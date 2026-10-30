/** Correctness/call-count regressions for compatible v2 caches. No CPU latency
 * qualification, production traffic, or changes to an existing browser profile. */
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const root=process.cwd(), evidence=resolve(process.env.ATLAS_CACHE_EVIDENCE||'evidence/performance-remediation-20261029');
await mkdir(evidence,{recursive:true});
const baseline=process.env.ATLAS_COOKIE_CACHE_BASELINE==='1';
const preimage={name:'retained-owned-preimages',setup(b){b.onLoad({filter:/\.ts$/},async a=>{const name=relative(root,a.path);if(!name.startsWith('runtime/'))return;try{return {contents:await readFile(resolve(evidence,'preimages',name),'utf8'),loader:'ts',resolveDir:dirname(a.path)}}catch{}})}};
const bundle=async(contents,old=false)=>(await build({stdin:{contents,resolveDir:resolve('runtime')},plugins:old?[preimage]:[],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const api=await bundle(`export{LocalCookieJarV2}from'./local-cookie-jar-v2.ts';export{createLocalCookieOwnerV2,createLocalStorageOwnerV2}from'./sandbox-local-owners-v2.ts';export{createSandboxDocumentCookie}from'./sandbox-document-cookie.ts';export{createSandboxStorageFacades,rebindSandboxStorageFacades}from'./sandbox-local-storage.ts';`,baseline);
// Frozen whole-site writer is a committed test fixture, not an ignored evidence
// dependency. New cache code surrounding it does not teach this old writer how
// to maintain the new identity-path usage certificate.
const legacyWrite=await readFile(new URL('./fixtures/cookie-whole-site-write-v2.txt',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(legacyWrite).digest('hex'),'7271f21cfb9bd6627431405df3eca02df4189b87f59f24bdae10cc52a9c19f6d');
const legacyPlugin={name:'whole-site-reference-writer',setup(b){b.onLoad({filter:/local-cookie-jar-v2\.ts$/},async a=>{const s=await readFile(a.path,'utf8'),start=s.indexOf('  private async write('),end=s.indexOf('  async getRequestHeader(',start);assert.ok(start>=0&&end>start);return {contents:s.slice(0,start)+legacyWrite+s.slice(end),loader:'ts',resolveDir:dirname(a.path)}})}};
const legacy=(await build({stdin:{contents:`export{LocalCookieJarV2}from'./local-cookie-jar-v2.ts';`,resolveDir:resolve('runtime')},plugins:[legacyPlugin],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const cookies=await bundle(`import'./cookie-native-worker-v2.ts';`,baseline), storage=await bundle(`import'./storage-native-worker-v2.ts';`,baseline);
const app=Fastify({logger:false});app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>V2 local cache correctness</title>'));
for(const [name,code] of [['api',api],['legacy',legacy],['cookies',cookies],['storage',storage]])app.get('/'+name+'.js',(_q,r)=>r.type('application/javascript').send(code));
let browser;const report={command:'node tests/local-cookie-cache-v2-browser.mjs',variant:baseline?'retained-preimage':'modified',scope:'Actual local native IndexedDB, cookie jar, native worker and synchronous receipt facade correctness; synthetic values only. Method-call assertions are invariants, not latency/hardware performance measurements.'};
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();const context=await browser.newContext(), page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 report.checks=await page.evaluate(async()=>{
  const api=await import('/api.js'), Legacy=(await import('/legacy.js')).LocalCookieJarV2;
  const checks=[];const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name)};
  const authority={version:2,profileId:'11111111-1111-4111-8111-111111111111',replicaId:'22222222-2222-4222-8222-222222222222',localAuthGeneration:'cache_generation_0123456789',browserSessionId:'cache_session_0123456789'};
  const nativeTx=IDBDatabase.prototype.transaction,completeDescriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');
  let getAlls=0,puts=0,holdRead=false,held,signalHeld;
  const getAll=IDBIndex.prototype.getAll,put=IDBObjectStore.prototype.put;
  IDBIndex.prototype.getAll=function(...a){getAlls++;return Reflect.apply(getAll,this,a)};
  IDBObjectStore.prototype.put=function(...a){puts++;return Reflect.apply(put,this,a)};
  IDBDatabase.prototype.transaction=function(...a){const tx=Reflect.apply(nativeTx,this,a);if(holdRead&&a[1]==='readonly'&&Array.isArray(a[0])&&a[0].includes('cookies')){holdRead=false;Object.defineProperty(tx,'oncomplete',{configurable:true,set(fn){completeDescriptor.set.call(tx,event=>{held=()=>fn(event);signalHeld()})},get(){return completeDescriptor.get.call(tx)}})}return tx};
  let now=Date.now(),commits=0;
  const options={factory:indexedDB,profileId:authority.replicaId,localAuthority:authority,browserSessionId:authority.browserSessionId,forbiddenOrigins:[location.origin],now:()=>now,onNativeCommit:()=>commits++};
  const jar=new api.LocalCookieJarV2(options), ctx=url=>({requestURL:url,documentURL:url,topLevelURL:url,credentials:'include',method:'GET'}), alpha=ctx('https://a.alpha.test/path/page?old=1'), beta=ctx('https://beta.test/');
  const usage=async()=>{const db=await jar.database;return await new Promise((resolve,reject)=>{const t=db.transaction('meta'),r=t.objectStore('meta').get('local-usage-v2');t.oncomplete=()=>resolve(r.result);t.onabort=()=>reject(t.error)})};
  await jar.storeResponseCookies(['root=visible;Secure;Path=/;SameSite=Lax','scoped=path;Secure;Path=/path;SameSite=Lax','secret=private;Secure;HttpOnly;Path=/;SameSite=None','partition=alpha;Secure;Partitioned;Path=/;SameSite=None'],alpha);
  const doc=jar.document({documentId:'cache_direct_document_012345',documentURL:alpha.documentURL,topLevelURL:alpha.topLevelURL});
  const initial=await doc.snapshot();check(initial.value.includes('root=visible')&&initial.value.includes('scoped=path')&&!initial.value.includes('secret=private'),'document filtering, path ordering and HttpOnly preserved');
  const header=await jar.getRequestHeader(alpha);check(header.includes('secret=private'),'HTTP includes authorized HttpOnly cookie');
  const viewCount=jar.headerViews.size;for(let i=0;i<5;i++)check(await jar.getRequestHeader({...alpha,requestURL:'https://a.alpha.test/path/page?q='+i+'#fragment'})===header,'query/hash-equivalent header '+i);
  check(jar.headerViews.size===viewCount,'equivalent resource queries reuse the same header cache entry');
  await jar.storeResponseCookies(['other=1;Secure;Path=/;SameSite=Lax'],beta);getAlls=0;
  check(await jar.getRequestHeader(alpha)===header&&getAlls===0,'unrelated site mutation retains hot header/partition');
  check(!(await jar.getRequestHeader({...alpha,requestURL:'https://a.alpha.test/other'})).includes('scoped=path'),'request path remains part of cache identity');
  check(!(await jar.getRequestHeader({...alpha,requestURL:'https://b.alpha.test/path/page',credentials:'include'})).includes('root=visible'),'host-only cookie isolation survives cache reuse');
  check(await jar.getRequestHeader({...alpha,credentials:'omit'})==='','credentials omit bypasses cookie values');
  const cross=await jar.getRequestHeader({...alpha,topLevelURL:'https://outside.test/'});
  check(cross.includes('secret=private')&&!cross.includes('root=visible')&&!cross.includes('partition=alpha'),'SameSite and partition context remain part of eligibility');
  check([...jar.headerViews.values()].filter(v=>v.view).some(v=>v.view.entries===undefined),'HTTP cached headers omit document-only entries');
  const identity='cache_direct_document_012345:receipt_identity';
  const first=await doc.set('same=one;Secure;Path=/;SameSite=Lax',{binding:identity,sequence:1});
  const beforeUsage=await usage(),beforeCommit=commits;puts=0;
  const same=await doc.set('same=one;Secure;Path=/;SameSite=Lax',{binding:identity,sequence:2});
  const receiptPuts=puts;
  check(same.revision===first.revision&&commits===beforeCommit&&receiptPuts===1,'equivalent session assignment persists only result identity without dirty/revision notification');
  check(JSON.stringify(await usage())===JSON.stringify(beforeUsage),'equivalent assignment preserves exact usage');
  const replay=await doc.set('same=must-not-reapply;Secure;Path=/',{binding:identity,sequence:2});
  check(replay.revision===same.revision&&(await doc.snapshot()).value.includes('same=one'),'lost-receipt identity cannot reapply a later different mutation');
  const age1=await doc.set('lifetime=value;Secure;Path=/;Max-Age=5',{binding:identity,sequence:3});now+=1000;
  const age2=await doc.set('lifetime=value;Secure;Path=/;Max-Age=5',{binding:identity,sequence:4});
  check(age2.revision>age1.revision&&age2.delta.upsert[0].expiresAt>age1.delta.upsert[0].expiresAt,'Max-Age reassignment extends expiry and is not a no-op');
  const expires=new Date(now+60000).toUTCString(),absolute1=await doc.set('absolute=value;Secure;Path=/;Expires='+expires,{binding:identity,sequence:5});now+=1000;
  const absolute2=await doc.set('absolute=value;Secure;Path=/;Expires='+expires,{binding:identity,sequence:6});
  check(absolute2.revision===absolute1.revision,'identical absolute expiry can be a semantic no-op');
  const flags=await doc.set('same=one;Secure;Path=/;SameSite=Strict',{binding:identity,sequence:7});check(flags.revision>absolute2.revision,'same value with changed SameSite remains a mutation');
  const rejected=await doc.set('secret=overwrite;Secure;Path=/;SameSite=None',{binding:identity,sequence:8});check(rejected.accepted===0&&rejected.rejected.includes('cookie_httponly_overwrite_denied')&&(await jar.getRequestHeader(alpha)).includes('secret=private'),'no-op optimization cannot bypass HttpOnly overwrite protection');
  await doc.set('soon=gone;Secure;Path=/;Max-Age=1',{binding:identity,sequence:9});const beforeExpiry=await usage();now+=2000;
  const cleanup=await doc.set('same=one;Secure;Path=/;SameSite=Strict',{binding:identity,sequence:10});const afterExpiry=await usage();
  check(cleanup.revision>flags.revision&&afterExpiry.count<beforeExpiry.count&&afterExpiry.bytes<beforeExpiry.bytes&&!(await doc.snapshot()).value.includes('soon=gone'),'expired-row cleanup still changes revision and exact aggregate accounting');
  // Hold a completed old read while a same-site mutation invalidates it.
  let heldReady=new Promise(r=>signalHeld=r);holdRead=true;const race=ctx('https://race.test/'),oldRead=jar.getRequestHeader(race);await heldReady;
  await jar.storeResponseCookies(['race=new;Secure;Path=/;SameSite=Lax'],race);held();await oldRead;
  check((await jar.getRequestHeader(race)).includes('race=new'),'in-flight pre-write result cannot seed a stale cache after site invalidation');
  heldReady=new Promise(r=>signalHeld=r);holdRead=true;const steady=ctx('https://steady.test/'),steadyRead=jar.getRequestHeader(steady);await heldReady;
  await jar.storeResponseCookies(['other=2;Secure;Path=/;SameSite=Lax'],beta);held();await steadyRead;getAlls=0;await jar.getRequestHeader(steady);
  check(getAlls===0,'unrelated invalidation does not discard an in-flight partition cut');
  const legacy=new Legacy(options);const legacyWrite=await legacy.storeResponseCookies(['legacy=compatible;Secure;Path=/;SameSite=Lax'],alpha);
  for(let i=0;i<100&&jar.latestRevision<legacyWrite.revision;i++)await new Promise(r=>setTimeout(r,5));
  check((await jar.getRequestHeader(alpha)).includes('legacy=compatible'),'older actor site notification invalidates the compatible new cache');
  for(let i=0;i<150;i++)await jar.getRequestHeader(ctx('https://empty-'+i+'.test/'));
  check(jar.partitions.size<=64&&jar.siteTokens.size<=128&&jar.partitionBytes<=8*1024*1024,'cookie-less site partitions and inflight identities remain bounded');
  await jar.storeResponseCookies(['large='+('x'.repeat(3500))+';Secure;Path=/;SameSite=Lax'],alpha);
  for(let i=0;i<160;i++)await jar.getRequestHeader({...alpha,requestURL:'https://a.alpha.test/cache/'+i});
  check(jar.headerViews.size<160&&jar.headerViews.size<=256&&jar.headerViewBytes<=1024*1024,'derived header views honor byte and count budgets');
  await legacy.close();doc.dispose();await jar.close();
  IDBDatabase.prototype.transaction=nativeTx;IDBIndex.prototype.getAll=getAll;IDBObjectStore.prototype.put=put;
  // Exercise actual trusted workers and local receipts for both facade caches.
  const liveAuthority={...authority,replicaId:'33333333-3333-4333-8333-333333333333'};
  const cookieOwner=await api.createLocalCookieOwnerV2({workerURL:'/cookies.js',localAuthority:liveAuthority}),cookieURL='https://facade.test/path/page';
  const localCtx=ctx(cookieURL);await cookieOwner.storeResponseCookies(['visible=one;Secure;Path=/;SameSite=Lax'],localCtx);
  const bound=await cookieOwner.bind({documentId:'cache_cookie_facade_012345',website:cookieURL}),facade=await api.createSandboxDocumentCookie({documentId:'cache_cookie_facade_012345',endpoint:bound.endpoint,port:bound.port,window,localOnly:true});
  let filters=0;const filter=Array.prototype.filter;Array.prototype.filter=function(...a){filters++;return Reflect.apply(filter,this,a)};
  for(let i=0;i<25;i++)check(facade.get()==='visible=one','cached document cookie getter '+i);
  Array.prototype.filter=filter;check(filters===0,'initialized document cookie getters reuse the validated string without entry-array filtering');
  facade.set('visible=two;Secure;Path=/;SameSite=Lax');check(facade.get()==='visible=two','accepted synchronous setter refreshes cached document string');
  await cookieOwner.storeResponseCookies(['net=changed;Secure;Path=/;SameSite=Lax'],localCtx);await new Promise(r=>setTimeout(r,20));check(facade.get().includes('net=changed'),'network Set-Cookie invalidates the cached document string');
  facade.set('short=gone;Secure;Path=/;Max-Age=1');check(facade.get().includes('short=gone'),'short cookie initially visible');await new Promise(r=>setTimeout(r,1100));check(!facade.get().includes('short=gone'),'cached document string refreshes at expiry');
  facade.setURL('https://facade.test/other');facade.set('path=other;Secure;Path=/other;SameSite=Lax');check(facade.get().includes('path=other'),'SPA path change refreshes correct local cookie view');facade.setURL(cookieURL);check(!facade.get().includes('path=other'),'path-scoped cached entry does not escape its URL');
  const storageOwner=await api.createLocalStorageOwnerV2({workerURL:'/storage.js',localAuthority:liveAuthority});
  async function storageDocument(documentId){const b=await storageOwner.bind({documentId,website:'https://storage.test/',sessionId:liveAuthority.browserSessionId}),facades=await api.createSandboxStorageFacades({documentId,endpoint:b.endpoint,port:b.port,window,localReceipts:true,localOnly:true}),frame=document.createElement('iframe');document.body.append(frame);const installed=api.rebindSandboxStorageFacades(facades,frame.contentWindow);return {binding:b,facades,frame,installed,local:frame.contentWindow.localStorage,session:frame.contentWindow.sessionStorage}}
  const local=await storageDocument('cache_storage_main_012345');const s=local.local;for(const k of ['one','two','three'])s.setItem(k,k);
  const keys=Map.prototype.keys;let keyWalks=0;Map.prototype.keys=function(...a){keyWalks++;return Reflect.apply(keys,this,a)};
  check([s.key(0),s.key(1),s.key(2),s.key(3)].join('|')==='one|two|three|','Storage.key preserves insertion order and null bounds');
  for(let i=0;i<10;i++)s.key(i%3);check(keyWalks===1,'Storage.key enumerates the key map once per membership generation');
  s.setItem('two','updated');s.key(1);check(keyWalks===1,'value-only storage mutation preserves key-order cache');
  s.removeItem('one');check(s.key(0)==='two'&&keyWalks===2,'storage removal invalidates key order');s.setItem('one','again');check(s.key(2)==='one'&&keyWalks===3,'reinserted key moves to the end');
  local.session.setItem('session','separate');check(local.session.key(0)==='session'&&keyWalks===4,'session key-order cache is independently scoped');
  Map.prototype.keys=keys;
  const peer=await storageDocument('cache_storage_peer_012345');peer.local.setItem('remote','new');for(let i=0;i<100&&s.getItem('remote')!=='new';i++)await new Promise(r=>setTimeout(r,5));check(s.key(s.length-1)==='remote','remote incremental insert invalidates cached key order');
  peer.local.clear();for(let i=0;i<100&&s.length;i++)await new Promise(r=>setTimeout(r,5));check(s.length===0&&s.key(0)===null,'remote clear invalidates cached key order');
  peer.installed.dispose();peer.frame.remove();peer.facades.dispose();peer.binding.dispose();local.installed.dispose();local.frame.remove();local.facades.dispose();local.binding.dispose();storageOwner.dispose();facade.dispose();bound.dispose();cookieOwner.dispose();
  return {checks,receiptPuts,remainingProfileData:'Synthetic fresh browser context only'};
 });
 assert.deepEqual(errors,[]);report.result='PASS';report.pageErrors=errors;console.log(JSON.stringify({result:report.result,variant:report.variant,checks:report.checks.checks.length}));await context.close();
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1}
finally{await writeFile(resolve(evidence,baseline?'COOKIE_CACHE_BASELINE_CORRECTNESS.json':'COOKIE_CACHE_CORRECTNESS.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close()}
