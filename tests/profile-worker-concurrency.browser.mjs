/** Actual trusted worker: unrelated cold restores coexist with two retained
 * compaction uploads. Native results, hashes, and slot admission are verified. */
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const app=Fastify({logger:false});
for(const [name,file] of [['worker','runtime/profile-local-worker.ts'],['local','web/src/profile-local-store.ts'],['codec','runtime/hub-contracts.ts']]){
 const code=(await build({entryPoints:[file],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
 app.get('/'+name+'.js',(_q,r)=>r.type('application/javascript').send(code));
}
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Profile worker concurrency</title>'));
let browser;
try{
 const url=await app.listen({host:'127.0.0.1',port:0});
 const executablePath=process.env.CHROME_PATH||['/Users/paxton/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});const page=await browser.newPage();await page.goto(url);
 const result=await page.evaluate(async()=>{
  const {createProfileLocalStore}=await import('/local.js'),{encodePortableValue,decodePortableValue}=await import('/codec.js');
  const id='11111111-1111-4111-8111-111111111111',local=createProfileLocalStore(id,{createWorker:()=>new Worker('/worker.js',{type:'module'})});
  const spec=(origin,operation='restore')=>({namespace:{kind:'local',origin},revision:1,snapshotRevision:1,journal:[],head:{revision:1,epoch:2},operation});
  const snapshot=(value)=>({format:'atlas-local-snapshot-v1',revision:1,entries:[['save',value]]});
  const compacts=await Promise.all([0,1].map(async i=>{
   const h=await local.beginHydration(spec('https://compact'+i+'.example','compact'));
   await local.hydrateValue(h,0,await encodePortableValue(snapshot(String(i).repeat(600000))));
   return local.finishHydration(h);
  }));
  // Both chunked plans stay retained as if cloud upload was blocked. They must
  // neither hold the codec queue nor forbid four independent foreground tabs.
  const inlineWhileUploads=decodePortableValue(await local.prepareWire({preference:'saved inline'})).preference==='saved inline';
  const handles=await Promise.all([0,1,2,3].map(i=>local.beginHydration(spec('https://cold'+i+'.example'))));
  let fifthReady=false;const fifth=local.beginHydration(spec('https://cold4.example')).then(h=>{fifthReady=true;return h});
  await new Promise(r=>setTimeout(r,20));const fifthInitiallyWaiting=!fifthReady;
  await Promise.all(handles.map(async(h,i)=>local.hydrateValue(h,0,await encodePortableValue(snapshot('cold-value-'+i)))));
  await Promise.all(handles.map(h=>local.finishHydration(h)));
  const fifthHandle=await fifth;await local.hydrateValue(fifthHandle,0,await encodePortableValue(snapshot('cold-value-4')));await local.finishHydration(fifthHandle);
  const exports=await Promise.all([0,1,2,3,4].map(i=>local.exportSnapshots('cold'+i+'.example')));
  const values=exports.map(v=>v[0].payload.entries[0][1]);
  const compactionExact=[];
  for(let i=0;i<compacts.length;i++){
   const plan=compacts[i],parts=[];
   for(let n=0;n<plan.hashes.length;n++){
    const {hash,body}=await local.wireChunk(plan.handle,n),chunk=JSON.parse(await body.text());
    if(hash!==plan.hashes[n])throw Error('compaction hash mismatch');parts.push(new Uint8Array(await local.decodeChunk(chunk.data,hash)));
   }
   const bytes=new Uint8Array(plan.bytes);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
   const value=await local.decodeWireBytes(bytes.buffer,plan.sha256);compactionExact.push(value.entries[0][1]===String(i).repeat(600000));await local.releaseWire(plan.handle);
  }
  const simultaneous=await Promise.all(Array.from({length:8},(_,i)=>local.encodeWire({index:i,blob:new Blob(['blob-'+i])})));
  const roundtrip=await Promise.all(simultaneous.map(v=>local.decodeWire(v)));
  const codecsExact=roundtrip.every((v,i)=>v.index===i)&&await Promise.all(roundtrip.map(v=>v.blob.text())).then(v=>v.every((s,i)=>s==='blob-'+i));
  // Saturation cannot consume the control slots active holders need to
  // finish. Excess admission is retryable and never claims a storage write.
  const saturated=await Promise.all([0,1,2,3].map(i=>local.beginHydration(spec('https://active'+i+'.test'))));
  const waiting=Array.from({length:16},(_,i)=>local.beginHydration(spec('https://waiting'+i+'.test')));
  await new Promise(r=>setTimeout(r,20));let overflowCode;
  try{await local.beginHydration(spec('https://overflow.test'))}catch(error){overflowCode=error.code}
  await Promise.all(saturated.map(h=>local.abortHydration(h)));
  for(const next of waiting){const handle=await next;await local.abortHydration(handle)}
  const after=await local.beginHydration(spec('https://after-saturation.test'));await local.abortHydration(after);
  local.dispose();return{fifthInitiallyWaiting,fifthAdmitted:fifthReady,values,compactionExact,codecsExact,retainedPlansDuringColdOpen:compacts.length,inlineWhileUploads,overflowCode,saturationDrained:true};
 });
 assert.equal(result.fifthInitiallyWaiting,true);assert.equal(result.fifthAdmitted,true);assert.deepEqual(result.values,Array.from({length:5},(_,i)=>'cold-value-'+i));assert.deepEqual(result.compactionExact,[true,true]);assert.equal(result.codecsExact,true);assert.equal(result.inlineWhileUploads,true);assert.equal(result.overflowCode,'PROFILE_LOCAL_BACKPRESSURE');assert.equal(result.saturationDrained,true);
 const output={browser:await browser.version(),...result};await writeFile('evidence/account-locks-20261028/native-worker-concurrency.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));
}finally{await browser?.close();await app.close()}
