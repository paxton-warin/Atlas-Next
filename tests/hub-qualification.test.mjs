import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openStore } from '../server/store.mjs';
import { createNodePool } from '../server/node-pool.mjs';
import { createNodeQualification } from '../server/hub-qualification.mjs';
import { createNodeService } from '../server/node-service.mjs';
import { installHubEndpoints } from '../server/hub-endpoints.mjs';
import { verifyTicket } from '../server/node-ticket.mjs';
import { nodeControlSettings, nodeHeartbeatRequest } from '../server/node-control-settings.mjs';
const frontend='https://frontend.example',oldEndpoint='https://old-node.example',candidate='https://new-node.example';
const grant=()=>({userId:randomUUID(),profileId:randomUUID(),sessionId:randomUUID(),branchId:randomUUID(),contextId:randomUUID()});
async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'atlas-qualification-')),store=openStore(directory),pool=createNodePool(store,{runtimeOrigin:'https://runtime.example',localRelayMode:'frontend',sameOriginRuntime:true,profileRuntimeEngine:'scramjet-controller'}),created=pool.add({name:'Stable physical node',endpoint:oldEndpoint});
 const node=await createNodeService({id:created.id,secret:created.token,staticDir:'/not-built',runtimeOrigin:candidate});
 const calls=[],previous=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{calls.push({url,headers:init?.headers});if(String(url).startsWith(oldEndpoint))throw Error('Old public distribution is offline');if(!String(url).startsWith(candidate))throw Error('Unexpected network request');const u=new URL(url),r=await node.inject({method:init?.method||'GET',url:u.pathname,headers:init?.headers,payload:init?.body?JSON.parse(init.body):undefined});return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}})};
 const account=grant(),body={jobId:randomUUID(),planHash:'a'.repeat(64),probeAccountId:account.userId,stableNodeId:created.id,expectedCurrentEndpoint:oldEndpoint,candidateEndpoint:candidate,expiresAt:new Date(Date.now()+10*60000).toISOString()};
 const app=Fastify();const config={appOrigin:frontend,hubOrigin:'https://hub.example',hubServiceSecret:'qualification-service-secret-long-enough'};await installHubEndpoints(app,{config,store,pool});
 t.after(async()=>{globalThis.fetch=previous;await app.close();await node.close();store.db.close();rmSync(directory,{recursive:true,force:true})});
 return{store,pool,node,created,calls,account,body,app,headers:{authorization:'Bearer '+config.hubServiceSecret},stage:()=>pool.qualification.stage(body)};
}
test('scoped stage probes authenticated candidate and normal account flow issues an actual candidate-bound ticket while old endpoint is offline',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.created.id);assert.equal((await f.stage()).ok,true);
 const lease=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:f.account,hubValidatedAt:Date.now()});
 assert.equal(lease.node.id,f.created.id);assert.equal(lease.relayOrigin,candidate);
 const ticket=verifyTicket(lease.ticket,f.created.token,frontend);assert.equal(ticket.role,'frontend-controller-v2');assert.equal(ticket.relayOrigin,candidate);assert.equal(ticket.lease,lease.sessionHash);assert.ok(ticket.expires<=Date.parse(f.body.expiresAt));
 assert.equal(f.calls.some(c=>c.url===candidate+'/node/control'),true);assert.equal(f.calls.filter(c=>c.url.startsWith(candidate)).every(c=>c.headers.authorization==='Bearer '+f.created.token),true);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.created.id),before);
 const renew=await f.pool.frontendAssignments.operate({intent:'renew',session:lease.session,generation:lease.generation},frontend,{hubGrant:f.account,hubValidatedAt:Date.now()});assert.equal(renew.session,lease.session);assert.equal(renew.relayOrigin,candidate);
 const native=await f.pool.resourceOwner(lease.session,frontend,lease.generation);assert.equal(native.resourceOrigin,candidate);
 const control=f.pool.nodeState(f.created.id);assert.ok(control.grants.find(g=>g.hash===lease.sessionHash).expiresAt<=Date.parse(f.body.expiresAt));
 const other=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:grant(),hubValidatedAt:Date.now()});assert.equal(other.node.id,'local');assert.equal(other.relayOrigin,frontend);
});
test('paired heartbeat can maintain actual candidate health/control without marking offline old endpoint online for ordinary accounts',async t=>{
 const f=await fixture(t);await f.stage();await f.pool.heartbeat(f.created.id,f.created.token,3);assert.equal(f.pool.list().find(n=>n.id===f.created.id).online,false);assert.equal(f.store.db.prepare('SELECT seen FROM nodes WHERE id=?').get(f.created.id).seen,0);
 const probe=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:f.account,hubValidatedAt:Date.now()});assert.equal(probe.relayOrigin,candidate);
 assert.equal(f.calls.some(c=>c.url===oldEndpoint+'/node/health'),true);assert.equal(f.calls.some(c=>c.url===candidate+'/node/health'),true);
});
test('private qualification route rejects browser Origin/missing credentials and never returns secrets',async t=>{
 const f=await fixture(t);for(const h of[{},{...f.headers,origin:frontend},{...f.headers,origin:''}])assert.equal((await f.app.inject({method:'POST',url:'/api/internal/hub/qualification-aliases',headers:h,payload:f.body})).statusCode,401);
 const r=await f.app.inject({method:'POST',url:'/api/internal/hub/qualification-aliases',headers:f.headers,payload:f.body});assert.equal(r.statusCode,200);assert.equal(r.body.includes(f.created.token),false);assert.equal(r.body.includes(f.account.userId),false);
 assert.equal(typeof f.store.get('hubQualificationAliases'),'string');assert.equal(f.store.get('hubQualificationAliases').includes(candidate),false);
});
test('stage replay and renewal preserve immutable job/account/node/origin bindings and reject stale endpoint',async t=>{
 const f=await fixture(t);await f.stage();assert.equal((await f.stage()).replayed,true);assert.equal((await f.pool.qualification.stage({...f.body,expiresAt:new Date(Date.parse(f.body.expiresAt)+1000).toISOString()})).ok,true);
 for(const patch of[{planHash:'b'.repeat(64)},{candidateEndpoint:'https://changed.example'},{expectedCurrentEndpoint:'https://stale.example'},{expiresAt:new Date(Date.parse(f.body.expiresAt)-1000).toISOString()}])await assert.rejects(f.pool.qualification.stage({...f.body,...patch}));
 const active=f.store.unseal(f.store.get('hubQualificationAliases'));assert.equal(active.includes('https://changed.example'),false);
});
test('conflicting active account alias, oversized expiry and arbitrary fields never acquire routing authority',async t=>{
 const f=await fixture(t);await f.stage();for(const patch of[{jobId:randomUUID()},{expiresAt:new Date(Date.now()+16*60000).toISOString()},{arbitraryTicket:'no'},{stableNodeId:'local'}])await assert.rejects(f.pool.qualification.stage({...f.body,...patch}));
});
test('revocation fences only the qualified lease and ordinary account keeps its original pin',async t=>{
 const f=await fixture(t);await f.stage();const probe=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:f.account,hubValidatedAt:Date.now()}),other=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:grant(),hubValidatedAt:Date.now()});
 const revoke=Object.fromEntries(['jobId','planHash','probeAccountId','stableNodeId'].map(k=>[k,f.body[k]]));assert.equal(f.pool.qualification.remove(revoke).ok,true);assert.equal(f.pool.qualification.remove(revoke).replayed,true);
 assert.equal(f.pool.validHubLease(probe.sessionHash),false);assert.equal(f.pool.validHubLease(other.sessionHash),true);assert.equal(f.pool.nodeState(f.created.id).leases.includes(probe.sessionHash),false);
 await assert.rejects(f.pool.controllerRelay(probe.session,frontend,probe.generation),/expired/);
 const normal=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:f.account,hubValidatedAt:Date.now()});assert.equal(normal.node.id,'local');assert.equal(f.store.db.prepare('SELECT endpoint FROM nodes WHERE id=?').get(f.created.id).endpoint,oldEndpoint);
});
test('expiry persists on the issued lease even after process-local qualification object is recreated',async t=>{
 const f=await fixture(t);await f.stage();const lease=await f.pool.frontendAssignments.operate({intent:'new'},frontend,{hubGrant:f.account,hubValidatedAt:Date.now()});
 const after=createNodeQualification(f.store,{now:()=>Date.parse(f.body.expiresAt)+1});assert.equal(after.validLease(lease.sessionHash),false);assert.equal(after.preferredNode(f.account.userId),'');assert.throws(()=>after.resolve({hash:lease.sessionHash,node:f.created.id,generation:1},f.store.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.created.id)),/expired/);
});
test('stable heartbeat override uses exact private header without mutating persisted credentials or sending key to old origin',()=>{
 const credentials={id:'stable-node',secret:'node-fixture-secret',control:'https://retiring.cloudfront.net'},before=structuredClone(credentials),settings=nodeControlSettings({ATLAS_COORDINATOR_ORIGIN:'https://vps-1.internals.example',ATLAS_COORDINATOR_ORIGIN_KEY:'origin-key-fixture-long-enough'}),request=nodeHeartbeatRequest(credentials,5,settings);
 assert.equal(request.url.href,'https://vps-1.internals.example/api/nodes/heartbeat');assert.equal(request.init.headers['X-Atlas-Origin-Key'],'origin-key-fixture-long-enough');assert.equal(request.init.headers.authorization,'Bearer node-fixture-secret');assert.equal(request.init.redirect,'error');assert.deepEqual(credentials,before);assert.equal(JSON.stringify(JSON.parse(request.init.body)).includes('origin-key'),false);
 const legacy=nodeHeartbeatRequest(credentials,0,nodeControlSettings({}));assert.equal(legacy.url.origin,'https://retiring.cloudfront.net');assert.equal(legacy.init.headers['X-Atlas-Origin-Key'],undefined);
 for(const env of[{ATLAS_COORDINATOR_ORIGIN_KEY:'must-not-go-to-old-origin'},{ATLAS_COORDINATOR_ORIGIN:'http://insecure.example'},{ATLAS_COORDINATOR_ORIGIN:'https://valid.example/path'},{ATLAS_COORDINATOR_ORIGIN:'https://valid.example',ATLAS_COORDINATOR_ORIGIN_KEY:'contains\nheader-injection'}])assert.throws(()=>nodeControlSettings(env));
});
