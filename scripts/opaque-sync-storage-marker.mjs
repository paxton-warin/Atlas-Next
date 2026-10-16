#!/usr/bin/env node
/** Local-only, marker-only synchronous durability feasibility proof. */
import http from "node:http";
import { WebSocketServer } from "ws";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const output = resolve(
  process.argv[2] ||
    "evidence/combined-update-20261015/opaque-sync-storage-marker.json",
);
const executablePath =
  process.env.CHROME_PATH ||
  [
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
if (!executablePath)
  throw Error("Set CHROME_PATH to a local Chromium executable.");
const documentId = "fixture_document_1234",
  site = "https://save.fixture.example",
  ownerCap = randomBytes(32).toString("hex");
let frontend,
  socket,
  delayNext = 0;
const documents = new Map(),
  waiting = new Map(),
  early = new Map(),
  events = [];
const workerSource = `
let socket,db,port,site,documentId,delayNext=0;let tail=Promise.resolve();const pending=new Map(),cancelled=new Set();
function result(sequence,ok,error,revision){if(socket.readyState===1)socket.send(JSON.stringify({type:'result',documentId,sequence,ok,...(error?{error}:{}),...(revision?{revision}:{})}));}
function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('atlas-sync-marker-feasibility',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function read(){return new Promise((resolve,reject)=>{const tx=db.transaction('data','readonly'),r=tx.objectStore('data').get(site);tx.oncomplete=()=>resolve(r.result||{revision:0,entries:[]});tx.onabort=()=>reject(tx.error);});}
function write(m){return new Promise(resolve=>{
 if(cancelled.delete(m.sequence)){result(m.sequence,false,'AbortError');return resolve();}
 const tx=db.transaction('data','readwrite'),entry={tx},store=tx.objectStore('data'),r=store.get(site);pending.set(m.sequence,entry);let next,failure;
 r.onsuccess=()=>{try{const old=r.result||{revision:0,entries:[]},map=new Map(old.entries);map.set(m.key,m.value);let bytes=0;for(const[k,v]of map)bytes+=2*(k.length+v.length);if(bytes>1024)throw new DOMException('Fixture website quota exceeded','QuotaExceededError');next={revision:old.revision+1,entries:[...map]};store.put(next,site);}catch(error){failure=error.name;tx.abort();}};
 tx.oncomplete=()=>{pending.delete(m.sequence);port.postMessage({type:'snapshot',...next});result(m.sequence,true,null,next.revision);resolve();};
 tx.onabort=()=>{pending.delete(m.sequence);result(m.sequence,false,failure||tx.error?.name||'AbortError');resolve();};
 });}
onmessage=async({data,ports})=>{
 if(data.type==='start'){site=data.site;documentId=data.documentId;db=await database();socket=new WebSocket(data.socketURL);socket.onopen=()=>postMessage({type:'ready'});socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.type==='cancel'){cancelled.add(m.sequence);pending.get(m.sequence)?.tx.abort();socket.send(JSON.stringify({type:'cancelled',documentId,sequence:m.sequence}));}};return;}
 if(data.type==='bind'){port=ports[0];port.onmessage=({data:m})=>{if(m.type==='delay'){delayNext=m.delay;port.postMessage({type:'delay-ready'});return;}if(m.type!=='set'||m.documentId!==documentId||typeof m.value!=='string')return;const delay=delayNext;delayNext=0;tail=tail.then(async()=>{if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return write(m);});};port.start();port.postMessage({type:'ready',snapshot:await read()});}
};`;
function reply(r, status, v) {
  r.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  r.end(JSON.stringify(v));
}
function key(id, sequence) {
  return id + ":" + sequence;
}
function cancel(entry, reason) {
  waiting.delete(entry.key);
  clearTimeout(entry.timer);
  if (socket?.readyState === 1)
    socket.send(
      JSON.stringify({
        type: "cancel",
        documentId: entry.documentId,
        sequence: entry.sequence,
      }),
    );
  events.push({ type: "cancel", sequence: entry.sequence, reason });
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = new URL(req.url, frontend || "http://127.0.0.1");
  if (url.pathname.startsWith("/browse/storage/commit/")) {
    res.setHeader("Access-Control-Allow-Origin", "null");
    const capability = url.pathname.slice("/browse/storage/commit/".length),
      id = documents.get(capability);
    if (req.method !== "POST" || req.headers.origin !== "null" || !id)
      return reply(res, 403, { ok: false, error: "SecurityError" });
    let text = "";
    for await (const part of req) {
      text += part;
      if (text.length > 128)
        return reply(res, 413, { ok: false, error: "DataError" });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return reply(res, 400, { ok: false, error: "DataError" });
    }
    if (
      Object.keys(body).join(",") !== "sequence" ||
      !Number.isSafeInteger(body.sequence) ||
      body.sequence < 1
    )
      return reply(res, 400, { ok: false, error: "DataError" });
    events.push({
      type: "http-marker",
      sequence: body.sequence,
      bodyKeys: Object.keys(body),
      cookiePresent: !!req.headers.cookie,
      authorizationPresent: !!req.headers.authorization,
    });
    if (!socket || socket.readyState !== 1)
      return reply(res, 503, { ok: false, error: "NetworkError" });
    const k = key(id, body.sequence),
      receipt = early.get(k);
    if (receipt) {
      early.delete(k);
      return reply(res, 200, receipt);
    }
    const entry = {
      key: k,
      documentId: id,
      sequence: body.sequence,
      res,
      timer: setTimeout(() => {
        cancel(entry, "deadline");
        reply(res, 504, { ok: false, error: "TimeoutError" });
      }, 250),
    };
    waiting.set(k, entry);
    res.on("close", () => {
      if (!res.writableFinished) cancel(entry, "http-client-closed");
    });
    return;
  }
  if (url.pathname === "/worker.js") {
    res.setHeader("Content-Type", "application/javascript");
    return res.end(workerSource);
  }
  if (url.pathname === "/child")
    res.setHeader(
      "Content-Security-Policy",
      `sandbox allow-scripts; default-src 'none';script-src 'unsafe-inline';connect-src ${frontend};frame-ancestors 'self';base-uri 'none';form-action 'none'`,
    );
  res.setHeader("Content-Type", "text/html");
  res.end(
    "<!doctype html><title>Marker-only browser durability fixture</title>",
  );
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, conn, head) => {
  if (
    req.url !== "/browse/storage/owner/" + ownerCap ||
    req.headers.origin !== frontend
  ) {
    conn.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, conn, head, (client) => {
    socket = client;
    client.on("message", (bytes) => {
      const m = JSON.parse(String(bytes));
      events.push({
        type: "worker-status",
        keys: Object.keys(m),
        sequence: m.sequence,
        ok: m.ok,
        error: m.error || null,
      });
      if (m.type === "cancelled") return;
      assert.ok(
        !("key" in m) && !("value" in m) && !("entries" in m),
        "server status contains no save data",
      );
      const k = key(m.documentId, m.sequence),
        entry = waiting.get(k);
      if (entry) {
        waiting.delete(k);
        clearTimeout(entry.timer);
        reply(entry.res, 200, m);
      } else {
        early.set(k, m);
        setTimeout(() => early.delete(k), 1000).unref();
      }
    });
    client.on("close", () => {
      if (socket === client) socket = undefined;
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        reply(entry.res, 503, { ok: false, error: "NetworkError" });
      }
      waiting.clear();
    });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
frontend = "http://127.0.0.1:" + server.address().port;
const receipt = {
  version: 1,
  recordedAt: new Date().toISOString(),
  sourceSha256: createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex"),
  command: "node scripts/opaque-sync-storage-marker.mjs",
  localOnly: true,
  productionChanged: false,
  serverPersistsSaves: false,
  serverReceivesSaveValues: false,
  generalRuntimeQualified: false,
  logicalQuotaUsesNativeTransactionAbort: true,
};
let browser;
async function initialize(page) {
  return page.evaluate(
    async ({ site, documentId, socketURL }) => {
      const worker = new Worker("/worker.js");
      window.worker = worker;
      const ready = new Promise((resolve, reject) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = (e) => reject(Error(e.message));
      });
      worker.postMessage({ type: "start", site, documentId, socketURL });
      return ready;
    },
    {
      site,
      documentId,
      socketURL:
        frontend.replace("http:", "ws:") + "/browse/storage/owner/" + ownerCap,
    },
  );
}
async function child(page) {
  const cap = randomBytes(32).toString("hex");
  documents.set(cap, documentId);
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
  const child = page.frames().find((f) => f.parentFrame() === page.mainFrame());
  await child.evaluate(
    ({ endpoint, documentId }) => {
      window.bindingReady = new Promise((resolve) => {
        onmessage = ({ source, ports }) => {
          if (source !== parent || ports.length !== 1) return;
          const port = ports[0];
          window.storagePort = port;
          let map = new Map(),
            revision = 0,
            sequence = 0;
          port.onmessage = ({ data: m }) => {
            if (m.type === "ready") {
              map = new Map(m.snapshot.entries);
              revision = m.snapshot.revision;
              resolve();
            } else if (m.type === "snapshot" && m.revision >= revision) {
              map = new Map(m.entries);
              revision = m.revision;
            } else if (m.type === "delay-ready") window.delayReady = true;
          };
          port.start();
          Object.defineProperty(window, "localStorage", {
            value: {
              getItem(key) {
                return map.get(String(key)) ?? null;
              },
              setItem(key, value) {
                key = String(key);
                value = String(value);
                port.postMessage({
                  type: "set",
                  documentId,
                  sequence: ++sequence,
                  key,
                  value,
                });
                const xhr = new XMLHttpRequest();
                xhr.open("POST", endpoint, false);
                xhr.setRequestHeader(
                  "Content-Type",
                  "text/plain;charset=UTF-8",
                );
                xhr.send(JSON.stringify({ sequence }));
                const m = JSON.parse(xhr.responseText);
                if (xhr.status !== 200 || !m.ok)
                  throw new DOMException(
                    "Storage commit failed",
                    m.error || "NetworkError",
                  );
                map.set(key, value);
                revision = m.revision;
              },
            },
          });
        };
      });
    },
    { endpoint: frontend + "/browse/storage/commit/" + cap, documentId },
  );
  await page.evaluate(() => {
    const c = new MessageChannel();
    worker.postMessage({ type: "bind" }, [c.port1]);
    document
      .querySelector("iframe")
      .contentWindow.postMessage({}, "*", [c.port2]);
  });
  await child.evaluate(() => window.bindingReady);
  return child;
}
async function until(test, label) {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw Error(label + " timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  receipt.browser = browser.version();
  const ctx = await browser.newContext(),
    page = await ctx.newPage();
  await page.goto(frontend);
  await initialize(page);
  let f = await child(page);
  receipt.boundary = await f.evaluate(() => {
    let access;
    try {
      parent.document;
      access = "unexpected_allowed";
    } catch (e) {
      access = e.name;
    }
    return {
      effectiveOrigin: origin,
      urlOrigin: location.origin,
      parentAccess: access,
    };
  });
  assert.equal(receipt.boundary.effectiveOrigin, "null");
  assert.equal(receipt.boundary.parentAccess, "SecurityError");
  receipt.write = await f.evaluate(() => {
    const start = performance.now(),
      result = localStorage.setItem("save", "777 cookies");
    return {
      returnValue: String(result),
      milliseconds: performance.now() - start,
      immediateRead: localStorage.getItem("save"),
    };
  });
  assert.equal(receipt.write.immediateRead, "777 cookies");
  documents.clear();
  await page.reload();
  await initialize(page);
  f = await child(page);
  receipt.immediateWholeShellReload = await f.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.immediateWholeShellReload, "777 cookies");
  receipt.logicalQuota = await f.evaluate(() => {
    try {
      localStorage.setItem("save", "x".repeat(2048));
      return "unexpected_success";
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(receipt.logicalQuota, "QuotaExceededError");
  documents.clear();
  await page.reload();
  await initialize(page);
  f = await child(page);
  receipt.afterQuotaReload = await f.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.afterQuotaReload, "777 cookies");
  await f.evaluate(() => {
    window.delayReady = false;
    storagePort.postMessage({ type: "delay", delay: 800 });
  });
  await f.waitForFunction(() => window.delayReady);
  receipt.deadline = await f.evaluate(() => {
    try {
      localStorage.setItem("save", "delayed");
      return "unexpected_success";
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(receipt.deadline, "TimeoutError");
  await until(
    () =>
      events.some(
        (e) =>
          e.type === "worker-status" &&
          e.keys.includes("type") &&
          e.keys.length === 3,
      ),
    "cancel receipt",
  );
  documents.clear();
  await page.reload();
  await initialize(page);
  f = await child(page);
  receipt.afterCancelledReload = await f.evaluate(() =>
    localStorage.getItem("save"),
  );
  assert.equal(receipt.afterCancelledReload, "777 cookies");
  await page.evaluate(() => worker.terminate());
  await until(() => !socket, "worker close");
  receipt.disconnected = await f.evaluate(() => {
    try {
      localStorage.setItem("save", "offline");
      return "unexpected_success";
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(receipt.disconnected, "NetworkError");
  assert.ok(
    events
      .filter((e) => e.type === "http-marker")
      .every(
        (e) =>
          e.bodyKeys.length === 1 &&
          e.bodyKeys[0] === "sequence" &&
          !e.cookiePresent &&
          !e.authorizationPresent,
      ),
  );
  receipt.events = events;
  receipt.result = "marker_only_sync_commit_and_immediate_reload_verified";
  receipt.exitStatus = 0;
  receipt.constraints = [
    "Native global browser quota exhaustion was not injected; configured per-website quota was enforced through native IDB transaction abort.",
    "Window synchronous XHR timeout is unsupported; server deadlines bound requests once the endpoint is reached, while unreachable transport failures follow browser network timeouts.",
    "Cancellation is proven before a delayed transaction starts, not after an already committed transaction.",
    "Only prehydrated getItem/setItem facade tested; general Storage API, cross-tab read timing, IDB facade, and browsing runtime are not qualified.",
  ];
  await ctx.close();
} catch (e) {
  receipt.result = "probe_failure";
  receipt.failure = { name: e.name, message: e.message };
  receipt.events = events;
  receipt.exitStatus = 1;
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => server.close(r));
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
