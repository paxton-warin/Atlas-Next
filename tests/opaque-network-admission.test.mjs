import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpaqueNetworkClient,OPAQUE_NETWORK_PROTOCOL} from '../runtime/opaque-runtime-adapter.ts';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const request=(n,extra={})=>({url:'https://site.test/resource/'+n,method:'GET',headers:[],credentials:'same-origin',mode:'cors',...extra});
function fixture(options={},automatic=false){
 const channel=new MessageChannel(),messages=[],inflight=new Set();let high=0;
 const client=createOpaqueNetworkClient({port:channel.port1,documentId:'network-admission',documentURL:'https://site.test/',...options});
 const reply=(m,error)=>{inflight.delete(m.sequence);channel.port2.postMessage({protocol:OPAQUE_NETWORK_PROTOCOL,documentId:'network-admission',type:error?'error':'response',sequence:m.sequence,...(error?{code:error}:{response:{url:m.request.url,status:200,statusText:'OK',headers:[],body:new TextEncoder().encode(m.request.url).buffer,type:'basic'}})})};
 channel.port2.onmessage=e=>{const m=e.data;messages.push(m);if(m.type==='fetch'){inflight.add(m.sequence);high=Math.max(high,inflight.size);if(automatic)setTimeout(()=>reply(m),1)}};
 return{client,messages,reply,get high(){return high},async wait(n){for(let i=0;i<2000&&messages.length<n;i++)await delay(1);assert.ok(messages.length>=n,'messages arrived '+messages.length+'/'+n)},close(){client.dispose();channel.port2.close()}};
}
test('bounded FIFO completes burst without more than32 posted requests or sequence gaps',async()=>{
 const s=fixture({},true);try{const results=await Promise.all(Array.from({length:160},(_,n)=>s.client.request(request(n))));assert.equal(results.length,160);assert.deepEqual(s.messages.map(m=>m.sequence),Array.from({length:160},(_,n)=>n+1));assert.deepEqual(s.messages.map(m=>m.request.url),Array.from({length:160},(_,n)=>request(n).url));assert.ok(s.high<=32);assert.equal(s.client.pending,0)}finally{s.close()}
});
test('queued abort consumes no protocol sequence and canceled posted slot waits for peer settlement',async()=>{
 const s=fixture({maxPending:1,timeoutMs:1000});try{const a=new AbortController(),b=new AbortController();const first=s.client.request(request('first'),a.signal);await s.wait(1);const second=s.client.request(request('aborted-queued'),b.signal),third=s.client.request(request('third'));b.abort();await assert.rejects(second,{name:'AbortError'});a.abort();await assert.rejects(first,{name:'AbortError'});await s.wait(2);assert.deepEqual(s.messages.map(m=>[m.sequence,m.type]),[[1,'fetch'],[2,'cancel']]);await delay(10);assert.equal(s.messages.length,2);s.reply(s.messages[0],'request_aborted');await s.wait(3);assert.equal(s.messages[2].sequence,3);assert.equal(s.messages[2].request.url,request('third').url);s.reply(s.messages[2]);await third;assert.equal(s.high,1)}finally{s.close()}
});
test('queue count and exact request-byte quota reject overflow without posting it',async()=>{
 const s=fixture({maxPending:1,timeoutMs:1000});const tasks=[];try{tasks.push(s.client.request(request('active')));await s.wait(1);for(let n=0;n<1024;n++)tasks.push(s.client.request(request('queued-'+n)));await assert.rejects(s.client.request(request('overflow')),{code:'concurrency_limit'});assert.equal(s.messages.length,1)}finally{s.close();await Promise.allSettled(tasks)}
 const q=fixture({maxPending:1,timeoutMs:1000});const active=q.client.request(request('active')),queued=[];try{await q.wait(1);for(let n=0;n<3;n++)queued.push(q.client.request(request(n,{method:'POST',body:new ArrayBuffer(1024*1024)})));await assert.rejects(q.client.request(request('bytes',{method:'POST',body:new ArrayBuffer(1024*1024)})),{code:'network_backpressure'});await assert.rejects(q.client.request(request('never-fit',{method:'POST',body:new ArrayBuffer(4*1024*1024)})),{code:'network_backpressure'});assert.equal(q.messages.length,1)}finally{q.close();await Promise.allSettled([active,...queued])}
});
test('posted byte admission snapshots queued input and does not exceed parent4MiB budget',async()=>{
 const s=fixture({timeoutMs:1000});const tasks=[];try{for(let n=0;n<4;n++)tasks.push(s.client.request(request(n,{method:'POST',body:new ArrayBuffer(1024*1024)})));await s.wait(3);await delay(5);assert.equal(s.messages.length,3);const body=new Uint8Array([17,23]),headers=[['x-test','original']],input=request('snapshot',{method:'POST',headers,body:body.buffer});const fifth=s.client.request(input);body[0]=99;headers[0][1]='mutated';for(let n=0;n<3;n++)s.reply(s.messages[n]);await s.wait(5);const sent=s.messages.find(m=>m.request.url.endsWith('/snapshot'));assert.equal(sent.request.headers[0][1],'original');assert.deepEqual([...new Uint8Array(sent.request.body)],[17,23]);for(const m of s.messages.slice(3))s.reply(m);await Promise.all([...tasks,fifth])}finally{s.close();await Promise.allSettled(tasks)}
});
test('total timeout includes queue; queued timeout sends no cancel, and dispose rejects all waiters',async()=>{
 const s=fixture({maxPending:1,timeoutMs:35});try{const first=s.client.request(request('first'));await s.wait(1);const second=s.client.request(request('queued'));const done=Promise.allSettled([first,second]);const result=await done;assert.deepEqual(result.map(r=>r.reason?.code),['network_timeout','network_timeout']);await s.wait(2);assert.deepEqual(s.messages.map(m=>m.type),['fetch','cancel']);assert.deepEqual(s.messages.map(m=>m.sequence),[1,2])}finally{s.close()}
 const q=fixture({maxPending:1});try{const tasks=[q.client.request(request(1)),q.client.request(request(2)),q.client.request(request(3))];q.client.dispose();const results=await Promise.allSettled(tasks);assert.ok(results.every(r=>r.reason?.code==='document_disposed'))}finally{q.close()}
});
