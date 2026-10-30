import test from 'node:test';import assert from 'node:assert/strict';import {installProfileWebSocketTransport}from'../runtime/scramjet-websocket.ts';
const tick=()=>new Promise(r=>setImmediate(r));
test('normal WebSockets use acknowledged profile Cookie without changing selected transport or eager opens',async()=>{
 let resolve,seen,opens=0,sent=[];const cookie=new Promise(r=>resolve=r);const transport={connect(...args){seen=args;args[3]('proto','');return[v=>sent.push(v),()=>{}];}};
 const stop=installProfileWebSocketTransport(transport,{topLevelURL:()=> 'https://site.test/page',getRequestHeader:ctx=>{assert.equal(ctx.requestURL,'https://socket.test/a');assert.equal(ctx.documentURL,'https://site.test/');return cookie;}});
 const [send]=transport.connect(new URL('wss://socket.test/a'),[],[['Origin','https://site.test'],['Cookie','legacy=wrong']],()=>opens++,()=>{},()=>{},()=>{});send('queued');assert.equal(opens,0);assert.equal(seen,undefined);resolve('profile=durable');await tick();assert.equal(opens,1);assert.deepEqual(seen[2],[['Origin','https://site.test'],['Cookie','profile=durable']]);assert.deepEqual(sent,['queued']);stop();
});
test('closing pending normal socket never opens underlying connection after cookie readiness',async()=>{
 let resolve,calls=0,closes=[];const transport={connect(){calls++;return[()=>{},()=>{}]}};const stop=installProfileWebSocketTransport(transport,{topLevelURL:()=> 'https://site.test/',getRequestHeader:()=>new Promise(r=>resolve=r)});const[,close]=transport.connect(new URL('wss://site.test/socket'),[],[],()=>{},()=>{},(...v)=>closes.push(v),()=>{});close(1000,'closed');resolve('cookie=ready');await tick();assert.equal(calls,0);assert.deepEqual(closes,[[1000,'closed']]);stop();
});
