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
const records = [],
  gateways = {},
  png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
    "base64",
  );
function install(app, label) {
  gateways[label] = installNativeResourceGateway(app, {
    originFor: (req) => "https://" + req.headers.host,
    authorizeOwner: (req) =>
      req.headers.authorization === "Bearer fixture-resource-owner-ticket"
        ? Object.freeze({
            nodeId: label,
            frontendOrigin: frontend,
            resourceOrigin: label === "Main" ? frontend : nodeOrigin,
            leaseHash: "a".repeat(64),
            generation: 1,
            expiresAt: Date.now() + 60000,
          })
        : null,
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
front.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Native resource HTTPS proof</title>"),
);
front.get("/favicon.ico", (_req, reply) => reply.code(204).send());
front.get("/frame", (_req, reply) =>
  reply
    .header(
      "Content-Security-Policy",
      `sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline';img-src ${frontend} ${nodeOrigin};style-src ${frontend} ${nodeOrigin};connect-src ${frontend} ${nodeOrigin};`,
    )
    .type("text/html").send(`<!doctype html><script>
const notify=parent.postMessage.bind(parent);addEventListener('message',async event=>{if(event.source!==parent||event.data?.type!=='start')return;const job=event.data;try{const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('image failed'));image.src=src});await load(job.enroll);const image=await load(job.image);let canvas;try{const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(image,0,0);c.toDataURL();canvas='readable'}catch(e){canvas=e.name}const link=document.createElement('link');link.rel='stylesheet';const styled=new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=()=>reject(Error('style failed'))});link.href=job.style;document.head.appendChild(link);await styled;let css;try{void link.sheet.cssRules;css='readable'}catch(e){css=e.name}let cors;try{await fetch(job.image,{credentials:'include'});cors='readable'}catch(e){cors=e.name}const opaque=await fetch(job.image,{mode:'no-cors',credentials:'include'});let parentDOM;try{parent.document.body;parentDOM='readable'}catch(e){parentDOM=e.name}notify({type:'done',origin:self.origin,canvas,css,cors,opaque:opaque.type,opaqueBytes:(await opaque.arrayBuffer()).byteLength,color:getComputedStyle(document.body).backgroundColor,parentDOM},'*')}catch(e){notify({type:'done',error:e.message},'*')}});notify({type:'ready'},'*');</script>`),
);
await front.listen({ host: "127.0.0.1", port: 0 });
await remote.listen({ host: "127.0.0.1", port: 0 });
frontend = "https://front.test:" + front.server.address().port;
nodeOrigin = "https://selected.test:" + remote.server.address().port;
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
        async ({ host, png }) => {
          const headers = {
            "Content-Type": "application/json",
            Authorization: "Bearer fixture-resource-owner-ticket",
          };
          const registered = await fetch(host + "/native-resource/v1/owners", {
            method: "POST",
            headers,
            credentials: "omit",
            body: "{}",
          });
          if (!registered.ok)
            throw Error(
              "register " + registered.status + " " + (await registered.text()),
            );
          const owner = await registered.json();
          const ws = new WebSocket(
            new URL(owner.websocket, host).href.replace(/^https:/, "wss:"),
          );
          window.gatewayOwner = ws;
          const pending = [],
            waiters = [];
          ws.addEventListener("message", (event) => {
            const v = JSON.parse(event.data);
            const i = waiters.findIndex((w) => w.test(v));
            if (i >= 0) {
              const w = waiters.splice(i, 1)[0];
              clearTimeout(w.timer);
              w.resolve(v);
            } else pending.push(v);
          });
          const wait = (test) => {
            const i = pending.findIndex(test);
            if (i >= 0) return Promise.resolve(pending.splice(i, 1)[0]);
            return new Promise((resolve, reject) => {
              const w = {
                test,
                resolve,
                timer: setTimeout(
                  () => reject(Error("owner message timeout")),
                  8000,
                ),
              };
              waiters.push(w);
            });
          };
          await wait((v) => v.type === "ready");
          const documentId = "native-document-" + crypto.randomUUID();
          const docResponse = await fetch(
            host + "/native-resource/v1/documents",
            {
              method: "POST",
              headers: {
                ...headers,
                Authorization: "Bearer " + owner.capability,
              },
              credentials: "omit",
              body: JSON.stringify({
                documentId,
                documentURL: "https://website.test/index.html",
                topLevelURL: "https://website.test/index.html",
              }),
            },
          );
          if (!docResponse.ok)
            throw Error(
              "document " +
                docResponse.status +
                " " +
                (await docResponse.text()),
            );
          const doc = await docResponse.json();
          const upload = async (kind, mime, body) => {
            const uploadId = Array.from(
              crypto.getRandomValues(new Uint8Array(16)),
              (n) => n.toString(16).padStart(2, "0"),
            ).join("");
            const sha256 = Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
              (n) => n.toString(16).padStart(2, "0"),
            ).join("");
            ws.send(
              JSON.stringify({
                type: "begin",
                uploadId,
                documentId,
                sourceURL: "https://unreadable.test/" + kind,
                kind,
                mime,
                bodyBytes: body.byteLength,
                sha256,
                policy: {
                  originalAllowed: true,
                  mixedContentChecked: true,
                  integrityChecked: true,
                  contentPolicyChecked: true,
                },
              }),
            );
            const ready = await wait(
              (v) => v.uploadId === uploadId || v.type === "error",
            );
            if (ready.type !== "upload-ready")
              throw Error(JSON.stringify(ready));
            const data = new Uint8Array(32 + body.byteLength);
            data.set(new TextEncoder().encode(uploadId));
            data.set(body, 32);
            ws.send(data);
            ws.send(JSON.stringify({ type: "commit", uploadId }));
            const committed = await wait(
              (v) => v.uploadId === uploadId || v.type === "error",
            );
            if (committed.type !== "resource-ready")
              throw Error(JSON.stringify(committed));
            return committed.url;
          };
          return {
            enroll: host + doc.enrollment,
            image: await upload("image", "image/png", new Uint8Array(png)),
            style: await upload(
              "style",
              "text/css",
              new TextEncoder().encode("body{background-color:rgb(1, 2, 3)}"),
            ),
          };
        },
        { host, png: Array.from(png) },
      );
      assert.equal(new URL(job.image).origin, host);
      assert.equal(new URL(job.style).origin, host);
      const result = await page.evaluate(
        (job) =>
          new Promise((resolve, reject) => {
            const frame = document.createElement("iframe");
            frame.sandbox = "allow-scripts";
            frame.src = "/frame";
            const timer = setTimeout(
              () => reject(Error("native primitive timeout")),
              12000,
            );
            addEventListener("message", function receive(e) {
              if (e.source !== frame.contentWindow || e.origin !== "null")
                return;
              if (e.data?.type === "ready")
                frame.contentWindow.postMessage({ type: "start", ...job }, "*");
              if (e.data?.type === "done") {
                clearTimeout(timer);
                removeEventListener("message", receive);
                resolve(e.data);
              }
            });
            document.body.appendChild(frame);
          }),
        job,
      );
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
  const receipt = {
    command: "node tests/native-resource-browser.mjs",
    browser: browser.version(),
    productionChanged: false,
    generalRuntimeQualified: false,
    result: "actual_gateway_upload_and_native_unreadability_verified",
    upstreamPolicyPreparerQualified: false,
    spkiOnlyTestCertificate: true,
    results,
    exitStatus: 0,
  };
  writeFileSync(
    "evidence/native-resource-gateway-20261016/GATEWAY-BROWSER.json",
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
  await remote.close();
  await front.close();
  rmSync(dir, { recursive: true, force: true });
}
