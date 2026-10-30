import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const bundle=async contents=>(await build({bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',
  stdin:{resolveDir:resolve('runtime'),contents}})).outputFiles[0].text;
const api=await bundle(`export {createSandboxIndexedDB,bindSandboxIndexedDB} from './sandbox-idb.ts';
 export {createLocalStorageOwnerV2,createLocalCookieOwnerV2} from './sandbox-local-owners-v2.ts';
 export {createSandboxStorageFacades,rebindSandboxStorageFacades} from './sandbox-local-storage.ts';
 export {createSandboxDocumentCookie} from './sandbox-document-cookie.ts';
 export {LocalCookieJarV2 as SandboxCookieJar} from './local-cookie-jar-v2.ts';
 export {profileDatabaseName,profileIDBPrefix} from './profile-journal.ts';
 export {LOCAL_NATIVE_PROTOCOL} from './local-native-worker.ts';
 export {inspectLegacySite,copyLegacySiteToV2} from './local-legacy-migration-v2.ts';
 export {appendLocalDirty,readLocalDirtyControl} from './local-dirty-v2.ts';
 export {commitLocalStorageV2} from './local-storage-v2.ts';`);
const files={'/api.js':api,'/native.js':await bundle(`import './local-native-worker.ts';`),
  '/storage.js':await bundle(`import './storage-native-worker-v2.ts';`),'/cookies.js':await bundle(`import './cookie-native-worker-v2.ts';`)};
