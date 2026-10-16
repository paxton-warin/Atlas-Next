/** Dormant reserved-helper native proof, not default runtime/fleet acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { installReservedRendererHelper } from "../server/reserved-renderer-helper.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const dir = await fs.mkdtemp(join(tmpdir(), "atlas-renderer-proof-"));
const openssl = (args, input) => {
  const p = spawnSync("openssl", args, { input });
  assert.equal(p.status, 0, String(p.stderr));
  return p.stdout;
};
openssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  join(dir, "key"),
  "-out",
  join(dir, "cert"),
  "-days",
  "1",
  "-subj",
  "/CN=127.0.0.1",
  "-addext",
  "subjectAltName=IP:127.0.0.1",
]);
const key = await fs.readFile(join(dir, "key")),
  cert = await fs.readFile(join(dir, "cert")),
  spki = openssl(
    ["dgst", "-sha256", "-binary"],
    openssl(
      ["pkey", "-pubin", "-outform", "der"],
      openssl(["x509", "-pubkey", "-noout"], cert),
    ),
  ).toString("base64");
const app = Fastify({ logger: false, https: { key, cert } }),
  requests = [],
  errors = [];
let origin,
  browser,
  denyOpaqueAncestors = false;
const parentId = "parent_renderer_doc_000001";
const runnerURL =
  "https://cdn.platform.openai.com/deployments/dil/v14/runner.html";
const moduleURL =
  "https://cdn.platform.openai.com/assets/dil/runner-proof123456.js";
const moduleCode = `const getData=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;parent.postMessage({type:'reviewed-renderer-running'},'*');addEventListener('message',e=>{const m=Reflect.apply(getData,e,[]);if(m?.type==='render-test'){document.body.textContent='Rendered fixture';parent.postMessage({type:'reviewed-renderer-result',value:document.body.textContent},'*')}});Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get(){throw Error('poisoned_event_data')}});MessagePort.prototype.postMessage=function(){throw Error('poisoned_port_post')};MessagePort.prototype.addEventListener=function(){throw Error('poisoned_port_listener')};parent.postMessage({type:'reviewed-renderer-poisoned'},'*');`;
const runnerHTML = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src 'self' https://cdn.platform.openai.com/assets/dil/ 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'"><script type="module" src="${moduleURL}"></script></head><body></body></html>`;
app.addHook("onRequest", async (req) =>
  requests.push({
    method: req.method,
    url: req.url,
    origin: req.headers.origin || "",
    cookieNames: String(req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim().split("=")[0])
      .filter(Boolean),
  }),
);
app.addHook("onSend", async (req, reply, payload) => {
  if (denyOpaqueAncestors && req.url.startsWith("/browse/renderer/v1/"))
    reply.header(
      "Content-Security-Policy",
      reply.getHeader("Content-Security-Policy") + "; frame-ancestors 'self'",
    );
  return payload;
});
installReservedRendererHelper(app, {
  originFor: () => origin,
  timeoutMs: 1800,
  authorizeReservation: (req, id) =>
    id === parentId &&
    String(req.headers.cookie || "")
      .split(";")
      .some((v) => v.trim() === "renderer-proof-owner=authorized"),
});
app.get("/", (req, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><title>Trusted renderer owner</title><main><iframe id="parent" src="/opaque-parent' +
        (req.query.deny ? "?deny=1" : "") +
        '"></iframe></main><script type="module" src="/proof.js"></script>',
    ),
);
const parentScript = `window.rendererMessages=[];addEventListener('message',e=>{if(e.data?.type?.startsWith('reviewed-renderer-'))rendererMessages.push(e.data)});for(let n=0;n<3;n++){const f=document.createElement('iframe');f.sandbox='allow-scripts';document.body.append(f)};window.parentReady=true;`;
app.get("/opaque-parent", (req, reply) =>
  reply
    .header(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; frame-src " +
        (req.query.deny
          ? "'none'"
          : origin + "/browse/renderer/v1/" + parentId + "/"),
    )
    .type("text/html")
    .send(
      "<!doctype html><title>Opaque website parent</title><body><script>" +
        parentScript +
        "</script>",
    ),
);
const bundle = await build({
  stdin: {
    contents: `import {createRendererHelperBroker} from ${JSON.stringify(resolve("runtime/renderer-helper-broker.ts"))};import {createOriginalDocumentPolicy} from ${JSON.stringify(resolve("runtime/original-document-policy.ts"))};
let broker,grant,secret,release,attestRelease,hello=false,result,fetchCalls=0,watching=false;const frame=document.querySelector('#parent');let active=true;
window.proof={async launch(input={}){broker?.dispose();hello=false;result=undefined;fetchCalls=0;if(!watching){frame.addEventListener('load',()=>active=false);watching=true}const policy=createOriginalDocumentPolicy({documentURL:'https://chatgpt.com/',contentPolicies:[input.denyPolicy?"frame-src 'none'":"frame-src https://cdn.platform.openai.com/deployments/dil/v14/"]});broker=createRendererHelperBroker({window,parentDocumentId:${JSON.stringify(parentId)},parentWindow:frame.contentWindow,website:'https://chatgpt.com/',activeParent:()=>active,timeoutMs:1200,authorizeFrame:url=>policy.checkURL({url,kind:'frame'}),reserveHelper:async(scriptHashes)=>{const r=await fetch('/api/browse/controller/renderer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({parentDocumentId:${JSON.stringify(parentId)},scriptHashes})});if(!r.ok)throw Error('reserve_status_'+r.status);const v=await r.json();secret=v.secret;return v},fetchResource:async(url,credentials,kind)=>{fetchCalls++;if(url.href===${JSON.stringify(runnerURL)})return{status:200,type:'text/html',text:${JSON.stringify(runnerHTML)},policies:[]};if(url.href===${JSON.stringify(moduleURL)})return{status:200,type:'application/javascript',text:${JSON.stringify(moduleCode)},policies:[],allowOrigin:'*'};throw Error('unexpected_renderer_resource')},beforeAttest:input.holdAttest?async()=>{await new Promise(r=>attestRelease=r)}:undefined,beforeGrant:input.hold?async()=>{hello=true;await new Promise(r=>release=r)}:undefined});try{grant=await broker.reserve({url:input.url??${JSON.stringify(runnerURL)},slot:input.slot??0});grant.ready.then(v=>result={status:'ready',...v},e=>result={status:'error',code:e.code});return{helperURL:grant.helperURL,childId:grant.childId}}catch(e){result={status:'error',code:e.code};return result}},get result(){return result},get fetchCalls(){return fetchCalls},releaseAttest(){attestRelease?.()},get ignored(){return broker?.ignored??0},get hello(){return hello},release(){release?.()},secret(){return secret},dispose(){broker?.dispose()},cancel(){grant?.cancel()}};`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  target: "es2022",
});
app.get("/proof.js", (_q, r) =>
  r.type("application/javascript").send(bundle.outputFiles[0].text),
);
const request = (path) =>
  new Promise((resolve, reject) => {
    https
      .get(origin + path, { ca: cert }, (r) => {
        let text = "";
        r.on("data", (x) => (text += x));
        r.on("end", () =>
          resolve({ status: r.statusCode, text, headers: r.headers }),
        );
      })
      .on("error", reject);
  });
try {
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--ignore-certificate-errors-spki-list=" + spki],
  });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "renderer-proof-owner",
      value: "authorized",
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const open = async (deny = false) => {
    await page.goto(origin + (deny ? "/?deny=1" : "/"));
    await page.waitForFunction(() => window.proof);
    const p = page.frames().find((f) => f.url().includes("/opaque-parent"));
    await p.waitForFunction(() => window.parentReady);
    return p;
  };
  if (process.env.ATLAS_RENDERER_BASELINE) {
    const p = await open(true),
      reserved = await page.evaluate(() => proof.launch());
    await p.evaluate(
      (url) => (document.querySelectorAll("iframe")[0].src = url),
      reserved.helperURL,
    );
    await page.waitForFunction(() => proof.result);
    assert.equal(
      (await page.evaluate(() => proof.result)).code,
      "RENDERER_DOCUMENT_TIMEOUT",
    );
    assert.equal(await p.evaluate(() => rendererMessages.length), 0);
    console.log(
      "BASELINE: physical frame-src none -> RENDERER_DOCUMENT_TIMEOUT; no renderer execution",
    );
    throw Error("BASELINE_EXPECTED_PHYSICAL_FRAME_DENIAL");
  }
  const nullAPI = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      parentDocumentId: parentId,
      scriptHashes: ["'sha256-" + "A".repeat(43) + "='"],
    });
    const req = https.request(
      origin + "/api/browse/controller/renderer",
      {
        ca: cert,
        method: "POST",
        headers: {
          origin: "null",
          cookie: "renderer-proof-owner=authorized",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(nullAPI, 403);
  let parent = await open();
  const denied = await page.evaluate(() => proof.launch({ denyPolicy: true }));
  assert.equal(denied.code, "original_policy_denied");
  assert.equal(await page.evaluate(() => proof.fetchCalls), 0);
  assert.equal(
    requests.filter(
      (r) => r.url === "/api/browse/controller/renderer" && r.origin !== "null",
    ).length,
    0,
  );
  const reserved = await page.evaluate(() =>
    proof.launch({ hold: true, holdAttest: true }),
  );
  assert.ok(
    reserved.helperURL.startsWith(
      origin + "/browse/renderer/v1/" + parentId + "/",
    ),
  );
  assert.ok(
    !reserved.helperURL.includes(await page.evaluate(() => proof.secret())),
  );
  const stolen = await request(new URL(reserved.helperURL).pathname);
  assert.equal(stolen.status, 403);
  assert.ok(!stolen.text.includes(await page.evaluate(() => proof.secret())));
  const html = await parent.evaluate(() => document.documentElement.outerHTML);
  assert.ok(!html.includes(await page.evaluate(() => proof.secret())));
  // Same expected WindowProxy, wrong secret from attacker-owned srcdoc.
  await parent.evaluate(
    ({ childId, parentId }) => {
      document.querySelectorAll("iframe")[0].srcdoc =
        "<script>const c=new MessageChannel();top.postMessage(" +
        JSON.stringify({
          protocol: "atlas-renderer-v1",
          type: "renderer-ready",
          parentDocumentId: parentId,
          childId,
          secret: "0".repeat(64),
        }) +
        ",'*',[c.port2]);</" +
        "script>";
    },
    { childId: reserved.childId, parentId },
  );
  await page.waitForFunction(() => proof.ignored > 0);
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => proof.result), undefined);
  // Valid secret from a different opaque sibling is insufficient.
  const privateSecret = await page.evaluate(() => proof.secret());
  const ignoredBefore = await page.evaluate(() => proof.ignored);
  await parent.evaluate(
    ({ childId, parentId, secret }) => {
      document.querySelectorAll("iframe")[1].srcdoc =
        "<script>const c=new MessageChannel();top.postMessage(" +
        JSON.stringify({
          protocol: "atlas-renderer-v1",
          type: "renderer-ready",
          parentDocumentId: parentId,
          childId,
          secret,
        }) +
        ",'*',[c.port2]);</" +
        "script>";
    },
    { childId: reserved.childId, parentId, secret: privateSecret },
  );
  await page.waitForFunction((before) => proof.ignored > before, ignoredBefore);
  await page.waitForTimeout(25);
  assert.equal(await page.evaluate(() => proof.result), undefined);
  const ignoredWrongDoc = await page.evaluate(() => proof.ignored);
  await parent.evaluate(
    ({ childId, secret }) => {
      document.querySelectorAll("iframe")[0].srcdoc =
        "<script>const c=new MessageChannel();top.postMessage(" +
        JSON.stringify({
          protocol: "atlas-renderer-v1",
          type: "renderer-ready",
          parentDocumentId: "wrong_parent_document_123",
          childId,
          secret,
        }) +
        ",'*',[c.port2]);</" +
        "script>";
    },
    { childId: reserved.childId, secret: privateSecret },
  );
  await page.waitForFunction(
    (before) => proof.ignored > before,
    ignoredWrongDoc,
  );
  assert.equal(await page.evaluate(() => proof.hello), false);
  await parent.evaluate(
    ({ url }) => {
      document.querySelectorAll("iframe")[0].removeAttribute("srcdoc");
      document.querySelectorAll("iframe")[0].src = url;
    },
    { url: reserved.helperURL },
  );
  await page.waitForFunction(() => proof.hello);
  await page.evaluate(() => proof.release());
  await parent.waitForFunction(() =>
    rendererMessages.some((m) => m.type === "reviewed-renderer-poisoned"),
  );
  await page.evaluate(() => proof.releaseAttest());
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "ready");
  await parent.waitForFunction(() =>
    rendererMessages.some((m) => m.type === "reviewed-renderer-running"),
  );
  await parent.evaluate(() =>
    frames[0].postMessage({ type: "render-test" }, "*"),
  );
  await parent.waitForFunction(() =>
    rendererMessages.some((m) => m.value === "Rendered fixture"),
  );
  const rendered = parent
    .childFrames()
    .find((f) => f.url() === reserved.helperURL);
  assert.ok(rendered);
  assert.equal(await rendered.evaluate(() => origin), "null");
  assert.equal(
    await rendered.evaluate(
      () => document.querySelectorAll("script[nonce]").length,
    ),
    0,
  );
  assert.equal(
    await rendered.evaluate(() => {
      try {
        return parent.document.body.textContent;
      } catch {
        return "denied";
      }
    }),
    "denied",
  );
  assert.equal(
    await rendered.evaluate(() => {
      try {
        return localStorage.length;
      } catch {
        return "denied";
      }
    }),
    "denied",
  );
  const ignoredReplay = await page.evaluate(() => proof.ignored);
  await rendered.evaluate(
    ({ childId, parentId, secret }) => {
      const c = new MessageChannel();
      top.postMessage(
        {
          protocol: "atlas-renderer-v1",
          type: "renderer-ready",
          parentDocumentId: parentId,
          childId,
          secret,
        },
        "*",
        [c.port2],
      );
    },
    { childId: reserved.childId, parentId, secret: privateSecret },
  );
  await page.waitForFunction((before) => proof.ignored > before, ignoredReplay);
  const replay = await request(new URL(reserved.helperURL).pathname);
  assert.equal(replay.status, 404);
  // Navigate after authenticated hello but before final grant; reused WindowProxy
  // must never receive a controller-created capability or execute renderer bytes.
  parent = await open();
  const race = await page.evaluate(() => proof.launch({ hold: true }));
  await parent.evaluate(
    (url) => (document.querySelectorAll("iframe")[0].src = url),
    race.helperURL,
  );
  await page.waitForFunction(() => proof.hello);
  await parent.evaluate(
    () => (document.querySelectorAll("iframe")[0].src = "about:blank"),
  );
  await page.waitForTimeout(30);
  await page.evaluate(() => proof.release());
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "error");
  assert.equal(await parent.evaluate(() => rendererMessages.length), 0);
  // A parent replacement invalidates the original assignment even if its
  // WindowProxy is reused; helper ports remain bound to the destroyed document.
  parent = await open();
  const staleParent = await page.evaluate(() => proof.launch({ hold: true }));
  await parent.evaluate(
    (url) => (document.querySelectorAll("iframe")[0].src = url),
    staleParent.helperURL,
  );
  await page.waitForFunction(() => proof.hello);
  await page.evaluate(
    () =>
      (document.querySelector("#parent").src = "/opaque-parent?replacement=1"),
  );
  await page.waitForTimeout(50);
  await page.evaluate(() => proof.release());
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "error");
  assert.equal(
    (await page.evaluate(() => proof.result)).code,
    "RENDERER_PARENT_STALE",
  );
  // Direct top navigation consumes only an inert opaque bootstrap; it cannot
  // claim the pending parent's final port or obtain frontend storage/API access.
  parent = await open();
  const directGrant = await page.evaluate(() => proof.launch());
  const direct = await context.newPage();
  await direct.goto(directGrant.helperURL);
  assert.equal(await direct.evaluate(() => origin), "null");
  assert.equal(
    await direct.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        return "denied";
      }
    }),
    "denied",
  );
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "error");
  await direct.close();
  // Missing/blocked reservation cookies fail closed without disclosing secrets.
  parent = await open();
  const cookieDenied = await page.evaluate(() => proof.launch());
  await context.clearCookies({ name: /^__Secure-atlas-renderer-/ });
  await parent.evaluate(
    (url) => (document.querySelectorAll("iframe")[0].src = url),
    cookieDenied.helperURL,
  );
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "error");
  // The conventional self ancestor guard is incompatible with the required
  // opaque intermediate ancestor; demonstrate denial, never remove isolation.
  parent = await open();
  const ancestorDenied = await page.evaluate(() => proof.launch());
  denyOpaqueAncestors = true;
  await parent.evaluate(
    (url) => (document.querySelectorAll("iframe")[0].src = url),
    ancestorDenied.helperURL,
  );
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "error");
  denyOpaqueAncestors = false;
  // Original response CSP frame-src none remains effective, not relaxed by helper.
  parent = await open(true);
  const physicalDeny = await page.evaluate(() => proof.launch());
  await parent.evaluate(
    (url) => (document.querySelectorAll("iframe")[0].src = url),
    physicalDeny.helperURL,
  );
  await page.waitForFunction(() => proof.result);
  assert.equal((await page.evaluate(() => proof.result)).status, "error");
  console.log(
    JSON.stringify(
      {
        result: "reserved_renderer_native_proof",
        reviewedAdapter: true,
        currentFrontendHelper: true,
        originalFramePolicyDenied: true,
        stolenURLServerFetch403: true,
        secretAbsentURLAndOuterDOM: true,
        wrongSecretSameWindowDenied: true,
        validSecretWrongWindowDenied: true,
        originalDocumentFinalPort: true,
        rendered: true,
        opaque: true,
        rendererNonceNotExposed: true,
        navigationRaceNoExecution: true,
        consumedRoute404: true,
        physicalFramePolicyDenied: true,
        parentReplacementDenied: true,
        directVisitInert: true,
        missingCookieFailedClosed: true,
        opaqueAncestorSelfDenied: true,
        poisonedPrimordialsPreservedPrivatePort: true,
        nullOriginReservationDenied: true,
        originalPolicyDeniedBeforeAnyResourceFetch: true,
        wrongParentDocumentIdDeniedBeforeHello: true,
        helloReplayDenied: true,
        scope:
          "Dormant reserved-helper primitive only; default runtime adapter/integration is not installed",
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
}
