import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {drainProfileQueue}=await import(process.env.PROFILE_SYNC_SOURCE?pathToFileURL(process.env.PROFILE_SYNC_SOURCE).href:'../runtime/profile-sync.ts');
import {portableWireBytes} from '../runtime/profile-compaction-sync.ts';
const origin='https://game.example';
const makeChange=i=>({entry:{id:'native-journal-'+String(i).padStart(16,'0'),profileId:'11111111-1111-4111-8111-111111111111',kind:'local',origin,createdAt:i,bytes:64,payload:{revision:i,change:{op:'set',key:'save',value:String(i)}}},database:'fixture',store:'origins',key:['outbox',i],arrayKeys:true});
function fixture(count=100,{reuse=true,compaction=false}={}){
 const changes=Array.from({length:count},(_,i)=>makeChange(i+1)),prepared=new Map(),calls=[],commits=[];
 let head={revision:0,epoch:7},plan=null,afterAck=()=>{},failAck=false,failCommit=false,acknowledge=true;
 const state={revision:0,snapshotRevision:0,restoreBytes:0,snapshotBytes:0},queue={
  list:async()=>[...changes],head:async()=>head&&{...head},prepared:async c=>prepared.get(c.entry.id)||null,prepare:async(c,h)=>{prepared.set(c.entry.id,{...h})},acknowledge:async(c,h)=>{if(failAck)throw Error('Native acknowledgement failed');head={...h};changes.splice(changes.indexOf(c),1);prepared.delete(c.entry.id);await afterAck(c,h)},
 };
 if(compaction)Object.assign(queue,{compaction:async()=>plan,prepareCompaction:async(_c,p)=>{assert.equal(plan,null);plan=p},finishCompaction:async(_c,p)=>{assert.equal(plan,p);head={revision:p.head.revision+1,epoch:p.head.epoch};plan=null}});
 const cloud={reuseAcknowledgedHeads:reuse,encode:async v=>v,receipt:async id=>{calls.push({op:'receipt',id});return null},stream:async()=>{calls.push({op:'stream'});return{...state}},writer:async()=>({epoch:7,expiresAt:new Date(Date.now()+90000).toISOString()}),snapshot:async(_n,expected)=>{assert.equal(expected,state.revision);calls.push({op:'snapshot'});return{revision:expected,payload:{format:'snapshot',values:{saved:state.revision}}}},commit:async v=>{
  if(failCommit)throw Object.assign(Error('Cloud unavailable'),{status:503});
  assert.equal(v.epoch,7);if(v.baseRevision!==state.revision)throw Object.assign(Error('Server CAS rejected stale revision'),{status:409,code:'PROFILE_REVISION_CONFLICT'});
  if(!acknowledge)return{acknowledged:false,revision:state.revision+1};
  commits.push(v);state.revision++;if(v.mode==='snapshot'){state.snapshotRevision=state.revision;state.restoreBytes=state.snapshotBytes=portableWireBytes(v.payload)}else state.restoreBytes+=portableWireBytes(v.payload);
  return{acknowledged:true,revision:state.revision};
 }};
 return{changes,queue,cloud,calls,commits,state,prepared,get head(){return head},set head(v){head=v},set afterAck(f){afterAck=f},set failAck(v){failAck=v},set failCommit(v){failCommit=v},set acknowledge(v){acknowledge=v}};
}
test('opt-in100-journal burst uses1 stream probe rather than100 while retaining all100 distinct commits',async()=>{
 for(const reuse of [false,true]){const f=fixture(100,{reuse});assert.equal(await drainProfileQueue(f.queue,f.cloud),100);assert.equal(f.calls.filter(c=>c.op==='stream').length,reuse?1:100);assert.equal(f.commits.length,100);assert.deepEqual(f.commits.map(c=>c.idempotencyKey),Array.from({length:100},(_,i)=>makeChange(i+1).entry.id));assert.deepEqual(f.commits.map(c=>c.payload.change.value),Array.from({length:100},(_,i)=>String(i+1)));assert.equal(f.state.revision,100);assert.equal(f.changes.length,0)}
});
test('a concurrent external commit is still server-CAS rejected and the unacknowledged native journal remains',async()=>{
 const f=fixture(2);f.afterAck=()=>{if(f.state.revision===1){f.state.revision=2;f.state.restoreBytes+=100}};
 await assert.rejects(drainProfileQueue(f.queue,f.cloud),e=>e.code==='PROFILE_REVISION_CONFLICT');assert.equal(f.commits.length,1);assert.equal(f.changes.length,1);assert.equal(f.changes[0].entry.id,makeChange(2).entry.id);assert.equal(f.state.revision,2);assert.equal(f.head.revision,1);
});
test('a failed native ACK never retires a journal or carries reusable heads into the next drain',async()=>{
 const f=fixture(2);f.failAck=true;await assert.rejects(drainProfileQueue(f.queue,f.cloud),/Native acknowledgement failed/);assert.equal(f.changes.length,2);assert.equal(f.head.revision,0);assert.equal(f.prepared.size,1);assert.equal(f.commits.length,1);
 f.failAck=false;await assert.rejects(drainProfileQueue(f.queue,f.cloud),/PROFILE_REVISION_CONFLICT/);assert.equal(f.calls.filter(c=>c.op==='stream').length,2);assert.equal(f.changes.length,2);assert.equal(f.commits.length,1);
});
test('durable head mismatch invalidates cached metadata instead of silently advancing local data',async()=>{
 const f=fixture(2);f.afterAck=()=>{f.head={revision:0,epoch:7}};await assert.rejects(drainProfileQueue(f.queue,f.cloud),/PROFILE_REVISION_CONFLICT/);assert.equal(f.calls.filter(c=>c.op==='stream').length,2);assert.equal(f.commits.length,1);assert.equal(f.changes.length,1);
});
test('changed epoch invalidates metadata reuse and remains a recovery error',async()=>{
 const f=fixture(2);f.afterAck=()=>{f.head={revision:1,epoch:8}};await assert.rejects(drainProfileQueue(f.queue,f.cloud),/PROFILE_RECOVERY_REQUIRED/);assert.equal(f.calls.filter(c=>c.op==='stream').length,2);assert.equal(f.commits.length,1);assert.equal(f.changes.length,1);
});
test('prepared retry probes its immutable receipt and refetches metadata even after a previous ACK',async()=>{
 const f=fixture(2);f.prepared.set(makeChange(2).entry.id,{revision:1,epoch:7});assert.equal(await drainProfileQueue(f.queue,f.cloud),2);assert.equal(f.calls.filter(c=>c.op==='stream').length,2);assert.ok(f.calls.some(c=>c.op==='receipt'&&c.id===makeChange(2).entry.id),'prepared request always probes its immutable receipt');assert.equal(f.commits.length,2);
});
test('queues without durable preparation and legacy incomplete metadata retain the original probe behavior',async()=>{
 const old=fixture(3);delete old.queue.prepared;delete old.queue.prepare;assert.equal(await drainProfileQueue(old.queue,old.cloud),3);assert.equal(old.calls.filter(c=>c.op==='stream').length,3);
 const missing=fixture(3);missing.cloud.stream=async()=>{missing.calls.push({op:'stream'});return{revision:missing.state.revision}};assert.equal(await drainProfileQueue(missing.queue,missing.cloud),3);assert.equal(missing.calls.filter(c=>c.op==='stream').length,3);
});
test('false remote ACK preserves pending writes and never creates an acknowledged metadata shortcut',async()=>{
 const f=fixture(2);f.acknowledge=false;await assert.rejects(drainProfileQueue(f.queue,f.cloud),/PROFILE_ACK_INVALID/);assert.equal(f.changes.length,2);assert.equal(f.head.revision,0);f.acknowledge=true;assert.equal(await drainProfileQueue(f.queue,f.cloud),2);assert.equal(f.calls.filter(c=>c.op==='stream').length,3,'prepared uncertain retry refetches and is not used as the next fresh cache base');
});
test('predicted journal counts preserve128-journal compaction and clear cache after snapshot revision changes',async()=>{
 const f=fixture(200,{compaction:true});assert.equal(await drainProfileQueue(f.queue,f.cloud),200);const snapshots=f.commits.filter(c=>c.mode==='snapshot');assert.equal(snapshots.length,1);assert.equal(f.commits.indexOf(snapshots[0]),128);assert.equal(f.commits.filter(c=>c.mode==='journal').length,200);assert.equal(f.state.revision,201);assert.equal(f.state.snapshotRevision,129);assert.equal(f.calls.filter(c=>c.op==='stream').length,3);assert.equal(f.changes.length,0);
});
test('predicted restoreBytes preserve byte-threshold compaction before the journal-count threshold',async()=>{
 const f=fixture(3,{compaction:true}),large='x'.repeat(9*1024*1024);for(const c of f.changes)c.entry.payload={data:large};assert.equal(await drainProfileQueue(f.queue,f.cloud),3);assert.deepEqual(f.commits.map(c=>c.mode),['journal','journal','snapshot','journal']);assert.equal(f.state.snapshotRevision,3);assert.equal(f.changes.length,0);
});
