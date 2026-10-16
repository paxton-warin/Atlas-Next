#!/usr/bin/env node
// Local-only browser experiment. No Atlas application/server modules are changed.
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const output = resolve(
  process.argv[2] ||
    "evidence/combined-update-20261015/opaque-sync-storage-feasibility.json",
);
const executablePath =
  process.env.CHROME_PATH ||
  [
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
if (!executablePath)
  throw Error("Set CHROME_PATH to a local Chromium executable.");
const serverHits = [];
let frontend;
const workerSource = `
let database;
const ready=(async()=>{
 try {
  database=await new Promise((resolve,reject)=>{
   const r=indexedDB.open('atlas-sync-feasibility',1);
   r.onupgradeneeded=()=>r.result.createObjectStore('data');
   r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  return {database:'available'};
 }catch(e){return {database:e.name,message:e.message};}
})();
ready.then(state=>postMessage({type:'ready',isolated:crossOriginIsolated,urlOrigin:location.origin,effectiveOrigin:self.origin??null,...state}));
onmessageerror=()=>postMessage({type:'worker-messageerror'});
onmessage=async({data})=>{
 if(data.kind==='port'){
  data.port.onmessageerror=()=>postMessage({type:'port-messageerror'});
  data.port.onmessage=e=>postMessage({type:'port-message',constructor:e.data?.constructor?.name});
  data.port.start();postMessage({type:'port-ready'});return;
 }
 if(data.kind==='probe'){
  const result=await ready;
  Atomics.store(new Int32Array(data.buffer),0,1);
  postMessage({type:'probe',...result});return;
 }
 const state=await ready;
 if(state.database!=='available'){Atomics.store(new Int32Array(data.buffer),0,4);return;}
 const flag=new Int32Array(data.buffer);
 try{
  const tx=database.transaction('data','readwrite');
  if(data.value.length>32){tx.abort();Atomics.store(flag,0,3);return;}
  tx.objectStore('data').put(data.value,data.key);
  tx.oncomplete=()=>Atomics.store(flag,0,1);
  tx.onabort=()=>Atomics.store(flag,0,2);
 }catch(e){Atomics.store(flag,0,2);}
};`;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, frontend || "http://127.0.0.1");
  const coep =
    url.searchParams.get("coep") === "credentialless"
      ? "credentialless"
      : "require-corp";
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", coep);
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Permissions-Policy", "cross-origin-isolated=*");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Origin-Agent-Cluster", "?0");
  if (url.pathname === "/worker.js") {
    response.setHeader("Content-Type", "application/javascript");
    return response.end(workerSource);
  }
  if (url.pathname === "/sync/sw.js") {
    response.setHeader("Content-Type", "application/javascript");
    return response.end(
      `addEventListener('install',()=>self.skipWaiting());addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/sync/storage')e.respondWith(new Response('SERVICE_WORKER',{headers:{'Content-Type':'text/plain'}}));});`,
    );
  }
  if (url.pathname === "/sync/storage") {
    serverHits.push({
      path: url.pathname,
      origin: request.headers.origin || null,
    });
    response.setHeader("Content-Type", "text/plain");
    return response.end("NETWORK");
  }
  if (url.pathname.endsWith("/child"))
    response.setHeader(
      "Content-Security-Policy",
      `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${frontend} blob: data:; worker-src ${frontend} blob: data:; connect-src ${frontend}; frame-src ${frontend}; style-src 'unsafe-inline'`,
    );
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>Local opaque synchronous storage feasibility</title>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
frontend = `http://127.0.0.1:${server.address().port}`;
const receipt = {
  version: 1,
  recordedAt: new Date().toISOString(),
  sourceSha256: createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex"),
  command: `node scripts/opaque-sync-storage-feasibility.mjs ${process.argv[2] || "evidence/combined-update-20261015/opaque-sync-storage-feasibility.json"}`,
  localOnly: true,
  productionChanged: false,
  websiteRuntimeQualified: false,
  modes: [],
  sources: [
    "https://html.spec.whatwg.org/multipage/webappapis.html#agents-and-agent-clusters",
    "https://html.spec.whatwg.org/multipage/structured-data.html#sharedarraybuffer-serialization",
    "https://w3c.github.io/ServiceWorker/spec/service_worker/#control-and-use-window-client",
  ],
};
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  receipt.browser = browser.version();
  for (const coep of ["require-corp", "credentialless"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(frontend + "/shell?coep=" + coep);
    const parent = await page.evaluate(() => ({
      isolated: crossOriginIsolated,
      effectiveOrigin: window.origin,
      originAgentCluster,
      sharedArrayBuffer: typeof SharedArrayBuffer,
    }));
    await page.evaluate(
      (coep) =>
        new Promise((resolve) => {
          const frame = document.createElement("iframe");
          frame.allow = "cross-origin-isolated *";
          frame.sandbox = "allow-scripts";
          frame.src = "/child?coep=" + coep;
          frame.onload = resolve;
          document.body.append(frame);
        }),
      coep,
    );
    const child = page
      .frames()
      .find((frame) => frame.parentFrame() === page.mainFrame());
    const childState = await child.evaluate(() => {
      let indexedDBAccess;
      try {
        indexedDB.open("opaque-denied");
        indexedDBAccess = "unexpected_allowed";
      } catch (error) {
        indexedDBAccess = error.name;
      }
      let wasm;
      try {
        wasm = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
          .buffer.constructor.name;
      } catch (error) {
        wasm = error.name;
      }
      return {
        isolated: crossOriginIsolated,
        effectiveOrigin: window.origin,
        urlOrigin: location.origin,
        originAgentCluster,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        wasmSharedMemory: wasm,
        indexedDBAccess,
      };
    });
    const mode = { coep, parent, child: childState, crossBoundary: [] };
    assert.equal(parent.isolated, true);
    assert.equal(childState.effectiveOrigin, "null");
    assert.equal(childState.indexedDBAccess, "SecurityError");
    for (const vector of [
      "SharedArrayBuffer",
      "WebAssembly.Memory.buffer",
      "WebAssembly.Memory",
    ]) {
      await child.evaluate(() => {
        window.probeEvents = [];
        window.onmessage = (event) =>
          window.probeEvents.push({
            type: "message",
            valueType: event.data?.value?.constructor?.name,
          });
        window.onmessageerror = () =>
          window.probeEvents.push({ type: "messageerror" });
      });
      const sent = await page.evaluate((vector) => {
        try {
          const memory = new WebAssembly.Memory({
            initial: 1,
            maximum: 1,
            shared: true,
          });
          const value =
            vector === "SharedArrayBuffer"
              ? new SharedArrayBuffer(8)
              : vector === "WebAssembly.Memory.buffer"
                ? memory.buffer
                : memory;
          document
            .querySelector("iframe")
            .contentWindow.postMessage({ value }, "*");
          return "returned";
        } catch (error) {
          return error.name;
        }
      }, vector);
      if (sent === "returned")
        await child.waitForFunction(() => window.probeEvents.length > 0);
      const events = await child.evaluate(() => window.probeEvents);
      mode.crossBoundary.push({ vector, sent, events });
      assert.equal(
        events.some((event) => event.type === "message"),
        false,
      );
    }
    mode.opaqueWorker = await child.evaluate(async (workerSource) => {
      const outcome = {};
      for (const type of ["classic", "module"]) {
        try {
          const worker = new Worker(location.origin + "/worker.js", { type });
          outcome[type] = await new Promise((resolve) => {
            worker.onmessage = (e) => resolve(e.data);
            worker.onerror = (e) => {
              e.preventDefault();
              resolve({ error: e.message });
            };
            setTimeout(() => resolve({ error: "timeout" }), 2000);
          });
          worker.terminate();
        } catch (error) {
          outcome[type] = { error: error.name, message: error.message };
        }
      }
      const url = URL.createObjectURL(
        new Blob([workerSource], { type: "application/javascript" }),
      );
      let worker;
      try {
        worker = new Worker(url);
        const events = [];
        worker.onmessage = (event) => events.push(event.data);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("opaque_worker_ready_timeout")),
            3000,
          );
          worker.addEventListener(
            "message",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          worker.onerror = (e) => {
            e.preventDefault();
            clearTimeout(timer);
            reject(Error(e.message));
          };
        });
        const buffer = new SharedArrayBuffer(8),
          flag = new Int32Array(buffer);
        worker.postMessage({ kind: "probe", buffer });
        const start = performance.now();
        while (
          Atomics.load(flag, 0) === 0 &&
          performance.now() - start < 3000
        ) {}
        const spinMilliseconds = performance.now() - start;
        await new Promise((resolve) => setTimeout(resolve, 30));
        outcome.blob = {
          state: events[0],
          sharedSignal: Atomics.load(flag, 0),
          events,
          spinMilliseconds,
        };
      } catch (error) {
        outcome.blob = { error: error.name, message: error.message };
      } finally {
        worker?.terminate();
        URL.revokeObjectURL(url);
      }
      return outcome;
    }, workerSource);
    mode.trustedWorker = await page.evaluate(async () => {
      const worker = new Worker("/worker.js");
      const ready = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = (e) => reject(Error(e.message));
      });
      function write(key, value) {
        const buffer = new SharedArrayBuffer(8),
          flag = new Int32Array(buffer);
        worker.postMessage({ kind: "write", key, value, buffer });
        const start = performance.now();
        while (
          Atomics.load(flag, 0) === 0 &&
          performance.now() - start < 3000
        ) {}
        const status = Atomics.load(flag, 0);
        if (status === 3)
          throw new DOMException(
            "Fixture quota exceeded",
            "QuotaExceededError",
          );
        if (status !== 1) throw Error("sync_worker_status_" + status);
        return { status, spinMilliseconds: performance.now() - start };
      }
      const committed = write("save", "worker-committed");
      let quota;
      try {
        write("save", "x".repeat(33));
        quota = "unexpected_commit";
      } catch (error) {
        quota = error.name;
      }
      worker.terminate();
      return { ready, committed, quota };
    });
    await page.reload();
    mode.trustedWorker.afterReload = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("atlas-sync-feasibility", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const value = await new Promise((resolve, reject) => {
        const r = db.transaction("data").objectStore("data").get("save");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return value;
    });
    assert.equal(mode.trustedWorker.afterReload, "worker-committed");
    assert.equal(mode.trustedWorker.quota, "QuotaExceededError");
    // A successful same-agent positive control does not qualify cross-opaque use.
    receipt.modes.push(mode);
    console.log(
      JSON.stringify({
        coep,
        parent: parent.isolated,
        opaqueIsolated: childState.isolated,
        crossBoundary: mode.crossBoundary,
        opaqueWorker: mode.opaqueWorker,
        trustedWorker: mode.trustedWorker,
      }),
    );
    await context.close();
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(frontend + "/sync/shell");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sync/sw.js", { scope: "/sync/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
  });
  const parentAsyncFetch = await page.evaluate(() =>
    fetch("/sync/storage").then((response) => response.text()),
  );
  const parentSyncXHR = await page.evaluate(() => {
    const r = new XMLHttpRequest();
    r.open("GET", "/sync/storage", false);
    r.send();
    return {
      status: r.status,
      text: r.responseText,
      controlled: !!navigator.serviceWorker.controller,
    };
  });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const f = document.createElement("iframe");
        f.sandbox = "allow-scripts";
        f.allow = "cross-origin-isolated *";
        f.src = "/sync/child";
        f.onload = resolve;
        document.body.append(f);
      }),
  );
  const child = page
    .frames()
    .find((frame) => frame.parentFrame() === page.mainFrame());
  const opaqueSyncXHR = await child.evaluate(() => {
    let controller;
    try {
      controller = !!navigator.serviceWorker.controller;
    } catch (error) {
      controller = error.name;
    }
    try {
      const r = new XMLHttpRequest();
      r.open("GET", location.origin + "/sync/storage", false);
      r.send();
      return { status: r.status, text: r.responseText, controller };
    } catch (error) {
      return { error: error.name, message: error.message, controller };
    }
  });
  receipt.synchronousXHR = {
    parentAsyncFetch,
    parent: parentSyncXHR,
    opaque: opaqueSyncXHR,
    serverHits,
  };
  assert.equal(parentAsyncFetch, "SERVICE_WORKER");
  assert.equal(parentSyncXHR.text, "NETWORK");
  assert.equal(opaqueSyncXHR.text, "NETWORK");
  assert.equal(opaqueSyncXHR.controller, "SecurityError");
  assert.deepEqual(serverHits, [
    { path: "/sync/storage", origin: null },
    { path: "/sync/storage", origin: "null" },
  ]);
  await context.close();
  receipt.result = "tested_constraints_and_positive_control";
  receipt.constraints = [
    "Cross-origin isolation enables SAB in the opaque child, but does not merge its agent cluster with the frontend.",
    "Parent-to-opaque SAB and shared WebAssembly memory fail delivery across the agent-cluster boundary.",
    "A trusted same-agent worker can commit browser IDB while its owner spins, preserving committed value and synchronous quota errors; this alone does not cross the opaque boundary.",
    "The opaque-owned worker does not obtain frontend native IDB authority.",
    "Asynchronous fetch confirms the scoped frontend service worker is active; synchronous XHR bypasses it in both the controlled frontend and opaque child.",
  ];
  receipt.exitStatus = 0;
} catch (error) {
  receipt.result = "probe_failure";
  receipt.failure = { name: error.name, message: error.message };
  receipt.exitStatus = 1;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      receipt: output,
      result: receipt.result,
      websiteRuntimeQualified: false,
      exitStatus: receipt.exitStatus,
    }),
  );
}
