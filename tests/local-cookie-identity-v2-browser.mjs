/** Differential correctness of revision/expiry-fenced identity writes against
 * the retained whole-site writer. Synthetic native IDB; no latency benchmark. */
import Fastify from 'fastify';import {chromium} from '@playwright/test';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild'), E=resolve('evidence/performance-remediation-20261029');await mkdir(E,{recursive:true});
const writer=await readFile(new URL('./fixtures/cookie-whole-site-write-v2.txt',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(writer).digest('hex'),'7271f21cfb9bd6627431405df3eca02df4189b87f59f24bdae10cc52a9c19f6d');
const reference={name:'frozen-whole-site-writer',setup(b){b.onLoad({filter:/local-cookie-jar-v2\.ts$/},async a=>{const s=await readFile(a.path,'utf8'),start=s.indexOf('  private async write('),end=s.indexOf('  async getRequestHeader(',start);assert.ok(start>=0&&end>start);return {contents:s.slice(0,start)+writer+s.slice(end),loader:'ts',resolveDir:dirname(a.path)}})}};
const bundle=async old=>(await build({stdin:{contents:`export{LocalCookieJarV2}from'./local-cookie-jar-v2.ts';`,resolveDir:resolve('runtime')},plugins:old?[reference]:[],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const app=Fastify({logger:false});app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Cookie identity differential correctness</title>'));for(const [name,old]of [['candidate',false],['reference',true]]){const code=await bundle(old);app.get('/'+name+'.js',(_q,r)=>r.type('application/javascript').send(code))}
let browser;const report={command:'node tests/local-cookie-identity-v2-browser.mjs',scope:'Actual native IndexedDB differential/call-count correctness against frozen pre-identity whole-site writer. No CPU throttle, latency qualification, public traffic, real accounts or existing browser state.'};
try{const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();const context=await browser.newContext(),page=await context.newPage();await page.goto(origin);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
report.checks=await page.evaluate(async()=>{
 const Candidate=(await import('/candidate.js')).LocalCookieJarV2,Reference=(await import('/reference.js')).LocalCookieJarV2,checks=[];
 const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name)};
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',profile='33333333-3333-4333-8333-333333333333';let now=1700000000000;
 const authority=id=>({version:2,profileId:profile,replicaId:id,localAuthGeneration:'identity_generation_0123456',browserSessionId:'identity_session_0123456789'});
 const options=(id,limits={})=>({factory:indexedDB,profileId:id,localAuthority:authority(id),browserSessionId:'identity_session_0123456789',forbiddenOrigins:[location.origin],now:()=>now,...limits});
 const ca=new Candidate(options(a)),rb=new Reference(options(b)),old=new Reference(options(a));
 const ctx=url=>({requestURL:url,documentURL:url,topLevelURL:url,credentials:'include',method:'GET'}),A=ctx('https://a.alpha.test/path/page'),B=ctx('https://beta.test/');
 let candidateScans=0,targetGets=0;const ga=IDBIndex.prototype.getAll,get=IDBObjectStore.prototype.get;
 IDBIndex.prototype.getAll=function(...args){if(this.objectStore.transaction.db.name.includes(a))candidateScans++;return Reflect.apply(ga,this,args)};
 IDBObjectStore.prototype.get=function(...args){if(this.name==='cookies'&&this.transaction.db.name.includes(a))targetGets++;return Reflect.apply(get,this,args)};
 const nativeState=async jar=>{const db=await jar.database;return await new Promise((resolve,reject)=>{const t=db.transaction(['cookies','meta']),cookies=t.objectStore('cookies').getAll(),usage=t.objectStore('meta').get('local-usage-v2'),revision=t.objectStore('meta').get('revision');t.oncomplete=()=>resolve({cookies:cookies.result,usage:usage.result,revision:revision.result||0});t.onabort=()=>reject(t.error)})};
 const norm=value=>JSON.stringify(value,(_k,v)=>typeof v==='string'?v.replaceAll(a,'<replica>').replaceAll(b,'<replica>'):v);
 let compared=0;const equal=async label=>{check(norm(await nativeState(ca))===norm(await nativeState(rb)),label);compared++};
 const apply=async(lines,where=A,legacy=false)=>{const left=legacy?old:ca;const out=await left.storeResponseCookies(lines,where),ref=await rb.storeResponseCookies(lines,where);check(norm(out)===norm(ref),'equivalent accepted/rejected/revision outcome '+compared);await equal('native cookie rows/usage/revision match '+compared);return out};
 await apply(Array.from({length:100},(_,i)=>'c'+i+'=value;Secure;Path=/;SameSite=Lax'));await apply(Array.from({length:80},(_,i)=>'c'+(i+100)+'=value;Secure;Path=/;SameSite=Lax'));
 candidateScans=0;targetGets=0;for(let i=0;i<30;i++)await apply(['c0=change'+i+';Secure;Path=/;SameSite=Lax']);
 check(candidateScans===0&&targetGets===30,'30 changing writes use exact identities, zero whole-site getAll');
 await apply(['legacyBeta=changed;Secure;Path=/;SameSite=Lax'],B,true);candidateScans=0;await apply(['c0=after-legacy;Secure;Path=/;SameSite=Lax']);check(candidateScans===1,'unmodified actor revision invalidates certificate even for another site');
 await apply(['expire=temporary;Secure;Path=/;Max-Age=1'],B);now+=2000;candidateScans=0;await apply(['fresh=session;Secure;Path=/;SameSite=Lax'],B);check(candidateScans===1,'elapsed earliest-expiry certificate performs full expiry cleanup');
 await apply(['lower=temporary;Secure;Path=/;Max-Age=2'],B);await apply(['lower=;Secure;Path=/;Max-Age=0'],B);now+=3000;candidateScans=0;await apply(['fresh=changed;Secure;Path=/;SameSite=Lax'],B);check(candidateScans===1,'deleted earliest expiry remains conservative and causes only a safe extra scan');
 await apply(['protected=secure;Secure;Path=/;SameSite=Lax'],B);candidateScans=0;const blocked=await apply(['protected=insecure;Path=/;SameSite=Lax'],ctx('http://beta.test/'));check(blocked.accepted===0&&blocked.rejected.includes('cookie_secure_overlay_denied')&&candidateScans===1,'insecure overlay check retains complete-site fallback');
 // Replay identity and sequential duplicate-cookie lines in the same batch.
 const da=ca.document({documentId:'identity_document_012345',documentURL:B.documentURL,topLevelURL:B.topLevelURL}),dr=rb.document({documentId:'identity_document_012345',documentURL:B.documentURL,topLevelURL:B.topLevelURL});
 const identity={binding:'identity_document_012345:operation',sequence:1};const setA=await da.set('doc=value;Secure;Path=/;SameSite=Lax',identity),setR=await dr.set('doc=value;Secure;Path=/;SameSite=Lax',identity);check(norm(setA)===norm(setR),'document receipt result matches whole-site reference');
 await da.set('doc=must-not-repeat;Secure;Path=/',identity);await dr.set('doc=must-not-repeat;Secure;Path=/',identity);await equal('replayed identity cannot repeat source mutation');
 await apply(['duplicate=first;Secure;Path=/','duplicate=second;Secure;Path=/','duplicate=;Secure;Path=/;Max-Age=0','duplicate=last;Secure;Path=/'],B);check((await ca.getRequestHeader(B)).includes('duplicate=last'),'batch duplicate identities retain sequential last accepted state');
 // Deterministic differential sequence includes invalid syntax, expiry, flags,
 // duplicate names/paths, partitioned/HttpOnly state and old native writers.
 let rng=0x12345678;const random=n=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng%n};
 for(let i=0;i<160;i++){
  now+=random(800);const where=random(3)?B:ctx('https://sub.beta.test/nested/page'),name=['f0','f1','f2','f3','__Host-pref',''][random(6)],path=random(3)?'/':'/nested',age=['',';Max-Age=0',';Max-Age=1',';Max-Age=60',';Expires=Wed, 15 Nov 2023 02:00:00 GMT'][random(5)],same=['Lax','Strict','None'][random(3)];
  let line=(name?name+'=':'')+['plain','é-value','quoted"value','unicode-ÿ'][random(4)]+';Secure;Path='+path+';SameSite='+same+age;
  if(random(7)===0)line+=';HttpOnly';if(random(9)===0)line+=';Partitioned';if(random(11)===0)line+=';Domain=evil.test';if(random(13)===0)line='invalid\nline';
  const lines=random(8)===0?[line,line.replace(/plain|é-value/,'other')]:[line];await apply(lines,where,i%11===0);
 }
 // Abort after native cookie success but before the surrounding transaction
 // commits: durable data AND the expendable proof must remain unchanged.
 const beforeAbort=norm(await nativeState(ca)),beforeProof=JSON.stringify([...ca.siteUsageProofs]),controller=new AbortController(),nativePut=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){const request=Reflect.apply(nativePut,this,[value,...args]);if(this.name==='cookies'&&this.transaction.db.name.includes(a)&&value?.name==='interrupted')request.addEventListener('success',()=>controller.abort(new DOMException('fixture-abort','AbortError')),{once:true});return request};
 let aborted;try{await ca.storeResponseCookies(['interrupted=must-not-commit;Secure;Path=/'],{...B,signal:controller.signal})}catch(e){aborted=e.name}finally{IDBObjectStore.prototype.put=nativePut}
 check(aborted==='AbortError'&&norm(await nativeState(ca))===beforeAbort&&JSON.stringify([...ca.siteUsageProofs])===beforeProof,'native abort after successful mutation leaves source and proof cache unchanged');
 const cold=new Candidate(options(a));candidateScans=0;const coldOut=await cold.storeResponseCookies(['cold=once;Secure;Path=/'],B),coldRef=await rb.storeResponseCookies(['cold=once;Secure;Path=/'],B);check(candidateScans===1&&norm(coldOut)===norm(coldRef),'cold/restarted actor safely scans once before creating its in-memory proof');await equal('cold actor mutation matches whole-site reference');await cold.close();
 for(let i=0;i<70;i++)await apply(['bounded=one;Secure;Path=/'],ctx('https://proof-'+i+'.test/'));
 check(ca.siteUsageProofs.size===64,'write-side proof cache is bounded to64sites across old actor and cold actor activity');
 check(compared>=190,'at least190 native states compared across deterministic mutations and old writers');
 IDBIndex.prototype.getAll=ga;IDBObjectStore.prototype.get=get;
 da.dispose();dr.dispose();await old.close();await ca.close();await rb.close();
 // Independent allowance fixture, including failed transaction rollback.
 const c='44444444-4444-4444-8444-444444444444',d='55555555-5555-4555-8555-555555555555',limits={maxCookies:4,maxCookiesPerSite:3,maxBytes:3000},qc=new Candidate(options(c,limits)),qr=new Reference(options(d,limits));
 const qnorm=value=>JSON.stringify(value,(_k,v)=>typeof v==='string'?v.replaceAll(c,'<quota>').replaceAll(d,'<quota>'):v);
 const q=async(lines,where)=>{const outcome=async jar=>{try{return {value:await jar.storeResponseCookies(lines,where)}}catch(e){return {error:e.name,message:e.message}}};const left=await outcome(qc),right=await outcome(qr);check(qnorm(left)===qnorm(right),'quota outcome agrees with whole-site writer');check(qnorm(await nativeState(qc))===qnorm(await nativeState(qr)),'quota commit/abort preserves exact native rows and aggregate');return left};
 await q(['a=one;Secure;Path=/','b=two;Secure;Path=/','soon=gone;Secure;Path=/;Max-Age=1'],B);await q(['other=one;Secure;Path=/'],A);
 const rejected=await q(['extra=blocked;Secure;Path=/'],B);check(rejected.error==='QuotaExceededError','site/global limit rejects growth atomically');now+=2000;check(!((await q(['extra=allowed;Secure;Path=/'],B)).error),'expiry cleanup can reclaim quota before growth rejection');
 const overBytes=await q(['a='+('x'.repeat(2800))+';Secure;Path=/'],B);check(overBytes.error==='QuotaExceededError','byte allowance failure aborts source/certificate together');
 await qc.close();await qr.close();
 // A rejected/no-change request on an empty profile must not create a certificate.
 const empty=new Candidate(options('66666666-6666-4666-8666-666666666666'));await empty.storeResponseCookies(['absent=;Secure;Path=/;Max-Age=0'],B);const edb=await empty.database,metaKeys=await new Promise((resolve,reject)=>{const t=edb.transaction('meta'),r=t.objectStore('meta').getAllKeys();t.oncomplete=()=>resolve(r.result);t.onabort=()=>reject(t.error)});check(metaKeys.length===0&&empty.siteUsageProofs.size===0,'empty-device bookkeeping does not seed local-data presence');await empty.close();
 return {assertions:checks.length,comparedStates:compared,checks};
});assert.deepEqual(pageErrors,[]);report.result='PASS';report.pageErrors=pageErrors;console.log(JSON.stringify({result:'PASS',assertions:report.checks.assertions,comparedStates:report.checks.comparedStates}));await context.close();
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1}
finally{await writeFile(resolve(E,'COOKIE_IDENTITY_CORRECTNESS.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close()}
