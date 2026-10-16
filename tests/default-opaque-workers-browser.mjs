/** Default built original-document Worker path; deterministic website bytes,
 * actual controller/relay probe/owners/native opaque dedicated workers. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(),
  E = join(root, "evidence/default-workers-20261016");
await fs.mkdir(E, { recursive: true });
const strictResponse = process.env.ATLAS_WORKER_POLICY_MODE === "stricter";
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
const replace = (before, after) => {
  assert.equal(source.split(before).length, 2, before.slice(0, 80));
  source = source.replace(before, after);
};
const workerBody = `
const read=()=>new Promise((resolve,reject)=>{const request=indexedDB.open('default-worker-save',1);request.onupgradeneeded=()=>request.result.createObjectStore('items');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('items','readwrite'),store=tx.objectStore('items'),q=store.get('value');let value;q.onsuccess=()=>{value=Number(q.result||0)+1;store.put(value,'value')};tx.oncomplete=()=>{db.close();resolve(value)};tx.onabort=()=>reject(tx.error)}});
self.onmessage=async event=>{try{const text=await(await fetch('/worker-data')).text();const xhr=await new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','/worker-xhr');x.onload=()=>resolve(x.responseText);x.onerror=()=>reject(Error('xhr'));x.send()});let evalDenied=false,wasmDenied=false;try{eval('1')}catch{evalDenied=true}try{new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))}catch{wasmDenied=true}self.postMessage({kind:'classic',value:await read(),text,xhr,echo:event.data.echo,buffer:event.data.buffer.byteLength,hasDocument:typeof document!=='undefined',evalDenied,wasmDenied})}catch(error){self.postMessage({error:error.name,message:error.message})}};`;
const moduleBody = `import{value}from'./dependency.js';self.onmessage=async()=>{try{const dynamic=await import('./dynamic.js');self.postMessage({kind:'module',value,dynamic:dynamic.value,url:import.meta.url,text:await(await fetch('/worker-data')).text()})}catch(error){self.postMessage({error:error.name,message:error.message})}};`;
const main = `
  (async()=>{
    const run=(url,type='classic')=>new Promise((resolve,reject)=>{let worker;try{worker=new Worker(url,{type})}catch(e){reject(e);return}const timeout=setTimeout(()=>{worker.terminate();reject(Error('worker timeout'))},10000);worker.onmessage=e=>{clearTimeout(timeout);worker.terminate();resolve(e.data)};worker.onerror=e=>{e.preventDefault();clearTimeout(timeout);worker.terminate();reject(Error('worker '+e.message))};const b=new Uint8Array([1,2,3]).buffer;worker.postMessage({echo:'queued',buffer:b},[b]);if(b.byteLength!==0)reject(Error('not native transfer'))});
    try{
      let capabilityLeak=false;Object.defineProperty(Object.prototype,'then',{configurable:true,get(){if(this.network instanceof MessagePort||this.indexedDB instanceof MessagePort)capabilityLeak=true;return undefined}});let first;try{first=await run('/worker-start.js')}finally{delete Object.prototype.then}const second=await run('/worker-start.js'),module=await run('/workers/module.js','module'),denied=await run('/workers/denied.js');
      let foreign;try{new Worker('https://peer.example/a.js');foreign='allowed'}catch(e){foreign=e.name}
      let parentBlobImport;try{await import(URL.createObjectURL(new Blob(['export default 1'],{type:'text/javascript'})));parentBlobImport='allowed'}catch(e){parentBlobImport=e.name}
      const nativeConstructorExposed=Object.getPrototypeOf(Worker)!==Function.prototype||Object.getPrototypeOf(Worker.prototype).constructor.name==='Worker';
      const visibleClient=window[Symbol.for('runtimekit client global')];const nativeCacheExposed=!!visibleClient&&((visibleClient.box.ctors.Worker||[]).some(c=>c!==Worker)||visibleClient.natives.store.Worker!==Worker);window.defaultWorkersResult={first,second,module,denied,foreign,parentBlobImport,nativeConstructorExposed,nativeCacheExposed,capabilityLeak};
    }catch(error){window.defaultWorkersResult={error:error.name,message:error.message}}
  })();
`;
replace(
  "  (async()=>{let parentFrontendLeak=false;",
  main + "\n  (async()=>{let parentFrontendLeak=false;",
);
replace(
  "default-src 'none'; script-src https://assets.example 'unsafe-inline'; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
  "default-src 'none'; script-src https://assets.example 'unsafe-inline'" +
    (strictResponse ? " 'unsafe-eval'" : "") +
    "; worker-src 'self'; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
);
replace(
  '      } else throw Error("Synthetic transport denied");',
  `      } else if(request.url==='https://site.example/worker-start.js'){body='';type='application/javascript';status=302;extra=[['location','/workers/main.js']]}else if(request.url==='https://site.example/workers/main.js'){body=${JSON.stringify(workerBody)};type='application/javascript';extra=[['content-security-policy',"script-src 'self';connect-src 'self'"]]}else if(request.url==='https://site.example/workers/module.js'){body=${JSON.stringify(moduleBody)};type='application/javascript';extra=[['content-security-policy',"script-src 'self';connect-src 'self'"]]}else if(request.url==='https://site.example/workers/dependency.js'){body='export const value=42';type='application/javascript'}else if(request.url==='https://site.example/workers/dynamic.js'){body='export const value=43';type='application/javascript'}else if(request.url==='https://site.example/workers/denied.js'){body="self.onmessage=async()=>{let denied=false;try{await fetch('/worker-blocked')}catch{denied=true}postMessage({denied})}";type='application/javascript';extra=[['content-security-policy',"script-src 'self';connect-src 'none'"]]}else if(request.url==='https://site.example/worker-data'||request.url==='https://site.example/worker-xhr'){body='worker-response';type='text/plain'}else throw Error("Synthetic transport denied");`,
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `  await frame.waitForFunction(()=>window.defaultWorkersResult,null,{timeout:35000});const workers=await frame.evaluate(()=>window.defaultWorkersResult);console.log(JSON.stringify({defaultWorkers:workers}));if(workers.error)console.log(JSON.stringify({errors,calls:await page.evaluate(()=>window.jointCalls),workerCount:page.workers().length,workerStates:await Promise.all(page.workers().map(w=>w.evaluate(()=>({origin:self.origin,client:!!self[Symbol.for('runtimekit client global')],onmessage:typeof self.onmessage,keys:Object.keys(self).filter(k=>/runtimekit/i.test(k))})).catch(e=>({error:e.name}))))}));assert.equal(workers.error,undefined);assert.deepEqual(workers.first,{kind:'classic',value:1,text:'worker-response',xhr:'worker-response',echo:'queued',buffer:3,hasDocument:false,evalDenied:true,wasmDenied:true});assert.deepEqual(workers.second,{...workers.first,value:2});assert.deepEqual(workers.denied,{denied:true});assert.equal((await page.evaluate(()=>window.jointCalls)).some(c=>c.url.endsWith("/worker-blocked")),false);assert.deepEqual(workers.module,{kind:'module',value:42,dynamic:43,url:'https://site.example/workers/module.js',text:'worker-response'});assert.equal(workers.foreign,'SecurityError');assert.notEqual(workers.parentBlobImport,'allowed');assert.equal(workers.nativeConstructorExposed,false);assert.equal(workers.nativeCacheExposed,false);assert.equal(workers.capabilityLeak,false);const result = await frame.evaluate(() => window.jointResult);`,
);
if (strictResponse) {
  const start = source.indexOf("assert.equal(workers.error,undefined);"),
    end = source.indexOf(
      "const result = await frame.evaluate(() => window.jointResult);",
      start,
    );
  assert.ok(start >= 0 && end > start);
  source =
    source.slice(0, start) +
    "assert.deepEqual(workers,{error:'Error',message:'worker WORKER_RESPONSE_COMPILATION_UNSUPPORTED'});assert.equal((await page.evaluate(()=>window.jointCalls)).some(c=>c.url.endsWith('/worker-data')),false);" +
    source.slice(end);
}
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(
    join(
      E,
      strictResponse ? "STRICT-RESPONSE-BROWSER.json" : "DEFAULT-BROWSER.json",
    ),
  ),
);
replace(
  "  console.log(JSON.stringify(receipt));",
  "  await page.waitForTimeout(100);assert.equal(page.workers().filter(w=>w.url().startsWith('blob:null/')).length,0);console.log(JSON.stringify({...receipt,defaultDedicatedWorkers: true,workerPolicyMode:" +
    JSON.stringify(strictResponse ? "stricter-fail-closed" : "native-denied") +
    "}));",
);
const file = join(E, "default-worker-" + process.pid + ".mjs");
await fs.writeFile(file, source);
try {
  await import(pathToFileURL(file).href);
} finally {
  await fs.rm(file, { force: true });
}
