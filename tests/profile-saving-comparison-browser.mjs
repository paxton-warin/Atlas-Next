/** Matched client-CPU comparison only: no production, external sites, auth or
 * network uploads. Identical native input, Chromium, UI/font and page throttling. */
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const E='evidence/profile-saving-reliability-20261022/comparison';
const app=Fastify({logger:false});
for(const [entry,url]of [['runtime/hub-contracts.ts','/codec.js'],['runtime/profile-local-worker.ts','/worker.js'],['web/src/profile-local-store.ts','/store.js']]){
 const code=(await build({entryPoints:[entry],bundle:true,write:false,format:'esm',target:'es2022',platform:'browser',logLevel:'silent'})).outputFiles[0].text;app.get(url,(_q,r)=>r.type('application/javascript').send(code));
}
app.get('/font.woff2',async(_q,r)=>r.type('font/woff2').send(await readFile('web/public/fonts/v21/inter-latin.woff2')));
app.get('/',(_q,r)=>r.type('text/html').send(`<!doctype html><title>Matched saving CPU comparison</title><style>@font-face{font-family:Inter;src:url(/font.woff2)}body{font:14px Inter,system-ui;background:#0b100d;color:#ecf0e9;padding:32px}input{font:inherit;padding:12px;border:1px solid #34483b;border-radius:10px;background:#0e1310;color:inherit}#pulse{display:inline-block;width:12px;height:12px;background:#9fd37a;margin:16px;border-radius:50%}</style><h1>Disposable profile-saving CPU comparison</h1><label>Typing stays live <input id=typing autofocus></label><span id=pulse></span><output id=ticks></output>`));
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
let browser;
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1,reducedMotion:'reduce'});const page=await context.newPage();await page.goto(origin);await page.evaluate(()=>document.fonts.ready);
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.evaluate(async()=>{
  const {encodePortableValue}=await import('/codec.js'),{createProfileLocalStore}=await import('/store.js');
  const local=createProfileLocalStore('11111111-1111-4111-8111-111111111111',{createWorker:()=>new Worker('/worker.js',{type:'module'})});
  const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const warm={blob:new Blob(['warm']),binary:new Uint8Array([1,2]),dense:[{key:'warm',value:1}],date:new Date('2026-10-22T00:00:00Z')};await encodePortableValue(warm);await local.encodeWire(warm);await sha(new Uint8Array([1]));
  window.runSavingTrial=async(mode,id)=>{
   const value={blob:new Blob([new Uint8Array(8*1024*1024)]),binary:new Uint8Array(1024*1024),dense:Array.from({length:1024},(_,i)=>({key:'record-'+i,value:i})),date:new Date('2026-10-22T00:00:00Z')};value.binary[17]=255;
   const input=document.querySelector('#typing');input.value='';input.focus();
   const longTasks=[],frames=[];let raf,framePrevious=performance.now(),ticks=0;
   const frame=now=>{frames.push(now-framePrevious);framePrevious=now;ticks++;document.querySelector('#ticks').textContent=String(ticks);document.querySelector('#pulse').style.opacity=String(ticks%2?.4:1);raf=requestAnimationFrame(frame)};
   const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push({duration:entry.duration,startTime:entry.startTime})});observer.observe({type:'longtask',buffered:false});raf=requestAnimationFrame(frame);
   await new Promise(resolve=>requestAnimationFrame(resolve));await window.savingTrialStarted(id);const start=performance.now();let manifest,bodyBytes=0;
   if(mode==='baseline'){
    // Exact old App algorithm from baseline profile-client.ts, replacing only
    // authenticated HTTP upload with body construction in BOTH implementations.
    const graph=await encodePortableValue(value),text=JSON.stringify(graph),bytes=new TextEncoder().encode(text);
    if(bytes.length>128*1024*1024)throw Error('PROFILE_STREAM_SIZE_EXCEEDED');
    if(bytes.length<500000)manifest=graph;
    else{
     const hashes=[];
     for(let i=0;i<bytes.length;i+=4*1024*1024){
      const part=bytes.slice(i,i+4*1024*1024),hash=await sha(part);let data='';
      for(let n=0;n<part.length;n+=8192)data+=String.fromCharCode(...part.slice(n,n+8192));
      const body=new Blob([JSON.stringify({hash,data:btoa(data)})],{type:'application/json'});bodyBytes+=body.size;hashes.push(hash);
     }
     manifest={codec:'atlas-chunks-v1',hashes,bytes:bytes.length,sha256:await sha(bytes)};
    }
   }else{
    const prepared=await local.prepareWire(value);
    if(!prepared.handle)manifest=prepared;
    else try{
     for(let index=0;index<prepared.hashes.length;index++){const chunk=await local.wireChunk(prepared.handle,index);if(chunk.hash!==prepared.hashes[index]||!(chunk.body instanceof Blob)||'data'in chunk)throw Error('Invalid worker chunk');bodyBytes+=chunk.body.size;}
     manifest={codec:'atlas-chunks-v1',hashes:prepared.hashes,bytes:prepared.bytes,sha256:prepared.sha256};
    }finally{await local.releaseWire(prepared.handle);}
   }
   const end=performance.now();await new Promise(resolve=>setTimeout(resolve,70));observer.takeRecords().forEach(entry=>longTasks.push({duration:entry.duration,startTime:entry.startTime}));observer.disconnect();cancelAnimationFrame(raf);
   return{mode,elapsedMs:end-start,manifest,bodyBytes,longTasksMs:longTasks.filter(t=>t.startTime>=start&&t.startTime<=end).map(t=>t.duration),raf:{ticks,maximumGapMs:Math.max(...frames),gapsMs:frames},typedCharacters:input.value.length,input:{blobBytes:8*1024*1024,typedBytes:1024*1024,denseRecords:1024},font:getComputedStyle(input).fontFamily};
  };
  window.disposeSavingTrial=()=>local.dispose();
 });
 let currentResolve;await page.exposeFunction('savingTrialStarted',id=>{currentResolve?.(id);});
 const trials=[];
 for(const [index,mode]of ['baseline','modified','modified','baseline','baseline','modified'].entries()){
  await cdp.send('HeapProfiler.collectGarbage');let started;const startedPromise=new Promise(resolve=>started=resolve);currentResolve=started;
  let complete=false;const work=page.evaluate(([m,id])=>window.runSavingTrial(m,id),[mode,index]).finally(()=>complete=true);
  await startedPromise;const keyboard=[];
  do{const at=performance.now();await page.keyboard.type('a');keyboard.push(performance.now()-at);if(!complete)await new Promise(resolve=>setTimeout(resolve,20));}while(!complete);
  const result=await work;result.keyboard={measurement:'Node-to-Chromium real keyboard.type(a) roundtrip while saving;20ms pacing;includes CDP overhead',samples:keyboard.length,p95Ms:percentile(keyboard,.95),maxMs:Math.max(...keyboard),latenciesMs:keyboard};trials.push(result);
 }
 const first=trials[0];for(const trial of trials){assert.deepEqual(trial.manifest,first.manifest);assert.equal(trial.bodyBytes,first.bodyBytes);assert.ok(trial.typedCharacters>0);}
 const summarize=mode=>{const t=trials.filter(v=>v.mode===mode),keys=t.flatMap(v=>v.keyboard.latenciesMs),tasks=t.flatMap(v=>v.longTasksMs),raf=t.flatMap(v=>v.raf.gapsMs);return{trials:t.length,elapsedMs:t.map(v=>v.elapsedMs),medianElapsedMs:percentile(t.map(v=>v.elapsedMs),.5),keyboardSamples:keys.length,keyboardP95Ms:percentile(keys,.95),keyboardMaximumMs:Math.max(...keys),mainThreadLongTasksOver50ms:tasks.length,maximumObservedMainThreadTaskMs:tasks.length?Math.max(...tasks):null,maximumTaskQualification:tasks.length?'Measured LongTasks API duration':'No >50ms LongTasks entry observed; sub50ms maximum not exposed by this API',rafP95GapMs:percentile(raf,.95),rafMaximumGapMs:Math.max(...raf)};};
 const baseline=summarize('baseline'),modified=summarize('modified');
 const out={result:'PASS',browser:browser.version(),environment:{viewport:{width:1366,height:768},deviceScaleFactor:1,cpuThrottle:4,throttleScope:'Chromium page CPU via CDP; dedicated worker thread is not independently CPU-throttled',fonts:'same self-hosted warmed Inter',network:'Upload omitted equally in both; exact JSON request body Blob constructed and byte sizes compared. No production/external requests.',warmup:'Both codec and worker warmed with same small native sample; GC before every trial; alternating order',keyboard:'Real keyboard.type(a) CDP roundtrip,20ms pacing; samples span saving plus70ms common observer flush; differing samplecounts reported',qualification:'Controlled desktop client-CPU comparison, not physical Chromebook or server capacity qualification'},wireIdentical:{bytes:first.manifest.bytes,hashes:first.manifest.hashes,sha256:first.manifest.sha256,jsonBodyBytes:first.bodyBytes},baseline,modified,gates:{wireAndBodiesIdentical:true,modifiedNoMainThreadTaskOver50ms:modified.mainThreadLongTasksOver50ms===0,modifiedKeyboardP95AtMost100ms:modified.keyboardP95Ms<=100},trials};
 if(!out.gates.modifiedNoMainThreadTaskOver50ms||!out.gates.modifiedKeyboardP95AtMost100ms)out.result='GATE_FAILED';
 await page.evaluate(()=>window.disposeSavingTrial());await writeFile(E+'/RESULTS.json',JSON.stringify(out,null,2));console.log(JSON.stringify({result:out.result,browser:out.browser,wire:out.wireIdentical,baseline,modified,gates:out.gates},null,2));if(out.result!=='PASS')process.exitCode=1;
}finally{await browser?.close();await app.close();}
