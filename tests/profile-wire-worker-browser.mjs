import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const E='evidence/profile-saving-reliability-20261022/worker';
const app=Fastify({logger:false,bodyLimit:10*1024*1024});
for(const [entry,route]of [['runtime/profile-local-worker.ts','/worker.js'],['web/src/profile-local-store.ts','/store.js']]){
 const code=(await build({entryPoints:[entry],bundle:true,write:false,format:'esm',target:'es2022',platform:'browser',logLevel:'silent'})).outputFiles[0].text;
 app.get(route,(_q,r)=>r.type('application/javascript').send(code));
}
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Disposable off-main profile wire test</title><label>Responsive shell<input id="typing" autofocus></label><output id="ticks"></output>'));
app.post('/echo-chunk',async q=>q.body);
let browser;
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(origin);
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const result=await page.evaluate(async()=>{
  const {createProfileLocalStore}=await import('/store.js');
  const local=createProfileLocalStore('11111111-1111-4111-8111-111111111111',{createWorker:()=>new Worker('/worker.js',{type:'module'})});
  await local.encodeWire({warmup:true});
  const data={blob:new Blob([new Uint8Array(8*1024*1024)]),binary:new Uint8Array(1024*1024),date:new Date('2026-10-22T00:00:00Z'),map:new Map([['k',new Set([1,2])]])};data.self=data;data.binary[17]=255;
  const native={stringify:JSON.stringify,parse:JSON.parse,atob,btoa,encode:TextEncoder.prototype.encode,digest:SubtleCrypto.prototype.digest};
  const calls=[];const prohibited=name=>function(){calls.push(name);throw Error('SHELL_EXPENSIVE_CODEC_'+name)};
  let ticks=0,last=performance.now(),maxHeartbeatGap=0;const longTasks=[];
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())longTasks.push(e.duration)});observer.observe({type:'longtask',buffered:false});
  const timer=setInterval(()=>{ticks++;const now=performance.now();maxHeartbeatGap=Math.max(maxHeartbeatGap,now-last);last=now;document.querySelector('#ticks').textContent=String(ticks)},10);
  let plan,restored,elapsed,detached=false,blobOnly=true;
  try{
   JSON.stringify=prohibited('JSON.stringify');JSON.parse=prohibited('JSON.parse');globalThis.atob=prohibited('atob');globalThis.btoa=prohibited('btoa');TextEncoder.prototype.encode=prohibited('TextEncoder.encode');SubtleCrypto.prototype.digest=prohibited('SHA256');
   const start=performance.now();plan=await local.prepareWire(data);if(!plan.handle)throw Error('Expected chunked native value');
   const parts=[];
   for(let i=0;i<plan.hashes.length;i++){
    const chunk=await local.wireChunk(plan.handle,i);blobOnly&&=chunk.body instanceof Blob&&!('data'in chunk);
    const response=await fetch('/echo-chunk',{method:'POST',body:chunk.body});if(!response.ok)throw Error('Chunk echo failed');
    const v=await response.json();if(v.hash!==chunk.hash||v.hash!==plan.hashes[i])throw Error('Unexpected chunk hash');
    parts.push(new Uint8Array(await local.decodeChunk(v.data,v.hash)));
   }
   const all=new Uint8Array(plan.bytes);let offset=0;for(const p of parts){all.set(p,offset);offset+=p.length}if(offset!==plan.bytes)throw Error('Byte count mismatch');
   const buffer=all.buffer;restored=await local.decodeWireBytes(buffer,plan.sha256);detached=buffer.byteLength===0;
   await local.releaseWire(plan.handle);elapsed=performance.now()-start;
   let released=false;try{await local.wireChunk(plan.handle,0)}catch(e){released=e.message==='PROFILE_WIRE_HANDLE_UNKNOWN'}
   if(!released)throw Error('Plan retained after release');
  }finally{
   JSON.stringify=native.stringify;JSON.parse=native.parse;globalThis.atob=native.atob;globalThis.btoa=native.btoa;TextEncoder.prototype.encode=native.encode;SubtleCrypto.prototype.digest=native.digest;
   clearInterval(timer);observer.disconnect();local.dispose();
  }
  const preserved={cycle:restored.self===restored,blob:restored.blob instanceof Blob&&restored.blob.size===data.blob.size,typed:restored.binary instanceof Uint8Array&&restored.binary[17]===255,date:restored.date.toISOString()===data.date.toISOString(),map:restored.map instanceof Map&&restored.map.get('k') instanceof Set&&restored.map.get('k').has(2)};
  return{bytes:plan.bytes,chunks:plan.hashes.length,elapsedMs:elapsed,throttle:4,heartbeatTicks:ticks,maxHeartbeatGapMs:maxHeartbeatGap,longTasksMs:longTasks,prohibitedShellCalls:calls,chunkBlobOnly:blobOnly,transferredBufferDetached:detached,preserved};
 });
 const out={result:'PASS',browser:browser.version(),syntheticDisposable:true,resultData:result};
 if(result.prohibitedShellCalls.length||!result.chunkBlobOnly||!result.transferredBufferDetached||Object.values(result.preserved).some(v=>!v)||result.heartbeatTicks<5)throw Error('Off-main profile wire regression failed');
 await writeFile(E+'/BROWSER_RESULT.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
}finally{await browser?.close();await app.close();}
