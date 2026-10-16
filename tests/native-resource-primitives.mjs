#!/usr/bin/env node
/** HTTPS browser primitives only. Baseline intentionally simulates bearer-only
 * auth when NATIVE_RESOURCE_BASELINE_CAP_ONLY=1; never registered by Atlas. */
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
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const baseline = process.env.NATIVE_RESOURCE_BASELINE_CAP_ONLY === "1",
  dir = mkdtempSync(join(tmpdir(), "atlas-native-https-"));
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
  grants = new Map(),
  resourceCaps = new Map(),
  png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
    "base64",
  );
function install(app, label) {
  app.get("/enroll/:cap", (req, reply) => {
    const grant = grants.get(req.params.cap);
    if (!grant || grant.used || grant.host !== label)
      return reply.code(403).send();
    grant.used = true;
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Type", "image/png")
      .header("Set-Cookie", [
        `__Host-atlas-native-proof=${grant.secret};Secure;HttpOnly;Path=/;SameSite=None;Partitioned`,
        `__Host-atlas-native-unpartitioned=${grant.secret};Secure;HttpOnly;Path=/;SameSite=None`,
      ]);
    return reply.send(png);
  });
  app.get("/resource/:cap", (req, reply) => {
    const grant = resourceCaps.get(req.params.cap),
      cookie = req.headers.cookie || "",
      partitioned =
        !!grant &&
        cookie
          .split(/;\s*/)
          .includes("__Host-atlas-native-proof=" + grant.secret),
      unpartitioned =
        !!grant &&
        cookie
          .split(/;\s*/)
          .includes("__Host-atlas-native-unpartitioned=" + grant.secret);
    records.push({
      host: label,
      cap: req.params.cap,
      cookie: partitioned,
      unpartitioned,
      dest: req.headers["sec-fetch-dest"] || null,
      mode: req.headers["sec-fetch-mode"] || null,
      origin: req.headers.origin || null,
    });
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (!grant || grant.host !== label || (!baseline && !partitioned))
      return reply
        .code(403)
        .type("text/plain")
        .send("Native resource proof required");
    if (grant.kind === "image") return reply.type("image/png").send(png);
    return reply.type("text/css").send("body{background-color:rgb(1, 2, 3)}");
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
      const cap = () => randomBytes(32).toString("base64url"),
        secret = cap(),
        enroll = cap(),
        image = cap(),
        style = cap(),
        host = label === "Main" ? frontend : nodeOrigin;
      grants.set(enroll, { secret, host: label, used: false });
      resourceCaps.set(image, { secret, host: label, kind: "image" });
      resourceCaps.set(style, { secret, host: label, kind: "style" });
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
        {
          enroll: host + "/enroll/" + enroll,
          image: host + "/resource/" + image,
          style: host + "/resource/" + style,
        },
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
      const escapedStatus = await offBrowser(host + "/resource/" + image);
      assert.equal(escapedStatus, baseline ? 200 : 403);
      const scoped = records.filter((r) => r.cap === image || r.cap === style),
        native = scoped.filter((r) => r.cookie);
      assert.ok(native.length >= 2);
      if (blocked && label === "remote")
        assert.ok(
          native.every((r) => !r.unpartitioned),
          JSON.stringify({ label, blocked, native }),
        );
      const cookies = (await context.cookies())
        .filter((c) => c.name === "__Host-atlas-native-proof")
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
      await context.close();
    }
  const receipt = {
    command: baseline
      ? "NATIVE_RESOURCE_BASELINE_CAP_ONLY=1 node tests/native-resource-primitives.mjs"
      : "node tests/native-resource-primitives.mjs",
    browser: browser.version(),
    productionChanged: false,
    generalRuntimeQualified: false,
    result: baseline
      ? "baseline_bearer_only_exfiltration_observed"
      : "native_partitioned_cookie_and_cap_boundary_verified",
    spkiOnlyTestCertificate: true,
    results,
    exitStatus: 0,
  };
  writeFileSync(
    "evidence/native-resource-gateway-20261016/" +
      (baseline ? "BASELINE-PRIMITIVES" : "MODIFIED-PRIMITIVES") +
      ".json",
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
