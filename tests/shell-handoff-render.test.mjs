import test from 'node:test';
import assert from 'node:assert/strict';
import {sameShellHandoff,profileHandoffForWebsite} from '../web/src/profile-handoff-view.ts';
const states=['restoring','local','pending','synced','offline','conflict','error'];
test('all non-handoff status transitions preserve null ownership UI and skip shell work',()=>{
 for(const a of states)for(const b of states){const previous={state:a,message:'Previous status'},next={state:b,message:'Real new save status'};assert.equal(sameShellHandoff(previous,next),true);for(const website of ['https://chatgpt.com/c/example','https://example.com/'])assert.equal(profileHandoffForWebsite(previous,website),profileHandoffForWebsite(next,website));}
});
test('entering, changing, and clearing actual handoffs always updates the shell',()=>{
 const normal={state:'synced',message:'Synced'};
 for(const phase of ['offered','waiting','releasing','paused']){
  const next={state:'pending',message:'Save state',handoff:{phase,siteGroup:'chatgpt.com'}};
  assert.equal(sameShellHandoff(normal,next),false);assert.equal(sameShellHandoff(next,normal),false);
  assert.equal(sameShellHandoff(next,{...next,handoff:{...next.handoff,error:'Retry needed'}}),false);
  assert.equal(sameShellHandoff(next,next),true);
 }
 assert.equal(sameShellHandoff(normal,{...normal,canContinue:true,origin:'https://chatgpt.com'}),false);
});
