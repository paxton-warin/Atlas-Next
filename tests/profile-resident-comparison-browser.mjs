/** Native IDB + actual built profile worker; local synthetic transport only. */
import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';import {resolve,join} from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import Fastify from 'fastify';import {chromium} from '@playwright/test';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const candidate=process.cwd(),baseline=resolve(process.env.ATLAS_RESIDENT_BASELINE||'../../baseline/Atlas-Next'),E=resolve(process.env.ATLAS_RESIDENT_EVIDENCE||'../../client/resident-comparison');await mkdir(E,{recursive:true});
const app=Fastify({logger:false,bodyLimit:64*1024*1024}),payloads=new Map(),sourceHashes={};const hash=b=>createHash('sha256').update(b).digest('hex');
for(const [mode,tree] of [['baseline',baseline],['modified',candidate]]){
 const assets=join(tree,'dist/web/assets'),worker=(await readdir(assets)).find(n=>/^profile-local-worker-.*\.js$/.test(n));assert(worker,'Build the exact profile worker first');const code=await readFile(join(assets,worker));sourceHashes[mode]=hash(code);app.get('/'+mode+'-worker.js',(_q,r)=>r.type('text/javascript').send(code));
 const adapter=(await build({entryPoints:[join(tree,'web/src/profile-local-store.ts')],bundle:true,write:false,format:'esm',target:'es2022',platform:'browser',logLevel:'silent'})).outputFiles[0].text;app.get('/'+mode+'-store.js',(_q,r)=>r.type('text/javascript').send(adapter));
 const shim=`import '/${mode}-worker.js';import * as J from '/journal.js';import * as S from '/profile-store.js';import {encodePortableValue} from '/codec.js';
const profile='11111111-1111-4111-8111-111111111111',origin='https://resident.example',name='source-game';const request=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)}),done=tx=>new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error)});
self.addEventListener('message',async({data})=>{if(data?.protocol!=='resident-fixture')return;try{
 let value;if(data.operation==='seed'){
 const physical=J.profileIDBPrefix(origin,profile)+encodeURIComponent(name),r=indexedDB.open(physical,1);r.onupgradeneeded=()=>{r.result.createObjectStore('data');r.result.createObjectStore(J.PROFILE_IDB_KEEP)};const db=await request(r);
 const tx=db.transaction(['data',J.PROFILE_IDB_KEEP],'readwrite',{durability:'strict'}),complete=done(tx);
 for(let i=0;i<3;i++){const bytes=new Uint8Array(4*1024*1024);bytes[137]=255;const native={bytes,objects:Array.from({length:3000},(_,n)=>({n,text:'synthetic-'+n+'-'.repeat(96)})),date:new Date('2026-10-22T00:00:00Z')};native.self=native;tx.objectStore('data').put(native,i);J.appendProfileJournal(tx.objectStore(J.PROFILE_IDB_KEEP),{profileId:profile,kind:'idb',origin,name,bytes:5*1024*1024,payload:{transactionId:'synthetic-'+i,version:1,changes:[{type:'mutation',store:'data',action:'put',key:i,args:[native,i]}]}},'string')}
 tx.objectStore(J.PROFILE_IDB_KEEP).put({bytes:15*1024*1024,sliceBytes:64*1024*1024,records:3,indexEntries:0},'usage');await complete;db.close();const snapshots=await S.exportProfileSnapshots(indexedDB,profile,undefined,'resident.example');const snapshot=snapshots.find(s=>s.namespace.kind==='idb'&&s.namespace.name===name).payload;const graph=await encodePortableValue(snapshot);value={blob:new Blob([JSON.stringify(graph)],{type:'application/json'}),records:snapshot.stores[0].records.length};
 }else if(data.operation==='inspect'){
 const snapshots=await S.exportProfileSnapshots(indexedDB,profile,undefined,'resident.example'),snapshot=snapshots.find(s=>s.namespace.kind==='idb'&&s.namespace.name==='restored-game')?.payload;const rows=snapshot?.stores[0]?.records||[];value={records:rows.length,types:rows.every(r=>r.value.self===r.value&&r.value.bytes instanceof Uint8Array&&r.value.bytes.length===4*1024*1024&&r.value.bytes[137]===255&&r.value.objects.length===3000&&r.value.date.toISOString()==='2026-10-22T00:00:00.000Z')};
 }else throw Error('Unknown fixture op');self.postMessage({protocol:'resident-fixture',id:data.id,value})
 }catch(e){self.postMessage({protocol:'resident-fixture',id:data.id,error:e.message})}});`;
 app.get('/'+mode+'-fixture-worker.js',(_q,r)=>r.type('text/javascript').send(shim));
}
for(const [route,file] of [['/journal.js','runtime/profile-journal.ts'],['/profile-store.js','runtime/profile-store.ts'],['/codec.js','runtime/hub-contracts.ts'],['/permissions.js','runtime/profile-permissions.ts']]){const code=(await build({entryPoints:[join(candidate,file)],bundle:true,write:false,format:'esm',target:'es2022',platform:'browser',logLevel:'silent'})).outputFiles[0].text;app.get(route,(_q,r)=>r.type('text/javascript').send(code))}
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Atlas native resident pipeline proof</title><label>Type while native profile work runs<input id="typing" autofocus></label><p id="stage"></p>'));
app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_r,b,done)=>done(null,b));
app.post('/fixture/:id',async q=>{const data=q.body;payloads.set(q.params.id,data);return{codec:'atlas-chunks-v1',bytes:data.length,hashes:Array.from({length:Math.ceil(data.length/(4*1024*1024))},(_,i)=>hash(data.subarray(i*4*1024*1024,(i+1)*4*1024*1024))),sha256:hash(data)}});
app.get('/fixture/:id/:part',async q=>{const all=payloads.get(q.params.id),i=Number(q.params.part),data=all.subarray(i*4*1024*1024,(i+1)*4*1024*1024);return{data:data.toString('base64')}});
let browser;const trials=[];const percentile=(a,p)=>a.length?[...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1]:null;
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true});
 for(const mode of ['baseline','modified','modified','baseline','baseline','modified']){
  const context=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1}),page=await context.newPage(),cdp=await context.newCDPSession(page);await page.goto(origin);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const id=String(trials.length);await page.evaluate(async({mode,id})=>{
   const {createProfileLocalStore}=await import('/'+mode+'-store.js');const raw=new Worker('/'+mode+'-fixture-worker.js',{type:'module'}),ops=new Map();window.replies=[];window.raw=raw;
   const worker={postMessage(v,t){if(v.protocol==='atlas-profile-local-v1')ops.set(v.id,v.operation);raw.postMessage(v,t||[])},terminate:()=>raw.terminate(),addEventListener:(...a)=>raw.addEventListener(...a),removeEventListener:(...a)=>raw.removeEventListener(...a)};
   raw.addEventListener('message',({data})=>{if(data.protocol!=='atlas-profile-local-v1')return;const op=ops.get(data.id);ops.delete(data.id);if(op==='queue-list')window.replies.push({op,nativePayloads:(data.value||[]).filter(c=>c.entry.payload!==undefined).length,nativeBinaryBytes:(data.value||[]).reduce((sum,c)=>sum+(c.entry.payload?.changes?.[0]?.args?.[0]?.bytes?.byteLength||0),0)});if(op==='decode-wire-bytes')window.replies.push({op,nativeBinaryBytes:(data.value?.stores?.[0]?.records||[]).reduce((sum,r)=>sum+(r.value?.bytes?.byteLength||0),0)})});
   window.local=createProfileLocalStore('11111111-1111-4111-8111-111111111111',{createWorker:()=>worker});await window.local.prepareWire({warmup:true});let serial=0;
   window.fixture=(operation)=>new Promise((ok,no)=>{const n=++serial;const receive=({data})=>{if(data.protocol!=='resident-fixture'||data.id!==n)return;raw.removeEventListener('message',receive);data.error?no(Error(data.error)):ok(data.value)};raw.addEventListener('message',receive);raw.postMessage({protocol:'resident-fixture',id:n,operation})});
   const seed=await window.fixture('seed');if(seed.records!==3)throw Error('Wrong seed');window.manifest=await(await fetch('/fixture/'+id,{method:'POST',headers:{'content-type':'application/octet-stream'},body:seed.blob})).json();window.fixtureID=id;
   window.inputDelays=[];window.longtasks=[];window.frames=[];let last=performance.now();document.querySelector('#typing').addEventListener('keydown',e=>{if(window.busy)window.inputDelays.push(performance.now()-e.timeStamp)});const raf=at=>{if(window.busy)window.frames.push(at-last);last=at;requestAnimationFrame(raf)};requestAnimationFrame(raf);new PerformanceObserver(l=>{for(const e of l.getEntries())if(window.busy)window.longtasks.push(e.duration)}).observe({type:'longtask',buffered:false});
  },{mode,id});
  const run=async(stage)=>{
   await page.locator('#typing').focus();await page.evaluate(stage=>{window.busy=true;window.inputDelays=[];window.longtasks=[];window.frames=[];document.querySelector('#stage').textContent=stage},stage);
   let done=false;const keys=[];const work=page.evaluate(async({stage,mode})=>{const start=performance.now();let details;
    if(stage==='queue'){
     const changes=await local.queue.list();if(changes.length!==3)throw Error('Missing journal');const plans=[];
     for(const c of changes){const p=mode==='modified'?await local.prepareQueueWire(c):await local.prepareWire(c.entry.payload);plans.push({bytes:p.bytes,hashes:p.hashes,sha256:p.sha256});await local.releaseWire(p.handle)}details={plans,payloadOmitted:changes.every(c=>c.payloadOmitted===true&&c.entry.payload===undefined)};
    }else{
     const n={kind:'idb',origin:'https://resident.example',name:'restored-game'},m=window.manifest;
     if(mode==='modified'){
      const h=await local.beginHydration({namespace:n,revision:1,snapshotRevision:1,journal:[],head:{revision:1,epoch:2},operation:'restore'});try{await local.hydrateValue(h,0,m);for(let i=0;i<m.hashes.length;i++){const part=await(await fetch('/fixture/'+fixtureID+'/'+i)).json();await local.hydrateChunk(h,i,part.data)}await local.finishHydration(h)}finally{await local.abortHydration(h).catch(()=>{})}
     }else{
      const all=new Uint8Array(m.bytes);let offset=0;for(let i=0;i<m.hashes.length;i++){const part=await(await fetch('/fixture/'+fixtureID+'/'+i)).json();const bytes=await local.decodeChunk(part.data,m.hashes[i]);all.set(new Uint8Array(bytes),offset);offset+=bytes.byteLength}const native=await local.decodeWireBytes(all.buffer,m.sha256);await local.restore(n,native,[],{revision:1,epoch:2});
     }details={wire:window.manifest};
    }
    const elapsedMs=performance.now()-start;await new Promise(r=>setTimeout(r,70));window.busy=false;return{elapsedMs,details,input:window.inputDelays,longtasks:window.longtasks,frames:window.frames};
   },{stage,mode}).finally(()=>done=true);
   while(!done){const s=performance.now();await page.keyboard.type('a');keys.push(performance.now()-s);await new Promise(r=>setTimeout(r,20))}
   const measured=await work;return{...measured,keyboardSamples:keys.length,keyboardP95Ms:percentile(keys,.95),keyboardMaxMs:Math.max(...keys),inputP95Ms:percentile(measured.input,.95),maxRafGapMs:Math.max(...measured.frames),longTaskMaxMs:Math.max(0,...measured.longtasks)};
  };
  const queue=await run('queue'),restore=await run('restore');const state=await page.evaluate(async()=>({inspect:await window.fixture('inspect'),queueStillPresent:(await local.queue.list()).length,replies:window.replies}));assert.deepEqual(state.inspect,{records:3,types:true});assert.equal(state.queueStillPresent,3);if(mode==='modified')assert.equal(queue.details.payloadOmitted,true);
  trials.push({mode,queue,restore,state});console.log(mode,'queueMs',queue.elapsedMs,'restoreMs',restore.elapsedMs,'keyP95',queue.keyboardP95Ms,restore.keyboardP95Ms);await context.close();
 }
 for(let i=1;i<trials.length;i++){assert.deepEqual(trials[i].queue.details.plans,trials[0].queue.details.plans);assert.deepEqual(trials[i].restore.details.wire,trials[0].restore.details.wire)}
 const context=await browser.newContext(),page=await context.newPage();await page.goto(origin);const cas=await page.evaluate(async()=>{
  const {setProfilePermit,resumeProfilePermit,revokeProfilePermit,assertProfileWrite}=await import('/permissions.js');const p={profileId:'11111111-1111-4111-8111-111111111111',group:'resident.example',contextId:'old',epoch:2,expiresAt:Date.now()+90000,offline:false,revoked:true};await setProfilePermit(indexedDB,p);const resumed=await resumeProfilePermit(indexedDB,{...p,revoked:false});const newer={...p,contextId:'new',epoch:3,revoked:false};await setProfilePermit(indexedDB,newer);const oldCleanup=await revokeProfilePermit(indexedDB,p),oldResume=await resumeProfilePermit(indexedDB,{...p,revoked:false});await assertProfileWrite(indexedDB,p.profileId,'https://resident.example','new');return{resumed,oldCleanup,oldResume,newerOwnerWritable:true};
 });assert.deepEqual(cas,{resumed:true,oldCleanup:false,oldResume:false,newerOwnerWritable:true});await context.close();
 const summary=Object.fromEntries(['baseline','modified'].map(mode=>{const rows=trials.filter(t=>t.mode===mode);return[mode,Object.fromEntries(['queue','restore'].map(stage=>[stage,{trials:rows.length,medianElapsedMs:percentile(rows.map(t=>t[stage].elapsedMs),.5),keyboardSamples:rows.reduce((s,t)=>s+t[stage].keyboardSamples,0),keyboardP95ByTrialMs:rows.map(t=>t[stage].keyboardP95Ms),maximumLongTaskMs:Math.max(...rows.map(t=>t[stage].longTaskMaxMs)),maximumRafGapMs:Math.max(...rows.map(t=>t[stage].maxRafGapMs))}]))]}));
 const result={result:'PASS',browser:browser.version(),qualification:'Disposable actual built workers/native IDB. Fourfold PAGE CPU throttling; worker CPU not equally throttled. No physical N5100/8GB or server qualification. Keyboard acknowledgement includes CDP; not key-to-pixel INP.',productionRequests:0,sourceHashes,fixture:{records:3,binaryBytesPerRecord:4*1024*1024,objectsPerRecord:3000,outboxBudgetBytes:15*1024*1024},exactWireAndRestoreParity:true,cas,summary,trials};await writeFile(join(E,'RESULTS.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',sourceHashes,cas,summary},null,2));
}finally{await browser?.close();await app.close()}
