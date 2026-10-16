#!/usr/bin/env node
/** Actual Chrome primitive proof; no proxy/native-resource qualification. */
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/frame") {
    res.setHeader("Content-Type", "text/html");
    res.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline' blob: data:;worker-src blob: data:;connect-src 'none'",
    );
    res.end(`<!doctype html><script>
  const nativeWorker=Worker, blob=URL.createObjectURL.bind(URL);
  addEventListener('message',async event=>{
   if(event.source!==parent||event.data?.type!=='init')return;
   const allocated=[], workers=[];
   const make=s=>{const u=blob(new Blob([s],{type:'application/javascript'}));allocated.push(u);return u};
   const run=(url,type)=>new Promise(resolve=>{let w;const timer=setTimeout(()=>{w?.terminate();resolve({error:'Timeout'})},3000);try{w=new nativeWorker(url,{type});workers.push(w);w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve({value:e.data})};w.onerror=e=>{e.preventDefault();clearTimeout(timer);w.terminate();resolve({error:e.message||'WorkerError'})}}catch(error){clearTimeout(timer);resolve({error:error.name})}});
   const privateState="let idb;try{indexedDB.open('frontend-private')}catch(e){idb=e.name};let cookie;try{cookie=String(document.cookie)}catch(e){cookie=e.name};";
   const classicDependency=make("self.dependency='classic-dependency';");
   const classic=await run(make(privateState+"importScripts("+JSON.stringify(classicDependency)+");postMessage({kind:'classic',dependency,origin:self.origin,idb,cookie,nativeLocation:location.href});"),'classic');
   const dataDependency='data:text/javascript,'+encodeURIComponent("export const answer='data-module-dependency';");const dataModule=await run('data:text/javascript,'+encodeURIComponent("import {answer} from "+JSON.stringify(dataDependency)+";"+privateState+"fetch("+JSON.stringify(event.data.frontend+'/private')+",{credentials:'include'}).then(()=>postMessage({unexpected:true}),e=>postMessage({kind:'data',answer,origin:self.origin,idb,cookie,network:e.name}));"),'module');const moduleSimple=await run(make("postMessage({kind:'simple',origin:self.origin})"),'module');const moduleDependency=make("export const answer='module-dependency';");
   const module=await run(make("import {answer} from "+JSON.stringify(moduleDependency)+";"+privateState+"postMessage({kind:'module',answer,origin:self.origin,idb,cookie,nativeLocation:location.href});"),'module');
   const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify({imports:{'document-map':moduleDependency}});document.head.appendChild(map);
   const ignoresImportMap=await run('data:text/javascript,'+encodeURIComponent("import {answer} from 'document-map';postMessage(answer);"),'module');
   const parentBlob=await run(event.data.parentBlob,'classic');
   const frontend=await run(event.data.frontend+'/native-worker.js','module');
   const nativeNetwork=await run(make("fetch("+JSON.stringify(event.data.frontend+'/private')+",{credentials:'include'}).then(()=>postMessage('unexpected_success'),e=>postMessage(e.name));"),'classic');
   parent.postMessage({type:'result',origin:self.origin,classic,dataModule,moduleSimple,module,ignoresImportMap,parentBlob,frontend,nativeNetwork},'*');
   workers.forEach(w=>w.terminate());allocated.forEach(u=>URL.revokeObjectURL(u));
  });parent.postMessage({type:'ready'},'*');
  </script>`);
    return;
  }
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Opaque workers primitive proof</title>");
    return;
  }
  res.statusCode = 404;
  res.end("Native application resource forbidden");
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
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const parentBlob = URL.createObjectURL(
          new Blob(["postMessage('unexpected_frontend_blob_access')"], {
            type: "application/javascript",
          }),
        );
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.src = "/frame";
        const timer = setTimeout(
          () => reject(Error("Opaque worker proof timeout")),
          15000,
        );
        addEventListener("message", function receive(e) {
          if (e.source !== frame.contentWindow || e.origin !== "null") return;
          if (e.data?.type === "ready")
            frame.contentWindow.postMessage(
              { type: "init", parentBlob, frontend: location.origin },
              "*",
            );
          if (e.data?.type === "result") {
            clearTimeout(timer);
            removeEventListener("message", receive);
            URL.revokeObjectURL(parentBlob);
            resolve(e.data);
          }
        });
        document.body.appendChild(frame);
      }),
  );
  assert.equal(result.origin, "null");
  for (const key of ["classic", "dataModule"]) {
    assert.ok(result[key].value);
    assert.equal(result[key].value.origin, "null");
    assert.equal(result[key].value.idb, "SecurityError");
    assert.equal(result[key].value.cookie, "ReferenceError");
    if (key === "classic")
      assert.ok(result[key].value.nativeLocation.startsWith("blob:null/"));
  }
  assert.equal(result.classic.value.dependency, "classic-dependency");
  assert.equal(result.dataModule.value.answer, "data-module-dependency");
  assert.equal(result.dataModule.value.network, "TypeError");
  assert.ok(result.moduleSimple.error);
  assert.ok(result.module.error);
  assert.ok(result.ignoresImportMap.error);
  assert.equal(result.parentBlob.error, "SecurityError");
  assert.equal(result.frontend.error, "SecurityError");
  assert.equal(result.nativeNetwork.value, "TypeError");
  assert.ok(!requests.includes("/private"));
  assert.ok(!requests.includes("/native-worker.js"));
  const receipt = {
    command: "node tests/opaque-workers-primitives.mjs",
    browser: browser.version(),
    result: "opaque_classic_blob_and_module_data_workers_verified",
    productionChanged: false,
    fullRuntimeQualified: false,
    probes: result,
    nativeRequests: requests,
    constraints: [
      "Opaque Blob module-worker startup failed in this tested Chrome even without imports; data-module worker graph succeeded.",
      "Document import maps do not apply to worker module graphs.",
      "Frontend-owned Blob URLs and direct frontend worker URLs denied.",
      "No-cors resource path, RuntimeKit worker boot and full worker semantics are not established by this primitive proof.",
    ],
    exitStatus: 0,
  };
  fs.writeFileSync(
    "evidence/combined-update-20261015/opaque-workers-primitives.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify({ result: receipt.result, exitStatus: 0 }));
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
