import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {createEntryLaunchLinkReader,normalizeEntryLaunchLink} from '../server/entry-launch-link.mjs';
import {installHubBranch} from '../server/hub-branch.mjs';
const url='https://docs.google.com/document/d/1YcSpjvV7n1VJRXPRu-2k8CW2r-CDv9QEGToRxkTfwxY/edit?tab=t.0';
const config={url,hubEnabled:true,browserEnabled:false},disabled={url:'',hubEnabled:false,browserEnabled:false};
const response=v=>new Response(JSON.stringify(v));
test('public presentation normalization rejects malformed flags and non-HTTP destinations',()=>{
 assert.deepEqual(normalizeEntryLaunchLink(config),config);
 for(const raw of [null,[],{}, {...config,hubEnabled:'true'}, ...['javascript:alert(1)','data:text/html,x','https://a:b@example.com','//example.com','file:///tmp/a','https://example.com/'+'x'.repeat(2048)].map(url=>({...config,url}))])assert.deepEqual(normalizeEntryLaunchLink(raw),disabled);
 assert.equal(normalizeEntryLaunchLink({...config,url:'http://example.com/?q=1#two'}).url,'http://example.com/?q=1#two');
});
test('public read is single-flight with30s cache and forwards no user credentials',async()=>{
 let clock=0,calls=0,release;const gate=new Promise(r=>release=r);
 const read=createEntryLaunchLinkReader({now:()=>clock,fetch:async(target,init)=>{calls++;assert.equal(target,'https://hub.example/api/hub/launch-link');assert.deepEqual(init.headers,{accept:'application/json'});assert.equal(init.redirect,'error');assert.ok(init.signal);await gate;return response(config)}});
 const pending=Array.from({length:50},()=>read('https://hub.example'));release();assert.deepEqual(await Promise.all(pending),Array.from({length:50},()=>config));assert.equal(calls,1);clock=29999;await read('https://hub.example');assert.equal(calls,1);clock=30000;await read('https://hub.example');assert.equal(calls,2);
});
test('unavailable configuration fails closed and failure cache is bounded',async()=>{
 let calls=0,clock=0;const read=createEntryLaunchLinkReader({now:()=>clock,fetch:async()=>{calls++;throw Error('OFFLINE')}});assert.deepEqual(await read(''),disabled);assert.equal(calls,0);assert.deepEqual(await read('https://hub.example'),disabled);clock=4999;await read('https://hub.example');assert.equal(calls,1);clock=5000;await read('https://hub.example');assert.equal(calls,2);
 for(const fetch of [async()=>response({...config,url:'javascript:alert(1)'}),async()=>new Response('no',{status:503}),async()=>new Response('notjson')])assert.deepEqual(await createEntryLaunchLinkReader({fetch})('https://hub.example'),disabled);
});
test('origin changes cannot publish an old in-flight configuration',async()=>{
 let release;const gate=new Promise(r=>release=r);const read=createEntryLaunchLinkReader({fetch:async target=>{if(target.startsWith('https://old.example')){await gate;return response(config)}return response({...config,url:'https://new.example/'})}});const old=read('https://old.example');await read('https://new.example');release();await old;assert.equal((await read('https://new.example')).url,'https://new.example/');
});
test('authenticated announcement gateway preserves branch identity, CSRF and positive acknowledgement',async()=>{
 const app=Fastify(),calls=[];let state,mismatched=false;
 const announcementId=createHash('sha256').update(url).digest('hex');
 const grant={protocol:1,branchId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',profileId:'33333333-3333-4333-8333-333333333333',sessionId:'44444444-4444-4444-8444-444444444444',contextId:'context-fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),grantExpiresAt:new Date(Date.now()+300000).toISOString()};
 try{
  await installHubBranch(app,{config:{appOrigin:'https://atlas.example',hubOrigin:'https://hub.example',hubBranchId:grant.branchId,hubBranchSecret:'s'.repeat(43),hubUiOnlyLab:true},originFor:()=> 'https://atlas.example',seal:x=>Buffer.from(x).toString('base64url'),unseal:x=>Buffer.from(x,'base64url').toString(),fetch:async(target,init)=>{calls.push({target,init});if(target.endsWith('/exchange'))return response({branchSession:'t'.repeat(43),grant,state});if(target.endsWith('/ack'))return response({acknowledged:true,announcementId:mismatched?'0'.repeat(64):announcementId,token:'DO_NOT_FORWARD'});if(target.endsWith('/document-announcement'))return response({...config,announcementId,acknowledged:false,token:'DO_NOT_FORWARD'});if(target.endsWith('/launch-link'))return response(config);throw Error('UNEXPECTED_UPSTREAM_PATH')}});
  assert.equal((await app.inject('/api/hub/document-announcement')).statusCode,401);
  const pub=await app.inject('/api/hub/launch-link');assert.equal(pub.statusCode,200);assert.deepEqual(pub.json(),config);assert.equal(pub.headers['cache-control'],'no-store');
  const start=await app.inject({method:'POST',url:'/api/hub/signin',headers:{origin:'https://atlas.example'},payload:{}});state=new URL(start.json().redirect).searchParams.get('state');
  const done=await app.inject({url:'/auth/hub/callback?state='+state+'&code='+'c'.repeat(43),headers:{cookie:start.headers['set-cookie'].split(';')[0]}});assert.equal(done.statusCode,302);
  const cookie=done.headers['set-cookie'].find(v=>v.startsWith('__Host-atlas-hub=')).split(';')[0];const current=await app.inject({url:'/api/hub/state',headers:{cookie}}),csrf=current.json().csrf;
  const read=await app.inject({url:'/api/hub/document-announcement',headers:{cookie}});assert.equal(read.statusCode,200);assert.deepEqual(read.json(),{...config,announcementId,acknowledged:false});assert.equal(read.headers['cache-control'],'no-store');
  assert.equal((await app.inject({method:'POST',url:'/api/hub/document-announcement/ack',headers:{cookie,origin:'https://atlas.example'},payload:{announcementId}})).statusCode,403);
  const headers={cookie,origin:'https://atlas.example','x-atlas-hub-csrf':csrf};assert.equal((await app.inject({method:'POST',url:'/api/hub/document-announcement/ack',headers,payload:{announcementId,arbitraryUser:'other'}})).statusCode,400);
  const ack=await app.inject({method:'POST',url:'/api/hub/document-announcement/ack',headers,payload:{announcementId}});assert.equal(ack.statusCode,200);assert.deepEqual(ack.json(),{acknowledged:true,announcementId});
  const upstream=calls.find(c=>c.target.endsWith('/ack'));assert.equal(upstream.target,'https://hub.example/api/hub/branch/document-announcement/ack');assert.equal(upstream.init.headers['x-atlas-branch-session'],'t'.repeat(43));assert.deepEqual(JSON.parse(upstream.init.body),{announcementId});
  mismatched=true;assert.equal((await app.inject({method:'POST',url:'/api/hub/document-announcement/ack',headers,payload:{announcementId}})).statusCode,502);
 }finally{await app.close()}
});
