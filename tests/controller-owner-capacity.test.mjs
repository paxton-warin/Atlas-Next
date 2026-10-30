import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const tree=process.env.ATLAS_CAPACITY_TREE;
const {createApp}=await import(tree?pathToFileURL(resolve(tree,'server/app.mjs')).href:'../server/app.mjs');
const origin='https://capacity.example';
async function fixture(t,options={}){
 const dataDir=mkdtempSync(join(tmpdir(),'atlas-owner-capacity-'));
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const app=await createApp({dataDir,staticDir:'/not-built',appOrigin:origin,dynamicOrigins:false,runtimeOrigin:'https://runtime.invalid',localRelayMode:'frontend',opaqueRuntimeEnabled:true,...options});
 t.after(()=>app.close());
 // Distinct synthetic client addresses avoid conflating global owner admission
 // with the unchanged per-IP API rate limit. No production traffic is sent.
 let client=0;
 const post=(url,payload={},headers={})=>{const n=++client;return app.inject({method:'POST',url,payload,remoteAddress:`198.18.${n>>8}.${n&255}`,headers:{origin,...headers}});};
 const b=await post('/api/browse/controller/bootstrap');assert.equal(b.statusCode,200);
 const grant=await post('/api/browse/controller/session',{intent:'new',requestId:b.json().requestId},{cookie:b.headers['set-cookie'].split(';')[0]});assert.equal(grant.statusCode,200);
 const s=grant.json(),headers={'x-atlas-browse-session':s.session,'x-atlas-browse-generation':String(s.generation)};
 return{app,post,headers};
}
test('one frontend process admits 1001 authenticated contexts per family without the old 256-owner ceiling',{timeout:20000},async t=>{
 const {post,headers}=await fixture(t);
 for(const family of ['storage','cookies'])for(let i=1;i<=1001;i++){
  const r=await post(`/api/browse/${family}/owners`,{},headers);
  assert.equal(r.statusCode,200,`${family} authenticated context ${i}: ${r.json().code||r.json().error||'registration rejected'}`);
 }
 console.log('OWNER_CAPACITY=PASS admitted_storage=1001 admitted_cookies=1001 local_only=true no_browser_workload_claim=true');
});
test('configured admission cap applies equally to both families without relaxing authentication',async t=>{
 const {post,headers}=await fixture(t,{controllerOwnerLimit:2});
 for(const family of ['storage','cookies']){
  const path=`/api/browse/${family}/owners`;
  assert.equal((await post(path)).statusCode,401);
  assert.equal((await post(path,{},headers)).statusCode,200);
  assert.equal((await post(path,{},headers)).statusCode,200);
  assert.equal((await post(path,{},headers)).statusCode,429);
 }
});
test('invalid admission limits fail before creating persistent data',async t=>{
 for(const controllerOwnerLimit of [0,-1,1.5,8193,NaN,'2048']){
  const dataDir=mkdtempSync(join(tmpdir(),'atlas-owner-invalid-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  await assert.rejects(createApp({dataDir,controllerOwnerLimit}),/ATLAS_CONTROLLER_MAX_OWNERS/);
 }
});
