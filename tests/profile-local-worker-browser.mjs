import Fastify from 'fastify';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { installSandboxCookieRendezvous } from '../server/sandbox-cookie-rendezvous.mjs';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const app=Fastify({logger:false});let frontend;const wire=[];
for(const name of ['sandbox-cookie-owner','sandbox-cookie-worker','sandbox-document-cookie','profile-local-worker','profile-permissions']){
 const code=(await build({entryPoints:['runtime/'+name+'.ts'],bundle:true,write:false,format:'esm',target:'es2022',platform:'browser',logLevel:'silent'})).outputFiles[0].text;
 app.get('/'+name+'.js',(_q,r)=>r.type('application/javascript').send(code));
}
const adapter=(await build({entryPoints:['web/src/profile-local-store.ts'],bundle:true,write:false,format:'esm',target:'es2022',platform:'browser',logLevel:'silent'})).outputFiles[0].text;app.get('/profile-local-store.js',(_q,r)=>r.type('application/javascript').send(adapter));
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Disposable cookie lock reproduction</title>'));
app.addHook('onResponse',(q,r,done)=>{if(q.url.startsWith('/browse/cookies/result/'))wire.push({at:Date.now(),status:r.statusCode});done()});
installSandboxCookieRendezvous(app,{originFor:()=>frontend,authorizeOwner:()=>({session:'synthetic'}),validateOwner:()=>true,documentOrigin:'same-origin',timeoutMs:800});
let browser;
try{
 frontend=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Users/paxton/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
 const page=await browser.newPage();await page.goto(frontend);
 const result=await page.evaluate(async()=>{
  const {createSandboxCookieOwner}=await import('/sandbox-cookie-owner.js');
  const {createSandboxDocumentCookie}=await import('/sandbox-document-cookie.js');
  const owner=await createSandboxCookieOwner({workerURL:'/sandbox-cookie-worker.js',registrationHeaders:()=>({}),browserSessionId:'disposable_cookie_lock_test'});
  const context={requestURL:'https://cookie.fixture.example/path',documentURL:'https://cookie.fixture.example/path',topLevelURL:'https://cookie.fixture.example/path',credentials:'include'};
  await owner.storeResponseCookies(['x=durable; Path=/; Max-Age=600'],context);
  async function bind(){const documentId=crypto.randomUUID();const bound=await owner.bind({documentId,website:context.documentURL});return createSandboxDocumentCookie({documentId,endpoint:bound.endpoint,port:bound.port})}
  const control=await bind(),at=performance.now(),first=control.get(),controlMs=performance.now()-at;control.dispose();
  const facade=await bind();const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('atlas.browsing.cookies.v2');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const tx=db.transaction('meta','readwrite'),request=tx.objectStore('meta').get('revision');let requestDispatched=false,transactionDone=false;
  request.onsuccess=()=>{requestDispatched=true};tx.oncomplete=()=>{transactionDone=true};
  const before=performance.now();let value,error;
  try{value=facade.get()}catch(e){error=e.name+': '+e.message}
  const lockedMs=performance.now()-before,blockedAtReturn={requestDispatched,transactionDone};
  await new Promise(r=>setTimeout(r,100));db.close();owner.dispose();
  const baseline={control:{value:first,ms:controlMs},locked:{value,error,ms:lockedMs,blockedAtReturn,after:{requestDispatched,transactionDone}}};
  const profileId='11111111-1111-4111-8111-111111111111',contextId='disposable-context';
  const {setProfilePermit}=await import('/profile-permissions.js');
  const {createProfileLocalStore}=await import('/profile-local-store.js');
  const permit={profileId,contextId,group:'cookie.fixture.example',epoch:1,expiresAt:Date.now()+90000,offline:false,revoked:false};
  // Canonical site grouping is registrable fixture.example, not full hostname.
  permit.group='fixture.example';await setProfilePermit(indexedDB,permit);
  const local=createProfileLocalStore(profileId,{createWorker:()=>new Worker('/profile-local-worker.js',{type:'module'})});
  const newOwner=await createSandboxCookieOwner({workerURL:'/sandbox-cookie-worker.js',registrationHeaders:()=>({}),browserSessionId:'disposable_cookie_worker_test',profileId,profileContextId:contextId});
  await newOwner.storeResponseCookies(['x=worker-durable; Path=/; Max-Age=600'],context);
  const documentId=crypto.randomUUID(),bound=await newOwner.bind({documentId,website:context.documentURL});
  const cookies=await createSandboxDocumentCookie({documentId,endpoint:bound.endpoint,port:bound.port});
  const changes=await local.queue.list();if(changes.length!==1)throw Error('Expected actual native cookie journal');
  const samples=[];
  // Prohibit App-side IDB opening: all background queue/permit operations must
  // remain independent while synchronous cookie access freezes this agent.
  const nativeOpen=IDBFactory.prototype.open;
  IDBFactory.prototype.open=function(){throw Error('APP_IDB_TRANSACTION_DURING_BROWSING')};
  try{
   for(let i=0;i<20;i++){
    const operation=i%4===0?local.queue.prepare(changes[0],{revision:0,epoch:1}):i%4===1?local.queue.list():i%4===2?local.setPermit({...permit,expiresAt:Date.now()+90000}):local.exportSnapshots();
    await Promise.resolve();await Promise.resolve();
    const start=performance.now(),read=cookies.get();samples.push({value:read,ms:performance.now()-start});await operation;
   }
   const ack=local.queue.acknowledge(changes[0],{revision:1,epoch:1});await Promise.resolve();await Promise.resolve();
   const start=performance.now(),read=cookies.get();samples.push({value:read,ms:performance.now()-start});await ack;
   const pending=await local.queue.list(),head=await local.queue.head(changes[0]);
   const namespace={kind:'idb',origin:'https://binary.fixture.example',name:'native-save'};
   const nativeValue={date:new Date('2026-10-21T10:00:00Z'),bytes:new Uint8Array([0,17,255]),blob:new Blob(['native-worker-binary'],{type:'text/plain'}),map:new Map([['a',new Set([1,2])]])};
   const snapshot={format:'atlas-idb-snapshot-v1',version:2,stores:[{name:'records',keyPath:null,autoIncrement:false,indexes:[{name:'date',keyPath:'date',unique:false,multiEntry:false}],records:[{key:7,value:nativeValue}],generator:null}]};
   await local.restore(namespace,snapshot,[],{revision:9,epoch:1});
   const exported=(await local.exportSnapshots()).find(s=>s.namespace.kind==='idb'&&s.namespace.name==='native-save');
   const restored=exported.payload.stores.find(s=>s.name==='records').records[0].value;
   const binary={date:restored.date instanceof Date&&restored.date.toISOString()===nativeValue.date.toISOString(),bytes:restored.bytes instanceof Uint8Array&&[...restored.bytes].join(',')==='0,17,255',blob:restored.blob instanceof Blob&&await restored.blob.text()==='native-worker-binary',map:restored.map instanceof Map&&restored.map.get('a') instanceof Set&&restored.map.get('a').has(2),head:await local.readHead(namespace)};
   await newOwner.storeResponseCookies(['recovery=keep; Path=/; Max-Age=600'],context);
   const recoveryChanges=await local.queue.list();await local.preserveRecovery('disposable-recovery',recoveryChanges,{nativeValue});
   const recovery={retiredOnlyAcknowledgedJournal:(await local.queue.list()).length===0,cookies:await newOwner.getRequestHeader(context)};
   await local.setPermit({...permit,revoked:true,expiresAt:0});let fenceError;
   try{cookies.set('forbidden=after-fence; Path=/')}catch(e){fenceError=e.name}
   const fencedHeader=await newOwner.getRequestHeader(context);
   baseline.worker={samples,pending:pending.length,head,appIDBOpeningProhibited:true,binary,recovery,fence:{error:fenceError,unwritten:!fencedHeader.includes('forbidden=')}};
  }finally{IDBFactory.prototype.open=nativeOpen;cookies.dispose();newOwner.dispose();local.dispose()}
  return baseline;
 });
 const out={browser:await browser.version(),syntheticDisposable:true,result,wire};
 await writeFile('evidence/seamless-handoff-20261021/real-cookie/COOKIE_IDB_WORKER_REGRESSION.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));if(result.worker.pending!==0||result.worker.samples.some(s=>s.value!=='x=worker-durable'||s.ms>=700)||result.locked.ms<750||!result.worker.binary.date||!result.worker.binary.bytes||!result.worker.binary.blob||!result.worker.binary.map||!result.worker.recovery.retiredOnlyAcknowledgedJournal||result.worker.fence.error!=='InvalidStateError'||!result.worker.fence.unwritten)throw Error('Worker deadlock regression failed');
}finally{await browser?.close();await app.close()}
