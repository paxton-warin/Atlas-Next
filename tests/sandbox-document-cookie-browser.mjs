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
import { adaptPinnedRuntimeBundle } from "./opaque-runtime-fork.mjs";
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
 const boot=api.bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL:data.website,prefix:location.origin+'/~/app/cookie-fixture/',network,localStorage:storage(),sessionStorage:storage(),installIndexedDB:()=>{},cookies,onNavigate:()=>{},sendSetCookie:async()=>{throw Error('stock cookie path must never run')}});
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
    window.documents = [];
  });
}
async function child(website = "https://cookie.fixture.example/path/page") {
  const id = await page.evaluate(async (website) => {
    const { createSandboxDocument } = await import("/controller.js");
    const doc = createSandboxDocument({
      website,
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
  }, website);
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
  let f = await child();
  if(process.env.ATLAS_COOKIE_CACHE === '1') {
    const before = wire.length;
    const proof = await f.evaluate(() => runFixture(`(()=>{const values=[];for(let i=0;i<60;i++)values.push(document.cookie);document.cookie='batch_proof=acknowledged; Path=/';const after=document.cookie;return {same:values.every(v=>v===values[0]),after}})()`));
    assert.equal(proof.same,true);assert.match(proof.after,/batch_proof=acknowledged/);
    assert.equal(wire.length-before,2,'one authoritative initial read plus one completed write, no redundant reads');
    await f.evaluate(() => Promise.resolve());
    const again=wire.length;await f.evaluate(()=>document.cookie);assert.equal(wire.length-again,1,'next job reads the current worker authority');
    await f.evaluate(()=>{document.cookie='batch_proof=; Path=/; Max-Age=0'});
    record('same-job reads share only acknowledged results; write/read ordering and next-job refresh retained');
  }
  assert.equal(new URL(f.url()).origin, frontend);
  record(
    "frontend frame URL and browser-enforced opaque origin",
    await f.evaluate(() => nativeOriginBeforeRuntime === "null"),
  );
  assert.deepEqual(
    await f.evaluate(() => {
      let dom = false,
        storage = false;
      try {
        void parent.document.body;
      } catch {
        dom = true;
      }
      try {
        void parent.localStorage;
      } catch {
        storage = true;
      }
      return [dom, storage];
    }),
    [true, true],
  );
  record("frontend DOM and native storage denied");
  await network([
    "protected=hidden-fixture; HttpOnly; Path=/; Max-Age=600",
    "dupe=root; Path=/; Max-Age=600",
    "dupe=path; Path=/path; Max-Age=600",
  ]);
  const own = await f.evaluate(() =>
    runFixture(
      `(()=>{const result=[];document.cookie='save=immediate; Path=/; Max-Age=600';result.push(document.cookie);document.cookie='protected=overwrite; Path=/';result.push(document.cookie);document.cookie='save=; Path=/; Max-Age=0';result.push(document.cookie);document.cookie='secure=first; Secure; Path=/';document.cookie='secure=second; Path=/';result.push(document.cookie);return result})()`,
    ),
  );
  assert.match(own[0], /save=immediate/);
  assert.match(own[0], /dupe=path; dupe=root/);
  assert.ok(
    own.every((s) => !s.includes("protected") && !s.includes("hidden-fixture")),
  );
  assert.ok(!own[2].includes("save="));
  assert.match(own[3], /secure=second/);
  record(
    "same-task set/read, hidden HttpOnly collision noop, duplicate path order, deletion and HTTPS Secure overwrite",
  );
  const peer = await child("https://peer.fixture.example/");
  assert.equal(await peer.evaluate(() => document.cookie), "");
  record("peer-site namespace denied");
  const other = await child("https://cookie.fixture.example/elsewhere");
  assert.equal(
    (await other.evaluate(() => document.cookie)).includes("dupe=path"),
    false,
  );
  record("same-site document gets only path-visible view");
  const historyViews = await f.evaluate(() =>
    runFixture(
      `(()=>{history.pushState({},'', '/different/route'); const away=document.cookie; document.cookie='defaultPath=route-local; Max-Age=600'; const route=document.cookie; history.replaceState({},'', '/path/page'); return [away,route,document.cookie];})()`,
    ),
  );
  assert.ok(!historyViews[0].includes("dupe=path"));
  assert.match(historyViews[1], /defaultPath=route-local/);
  assert.ok(!historyViews[2].includes("defaultPath="));
  assert.match(historyViews[2], /dupe=path/);
  assert.equal(
    await f.evaluate(() => {
      try {
        cookieFacade.setURL("https://peer.fixture.example/");
        return "unexpected";
      } catch (error) {
        return error.name;
      }
    }),
    "SecurityError",
  );
  record(
    "same-task SPA history changes update path/default-Path without allowing another website origin",
  );
  await network(["fromNetwork=committed; Path=/; Max-Age=600"]);
  assert.match(
    await f.evaluate(() => document.cookie),
    /fromNetwork=committed/,
  );
  record("network cookie commits visible to authoritative synchronous getter");
  await other.evaluate(() => {
    document.cookie = "otherTab=updated; Path=/; Max-Age=600";
  });
  assert.match(await f.evaluate(() => document.cookie), /otherTab=updated/);
  record("other document writes visible without a child event-loop turn");
  await f.evaluate(() => {
    document.cookie = "expires=short; Path=/; Max-Age=1";
  });
  await new Promise((r) => setTimeout(r, 1150));
  assert.ok(!(await f.evaluate(() => document.cookie)).includes("expires="));
  record("getter expires elapsed cookies authoritatively");
  await f.evaluate(() => {
    document.cookie = "reload=durable; Path=/; Max-Age=600";
  });
  await initialize();
  f = await child();
  assert.match(await f.evaluate(() => document.cookie), /reload=durable/);
  record("immediate whole-frontend reload preserves committed cookie");
  assert.ok(
    wire.every(
      (r) =>
        r.origin === "null" &&
        !r.cookie &&
        !r.authorization &&
        Object.keys(r.body).join(",") === "sequence",
    ),
  );
  assert.ok(
    wire.every(
      (r) =>
        !r.packet ||
        !Buffer.from(r.packet, "base64").includes(
          Buffer.from("hidden-fixture"),
        ),
    ),
  );
  assert.ok(
    wire.every(
      (r) =>
        !r.packet ||
        !Buffer.from(r.packet, "base64").includes(
          Buffer.from("reload=durable"),
        ),
    ),
  );
  record(
    "HTTP inputs are anonymous sequence-only; outputs contain no plaintext cookie view",
  );
  tamper = true;
  assert.equal(
    await f.evaluate(() => {
      try {
        void document.cookie;
        return "unexpected";
      } catch (e) {
        return e.name;
      }
    }),
    "SecurityError",
  );
  tamper = false;
  record("tampered ciphertext fails closed");
  f = await child();
  await f.evaluate(() => document.cookie);
  replay = true;
  assert.equal(
    await f.evaluate(() => {
      try {
        void document.cookie;
        return "unexpected";
      } catch (e) {
        return e.name;
      }
    }),
    "SecurityError",
  );
  replay = false;
  record("prior-sequence ciphertext replay fails closed");
  f = await child();
  drop = true;
  assert.equal(
    await f.evaluate(() => {
      try {
        document.cookie = "ambiguous=committed; Path=/; Max-Age=600";
        return "unexpected";
      } catch (e) {
        return e.name;
      }
    }),
    "NetworkError",
  );
  drop = false;
  f = await child();
  assert.match(await f.evaluate(() => document.cookie), /ambiguous=committed/);
  record(
    "lost acknowledgement reports ambiguous failure, never falsely claims rollback",
  );
  f = await child();
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("atlas.browsing.cookies.v2");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    window.cookieLockLive = true;
    window.cookieLockDB = db;
    const tx = db.transaction(["cookies", "meta"], "readwrite");
    window.cookieLockDone = new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onabort = resolve;
    });
    const pump = () => {
      const r = tx.objectStore("meta").get("hold");
      r.onsuccess = () => {
        if (cookieLockLive) pump();
      };
    };
    pump();
  });
  assert.equal(
    await f.evaluate(() => {
      try {
        document.cookie = "cancelledWrite=must-not-commit; Path=/; Max-Age=600";
        return "unexpected";
      } catch (e) {
        return e.name;
      }
    }),
    "NetworkError",
  );
  await page.evaluate(async () => {
    cookieLockLive = false;
    await cookieLockDone;
    cookieLockDB.close();
  });
  f = await child();
  assert.ok(
    !(await f.evaluate(() => document.cookie)).includes("cancelledWrite="),
  );
  record(
    "deadline revocation aborts native queued cookie write before later lock release",
  );
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("atlas.browsing.cookies.v2");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    let holding = true;
    const tx = db.transaction(["cookies", "meta"], "readwrite");
    const ended = new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onabort = resolve;
    });
    const pump = () => {
      const r = tx.objectStore("meta").get("hold");
      r.onsuccess = () => {
        if (holding) pump();
      };
    };
    pump();
    const abort = new AbortController();
    const operation = cookieOwner.storeResponseCookies(
      ["networkAborted=must-not-commit; Path=/; Max-Age=600"],
      {
        requestURL: "https://cookie.fixture.example/",
        documentURL: "https://cookie.fixture.example/",
        topLevelURL: "https://cookie.fixture.example/",
        credentials: "include",
        signal: abort.signal,
      },
    );
    setTimeout(
      () => abort.abort(new DOMException("fixture abort", "AbortError")),
      30,
    );
    try {
      await operation;
      throw Error("unexpected success");
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
    holding = false;
    await ended;
    db.close();
  });
  f = await child();
  assert.ok(
    !(await f.evaluate(() => document.cookie)).includes("networkAborted="),
  );
  record(
    "trusted network AbortSignal cancels queued native cookie transaction",
  );
  const bulkURL = "https://bulk-cookie.example/";
  const bulk = Array.from(
    { length: 150 },
    (_, index) =>
      "bulk" + index + "=" + "A".repeat(4000) + "; Path=/; Max-Age=600",
  );
  assert.equal((await network(bulk.slice(0, 90), bulkURL)).accepted, 90);
  assert.equal((await network(bulk.slice(90), bulkURL)).accepted, 60);
  const bulkFrame = await child(bulkURL);
  assert.ok((await bulkFrame.evaluate(() => document.cookie.length)) > 590000);
  assert.ok(wire.some((entry) => entry.packet?.length > 750000));
  record(
    "valid large cookie view crosses encrypted result channel without truncation or false quota acknowledgement",
  );
  f = await child();
  await context.setOffline(true);
  assert.equal(
    await f.evaluate(() => {
      try {
        void document.cookie;
        return "unexpected";
      } catch (e) {
        return e.name;
      }
    }),
    "NetworkError",
  );
  await context.setOffline(false);
  record(
    "offline synchronous access fails explicitly rather than returning stale success",
  );
  const output =
    process.argv[2] ||
    "evidence/combined-update-20261015/sandbox-document-cookie-browser.json";
  const receipt = {
    command: "node tests/sandbox-document-cookie-browser.mjs",
    recordedAt: new Date().toISOString(),
    localOnly: true,
    productionChanged: false,
    generalRuntimeQualified: false,
    encryptedResultTrafficNotMarkerOnly: true,
    groups,
    requests: wire.length,
    limitations: [
      "Synchronous getter depends on frontend rendezvous availability, not offline native equivalence.",
      "Network control-port abort after posting may leave a committed outcome; owner lifecycle/abort parity remains held.",
      "Prototype runtime only; public login/app performance and fleet validation remain held.",
    ],
    sources: Object.fromEntries(
      [
        "sandbox-document-cookie",
        "sandbox-cookie-result",
        "sandbox-cookie-worker",
        "sandbox-cookie-owner",
      ].map((n) => [
        "runtime/" + n + ".ts",
        createHash("sha256")
          .update(fs.readFileSync("runtime/" + n + ".ts"))
          .digest("hex"),
      ]),
    ),
  };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      result: "PASS",
      groups: groups.length,
      requests: wire.length,
      output,
    }),
  );
} finally {
  await browser.close();
  await app.close();
}
