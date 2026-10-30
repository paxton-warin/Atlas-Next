/** Actual copied RuntimeKit + opaque frame + trusted cookie worker/native IDB +
 * encrypted synchronous HTTP/WS result channel. Local component, not fleet proof. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
import { installSandboxCookieRendezvous } from "../server/sandbox-cookie-rendezvous.mjs";
import { adaptPinnedRuntimeBundle } from "../tests/opaque-runtime-fork.mjs";

const artificialLatencyMs=Number(process.env.ATLAS_RPC_LATENCY||0);
const app = Fastify({ logger: false }),
  compiled = new Map(),
  wire = [];
let frontend,
  tamper = false,
  replay = false,
  lastPacket,
  drop = false;
const bundle = async (entry, format = "esm") =>
  (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format,
      target: "es2022",
      platform: "browser",
      logLevel: "silent",
    })
  ).outputFiles[0].text;
for (const [url, entry] of [
  ["owner", "sandbox-cookie-owner"],
  ["worker", "sandbox-cookie-worker"],
  ["controller", "sandbox-controller"],
])
  compiled.set("/" + url + ".js", await bundle("runtime/" + entry + ".ts"));
const childBundle = (
  await build({
    stdin: {
      contents: `import {createSandboxDocumentCookie} from './runtime/sandbox-document-cookie.ts';import {bootOpaqueRuntimeClient,createOpaqueNetworkClient} from './runtime/opaque-runtime-adapter.ts';globalThis.fixtureCookieAPI={createSandboxDocumentCookie,bootOpaqueRuntimeClient,createOpaqueNetworkClient};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    platform: "browser",
    logLevel: "silent",
  })
).outputFiles[0].text;
const core = adaptPinnedRuntimeBundle(
  fs.readFileSync("runtime/public/runtime/runtimekit.js", "utf8"),
);
const wasm = fs
  .readFileSync("runtime/public/runtime/runtimekit.wasm")
  .toString("base64");
const bootstrap = `${core}\n${childBundle}\nwindow.nativeOriginBeforeRuntime=window.origin;const nativeEval=window.eval, wasm=Uint8Array.from(atob(${JSON.stringify(wasm)}),c=>c.charCodeAt(0));
addEventListener('atlas:document-capabilities',event=>{const grant=event.detail;grant.control.onmessage=async event=>{if(event.data.type!=='initialize')return;try{
 const api=fixtureCookieAPI,data=event.data,cookies=await api.createSandboxDocumentCookie({documentId:grant.documentId,endpoint:data.cookieEndpoint,port:grant.cookies,batchReads:${JSON.stringify(process.env.ATLAS_COOKIE_CACHE==='1')}});
 const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),clear:()=>m.clear(),key:n=>[...m.keys()][n]??null,get length(){return m.size}}};
 const network=api.createOpaqueNetworkClient({port:grant.network,documentId:grant.documentId,documentURL:data.website});
 const boot=api.bootOpaqueRuntimeClient({global:window,documentOrigin:'opaque',core:$runtimekit,wasm,documentURL:data.website,prefix:location.origin+'/~/app/cookie-fixture/',network,localStorage:storage(),sessionStorage:storage(),installIndexedDB:()=>{},cookies,onNavigate:()=>{},sendSetCookie:async()=>{throw Error('stock cookie path must never run')}});
 for(const p of [grant.control,grant.storage,grant.indexedDB,grant.network,grant.cookies])boot.client.nativeMessagePorts.add(p);
 window.runFixture=source=>nativeEval.call(window,boot.rewriter.javascript(source));window.cookieFacade=cookies;window.fixtureReady=true;
}catch(error){window.fixtureError=error.name+':'+error.message}}});`;
app.addHook("onRequest", (req, _reply, done) => {
  if (req.url.startsWith("/browse/cookies/result/"))
    wire.push({
      origin: req.headers.origin,
      cookie: !!req.headers.cookie,
      authorization: !!req.headers.authorization,
    });
  done();
});
app.addHook("preValidation", (req, _reply, done) => {
  if (req.url.startsWith("/browse/cookies/result/"))
    wire.at(-1).body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  done();
});
app.addHook("onSend", async (req, reply, payload) => {
  if (req.url.startsWith("/browse/frame/"))
    reply.header(
      "Content-Security-Policy",
      String(reply.getHeader("Content-Security-Policy")).replace(
        "script-src 'unsafe-inline'",
        "script-src 'unsafe-inline' 'unsafe-eval'",
      ),
    );
  if (
    req.url.startsWith("/browse/cookies/result/") &&
    typeof payload === "string"
  ) {
    if(artificialLatencyMs)await new Promise(r=>setTimeout(r,artificialLatencyMs));
    let p = JSON.parse(payload);
    if (p.packet) {
      wire.at(-1).packet = p.packet;
      if (replay && lastPacket) p.packet = lastPacket;
      else lastPacket = p.packet;
      if (tamper) {
        const b = Buffer.from(p.packet, "base64");
        b[b.length - 1] ^= 1;
        p.packet = b.toString("base64");
      }
      if (drop) {
        reply.code(503);
        p = { ok: false };
      }
      return JSON.stringify(p);
    }
  }
  return payload;
});
installSandboxCookieRendezvous(app, {
  originFor: () => frontend,
  authorizeOwner: (r) =>
    r.headers["x-fixture-csrf"] === "fixture" ? { session: "trusted" } : null,
  validateOwner: () => true,
  timeoutMs: 500,
});
installSandboxFramePrototype(app, {
  capabilities: true,
  documentOrigin: "opaque",
  trustedBootstrap: bootstrap,
  cookieEndpointOrigin: () => frontend,
});
for (const [path, code] of compiled)
  app.get(path, (_r, reply) => reply.type("application/javascript").send(code));
app.get("/", (_r, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Trusted cookie component</title>"),
);
await app.listen({ host: "127.0.0.1", port: 0 });
frontend = "http://127.0.0.1:" + app.server.address().port;
const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  }),
  context = await browser.newContext(),
  page = await context.newPage(),
  groups = [];
const record = (name, result = true) => {
  assert.ok(result, name);
  groups.push({ name, result: "PASS" });
};
async function initialize() {
  await page.goto(frontend);
  await page.evaluate(async () => {
    localStorage.setItem("atlas-admin-sentinel", "frontend-private");
    document.cookie = "atlas_admin_fixture=frontend-private; Path=/";
    const { createSandboxCookieOwner } = await import("/owner.js");
    window.cookieOwner = await createSandboxCookieOwner({
      workerURL: "/worker.js",
      registrationHeaders: () => ({ "x-fixture-csrf": "fixture" }),
      browserSessionId: "same_browser_session_0123456789",
    });
    const originalBind=cookieOwner.bind;cookieOwner.bind=async x=>{const b=await originalBind(x);window.perfCookieEndpoint=b.endpoint;return b};
    window.documents = [];
  });
}
async function child(website = "https://cookie.fixture.example/path/page") {
  const id = await page.evaluate(async ({website}) => {
    const { createSandboxDocument } = await import("/controller.js");
    const doc = createSandboxDocument({
      website,
      documentOrigin: "opaque",
      container: document.body,
      factory: indexedDB,
      vault: {
        snapshot: async () => ({ revision: 0, entries: [] }),
        write: async () => ({ revision: 0, entries: [] }),
      },
      cookieProvider: cookieOwner,
      fetch: async (r) => ({
        url: r.url,
        status: 200,
        statusText: "OK",
        headers: [],
        body: new ArrayBuffer(0),
      }),
    });
    documents.push(doc);
    await doc.ready;
    return doc.documentId;
  }, {website});
  const frame = page
    .frames()
    .find((f) => f.url().includes("/browse/frame/" + id));
  await frame.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await frame.evaluate(() => window.fixtureError), undefined);
  return frame;
}
const network = async (
  lines,
  url = "https://cookie.fixture.example/path/page",
) =>
  page.evaluate(
    async ({ lines, url }) =>
      cookieOwner.storeResponseCookies(lines, {
        requestURL: url,
        documentURL: url,
        topLevelURL: url,
        credentials: "include",
      }),
    { lines, url },
  );
try {
  await initialize();
  const f=await child();
  const session=await context.newCDPSession(page);
  const results=[];
  for(const rate of [1,4,6]){
    await session.send('Emulation.setCPUThrottlingRate',{rate});
    await f.evaluate(()=>document.cookie='performance_proof=present; Path=/');
    const before=wire.length;
    const measurement=await f.evaluate(()=>{
      const start=performance.now();let bytes=0;
      for(let i=0;i<60;i++)bytes+=document.cookie.length;
      return {durationMs:performance.now()-start,reads:60,bytes};
    });
    results.push({rate,artificialLatencyMs,...measurement,HTTPResultRequests:wire.length-before});
  }
  const result={scope:'Real native cookie owner/worker, actual synchronous result XHR; synthetic opaque document, not a public website',results};
  fs.writeFileSync('evidence/client-lag-20261021/COOKIE_'+(process.env.ATLAS_COOKIE_CACHE==='1'?'BATCHED':'BASELINE')+'-'+artificialLatencyMs+'.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));

} finally {
  await browser.close();
  await app.close();
}
