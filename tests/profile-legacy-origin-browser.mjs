/** Actual native pre-Hub HOST@key / ORIGIN@IDB / controller-cookie storage.
 * Disposable browser and ephemeral local fixture only; no Lab or user profiles. */
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import ts from 'typescript';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const out=resolve(process.env.ATLAS_MIGRATION_OUT||'evidence/local-release-readiness-20261021/migration');mkdirSync(out,{recursive:true});
const app=Fastify({logger:false});let browser;
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Disposable pre-Hub storage</title>'));
app.get('/tldts.js',(_q,r)=>r.type('application/javascript').send(readFileSync('node_modules/tldts/dist/index.esm.min.js','utf8')));
app.get('/:file',(q,r)=>{const name=q.params.file;if(!/^[a-z0-9-]+\.ts$/.test(name))return r.code(404).send();const path=name==='profile-store.ts'&&process.env.ATLAS_PROFILE_STORE_SOURCE?process.env.ATLAS_PROFILE_STORE_SOURCE:'runtime/'+name;return r.type('application/javascript').send(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"'));});
const results=[];
try{
 const address=await app.listen({host:'127.0.0.1',port:0}),port=new URL(address).port;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext();
 for(const [i,host]of['127.0.0.1','localhost'].entries()){
  const p=await context.newPage();await p.goto(`http://${host}:${port}/`);
  const result=await p.evaluate(async({i})=>{
   const store=await import('/profile-store.ts'),codec=await import('/hub-contracts.ts');
   const open=(name,version,setup)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);r.onupgradeneeded=()=>setup(r.result);r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result)});
   const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
   // These are the exact namespace and serialized formats in the pinned normal
   // Scramjet source; do not replace with account-profile v2 fixtures.
   const save='synthetic-old-origin-'+i;
   localStorage.setItem('orteil.dashnet.org@CookieClickerGame',save);
   localStorage.setItem('both.example@save','ambiguous-'+i);
   localStorage.setItem('unknown.example@save','unknown-'+i);
   localStorage.setItem('https://exact.example@save','explicit-'+i);
   localStorage.setItem('atlas.admin.synthetic-token','must-not-export-native-admin');
   let db=await open('https://orteil.dashnet.org@legacy-game-db',2,d=>{const s=d.createObjectStore('records',{keyPath:'id',autoIncrement:true});s.createIndex('tag','tag',{unique:true})});
   let tx=db.transaction('records','readwrite');tx.objectStore('records').add({tag:'one',bytes:new Uint8Array([i,2,3]),date:new Date('2026-10-21T00:00:00Z'),blob:new Blob(['old-binary-'+i])});await done(tx);db.close();
   db=await open('__scramjet_controller',1,d=>d.createObjectStore('state'));tx=db.transaction('state','readwrite');
   tx.objectStore('state').put({updatedAt:Date.now()-100,cookies:JSON.stringify({'.dashnet.org@/@legacy':{name:'legacy',value:'cookie-'+i,domain:'.dashnet.org',hostOnly:false,path:'/',secure:true,httpOnly:true,sameSite:'lax'}})},'cookies');await done(tx);db.close();
   // The currently pinned production fork uses this renamed jar, not the old
   // __scramjet_controller predecessor. Both versions must remain recoverable.
   db=await open('__runtimekit_controller',1,d=>d.createObjectStore('state'));tx=db.transaction('state','readwrite');
   tx.objectStore('state').put({updatedAt:Date.now()-50,cookies:JSON.stringify({'.dashnet.org@/@legacy':{name:'legacy',value:'fork-cookie-'+i,domain:'.dashnet.org',hostOnly:false,path:'/',secure:true,httpOnly:true,sameSite:'lax'},native:{name:'native-control',value:'must-not-export-native-controller',domain:location.hostname,hostOnly:true,path:'/',secure:false}})},'cookies');await done(tx);db.close();
   db=await open('unknown-native-database',1,d=>d.createObjectStore('secrets'));tx=db.transaction('secrets','readwrite');tx.objectStore('secrets').put('must-not-export-native-db','token');await done(tx);db.close();
   const hints=['https://orteil.dashnet.org','http://both.example','https://both.example'];
   const data=store.exportLegacyProfileData?await store.exportLegacyProfileData(indexedDB,hints):{snapshots:await store.exportProfileSnapshots(indexedDB,null),hostStorage:[]};
   const native=data.snapshots.find(s=>s.namespace.kind==='local'&&s.namespace.origin==='https://orteil.dashnet.org');
   const nativeValue=native?.payload.entries.find(([k])=>k==='CookieClickerGame')?.[1];
   if(nativeValue!==save)throw Error('REAL_PRE_HUB_HOST_STORAGE_NOT_IMPORTED');
   const idb=data.snapshots.find(s=>s.namespace.kind==='idb'&&s.namespace.name==='legacy-game-db');
   if(idb?.payload.version!==2||idb.payload.stores[0].generator.next!==2||idb.payload.stores[0].indexes[0].name!=='tag')throw Error('LEGACY_IDB_SCHEMA_OR_GENERATOR_LOST');
   const graph=await codec.encodePortableValue(data),wire=JSON.stringify(graph);
   if(wire.includes('must-not-export-native'))throw Error('NATIVE_CONTROL_DATA_LEAK');
   const decoded=codec.decodePortableValue(graph),record=decoded.snapshots.find(s=>s.namespace.kind==='idb').payload.stores[0].records[0].value;
   if(!(record.bytes instanceof Uint8Array)||!(record.date instanceof Date)||!(record.blob instanceof Blob)||await record.blob.text()!=='old-binary-'+i)throw Error('LEGACY_BINARY_VALUES_LOST');
   const cookie=decoded.snapshots.find(s=>s.namespace.kind==='cookies').payload.cookies[0];
   if(cookie.value!=='fork-cookie-'+i||!cookie.httpOnly||cookie.hostOnly!==false||cookie.sessionId!=='legacy-profile-import')throw Error('PINNED_FORK_COOKIE_LOST');
   const current=decoded.cookieStores?.find(v=>v.database==='__runtimekit_controller'),previous=decoded.cookieStores?.find(v=>v.database==='__scramjet_controller');
   if(current?.payload.cookies[0].value!=='fork-cookie-'+i||previous?.payload.cookies[0].value!=='cookie-'+i)throw Error('DIVERGENT_CONTROLLER_COOKIE_RECOVERY_LOST');
   const ambiguous=decoded.hostStorage.find(s=>s.host==='both.example'),unknown=decoded.hostStorage.find(s=>s.host==='unknown.example');
   if(ambiguous?.candidateOrigins.length!==2||unknown?.candidateOrigins.length!==0||decoded.snapshots.some(s=>s.namespace.origin==='https://both.example'||s.namespace.origin==='https://unknown.example'))throw Error('HOST_SCHEME_GUESSED');
   if(localStorage.getItem('orteil.dashnet.org@CookieClickerGame')!==save)throw Error('SOURCE_STORAGE_CHANGED');
   db=await open('https://orteil.dashnet.org@legacy-game-db',2,()=>{});tx=db.transaction('records','readwrite');const request=tx.objectStore('records').add({tag:'two'});const next=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});await done(tx);db.close();if(next!==2)throw Error('SOURCE_KEY_GENERATOR_MUTATED');
   return{result:'PASS',source:i,logicalNamespaces:decoded.snapshots.length,rawHostGroups:decoded.hostStorage.length,controllerSourceBackups:decoded.cookieStores.length,pinnedForkJar:true,divergentPredecessorJarRetained:true,ambiguousPreserved:true,unknownSchemePreserved:true,binarySchemaCookie:true,nativeControlDataExcluded:true,sourceRetained:true,generatorNext:next};
  },{i});results.push(result);await p.close();
 }
 assert.equal(results.length,2);writeFileSync(resolve(out,'LEGACY_EXPORT_BROWSER.json'),JSON.stringify({result:'PASS',browser:browser.version(),sources:results},null,2)+'\n');
 console.log('LEGACY_EXPORT_BROWSER=PASS; OLD_ORIGINS=2; NORMAL_SCRAMJET_HOST_LOCAL=PASS; ORIGIN_IDB_BINARY_SCHEMA_KEYS=PASS; PINNED_FORK_COOKIE_JAR=PASS; DIVERGENT_COOKIE_SOURCE_BACKUPS=PASS; AMBIGUOUS_RAW_BACKUP=PASS; NATIVE_CONTROL_EXCLUDED=PASS; SOURCE_RETAINED=PASS');
}catch(error){writeFileSync(resolve(out,'LEGACY_EXPORT_BROWSER.json'),JSON.stringify({result:'FAIL',sources:results,error:error.message},null,2)+'\n');console.error(error.stack);process.exitCode=1;}
finally{await browser?.close();await app.close();}
