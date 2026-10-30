import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProfileWirePlanner, buildProfileWire, PROFILE_WIRE_INLINE_BYTES } from '../runtime/profile-wire.ts';
import { encodePortableValue, decodePortableValue, HUB_LIMITS } from '../runtime/hub-contracts.ts';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('worker inline graph is byte-identical to the legacy codec and exact500000byte threshold is preserved',async()=>{
 const p=createProfileWirePlanner();
 const empty=await buildProfileWire(''), overhead=empty.serialized.byteLength;
 const inline='x'.repeat(PROFILE_WIRE_INLINE_BYTES-overhead-1),chunked=inline+'x';
 const graph=await p.prepare(inline);assert.equal(graph.codec,'atlas-portable-v1');
 assert.equal(JSON.stringify(graph),JSON.stringify(await encodePortableValue(inline)));
 const plan=await p.prepare(chunked);assert.equal(plan.bytes,PROFILE_WIRE_INLINE_BYTES);assert.equal(plan.hashes.length,1);
 p.release(plan.handle);p.dispose();
});
test('large prepared bytes/chunk hashes/full digest exactly match previous JSON UTF8 chunking with no base64 string returned to shell',async()=>{
 const p=createProfileWirePlanner(),input={binary:new Uint8Array(4*1024*1024+11),text:'unicode🔥é'};input.binary[9]=255;
 const legacy=new TextEncoder().encode(JSON.stringify(await encodePortableValue(input)));
 const plan=await p.prepare(input);assert.equal(plan.bytes,legacy.byteLength);assert.equal(plan.sha256,sha(legacy));
 const parts=[];
 for(let i=0;i<plan.hashes.length;i++){
  const chunk=p.chunk(plan.handle,i);assert.deepEqual(Object.keys(chunk).sort(),['body','hash']);assert.ok(chunk.body instanceof Blob);assert.equal(chunk.body.type,'application/json');
  const body=JSON.parse(await chunk.body.text()),part=Buffer.from(body.data,'base64');assert.ok(part.length<=HUB_LIMITS.chunkBytes);
  assert.equal(chunk.hash,plan.hashes[i]);assert.equal(body.hash,chunk.hash);assert.equal(sha(part),chunk.hash);parts.push(part);
 }
 assert.deepEqual(Buffer.concat(parts),Buffer.from(legacy));p.release(plan.handle);assert.throws(()=>p.chunk(plan.handle,0),/HANDLE_UNKNOWN/);p.release(plan.handle);p.dispose();
});
test('at most two plans are retained; release creates room without invalidating another exact plan',async()=>{
 const p=createProfileWirePlanner(),a=await p.prepare('a'.repeat(600000)),b=await p.prepare('b'.repeat(600000));
 await assert.rejects(p.prepare('c'.repeat(600000)),{name:'QuotaExceededError',message:'Profile wire plan limit reached',code:'PROFILE_LOCAL_BACKPRESSURE'});
 assert.equal(decodePortableValue(await p.prepare('inline settings while both uploads remain retained')),'inline settings while both uploads remain retained');
 p.release(a.handle);const c=await p.prepare('c'.repeat(600000));assert.equal(p.chunk(b.handle,0).hash,b.hashes[0]);assert.equal(p.chunk(c.handle,0).hash,c.hashes[0]);p.dispose();
 assert.throws(()=>p.chunk(b.handle,0),/PROFILE_WIRE_DISPOSED/);await assert.rejects(p.prepare({}),/PROFILE_WIRE_DISPOSED/);
});
test('concurrent codec work queues boundedly instead of failing another website at an async Blob step',async()=>{
 const p=createProfileWirePlanner();let release;const gate=new Promise(r=>release=r),blob=new Blob(['first']),read=blob.arrayBuffer.bind(blob);blob.arrayBuffer=async()=>{await gate;return read()};
 const first=p.prepare(blob);let secondReady=false;const second=p.prepare('second').then(v=>{secondReady=true;return v});
 await new Promise(r=>setImmediate(r));assert.equal(secondReady,false);release();
 assert.equal((await first).codec,'atlas-portable-v1');assert.equal(decodePortableValue(await second),'second');
 const pending=Array.from({length:32},(_,i)=>p.prepare(String(i)));
 await assert.rejects(p.prepare('overflow'),{name:'QuotaExceededError',message:'Profile wire worker backpressure',code:'PROFILE_LOCAL_BACKPRESSURE'});
 assert.deepEqual((await Promise.all(pending)).map(decodePortableValue),Array.from({length:32},(_,i)=>String(i)));
 await assert.rejects(p.prepare({fn(){}}),/Value is not portable/);assert.equal(decodePortableValue(await p.prepare('after failed codec')),'after failed codec');p.dispose();
});
test('disposed in-flight preparation cannot retain a late plan or return a false successful save',async()=>{
 const p=createProfileWirePlanner(),pending=p.prepare(new Blob(['x'.repeat(600000)]));p.dispose();await assert.rejects(pending,/PROFILE_WIRE_DISPOSED/);
});
test('chunk handle/index validation prevents unknown or arbitrary access and no implicit plan allocation',async()=>{
 const p=createProfileWirePlanner(),plan=await p.prepare('a'.repeat(600000));
 for(const i of [-1,.5,Infinity,NaN,1])assert.throws(()=>p.chunk(plan.handle,i),/CHUNK_INVALID/);
 assert.throws(()=>p.chunk('foreign-handle',0),/HANDLE_UNKNOWN/);assert.throws(()=>p.chunk('../database',0),/HANDLE_INVALID/);p.dispose();
});
test('off-main generic encode/decode and transferred JSON bytes preserve cycles, Blob, typed arrays, dates, Map/Set',async()=>{
 const p=createProfileWirePlanner(),input={date:new Date('2026-10-22T00:00:00Z'),blob:new Blob(['binary']),bytes:new Uint8Array([0,17,255]),map:new Map([['set',new Set([1,2])]])};input.self=input;
 const graph=await p.encode(input),bytes=new TextEncoder().encode(JSON.stringify(graph));
 for(const restored of [await p.decode(graph),await p.decode(bytes.buffer)]){
  assert.equal(restored.self,restored);assert.equal(restored.date.toISOString(),input.date.toISOString());assert.equal(await restored.blob.text(),'binary');assert.deepEqual(restored.bytes,input.bytes);assert.equal(restored.map.get('set').has(2),true);
 }
 await assert.rejects(p.decode(new Uint8Array([255]).buffer),TypeError);await assert.rejects(p.decode(new TextEncoder().encode('{}').buffer),/Invalid portable graph/);p.dispose();
});
test('nonportable data and graph/depth allowance errors remain exact rather than silent partial data',async()=>{
 const p=createProfileWirePlanner();await assert.rejects(p.prepare({fn(){}}),/Value is not portable/);
 const value={};let cursor=value;for(let i=0;i<70;i++){cursor.next={};cursor=cursor.next;}
 await assert.rejects(p.prepare(value),/Portable graph exceeds allowance/);p.dispose();
});
test('chunk download canonical base64, byte ceiling and SHA checks run before returning native bytes',async()=>{
 const p=createProfileWirePlanner(),bytes=Buffer.from([0,17,255]),hash=sha(bytes);
 assert.deepEqual(new Uint8Array(await p.decodeChunk(bytes.toString('base64'),hash)),new Uint8Array(bytes));
 await assert.rejects(p.decodeChunk(bytes.toString('base64'),'a'.repeat(64)),/chunk integrity mismatch/);
 await assert.rejects(p.decodeChunk('AB==',hash),/chunk encoding/);await assert.rejects(p.decodeChunk('not base64',hash));
 await assert.rejects(p.decodeChunk(bytes.toString('base64'),'not-a-hash'),/integrity hash/);
 await assert.rejects(p.decodeChunk('a'.repeat(Math.ceil(HUB_LIMITS.chunkBytes*4/3)+5),hash),/chunk size/);p.dispose();
});
test('full transferred-wire checksum is verified before JSON parsing and native graph reconstruction',async()=>{
 const p=createProfileWirePlanner(),graph=await encodePortableValue({saved:true,binary:new Uint8Array([4,5])}),bytes=new TextEncoder().encode(JSON.stringify(graph));
 const value=await p.decodeBytes(bytes.buffer,sha(bytes));assert.equal(value.saved,true);assert.deepEqual(value.binary,new Uint8Array([4,5]));
 await assert.rejects(p.decodeBytes(bytes.buffer,'b'.repeat(64)),/Profile integrity mismatch/);
 const malformed=new TextEncoder().encode('not JSON');await assert.rejects(p.decodeBytes(malformed.buffer,'b'.repeat(64)),/Profile integrity mismatch/);await assert.rejects(p.decodeBytes(malformed.buffer,sha(malformed)),SyntaxError);
 const utf8=new Uint8Array([255]);await assert.rejects(p.decodeBytes(utf8.buffer,sha(utf8)),TypeError);p.dispose();
});
