import test from 'node:test';
import assert from 'node:assert/strict';
import {newCookieResultKey,sealCookieResult,openCookieResult,validateCookieViewEntries,
 applyCookieViewDelta,cookieViewString} from '../runtime/sandbox-cookie-result.ts';
const entry=(id,value,path='/')=>({id,name:'preference',value,path,created:1,expiresAt:null});
test('local cookie setters authenticate an accepted change, not a complete jar snapshot',()=>{
 const key=newCookieResultKey(), packet={documentId:'document_local_cookie_1234',sequence:2,operation:'set',view:'',viewVersion:2,
  expiresAt:null,localMode:2,cookieRevision:8,delta:{baseVersion:1,baseRevision:7,upsert:[entry('id-2','changed','/messages')],remove:[]}};
 const opened=openCookieResult(key,sealCookieResult(key,packet),packet), initial=[entry('id-1','root')];
 assert.equal(cookieViewString(applyCookieViewDelta(initial,opened.delta)),'preference=changed; preference=root');
 assert.equal(cookieViewString(initial),'preference=root');
 assert.equal(opened.view,'');assert.equal(Object.hasOwn(opened,'entries'),false);
});
test('missing, unbounded, or mixed legacy/v2 cookie deltas cannot be treated as successful setters',()=>{
 const key=newCookieResultKey(), base={documentId:'document_local_cookie_1234',sequence:1,operation:'set',view:'',viewVersion:1,
   expiresAt:null,localMode:2,cookieRevision:1,delta:{baseVersion:0,baseRevision:0,upsert:[],remove:[]}};
 for(const bad of [{...base,delta:undefined},{...base,view:'entire=jar'},
   {...base,entries:[]},{...base,cookieRevision:-1},{...base,localMode:undefined},
   {...base,delta:{...base.delta,upsert:[entry('1','a'),entry('2','b')]}}]) {
   assert.throws(()=>openCookieResult(key,sealCookieResult(key,bad),bad),{name:'SecurityError'});
 }
 assert.equal(validateCookieViewEntries(Array(181).fill(entry('id','x'))),false);
});
test('local cookie initialized snapshots retain path ordering, duplicate names and expiry',()=>{
 const initial=[entry('root','root'),entry('path','private','/messages'),{...entry('expired','gone'),expiresAt:10}];
 assert.equal(cookieViewString(initial,20),'preference=private; preference=root');
 assert.equal(cookieViewString(applyCookieViewDelta(initial,{baseVersion:1,baseRevision:4,upsert:[],remove:['path']}),20),'preference=root');
});
