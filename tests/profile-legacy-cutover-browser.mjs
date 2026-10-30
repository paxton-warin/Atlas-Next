/** Actual Chromium old-origin export -> acknowledged fixture transport -> new
 * account-native restore. The HTTP store is deterministic test I/O, NOT Hub
 * authentication/authorization/lease qualification (covered separately). */
import Fastify from 'fastify';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hubNamespace } from '../runtime/hub-contracts.ts';

const out=resolve(process.env.ATLAS_MIGRATION_OUT||'evidence/legacy-cutover-20261021');mkdirSync(out,{recursive:true});
const sha=v=>createHash('sha256').update(v).digest('hex');
const streams=new Map(),receipts=new Map(),recoveries=new Map(),calls=[];
let commitCount=0,failedOnce=false,browser;
const app=Fastify({logger:false});
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Disposable legacy cutover qualification</title>'));
app.get('/tldts.js',(_q,r)=>r.type('application/javascript').send(readFileSync('node_modules/tldts/dist/index.esm.min.js','utf8')));
for(const dir of ['runtime','web'])app.get(`/${dir}/:file`,(q,r)=>{
 const name=q.params.file;if(!/^[a-z0-9-]+\.ts$/.test(name))return r.code(404).send();
 const file=dir==='web'?`web/src/${name}`:`runtime/${name}`;
 const source=process.env.ATLAS_LEGACY_MIGRATION_SOURCE&&name==='profile-legacy-migration.ts'?process.env.ATLAS_LEGACY_MIGRATION_SOURCE:file;
 return r.type('application/javascript').send(ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"'));
});
app.post('/fixture/:operation',async(q,r)=>{
 const op=q.params.operation,v=q.body;calls.push(op);
 if(op==='recover'){const old=recoveries.get(v.id);if(old)assert.deepEqual(old,v);recoveries.set(v.id,v);return{acknowledged:true};}
 if(op==='manifest')return{streams:[...streams.values()].map(v=>({namespace:v.namespace,revision:v.revision}))};
 if(op==='acquire')return{epoch:7};
 if(op==='release')return{ok:true};
 if(op==='receipt'){const receipt=receipts.get(v.id);if(!receipt)return r.code(404).send({code:'HUB_NOT_FOUND'});return receipt;}
 if(op==='commit'){
  assert.equal(v.baseRevision,0);assert.equal(v.epoch,7);assert.equal(v.mode,'snapshot');const n=hubNamespace(v.namespace);assert.equal(streams.has(n.key),false,'test transport refuses canonical overwrites');
  streams.set(n.key,{namespace:JSON.parse(n.key),revision:1,payload:v.payload});
  receipts.set(v.idempotencyKey,{acknowledged:true,namespace:JSON.parse(n.key),revision:1,mode:v.mode,payloadHash:sha(JSON.stringify([n.key,v.mode,v.baseRevision,sha(JSON.stringify(v.payload))]))});
  if(++commitCount===2&&!failedOnce){failedOnce=true;return r.code(503).send({code:'FIXTURE_LOST_COMMIT_ACK'});}
  return{acknowledged:true,revision:1};
 }
 return r.code(404).send();
});
const results=[];
try{
 const address=await app.listen({host:'127.0.0.1',port:0}),port=new URL(address).port;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--host-resolver-rules=MAP *.localhost 127.0.0.1']});
 const context=await browser.newContext();
 const pages=[];
 for(const [i,host]of['old-a.localhost','old-b.localhost'].entries()){
  const page=await context.newPage();await page.goto(`http://${host}:${port}/`);pages.push(page);
  await page.evaluate(async i=>{
   const open=(name,version,setup)=>new Promise((resolve,reject)=>{const q=indexedDB.open(name,version);q.onupgradeneeded=()=>setup(q.result);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
   const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
   localStorage.setItem('orteil.dashnet.org@CookieClickerGame','old-save-'+i);
   localStorage.setItem('atlas.history',JSON.stringify([{url:'https://orteil.dashnet.org/cookieclicker/',title:'Cookie Clicker',time:1792530000000}]));
   localStorage.setItem('atlas.admin.token','native-secret-must-not-leave');
   let db=await open('https://orteil.dashnet.org@native-save',3,d=>{const s=d.createObjectStore('saves',{keyPath:'id',autoIncrement:true});s.createIndex('label','label',{unique:true})});
   let tx=db.transaction('saves','readwrite');tx.objectStore('saves').add({label:'bakery',bytes:new Uint8Array([i,4,8]),blob:new Blob(['binary-'+i]),date:new Date('2026-10-21T00:00:00Z')});await done(tx);db.close();
   db=await open('__runtimekit_controller',1,d=>d.createObjectStore('state'));tx=db.transaction('state','readwrite');
   tx.objectStore('state').put({updatedAt:1792530000000,cookies:JSON.stringify({legacy:{name:'bakery',value:'cookie-'+i,domain:'.dashnet.org',hostOnly:false,path:'/',httpOnly:true,secure:true,sameSite:'lax'}})},'cookies');await done(tx);db.close();
  },i);
 }
 const migrate=async(page,ownsLegacy=true)=>page.evaluate(async ownsLegacy=>{
  const {migrateLegacyOrigin,legacyWebsiteOriginHints}=await import('/web/profile-legacy-migration.ts'),store=await import('/runtime/profile-store.ts'),codec=await import('/runtime/hub-contracts.ts');
  const rpc=async(op,value={})=>{const r=await fetch('/fixture/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),v=await r.json();if(!r.ok)throw Object.assign(Error(v.code),{status:r.status,code:v.code});return v;};
  let exports=0;
  const result=await migrateLegacyOrigin({ownsLegacy,profileId:'11111111-1111-4111-8111-111111111111',sourceOrigin:location.origin,storage:localStorage,check(){},blockedGroups:new Set(),
   entries:async()=>{exports++;const values={'atlas.history':localStorage.getItem('atlas.history')},data=await store.exportLegacyProfileData(indexedDB,legacyWebsiteOriginHints(values));return[...data.snapshots,...data.cookieStores.map(source=>({namespace:{kind:'atlas'},payload:{format:'atlas-legacy-cookie-store-v1',database:source.database,namespace:source.namespace,snapshot:source.payload}}))];},
   wire:codec.encodePortableValue,hash:async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join(''),
   recover:v=>rpc('recover',v),manifest:()=>rpc('manifest'),acquire:n=>rpc('acquire',n),commit:v=>rpc('commit',v),release:(namespace,epoch)=>rpc('release',{namespace,epoch}),receipt:id=>rpc('receipt',{id}),
  });
  return{...result,exports,sourceSave:localStorage.getItem('orteil.dashnet.org@CookieClickerGame')};
 },ownsLegacy);
 await assert.rejects(migrate(pages[0]),/FIXTURE_LOST_COMMIT_ACK/);assert.equal(streams.size,2);assert.equal(recoveries.size,4);
 const resumed=await migrate(pages[0]);assert.deepEqual(resumed.adoptedGroups,['dashnet.org']);assert.equal(resumed.newBackups,0);assert.equal(streams.size,3);assert.equal(commitCount,3);results.push({state:'interrupted-first-origin-resumed',...resumed});
 const second=await migrate(pages[1]);assert.deepEqual(second.preservedGroups,['dashnet.org']);assert.equal(streams.size,3);assert.equal(commitCount,3);assert.equal(recoveries.size,8);results.push({state:'second-divergent-origin-preserved',...second});
 const before=calls.length,foreign=await migrate(pages[1],false);assert.equal(foreign.exports,0);assert.equal(calls.length,before);results.push({state:'nonowner-did-not-inspect-or-upload',exports:foreign.exports});
 assert.equal(JSON.stringify([...recoveries.values()]).includes('native-secret-must-not-leave'),false);
 const replacement=await context.newPage();await replacement.goto(`http://new.localhost:${port}/`);
 const restored=await replacement.evaluate(async wireEntries=>{
  const store=await import('/runtime/profile-store.ts'),codec=await import('/runtime/hub-contracts.ts'),catalog=await import('/runtime/profile-idb-catalog.ts');
  const id='11111111-1111-4111-8111-111111111111';
  for(const entry of wireEntries){const tuple=entry.namespace,n=tuple[0]==='cookies'?{kind:'cookies',origin:'https://'+tuple[1]}:{kind:tuple[0],origin:tuple[1],...(tuple[0]==='idb'?{name:tuple[2]}:{})};await store.restoreProfileStream(indexedDB,id,n,codec.decodePortableValue(entry.payload),[],{revision:entry.revision,epoch:1});}
  const snapshots=await store.exportProfileSnapshots(indexedDB,id),local=snapshots.find(s=>s.namespace.kind==='local'),idb=snapshots.find(s=>s.namespace.kind==='idb'),cookie=snapshots.find(s=>s.namespace.kind==='cookies');
  const record=idb.payload.stores[0].records[0].value;
  if(local.payload.entries[0][1]!=='old-save-0'||idb.payload.version!==3||idb.payload.stores[0].indexes[0].name!=='label'||idb.payload.stores[0].generator.next!==2||record.bytes[0]!==0||!(record.bytes instanceof Uint8Array)||!(record.date instanceof Date)||await record.blob.text()!=='binary-0'||cookie.payload.cookies[0].value!=='cookie-0'||!cookie.payload.cookies[0].httpOnly)throw Error('NEW_ORIGIN_RESTORE_MISMATCH');
  const other=await store.exportProfileSnapshots(indexedDB,'22222222-2222-4222-8222-222222222222');if(other.length)throw Error('OTHER_ACCOUNT_INHERITED_SAVE');
  const rows=await catalog.listProfileIDBDatabases(indexedDB,id,'https://orteil.dashnet.org');const physical=rows.find(r=>r.name==='native-save').physical;
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(physical);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)}),tx=db.transaction('saves','readwrite'),q=tx.objectStore('saves').add({label:'next'});
  const next=await new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();if(next!==2)throw Error('NEW_ORIGIN_GENERATOR_NOT_RESTORED');
  return{result:'PASS',canonicalNamespaces:snapshots.length,localSave:'old-save-0',idbVersion:3,nextGeneratedKey:next,binaryDateBlob:true,cookieHttpOnly:true,otherAccountNamespaces:other.length};
 },[...streams.values()]);results.push({state:'new-origin-native-restore',...restored});
 for(const [i,page]of pages.entries())assert.equal(await page.evaluate(()=>localStorage.getItem('orteil.dashnet.org@CookieClickerGame')),'old-save-'+i);
 // Recovery contents include both divergent source versions, not only metadata.
 const backupLocals=[...recoveries.values()].filter(v=>v.namespace.kind==='local');assert.equal(backupLocals.length,2);
 writeFileSync(resolve(out,'LEGACY_CUTOVER_BROWSER.json'),JSON.stringify({result:'PASS',transport:'deterministic fixture, not production Hub',browser:browser.version(),oldOrigins:2,newOrigins:1,recoveries:recoveries.size,canonicalStreams:streams.size,commits:commitCount,sourceStoresRetained:true,results},null,2)+'\n');
 console.log('LEGACY_CUTOVER_BROWSER=PASS; OLD_ORIGINS=2; NEW_ORIGINS=1; INTERRUPTED_RECEIPT_RESUME=PASS; DIVERGENT_SAVE_RECOVERY=PASS; NATIVE_LOCAL_IDB_COOKIE_RESTORE=PASS; BINARY_SCHEMA_GENERATOR=PASS; ACCOUNT_NAMESPACE_ISOLATION=PASS; SOURCE_RETAINED=PASS; HUB_TRANSPORT=FIXTURE');
}catch(error){writeFileSync(resolve(out,'LEGACY_CUTOVER_BROWSER.json'),JSON.stringify({result:'FAIL',results,error:error.message},null,2)+'\n');console.error(error.stack);process.exitCode=1;}
finally{await browser?.close();await app.close();}
