import test from 'node:test';import assert from 'node:assert/strict';
import {createProfileHydration} from '../runtime/profile-hydration.ts';
import {createProfileWirePlanner} from '../runtime/profile-wire.ts';
import {HUB_LIMITS,encodePortableValue,decodePortableValue} from '../runtime/hub-contracts.ts';
const namespace={kind:'idb',origin:'https://save.example',name:'game'};
const spec=(extra={})=>({namespace,revision:1,snapshotRevision:1,journal:[],head:{revision:1,epoch:2},operation:'restore',...extra});
function fixture(){let restored,compacted;const wire=createProfileWirePlanner();const hydration=createProfileHydration(wire,{restore:async(...args)=>{restored=args},compact:async(n,s)=>{compacted={n,s};return s.snapshot}});return{wire,hydration,get restored(){return restored},get compacted(){return compacted}}}
async function feed(f,h,index,value){const encoded=await f.wire.prepare(value);if(!encoded.handle){await f.hydration.value(h,index,encoded);return encoded}const manifest={codec:'atlas-chunks-v1',bytes:encoded.bytes,hashes:encoded.hashes,sha256:encoded.sha256};await f.hydration.value(h,index,manifest);for(let i=0;i<encoded.hashes.length;i++){const part=await f.wire.chunk(encoded.handle,i);const v=JSON.parse(await part.body.text());assert.equal(await f.hydration.chunk(h,i,v.data),undefined)}f.wire.release(encoded.handle);return manifest}
test('worker-resident inline restore preserves native cycles, sparse arrays, binary, Date, Blob and journal order without returning native values',async()=>{
 const f=fixture(),array=Array(4);array[3]=new Uint8Array([0,255]);const value={date:new Date('2026-10-22'),blob:new Blob(['hello']),array,map:new Map([['x',new Set([2n])]])};value.self=value;
 const h=f.hydration.begin(spec({revision:2,journal:[{revision:2,mode:'journal'}],head:{revision:2,epoch:2}}));
 assert.equal(await f.hydration.value(h,0,await encodePortableValue(value)),undefined);assert.equal(f.restored,undefined);await feed(f,h,1,{operation:'put',value:'new'});assert.equal(await f.hydration.finish(h),undefined);
 const v=f.restored[1];assert.equal(v.self,v);assert.equal(0 in v.array,false);assert.deepEqual([...v.array[3]],[0,255]);assert.equal(await v.blob.text(),'hello');assert.equal(v.map.get('x').has(2n),true);assert.equal(f.restored[2][0].revision,2);assert.equal(f.restored[2][0].payload.value,'new');
});
test('chunked snapshot stays worker-resident, verifies exact hashes, and compaction returns byte-identical encoded wire',async()=>{
 const f=fixture(),value={binary:new Uint8Array(1024*1024)};value.binary[777]=255;value.self=value;const h=f.hydration.begin(spec({operation:'compact'}));const original=await feed(f,h,0,value);const result=await f.hydration.finish(h);
 assert.equal(f.compacted.s.snapshot.self,f.compacted.s.snapshot);assert.equal(f.compacted.s.snapshot.binary[777],255);
 assert.equal(result.bytes,original.bytes);assert.deepEqual(result.hashes,original.hashes);assert.equal(result.sha256,original.sha256);f.wire.release(result.handle);
});
test('incomplete, out-of-order and corrupted chunks never publish native data',async()=>{
 const f=fixture(),h=f.hydration.begin(spec());await assert.rejects(f.hydration.finish(h),/INCOMPLETE/);await assert.rejects(f.hydration.value(h,1,null),/ORDER_INVALID/);
 const plan=await f.wire.prepare(new Uint8Array(1024*1024));await f.hydration.value(h,0,{codec:'atlas-chunks-v1',bytes:plan.bytes,hashes:plan.hashes,sha256:plan.sha256});await assert.rejects(f.hydration.chunk(h,1,''),/ORDER_INVALID/);await assert.rejects(f.hydration.chunk(h,0,'AAAA'),/integrity mismatch/);assert.equal(f.restored,undefined);f.hydration.abort(h);f.wire.release(plan.handle);
});
test('malformed histories and excessive byte budgets are rejected before any native restore',async()=>{
 const f=fixture();for(const s of [spec({revision:2}),spec({head:{revision:2,epoch:2}}),spec({journal:[{revision:9}]}),spec({operation:'run-script'})])assert.throws(()=>f.hydration.begin(s),/SPEC_INVALID/);
 const h=f.hydration.begin(spec());await assert.rejects(f.hydration.value(h,0,{codec:'atlas-chunks-v1',bytes:HUB_LIMITS.streamBytes+1,hashes:['0'.repeat(64)],sha256:'0'.repeat(64)}),/CHUNKS_INVALID/);assert.equal(f.restored,undefined);f.hydration.abort(h);
});
test('only one bounded hydration exists, abort releases it and stale handles cannot affect replacements',async()=>{
 const f=fixture(),a=f.hydration.begin(spec());assert.throws(()=>f.hydration.begin(spec()),/already active/);f.hydration.abort(a);const b=f.hydration.begin(spec());await assert.rejects(f.hydration.value(a,0,null),/UNKNOWN/);await feed(f,b,0,{value:'replacement'});await f.hydration.finish(b);assert.equal(f.restored[1].value,'replacement');assert.throws(()=>f.hydration.abort(a),/UNKNOWN/);
});
test('a failed native publication releases worker state but never returns a success',async()=>{
 const wire=createProfileWirePlanner(),h=createProfileHydration(wire,{restore:async()=>{throw Error('Native publication failed')},compact:async()=>null});const a=h.begin(spec());await h.value(a,0,null);await assert.rejects(h.finish(a),/publication failed/);assert.doesNotThrow(()=>h.begin(spec()));h.dispose();
});
test('aborting an in-flight decode cannot publish a late value into a new session',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=fixture(),wire={...f.wire,decode:async v=>{await pending;return decodePortableValue(v)}};const h=createProfileHydration(wire,{restore:async()=>{throw Error('Must not publish')},compact:async()=>null});const a=h.begin(spec()),decode=h.value(a,0,await encodePortableValue({value:'old'}));h.abort(a);h.begin(spec());release();await assert.rejects(decode,/CLOSED/);h.dispose();
});

