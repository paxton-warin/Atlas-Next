import test from 'node:test';import assert from 'node:assert/strict';
import{createPrivateCookieLocalView}from'../runtime/cookie-local-view.ts';
import{applyCookieViewDelta,cookieViewString}from'../runtime/sandbox-cookie-result.ts';
const entry=(id,value=id,path='/',expiresAt=null)=>({id,name:'same',value,path,created:1,expiresAt});
const delta=(upsert=[],remove=[])=>({baseVersion:1,baseRevision:2,upsert,remove});
test('owned cookie state matches ordered reference across changes, expiry and duplicate names',()=>{
 const realNow=Date.now;let now=100;Date.now=()=>now;
 try{let reference=[entry('a','root'),entry('b','nested','/messages'),entry('c','soon','/',120)];const state=createPrivateCookieLocalView();assert.equal(state.replace(reference,now),cookieViewString(reference,now));
 for(let index=0;index<400;index++){now++;const change=index%5===0?delta([],['key'+index%23]):delta([entry('key'+index%23,'value'+index,index%2?'/':'/messages',index%3?null:now+6)]);reference=applyCookieViewDelta(reference,change);assert.equal(state.update(change,now),cookieViewString(reference,now));const expiries=reference.filter(e=>e.expiresAt!==null&&e.expiresAt>now).map(e=>e.expiresAt);assert.equal(state.expiresAt,expiries.length?Math.min(...expiries):null)}state.clear();assert.equal(state.update(delta(),now),'');assert.equal(state.expiresAt,null);
 }finally{Date.now=realNow}
});
test('snapshot and accepted-delta aliases cannot mutate the private cached view',()=>{
 const state=createPrivateCookieLocalView(),initial=[entry('a','accepted')];state.replace(initial,1);initial[0].value='corrupted';initial.push(entry('x'));assert.equal(state.update(delta(),1),'same=accepted');
 const changed=delta([entry('a','new')]);assert.equal(state.update(changed,1),'same=new');changed.upsert[0].value='corrupted';changed.upsert.length=0;assert.equal(state.update(delta(),1),'same=new');
});
test('per-set validation work does not grow with previously accepted jar size',()=>{
 const original=Object.keys;for(const size of[1,180]){const state=createPrivateCookieLocalView();state.replace(Array.from({length:size},(_,i)=>entry('key'+i)),1);let entryChecks=0;Object.keys=value=>{if(value&&Object.hasOwn(value,'id'))entryChecks++;return original(value)};
 try{for(let i=0;i<40;i++)state.update(delta([entry('key0')]),1)}finally{Object.keys=original}
 assert.equal(entryChecks,80,'only delta ingress + copied primitive entry validate, not existing'+size+'rows');}
});
test('count allowance is checked before accepted state changes; expiry permits a bounded replacement',()=>{
 const state=createPrivateCookieLocalView(),initial=Array.from({length:180},(_,i)=>entry('key'+i));const before=state.replace(initial,1);assert.throws(()=>state.update(delta([entry('new')]),1),{name:'QuotaExceededError'});assert.equal(state.update(delta(),1),before);
 initial[0].expiresAt=2;state.replace(initial,1);assert.ok(state.update(delta([entry('new')]),3).includes('same=new'));assert.equal(state.expiresAt,null);
});
test('malformed, duplicate, inherited and accessor entry fields fail without replacing owned state',()=>{
 const state=createPrivateCookieLocalView();state.replace([entry('good')],1);
 for(const bad of[[entry('a'),entry('a')],[{...entry('bad'),extra:1}],[Object.create(entry('inherited'))],[{...entry('bad'),expiresAt:NaN}],[Object.defineProperty(entry('bad'),'value',{get(){throw Error('must not run accessor')},enumerable:true})]]){assert.throws(()=>state.replace(bad,1));assert.equal(state.update(delta(),1),'same=good')}
 assert.throws(()=>state.update(delta([entry('a'),entry('b')]),1),{name:'SecurityError'});assert.equal(state.update(delta(),1),'same=good');
});
