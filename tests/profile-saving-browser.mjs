/** Disposable real Chromium/IDB/worker proof. HTTP transport is local synthetic,
 * not a live Hub acknowledgement or physical Chromebook qualification. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { decodePortableValue } from "../runtime/hub-contracts.ts";
import { unpackProfileRecovery } from "../runtime/profile-recovery-archive.ts";

const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const output = resolve(process.env.ATLAS_SAVING_BROWSER_EVIDENCE ||
  "evidence/profile-saving-reliability-20261022/browser");
await mkdir(output, { recursive: true });
const app = Fastify({ logger: false });
const uploadRuns = new Map();
const transport = [];
const recoveryReceipts = new Map();
let compiledWorker;
const sourceFiles = ["tests/profile-saving-browser.mjs", "runtime/hub-contracts.ts", "runtime/profile-wire.ts",
  "runtime/profile-recovery.ts", "runtime/profile-recovery-archive.ts", "runtime/profile-local-worker.ts",
  "runtime/profile-store.ts", "runtime/profile-sync.ts", "web/src/profile-local-store.ts"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (path) =>
  [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
const initialSourceHashes = await sourceHashes();
const routes = {
  "/profile-local-worker.js": "runtime/profile-local-worker.ts",
  "/profile-local-store.js": "web/src/profile-local-store.ts",
  "/profile-journal.js": "runtime/profile-journal.ts",
  "/profile-idb-catalog.js": "runtime/profile-idb-catalog.ts",
  "/hub-contracts.js": "runtime/hub-contracts.ts",
};
for (const [url, source] of Object.entries(routes)) {
  const code = (await build({ entryPoints: [source], bundle: true, write: false,
    format: "esm", target: "es2022", platform: "browser", logLevel: "silent" })).outputFiles[0].text;
  if (url === "/profile-local-worker.js") compiledWorker = code;
  app.get(url, (_request, reply) => reply.type("application/javascript").send(code));
}
app.get("/instrumented-worker.js", (_request, reply) => reply.type("application/javascript").send(`
{
const nativeOpen=IDBFactory.prototype.open;let operation='initialize';
IDBFactory.prototype.open=function(name,...args){self.postMessage({protocol:'atlas-saving-audit',operation,database:String(name)});return nativeOpen.call(this,name,...args)};
const profile='11111111-1111-4111-8111-111111111111',origin='https://save.performance.example';
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Test transaction failed'))});
self.addEventListener('message',async({data})=>{
 if(data?.protocol==='atlas-profile-local-v1'){operation=data.operation;return;}
 if(data?.protocol!=='atlas-saving-inspect')return;
 try{
  operation='test-'+data.operation;
  const journal=await import('/profile-journal.js');
  if(data.operation==='journal'){
   const r=indexedDB.open(journal.profileDatabaseName('atlas.browsing.v2',profile),1);r.onupgradeneeded=()=>r.result.createObjectStore('origins');const db=await request(r);
   const tx=db.transaction('origins','readwrite',{durability:'strict'}),completion=done(tx),s=tx.objectStore('origins');
   const target=data.origin||origin;s.put({revision:data.revision||1,entries:[['save',data.value||'local-only-retain']]},target);
   journal.appendProfileJournal(s,{profileId:profile,kind:'local',origin:target,bytes:128,payload:{revision:data.revision||1,change:{op:'set',key:'save',value:data.value||'local-only-retain'}}},'array');
   await completion;db.close();self.postMessage({protocol:'atlas-saving-inspect',id:data.id,value:{committed:true}});return;
  }
  if(data.operation==='local-state'){
   const db=await request(indexedDB.open(journal.profileDatabaseName('atlas.browsing.v2',profile),1));const tx=db.transaction('origins'),completion=done(tx);const value=await request(tx.objectStore('origins').get(origin));await completion;db.close();self.postMessage({protocol:'atlas-saving-inspect',id:data.id,value});return;
  }
  const r=indexedDB.open('atlas.profile.recovery.v1:profile:'+profile,1);r.onupgradeneeded=()=>r.result.createObjectStore('branches');const db=await request(r);
  const tx=db.transaction('branches'),completion=done(tx),s=tx.objectStore('branches');const [pending,archive]=await Promise.all([request(s.get('pending:'+data.recoveryId)),request(s.get(data.recoveryId))]);await completion;db.close();
  const bytes=pending?.payload?.archive?await pending.payload.archive.arrayBuffer():archive?.snapshot?.archive?await archive.snapshot.archive.arrayBuffer():null;
  const hash=bytes?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''):null;
  self.postMessage({protocol:'atlas-saving-inspect',id:data.id,value:{pending:!!pending,archived:!!archive,format:pending?.payload?.format||archive?.snapshot?.format,archiveBytes:bytes?.byteLength||0,archiveSHA256:hash,selectedChanges:pending?.changes?.length??archive?.changes?.length??0}});
 }catch(error){self.postMessage({protocol:'atlas-saving-inspect',id:data.id,error:error.message})}
});
}
` + compiledWorker));
app.get("/", (_request, reply) => reply.type("text/html").send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Atlas saving worker proof</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:32px;background:#101912;color:#eef4ec}main{max-width:900px;margin:auto}h1{font-size:24px}label{display:block;margin:24px 0 8px}textarea{box-sizing:border-box;width:100%;min-height:110px;padding:16px;background:#1b2920;color:inherit;border:1px solid #66825c;border-radius:12px;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1b2920;padding:20px;border-radius:12px}small{color:#b8c5b1}</style>
<main><h1>Atlas saving: real worker responsiveness</h1><p id="stage">Preparing isolated synthetic data.</p><small>Chromium 153 · CDP 4× CPU throttling · 1366×768 · Local mock transport, not production.</small>
<label for="typing">Trusted keyboard input while the worker saves</label><textarea id="typing" autocomplete="off" spellcheck="false"></textarea><pre id="result">Waiting for measurements…</pre></main></html>`));
app.post("/transport/chunk", { bodyLimit: 6_000_000 }, async (request) => {
  const run = String(request.headers["x-proof-run"] || ""), index = Number(request.headers["x-proof-index"]);
  assert.match(run, /^\d+$/); assert(Number.isSafeInteger(index) && index >= 0);
  const { hash, data } = request.body;
  const bytes = Buffer.from(data, "base64");
  assert.equal(bytes.toString("base64"), data);
  assert(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  if (!uploadRuns.has(run)) uploadRuns.set(run, new Map());
  uploadRuns.get(run).set(index, bytes);
  transport.push({ run, index, bytes: bytes.length, hash, status: 200 });
  return { acknowledged: true, hash, bytes: bytes.length };
});
app.get("/transport/graph", async (request, reply) => {
  const parts = uploadRuns.get(String(request.query.run));
  assert(parts?.size);
  return reply.header("cache-control", "no-store").type("application/octet-stream")
    .send(Buffer.concat([...parts].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])));
});
app.get("/transport/chunk", async (request) => {
  const bytes = uploadRuns.get(String(request.query.run))?.get(Number(request.query.index));
  assert(bytes);
  return { hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
    data: bytes.toString("base64") };
});
app.post("/transport/recovery", { bodyLimit: 2_000_000 }, async (request, reply) => {
  const { id, payload } = request.body;
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(payload.codec, "atlas-chunks-v1");
  const known = new Map([...uploadRuns.values()].flatMap((run) => [...run.values()])
    .map((bytes) => [createHash("sha256").update(bytes).digest("hex"), bytes]));
  const bytes = Buffer.concat(payload.hashes.map((hash) => { assert(known.has(hash)); return known.get(hash); }));
  assert.equal(bytes.length, payload.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), payload.sha256);
  const packed = decodePortableValue(JSON.parse(bytes.toString("utf8")));
  assert.equal(packed.format, "atlas-recovery-packed-v1");
  assert(packed.archive instanceof Blob);
  const previous = recoveryReceipts.get(id);
  if (previous) {
    assert.equal(previous.sha256, payload.sha256, "Lost-ACK retry must preserve exact wire bytes");
    return { acknowledged: true, id, replayed: true };
  }
  const value = await unpackProfileRecovery(packed);
  const native = value.snapshots.find((snapshot) => snapshot.namespace.kind === "idb" && snapshot.namespace.name === "large-native-save");
  assert(native);
  assert.equal(native.payload.stores[0].records.length, 14001);
  assert.equal(native.payload.stores[0].records[137].value.value, "synthetic-137");
  const cycle = native.payload.stores[0].records.find((record) => record.key === 20000).value;
  assert.equal(cycle.self, cycle);
  assert(cycle.bytes instanceof Uint8Array);
  assert.deepEqual([...cycle.bytes], [0, 255, 17]);
  const selectedChanges = recoveryReceipts.size ? 2 : 1;
  assert.equal(value.changes.length, selectedChanges);
  assert(value.snapshots.every((snapshot) => !snapshot.namespace.origin.includes("unrelated")));
  const loseReceipt = recoveryReceipts.size === 0;
  recoveryReceipts.set(id, { sha256: payload.sha256, bytes: packed.archive.size,
    verifiedNativeRecords: 14001, cycleAndBinary: true, selectedChanges });
  // The synthetic authority committed, but the first positive receipt is lost.
  // This is not a real Hub/database acknowledgement claim.
  return loseReceipt ? reply.code(503).send({ error: { code: "SYNTHETIC_ACK_LOST" } })
    : { acknowledged: true, id, replayed: false };
});

let browser;
const results = { syntheticDisposable: true, physicalChromebookQualified: false,
  productionRequests: 0, backendAcknowledgementsQualified: false,
  transportQualification: "Real local HTTP Blob request bodies with synthetic SHA-verified receipts only",
  viewport: { width: 1366, height: 768 }, cpuThrottle: 4, sourceHashes: initialSourceHashes, stages: [] };
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ||
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" });
  results.browser = await browser.version();
  assert.match(results.browser, /^153\./, "This evidence requires the pinned Chromium 153");
  const context = await browser.newContext({ viewport: results.viewport });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(origin);
  await page.evaluate(async () => {
    const { createProfileLocalStore } = await import("/profile-local-store.js");
    window.workerAudit = [];
    window.inspectSerial = 0;
    window.createLocal = () => createProfileLocalStore("11111111-1111-4111-8111-111111111111", {
      createWorker: () => {
        const worker = new Worker("/instrumented-worker.js", { type: "module" });
        worker.addEventListener("message", ({ data }) => { if (data?.protocol === "atlas-saving-audit") window.workerAudit.push(data); });
        window.localWorker = worker;
        return worker;
      },
    });
    window.local = window.createLocal();
    window.inspect = (operation, extra = {}) => new Promise((resolve, reject) => {
      const id = ++window.inspectSerial;
      const timeout = setTimeout(() => { window.localWorker.removeEventListener("message", receive); reject(Error("Synthetic inspect timeout")); }, 30000);
      const receive = ({ data }) => {
        if (data?.protocol !== "atlas-saving-inspect" || data.id !== id) return;
        clearTimeout(timeout); window.localWorker.removeEventListener("message", receive);
        if (data.error) reject(Error(data.error)); else resolve(data.value);
      };
      window.localWorker.addEventListener("message", receive);
      window.localWorker.postMessage({ protocol: "atlas-saving-inspect", id, operation, ...extra });
    });
    await window.local.prepareWire({ warmup: true });
    const bytes = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    window.syntheticWireValue = { format: "atlas-saving-browser-proof-v1",
      archive: new Blob([bytes], { type: "application/octet-stream" }),
      typed: new Uint8Array([0, 255, 17]), date: new Date("2026-10-22T00:00:00Z") };
    const input = document.querySelector("#typing");
    window.measurements = { input: [], frames: [], longtasks: [], blocked: [], busy: false };
    input.addEventListener("keydown", (event) => {
      if (window.measurements.busy) window.measurements.input.push({ trusted: event.isTrusted,
        delayMs: Math.max(0, performance.now() - event.timeStamp) });
    });
    let last = performance.now();
    const frame = (at) => {
      if (window.measurements.busy) window.measurements.frames.push(at - last);
      last = at; requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= (window.measurements.start || Infinity) &&
            entry.startTime <= (window.measurements.end || Infinity))
          window.measurements.longtasks.push({ start: entry.startTime, durationMs: entry.duration });
      }
    }).observe({ type: "longtask", buffered: false });
    const nativeBtoa = window.btoa;
    window.btoa = function () { window.measurements.blocked.push("MAIN_THREAD_BASE64"); throw Error("MAIN_THREAD_BASE64"); };
    const nativeAtob = window.atob;
    window.atob = function () { window.measurements.blocked.push("MAIN_THREAD_BASE64_DECODE"); throw Error("MAIN_THREAD_BASE64_DECODE"); };
    const nativeOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function () { window.measurements.blocked.push("MAIN_THREAD_IDB"); throw Error("MAIN_THREAD_IDB"); };
    const nativeStringify = JSON.stringify;
    JSON.stringify = function (value, ...args) {
      const graph = value?.codec === "atlas-portable-v1" ? value : value?.payload?.codec === "atlas-portable-v1" ? value.payload : null;
      if (graph && (graph.nodes.length > 1000 || graph.nodes.some((node) => typeof node.v === "string" && node.v.length > 500000))) {
        window.measurements.blocked.push("MAIN_THREAD_GRAPH_JSON"); throw Error("MAIN_THREAD_GRAPH_JSON");
      }
      return nativeStringify(value, ...args);
    };
    const nativeEncode = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = function (value) {
      if (typeof value === "string" && value.length > 500000) {
        window.measurements.blocked.push("MAIN_THREAD_LARGE_TEXT_ENCODING"); throw Error("MAIN_THREAD_LARGE_TEXT_ENCODING");
      }
      return nativeEncode.call(this, value);
    };
    window.restoreGuards = () => { window.btoa = nativeBtoa; window.atob = nativeAtob; IDBFactory.prototype.open = nativeOpen;
      JSON.stringify = nativeStringify; TextEncoder.prototype.encode = nativeEncode; };
    window.startMeasurement = (name) => {
      document.querySelector("#stage").textContent = name;
      window.measurements = { input: [], frames: [], longtasks: [], blocked: [], busy: true, start: performance.now() };
    };
    window.endMeasurement = async (details) => {
      window.measurements.end = performance.now(); window.measurements.busy = false;
      await new Promise((done) => setTimeout(done, 100));
      const metric = { ...window.measurements, details };
      delete metric.busy;
      document.querySelector("#result").textContent = JSON.stringify(metric, null, 2);
      return metric;
    };
    window.uploadPlan = async (plan, run) => {
      if (!plan.handle) throw Error("Expected chunk plan for the large synthetic recovery");
      for (let index = 0; index < plan.hashes.length; index++) {
        const chunk = await window.local.wireChunk(plan.handle, index);
        if (!(chunk.body instanceof Blob) || chunk.hash !== plan.hashes[index]) throw Error("Recovery chunk body mismatch");
        const response = await fetch("/transport/chunk", { method: "POST", headers: {
          "content-type": "application/json", "x-proof-run": String(run), "x-proof-index": String(index),
        }, body: chunk.body });
        const receipt = await response.json();
        if (!response.ok || receipt.acknowledged !== true || receipt.hash !== chunk.hash) throw Error("Synthetic recovery chunk receipt mismatch");
      }
      return { codec: "atlas-chunks-v1", hashes: plan.hashes, bytes: plan.bytes, sha256: plan.sha256 };
    };
  });
  await page.locator("#typing").focus();
  const runStage = async (name, operation) => {
    await page.evaluate((value) => window.startMeasurement(value), name);
    const work = page.evaluate(operation);
    const typing = page.keyboard.type("Atlas worker typing proof: 1234567890 abcdefghijklmnopqrstuvwxyz ", { delay: 12 });
    const details = await work;
    const metric = await page.evaluate((value) => window.endMeasurement(value), details);
    await typing;
    const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
    const stage = { name, ...metric, durationMs: metric.end - metric.start,
      trustedInputEvents: metric.input.filter((entry) => entry.trusted).length,
      inputDelayP95Ms: percentile(metric.input.map((entry) => entry.delayMs), .95),
      frameGapP95Ms: percentile(metric.frames, .95), frameGapMaxMs: metric.frames.length ? Math.max(...metric.frames) : null,
      longtaskMaxMs: metric.longtasks.length ? Math.max(...metric.longtasks.map((entry) => entry.durationMs)) : 0 };
    results.stages.push(stage);
    await page.evaluate((value) => {
      document.querySelector("#result").textContent = JSON.stringify({ stage: value.name,
        durationMs: value.durationMs, trustedInputEvents: value.trustedInputEvents,
        inputDelayP95Ms: value.inputDelayP95Ms, frameGapP95Ms: value.frameGapP95Ms,
        frameGapMaxMs: value.frameGapMaxMs, longtaskMaxMs: value.longtaskMaxMs,
        prohibitedMainThreadCalls: value.blocked, details: value.details }, null, 2);
    }, stage);
    assert.deepEqual(stage.blocked, [], "Heavy graph/base64 encoding and IDB must stay off the UI agent");
    assert(stage.trustedInputEvents >= 3, "Actual keyboard input must overlap worker execution");
    assert(stage.inputDelayP95Ms <= 100, "Observed input p95 exceeded 100ms under recorded desktop emulation");
    console.log(JSON.stringify({ stage: name, durationMs: stage.durationMs, trustedInputEvents: stage.trustedInputEvents,
      inputDelayP95Ms: stage.inputDelayP95Ms, frameGapP95Ms: stage.frameGapP95Ms,
      frameGapMaxMs: stage.frameGapMaxMs, longtaskMaxMs: stage.longtaskMaxMs }));
    return stage;
  };
  await runStage("Worker wire encode, Blob chunk upload and transferable decode", async () => {
    const plan = await window.local.prepareWire(window.syntheticWireValue);
    if (!plan.handle || plan.bytes <= 500000 || plan.hashes.length < 2) throw Error("Expected actual chunk wire plan");
    let bodyBytes = 0;
    for (let index = 0; index < plan.hashes.length; index++) {
      const chunk = await window.local.wireChunk(plan.handle, index);
      if (!(chunk.body instanceof Blob) || chunk.hash !== plan.hashes[index]) throw Error("Chunk body was not a matching Blob");
      bodyBytes += chunk.body.size;
      const response = await fetch("/transport/chunk", { method: "POST", headers: {
        "content-type": "application/json", "x-proof-run": "1", "x-proof-index": String(index),
      }, body: chunk.body });
      const receipt = await response.json();
      if (!response.ok || receipt.acknowledged !== true || receipt.hash !== chunk.hash) throw Error("Synthetic transport receipt mismatch");
    }
    const response = await fetch("/transport/graph?run=1");
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    if (bytes.byteLength !== plan.bytes || hash !== plan.sha256) throw Error("Downloaded wire SHA/size mismatch");
    const decoded = await window.local.decodeWire(bytes);
    if (bytes.byteLength !== 0) throw Error("Decode did not transfer the ArrayBuffer");
    const prefix = [...new Uint8Array(await decoded.archive.slice(0, 6).arrayBuffer())];
    if (!(decoded.archive instanceof Blob) || decoded.archive.size !== 8 * 1024 * 1024 ||
        prefix.join(",") !== "0,1,2,3,4,5" || !(decoded.date instanceof Date) ||
        !(decoded.typed instanceof Uint8Array) || [...decoded.typed].join(",") !== "0,255,17") throw Error("Restored native types or data mismatch");
    const encodedChunk = await (await fetch("/transport/chunk?run=1&index=0")).json();
    const decodedChunk = await window.local.decodeChunk(encodedChunk.data, encodedChunk.hash);
    const chunkHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", decodedChunk)), (value) => value.toString(16).padStart(2, "0")).join("");
    if (!(decodedChunk instanceof ArrayBuffer) || decodedChunk.byteLength !== 4 * 1024 * 1024 || chunkHash !== encodedChunk.hash)
      throw Error("Actual chunk worker base64 decode/integrity mismatch");
    await window.local.releaseWire(plan.handle);
    return { encodedBytes: plan.bytes, chunks: plan.hashes.length, bodyBytes,
      chunkBodiesWereBlobs: true, transferredDecode: true, workerBase64ChunkDecode: true, exactDataAndTypes: true };
  });
  await page.screenshot({ path: resolve(output, "WIRE_WORKER_4X.png"), fullPage: true });
  if (!process.argv.includes("--core-only")) {
    const seed = await page.evaluate(async () => {
      const records = Array.from({ length: 14000 }, (_, key) => ({ key, value: { index: key, value: "synthetic-" + key } }));
      const cycle = { bytes: new Uint8Array([0, 255, 17]) }; cycle.self = cycle;
      records.push({ key: 20000, value: cycle });
      const snapshot = { format: "atlas-idb-snapshot-v1", version: 1, stores: [{ name: "records", keyPath: null,
        autoIncrement: false, indexes: [], records, generator: null }] };
      await window.local.restore({ kind: "idb", origin: "https://save.performance.example", name: "large-native-save" }, snapshot, [], { revision: 1, epoch: 1 });
      await window.local.restore({ kind: "idb", origin: "https://unrelated.test", name: "unrelated-native-save" }, {
        ...snapshot, stores: [{ ...snapshot.stores[0], records: [{ key: 1, value: "unrelated-retained" }] }],
      }, [], { revision: 1, epoch: 1 });
      await window.inspect("journal");
      await window.inspect("journal", { origin: "https://unrelated.test", value: "unrelated-journal-retained" });
      let oldFailure;
      try { await window.local.encodeWire({ format: "atlas-recovery-v1", snapshots: [{ namespace: {
        kind: "idb", origin: "https://save.performance.example", name: "large-native-save" }, payload: snapshot }], changes: [] }); }
      catch (error) { oldFailure = error.message; }
      if (oldFailure !== "Portable graph exceeds allowance") throw Error("Synthetic native group did not reproduce the prior structural error");
      window.workerAudit = [];
      const exported = await window.local.exportSnapshots("performance.example");
      if (exported.some((entry) => entry.namespace.origin.includes("unrelated"))) throw Error("Filtered snapshot leaked unrelated data");
      const unrelatedOpened = window.workerAudit.filter((entry) => entry.operation === "export" && entry.database.includes(encodeURIComponent("https://unrelated.test")));
      if (unrelatedOpened.length) throw Error("Filtered export opened unrelated website IDB");
      window.recoveryId = crypto.randomUUID();
      return { legacyAggregateFailure: oldFailure, records: 14001, unrelatedPhysicalDBNotOpenedByExport: true };
    });
    results.seed = seed;
    await page.locator("#typing").focus();
    await runStage("Pack and durably stage a native group larger than 40,000 graph nodes", async () => {
      const prepared = await window.local.prepareRecovery(window.recoveryId, "https://save.performance.example");
      if (!prepared || prepared.changes !== 1) throw Error("Recovery did not select the exact group journal");
      window.firstPlan = prepared.wire;
      const staged = await window.inspect("state", { recoveryId: window.recoveryId });
      const queue = await window.local.queue.list();
      if (!staged.pending || staged.archived || staged.selectedChanges !== 1 || queue.length !== 2) throw Error("Preparing recovery retired or lost source entries");
      window.firstStaged = staged;
      return { ...staged, queueEntriesBeforeACK: queue.length, wireBytes: prepared.wire.bytes, chunks: prepared.wire.hashes.length };
    });
    await page.screenshot({ path: resolve(output, "RECOVERY_STAGE_4X.png"), fullPage: true });
    results.lostAck = await page.evaluate(async () => {
      const payload = await window.uploadPlan(window.firstPlan, 2);
      const response = await fetch("/transport/recovery", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: window.recoveryId, namespace: { kind: "local", origin: "https://save.performance.example" }, payload }) });
      if (response.status !== 503) throw Error("The first synthetic positive receipt was not withheld");
      await window.local.releaseWire(window.firstPlan.handle);
      window.local.dispose(); window.local = window.createLocal();
      await window.local.prepareWire({ restarted: true });
      await window.inspect("journal", { revision: 2, value: "newer-entry-must-not-retire" });
      const staged = await window.inspect("state", { recoveryId: window.recoveryId });
      if (!staged.pending || staged.archived || staged.archiveSHA256 !== window.firstStaged.archiveSHA256 || (await window.local.queue.list()).length !== 3)
        throw Error("Lost ACK/restart changed the prepared bytes or discarded a journal");
      return { committedSyntheticReceiptLost: true, workerRestarted: true,
        pendingBlobUnchanged: true, queueEntriesRetained: 3 };
    });
    await page.locator("#typing").focus();
    await runStage("Retry identical staged bytes after restart, then archive only acknowledged entries", async () => {
      const prepared = await window.local.prepareRecovery(window.recoveryId, "https://save.performance.example");
      if (prepared.changes !== 1 || prepared.wire.sha256 !== window.firstPlan.sha256 || prepared.wire.bytes !== window.firstPlan.bytes)
        throw Error("Recovery retry did not reuse the exact staged wire payload");
      const payload = await window.uploadPlan(prepared.wire, 3);
      const response = await fetch("/transport/recovery", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: window.recoveryId, namespace: { kind: "local", origin: "https://save.performance.example" }, payload }) });
      const receipt = await response.json();
      if (!response.ok || receipt.acknowledged !== true || receipt.id !== window.recoveryId) throw Error("No matching positive recovery receipt");
      await window.local.finishRecovery(window.recoveryId, "https://save.performance.example");
      await window.local.releaseWire(prepared.wire.handle);
      const state = await window.inspect("state", { recoveryId: window.recoveryId }), queue = await window.local.queue.list();
      if (state.pending || !state.archived || state.archiveSHA256 !== window.firstStaged.archiveSHA256 || queue.length !== 2 ||
          !queue.some((change) => change.entry.payload?.change?.value === "newer-entry-must-not-retire") ||
          !queue.some((change) => change.entry.origin === "https://unrelated.test")) throw Error("Recovery retired newer/unrelated entries or missed durable archival");
      return { ...state, remainingNewerAndUnrelatedEntries: queue.length,
        matchingPositiveSyntheticReceipt: true, deterministicWireRetry: true };
    });
    await page.screenshot({ path: resolve(output, "RECOVERY_FINISHED_4X.png"), fullPage: true });
    await page.locator("#typing").focus();
    await runStage("Finalize-response crash replay preserves newer entries, then a new backup retires only its own ACKed entries", async () => {
      await window.inspect("journal", { revision: 3, value: "post-finish-crash-window" });
      const before = await window.local.queue.list();
      if (before.length !== 3) throw Error("New crash-window journal was not durable");
      const replay = await window.local.prepareRecovery(window.recoveryId, "https://save.performance.example");
      if (replay.wire.sha256 !== window.firstPlan.sha256 || replay.wire.bytes !== window.firstPlan.bytes || replay.changes !== 1)
        throw Error("Finalized recovery ID was reused for a different payload");
      const payload = await window.uploadPlan(replay.wire, 4);
      const response = await fetch("/transport/recovery", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: window.recoveryId, namespace: { kind: "local", origin: "https://save.performance.example" }, payload }) });
      const receipt = await response.json();
      if (!response.ok || receipt.acknowledged !== true || receipt.id !== window.recoveryId) throw Error("No positive replay receipt");
      await window.local.finishRecovery(window.recoveryId, "https://save.performance.example");
      await window.local.releaseWire(replay.wire.handle);
      if ((await window.local.queue.list()).length !== 3) throw Error("Finalization replay retired newer journal entries");
      const freshId = crypto.randomUUID(), fresh = await window.local.prepareRecovery(freshId, "https://save.performance.example");
      if (fresh.changes !== 2 || fresh.wire.sha256 === window.firstPlan.sha256 || (await window.local.queue.list()).length !== 3)
        throw Error("A new recovery ID failed to stage only the two remaining target changes");
      const freshPayload = await window.uploadPlan(fresh.wire, 5);
      const freshResponse = await fetch("/transport/recovery", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: freshId, namespace: { kind: "local", origin: "https://save.performance.example" }, payload: freshPayload }) });
      const freshReceipt = await freshResponse.json();
      if (!freshResponse.ok || freshReceipt.acknowledged !== true || freshReceipt.id !== freshId) throw Error("New recovery lacks matching ACK");
      await window.local.finishRecovery(freshId, "https://save.performance.example");
      await window.local.releaseWire(fresh.wire.handle);
      const remaining = await window.local.queue.list(), namespaces = await window.local.pendingNamespaces();
      const current = await window.inspect("local-state");
      if (remaining.length !== 1 || remaining[0].entry.origin !== "https://unrelated.test" ||
          namespaces.length !== 1 || namespaces[0].origin !== "https://unrelated.test" ||
          current.revision !== 3 || current.entries[0][1] !== "post-finish-crash-window")
        throw Error("New recovery deleted native saves, unrelated data, or returned wrong namespace metadata");
      return { finalizedIdByteIdentical: true, sameIdReplayPreservedAllThreeEntries: true,
        newIdACKRetiredOnlyTwoSelectedEntries: true, unrelatedEntryRemains: true,
        nativeSaveRevisionAndValueUnchanged: true, namespaceMetadataExact: true };
    });
    await page.screenshot({ path: resolve(output, "FINALIZE_CRASH_REPLAY_4X.png"), fullPage: true });
    results.recovery = { complete: true, selectedNativeRecords: 14001,
      oldStructuralErrorReproduced: true, noPrematureRetirement: true, syntheticAckOnly: true };
  } else results.recovery = { skipped: true, reason: "Explicit --core-only" };
  await page.evaluate(() => { window.restoreGuards(); window.local.dispose(); });
  const finalSourceHashes = await sourceHashes();
  assert.deepEqual(finalSourceHashes, initialSourceHashes, "Covered source changed while browser evidence was being captured; rerun on settled source");
  results.sourceStayedUnchanged = true;
  results.result = process.argv.includes("--core-only") ? "CORE_ONLY_PASS" : "PASS";
} catch (error) {
  results.result = "FAILED"; results.error = { name: error.name, message: error.message };
  throw error;
} finally {
  results.transport = transport;
  await writeFile(resolve(output, "RESULTS.json"), JSON.stringify(results, null, 2) + "\n");
  await browser?.close(); await app.close();
}
