import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {adaptRuntimeWorkerGlobals} from '../scripts/runtime-worker-globals.mjs';
import {compilerBindingImport,compilerBindingModule,compilerBindingClassic} from '../runtime/worker-compiler-bindings.ts';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const helper=(await build({entryPoints:['runtime/worker-compiler-bindings.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const helperClassic=(await build({entryPoints:['runtime/worker-compiler-bindings.ts'],bundle:true,write:false,format:'iife',globalName:'WorkerBindings',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const raw=await readFile('upstream/scramjet-ls-bypass/app/vendor/runtimekit.js');
const wasm=await readFile('upstream/scramjet-ls-bypass/app/vendor/runtimekit.wasm');
const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('content-type',path.endsWith('.wasm')?'application/wasm':path.endsWith('.js')?'text/javascript':'text/html');if(path==='/runtime.js')res.end(raw);else if(path==='/adapted.js')res.end(adaptRuntimeWorkerGlobals(raw));else if(path==='/runtime.wasm')res.end(wasm);else if(path==='/bindings.js')res.end(helper);else if(path==='/bindings-classic.js')res.end(helperClassic);else res.end('<!doctype html><title>Worker compiler binding regression</title>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{const p=await browser.newPage();await p.goto(origin);await p.addScriptTag({url:origin+'/runtime.js'});const results=await p.evaluate(async({origin,bindingImport,bindingClassic,wasmBase64})=>{
 const core=globalThis.$runtimekit;core.setWasm(new Uint8Array(await(await fetch('/runtime.wasm')).arrayBuffer()));
 const source=`
 const send=globalThis.postMessage.bind(globalThis), NativePromise=Promise;
 const resumed=new NativePromise(resolve=>{globalThis.onmessage=()=>resolve()});
 const allow=new Set(['TEMPORARY','PERSISTENT','TextEncoder','Float16Array','Iterator','Object','Function','Array','Number','Boolean','String','Symbol','Date','RegExp','Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError','URIError','AggregateError','Promise','Map','Set','WeakMap','WeakSet','WeakRef','FinalizationRegistry','Reflect','Proxy','JSON','Math','Intl','BigInt','ArrayBuffer','SharedArrayBuffer','DataView','Uint8Array','Uint8ClampedArray','Int8Array','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','Atomics','NaN','Infinity','undefined','eval','globalThis','parseInt','parseFloat','isNaN','isFinite','decodeURI','decodeURIComponent','encodeURI','encodeURIComponent','escape','unescape','onmessage']);
 try {
 for(let scope=globalThis;scope!==null&&scope!==Object.prototype;scope=Object.getPrototypeOf(scope))for(const key of Reflect.ownKeys(scope))if(typeof key!=='string'||!allow.has(key)){try{Reflect.set(scope,key,undefined)}catch{}try{Reflect.deleteProperty(scope,key)}catch{}const d=Object.getOwnPropertyDescriptor(scope,key);if(d&&(!('value'in d)||d.value!==undefined))throw Error('Failed to remove sandbox global '+String(key));}
 Object.freeze(globalThis);Object.freeze(Error);
 send({type:'armed'});await resumed;
 const normal=Function('a','return a+1')(41);
 const indirect=(0,eval)('21*2');
 const direct=eval('20+22');
 const asyncValue=await (async function(){}).constructor('return 42')();
 const generator=(function*(){}).constructor('yield 42')().next().value;
 const asyncGenerator=(await (async function*(){}).constructor('yield 42')().next()).value;
 send({ok:true,normal,indirect,direct,asyncValue,generator,asyncGenerator,frozen:Object.isFrozen(globalThis),fetch:typeof fetch,idb:typeof indexedDB,worker:typeof Worker,ambientHelpers:Reflect.ownKeys(globalThis).filter(k=>typeof k==='string'&&k.startsWith('$runtimekit$'))});
 } catch(error){send({ok:false,name:error.name,message:error.message,stack:error.stack})}
 `;
 const results=[];
 for(const [modified,classic] of [[false,false],[true,false],[true,true]]){
  const context={config:structuredClone(core.defaultConfig),prefix:new URL(origin+'/proxy/'),interface:{codecEncode:u=>u,codecDecode:u=>u}};
  const meta={origin:new URL('https://fixture.test/worker.js'),base:new URL('https://fixture.test/worker.js')};
  const rewritten=core.transformJs(classic?'(async()=>{'+source+'})()':source,'https://fixture.test/worker.js',context,meta,!classic);
  const setup=`${modified&&!classic?`import {installWorkerFunctionBindings} from ${JSON.stringify(origin+'/bindings.js')};`:""}const core=globalThis.$runtimekit;core.setWasm(Uint8Array.from(atob(${JSON.stringify(wasmBase64)}),c=>c.charCodeAt(0)));const context={config:core.defaultConfig,prefix:new URL(${JSON.stringify(origin+'/proxy/')}),interface:{codecEncode:u=>u,codecDecode:u=>u}};if(${modified})context.config.flags.allowInvalidJs=false;const client=new core.RuntimeKitClient(globalThis,{context,transport:null});client.hook();${modified?`${classic?"WorkerBindings.installWorkerFunctionBindings":"installWorkerFunctionBindings"}(globalThis,core,client);`:''}`;
  const setupURL='data:text/javascript;charset=utf-8,'+encodeURIComponent(setup);
  const text=classic?`importScripts(${JSON.stringify(origin+"/adapted.js")},${JSON.stringify(origin+"/bindings-classic.js")});importScripts(${JSON.stringify(setupURL)});${bindingClassic}\n${rewritten}`:`import ${JSON.stringify(origin+(modified?'/adapted.js':'/runtime.js'))};\nimport ${JSON.stringify(setupURL)};\n${modified?bindingImport:''}\n${rewritten}`;
  const blob=URL.createObjectURL(new Blob([text],{type:'text/javascript'}));
  const result=await new Promise(resolve=>{const w=new Worker(blob,classic?{}:{type:'module'});const t=setTimeout(()=>{w.terminate();resolve({ok:false,message:'Worker timeout'})},20000);w.onmessage=e=>{const data=e.data?.['$runtimekit$data']??e.data;if(data.type==='armed'){w.postMessage({test:true});return}clearTimeout(t);w.terminate();resolve(e.data?.['$runtimekit$data']??e.data)};w.onerror=e=>{clearTimeout(t);w.terminate();resolve({ok:false,message:e.message})}});URL.revokeObjectURL(blob);results.push({modified,classic,...result});
 }return results;
},{origin,bindingImport:compilerBindingImport,bindingClassic:compilerBindingClassic,wasmBase64:wasm.toString("base64")});console.log(JSON.stringify(results,null,2));assert.equal(results[0].ok,false);assert.match(results[0].message,/Failed to remove sandbox global/);assert.equal(results[1].ok,true);assert.equal(results[2].ok,true,JSON.stringify(results[2]));for(const k of ['normal','indirect','direct','asyncValue','generator','asyncGenerator'])assert.equal(results[1][k],42);for(const k of ['fetch','idb','worker'])assert.equal(results[1][k],'undefined');assert.deepEqual(results[1].ambientHelpers,[]);assert.equal(results[1].frozen,true);console.log('WORKER_COMPILER_HARDENING=PASS');if(process.env.ATLAS_PROOF_FILE)await writeFile(process.env.ATLAS_PROOF_FILE,JSON.stringify({result:'PASS',results},null,2));}finally{await browser.close();await new Promise(r=>server.close(r))}
