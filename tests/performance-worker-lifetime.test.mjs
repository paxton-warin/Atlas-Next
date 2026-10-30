import test from 'node:test';import assert from 'node:assert/strict';
import { installScramjetProfileWorkerConstructors } from '../runtime/scramjet-profile-workers.ts';
const protocol='atlas-scramjet-profile-worker-v1';
function fixture(bind=async()=>({port:new MessageChannel().port1,dispose(){}})){
 class Worker extends EventTarget{terminate(){this.terminated=(this.terminated||0)+1}postMessage(){}}
 const owner={Worker,MessageEvent,MessagePort,MessageChannel,crypto};
 const handle=installScramjetProfileWorkerConstructors(owner,{url:{href:'https://website.test/'}},{bindWorkerIndexedDB:bind});return{owner,handle,Worker};
}
test('terminated dedicated workers leave document registry; disposal is idempotent and restores constructor',()=>{
 const {owner,handle,Worker}=fixture();for(let i=0;i<1000;i++){const w=new owner.Worker('/worker.js');assert.equal(handle.activeDedicatedWorkers,1);w.terminate();w.terminate();assert.equal(w.terminated,2);assert.equal(handle.activeDedicatedWorkers,0)}handle.dispose();handle.dispose();assert.equal(owner.Worker,Worker);assert.equal(handle.activeDedicatedWorkers,0);
});
test('self-closed worker releases registry; declined live worker remains until terminate',()=>{
 const{owner,handle}=fixture();const closed=new owner.Worker('/closed.js'),declined=new owner.Worker('/declined.js');assert.equal(handle.activeDedicatedWorkers,2);
 declined.dispatchEvent(new MessageEvent('message',{data:{protocol,type:'declined'}}));assert.equal(handle.activeDedicatedWorkers,2);
 closed.dispatchEvent(new MessageEvent('message',{data:{protocol,type:'closed'}}));assert.equal(handle.activeDedicatedWorkers,1);declined.terminate();assert.equal(handle.activeDedicatedWorkers,0);handle.dispose();
});
test('late asynchronous storage binding is disposed after termination, not resurrected',async()=>{
 let finish,disposed=0;const channel=new MessageChannel();const{owner,handle}=fixture(()=>new Promise(r=>finish=r));const w=new owner.Worker('/late.js');w.dispatchEvent(new MessageEvent('message',{data:{protocol,type:'ready',documentId:'late_worker_document'}}));w.terminate();finish({port:channel.port1,dispose(){disposed++;channel.port1.close()}});await new Promise(r=>setTimeout(r,5));assert.equal(disposed,1);assert.equal(handle.activeDedicatedWorkers,0);channel.port2.close();handle.dispose();
});
