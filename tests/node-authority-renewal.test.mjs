import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import WebSocket from 'ws';
const source=process.env.ATLAS_SERVER_SOURCE||resolve('.');
const load=file=>import(pathToFileURL(join(source,'server',file)).href);
const {openStore}=await load('store.mjs');
const {createNodePool}=await load('node-pool.mjs');
const {createNodeService}=await load('node-service.mjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let i=0;i<200;i++){if(check())return;await tick();}assert.ok(check(),'condition did not settle');}

test('verified refresh pushes current remote authority before45s and90s; revocation still closes the real Wisp socket',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'atlas-renewal-')),nativeNow=Date.now;
 let clock=nativeNow(),remote,ws,pool;const t0=clock;Date.now=()=>clock;
 const store=openStore(dir);let credential;const origin='http://frontend.example';
 try{
  pool=createNodePool(store,{runtimeOrigin:'http://runtime.example'});
  remote=await createNodeService({staticDir:'/not-built',pairing:{verify:()=>true,save:value=>{credential=value}}});
  await remote.listen({host:'127.0.0.1',port:0});const endpoint='http://127.0.0.1:'+remote.server.address().port;
  const {id}=await pool.attach({name:'Renewal node',endpoint,code:'fixture'},origin);
  pool.update('local',{state:'disabled',weight:1});
  const lease=await pool.operate({},origin,endpoint);
  const grant={userId:randomUUID(),profileId:randomUUID(),sessionId:randomUUID(),branchId:randomUUID(),contextId:randomUUID()};
  pool.bindHubLease(lease.sessionHash,grant,t0);pool.setRequireHubOwnership(true);
  const relay=await pool.controllerRelay(lease.session,origin,lease.generation);
  ws=new WebSocket(endpoint.replace('http:','ws:')+'/relay/'+relay.ticket+'/',{origin});ws.on('error',()=>{});
  const first=once(ws,'message');await once(ws,'open');await first;
  for(const seconds of [30,60]){
   clock=t0+seconds*1000;store.db.prepare('UPDATE nodes SET seen=? WHERE id=?').run(clock,id);
   pool.refreshHubIdentity(grant,clock);
   if(pool.controlStats)await until(()=>pool.controlStats().pending===0);
   clock=t0+(seconds===30?46:91)*1000;
   assert.equal(pool.validHubLease(lease.sessionHash),true);
   remote.recheckConnections();await tick();
   assert.equal(ws.readyState,WebSocket.OPEN,'a fresh owner must not lose its relay to the previous45-second grant');
  }
  pool.revokeHubSession(grant.sessionId);
  if(pool.controlStats)await until(()=>pool.controlStats().pending===0);
  await until(()=>ws.readyState===WebSocket.CLOSED);
  assert.equal(pool.validHubLease(lease.sessionHash),false);
  pool.refreshHubIdentity(grant,clock);assert.equal(pool.validHubLease(lease.sessionHash),false,'old grant cannot revive a revoked owner');
  assert.throws(()=>pool.bindHubLease(lease.sessionHash,grant,clock),{code:'SESSION_REVOKED'});
  assert.equal(remote.performanceSnapshot().counters['relay-closed-revoked'].count,1);
  assert.ok(credential.secret); // the secret is never logged or added to evidence
 }finally{ws?.terminate();await pool?.close?.();await remote?.close();store.db.close();rmSync(dir,{recursive:true,force:true});Date.now=nativeNow;}
});

test('older authenticated control snapshots cannot erase a newer grant or reauthorize a revoked lease',async()=>{
 const secret='s'.repeat(43),node=await createNodeService({id:'node',secret,staticDir:'/not-built'});
 try{
  const hash='a'.repeat(64),current={revision:2,state:'active',leases:[hash],grants:[{hash,generation:2,expiresAt:Date.now()+90000}]};
  node.applyControl(current);node.applyControl({revision:1,state:'disabled',leases:[],grants:[]});
  // Observe a real purpose-bound upgrade; no fake success flags.
  const {signTicket}=await load('node-ticket.mjs');await node.listen({host:'127.0.0.1',port:0});
  const origin='http://frontend.example',endpoint='http://127.0.0.1:'+node.server.address().port;
  const ticket=signTicket({role:'frontend-controller-v2',node:'node',lease:hash,generation:2,origin,runtimeOrigin:origin,relayOrigin:endpoint,expires:Date.now()+90000},secret);
  const socket=new WebSocket(endpoint.replace('http:','ws:')+'/relay/'+ticket+'/',{origin});socket.on('error',()=>{});
  const first=once(socket,'message');await once(socket,'open');await first;
  node.applyControl({revision:3,state:'active',leases:[],grants:[],revoked:[hash]});
  await until(()=>socket.readyState===WebSocket.CLOSED);
  node.applyControl(current);assert.equal(node.connectionStats().activeSessions,0);
 }finally{await node.close();}
});
