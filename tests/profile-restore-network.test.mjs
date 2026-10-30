import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProfileStreamHead} from '../web/src/profile-stream.ts';
import {restoreProfileChunks,PROFILE_RESTORE_BUFFER_BYTES} from '../web/src/profile-chunk-restore.ts';
import {HUB_LIMITS} from '../runtime/hub-contracts.ts';
const namespace={kind:'idb',origin:'https://save.example',name:'game'};
const hash=i=>i.toString(16).padStart(64,'0');
const manifest=(count=3,extra={})=>({codec:'atlas-chunks-v1',bytes:count*HUB_LIMITS.chunkBytes,hashes:Array.from({length:count},(_,i)=>hash(i)),sha256:hash(999),...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const turn=()=>new Promise(r=>setImmediate(r));

test('metadata query uses existing headOnly protocol and does not retain payload fields',async()=>{
 const calls=[];const head=await loadProfileStreamHead(async b=>{calls.push(b);return{revision:9,snapshotRevision:5,restoreBytes:17,snapshotBytes:7,snapshot:{mustNotRetain:true}}},namespace);
 assert.deepEqual(calls,[{namespace,headOnly:true}]);assert.deepEqual(head,{revision:9,snapshotRevision:5,restoreBytes:17,snapshotBytes:7});
 assert.deepEqual(await loadProfileStreamHead(async()=>({revision:0,snapshotRevision:0,restoreBytes:0,snapshotBytes:0}),namespace),{revision:0,snapshotRevision:0,restoreBytes:0,snapshotBytes:0});
});
test('metadata rejects malformed revisions/byte counts without performing a full stream request',async()=>{
 const valid={revision:9,snapshotRevision:5,restoreBytes:17,snapshotBytes:7};
 for(const v of [null,[],{}, {...valid,revision:-1},{...valid,revision:1.5},{...valid,snapshotRevision:10},{...valid,restoreBytes:-1},{...valid,restoreBytes:Number.MAX_SAFE_INTEGER+1},{...valid,snapshotBytes:'7'}]){
  let calls=0;await assert.rejects(loadProfileStreamHead(async b=>{calls++;assert.equal(b.headOnly,true);return v},namespace),/HEAD_INVALID/);assert.equal(calls,1);
 }
});
test('chunk transport overlaps at most two fetches while native apply stays strictly ordered and serial',async()=>{
 const first=deferred(),applyFirst=deferred(),reads=[],applies=[];let applying=0,maxApplying=0,active=0,maxActive=0;
 const run=restoreProfileChunks(manifest(),{read:async(h,i)=>{reads.push(i);active++;maxActive=Math.max(maxActive,active);if(i===0)await first.promise;active--;return{data:'AAAA'}},apply:async(i)=>{applying++;maxApplying=Math.max(maxApplying,applying);applies.push(i);if(i===0)await applyFirst.promise;applying--}});
 await turn();assert.deepEqual(reads,[0,1]);assert.deepEqual(applies,[]);first.resolve();await turn();assert.deepEqual(applies,[0]);assert.deepEqual(reads,[0,1]);applyFirst.resolve();await run;
 assert.deepEqual(reads,[0,1,2]);assert.deepEqual(applies,[0,1,2]);assert.equal(maxActive,2);assert.equal(maxApplying,1);
});
test('aggregate encoded-string reservation, not finished network count, prevents excess lookahead',async()=>{
 const fullCost=Math.ceil(HUB_LIMITS.chunkBytes/3)*4*2,applyFirst=deferred(),reads=[];
 const run=restoreProfileChunks(manifest(),{read:async(_h,i)=>{reads.push(i);return{data:'AAAA'}},apply:async i=>{if(i===0)await applyFirst.promise}},{maxBufferedBytes:fullCost});
 await turn();assert.deepEqual(reads,[0]);applyFirst.resolve();await run;assert.deepEqual(reads,[0,1,2]);assert.ok(PROFILE_RESTORE_BUFFER_BYTES<32*1024*1024);
});
test('worker integrity errors abort speculative work and never apply later chunks',async()=>{
 const reads=[],applies=[],second=deferred();let aborted=false;
 await assert.rejects(restoreProfileChunks(manifest(),{read:async(_h,i,signal)=>{reads.push(i);if(i===1){signal.addEventListener('abort',()=>{aborted=true;second.reject(Error('late speculative failure'))},{once:true});return second.promise}return{data:'AAAA'}},apply:async i=>{applies.push(i);throw Error('Profile chunk integrity mismatch.')}}),/integrity mismatch/);
 await turn();assert.equal(aborted,true);assert.deepEqual(reads,[0,1]);assert.deepEqual(applies,[0]);
});
test('sign-out or writer-fence check cancels before any later native apply',async()=>{
 let live=true;const gate=deferred(),applies=[],signals=[];
 const run=restoreProfileChunks(manifest(),{check(){if(!live)throw Error('WRITER_FENCED')},read:async(_h,i,signal)=>{signals.push(signal);if(i===0)await gate.promise;return{data:'AAAA'}},apply:async i=>applies.push(i)});
 await turn();live=false;gate.resolve();await assert.rejects(run,/WRITER_FENCED/);assert.deepEqual(applies,[]);assert.ok(signals.every(s=>s.aborted));
});
test('caller cancellation aborts transport and does not publish the remaining chunks',async()=>{
 const controller=new AbortController(),gate=deferred(),applies=[],signals=[];
 const run=restoreProfileChunks(manifest(),{read:async(_h,i,signal)=>{signals.push(signal);if(i===0)await gate.promise;return{data:'AAAA'}},apply:async i=>applies.push(i)},{signal:controller.signal});
 await turn();controller.abort(new Error('ACCOUNT_CHANGED'));gate.resolve();await assert.rejects(run,/ACCOUNT_CHANGED/);assert.deepEqual(applies,[]);assert.ok(signals.every(s=>s.aborted));
});
test('bad manifests, over-budget chunks and oversized transport values fail before native publication',async()=>{
 let reads=0,applies=0;const callbacks={read:async()=>{reads++;return{data:'A'.repeat(20)}},apply:async()=>applies++};
 for(const m of [manifest(0),manifest(1,{hashes:[]}),manifest(1,{sha256:'wrong'}),manifest(1,{bytes:HUB_LIMITS.streamBytes+1})])await assert.rejects(restoreProfileChunks(m,callbacks),/CHUNKS_INVALID/);
 assert.equal(reads,0);
 await assert.rejects(restoreProfileChunks(manifest(1),callbacks,{maxBufferedBytes:1}),/BUFFER_TOO_SMALL/);assert.equal(reads,0);
 await assert.rejects(restoreProfileChunks(manifest(1),callbacks,{maxBufferedBytes:PROFILE_RESTORE_BUFFER_BYTES+1}),/BUFFER_INVALID/);
 await assert.rejects(restoreProfileChunks(manifest(1,{bytes:3}),callbacks),/CHUNK_SIZE_INVALID/);assert.equal(reads,1);assert.equal(applies,0);
});
test('rejected out-of-order speculative fetch is observed; ordered apply never skips a missing chunk',async()=>{
 const gate=deferred(),applies=[];
 const run=restoreProfileChunks(manifest(),{read:async(_h,i)=>{if(i===0)await gate.promise;if(i===1)throw Error('NETWORK_DOWN');return{data:'AAAA'}},apply:async i=>applies.push(i)});
 await turn();gate.resolve();await assert.rejects(run,/NETWORK_DOWN/);assert.deepEqual(applies,[0]);await turn();
});

test('bounded prefetch feeds real worker wire/hydration without changing binary, Blob, cycles or publication ordering',async()=>{
 const {createProfileWirePlanner}=await import('../runtime/profile-wire.ts');
 const {createProfileHydration}=await import('../runtime/profile-hydration.ts');
 const wire=createProfileWirePlanner(),binary=new Uint8Array(4*1024*1024);binary[111]=255;binary[binary.length-1]=17;
 const value={binary,blob:new Blob(['real worker data'])};value.self=value;
 const prepared=await wire.prepare(value);assert.ok(prepared.handle);assert.ok(prepared.hashes.length>1);
 const m={codec:'atlas-chunks-v1',bytes:prepared.bytes,hashes:prepared.hashes,sha256:prepared.sha256};
 let restored;const hydration=createProfileHydration(wire,{restore:async(_n,v)=>{restored=v},compact:async()=>{throw Error('not compacting')}});
 const h=hydration.begin({namespace,revision:1,snapshotRevision:1,journal:[],head:{revision:1,epoch:7},operation:'restore'});
 try{await hydration.value(h,0,m);assert.equal(restored,undefined);
  await restoreProfileChunks(m,{read:async(_hash,i)=>JSON.parse(await wire.chunk(prepared.handle,i).body.text()),apply:(i,data)=>hydration.chunk(h,i,data)});
  assert.equal(restored,undefined);await hydration.finish(h);
  assert.equal(restored.self,restored);assert.equal(restored.binary[111],255);assert.equal(restored.binary[binary.length-1],17);assert.equal(await restored.blob.text(),'real worker data');
 }finally{wire.release(prepared.handle);hydration.dispose()}
});
