import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {hubSiteGroup} from '../runtime/hub-contracts.ts';
import {selectProfileCheckpoints} from '../web/src/profile-checkpoint.ts';
const candidate=(origin,visible,lastActiveAt,checkpoint=async()=>{})=>({origin,visible,lastActiveAt,checkpoint});

test('one checkpoint per exact origin prefers foreground over stale hidden game, then MRU',()=>{
 const hidden=candidate('https://orteil.dashnet.org',false,200),active=candidate('https://orteil.dashnet.org',true,10),older=candidate('https://orteil.dashnet.org',true,5);
 const sibling=candidate('https://sub.dashnet.org',false,1);
 assert.deepEqual(selectProfileCheckpoints('dashnet.org',[hidden,active,older,sibling]),[active,sibling]);
 assert.deepEqual(selectProfileCheckpoints('dashnet.org',[active,hidden,older]),[active]);
 assert.deepEqual(selectProfileCheckpoints('dashnet.org',[hidden,{...hidden,lastActiveAt:300}]),[{...hidden,lastActiveAt:300}]);
});

test('checkpoint selection rejects unrelated groups, credential URLs, paths, invalid timestamps and noncallbacks',()=>{
 const good=candidate('https://orteil.dashnet.org',true,2);
 const invalid=['https://unrelated.example','https://orteil.dashnet.org/cookieclicker/','https://user@orteil.dashnet.org','data:text/plain,hi','not a URL'].map(o=>candidate(o,true,2));
 assert.deepEqual(selectProfileCheckpoints('dashnet.org',[...invalid,{...good,lastActiveAt:NaN},{...good,checkpoint:null},{...good,visible:'yes'},null,good]),[good]);
});

function fixture(candidates){
 const exports={},timers=new Map();let id=0,events=[];
 runInNewContext(ts.transpileModule(readFileSync(new URL('../web/src/profile-checkpoint.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports,require:()=>({hubSiteGroup}),URL,Map,Number,Promise,Error,
  CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail}},
  window:{dispatchEvent:e=>{events.push(e);e.detail.candidates.push(...candidates)}},
  setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
 });
 return{exports,timers,events};
}
test('actual registered controllers finish before the barrier resolves; all exact origins run and timer is cleaned',async()=>{
 let saved=[];const f=fixture([candidate('https://orteil.dashnet.org',true,2,async()=>{saved.push('main')}),candidate('https://cdn.dashnet.org',true,2,async()=>{saved.push('cdn')})]);
 await f.exports.checkpointProfileGroup('dashnet.org');assert.deepEqual(saved,['main','cdn']);assert.equal(f.timers.size,0);assert.equal(f.events[0].type,'atlas:profile-checkpoint');
});
test('no registered site adapter leaves ordinary committed-data semantics unchanged without a timer',async()=>{
 const f=fixture([]);await f.exports.checkpointProfileGroup('dashnet.org');assert.equal(f.timers.size,0);
});
test('native checkpoint rejection is propagated, not converted into a success or timeout',async()=>{
 const err=Object.assign(Error('write failed'),{code:'PROFILE_CHECKPOINT_SAVE_FAILED'});
 const f=fixture([candidate('https://orteil.dashnet.org',true,2,()=>{throw err})]);
 await assert.rejects(f.exports.checkpointProfileGroup('dashnet.org'),e=>e===err);assert.equal(f.timers.size,0);
});
test('bounded checkpoint timeout rejects and cleans deadline even if the website never answers',async()=>{
 const f=fixture([candidate('https://orteil.dashnet.org',true,2,()=>new Promise(()=>{}))]);const flight=f.exports.checkpointProfileGroup('dashnet.org');
 assert.equal(f.timers.size,1);const timer=[...f.timers.values()][0];assert.equal(timer.ms,5500);timer.fn();
 await assert.rejects(flight,{code:'PROFILE_CHECKPOINT_TIMEOUT'});assert.equal(f.timers.size,0);
});