test('four independent network-bound hydrations coexist, fifth admits FIFO after release, same-stream exclusion stays exact',async()=>{
 const f=fixture(),handles=[];
 for(let i=0;i<4;i++)handles.push(f.hydration.begin(spec({namespace:{kind:'local',origin:'https://site'+i+'.example'}})));
 let admitted=false;const fifth=f.hydration.begin(spec({namespace:{kind:'local',origin:'https://site4.example'}})).then(h=>{admitted=true;return h});
 await new Promise(r=>setImmediate(r));assert.equal(admitted,false);
 await Promise.all(handles.map(h=>f.hydration.value(h,0,null)));f.hydration.abort(handles[0]);
 const h=await fifth;assert.equal(admitted,true);await f.hydration.value(h,0,null);
 await Promise.all([...handles.slice(1),h].map(handle=>f.hydration.finish(handle)));f.hydration.dispose();
});
test('disposing a full hydration pool rejects queued admission without publishing any native data',async()=>{
 const f=fixture();for(let i=0;i<4;i++)f.hydration.begin(spec({namespace:{kind:'local',origin:'https://site'+i+'.example'}}));
 const pending=f.hydration.begin(spec({namespace:{kind:'local',origin:'https://waiting.example'}}));f.hydration.dispose();
 await assert.rejects(pending,/CLOSED/);assert.equal(f.restored,undefined);
});
test('independent hydration sessions share one original aggregate byte budget and abort returns only its reservation',async()=>{
 const f=fixture(),a=f.hydration.begin(spec()),b=f.hydration.begin(spec({namespace:{kind:'local',origin:'https://independent.example'}}));
 const bytes=HUB_LIMITS.streamBytes,manifest={codec:'atlas-chunks-v1',bytes,hashes:Array(Math.ceil(bytes/HUB_LIMITS.chunkBytes)).fill('0'.repeat(64)),sha256:'0'.repeat(64)};
 await f.hydration.value(a,0,manifest);
 await assert.rejects(f.hydration.value(b,0,await encodePortableValue({small:true})),/allowance exceeded/);
 f.hydration.abort(a);
 await f.hydration.value(b,0,await encodePortableValue({small:true}));await f.hydration.finish(b);assert.equal(f.restored[1].small,true);f.hydration.dispose();
});
