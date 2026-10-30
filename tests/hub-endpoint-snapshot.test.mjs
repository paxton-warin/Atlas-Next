import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../server/store.mjs';
import { createNodePool } from '../server/node-pool.mjs';
import { installHubEndpoints } from '../server/hub-endpoints.mjs';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'atlas-snapshot-')),store=openStore(dir),pool=createNodePool(store,{runtimeOrigin:'https://runtime.example'});
 const node=pool.add({name:'Do not export owner labels',endpoint:'https://node.example'});
 const config={appOrigin:'https://a.example',hubOrigin:'https://hub.example',hubServiceSecret:'service-control-secret-fixture-123456789',hubBranchId:randomUUID(),hubBranchSecret:'s'.repeat(43)};
 let probes=0;const app=Fastify({trustProxy:'loopback'});await installHubEndpoints(app,{config,store,pool,fetch:async()=>{probes++;throw Error('No network permitted in read-only snapshot')}});
 const headers={host:'coordinator.example','x-forwarded-proto':'https',authorization:'Bearer '+config.hubServiceSecret};
 t.after(async()=>{await app.close();store.db.close();rmSync(dir,{recursive:true,force:true})});
 return{app,store,pool,node,config,headers,probes:()=>probes,get:extra=>app.inject({method:'GET',url:'/api/internal/hub/endpoints',headers:{...headers,...extra}})};
}
test('private snapshot requires service authorization and denies any browser Origin',async t=>{
 const f=await fixture(t);for(const headers of [{authorization:''},{authorization:'Bearer incorrect'},{origin:'https://a.example'},{origin:''}])assert.equal((await f.get(headers)).statusCode,401);
 f.config.hubServiceSecret='short';assert.equal((await f.get()).statusCode,503);
});
test('authoritative snapshot returns exact schema and no credentials, names, hashes or ciphertext',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT * FROM nodes ORDER BY id').all();
 const response=await f.get();assert.equal(response.statusCode,200);const b=response.json();
 assert.deepEqual(Object.keys(b).sort(),['branches','format','generation','hubOrigin','nodes','observedAt','origin'].sort());
 assert.equal(b.format,'atlas-coordinator-endpoint-snapshot-v1');assert.equal(b.origin,'https://coordinator.example');assert.equal(b.generation,0);assert.equal(b.hubOrigin,f.config.hubOrigin);assert.ok(Math.abs(Date.now()-Date.parse(b.observedAt))<5000);
 assert.deepEqual(b.nodes,[{id:f.node.id,endpoint:'https://node.example'}]);assert.deepEqual(b.branches,[{origin:'https://a.example',id:f.config.hubBranchId,generation:1,transitionRevision:0,transitionActive:false}]);
 for(const secret of[f.config.hubBranchSecret,f.config.hubServiceSecret,'credential','secret','Do not export owner labels'])assert.equal(response.body.includes(secret),false);
 assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(f.probes(),0);assert.deepEqual(f.store.db.prepare('SELECT * FROM nodes ORDER BY id').all(),before);
 assert.equal(f.store.get('hubEndpointRevision'),null);assert.equal(f.store.get('hubBranchRegistry'),null);
});
test('sealed registry overrides configured fallback and preserves inactive transition revision',async t=>{
 const f=await fixture(t),id=randomUUID();f.config.hubBranches=[{origin:'https://b.example',id:randomUUID(),secret:'b'.repeat(43),generation:2,transition:{revision:99,active:true}}];
 f.store.set('hubBranchRegistry',{'https://a.example':f.store.seal(JSON.stringify({id,secret:'q'.repeat(43),generation:4,transition:{revision:7,active:false}}))});
 f.store.set('hubEndpointRevision',{generation:3,hash:'never-export'});f.store.set('hubCurrentOrigin','https://new-hub.example');
 const b=(await f.get()).json();assert.equal(b.generation,3);assert.equal(b.hubOrigin,'https://new-hub.example');assert.deepEqual(b.branches,[{origin:'https://a.example',id,generation:4,transitionRevision:7,transitionActive:false},{origin:'https://b.example',id:f.config.hubBranches[0].id,generation:2,transitionRevision:0,transitionActive:false}]);
});
test('configured array precedence exactly matches actual branch gateway over initial fallback',async t=>{
 const f=await fixture(t),id=randomUUID();f.config.hubBranches=[{origin:f.config.appOrigin,id,secret:'x'.repeat(43),generation:6}];assert.equal((await f.get()).json().branches[0].id,id);
});
test('corrupt sealed entry fails complete snapshot instead of silently omitting peers, then read transaction rolls back',async t=>{
 const f=await fixture(t);f.store.set('hubBranchRegistry',{'https://bad.example':'not-encrypted'});const r=await f.get();assert.equal(r.statusCode,503);assert.equal(r.body.includes('not-encrypted'),false);
 f.store.set('hubBranchRegistry',{});assert.equal((await f.get()).statusCode,200);assert.equal(f.store.get('hubEndpointRevision'),null);
});
test('malformed stored generations/origins/transitions and query-selected targets never qualify',async t=>{
 const f=await fixture(t);
 for(const entry of [{id:f.config.hubBranchId,secret:'s'.repeat(43),generation:0},{id:f.config.hubBranchId,secret:'s'.repeat(43),generation:1,transition:{revision:0,active:true}}]){
  f.store.set('hubBranchRegistry',{'https://a.example':f.store.seal(JSON.stringify(entry))});assert.equal((await f.get()).statusCode,503);
 }
 f.store.set('hubBranchRegistry',{});f.store.set('hubEndpointRevision',{generation:-1});assert.equal((await f.get()).statusCode,503);f.store.set('hubEndpointRevision',{generation:0});
 const q=await f.app.inject({method:'GET',url:'/api/internal/hub/endpoints?target=https://another.example',headers:f.headers});assert.equal(q.statusCode,400);assert.equal(f.probes(),0);
});
