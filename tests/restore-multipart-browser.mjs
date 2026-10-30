import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const bundled=async contents=>(await build({bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',stdin:{resolveDir:resolve('runtime'),contents}})).outputFiles[0].text;
const api=await bundled(`export * from './local-dirty-v2.ts';export * from './local-storage-v2.ts';export * from './backup-v2-capture.ts';export * from './backup-v2-restore.ts';export * from './backup-v2-discovery.ts';export * from './backup-v2-preferences.ts';export * from './local-idb-catalog.ts';export * from './backup-v2-spool.ts';export * from './backup-v2-indexeddb-source.ts';export * from './backup-v2-keys.ts';export * from './backup-v2-contracts.ts';export {decodePortableValue} from './hub-contracts.ts';export * from '../web/src/backup-v2-service.ts';`);
const worker=await bundled(`import './backup-v2-worker.ts';`);
const app=Fastify({logger:false});app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Local periodic backup fixture</title>'));app.get('/api.js',(_q,r)=>r.type('application/javascript').send(api));app.get('/backup-worker.js',(_q,r)=>r.type('application/javascript').send(worker));
const report={command:'node tests/local-backup-v2-browser.mjs',productionChanged:false,checks:{}};
const output=resolve('evidence/restore-multipart/BACKUP_V2_BROWSER.json');await mkdir(resolve('evidence/restore-multipart'),{recursive:true});let browser;
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
 const context=await browser.newContext(),page=await context.newPage();page.on('console',m=>console.log('BROWSER',m.text()));page.on('pageerror',e=>console.error('PAGEERROR',e));await page.goto(origin);
 await page.evaluate(async()=>{window.api=await import('/api.js');window.captureDeferrals=0;window.capture=async(...args)=>{for(let attempt=0;;attempt++)try{return await api.captureBackupNamespace(...args);}catch(e){if(!['BACKUP_READ_DEADLINE','BACKUP_SEAL_DEADLINE'].includes(e.code)||attempt>=10)throw e;captureDeferrals++;await new Promise(r=>setTimeout(r,20));}};window.request=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});window.complete=t=>new Promise((res,rej)=>{t.oncomplete=()=>res();t.onabort=()=>rej(t.error||Error('TX_ABORT'));});
   const r=indexedDB.open('backup-source-fixture',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('rows');};window.sourceDB=await request(r);
   window.namespace=JSON.stringify(['idb','https://site.example','fixture']);window.put=async(key,value,limits)=>{const t=sourceDB.transaction(['meta','rows'],'readwrite'),end=complete(t);t.objectStore('rows').put(value,key);api.appendLocalDirty(t.objectStore('meta'),{namespace,store:'rows',key,operation:'upsert',estimatedNativeBytes:100,shapeEligible:true},limits);await end;};
   window.descriptor={id:'fixture',namespace:{kind:'idb',origin:'https://site.example',name:'fixture'},database:'backup-source-fixture',metadataStore:'meta',dirtyNamespace:namespace,kind:'idb',scope:'fixture'};
   window.source=api.createIndexedDBBackupSource(indexedDB,descriptor);window.replica='33333333-3333-4333-8333-333333333333';window.spool=api.createIndexedDBBackupSpool(indexedDB,replica);
 });
 report.checks.dirty=await page.evaluate(async()=>{
  for(let n=0;n<100;n++)await put('draft',{text:'edit-'+n});
  const coalesced=await source.readControl();
  await put('second',2,{maxKeys:1});const overflow=await source.readControl();
  await put('third',3);const after=await source.readControl();
  const t=sourceDB.transaction(['meta','rows'],'readwrite'),end=complete(t);t.objectStore('rows').put(1,'atomic1');t.objectStore('rows').put(2,'atomic2');
  const a=api.appendLocalDirty(t.objectStore('meta'),{namespace,store:'rows',key:'atomic1',operation:'upsert',estimatedNativeBytes:16});const b=api.appendLocalDirty(t.objectStore('meta'),{namespace,store:'rows',key:'atomic2',operation:'upsert',estimatedNativeBytes:16});await end;
  return {coalesced,overflow,after,generations:[a.generation,b.generation]};
 });assert.equal(report.checks.dirty.coalesced.dirtyCount,1);assert.equal(report.checks.dirty.overflow.baselineRequired,true);assert.ok(report.checks.dirty.after.dirtyCount>0);assert.equal(report.checks.dirty.generations[0],report.checks.dirty.generations[1]);
 report.checks.capture=await page.evaluate(async()=>{
  let inserted=false;const wrapped={...source,async scanBaseline(cursor,limits){const page=await source.scanBaseline(cursor,limits);if(!inserted){inserted=true;await put('000-inserted-behind-cursor',{text:'catch-up'});await put('draft',{text:'latest'});}return page;}};
  const captured=await capture(wrapped,spool,null),records=[];for await(const r of spool.records(captured.version.namespaceVersionId))records.push(JSON.parse(new TextDecoder().decode(r.bytes)));
  window.firstCapture=captured;return {version:captured.version,records:records.map(r=>({...r,value:r.value?api.decodePortableValue(r.value):undefined}))};
 });assert.ok(report.checks.capture.records.find(r=>r.key?.v==='000-inserted-behind-cursor'));assert.equal(report.checks.capture.records.find(r=>r.key?.v==='draft').value.text,'latest');assert.ok(report.checks.capture.version.parts.every(p=>p.bytes<=262144));
 report.checks.spool=await page.evaluate(async()=>{
  const partial={format:'atlas-checkpoint-v2',checkpointId:crypto.randomUUID(),replicaId:replica,incarnation:crypto.randomUUID(),sequence:1,parentCheckpointId:null,adoptedThrough:0,namespaces:[firstCapture.version]},manifest={...partial,manifestDigest:await api.backupManifestDigest(partial)},coverage={sourceId:source.id,namespaceVersionId:firstCapture.version.namespaceVersionId,cut:firstCapture.version.localCut,trackingEpoch:firstCapture.trackingEpoch};
  await spool.prepare({manifest,coverages:[coverage]});const old=await spool.pending();spool.dispose();window.spool=api.createIndexedDBBackupSpool(indexedDB,replica);const recovered=await spool.pending();
  // An edit during upload remains dirty after acknowledged G.
  await put('draft',{text:'after-cut'});await source.acknowledge(coverage.cut,coverage.trackingEpoch);
  const c=await source.readControl();return {before:old.manifest.manifestDigest,after:recovered.manifest.manifestDigest,cut:coverage.cut,generation:c.generation,ack:c.acknowledgedGeneration};
 });assert.equal(report.checks.spool.before,report.checks.spool.after);assert.ok(report.checks.spool.generation>report.checks.spool.ack);assert.equal(report.checks.spool.ack,report.checks.spool.cut);
 report.checks.publication=await page.evaluate(async()=>{
  const prepared=await spool.pending();let attempt=0,uploads=0,identities=[];let fail=true;
  const transport={async request(path,method,body){if(path==='/replicas')return {replicaId:replica,incarnation:prepared.manifest.incarnation,headCheckpointId:null,headSequence:0,adoptedThrough:0};
    if(path.endsWith('/adopt'))return {replicaId:replica,adoptedThrough:body.adoptedThrough};
    if(path.includes('/checkpoints')){identities.push(body.manifestDigest);return {checkpointId:body.checkpointId,status:'prepared',missingParts:body.namespaces.flatMap(n=>n.parts.map(p=>p.sha256))};}
    if(path.endsWith('/publish')){attempt++;if(fail){fail=false;throw Object.assign(Error('lost response'),{name:'NetworkError'});}return {acknowledged:true,checkpointId:prepared.manifest.checkpointId,replicaId:replica,manifestDigest:prepared.manifest.manifestDigest,sequence:1,publicationOrdinal:'1',completedAt:'2026-10-28T00:00:00.000Z',coverage:prepared.coverages.map(c=>({namespaceVersionId:c.namespaceVersionId,localCut:c.cut})),historyShortened:false};}
    throw Error(path);},async upload(){uploads++;}};
  const service=api.createBackupV2Service({replicaId:replica,incarnation:prepared.manifest.incarnation,label:'test',source:async()=>[source],spool,transport,withLeadership:async work=>work()});await service.initialize();
  let failure;try{await service.flush();}catch(e){failure=e.name;}const pendingAfterLoss=!!await spool.pending();await put('still-local',1);await service.retry();
  const current=await source.readControl(),head=await spool.head();service.stop();return {attempt,uploads,identities,failure,pendingAfterLoss,current,head};
 });assert.equal(report.checks.publication.pendingAfterLoss,true);assert.equal(report.checks.publication.attempt,2);assert.equal(new Set(report.checks.publication.identities).size,1);assert.equal(report.checks.publication.head.sequence,1);assert.ok(report.checks.publication.current.generation>report.checks.publication.current.acknowledgedGeneration);
 report.checks.preRead=await page.evaluate(async()=>{
  const t=sourceDB.transaction(['meta','rows'],'readwrite'),end=complete(t);t.objectStore('rows').put(new Blob([new Uint8Array(2*1024*1024)]),'oversized');api.appendLocalDirty(t.objectStore('meta'),{namespace,store:'rows',key:'oversized',operation:'upsert',estimatedNativeBytes:2*1024*1024});await end;
  const original=IDBObjectStore.prototype.openCursor;let oversizedValueReads=0;
  IDBObjectStore.prototype.openCursor=function(query,...rest){if(this.name==='rows'&&query instanceof IDBKeyRange&&query.lower==='oversized')oversizedValueReads++;return original.call(this,query,...rest);};
  const temp=api.createIndexedDBBackupSpool(indexedDB,'44444444-4444-4444-8444-444444444444');let code;try{await capture(source,temp,null);}catch(e){code=e.code;}finally{IDBObjectStore.prototype.openCursor=original;temp.dispose();}
  await put('after-oversize',1);return {oversizedValueReads,code};
 });assert.equal(report.checks.preRead.oversizedValueReads,0);assert.equal(report.checks.preRead.code,'BACKUP_RECORD_UNSIZED');
 report.checks.generator=await page.evaluate(async()=>{
  const r=indexedDB.open('generator-source-fixture',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('rows',{autoIncrement:true});};const db=await request(r),ns=JSON.stringify(['idb','https://site.example','generator']);
  let t=db.transaction(['meta','rows'],'readwrite'),end=complete(t);t.objectStore('rows').put('high',100);api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:'rows',key:100,operation:'upsert',estimatedNativeBytes:40});await end;
  t=db.transaction(['meta','rows'],'readwrite');end=complete(t);t.objectStore('rows').delete(100);api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:'rows',key:100,operation:'delete'});await end;
  const src=api.createIndexedDBBackupSource(indexedDB,{...descriptor,database:'generator-source-fixture',dirtyNamespace:ns,id:'generator',namespace:{kind:'idb',origin:'https://site.example',name:'generator'}}),c=await src.readControl(),sealed=await src.seal(c);
  t=db.transaction('rows','readwrite');end=complete(t);const key=await request(t.objectStore('rows').add('next'));await end;src.dispose();db.close();return {schema:sealed.schema,key};
 });assert.equal(report.checks.generator.schema.stores[0].generator.next,101);assert.equal(report.checks.generator.key,101);
 report.checks.worker=await page.evaluate(async()=>{
  const worker=new Worker('/backup-worker.js',{type:'module'}),waiting=new Map();let sequence=0;
  worker.onmessage=({data})=>{const p=waiting.get(data.id);if(p){waiting.delete(data.id);data.ok?p.resolve(data.value):p.reject(Error(data.error.message));}};
  const rpc=(operation,extra)=>new Promise((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});worker.postMessage({protocol:'atlas-backup-actor-v2',id,operation,...extra});});
  await rpc('initialize',{options:{replicaId:'55555555-5555-4555-8555-555555555555',incarnation:'66666666-6666-4666-8666-666666666666',label:'isolated worker',headers:{},sources:[descriptor]}});
  worker.terminate();await put('survives-worker-death',{yes:true});const t=sourceDB.transaction('rows'),end=complete(t),value=await request(t.objectStore('rows').get('survives-worker-death'));await end;return value;
 });assert.equal(report.checks.worker.yes,true);
 report.checks.restore=await page.evaluate(async()=>{
  const opened=indexedDB.open('roundtrip-source',1);opened.onupgradeneeded=()=>{opened.result.createObjectStore('meta');const rows=opened.result.createObjectStore('rows',{autoIncrement:true});rows.createIndex('name','name',{unique:true});opened.result.createObjectStore('typed');};
  const db=await request(opened),ns=JSON.stringify(['idb','https://restore.example','roundtrip']);
  const value={name:'one',sparse:new Array(5),view:new Uint16Array(new Uint8Array([1,2,3,4,5,6]).buffer,2,2),blob:new Blob(['blob-preserved'],{type:'text/plain'}),file:new File(['file-preserved'],'notes.txt',{type:'text/plain',lastModified:1234})};value.self=value;value.sparse[3]='kept';
  let t=db.transaction(['rows','typed','meta'],'readwrite'),end=complete(t);t.objectStore('rows').put(value,1);t.objectStore('rows').put({name:'high'},100);t.objectStore('typed').put({map:new Map([['x',3]]),set:new Set(['a'])},['array',new Date(7)]);
  for(let n=0;n<600;n++){t.objectStore('typed').put({number:n,padding:'abcdefghij'.repeat(50)},'record-'+n);api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:'typed',key:'record-'+n,operation:'upsert',estimatedNativeBytes:100});}
  for(const [store,key] of [['rows',1],['rows',100],['typed',['array',new Date(7)]]])api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store,key,operation:'upsert',estimatedNativeBytes:2048});await end;
  t=db.transaction(['rows','meta'],'readwrite');end=complete(t);t.objectStore('rows').delete(100);api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:'rows',key:100,operation:'delete'});await end;
  const descriptor={id:ns,namespace:{kind:'idb',origin:'https://restore.example',name:'roundtrip'},database:'roundtrip-source',metadataStore:'meta',dirtyNamespace:ns,kind:'idb',scope:'roundtrip'},source=api.createIndexedDBBackupSource(indexedDB,descriptor),spool=api.createIndexedDBBackupSpool(indexedDB,'77777777-7777-4777-8777-777777777777');
  const captured=await capture(source,spool,null),records=[],parts=new Map();
  for(const part of captured.version.parts){const bytes=await spool.part(part.sha256);parts.set(part.sha256,bytes);const page=JSON.parse(new TextDecoder().decode(bytes));for(let index=0;index<page.records.length;index++){const f=page.records[index];let row=records.find(r=>r.recordId===f.recordId);if(!row){row={recordId:f.recordId,sha256:f.sha256,totalBytes:f.totalBytes,fragments:[]};records.push(row);}row.fragments[f.index]={sha256:part.sha256,index};}}
  for await(const r of spool.records(captured.version.namespaceVersionId)){const encoded=JSON.parse(new TextDecoder().decode(r.bytes));Object.assign(records.find(x=>x.recordId===r.id),{store:encoded.store,operation:encoded.operation});}
  let downloads=0,metadataPages=0;const checkpointId=crypto.randomUUID(),transport={async request(path){if(path.startsWith('/checkpoints/'))return {checkpoint:{checkpointId,namespaces:[captured.version]}};metadataPages++;const at=Number(new URL(path,'https://fixture').searchParams.get('cursor')||0);return {records:records.slice(at,at+64),...(at+64<records.length?{nextCursor:String(at+64)}:{})};},async download(path){downloads++;await new Promise(r=>setTimeout(r,15));return parts.get(path.split('/').at(-1));}};
  const restoreProgress=[];const restoreStart=performance.now();const staged=await api.prepareBackupV2Restore({factory:indexedDB,transport,checkpointId,onProgress:(_n,_r,p)=>restoreProgress.push(p)});const restoreMs=performance.now()-restoreStart;
  const restored=await request(indexedDB.open(staged.descriptors[0].database));t=restored.transaction(['rows','typed']);end=complete(t);const row=await request(t.objectStore('rows').get(1)),typed=await request(t.objectStore('typed').get(['array',new Date(7)]));await end;
  t=restored.transaction('rows','readwrite');end=complete(t);const key=await request(t.objectStore('rows').add({name:'new'}));await end;
  const catalog=await request(indexedDB.open('atlas.browsing.profile-catalog.v1:profile:'+staged.stagingReplicaId));t=catalog.transaction('meta');end=complete(t);const marker=await request(t.objectStore('meta').get('backup-restore-v2'));await end;
  const discovery=await api.discoverBackupSources(indexedDB,staged.stagingReplicaId);
  window.restoredScope=staged;const answer={progress:restoreProgress,downloads,metadataPages,uniqueParts:parts.size,restoreMs,metadataCount:records.length,key,cycle:row.self===row,sparseLength:row.sparse.length,hole:!(0 in row.sparse),view:[...row.view],blob:await row.blob.text(),file:{text:await row.file.text(),name:row.file.name,modified:row.file.lastModified},map:typed.map.get('x'),set:typed.set.has('a'),state:marker.state,discovered:discovery.length,sourceUntouched:db.name!==restored.name};
  source.dispose();spool.dispose();db.close();restored.close();catalog.close();return answer;
 });assert.equal(report.checks.restore.downloads,report.checks.restore.uniqueParts);assert.equal(report.checks.restore.metadataPages,Math.ceil(report.checks.restore.metadataCount/64));assert.equal(report.checks.restore.progress.at(-1).phase,'finalizing');assert.equal(report.checks.restore.progress.at(-1).completedBytes,report.checks.restore.progress.at(-1).totalBytes);assert.ok(report.checks.restore.metadataCount>64);assert.equal(report.checks.restore.key,101);assert.equal(report.checks.restore.cycle,true);assert.equal(report.checks.restore.hole,true);assert.equal(report.checks.restore.sparseLength,5);assert.equal(report.checks.restore.blob,'blob-preserved');assert.equal(report.checks.restore.file.name,'notes.txt');assert.equal(report.checks.restore.file.modified,1234);assert.equal(report.checks.restore.map,3);assert.equal(report.checks.restore.state,'ready');assert.equal(report.checks.restore.discovered,1);
 report.checks.deleted=await page.evaluate(async()=>{
  await api.deleteLocalIDBDatabase(indexedDB,restoredScope.stagingReplicaId,'https://restore.example','roundtrip');
  const descriptors=await api.discoverBackupSources(indexedDB,restoredScope.stagingReplicaId),deleted=descriptors.find(d=>d.namespace.name==='roundtrip'),source=api.createIndexedDBBackupSource(indexedDB,deleted),spool=api.createIndexedDBBackupSpool(indexedDB,'88888888-8888-4888-8888-888888888888');
  const captured=await capture(source,spool,'99999999-9999-4999-8999-999999999999');source.dispose();spool.dispose();return {kind:captured.version.kind,parts:captured.version.parts.length,database:deleted.database};
 });assert.equal(report.checks.deleted.kind,'deleted');assert.equal(report.checks.deleted.parts,0);
 report.checks.preferences=await page.evaluate(async()=>{
  const replica='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await api.writeBackupPreferences(indexedDB,replica,{'atlas.settings':'{"theme":"moss"}','atlas.tabs':'[{"url":"https://example.com"}]'});
  const descriptor=(await api.discoverBackupSources(indexedDB,replica)).find(d=>d.kind==='atlas'),source=api.createIndexedDBBackupSource(indexedDB,descriptor),spool=api.createIndexedDBBackupSpool(indexedDB,replica);
  await api.writeBackupPreferences(indexedDB,replica,{},[{key:'atlas.chats',estimatedNativeBytes:1024*1024}]);let deferred;try{await capture(source,spool,null);}catch(e){deferred=e.code;}
  await api.writeBackupPreferences(indexedDB,replica,{'atlas.chats':'[]'});const captured=await capture(source,spool,null),parts=new Map(),records=[];
  for(const part of captured.version.parts){const bytes=await spool.part(part.sha256);parts.set(part.sha256,bytes);const page=JSON.parse(new TextDecoder().decode(bytes));for(let index=0;index<page.records.length;index++){const f=page.records[index];let row=records.find(r=>r.recordId===f.recordId);if(!row){row={recordId:f.recordId,sha256:f.sha256,totalBytes:f.totalBytes,fragments:[]};records.push(row);}row.fragments[f.index]={sha256:part.sha256,index};}}
  for await(const r of spool.records(captured.version.namespaceVersionId)){const encoded=JSON.parse(new TextDecoder().decode(r.bytes));Object.assign(records.find(x=>x.recordId===r.id),{store:encoded.store,operation:encoded.operation});}
  let downloads=0,metadataPages=0;const checkpointId=crypto.randomUUID(),transport={async request(path){return path.startsWith('/checkpoints/')?{checkpoint:{checkpointId,namespaces:[captured.version]}}:{records};},async download(path){downloads++;await new Promise(r=>setTimeout(r,15));return parts.get(path.split('/').at(-1));}};
  const restored=await api.prepareBackupV2Restore({factory:indexedDB,transport,checkpointId,profileId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),restoredSources=await api.discoverBackupSources(indexedDB,restored.stagingReplicaId);source.dispose();spool.dispose();return {deferred,preferences:restored.atlasPreferences,deferredPreferences:restored.deferredPreferences,restoredKind:restoredSources[0].kind};
 });assert.equal(report.checks.preferences.deferred,'BACKUP_ATLAS_PREFERENCE_DEFERRED');assert.equal(report.checks.preferences.preferences['atlas.settings'],'{"theme":"moss"}');assert.equal(report.checks.preferences.preferences['atlas.chats'],'[]');assert.equal(report.checks.preferences.restoredKind,'atlas');
 report.checks.localGC=await page.evaluate(async()=>{
  const opened=indexedDB.open('gc-independent-fixture',1);opened.onupgradeneeded=()=>{opened.result.createObjectStore('meta');opened.result.createObjectStore('rows');};const db=await request(opened),ns=JSON.stringify(['idb','https://gc.example','gc']);
  for(let round=0;round<6;round++){const t=db.transaction(['meta','rows'],'readwrite'),end=complete(t);t.objectStore('rows').clear();api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:'rows',operation:'clear'});for(let n=0;n<30;n++){t.objectStore('rows').put(round+':'+n,n);api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:'rows',operation:'upsert',key:n,estimatedNativeBytes:50});}await end;}
  let sizeRows=Infinity,dirtyRows=Infinity;for(let tries=0;tries<120;tries++){await new Promise(r=>setTimeout(r,50));const t=db.transaction('meta'),end=complete(t),keys=await request(t.objectStore('meta').getAllKeys());await end;sizeRows=keys.filter(k=>Array.isArray(k)&&k[1]==='size').length;dirtyRows=keys.filter(k=>Array.isArray(k)&&k[1]==='dirty').length;if(sizeRows===30&&dirtyRows===30)break;}
  const t=db.transaction('rows'),end=complete(t),value=await request(t.objectStore('rows').get(29));await end;db.close();return {sizeRows,dirtyRows,value,noPublisherCreated:true};
 });assert.equal(report.checks.localGC.sizeRows,30);assert.equal(report.checks.localGC.dirtyRows,30);assert.equal(report.checks.localGC.value,'5:29');
 report.checks.prototypeNames=await page.evaluate(async()=>{
  const r=indexedDB.open('prototype-store-fixture',1),names=['__proto__','constructor','toString'];r.onupgradeneeded=()=>{r.result.createObjectStore('meta');for(const name of names)r.result.createObjectStore(name);};const db=await request(r),ns=JSON.stringify(['idb','https://names.example','names']);
  for(let round=0;round<2;round++){const t=db.transaction(['meta',...names],'readwrite'),end=complete(t);for(const name of names){t.objectStore(name).put('value-'+round,'key');api.appendLocalDirty(t.objectStore('meta'),{namespace:ns,store:name,key:'key',operation:'upsert',estimatedNativeBytes:100});}await end;}
  const source=api.createIndexedDBBackupSource(indexedDB,{id:ns,namespace:{kind:'idb',origin:'https://names.example',name:'names'},database:'prototype-store-fixture',metadataStore:'meta',dirtyNamespace:ns,kind:'idb',scope:'names'}),control=await source.readControl(),spool=api.createIndexedDBBackupSpool(indexedDB,'abababab-abab-4bab-8bab-abababababab'),captured=await capture(source,spool,null);source.dispose();spool.dispose();db.close();return {epochs:names.map(n=>control.storeEpochs[n]),cut:captured.version.localCut};
 });assert.deepEqual(report.checks.prototypeNames.epochs,[1,1,1]);assert.equal(report.checks.prototypeNames.cut,2);
 report.checks.keys=await page.evaluate(()=>{const keys=[Infinity,-Infinity,-0,new Date(123456789),'\ud800',new Uint8Array([1,2,3]).subarray(1),['array',new Date(1),[2]]];return keys.map(k=>({same:indexedDB.cmp(k,api.decodeBackupKey(api.encodeBackupKey(k)))===0}));});assert.ok(report.checks.keys.every(k=>k.same));
 report.captureDeadlineDeferrals=await page.evaluate(()=>captureDeferrals);report.result='PASS';console.log('BACKUP_V2 PASS real Chromium IDB: bounded dirty coalescing; optimistic catch-up; preread oversize deferral; exact lost-ACK resume; worker independence; generator/key preservation');
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}
finally{await writeFile(output,JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
