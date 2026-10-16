#!/usr/bin/env node
/** Actual unregistered gateway, trusted browser upload, opaque native loads. */
import Fastify from "fastify";
import https from "node:https";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
import { signTicket, verifyTicket } from "../server/node-ticket.mjs";
import { installNativeResourceGateway } from "../server/native-resource-gateway.mjs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const dir = mkdtempSync(join(tmpdir(), "atlas-native-https-"));
const openssl = (args, input) => {
  const r = spawnSync("openssl", args, { input, encoding: null });
  if (r.status !== 0) throw Error(String(r.stderr));
  return r.stdout;
};
openssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  join(dir, "key.pem"),
  "-out",
  join(dir, "cert.pem"),
  "-days",
  "1",
  "-subj",
  "/CN=front.test",
  "-addext",
  "subjectAltName=DNS:front.test,DNS:selected.test",
]);
const key = readFileSync(join(dir, "key.pem")),
  cert = readFileSync(join(dir, "cert.pem")),
  spki = openssl(
    ["dgst", "-sha256", "-binary"],
    openssl(
      ["pkey", "-pubin", "-outform", "der"],
      openssl(["x509", "-pubkey", "-noout"], cert),
    ),
  ).toString("base64");
const front = Fastify({ https: { key, cert }, logger: false }),
  remote = Fastify({ https: { key, cert }, logger: false });
let frontend, nodeOrigin, browser;
const relayNodes = [];
const website = Fastify({ logger: false }),
  websiteCalls = [];
website.get("/image", (req, reply) => {
  websiteCalls.push({ path: "image", cookie: req.headers.cookie || "" });
  return reply
    .header(
      "Set-Cookie",
      "private=resource; HttpOnly; Path=/; SameSite=Lax; Max-Age=600",
    )
    .type("image/png")
    .send(png);
});
website.get("/style", (req, reply) => {
  websiteCalls.push({ path: "style", cookie: req.headers.cookie || "" });
  return reply.type("text/css").send("body{background-color:rgb(1, 2, 3)}");
});
const records = [],
  gateways = {},
  png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
    "base64",
  );
