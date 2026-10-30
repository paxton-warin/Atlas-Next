import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileSyncScheduler } from '../web/src/profile-sync-scheduler.ts';

const settle = async () => { for(let i=0;i<16;i++)await Promise.resolve(); };
function fixture(overrides={}) {
 let time=0,id=0;const timers=new Map(),runs=[],errors=[];
 const clock={now:()=>time,setTimeout(fn,delay){const key=++id;timers.set(key,{at:time+delay,fn});return key},clearTimeout(key){timers.delete(key)}};
 const scheduler=createProfileSyncScheduler({clock,random:()=>.5,retryable:e=>e?.temporary===true,run:async()=>{runs.push(time)},onError:e=>errors.push(e),...overrides});
 async function advance(ms){const target=time+ms;while(true){const next=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}time=target;await settle();}
 return{scheduler,clock,timers,runs,errors,advance,now:()=>time};
}
const transient=()=>Object.assign(Error('offline'),{temporary:true});

test('construction and clean idle reconciliation create no background traffic',async()=>{
 const f=fixture();assert.equal(f.timers.size,0);await f.advance(120000);assert.deepEqual(f.runs,[]);assert.equal(f.scheduler.pending(),false);
});
test('data burst coalesces with a fixed first-change deadline',async()=>{
 const f=fixture();f.scheduler.changed();for(let i=0;i<9;i++){await f.advance(100);f.scheduler.changed();}assert.equal(f.runs.length,0);await f.advance(100);assert.deepEqual(f.runs,[1000]);assert.equal(f.scheduler.pending(),false);assert.equal(f.timers.size,0);
});
test('continuous cookies cannot postpone their 15-second first-change deadline',async()=>{
 const f=fixture();f.scheduler.changed('cookies');for(let i=0;i<14;i++){await f.advance(1000);f.scheduler.changed('cookies');}await f.advance(1000);assert.deepEqual(f.runs,[15000]);assert.equal(f.scheduler.pending(),false);
});
test('data can accelerate a pending cookie drain without multiple timers',async()=>{
 const f=fixture();f.scheduler.changed('cookies');await f.advance(2000);f.scheduler.changed();assert.equal(f.timers.size,1);await f.advance(1000);assert.deepEqual(f.runs,[3000]);
});
test('urgent flush bypasses coalescing and later timer does not duplicate it',async()=>{
 const f=fixture();f.scheduler.changed('cookies');await f.scheduler.flushNow();assert.deepEqual(f.runs,[0]);await f.advance(20000);assert.equal(f.runs.length,1);assert.equal(f.scheduler.pending(),false);
});
test('urgent flush runs even without an observed dirty event',async()=>{
 const f=fixture();await f.scheduler.flushNow();assert.deepEqual(f.runs,[0]);assert.equal(f.scheduler.pending(),false);
});
test('dirty work during a flight is not cleared by its older success',async()=>{
 let complete;let count=0;const f=fixture({run:()=>{f.runs.push(f.now());return ++count===1?new Promise(r=>complete=r):Promise.resolve()}});f.scheduler.changed();await f.advance(1000);assert.equal(f.scheduler.inspect().running,true);f.scheduler.changed();await f.advance(1500);assert.equal(f.runs.length,1);complete();await settle();assert.equal(f.scheduler.pending(),true);await f.advance(0);assert.deepEqual(f.runs,[1000,2500]);assert.equal(f.scheduler.pending(),false);
});
test('urgent joining an existing flight starts no second drain',async()=>{
 let complete;const f=fixture({run:()=>{f.runs.push(f.now());return new Promise(r=>complete=r)}});f.scheduler.changed();await f.advance(1000);const a=f.scheduler.flushNow(),b=f.scheduler.flushNow();assert.equal(a,b);assert.equal(f.runs.length,1);complete();await Promise.all([a,b]);assert.equal(f.scheduler.pending(),false);
});
test('retryable failures back off exponentially; new writes and probes preserve pacing',async()=>{
 const f=fixture({run:async()=>{f.runs.push(f.now());throw transient()}});f.scheduler.changed();await f.advance(1000);assert.deepEqual(f.runs,[1000]);assert.equal(f.scheduler.inspect().retryAt,3000);await f.advance(500);f.scheduler.changed();f.scheduler.reconcileDirty();assert.equal(f.scheduler.inspect().retryAt,3000);await f.advance(1500);assert.deepEqual(f.runs,[1000,3000]);assert.equal(f.scheduler.inspect().retryAt,7000);await f.advance(4000);assert.deepEqual(f.runs,[1000,3000,7000]);assert.equal(f.errors.length,3);assert.equal(f.scheduler.pending(),true);
});
test('backoff is bounded, jittered and resets after successful acknowledgement',async()=>{
 let fail=true;const f=fixture({random:()=>1,retryBaseMs:1000,maxBackoffMs:3000,run:async()=>{f.runs.push(f.now());if(fail)throw transient()}});f.scheduler.changed();await f.advance(1000);assert.equal(f.scheduler.inspect().retryAt,2200);await f.advance(1200);assert.equal(f.scheduler.inspect().retryAt,4600);await f.advance(2400);assert.equal(f.scheduler.inspect().retryAt,7600);fail=false;await f.advance(3000);assert.equal(f.scheduler.inspect().failures,0);assert.equal(f.scheduler.inspect().retryAt,0);assert.equal(f.scheduler.pending(),false);
});
test('terminal failures remain paused despite noisy writes and periodic probes',async()=>{
 const error=Error('quota');const f=fixture({run:async()=>{f.runs.push(f.now());throw error}});f.scheduler.changed();await f.advance(1000);for(let i=0;i<30;i++){f.scheduler.changed();f.scheduler.reconcileDirty();await f.advance(20000);}assert.equal(f.runs.length,1);assert.equal(f.scheduler.inspect().paused,true);assert.equal(f.scheduler.pending(),true);assert.equal(f.timers.size,0);assert.deepEqual(f.errors,[error]);
});
test('proven independent work may resume terminal pause with normal coalescing',async()=>{
 let fail=true;const f=fixture({run:async()=>{f.runs.push(f.now());if(fail)throw Error('one site repair')}});f.scheduler.changed();await f.advance(1000);assert.equal(f.scheduler.inspect().paused,true);await f.advance(10000);fail=false;f.scheduler.changed('data',{resumePaused:true});assert.equal(f.scheduler.inspect().failures,1);await f.advance(999);assert.equal(f.runs.length,1);await f.advance(1);assert.deepEqual(f.runs,[1000,12000]);assert.equal(f.scheduler.pending(),false);
});
test('manual retry bypasses terminal pause and background backoff',async()=>{
 let fail=true;const f=fixture({run:async()=>{f.runs.push(f.now());if(fail)throw transient()}});f.scheduler.changed();await f.advance(1000);fail=false;await f.scheduler.retry();assert.deepEqual(f.runs,[1000,1000]);assert.equal(f.scheduler.pending(),false);await f.advance(20000);assert.equal(f.runs.length,2);
});
test('explicit flush failure rejects its caller without duplicate background reporting',async()=>{
 const error=transient();const f=fixture({run:async()=>{throw error}});await assert.rejects(f.scheduler.flushNow(),e=>e===error);assert.equal(f.errors.length,0);assert.equal(f.scheduler.pending(),true);assert.equal(f.scheduler.inspect().failures,1);
});
test('background UI rejection does not become an unhandled rejection or acknowledge saves',async()=>{
 const f=fixture({run:async()=>{throw transient()},onError:async()=>{throw Error('UI failed')}});f.scheduler.changed();await f.advance(1000);assert.equal(f.scheduler.pending(),true);assert.equal(f.scheduler.inspect().running,false);assert.equal(f.timers.size,1);
});
test('stop cancels timers and never reschedules after an in-flight failure',async()=>{
 let reject;const f=fixture({run:()=>new Promise((_r,j)=>reject=j)});f.scheduler.changed();await f.advance(1000);f.scheduler.changed();f.scheduler.stop();reject(transient());await settle();assert.equal(f.timers.size,0);assert.equal(f.scheduler.pending(),true);assert.equal(f.errors.length,0);await assert.rejects(f.scheduler.flushNow(),{code:'PROFILE_SYNC_SCHEDULER_STOPPED'});
});
test('stop before scheduled work leaves its durable dirty status untouched',async()=>{
 const f=fixture();f.scheduler.changed();f.scheduler.stop();await f.advance(30000);assert.equal(f.runs.length,0);assert.equal(f.scheduler.pending(),true);
});
test('dirty reconciliation does not bump a running generation or manufacture follow-up traffic',async()=>{
 let complete;const f=fixture({run:()=>{f.runs.push(f.now());return new Promise(r=>complete=r)}});f.scheduler.reconcileDirty();await f.advance(1000);f.scheduler.reconcileDirty();complete();await settle();await f.advance(20000);assert.equal(f.runs.length,1);assert.equal(f.scheduler.pending(),false);
});
test('invalid scheduling bounds are rejected',()=>{
 for(const config of [{delayMs:-1},{cookieDelayMs:NaN},{retryBaseMs:0},{maxBackoffMs:1,retryBaseMs:2}])assert.throws(()=>fixture(config),TypeError);
});
test('explicit manual retry can recover a terminal failure without noisy auto-retry',async()=>{
 let fail=true;const f=fixture({run:async()=>{f.runs.push(f.now());if(fail)throw Error('needs repair')}});f.scheduler.changed();await f.advance(1000);assert.equal(f.scheduler.inspect().paused,true);fail=false;await f.scheduler.retry();assert.deepEqual(f.runs,[1000,1000]);assert.equal(f.scheduler.pending(),false);assert.equal(f.scheduler.inspect().paused,false);
});
test('independent-work hint cannot defeat transient retry backoff',async()=>{
 const f=fixture({run:async()=>{f.runs.push(f.now());throw transient()}});f.scheduler.changed();await f.advance(1000);f.scheduler.changed('data',{resumePaused:true});await f.advance(1999);assert.equal(f.runs.length,1);await f.advance(1);assert.equal(f.runs.length,2);
});
test('fallback probes preserve a pending cookie deadline rather than accelerate it',async()=>{
 const f=fixture();f.scheduler.changed('cookies');await f.advance(500);f.scheduler.reconcileDirty('data');await f.advance(14000);assert.equal(f.runs.length,0);await f.advance(500);assert.deepEqual(f.runs,[15000]);
});
test('a throwing retry classifier pauses safely and still reports the original failure',async()=>{
 const error=Error('original');const f=fixture({retryable:()=>{throw Error('bad classifier')},run:async()=>{throw error}});f.scheduler.changed();await f.advance(1000);assert.equal(f.scheduler.inspect().paused,true);assert.deepEqual(f.errors,[error]);assert.equal(f.timers.size,0);
});
test('success arriving after stop creates no acknowledgement or follow-up timer',async()=>{
 let complete;const f=fixture({run:()=>new Promise(r=>complete=r)});f.scheduler.changed();await f.advance(1000);f.scheduler.stop();complete();await settle();assert.equal(f.scheduler.pending(),true);assert.equal(f.timers.size,0);assert.equal(f.scheduler.inspect().running,false);
});
test('success callback reports newer dirty work still pending, then clean after its own ACK',async()=>{
 let complete,count=0;const states=[];const f=fixture({onSuccess:s=>states.push(s),run:()=>++count===1?new Promise(r=>complete=r):Promise.resolve()});f.scheduler.changed();await f.advance(1000);f.scheduler.changed();complete();await settle();assert.deepEqual(states,[{pending:true}]);await f.advance(1000);assert.deepEqual(states,[{pending:true},{pending:false}]);assert.equal(f.scheduler.pending(),false);
});
test('a throwing success UI callback cannot convert an ACK into retry traffic',async()=>{
 const f=fixture({onSuccess:async()=>{throw Error('render failed')}});f.scheduler.changed();await f.advance(1000);assert.equal(f.runs.length,1);assert.equal(f.scheduler.pending(),false);assert.equal(f.scheduler.inspect().failures,0);assert.equal(f.errors.length,0);await f.advance(20000);assert.equal(f.runs.length,1);
});
test('stop before completion suppresses the success callback',async()=>{
 let complete;const states=[];const f=fixture({onSuccess:s=>states.push(s),run:()=>new Promise(r=>complete=r)});f.scheduler.changed();await f.advance(1000);f.scheduler.stop();complete();await settle();assert.deepEqual(states,[]);assert.equal(f.scheduler.pending(),true);
});