const app=Fastify({logger:false});app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Local-first native authority</title>'));
for(const [path,source] of Object.entries(files)) app.get(path,(_q,r)=>r.type('application/javascript').send(source));
let browser;const output=resolve('evidence/local-first-backups-20261028/NATIVE_V2_BROWSER.json');await mkdir(resolve('evidence/local-first-backups-20261028'),{recursive:true});
const report={command:'node tests/local-native-v2-browser.mjs',productionChanged:false,checks:{}};
try {
 const origin=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 report.browser=browser.version();const context=await browser.newContext(),page=await context.newPage();
 const failures=[];page.on('pageerror',e=>failures.push(e.message));await page.goto(origin);
 await page.evaluate(async()=>{window.api=await import('/api.js');
  const oldOpen=XMLHttpRequest.prototype.open,oldSend=XMLHttpRequest.prototype.send,urls=new WeakMap();window.receiptReadFailures=0;
  XMLHttpRequest.prototype.open=function(method,url,...args){urls.set(this,String(url));return oldOpen.call(this,method,url,...args);};
  XMLHttpRequest.prototype.send=function(...args){const url=urls.get(this)||'';
    if(window.dropStorageReceipt&&url.includes('/atlas-storage-receipts/')) {
      window.dropStorageReceipt=false;receiptReadFailures++;throw new DOMException('Synthetic lost local storage acknowledgement','NetworkError');}
    if(window.dropCookieReceipt>0&&url.includes('/atlas-cookie-receipts-v2/')) {
      window.dropCookieReceipt--;receiptReadFailures++;throw new DOMException('Synthetic lost local cookie acknowledgement','NetworkError');}
    return oldSend.apply(this,args);};
  window.authority={version:2,profileId:'11111111-1111-4111-8111-111111111111',
  replicaId:'22222222-2222-4222-8222-222222222222',localAuthGeneration:'generation_0123456789abcdef',browserSessionId:'session_0123456789abcdef'};
  window.storageOwner=await api.createLocalStorageOwnerV2({workerURL:'/storage.js',localAuthority:authority});
  window.cookieOwner=await api.createLocalCookieOwnerV2({workerURL:'/cookies.js',localAuthority:authority});
  window.storageBinding=await storageOwner.bind({documentId:'storage_document_0123456789',website:'https://site.example',sessionId:authority.browserSessionId});
  window.storage=await api.createSandboxStorageFacades({documentId:'storage_document_0123456789',endpoint:storageBinding.endpoint,
   port:storageBinding.port,window,localOnly:true});
  api.rebindSandboxStorageFacades(storage,window);
  window.cookieBinding=await cookieOwner.bind({documentId:'cookie_document_0123456789',website:'https://site.example'});
  window.cookies=await api.createSandboxDocumentCookie({documentId:'cookie_document_0123456789',endpoint:cookieBinding.endpoint,
   port:cookieBinding.port,window,localOnly:true});
  window.native=new Worker('/native.js',{type:'module'});window.serial=0;window.pending=new Map();native.onmessage=({data})=>{if(data.id){const p=pending.get(data.id);pending.delete(data.id);data.ok?p.resolve(data.value):p.reject(new Error(JSON.stringify(data.error)));}};
  window.control=(operation,payload={},ports=[])=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});native.postMessage({protocol:api.LOCAL_NATIVE_PROTOCOL,id,operation,...payload},ports);});
  await control('initialize',{authority});const channel=new MessageChannel(),documentId='idb_document_0123456789';
  await control('bind-idb',{authority:{...authority,documentId,logicalOrigin:'https://site.example'},documentId,website:'https://site.example'},[channel.port1]);
  window.idb=api.createSandboxIndexedDB(channel.port2,documentId);window.request=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
  const opened=idb.open('data',1);opened.onupgradeneeded=()=>{const store=opened.result.createObjectStore('records',{autoIncrement:true});store.createIndex('name','name',{unique:true});store.createIndex('tags','tags',{multiEntry:true});};
  window.db=await request(opened);
 });
 // Networking is disabled AFTER all local actors bind. Neither a cloud token,
 // profile permit, connection socket nor backup worker exists in this fixture.
 await context.setOffline(true);
 report.checks.independent=await page.evaluate(async()=>{
   const errors=[];for(let n=0;n<40;n++) storage.localStorage.setItem('draft','value-'+n);
   storage.localStorage.setItem('','');storage.localStorage.removeItem('');storage.sessionStorage.setItem('session','kept');
   cookies.set('preference=local; Path=/; SameSite=Lax');
   let tx=db.transaction('records','readwrite',{durability:'strict'}),done=tx.done;
   const key1=await request(tx.objectStore('records').add({name:'one',tags:['a','a','b'],value:'local'}));await done;
   tx=db.transaction('records','readwrite');done=tx.done;tx.objectStore('records').put({name:'high',tags:[]},100);await done;
   tx=db.transaction('records','readwrite');done=tx.done;tx.objectStore('records').delete(100);await done;
   tx=db.transaction('records','readwrite');done=tx.done;const key2=await request(tx.objectStore('records').add({name:'two',tags:['b']}));await done;
   tx=db.transaction('records');done=tx.done;const row=await request(tx.objectStore('records').get(key1));await done;
   return {draft:storage.localStorage.getItem('draft'),session:storage.sessionStorage.getItem('session'),cookie:cookies.get(),
     key1,key2,value:row.value,durability:'strict',title:document.title};
 });
 assert.equal(report.checks.independent.draft,'value-39');assert.equal(report.checks.independent.cookie.includes('preference=local'),true);
 assert.equal(report.checks.independent.key2,101);assert.equal(report.checks.independent.value,'local');
 await context.setOffline(false);
 report.checks.ledger=await page.evaluate(async()=>{
   const physical=(await indexedDB.databases()).find(d=>d.name?.startsWith(api.profileIDBPrefix('https://site.example',authority.replicaId))&&!d.name.endsWith(':#quota')).name,
    nativeDB=await request(indexedDB.open(physical)), tx=nativeDB.transaction('__atlas_idb_keepalive_v2__'), store=tx.objectStore('__atlas_idb_keepalive_v2__'),
    usage=await request(store.get('usage')), keys=await request(store.getAllKeys());nativeDB.close();
   return {usage,outbox:keys.filter(k=>typeof k==='string'&&k.startsWith('outbox:')).length,
    dirtyControls:keys.filter(k=>Array.isArray(k)&&k[0]==='atlas-local-dirty-v2'&&k[1]==='control').length,
    recordMetadata:keys.filter(k=>Array.isArray(k)&&k[0]==='local-record-v2').length};
 });
 assert.equal(report.checks.ledger.usage.localAccountingVersion,2);assert.equal(report.checks.ledger.usage.records,2);
 assert.equal(report.checks.ledger.outbox,0);assert.equal(report.checks.ledger.recordMetadata,2);
 report.checks.clears=await page.evaluate(async()=>{let tx=db.transaction('records','readwrite'),done=tx.done;tx.objectStore('records').clear();await done;
  tx=db.transaction('records','readwrite');done=tx.done;const key=await request(tx.objectStore('records').add({name:'after-clear',tags:['x']}));await done;
  tx=db.transaction('records','readwrite');done=tx.done;tx.objectStore('records').delete(IDBKeyRange.lowerBound(1));await done;
  return {key};});assert.equal(report.checks.clears.key,102);
 report.checks.lostLocalReceipts=await page.evaluate(async()=>{
   const localDB=await request(indexedDB.open(api.profileDatabaseName('atlas.browsing.v2',authority.replicaId))),cookieDB=await request(indexedDB.open(api.profileDatabaseName('atlas.browsing.cookies.v2',authority.replicaId)));
   const read=async(db,store,key)=>{const tx=db.transaction(store),done=new Promise((res,rej)=>{tx.oncomplete=res;tx.onabort=()=>rej(tx.error);});const value=await request(tx.objectStore(store).get(key));await done;return value;};
   const beforeLocal=(await read(localDB,'origins','https://site.example')).revision,beforeCookie=await read(cookieDB,'meta','revision');
   window.dropStorageReceipt=true;storage.localStorage.setItem('lost-ack','durable-once');
   window.dropCookieReceipt=128;cookies.set('lost_ack=durable_once; Path=/; SameSite=Lax');
   const afterLocal=(await read(localDB,'origins','https://site.example')).revision,afterCookie=await read(cookieDB,'meta','revision');
   const result={localDelta:afterLocal-beforeLocal,cookieDelta:afterCookie-beforeCookie,readFailures:receiptReadFailures,
     local:storage.localStorage.getItem('lost-ack'),cookie:cookies.get().includes('lost_ack=durable_once')};localDB.close();cookieDB.close();return result;
 });assert.deepEqual(report.checks.lostLocalReceipts,{localDelta:1,cookieDelta:1,readFailures:129,local:'durable-once',cookie:true});
 report.checks.cookieBurst=await page.evaluate(async()=>{
   const local={...authority,replicaId:'66666666-6666-4666-8666-666666666666'},jar=new api.SandboxCookieJar({factory:indexedDB,profileId:local.replicaId,
     localAuthority:local,browserSessionId:local.browserSessionId,forbiddenOrigins:[location.origin]}),context={requestURL:'https://cookies.example/',documentURL:'https://cookies.example/',topLevelURL:'https://cookies.example/',credentials:'include'};
   await jar.storeResponseCookies(['visible=on; Secure; Path=/; SameSite=Lax','server=hidden; HttpOnly; Secure; Path=/; SameSite=Lax'],context);
   const all=IDBObjectStore.prototype.getAll,indexed=IDBIndex.prototype.getAll;let fullJarReads=0,partitionReads=0;
   IDBObjectStore.prototype.getAll=function(...args){if(this.name==='cookies')fullJarReads++;return all.apply(this,args);};
   IDBIndex.prototype.getAll=function(...args){if(this.objectStore.name==='cookies')partitionReads++;return indexed.apply(this,args);};
   const headers=await Promise.all(Array.from({length:128},(_,n)=>jar.getRequestHeader({...context,requestURL:'https://cookies.example/asset-'+n})));
   IDBObjectStore.prototype.getAll=all;IDBIndex.prototype.getAll=indexed;
   const doc=jar.document({documentId:'cookie_delta_document_012345',documentURL:context.documentURL,topLevelURL:context.topLevelURL}),initial=await doc.snapshot();
   const first=await doc.set('draft=once; Secure; Path=/; SameSite=Lax',{binding:'document_result_identity_012345',sequence:1}),
     replay=await doc.set('draft=twice; Secure; Path=/; SameSite=Lax',{binding:'document_result_identity_012345',sequence:1}),view=await doc.view();
   doc.dispose();await jar.close();
   const resourceHeaders=await Promise.all(Array.from({length:128},(_,n)=>cookieOwner.getRequestHeader({requestURL:'https://resource.example/asset-'+n,
     documentURL:'https://site.example/',topLevelURL:'https://site.example/',credentials:'include'})));
   return{fullJarReads,partitionReads,headersCorrect:headers.every(h=>h.includes('visible=on')&&h.includes('server=hidden')),
     documentHidesHttpOnly:!initial.value.includes('server='),deltaHasOnlyAccepted:first.delta.upsert.length===1&&first.view==='',
     noDuplicateMutation:view.includes('draft=once')&&!view.includes('draft=twice')&&replay.revision===first.revision,networkBurst:resourceHeaders.length};
 });assert.deepEqual(report.checks.cookieBurst,{fullJarReads:0,partitionReads:1,headersCorrect:true,documentHidesHttpOnly:true,deltaHasOnlyAccepted:true,noDuplicateMutation:true,networkBurst:128});
 report.checks.cookiePeers=await page.evaluate(async()=>{
   const binding=await cookieOwner.bind({documentId:'cookie_peer_document_012345',website:'https://site.example/'}),
     peer=await api.createSandboxDocumentCookie({documentId:'cookie_peer_document_012345',endpoint:binding.endpoint,port:binding.port,window,localOnly:true});
   cookies.set('peer_update=visible; Secure; Path=/; SameSite=Lax');await new Promise(resolve=>setTimeout(resolve,10));
   const received=peer.get().includes('peer_update=visible');
   await cookieOwner.storeResponseCookies(['private_header=secret; Secure; Path=/; HttpOnly; SameSite=Lax'],{requestURL:'https://site.example/',documentURL:'https://site.example/',topLevelURL:'https://site.example/',credentials:'include'});
   await new Promise(resolve=>setTimeout(resolve,10));const hidesHeader=!peer.get().includes('private_header=');
   peer.dispose();binding.dispose();return{received,hidesHeader};
 });assert.deepEqual(report.checks.cookiePeers,{received:true,hidesHeader:true});
 report.checks.schemaAndAbort=await page.evaluate(async()=>{
   let opened=idb.open('schema',1);opened.onupgradeneeded=()=>{const s=opened.result.createObjectStore('items',{keyPath:'id',autoIncrement:true});s.createIndex('name','name',{unique:true});};
   let schemaDB=await request(opened),t=schemaDB.transaction('items','readwrite'),end=t.done;
   t.objectStore('items').put({id:1,name:'one'});t.objectStore('items').put({id:100,name:'high'});await end;
   t=schemaDB.transaction('items','readwrite');end=t.done;t.objectStore('items').delete(100);await end;
   t=schemaDB.transaction('items','readwrite');end=t.done;let uniqueError;
   const bad=t.objectStore('items').put({id:2,name:'one'});bad.onerror=e=>{uniqueError=bad.error.name;e.preventDefault();};
   t.objectStore('items').put({id:3,name:'three'});await end;
   t=schemaDB.transaction('items','readwrite');const aborted=t.done.catch(e=>e.name);t.objectStore('items').put({id:4,name:'rolled-back'});t.abort();await aborted;
   schemaDB.close();opened=idb.open('schema',2);opened.onupgradeneeded=()=>{const s=opened.transaction.objectStore('items');s.name='renamed';s.index('name').name='unique-name';};schemaDB=await request(opened);
   t=schemaDB.transaction('renamed','readwrite');end=t.done;const next=await request(t.objectStore('renamed').add({name:'next'}));await end;
   t=schemaDB.transaction('renamed');end=t.done;const one=await request(t.objectStore('renamed').index('unique-name').get('one')),rolledBack=await request(t.objectStore('renamed').get(4));await end;
   schemaDB.close();return{uniqueError,next,one:one.name,rolledBack:rolledBack===undefined};
 });assert.equal(report.checks.schemaAndAbort.uniqueError,'ConstraintError');assert.equal(report.checks.schemaAndAbort.next,101);assert.equal(report.checks.schemaAndAbort.rolledBack,true);
 report.checks.isolation=await page.evaluate(async()=>{
   // A crashed/rejected backup actor has no port or revoke authority for native actors.
   const backup=new Worker(URL.createObjectURL(new Blob(['throw new Error("synthetic backup crash")'],{type:'application/javascript'})));
   await new Promise(resolve=>{backup.onerror=e=>{e.preventDefault();resolve();};});backup.terminate();
   storage.localStorage.setItem('after-backup-failure','kept');
   const other=await api.createLocalStorageOwnerV2({workerURL:'/storage.js',localAuthority:{...authority,replicaId:'33333333-3333-4333-8333-333333333333'}}),
     b=await other.bind({documentId:'other_storage_document_012345',website:'https://site.example',sessionId:authority.browserSessionId}),
     f=await api.createSandboxStorageFacades({documentId:'other_storage_document_012345',endpoint:b.endpoint,port:b.port,window,localOnly:true});
   api.rebindSandboxStorageFacades(f,window);f.localStorage.setItem('draft','independent-replica');
   const isolated=storage.localStorage.getItem('draft')==='value-39';
   f.dispose();b.dispose();other.dispose();
   return {isolated,afterFailure:storage.localStorage.getItem('after-backup-failure'),localOwnerLive:storageOwner.live};
 });assert.equal(report.checks.isolation.isolated,true);assert.equal(report.checks.isolation.afterFailure,'kept');
 report.checks.dirtyOverflow=await page.evaluate(async()=>{
   const nativeDB=await request(indexedDB.open(api.profileDatabaseName('atlas.browsing.v2',authority.replicaId)));
   let tx=nativeDB.transaction('origins','readwrite');
   const done=new Promise((res,rej)=>{tx.oncomplete=res;tx.onabort=()=>rej(tx.error);});
   for(let i=0;i<30;i++) api.appendLocalDirty(tx.objectStore('origins'),{namespace:'synthetic-overflow',key:'key-'+i,operation:'upsert',estimatedNativeBytes:4}, {maxKeys:4,maxBytes:2048});
   tx.objectStore('origins').put('valid-foreground-value','overflow-foreground');await done;
   tx=nativeDB.transaction('origins');const control=await api.readLocalDirtyControl(tx.objectStore('origins'),'synthetic-overflow');
   const valid=await request(tx.objectStore('origins').get('overflow-foreground'));nativeDB.close();
   return {baselineRequired:control.baselineRequired,dirtyCount:control.dirtyCount,valid};
 });assert.equal(report.checks.dirtyOverflow.baselineRequired,true);assert.equal(report.checks.dirtyOverflow.valid,'valid-foreground-value');
 report.checks.revoke=await page.evaluate(async()=>{await control('revoke',{expectedAuthGeneration:'old_generation_0123456789'});
  let tx=db.transaction('records','readwrite'),done=tx.done;tx.objectStore('records').put({name:'still-current'},1);await done;
  await control('revoke',{expectedAuthGeneration:authority.localAuthGeneration});let error;
  try {tx=db.transaction('records','readwrite');done=tx.done;tx.objectStore('records').put({name:'revoked'},2);await done;}catch(e){error=e.name;}
  return {error};});assert.ok(report.checks.revoke.error);
 assert.deepEqual(failures,[]);report.result='PASS';console.log('LOCAL_NATIVE_V2 PASS offline localStorage/cookies/worker-IDB; no v1 journal; incremental records; generator survives deletion/clear; CAS revoke');
} catch(error) {report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}
finally {await writeFile(output,JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