function install(app, label) {
  gateways[label] = installNativeResourceGateway(app, {
    originFor: (req) => "https://" + req.headers.host,
    authorizeOwner: (req) => {
      try {
        const ticket = verifyTicket(
          req.headers.authorization?.replace(/^Bearer /, ""),
          nativeSecret,
          frontend,
        );
        if (
          ticket.role !== "frontend-resource-owner-v1" ||
          ticket.purpose !== "native-resource-owner" ||
          ticket.node !== label ||
          ticket.resourceOrigin !== (label === "Main" ? frontend : nodeOrigin)
        )
          return null;
        return {
          nodeId: label,
          frontendOrigin: frontend,
          resourceOrigin: ticket.resourceOrigin,
          leaseHash: ticket.lease,
          generation: ticket.generation,
          expiresAt: ticket.expires,
        };
      } catch {
        return null;
      }
    },
    validateOwner: () => true,
  });
  app.addHook("onRequest", (req, _reply, done) => {
    if (req.url.startsWith("/native-resource/v1/resource/"))
      records.push({
        host: label,
        cap: req.url.split("/").pop(),
        cookie: (req.headers.cookie || "").includes("__Host-atlas-native-"),
        dest: req.headers["sec-fetch-dest"] || null,
        mode: req.headers["sec-fetch-mode"] || null,
        origin: req.headers.origin || null,
      });
    done();
  });
}
install(front, "Main");
install(remote, "remote");
for (const name of [
  "native-resource-preparer",
  "native-resource-owner",
  "opaque-resource-integrity",
  "sandbox-relay",
  "sandbox-relay-protocol",
  "sandbox-relay-worker",
  "sandbox-relay-websocket",
  "sandbox-cookies",
]) {
  const source = readFileSync(
    new URL("../runtime/" + name + ".ts", import.meta.url),
    "utf8",
  );
  const code = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replaceAll(/(from\s+["'])\.\/([^"']+)\.ts/g, "$1./$2.js")
    .replace('from "tldts"', 'from "/tldts.js"');
  front.get("/" + name + ".js", (_req, reply) =>
    reply.type("application/javascript").send(code),
  );
}
front.get("/tldts.js", (_req, reply) =>
  reply
    .type("application/javascript")
    .send(readFileSync("node_modules/tldts/dist/index.esm.min.js")),
);
front.get("/clients/httpengine-client.js", (_req, reply) =>
  reply
    .type("application/javascript")
    .send(readFileSync("runtime/public/clients/httpengine-client.js")),
);
front.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Native resource HTTPS proof</title>"),
);
front.get("/favicon.ico", (_req, reply) => reply.code(204).send());
const nativeSecret = "native-owner-purpose-test-secret-0123456789";
front.post("/fixture/native-ticket", (req, reply) => {
  const label = req.body?.label === "Main" ? "Main" : "remote";
  const resourceOrigin = label === "Main" ? frontend : nodeOrigin;
  const expiresAt = Date.now() + (req.body?.refresh ? 60000 : 5000),
    identity = {
      nodeId: label,
      frontendOrigin: frontend,
      resourceOrigin,
      leaseHash: "a".repeat(64),
      generation: 1,
    };
  return reply.send({
    ...identity,
    expiresAt,
    role: "frontend-resource-owner-v1",
    purpose: "native-resource-owner",
    ownerTicket: signTicket(
      {
        node: label,
        origin: frontend,
        runtimeOrigin: frontend,
        resourceOrigin,
        lease: identity.leaseHash,
        generation: 1,
        expires: expiresAt,
        role: "frontend-resource-owner-v1",
        purpose: "native-resource-owner",
      },
      nativeSecret,
    ),
  });
});
const clientCode = ts
  .transpileModule(readFileSync("runtime/native-resource-owner.ts", "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  })
  .outputText.split("export function createNativeResourceClient")[1];
front.get("/frame", (req, reply) =>
  reply
    .header(
      "Content-Security-Policy",
      `sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline';img-src ${frontend} ${nodeOrigin};style-src ${frontend} ${nodeOrigin};connect-src ${frontend} ${nodeOrigin};`,
    )
    .type("text/html").send(`<!doctype html><script>
function createNativeResourceClient${clientCode}
const documentId=${JSON.stringify(req.query.documentId)},nonce=${JSON.stringify(req.query.nonce)},resourceOrigin=${JSON.stringify(req.query.selected === "Main" ? frontend : nodeOrigin)},sourceOrigin=${JSON.stringify(sourceOrigin)};
const channel=new MessageChannel(),notify=parent.postMessage.bind(parent),client=createNativeResourceClient({documentId,resourceOrigin,port:channel.port1});
const nativeApply=Reflect.apply,nativeSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set,nativeURLHref=Object.getOwnPropertyDescriptor(URL.prototype,'href'),nativeData=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data'),nativeTest=RegExp.prototype.test,nativeExec=RegExp.prototype.exec,nativeStringify=JSON.stringify;
const leaks=[];let imageURL,styleURL;
const load=src=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('image failed'));img.src=src});
function poison(){Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,get(){return ''},set(value){if(String(value).includes('/enroll/'))leaks.push('src');nativeApply(nativeSrc,this,[value])}});Object.defineProperty(URL.prototype,'href',{...nativeURLHref,get(){const value=nativeApply(nativeURLHref.get,this,[]);if(value.includes('/enroll/'))leaks.push('url');return value}});Object.defineProperty(MessageEvent.prototype,'data',{...nativeData,get(){const value=nativeApply(nativeData.get,this,[]);if(value&&typeof value==='object'&&value.type==='enroll')leaks.push('message');return value}});RegExp.prototype.test=function(value){if(String(value).includes('/enroll/'))leaks.push('regexp');return nativeApply(nativeTest,this,[value])};RegExp.prototype.exec=function(value){if(String(value).includes('/enroll/'))leaks.push('regexp-exec');return nativeApply(nativeExec,this,[value])};}
addEventListener('message',async e=>{if(e.source!==parent||e.data?.type!=='check-renewal')return;try{await client.ready;await load(imageURL);notify({type:'renewal-done',documentId,leaks,enrollments:performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.includes('/native-resource/v1/enroll/'))},'*')}catch(error){notify({type:'renewal-done',error:error.message},'*')}});
notify({type:'native-offer',documentId,nonce},'*',[channel.port2]);
(async()=>{try{await client.ready;imageURL=await client.prepare({url:sourceOrigin+'/image',kind:'image'});styleURL=await client.prepare({url:sourceOrigin+'/style',kind:'style'});const image=await load(imageURL);let canvas;try{const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(image,0,0);c.toDataURL();canvas='readable'}catch(e){canvas=e.name}const link=document.createElement('link');link.rel='stylesheet';const loaded=new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=()=>reject(Error('style failed'))});link.href=styleURL;document.head.appendChild(link);await loaded;let css;try{void link.sheet.cssRules;css='readable'}catch(e){css=e.name}let cors;try{await fetch(imageURL,{credentials:'include'});cors='readable'}catch(e){cors=e.name}const opaque=await fetch(imageURL,{mode:'no-cors',credentials:'include'});let parentDOM;try{parent.document.body;parentDOM='readable'}catch(e){parentDOM=e.name}poison();notify({type:'owner-done',documentId,image:imageURL,style:styleURL,result:{origin:self.origin,canvas,css,cors,opaque:opaque.type,opaqueBytes:(await opaque.arrayBuffer()).byteLength,color:getComputedStyle(document.body).backgroundColor,parentDOM}},'*')}catch(e){notify({type:'owner-done',documentId,error:e.message},'*')}})();
<\/script>`),
);

await front.listen({ host: "127.0.0.1", port: 0 });
await remote.listen({ host: "127.0.0.1", port: 0 });
frontend = "https://front.test:" + front.server.address().port;
nodeOrigin = "https://selected.test:" + remote.server.address().port;
await website.listen({ host: "127.0.0.1", port: 0 });
const websitePort = website.server.address().port,
  sourceOrigin = "http://127.0.0.1:" + websitePort,
  documentURL =
    "http://127.0.0.1:" +
    (websitePort === 65535 ? websitePort - 1 : websitePort + 1) +
    "/page";
const evidence = new URL(
    "../evidence/native-resource-gateway-20261016/",
    import.meta.url,
  ),
  runtimeURL = new URL("../server/runtime.mjs", import.meta.url),
  nodeURL = new URL("../server/node-service.mjs", import.meta.url),
  originalRuntime = readFileSync(runtimeURL, "utf8");
assert.equal(originalRuntime.split("this.port === 4199").length, 2);
const imports = (source, base, special = {}) =>
  source.replace(
    /(from\s+["'])\.\/([^"']+)/g,
    (_m, start, path) => start + (special[path] || new URL(path, base).href),
  );
const runtimeCopy = new URL("preparer-fixture-runtime.mjs", evidence),
  nodeCopy = new URL("preparer-fixture-node-service.mjs", evidence);
writeFileSync(
  new URL("preparer-fixture-runtime-baseline.mjs", evidence),
  originalRuntime,
);
writeFileSync(
  runtimeCopy,
  imports(
    originalRuntime.replace(
      "this.port === 4199",
      "this.port === " + websitePort,
    ),
    runtimeURL,
  ),
);
writeFileSync(
  nodeCopy,
  imports(readFileSync(nodeURL, "utf8"), nodeURL, {
    "runtime.mjs": runtimeCopy.href,
  }),
);
writeFileSync(
  new URL("PREPARER-FIXTURE-SOURCE.json", evidence),
  JSON.stringify(
    {
      productionRuntimeSHA256: createHash("sha256")
        .update(originalRuntime)
        .digest("hex"),
      testRuntimeSHA256: createHash("sha256")
        .update(readFileSync(runtimeCopy))
        .digest("hex"),
      onlyGuardChange:
        "fixture-only port4199 -> process allocated ephemeral website port",
      productionEdited: false,
    },
    null,
    2,
  ),
);
const { createNodeService } = await import(
  nodeCopy.href + "?port=" + websitePort
);
const lease = "a".repeat(64),
  secret = "preparer-fixture-dedicated-relay-secret-0123456789";
const assignments = {};
for (const [label, app, origin] of [
  ["remote", remote, nodeOrigin],
  ["Main", front, frontend],
]) {
  const relayNode = await createNodeService({
    id: label,
    secret,
    fixture: true,
    staticDir: "/not-built",
    runtimeOrigin: frontend,
  });
  await relayNode.listen({ host: "127.0.0.1", port: 0 });
  relayNodes.push(relayNode);
  relayNode.applyControl({
    state: "active",
    revision: 1,
    leases: [lease],
    grants: [{ hash: lease, generation: 1, expiresAt: Date.now() + 600000 }],
  });
  app.server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith("/relay/"))
      relayNode.server.emit("upgrade", req, socket, head);
  });
  assignments[label] = {
    origin,
    generation: 1,
    sessionHash: lease,
    ticket: signTicket(
      {
        lease,
        generation: 1,
        node: label,
        name: "Test selected resource node",
        origin: frontend,
        runtimeOrigin: frontend,
        relayOrigin: origin,
        role: "frontend-controller-v2",
        expires: Date.now() + 600000,
      },
      secret,
    ),
  };
}
const offBrowser = (url) =>
  new Promise((resolve, reject) => {
    const r = https.get(
      url,
      {
        ca: cert,
        lookup: (_h, o, cb) =>
          o.all
            ? cb(null, [{ address: "127.0.0.1", family: 4 }])
            : cb(null, "127.0.0.1", 4),
        headers: {
          Origin: "null",
          "Sec-Fetch-Dest": "image",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "cross-site",
          Referer: frontend + "/frame",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    r.on("error", reject);
  });
const results = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--no-proxy-server",
      "--host-resolver-rules=MAP front.test 127.0.0.1,MAP selected.test 127.0.0.1",
      "--ignore-certificate-errors-spki-list=" + spki,
    ],
  });
  for (const blocked of [false, true])
    for (const label of ["remote", "Main"]) {
      await browser.close();
      const profile = mkdtempSync(join(dir, "profile-"));
      mkdirSync(join(profile, "Default"));
      writeFileSync(
        join(profile, "Default", "Preferences"),
        JSON.stringify({
          profile: {
            cookie_controls_mode: blocked ? 1 : 0,
            block_third_party_cookies: blocked,
          },
          tracking_protection: { tracking_protection3pcd_enabled: blocked },
        }),
      );
      const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        executablePath:
          process.env.CHROME_PATH ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        args: [
          "--no-proxy-server",
          "--host-resolver-rules=MAP front.test 127.0.0.1,MAP selected.test 127.0.0.1",
          "--ignore-certificate-errors-spki-list=" + spki,
          ...(blocked ? ["--test-third-party-cookie-phaseout"] : []),
        ],
      });
      browser = context.browser();
      const page = await context.newPage(),
        cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      if (blocked)
        await cdp.send("Network.setCookieControls", {
          enableThirdPartyCookieRestriction: true,
          disableThirdPartyCookieMetadata: true,
          disableThirdPartyCookieHeuristics: true,
        });
      await page.goto(frontend);
      if (blocked) {
        await cdp.send("Network.setCookieControls", {
          enableThirdPartyCookieRestriction: true,
          disableThirdPartyCookieMetadata: true,
          disableThirdPartyCookieHeuristics: true,
        });
        await page.reload();
      }
      const host = label === "Main" ? frontend : nodeOrigin;
      const job = await page.evaluate(
        async ({ host, assignment, sourceOrigin, documentURL, label }) => {
          const { createSandboxRelay, createSandboxRelayFetch } = await import(
            "/sandbox-relay.js"
          );
          const { SandboxCookieJar } = await import("/sandbox-cookies.js");
          const { createNativeResourceOwner } = await import(
            "/native-resource-owner.js"
          );
          const relay = await createSandboxRelay({
            assignment,
            workerURL: "/sandbox-relay-worker.js",
          });
          window.privateRelay = relay;
          const jar = new SandboxCookieJar({
            factory: indexedDB,
            browserSessionId: "native_owner_session_0123456789",
            forbiddenOrigins: [location.origin, host],
          });
          window.privateJar = jar;
          const identity = {
            nodeId: label,
            resourceOrigin: host,
            leaseHash: "a".repeat(64),
            generation: 1,
          };
          let initialExpires;
          const owner = await createNativeResourceOwner({
            identity: () => identity,
            grant: async (_identity, { refresh }) => {
              const response = await fetch("/fixture/native-ticket", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "omit",
                body: JSON.stringify({ refresh, label }),
              });
              const grant = await response.json();
              if (!refresh) initialExpires = grant.expiresAt;
              return grant;
            },
            renewBeforeMs: 1000,
          });
          window.privateNativeOwner = owner;
          const documentId =
              "native_document_" + crypto.randomUUID().replaceAll("-", ""),
            nonce = crypto.randomUUID(),
            frame = document.createElement("iframe");
          frame.sandbox = "allow-scripts";
          frame.src =
            "/frame?documentId=" +
            documentId +
            "&nonce=" +
            nonce +
            "&selected=" +
            label;
          window.websiteFrame = frame;
          const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("native owner initial timeout")),
              15000,
            );
            addEventListener("message", function receive(event) {
              if (
                event.source !== frame.contentWindow ||
                event.origin !== "null" ||
                event.data?.documentId !== documentId
              )
                return;
              if (
                event.data.type === "native-offer" &&
                event.data.nonce === nonce &&
                event.ports.length === 1
              ) {
                const fetch = createSandboxRelayFetch({
                  documentId,
                  documentURL,
                  topLevelURL: documentURL,
                  frontendOrigin: location.origin,
                  relay,
                  cookies: jar,
                });
                owner
                  .bind({
                    documentId,
                    documentURL,
                    topLevelURL: documentURL,
                    port: event.ports[0],
                    fetch,
                    contentPolicies: [],
                    transform: async (resource) => resource.body,
                  })
                  .then((binding) => (window.privateBinding = binding))
                  .catch(reject);
              }
              if (event.data.type === "owner-done") {
                clearTimeout(timer);
                removeEventListener("message", receive);
                event.data.error
                  ? reject(Error(event.data.error))
                  : resolve(event.data);
              }
            });
            document.body.appendChild(frame);
          });
          await owner.renew();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, initialExpires - Date.now() + 100)),
          );
          const renewed = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("native owner renewal timeout")),
              10000,
            );
            addEventListener("message", function receive(event) {
              if (
                event.source !== frame.contentWindow ||
                event.origin !== "null" ||
                event.data?.type !== "renewal-done"
              )
                return;
              clearTimeout(timer);
              removeEventListener("message", receive);
              event.data.error
                ? reject(Error(event.data.error))
                : resolve(event.data);
            });
            frame.contentWindow.postMessage({ type: "check-renewal" }, "*");
          });
          return {
            ...result,
            renewed,
            pastOriginalExpiry: Date.now() > initialExpires,
            ownerState: owner.stats(),
          };
        },
        {
          host,
          assignment: assignments[label],
          sourceOrigin,
          documentURL,
          label,
        },
      );
      const enrollmentReplayStatuses = await Promise.all(
        job.renewed.enrollments.map((url) => offBrowser(url)),
      );
      assert.ok(enrollmentReplayStatuses.length >= 2);
      assert.ok(enrollmentReplayStatuses.every((status) => status === 403));
      job.renewed = {
        type: job.renewed.type,
        leaks: job.renewed.leaks,
        enrollmentEntries: job.renewed.enrollments.length,
        enrollmentReplayStatuses,
      };
      const result = job.result;
      assert.ok(job.pastOriginalExpiry);
      assert.deepEqual(job.renewed.leaks, []);
      assert.equal(job.ownerState.live, true);
      assert.equal(new URL(job.image).origin, host);
      assert.equal(new URL(job.style).origin, host);
      assert.ok(!result.error, JSON.stringify(result));
      assert.equal(result.origin, "null");
      assert.equal(result.canvas, "SecurityError");
      assert.equal(result.css, "SecurityError");
      assert.equal(result.cors, "TypeError");
      assert.equal(result.opaque, "opaque");
      assert.equal(result.opaqueBytes, 0);
      assert.equal(result.color, "rgb(1, 2, 3)");
      assert.equal(result.parentDOM, "SecurityError");
      const escapedStatus = await offBrowser(job.image);
      assert.equal(escapedStatus, 403);
      const caps = [job.image, job.style].map((v) =>
        new URL(v).pathname.split("/").pop(),
      );
      const scoped = records.filter((r) => caps.includes(r.cap)),
        native = scoped.filter((r) => r.cookie);
      assert.ok(native.length >= 2);
      const cookies = (await context.cookies())
        .filter((c) => c.name.startsWith("__Host-atlas-native-"))
        .map((c) => ({
          httpOnly: c.httpOnly,
          secure: c.secure,
          partitionKey: c.partitionKey ?? null,
        }));
      results.push({
        blockedThirdParty: blocked,
        selected: label,
        result,
        renewal: job.renewed,
        pastOriginalExpiry: job.pastOriginalExpiry,
        exfiltrationStatus: escapedStatus,
        cookies,
        requests: scoped.map(({ cap, ...r }) => r),
      });
      assert.ok(
        cookies.length === 1 &&
          cookies[0].httpOnly &&
          cookies[0].secure &&
          cookies[0].partitionKey,
      );
      await context.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(gateways[label].stats().bytes, 0);
      assert.equal(gateways[label].stats().owners, 0);
    }
  assert.ok(
    websiteCalls.some(
      (v) => v.path === "style" && v.cookie.includes("private=resource"),
    ),
  );
  const receipt = {
    command: "node tests/native-resource-owner-browser.mjs",
    browser: browser.version(),
    productionChanged: false,
    generalRuntimeQualified: false,
    result: "native_owner_private_port_and_renewal_verified",
    upstreamPolicyPreparerQualified:
      "bounded component proof; broad runtime not qualified",
    realUnchangedPinnedHttpEngine: true,
    websiteCalls: websiteCalls.map((v) => ({
      path: v.path,
      httpOnlyCookiePresent: v.cookie.includes("private=resource"),
    })),
    spkiOnlyTestCertificate: true,
    results,
    exitStatus: 0,
  };
  writeFileSync(
    "evidence/native-resource-gateway-20261016/OWNER-BROWSER.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      result: receipt.result,
      cases: results.length,
      exfiltrationStatuses: results.map((r) => r.exfiltrationStatus),
      exitStatus: 0,
    }),
  );
} finally {
  await browser?.close();
  for (const relayNode of relayNodes) await relayNode.close();
  await website.close();
  await remote.close();
  await front.close();
  rmSync(dir, { recursive: true, force: true });
}
