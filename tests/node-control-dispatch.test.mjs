import test from 'node:test';
import assert from 'node:assert/strict';
import {createNodeControlDispatch} from '../server/node-control-dispatch.mjs';
import {createIdentityVerification} from '../server/identity-verification.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve,reject;const promise = new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};

test('control renewals coalesce by unsent batch, acknowledge earlier callers without starvation and send newest expiry',async()=>{
 let expiry=45000,rev=0;const sends=[],holds=[];let active=0,max=0;
 const d=createNodeControlDispatch({snapshot:()=>({revision:++rev,expiresAt:expiry}),send:async(t,s)=>{
  sends.push(s);active++;max=Math.max(max,active);const h=deferred();holds.push(h);await h.promise;active--;
 }});
 const target={id:'n',endpoint:'https://node.invalid'};
 const a=d.request(target);await tick();expiry=90000;
 const b=d.request(target);for(let i=0;i<100;i++)assert.equal(d.request(target),b,'only callers in the same unsent batch coalesce');
 assert.notEqual(a,b,'a sent snapshot cannot acknowledge a newer queued renewal');assert.equal(sends.length,1);
 let firstAcknowledged=false,nextAcknowledged=false;a.then(()=>firstAcknowledged=true);b.then(()=>nextAcknowledged=true);
 holds[0].resolve();await tick();assert.deepEqual(sends,[{revision:1,expiresAt:45000},{revision:2,expiresAt:90000}]);
 assert.equal(firstAcknowledged,true,'the old batch completes while the newer send is still held');assert.equal(nextAcknowledged,false,'newer callers wait for their own snapshot acknowledgement');
 holds[1].resolve();await b;assert.equal(nextAcknowledged,true);assert.equal(max,1);assert.equal(d.stats().pending,0);await d.close();
});
test('control revocation supersedes queued renewal and dispatch is bounded',async()=>{
 let state={revision:1,grants:['owner']};const hold=deferred(),sent=[];
 const d=createNodeControlDispatch({maxPending:1,snapshot:()=>structuredClone(state),send:async(t,s)=>{sent.push(s);if(sent.length===1)await hold.promise;}});
 const target={id:'n',endpoint:'https://node.invalid'};const p=d.request(target);await tick();
 state={revision:2,grants:[]};const revoked=d.request(target);assert.notEqual(revoked,p);
 await assert.rejects(d.request({id:'other',endpoint:'https://other.invalid'}),/busy/);
 hold.resolve();await Promise.all([p,revoked]);assert.deepEqual(sent.at(-1).grants,[]);assert.equal(d.stats().pending,0);await d.close();await assert.rejects(d.request(target),/closed/);
});
test('failed control is released and close aborts pending work without leaking entries',async()=>{
 const d=createNodeControlDispatch({snapshot:()=>({}),send:(t,s,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 const p=d.request({id:'n',endpoint:'https://node.invalid'});await tick();const rejected=assert.rejects(p,/aborted/);await d.close();await rejected;assert.equal(d.stats().pending,0);
});
test('same verified identity is single-flight; unrelated contexts remain isolated and invalidated responses cannot revive',async()=>{
 const v=createIdentityVerification({maxPending:2});let calls=0;const h=deferred();
 const a=v.run('account/profile/context/one',()=>{calls++;return h.promise});const b=v.run('account/profile/context/one',()=>{calls++;return h.promise});
 const c=v.run('account/profile/context/two',async()=>({other:true}));await tick();assert.equal(calls,1);assert.deepEqual(await c,{other:true});
 v.invalidate('account/profile/context/one');const checks=[assert.rejects(a,{code:'HUB_SESSION_EXPIRED'}),assert.rejects(b,{code:'HUB_SESSION_EXPIRED'})];h.resolve({grant:'old'});await Promise.all(checks);assert.equal(v.pending(),0);
 assert.deepEqual(await v.run('new',async()=>({ok:true})),{ok:true});v.close();await assert.rejects(v.run('new',async()=>({})),/closed/);
});
