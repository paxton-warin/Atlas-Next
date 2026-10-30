import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createPerformanceMetrics,sanitizePerformanceMetrics} from '../server/performance-metrics.mjs';
import {guardedSocket} from '../server/runtime.mjs';
import {createDestinationResolver} from '../server/destination-resolver.mjs';
test('performance counters are fixed-cardinality, finite, copied and do not retain destination or content',()=>{
 const m=createPerformanceMetrics();try{
  m.record('dns',2);m.record('dns',4);m.record('https://private-text.example',8);m.record('tcp',NaN);m.record('tcp',-1);
  const first=m.snapshot();assert.deepEqual(first.counters,{dns:{count:2,total:6,max:4}});first.counters.dns.max=1000;assert.equal(m.snapshot().counters.dns.max,4);
  const safe=sanitizePerformanceMetrics({...first,secret:'must-not-copy',counters:{...first.counters,unbounded:{count:1,total:2,max:2},tcp:{count:1,total:Infinity,max:3}}});assert.doesNotMatch(JSON.stringify(safe),/secret|must-not-copy|unbounded|Infinity/);
 }finally{m.close();}
});
test('event-loop windows roll independently of readers, include ELU and retain only bounded numeric metadata',async()=>{
 const m=createPerformanceMetrics({windowMs:25,historyWindows:3});
 try{
  await new Promise(resolve=>setTimeout(resolve,160));
  const a=m.snapshot();assert.equal(a.eventLoop.recentWindows.length,3);
  assert.ok(a.eventLoop.recentWindows.every(w=>w.endedAt>0&&w.durationMs>=20&&w.utilization>=0&&w.utilization<=1&&Number.isSafeInteger(w.samples)));
  const before=a.eventLoop.recentWindows.at(-1).endedAt;a.eventLoop.recentWindows[0].maxMs=99999;
  assert.notEqual(m.snapshot().eventLoop.recentWindows[0].maxMs,99999);
  const sanitized=sanitizePerformanceMetrics({...a,eventLoop:{...a.eventLoop,recentWindows:[{...a.eventLoop.recentWindows[0],secret:'discard'}, {endedAt:Infinity}]}});
  assert.equal(sanitized.eventLoop.recentWindows.length,1);assert.doesNotMatch(JSON.stringify(sanitized),/secret|discard|Infinity/);
  m.close();await new Promise(resolve=>setTimeout(resolve,60));assert.equal(m.snapshot().eventLoop.recentWindows.at(-1).endedAt,before);
 }finally{m.close();}
});
test('DNS telemetry distinguishes shared lookup and cache hit without recording hostnames',async()=>{
 const events=[];let release;const resolver=createDestinationResolver({lookup:()=>new Promise(resolve=>{release=resolve}),onMetric:(...v)=>events.push(v)});
 const a=resolver('public.example'),b=resolver('public.example');await Promise.resolve();release([{address:'8.8.8.8',family:4}]);await Promise.all([a,b]);await resolver('public.example');
 assert.equal(events.filter(e=>e[0]==='dns-lookup').length,1);assert.equal(events.filter(e=>e[0]==='dns-coalesced').length,1);assert.equal(events.filter(e=>e[0]==='dns-cache-hit').length,1);assert.doesNotMatch(JSON.stringify(events),/public\.example|8\.8/);
});
test('real local guarded TCP records resolver/connect/first-inbound byte/queue aggregates only',async()=>{
 const target=createServer(socket=>socket.on('data',bytes=>socket.write(bytes)));await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));const port=target.address().port,m=createPerformanceMetrics(),saved={};
 for(const k of ['NODE_ENV','ATLAS_TEST_FIXTURE','ATLAS_TEST_FIXTURE_PORT'])saved[k]=process.env[k];
 process.env.NODE_ENV='test';process.env.ATLAS_TEST_FIXTURE='1';process.env.ATLAS_TEST_FIXTURE_PORT=String(port);
 let tcp;try{
  const Tcp=guardedSocket({fixture:true,metrics:m});tcp=new Tcp('127.0.0.1',port);await tcp.connect();await tcp.send(Buffer.from('synthetic'));assert.equal((await tcp.recv()).toString(),'synthetic');
  const s=m.snapshot();for(const key of ['dns','tcp','first-byte','tcp-queue','tcp-bytes-in','tcp-bytes-out'])assert.ok(s.counters[key]);assert.doesNotMatch(JSON.stringify(s),/127\.0|synthetic/);
 }finally{await tcp?.close();await new Promise(resolve=>target.close(resolve));m.close();for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
