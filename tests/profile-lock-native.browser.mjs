/** Real native IDB: a blocked site's delete never stalls another site's queue,
 * export, or lock; interrupted intents retain exactly one copied journal. */
import Fastify from 'fastify';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const app = Fastify({ logger: false });
const sourceRoot = process.env.ATLAS_LOCK_NATIVE_SOURCE || '.';
for (const name of ['profile-sync', 'profile-idb-catalog', 'profile-store', 'profile-journal', 'profile-locks', 'profile-recovery']) {
  const code = (await build({entryPoints:[`${sourceRoot}/runtime/${name}.ts`],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
  app.get(`/${name}.js`, (_q,r) => r.type('application/javascript').send(code));
}
app.get('/', (_q,r) => r.type('text/html').send('<!doctype html><title>Native group-lock regression</title>'));
let browser;
try {
  const origin = await app.listen({host:'127.0.0.1',port:0});
  const executablePath = process.env.CHROME_PATH || ['/Users/paxton/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  browser = await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const page = await browser.newPage(); await page.goto(origin);
  const result = await page.evaluate(async baseline => {
    const j=await import('/profile-journal.js'),c=await import('/profile-idb-catalog.js'),s=await import('/profile-sync.js'),p=await import('/profile-store.js'),locks=await import('/profile-locks.js'),recovery=await import('/profile-recovery.js');
    const id='11111111-1111-4111-8111-111111111111',a='https://slow.example',b='https://fast.test';
    const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('native transaction failed'))});
    const open=(name,setup)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>setup(r.result);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const physical=await c.resolveProfileIDBDatabase(indexedDB,id,a,'blocked');
    const held=await open(physical,db=>{db.createObjectStore(j.PROFILE_IDB_KEEP);db.createObjectStore('data')});
    const tx=held.transaction([j.PROFILE_IDB_KEEP,'data'],'readwrite');const committed=done(tx);
    const oldEntry=j.appendProfileJournal(tx.objectStore(j.PROFILE_IDB_KEEP),{profileId:id,kind:'idb',origin:a,name:'blocked',payload:{format:'atlas-idb-fixture-journal',keep:'exact'},bytes:64});tx.objectStore('data').put('do not lose','save');await committed;
    const local=await open(j.profileDatabaseName('atlas.browsing.v2',id),db=>db.createObjectStore('origins'));
    const lt=local.transaction('origins','readwrite'),ld=done(lt),store=lt.objectStore('origins');store.put({revision:1,entries:[['save','retained']]},b);
    const fastEntry=j.appendProfileJournal(store,{profileId:id,kind:'local',origin:b,payload:{format:'atlas-local-journal-v1',revision:1,change:{op:'set',key:'save',value:'retained'}},bytes:64},'array');await ld;local.close();
    let signalBlocked;const blocked=new Promise(resolve=>signalBlocked=resolve);let deleteComplete=false;
    const deletion=c.deleteProfileIDBDatabase(indexedDB,id,a,'blocked',()=>signalBlocked()).then(()=>{deleteComplete=true});
    await blocked;
    const bounded=async(label,run)=>{const at=performance.now();let timer;try{return await Promise.race([run().then(value=>({label,ms:performance.now()-at,value})),new Promise(resolve=>timer=setTimeout(()=>resolve({label,timedOut:true,ms:performance.now()-at}),350))])}finally{clearTimeout(timer)}};
    const queue=s.nativeProfileQueue(indexedDB,id);
    const scoped=await bounded('unrelated scoped queue',()=>queue.metadata('fast.test'));
    const unscoped=await bounded('global queue discovery',()=>queue.metadata());
    const exported=await bounded('unrelated scoped export',()=>p.exportProfileSnapshots(indexedDB,id,undefined,'fast.test'));
    const independent=await bounded('unrelated group operation',()=>locks.withProfileGroupLock(id,'fast.test',async()=>true));
    const prepared=baseline?undefined:await bounded('unrelated recovery preparation',async()=>{const value=await recovery.prepareProfileRecovery(indexedDB,id,'native-recovery-000000000001',b,queue);return {changes:value?.changes.length,bytes:value?.payload.archive.size}});
    const whileBlocked={scoped:scoped.timedOut?'timeout':scoped.value.map(x=>({id:x.entry.id,origin:x.entry.origin})),global:unscoped.timedOut?'timeout':unscoped.value.map(x=>({id:x.entry.id,database:x.database})),export:exported.timedOut?'timeout':exported.value.map(x=>({origin:x.namespace.origin,payload:x.payload})),independent:independent.timedOut?'timeout':independent.value,recovery:prepared?.timedOut?'timeout':prepared?.value,deleteComplete};
    held.close();await deletion;
    const final=await queue.list();
    const finalState={copiedOldCount:final.filter(x=>x.entry.id===oldEntry.id).length,fastCount:final.filter(x=>x.entry.id===fastEntry.id).length,tombstones:final.filter(x=>x.entry.kind==='idb'&&x.entry.origin===a&&x.entry.payload?.deleted===true).length,deleteComplete,records:await c.listProfileIDBDatabases(indexedDB,id)};
    let invalidGroupRejected=false;try{await queue.metadata('not a domain')}catch{invalidGroupRejected=true}
    let staleRecoveryPreserved;
    if (!baseline) {
      // A stale discovered intent must not delete a newer physical generation
      // after it finally acquires the website lock.
      const oldPhysical=j.profileIDBPrefix(a,id)+'stale',newPhysical=j.profileIDBPrefix(a,id)+'stale#:generation:new';
      const stale=await open(oldPhysical,db=>db.createObjectStore(j.PROFILE_IDB_KEEP));stale.close();
      const catalog=await c.openProfileCatalog(indexedDB,id);let st=catalog.transaction('meta','readwrite'),sd=done(st);st.objectStore('meta').put({origin:a,name:'stale',physical:oldPhysical,deleting:true},c.profileDatabaseKey(a,'stale'));await sd;
      let release,entered;const entry=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
      const owner=locks.withProfileGroupLock(id,'slow.example',async()=>{entered();await gate});await entry;
      await queue.metadata('slow.example');
      const replacement=await open(newPhysical,db=>db.createObjectStore('data'));st=replacement.transaction('data','readwrite');sd=done(st);st.objectStore('data').put('new generation','save');await sd;replacement.close();
      st=catalog.transaction('meta','readwrite');sd=done(st);st.objectStore('meta').put({origin:a,name:'stale',physical:newPhysical},c.profileDatabaseKey(a,'stale'));await sd;catalog.close();release();await owner;
      await locks.withProfileGroupLock(id,'slow.example',async()=>{});
      staleRecoveryPreserved=(await indexedDB.databases()).some(x=>x.name===newPhysical)&&(await c.listProfileIDBDatabases(indexedDB,id)).some(x=>x.name==='stale'&&x.physical===newPhysical&&!x.deleting);
    }
    return {baseline,whileBlocked,timings:[scoped,unscoped,exported,independent,...(prepared?[prepared]:[])].map(({label,ms,timedOut})=>({label,ms,timedOut:!!timedOut})),finalState,invalidGroupRejected,staleRecoveryPreserved};
  },process.env.ATLAS_LOCK_NATIVE_BASELINE==='1');
  const out={browser:await browser.version(),result};
  const output=process.env.ATLAS_LOCK_NATIVE_OUTPUT || 'evidence/account-locks-20261028/native-lock-browser.json';await writeFile(output,JSON.stringify(out,null,2));
  if (result.baseline) assert.equal(result.whileBlocked.scoped,'timeout');
  else {assert.equal(result.timings.every(x=>!x.timedOut),true);assert.equal(result.whileBlocked.deleteComplete,false);assert.equal(result.whileBlocked.scoped.length,1);assert.equal(result.whileBlocked.export[0].payload.entries[0][1],'retained');assert.equal(result.whileBlocked.independent,true);assert.equal(result.whileBlocked.recovery.changes,1);assert.ok(result.whileBlocked.recovery.bytes>0);assert.equal(result.staleRecoveryPreserved,true);assert.equal(result.invalidGroupRejected,true)}
  assert.equal(result.finalState.copiedOldCount,1);assert.equal(result.finalState.fastCount,1);assert.equal(result.finalState.tombstones,1);assert.equal(result.finalState.deleteComplete,true);
  console.log(JSON.stringify({browser:out.browser,baseline:result.baseline,timings:result.timings,deleteStayedPendingUntilClose:!result.whileBlocked.deleteComplete,exactOneCopiedJournal:result.finalState.copiedOldCount===1,tombstoneAfterActualDelete:result.finalState.tombstones===1,staleRecoveryPreserved:result.staleRecoveryPreserved}));
} finally {await browser?.close();await app.close()}
