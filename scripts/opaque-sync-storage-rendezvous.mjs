#!/usr/bin/env node
// A local-only feasibility experiment, not an activated Atlas runtime.
import http from "node:http";
import { WebSocketServer } from "ws";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(
  process.argv[2] ||
    "evidence/combined-update-20261015/opaque-sync-storage-rendezvous.json",
);
const executablePath =
  process.env.CHROME_PATH ||
  [
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
if (!executablePath)
  throw Error("Set CHROME_PATH to a local Chromium executable.");
const website = "https://storage.fixture.example";
const workerCapability = randomBytes(32).toString("hex");
const documentCapabilities = new Set();
const pending = new Map();
const events = [];
let frontend,
  socket,
  nextDelay = 0;
const timeoutMilliseconds = 250;
const workerSource = `
let socket,site,database;
const requests=new Map();
function send(value){socket.send(JSON.stringify(value));}
async function open(){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open('atlas-sync-rendezvous-feasibility',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('data');
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
 });
}
function execute(message,entry){
 if(entry.cancelled)return;
 const tx=database.transaction('data',message.op==='get'?'readonly':'readwrite');
 entry.transaction=tx;
 const store=tx.objectStore('data');let value;
 const request=message.op==='get'?store.get(site+'@'+message.key):store.put(message.value,site+'@'+message.key);
 request.onsuccess=()=>{value=request.result;};
 tx.oncomplete=()=>{requests.delete(message.id);send({type:'result',id:message.id,ok:true,result:message.op==='get'?(value??null):null,committed:message.op==='set'});};
 tx.onabort=()=>{requests.delete(message.id);send({type:'result',id:message.id,ok:false,error:tx.error?.name||'AbortError',committed:false});};
}
onmessage=async({data})=>{
 if(data.type!=='start')return;
 site=new URL(data.website).origin;database=await open();socket=new WebSocket(data.socketURL);
 socket.onopen=()=>postMessage({type:'ready',database:'browser-native-IDB',site,crossOriginIsolated});
 socket.onerror=()=>postMessage({type:'socket-error'});
 socket.onmessage=({data})=>{
  const message=JSON.parse(data);
  if(message.type==='cancel'){
   const entry=requests.get(message.id);
   if(entry){entry.cancelled=true;clearTimeout(entry.timer);if(entry.transaction)try{entry.transaction.abort()}catch{}requests.delete(message.id);}
   send({type:'cancelled',id:message.id});return;
  }
  const entry={cancelled:false,timer:null,transaction:null};requests.set(message.id,entry);
  if(message.delay)entry.timer=setTimeout(()=>execute(message,entry),message.delay);
  else execute(message,entry);
 };
};`;

function respond(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function cancel(id, reason) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (socket?.readyState === 1)
    socket.send(JSON.stringify({ type: "cancel", id }));
  events.push({ type: "cancel-sent", id, reason });
}
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, frontend || "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname.startsWith("/storage-sync/")) {
    const capability = url.pathname.slice("/storage-sync/".length);
    response.setHeader("Access-Control-Allow-Origin", "null");
    response.setHeader("Vary", "Origin");
    if (
      request.method !== "POST" ||
      request.headers.origin !== "null" ||
      !documentCapabilities.has(capability)
    )
      return respond(response, 403, { ok: false, error: "SecurityError" });
    if (!socket || socket.readyState !== 1)
      return respond(response, 503, { ok: false, error: "NetworkError" });
    let text = "";
    for await (const part of request) {
      text += part;
      if (text.length > 256 * 1024)
        return respond(response, 413, {
          ok: false,
          error: "QuotaExceededError",
        });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return respond(response, 400, { ok: false, error: "SyntaxError" });
    }
    if (
      !body ||
      !["get", "set"].includes(body.op) ||
      typeof body.key !== "string" ||
      (body.op === "set" && typeof body.value !== "string") ||
      Object.keys(body).some((key) => !["op", "key", "value"].includes(key))
    )
      return respond(response, 400, { ok: false, error: "TypeError" });
    const id = randomUUID(),
      delay = nextDelay;
    nextDelay = 0;
    const entry = {
      response,
      timer: setTimeout(() => {
        cancel(id, "deadline");
        respond(response, 504, { ok: false, error: "TimeoutError" });
      }, timeoutMilliseconds),
    };
    pending.set(id, entry);
    response.on("close", () => {
      if (!response.writableFinished) cancel(id, "http-client-closed");
    });
    events.push({
      type: "dispatched",
      id,
      operation: body.op,
      origin: request.headers.origin,
      cookiePresent: !!request.headers.cookie,
      authorizationPresent: !!request.headers.authorization,
      delayed: !!delay,
    });
    socket.send(JSON.stringify({ type: "storage", id, ...body, delay }));
    return;
  }
  if (url.pathname === "/storage-vault-worker.js") {
    response.setHeader("Content-Type", "application/javascript");
    return response.end(workerSource);
  }
  if (url.pathname === "/child")
    response.setHeader(
      "Content-Security-Policy",
      `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; connect-src ${frontend}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
    );
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>Local browser storage rendezvous fixture</title>",
  );
});
const websocket = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, connection, head) => {
  const url = new URL(request.url, frontend);
  if (
    url.pathname !== "/storage-worker/" + workerCapability ||
    request.headers.origin !== frontend
  ) {
    connection.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  websocket.handleUpgrade(request, connection, head, (client) => {
    socket = client;
    client.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.type === "cancelled") {
        events.push({ type: "cancel-confirmed", id: message.id });
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      events.push({
        type: "worker-result",
        id: message.id,
        ok: message.ok,
        committed: message.committed,
        error: message.error || null,
      });
      respond(entry.response, 200, message);
    });
    client.on("close", () => {
      if (socket === client) socket = undefined;
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(id);
        if (!entry.response.writableEnded)
          respond(entry.response, 503, { ok: false, error: "NetworkError" });
      }
    });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
frontend = `http://127.0.0.1:${server.address().port}`;
const receipt = {
  version: 1,
  recordedAt: new Date().toISOString(),
  sourceSha256: createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex"),
  command: `node scripts/opaque-sync-storage-rendezvous.mjs ${process.argv[2] || "evidence/combined-update-20261015/opaque-sync-storage-rendezvous.json"}`,
  localOnly: true,
  productionChanged: false,
  serverPersistsSaves: false,
  serverSeesTransientStorageValues: true,
  minimalStorageFacadeOnly: true,
  generalRuntimeQualified: false,
  relaySwitchTested: false,
};
let browser;
async function initialize(page) {
  return page.evaluate(
    async ({ socketURL, website }) => {
      const worker = new Worker("/storage-vault-worker.js");
      window.storageWorker = worker;
      const ready = new Promise((resolve, reject) => {
        worker.onmessage = (e) =>
          e.data.type === "ready"
            ? resolve(e.data)
            : reject(Error(e.data.type));
        worker.onerror = (e) => reject(Error(e.message));
      });
      worker.postMessage({ type: "start", socketURL, website });
      return ready;
    },
    {
      socketURL:
        frontend.replace("http:", "ws:") +
        "/storage-worker/" +
        workerCapability,
      website,
    },
  );
}
async function createChild(page) {
  const capability = randomBytes(32).toString("hex");
  documentCapabilities.add(capability);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const f = document.createElement("iframe");
        f.sandbox = "allow-scripts";
        f.src = "/child";
        f.onload = resolve;
        document.body.append(f);
      }),
  );
  const child = page
    .frames()
    .find((frame) => frame.parentFrame() === page.mainFrame());
  await child.evaluate(
    (endpoint) => {
      function rpc(op, key, value) {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", endpoint, false);
        xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
        xhr.send(
          JSON.stringify({ op, key, ...(op === "set" ? { value } : {}) }),
        );
        const result = JSON.parse(xhr.responseText);
        if (xhr.status !== 200 || !result.ok)
          throw new DOMException(
            "Synchronous browser-storage broker failed",
            result.error || "NetworkError",
          );
        return result.result;
      }
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          getItem(key) {
            return rpc("get", String(key));
          },
          setItem(key, value) {
            rpc("set", String(key), String(value));
          },
        },
      });
    },
    frontend + "/storage-sync/" + capability,
  );
  return child;
}
async function waitUntil(check, description) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3000) throw Error(description + " timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  receipt.browser = browser.version();
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(frontend);
  receipt.worker = await initialize(page);
  let child = await createChild(page);
  receipt.boundary = await child.evaluate(() => {
    let parentAccess;
    try {
      parent.document.title;
      parentAccess = "unexpected_allowed";
    } catch (error) {
      parentAccess = error.name;
    }
    let nativeIDB;
    try {
      indexedDB.open("no");
      nativeIDB = "unexpected_allowed";
    } catch (error) {
      nativeIDB = error.name;
    }
    return {
      urlOrigin: location.origin,
      effectiveOrigin: window.origin,
      crossOriginIsolated,
      parentAccess,
      nativeIDB,
    };
  });
  assert.equal(receipt.boundary.effectiveOrigin, "null");
  assert.equal(receipt.boundary.parentAccess, "SecurityError");
  assert.equal(receipt.boundary.nativeIDB, "SecurityError");
  receipt.write = await child.evaluate(() => {
    const start = performance.now();
    const returned = localStorage.setItem("save", "777 cookies");
    return {
      returnValue: String(returned),
      milliseconds: performance.now() - start,
    };
  });
  const committedBeforeReload = events.filter(
    (e) => e.type === "worker-result" && e.committed,
  );
  assert.equal(committedBeforeReload.length, 1);
  // No grace delay: the first subsequent browser command reloads the whole shell.
  documentCapabilities.clear();
  await page.reload();
  receipt.afterReloadWorker = await initialize(page);
  child = await createChild(page);
  receipt.immediateWholeShellReload = await child.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.immediateWholeShellReload, "777 cookies");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Storage.overrideQuotaForOrigin", {
    origin: frontend,
    quotaSize: 1,
  });
  receipt.quotaOverride = await cdp.send("Storage.getUsageAndQuota", {
    origin: frontend,
  });
  await page.evaluate(() => window.storageWorker.terminate());
  await waitUntil(() => !socket, "quota test worker socket closure");
  await initialize(page);
  receipt.nativeQuotaFailure = await child.evaluate(() => {
    const bytes = new Uint8Array(32768);
    crypto.getRandomValues(bytes);
    const value = btoa(String.fromCharCode(...bytes));
    for (let index = 0; index < 32; index++)
      try {
        localStorage.setItem("quota-probe-" + index, value);
      } catch (error) {
        return error.name;
      }
    return "override_not_enforced_in_probe";
  });
  assert.equal(receipt.nativeQuotaFailure, "QuotaExceededError");
  await cdp.send("Storage.overrideQuotaForOrigin", { origin: frontend });
  receipt.afterNativeQuotaFailure = await child.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.afterNativeQuotaFailure, "777 cookies");
  nextDelay = 800;
  receipt.timeoutFailure = await child.evaluate(() => {
    try {
      localStorage.setItem("save", "late value");
      return "unexpected_commit";
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(receipt.timeoutFailure, "TimeoutError");
  await waitUntil(
    () => events.some((e) => e.type === "cancel-confirmed"),
    "worker cancellation acknowledgement",
  );
  receipt.afterCancellation = await child.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.afterCancellation, "777 cookies");
  const beforeInvalid = events.filter((e) => e.type === "dispatched").length;
  receipt.invalidCapability = await child.evaluate((url) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, false);
    xhr.setRequestHeader("Content-Type", "text/plain");
    xhr.send(JSON.stringify({ op: "set", key: "save", value: "stolen" }));
    return { status: xhr.status, error: JSON.parse(xhr.responseText).error };
  }, frontend + "/storage-sync/unknown-capability");
  assert.deepEqual(receipt.invalidCapability, {
    status: 403,
    error: "SecurityError",
  });
  assert.equal(
    events.filter((e) => e.type === "dispatched").length,
    beforeInvalid,
  );
  await page.evaluate(() => window.storageWorker.terminate());
  await waitUntil(() => !socket, "closed browser worker socket");
  receipt.disconnectedFailure = await child.evaluate(() => {
    try {
      localStorage.setItem("save", "disconnected value");
      return "unexpected_commit";
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(receipt.disconnectedFailure, "NetworkError");
  await initialize(page);
  receipt.afterDisconnectedFailure = await child.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.afterDisconnectedFailure, "777 cookies");
  assert.equal(
    events
      .filter((e) => e.type === "dispatched")
      .some((e) => e.cookiePresent || e.authorizationPresent),
    false,
  );
  receipt.requestSummary = {
    reservedEndpoint: true,
    opaqueOriginOnly: true,
    randomDocumentCapability: true,
    nativeCookieOrAuthorizationForwarded: false,
  };
  receipt.events = events;
  receipt.result =
    "synchronous_durability_route_verified_with_network_availability_dependency";
  receipt.constraints = [
    "Only a minimal getItem/setItem facade is tested; no general browsing runtime or complete Storage/IndexedDB API parity is claimed.",
    "Opaque synchronous XHR requires a reachable reserved HTTP endpoint and an already-connected trusted browser worker WebSocket; failure is synchronous, not a false success followed by data loss.",
    "Storage values transit server RAM in this proof but are persisted only in frontend browser-native IndexedDB.",
    "Timeout cancellation is proven before a delayed transaction begins; cancellation versus an already-committed transaction remains a separate race-policy requirement.",
    "Synchronous network round trips block the website thread and are not appropriate for unbounded hot-path storage use without performance qualification.",
  ];
  receipt.exitStatus = 0;
  await context.close();
} catch (error) {
  receipt.result = "probe_failure";
  receipt.failure = { name: error.name, message: error.message };
  receipt.events = events;
  receipt.exitStatus = 1;
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const client of websocket.clients) client.terminate();
  await new Promise((resolve) => websocket.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      receipt: output,
      result: receipt.result,
      exitStatus: receipt.exitStatus,
      generalRuntimeQualified: false,
    }),
  );
}
