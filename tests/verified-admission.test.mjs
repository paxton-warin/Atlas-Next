import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const {createApp}=await import(pathToFileURL(join(process.env.ATLAS_SERVER_SOURCE||resolve('.'),'server/app.mjs')).href);
import {digest} from '../server/store.mjs';
import {createRequestLimits} from '../server/request-limits.mjs';
const origin='https://atlas.example',branchId=randomUUID();
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'atlas-verified-admission-')),subjects=new Map();let calls=0,hold;
 const app=await createApp({dataDir:dir,staticDir:'/not-built',appOrigin:origin,runtimeOrigin:'https://runtime.example',dynamicOrigins:false,
  hubOrigin:'https://hub.example',hubBranchId:branchId,hubBranchSecret:'s'.repeat(43),hubUiOnlyLab:true,hubServiceSecret:'control-'.repeat(6),hubControlMutations:true,
  hubFetch:async(url,options)=>{calls++;if(hold)await hold;const grant=subjects.get(options.headers['x-atlas-branch-session']);return new Response(JSON.stringify(grant?{grant}:{error:{code:'HUB_SESSION_EXPIRED'}}),{status:grant?200:401});}});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const cookie=(id='a',contextId=randomUUID())=>{const token=id.repeat(43),grant={protocol:1,branchId,userId:randomUUID(),profileId:randomUUID(),sessionId:randomUUID(),contextId,expiresAt:new Date(Date.now()+3600000).toISOString(),grantExpiresAt:new Date(Date.now()+300000).toISOString()};subjects.set(token,grant);
 return '__Host-atlas-hub='+app.store.seal(JSON.stringify({generation:1,token,grant,csrf:'c'.repeat(43),origin}));};
 const headers={origin,cookie:'__Host-atlas-admin=owner','x-atlas-csrf':'csrf'};
 app.store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest('owner'),'csrf',Date.now(),Date.now());
 return {app,cookie,get calls(){return calls},setHold(value){hold=value},async caps(api){const r=await app.inject({method:'POST',url:'/api/internal/hub/control',headers:{authorization:'Bearer '+'control-'.repeat(6)},payload:{operation:'requestLimits.update',input:{rules:{api:{max:api},browse:{max:2}}}}});assert.equal(r.statusCode,200,r.body);}};
}
test('same NAT valid identities receive unchanged per-account ceiling; anonymous and forged attempts retain IP ceiling',async t=>{
 const f=await fixture(t);await f.caps(2);const a=f.cookie('a'),b=f.cookie('b');
 const get=cookie=>f.app.inject({url:'/api/hub/state',remoteAddress:'198.51.100.10',headers:cookie?{cookie}:{'x-atlas-user-id':'forged'}});
 for(let i=0;i<2;i++){assert.equal((await get(a)).json().authenticated,true);assert.equal((await get(b)).json().authenticated,true);}
 assert.equal((await get(a)).statusCode,429);assert.equal((await get(b)).statusCode,429);
 assert.equal((await get()).json().authenticated,false);assert.equal((await get()).json().authenticated,false);assert.equal((await get()).statusCode,429);
 assert.equal((await f.app.inject({url:'/api/internal/hub/control'})).statusCode,401);
 const metrics=await f.app.inject({url:'/api/internal/hub/control',headers:{authorization:'Bearer '+'control-'.repeat(6)}});assert.equal(metrics.statusCode,200);assert.ok(metrics.json().performance.main.eventLoop);
});
test('concurrent same-context verification uses one Hub request, but foreign contexts fail identity checks',async t=>{
 const f=await fixture(t);const cookie=f.cookie('c');let release;f.setHold(new Promise(resolve=>{release=resolve}));
 const pending=Array.from({length:25},()=>f.app.inject({url:'/api/hub/state',headers:{cookie}}));
 await new Promise(resolve=>setTimeout(resolve,15));const callsAtHold=f.calls;release();const values=await Promise.all(pending);assert.equal(callsAtHold,1);assert.ok(values.every(r=>r.statusCode===200&&r.json().authenticated===true));
 const raw=cookie.slice(cookie.indexOf('=')+1),value=JSON.parse(f.app.store.unseal(raw));value.grant.contextId=randomUUID();
 const foreign='__Host-atlas-hub='+f.app.store.seal(JSON.stringify(value));const denied=await f.app.inject({url:'/api/hub/state',headers:{cookie:foreign}});
 assert.equal(denied.json().authenticated,false);assert.equal(f.calls,2,'Rejected context must not trigger duplicate verification within the same HTTP request.');
});
test('verified browse allowances preserve configured caps even for whitelisted IPs; arbitrary subject input is rejected',()=>{
 const budgets=new Map(),store={get:()=>({enabled:true,whitelist:['198.51.100.10'],aiConcurrent:2,rules:{api:{max:2,windowSeconds:60},browse:{max:1,windowSeconds:60},suggestions:{max:120,windowSeconds:60},login:{max:8,windowSeconds:900},ticket:{max:5,windowSeconds:3600},'node-heartbeat':{max:120,windowSeconds:60},ai:{max:20,windowSeconds:3600}}})};
 const policy=createRequestLimits(store,(key,max)=>{const n=(budgets.get(key)||0)+1;budgets.set(key,n);if(n>max)throw Object.assign(Error('limited'),{statusCode:429});});
 policy.limitVerified('a/profile','browse');policy.limitVerified('b/profile','browse');assert.throws(()=>policy.limitVerified('a/profile','browse'),{statusCode:429});assert.throws(()=>policy.limitVerified('', 'api'),{statusCode:400});assert.throws(()=>policy.limitVerified('a','login'),/Unknown/);
});

