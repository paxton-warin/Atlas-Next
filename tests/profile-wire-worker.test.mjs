import test from 'node:test';import assert from 'node:assert/strict';
import { createProfileLocalStore } from '../web/src/profile-local-store.ts';
import { installProfileLocalWorker, PROFILE_LOCAL_PROTOCOL } from '../runtime/profile-local-worker.ts';
const profile='11111111-1111-4111-8111-111111111111';
function fixture(){let listener,serial=0;const waiters=new Map();let opens=0;
 installProfileLocalWorker({indexedDB:{open(){opens++;throw Error('UNEXPECTED_IDB_ACCESS')}},postMessage(v){waiters.get(v.id)?.(v);waiters.delete(v.id)},addEventListener(_t,fn){listener=fn}});
 return{send:(operation,args=[])=>new Promise(resolve=>{const id=++serial;waiters.set(id,resolve);listener({data:{protocol:PROFILE_LOCAL_PROTOCOL,id,operation,args}})}),opens:()=>opens};
}
test('wire operations stay behind immutable initialization and use no IDB/network capability',async()=>{
 const f=fixture();assert.equal((await f.send('wire-encode',[{}])).error.message,'PROFILE_LOCAL_NOT_INITIALIZED');await f.send('initialize',[profile]);
 const result=await f.send('wire-encode',['x'.repeat(600000)]);assert.equal(result.ok,true);const plan=result.value;
 const chunk=await f.send('wire-chunk',[plan.handle,0]);assert.equal(chunk.ok,true);assert.ok(chunk.value.body instanceof Blob);assert.equal(chunk.value.hash,plan.hashes[0]);
 assert.equal((await f.send('wire-release',[plan.handle])).ok,true);assert.equal((await f.send('wire-chunk',[plan.handle,0])).error.message,'PROFILE_WIRE_HANDLE_UNKNOWN');
 assert.equal((await f.send('initialize',['22222222-2222-4222-8222-222222222222'])).error.message,'PROFILE_LOCAL_INITIALIZATION_INVALID');assert.equal(f.opens(),0);
});
test('worker decode-bytes validates transferred type and returns native data, generic encode/decode stay allowlisted',async()=>{
 const f=fixture();await f.send('initialize',[profile]);const graph=(await f.send('encode',[{v:new Uint8Array([1,2,3])}])).value;
 const direct=await f.send('decode',[graph]),bytes=await f.send('decode-bytes',[new TextEncoder().encode(JSON.stringify(graph)).buffer]);assert.deepEqual(direct.value.v,new Uint8Array([1,2,3]));assert.deepEqual(bytes.value.v,direct.value.v);
 assert.equal((await f.send('decode-bytes',['not bytes'])).error.message,'PROFILE_LOCAL_ARGUMENTS_INVALID');assert.equal(f.opens(),0);
});
test('adapter transfers decode ArrayBuffer instead of cloning; requests contain no serialized native data and preserve group export',async t=>{
 const events=new EventTarget(),sent=[];let terminated=0;
 const worker={addEventListener:(...a)=>events.addEventListener(...a),removeEventListener:(...a)=>events.removeEventListener(...a),terminate:()=>{terminated++},postMessage(data,transfer=[]){const copy=structuredClone(data,{transfer});sent.push(copy);queueMicrotask(()=>events.dispatchEvent(new MessageEvent('message',{data:{protocol:PROFILE_LOCAL_PROTOCOL,id:copy.id,ok:true,value:copy.operation==='wire-encode'?{codec:'atlas-portable-v1',root:0,nodes:[{t:'null'}]}:undefined}})))}};
 const local=createProfileLocalStore(profile,{createWorker:()=>worker,timeoutMs:1000});t.after(()=>local.dispose());
 const buffer=new TextEncoder().encode('native bytes').buffer;await local.decodeWire(buffer);assert.equal(buffer.byteLength,0);assert.equal(sent.at(-1).operation,'decode-bytes');assert.equal(new TextDecoder().decode(sent.at(-1).args[0]),'native bytes');
 const raw={blob:new Blob(['native']),bytes:new Uint8Array([7,9])};await local.prepareWire(raw);assert.ok(sent.at(-1).args[0].blob instanceof Blob);assert.deepEqual(sent.at(-1).args[0].bytes,new Uint8Array([7,9]));
 await local.wireChunk('test-handle',0);assert.deepEqual(sent.at(-1).args,['test-handle',0]);await local.releaseWire('test-handle');assert.equal(sent.at(-1).operation,'wire-release');
 await local.exportSnapshots('example.test');assert.deepEqual(sent.at(-1).args,['example.test']);local.dispose();assert.equal(terminated,1);await assert.rejects(local.prepareWire({}),/PROFILE_LOCAL_DISPOSED/);
});
test('download chunk bytes transfer out of worker and full payload hash is checked before decode',async()=>{
 const {createHash}=await import('node:crypto');const hash=b=>createHash('sha256').update(b).digest('hex');
 let listener,serial=0;const waiters=new Map(),transfers=[];
 installProfileLocalWorker({indexedDB:{open(){throw Error('UNEXPECTED_IDB')}},addEventListener(_t,fn){listener=fn},postMessage(value,transfer=[]){
  const copy=structuredClone(value,{transfer});transfers.push({operationReply:value.id,transferred:transfer.length,detached:transfer.every(b=>b.byteLength===0)});waiters.get(value.id)?.(copy);waiters.delete(value.id);
 }});
 const send=(operation,args=[])=>new Promise(resolve=>{const id=++serial;waiters.set(id,resolve);listener({data:{protocol:PROFILE_LOCAL_PROTOCOL,id,operation,args}})});
 await send('initialize',[profile]);const bytes=Buffer.from([7,8,9]),reply=await send('decode-chunk',[bytes.toString('base64'),hash(bytes)]);assert.deepEqual(new Uint8Array(reply.value),new Uint8Array(bytes));assert.equal(transfers.at(-1).transferred,1);assert.equal(transfers.at(-1).detached,true);
 const graph=(await send('encode',[{restored:true}])).value;const encoded=new TextEncoder().encode(JSON.stringify(graph));const native=await send('decode-wire-bytes',[encoded.buffer,hash(encoded)]);assert.equal(native.value.restored,true);
 assert.equal((await send('decode-wire-bytes',[encoded.buffer,'a'.repeat(64)])).error.message,'Profile integrity mismatch.');
});

test('legacy and packed recovery downloads return native file Blobs, never large graphs to stringify in the shell',async()=>{
 const f=fixture();await f.send('initialize',[profile]);const value={blob:new Blob(['old-save']),bytes:new Uint8Array([4,5])};
 const old=await f.send('recovery-file',[value]);assert.equal(old.ok,true);assert.equal(old.value.extension,'.json');assert.ok(old.value.blob instanceof Blob);
 const graph=JSON.parse(await old.value.blob.text());assert.equal(graph.codec,'atlas-portable-v1');
 const archive=new Blob(['versioned-recovery\n'],{type:'application/x-atlas-recovery-ndjson'});
 const packed=await f.send('recovery-file',[{format:'atlas-recovery-packed-v1',archive,records:1}]);assert.equal(packed.ok,true);assert.equal(packed.value.extension,'.atlas-recovery.ndjson');assert.equal(await packed.value.blob.text(),await archive.text());assert.equal(f.opens(),0);
});
