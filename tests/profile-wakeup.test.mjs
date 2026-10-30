import test from 'node:test';import assert from 'node:assert/strict';
import {watchProfileWriters} from '../web/src/profile-wakeup.ts';
function fixture(){const streams=[];class Source extends EventTarget{static CLOSED=2;readyState=1;constructor(url,options){super();this.url=url;this.options=options;streams.push(this)}close(){this.readyState=2}hint(data){this.dispatchEvent(new MessageEvent('profile',{data}))}}let wakes=0;const watcher=watchProfileWriters(()=>wakes++,Source);return{streams,watcher,get wakes(){return wakes}};}
test('profile wakeup uses one fixed cookie-authenticated endpoint and accepts only type-only hints',()=>{
 const f=fixture(),s=f.streams[0];assert.equal(s.url,'/api/hub/profile/events');assert.deepEqual(s.options,{withCredentials:true});
 for(const type of ['profile.writers.changed','profile.writers.resync'])s.hint(JSON.stringify({type}));assert.equal(f.wakes,2);
 for(const data of ['broken','null','[]','{}',JSON.stringify({type:'synced'}),JSON.stringify({type:'profile.writers.changed',acknowledged:true}),'x'.repeat(129)])s.hint(data);
 assert.equal(f.wakes,2);s.dispatchEvent(new Event('error'));assert.equal(f.wakes,2,'transport errors are not save acknowledgements');
 f.watcher.close();s.hint('{"type":"profile.writers.changed"}');assert.equal(f.wakes,2);assert.equal(f.watcher.closed(),true);
});
test('authorization hint closes only this event channel and triggers an authoritative reread',()=>{const f=fixture();f.streams[0].dispatchEvent(new Event('authorization'));assert.equal(f.wakes,1);assert.equal(f.watcher.closed(),true);f.watcher.close();});
test('an EventSource-free browser retains the independent polling fallback',()=>{let wakes=0;const w=watchProfileWriters(()=>wakes++,undefined);w.close();assert.equal(wakes,0);assert.equal(w.closed(),false);});