test('verified config/catalog/support notification reads avoid shared NAT collision, while public anonymous reads retain original behavior',async t=>{
 const f=await fixture(t);await f.caps(4);const a=f.cookie('d'),b=f.cookie('e');
 for(const cookie of [a,b])for(const url of ['/api/config','/api/catalog','/api/hub/support/notifications']){
  const response=await f.app.inject({url,remoteAddress:'198.51.100.77',headers:{cookie}});assert.equal(response.statusCode,200,response.body);
 }
 const calls=f.calls;assert.equal(calls,4,'Two identity verifications plus two forwarded notifications, not one verification per route.');
 for(const url of ['/api/config','/api/catalog'])assert.equal((await f.app.inject({url,remoteAddress:'198.51.100.77'})).statusCode,200);
 for(let i=0;i<2;i++)assert.equal((await f.app.inject({url:'/api/config',remoteAddress:'198.51.100.77'})).statusCode,200);
 assert.equal((await f.app.inject({url:'/api/catalog',remoteAddress:'198.51.100.77'})).statusCode,429);
});

test('announcement detail/read use verified per-account caps, never arbitrary support paths or query variants',async t=>{
 const f=await fixture(t);await f.caps(2);const a=f.cookie('g'),b=f.cookie('h');
 const path='/api/hub/support/announcements/77777777-7777-4777-8777-777777777777';
 const headers=cookie=>({cookie,origin,'x-atlas-hub-csrf':'c'.repeat(43)});
 for(const cookie of[a,b]){
  assert.equal((await f.app.inject({url:path,remoteAddress:'198.51.100.91',headers:headers(cookie)})).statusCode,200);
  assert.equal((await f.app.inject({method:'POST',url:path+'/read',remoteAddress:'198.51.100.91',headers:headers(cookie),payload:{}})).statusCode,200);
  assert.equal((await f.app.inject({url:path,remoteAddress:'198.51.100.91',headers:headers(cookie)})).statusCode,429);
 }
 const before=f.calls;
 for(const url of[path+'?x=forged',path+'/withdraw'])assert.equal((await f.app.inject({url,remoteAddress:'198.51.100.92',headers:headers(a)})).statusCode,404);
 assert.equal(f.calls,before,'Invalid paths must not use Hub validation or forwarding.');
 assert.equal((await f.app.inject({url:path,remoteAddress:'198.51.100.93',headers:{'x-atlas-user-id':'forged'}})).statusCode,401);
});
