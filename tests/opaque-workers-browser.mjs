#!/usr/bin/env node
/** Actual copied RuntimeKit inside opaque workers + real native-IDB broker. */
import http from "node:http";
import fs from "node:fs";
import { compileRuntimeFixture } from "./runtime-fixture.mjs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { adaptPinnedRuntimeBundle } from "./opaque-runtime-fork.mjs";
const documentURL = "https://worker-site.test/index.html",
  calls = [],
  httpRequests = [];
const core = adaptPinnedRuntimeBundle(
    fs.readFileSync("runtime/public/runtime/runtimekit.js", "utf8"),
  ),
  wasm = fs.readFileSync("runtime/public/runtime/runtimekit.wasm");
const compiled = new Map(),
  packed = new Map();
for (const [name,source] of compileRuntimeFixture([
  "opaque-workers",
  "opaque-runtime-adapter",
  "sandbox-idb",
  "sandbox-network",
],{externalSpecifiers:["es-module-lexer/minimal/js"]}))
  compiled.set("/" + name + ".js", source);
compiled.set(
  "/lexer.js",
  fs.readFileSync(
    new URL(import.meta.resolve("es-module-lexer/minimal/js")),
    "utf8",
  ),
);
const pack = (path) => {
  if (packed.has(path)) return packed.get(path);
  let source = compiled.get(path);
  assert.ok(source, "unknown bootstrap module " + path);
  source = source.replaceAll(
    /(from\s+["'])([^"']+)(["'])/g,
    (all, before, specifier, after) => {
      const resolved =
        specifier === "es-module-lexer/minimal/js"
          ? "/lexer.js"
          : new URL(specifier, "http://fixture" + path).pathname;
      return before + pack(resolved) + after;
    },
  );
  const url =
    "data:text/javascript;charset=utf-8," + encodeURIComponent(source);
  packed.set(path, url);
  return url;
};
const runtimeModuleURL = pack("/opaque-workers.js");
const common = `const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('worker-persist',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result)});self.onmessage=async event=>{try{const db=await open();const tx=db.transaction('data',event.data.write?'readwrite':'readonly'),store=tx.objectStore('data');if(event.data.write)store.put(event.data.write,'save');const q=store.get('save');await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});const saved=q.result;db.close();const payload=await(await fetch('./payload')).text();let frontendDenied;try{await fetch(event.data.frontend+'/api/private',{credentials:'include'});frontendDenied=false}catch{frontendDenied=true}const opaque=await fetch('https://peer.test/private',{mode:'no-cors'});postMessage({saved,payload,location:location.href,origin:location.origin,globalOrigin:self.origin,label:typeof workerLabel==='undefined'?null:workerLabel,frontendDenied,opaqueType:opaque.type,opaqueBody:await opaque.text(),hasDocument:typeof document,hasLocalStorage:typeof localStorage,echo:event.data.echo,transferFirst:new Uint8Array(event.data.buffer)[0],meta:typeof moduleMeta==='undefined'?null:moduleMeta});}catch(error){postMessage({error:error.name,message:error.message})}};`;
const resources = {
  "/classic.js": [
    "application/javascript",
    "importScripts('./dependency.js');" + common,
  ],
  "/dependency.js": [
    "application/javascript",
    "self.workerLabel='classic-preloaded';",
  ],
  "/module.js": [
    "application/javascript",
    "import {label} from './module-dependency.js';self.workerLabel=label+'+'+(await import('./lazy.js')).default;self.moduleMeta=import.meta.url;" +
      common,
  ],
  "/lazy.js": ["application/javascript", "export default 'dynamic';"],
  "/module-dependency.js": [
    "application/javascript",
    "export const label='module-static';",
  ],
  "/cycle-a.js": ["application/javascript", "import './cycle-b.js';"],
  "/cycle-b.js": ["application/javascript", "import './cycle-a.js';"],
  "/missing-import.js": [
    "application/javascript",
    "importScripts('./unprepared.js');",
  ],
  "/payload": ["text/plain", "bound-worker-network"],
};
const server = http.createServer((req, res) => {
  httpRequests.push(req.url);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/favicon.ico") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.url === "/core.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(core);
    return;
  }
  if (req.url === "/wasm") {
    res.end(wasm);
    return;
  }
  if (compiled.has(req.url)) {
    res.setHeader("Content-Type", "application/javascript");
    res.end(
      compiled.get(req.url).replaceAll("es-module-lexer/minimal/js", "/lexer.js"),
    );
    return;
  }
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Worker boundary fixture</title>");
    return;
  }
  if (req.url === "/frame") {
    res.setHeader("Content-Type", "text/html");
    res.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline' 'unsafe-eval' blob: data: http:;worker-src blob: data:;connect-src http: blob:;frame-ancestors 'self';",
    );
    res.end(`<!doctype html><script src='/core.js'></script><script type='module'>
 import{createOpaqueWorkerManager}from'/opaque-workers.js';import{createOpaqueNetworkClient,createPinnedOpaqueRewriter,bootOpaqueRuntimeClient}from'/opaque-runtime-adapter.js';
 const nativePortAdd=EventTarget.prototype.addEventListener,nativePortStart=MessagePort.prototype.start,nativePortClose=MessagePort.prototype.close,NativeChannel=MessageChannel; const notify=parent.postMessage.bind(parent),nativeWorkers={Worker,Blob,createObjectURL:URL.createObjectURL.bind(URL),revokeObjectURL:URL.revokeObjectURL.bind(URL)};
 const wasm=new Uint8Array(await(await fetch('/wasm')).arrayBuffer());
 addEventListener('message',async event=>{if(event.source!==parent||event.data?.type!=='init'||event.ports.length!==1)return;
 try{const network=createOpaqueNetworkClient({port:event.ports[0],documentId:'worker_graph_document',documentURL:${JSON.stringify(documentURL)}}),rewriter=createPinnedOpaqueRewriter({core:$runtimekit,wasm,documentURL:${JSON.stringify(documentURL)},prefix:location.origin+'/~/worker/'});
 const manager=createOpaqueWorkerManager({global:window,documentURL:${JSON.stringify(documentURL)},network,rewriter,coreSource:${JSON.stringify(core)},wasm,runtimeModuleURL:${JSON.stringify(runtimeModuleURL)},prefix:location.origin+'/~/worker/',natives:nativeWorkers,classicImports:['./dependency.js'],bindWorker:binding=>new Promise((resolve,reject)=>{const c=new NativeChannel();nativePortAdd.call(c.port1,'message',e=>{nativePortClose.call(c.port1);if(e.data?.type!=='bound'||e.ports.length!==2){reject(Error('grant failed'));return}resolve({network:e.ports[0],indexedDB:e.ports[1],dispose(){notify({type:'worker-dispose',documentId:binding.documentId},'*')}})});nativePortStart.call(c.port1);notify({...binding,type:'worker-bind',workerType:binding.type},'*',[c.port2])})});
 const storage=()=>({getItem:()=>null,setItem(){},removeItem(){},clear(){},key:()=>null,length:0});const windowBoot=bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL:${JSON.stringify(documentURL)},prefix:location.origin+'/~/worker/',network,localStorage:storage(),sessionStorage:storage(),installIndexedDB(){},onNavigate(){throw Error('navigation unqualified')},sendSetCookie:async()=>{},installWorkers(_client,global){Object.defineProperty(global,'Worker',{configurable:true,writable:true,value:manager.Worker})}}); const run=(url,type,write)=>new Promise((resolve,reject)=>{const worker=new Worker(url,{type});const timer=setTimeout(()=>{worker.terminate();reject(Error('worker-site timeout '+url))},15000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};worker.onerror=e=>{e.preventDefault();clearTimeout(timer);worker.terminate();reject(Error('worker error '+url+':'+e.message))};const buffer=new Uint8Array([17]).buffer;worker.postMessage({write,echo:'queued-before-boot',frontend:event.data.frontend,buffer},[buffer]);if(buffer.byteLength!==0)reject(Error('native transfer did not detach synchronously'));});
 const classic=await run('/classic.js','classic','durable-worker-save'),module=await run('/module.js','module',null);
 let foreign;try{new manager.Worker('https://peer.test/main.js');foreign='unexpected'}catch(e){foreign=e.name}
 const held={};for(const [name,url,type]of[['cycle','/cycle-a.js','module'],['unprepared','/missing-import.js','classic']]){try{await run(url,type,null);held[name]='unexpected'}catch{held[name]='denied'}}
 manager.dispose();windowBoot.dispose();network.dispose();notify({type:'result',classic,module,foreign,held,active:manager.active},'*');
 }catch(error){notify({type:'result',error:{name:error.name,message:error.message,stack:String(error.stack||'').replace(/data:[^ )\\n]+/g,'[inline-fixture]').split('\\n').slice(0,7).join('\\n')}},'*')}
 });notify({type:'ready'},'*');</script>`);
    return;
  }
  res.statusCode = 404;
  res.end("Native frontend application request forbidden");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text().slice(0, 1500));
    }
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(
    async ({ resources, documentURL }) => {
      const { bindSandboxNetwork } = await import("/sandbox-network.js"),
        { bindSandboxIndexedDB } = await import("/sandbox-idb.js");
      const networkCalls = [],
        bindings = new Map();
      const transport = async (request) => {
        networkCalls.push({ url: request.url, mode: request.mode });
        const path = new URL(request.url).pathname,
          [type, source] = resources[path] || [
            "text/plain",
            "unreadable peer body",
          ];
        return {
          url: request.url,
          status: 200,
          statusText: "OK",
          headers: [["content-type", type]],
          body: new TextEncoder().encode(source).buffer,
        };
      };
      return await new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.src = "/frame";
        const timer = setTimeout(
          () => reject(Error("worker joint timeout")),
          50000,
        );
        addEventListener("message", function receive(e) {
          if (e.source !== frame.contentWindow || e.origin !== "null") return;
          if (e.data?.type === "ready") {
            const channel = new MessageChannel();
            const broker = bindSandboxNetwork({
              port: channel.port1,
              documentId: "worker_graph_document",
              documentURL,
              frontendOrigin: location.origin,
              fetch: transport,
            });
            bindings.set("graph", { dispose: () => broker.dispose() });
            frame.contentWindow.postMessage(
              { type: "init", frontend: location.origin },
              "*",
              [channel.port2],
            );
          } else if (e.data?.type === "worker-bind") {
            if (
              new URL(e.data.documentURL).origin !==
                new URL(documentURL).origin ||
              !e.data.documentId.startsWith("worker_")
            )
              throw Error("worker identity denied");
            const n = new MessageChannel(),
              i = new MessageChannel();
            const net = bindSandboxNetwork({
              port: n.port1,
              documentId: e.data.documentId,
              documentURL: e.data.documentURL,
              frontendOrigin: location.origin,
              fetch: transport,
            });
            const idb = bindSandboxIndexedDB({
              port: i.port1,
              documentId: e.data.documentId,
              website: e.data.documentURL,
              frontendOrigin: location.origin,
              factory: indexedDB,
            });
            bindings.set(e.data.documentId, {
              dispose() {
                net.dispose();
                idb.dispose();
              },
            });
            e.ports[0].postMessage({ type: "bound" }, [n.port2, i.port2]);
            e.ports[0].close();
          } else if (e.data?.type === "worker-dispose") {
            bindings.get(e.data.documentId)?.dispose();
            bindings.delete(e.data.documentId);
          } else if (e.data?.type === "result") {
            clearTimeout(timer);
            removeEventListener("message", receive);
            for (const binding of bindings.values()) binding.dispose();
            resolve({ ...e.data, networkCalls });
          }
        });
        document.body.appendChild(frame);
      });
    },
    { resources, documentURL },
  );
  console.log(JSON.stringify(result));
  assert.ok(!result.error, JSON.stringify(result.error));
  for (const key of ["classic", "module"]) {
    assert.ok(!result[key].error, JSON.stringify(result[key]));
    assert.equal(result[key].saved, "durable-worker-save");
    assert.equal(result[key].payload, "bound-worker-network");
    assert.equal(result[key].origin, "https://worker-site.test");
    assert.equal(result[key].hasDocument, "undefined");
    assert.equal(result[key].hasLocalStorage, "undefined");
    assert.equal(result[key].frontendDenied, true);
    assert.equal(result[key].opaqueType, "opaque");
    assert.equal(result[key].opaqueBody, "");
    assert.equal(result[key].echo, "queued-before-boot");
    assert.equal(result[key].transferFirst, 17);
  }
  assert.equal(result.classic.label, "classic-preloaded");
  assert.equal(result.module.label, "module-static+dynamic");
  assert.equal(result.module.meta, "https://worker-site.test/module.js");
  assert.equal(result.foreign, "SecurityError");
  assert.deepEqual(result.held, { cycle: "denied", unprepared: "denied" });
  assert.equal(result.active, 0);
  assert.ok(!httpRequests.includes("/api/private"));
  const receipt = {
    command: "node tests/opaque-workers-browser.mjs",
    browser: browser.version(),
    result: "copied_runtime_opaque_dedicated_workers_network_idb_verified",
    productionChanged: false,
    generalRuntimeQualified: false,
    probes: result,
    httpRequests,
    errors,
    exitStatus: 0,
    constraints: [
      "Same-origin worker entries and CORS-readable dependency bodies only.",
      "Acyclic module graphs only; document import maps, nested/shared workers/worklets unqualified.",
      "Classic synchronous importScripts limited to explicitly preloaded imports.",
      "Boot-time buffered user messages are redispatched MessageEvents with isTrusted=false.",
      "Transport is a trusted in-memory website fixture; native browser IDB authority is real.",
    ],
  };
  fs.writeFileSync(
    "evidence/combined-update-20261015/opaque-workers-browser.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify({ result: receipt.result, exitStatus: 0 }));
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
