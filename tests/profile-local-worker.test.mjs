import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileLocalStore } from '../web/src/profile-local-store.ts';
import { installProfileLocalWorker, PROFILE_LOCAL_PROTOCOL } from '../runtime/profile-local-worker.ts';
const profile='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{initializeError=false,timeoutMs=1000}={}){
 const events=new EventTarget(),sent=[];let terminated=0;
 const worker={addEventListener:(...a)=>events.addEventListener(...a),removeEventListener:(...a)=>events.removeEventListener(...a),terminate:()=>{terminated++},postMessage:data=>{sent.push(data);if(data.operation==='initialize')queueMicrotask(()=>reply(data.id,initializeError?{ok:false,error:{name:'Error',message:'INITIALIZATION_FAILURE'}}:{ok:true}))}};
 function reply(id,data){events.dispatchEvent(new MessageEvent('message',{data:{protocol:PROFILE_LOCAL_PROTOCOL,id,...data}}))}
 const store=createProfileLocalStore(profile,{createWorker:()=>worker,timeoutMs});t.after(()=>store.dispose());
 return{store,sent,reply,events,terminated:()=>terminated};
}
test('trusted local adapter initializes exactly one immutable profile and coalesces no queue acknowledgements',async t=>{
 const f=fixture(t),list=f.store.queue.list(),head=f.store.readHead({kind:'local',origin:'https://game.example'});await tick();
 assert.deepEqual(f.sent.map(v=>v.operation),['initialize','queue-list','read-head']);assert.deepEqual(f.sent[0].args,[profile]);
 f.reply(f.sent[2].id,{ok:true,value:{revision:4,epoch:8}});f.reply(f.sent[1].id,{ok:true,value:[]});
 assert.deepEqual(await list,[]);assert.deepEqual(await head,{revision:4,epoch:8});assert.equal(f.terminated(),0);
});
test('native structured values cross only structured-clone transport without JSON serialization',async t=>{
 const f=fixture(t),snapshot={binary:new Uint8Array([0,255]),date:new Date('2026-10-21T00:00:00Z'),map:new Map([['k',new Blob(['bytes'])]])};
 const p=f.store.restore({kind:'idb',origin:'https://game.example',name:'save'},snapshot,[],{revision:1,epoch:2});await tick();
 const message=structuredClone(f.sent.at(-1));assert.deepEqual(message.args[1].binary,new Uint8Array([0,255]));assert.equal(message.args[1].date.toISOString(),snapshot.date.toISOString());assert.equal(await message.args[1].map.get('k').text(),'bytes');
 f.reply(message.id,{ok:true});await p;
});
test('worker failures reject all exact in-flight calls and do not invent successful writes or retry',async t=>{
 const f=fixture(t),a=f.store.queue.list(),b=f.store.setPermit({profileId:profile,group:'example',contextId:'context',epoch:1,expiresAt:0,offline:false,revoked:true});
 const outcomes=Promise.allSettled([a,b]);await tick();f.events.dispatchEvent(new Event('error'));
 assert.equal((await outcomes).every(r=>r.status==='rejected'&&r.reason.message==='PROFILE_LOCAL_WORKER_FAILED'),true);assert.equal(f.terminated(),1);
 await assert.rejects(f.store.queue.list(),/PROFILE_LOCAL_DISPOSED/);assert.equal(f.sent.length,3);
});
test('a bounded timeout terminates uncertain work and preserves its failure rather than auto repeating it',async t=>{
 const f=fixture(t,{timeoutMs:15});await assert.rejects(f.store.queue.list(),{name:'TimeoutError'});assert.equal(f.terminated(),1);assert.equal(f.sent.length,2);
});
test('initialization failure stays observable and no uninitialized storage request is sent',async t=>{
 const f=fixture(t,{initializeError:true});await assert.rejects(f.store.queue.list(),/INITIALIZATION_FAILURE/);await assert.rejects(f.store.exportSnapshots(),/INITIALIZATION_FAILURE/);assert.equal(f.sent.length,1);
});
test('malformed responses fail closed while stale or different protocol replies cannot acknowledge a request',async t=>{
 const f=fixture(t),p=f.store.queue.list();const outcome=Promise.allSettled([p]);await tick();
 f.events.dispatchEvent(new MessageEvent('message',{data:{protocol:'other',id:f.sent[1].id,ok:true,value:[]}}));
 f.reply(99999,{ok:true,value:[]});f.reply(f.sent[1].id,{ok:'yes'});
 assert.equal((await outcome)[0].reason.message,'PROFILE_LOCAL_RESPONSE_INVALID');assert.equal(f.terminated(),1);
});
function workerFixture(){let listener;const results=[];let opens=0;installProfileLocalWorker({indexedDB:{open(){opens++;throw Error('UNEXPECTED_DATABASE_ACCESS')}},postMessage:v=>results.push(v),addEventListener:(_t,fn)=>{listener=fn}});let id=0;const send=async(operation,args=[])=>{const n=++id;listener({data:{protocol:PROFILE_LOCAL_PROTOCOL,id:n,operation,args}});await tick();return results.find(v=>v.id===n)};return{send,opens:()=>opens};}
const change=()=>({entry:{id:'change-1',profileId:profile,kind:'cookies',origin:'https://game.example',payload:{changes:[]}},database:'atlas.browsing.cookies.v2:profile:'+profile,store:'meta',key:'outbox:change-1',arrayKeys:false});
test('worker binds profile once and rejects a second initialization',async()=>{
 const f=workerFixture();assert.equal((await f.send('initialize',[profile])).ok,true);assert.equal((await f.send('initialize',['22222222-2222-4222-8222-222222222222'])).error.message,'PROFILE_LOCAL_INITIALIZATION_INVALID');assert.equal(f.opens(),0);
});
test('fixed operation allowlist denies unknown databases, wrong profile, stores, and non-outbox keys before IDB access',async()=>{
 for(const modify of [c=>{c.database='administrator-data'},c=>{c.entry.profileId='22222222-2222-4222-8222-222222222222'},c=>{c.store='cookies'},c=>{c.key='profile-cloud-head:other'},c=>{c.entry.kind='atlas'}]){
  const f=workerFixture();await f.send('initialize',[profile]);const c=change();modify(c);const result=await f.send('queue-acknowledge',[c,{revision:1,epoch:1}]);assert.equal(result.ok,false);assert.equal(f.opens(),0);
 }
 const f=workerFixture();await f.send('initialize',[profile]);assert.equal((await f.send('run-shell',['anything'])).error.message,'PROFILE_LOCAL_OPERATION_INVALID');assert.equal((await f.send('set-permit',[{profileId:'22222222-2222-4222-8222-222222222222'}])).error.message,'PROFILE_LOCAL_PERMIT_INVALID');assert.equal(f.opens(),0);
});

// A website-specific preparation must not turn back into an all-account scan
// at the trusted worker boundary. Arguments are explicit, not caller metadata.
test('site-scoped queue discovery and pending namespace lookup preserve their group across worker RPC',async t=>{
 const f=fixture(t),group='example.com';
 const a=f.store.queue.list(group),b=f.store.pendingNamespaces(group);await tick();
 assert.deepEqual(f.sent.slice(1).map(v=>({operation:v.operation,args:v.args})),[
  {operation:'queue-list',args:[group]},{operation:'queue-namespaces',args:[group]},
 ]);
 for(const message of f.sent.slice(1))f.reply(message.id,{ok:true,value:[]});
 assert.deepEqual(await a,[]);assert.deepEqual(await b,[]);
});
