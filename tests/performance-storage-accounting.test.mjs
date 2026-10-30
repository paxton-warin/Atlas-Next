import test from 'node:test';
import assert from 'node:assert/strict';
import { localIDBRecordUsage } from '../runtime/local-idb-accounting.ts';
import { boundedIDBValueBytes as measure, compareSandboxKeys } from '../runtime/sandbox-idb.ts';
const limits={quotaBytes:8*1024*1024,maxValueNodes:40000,maxValueDepth:64,maxStores:32,maxIndexes:16,maxRecords:20000,maxIndexEntries:100000};
const store=()=>({indexNames:['tags'],index(){return{keyPath:'tags',multiEntry:true}}});
function previous(key,value,factory){const result={bytes:64+measure(key,limits.quotaBytes)+measure(value,limits.quotaBytes),records:1,indexEntries:0},seen=[];for(const candidate of value.tags){try{factory.cmp(candidate,candidate)}catch{continue}if(seen.some(k=>factory.cmp(k,candidate)===0))continue;seen.push(candidate);result.indexEntries++;result.bytes+=32+measure(candidate,limits.quotaBytes)+measure(key,limits.quotaBytes)}return result}
test('sorted multiEntry accounting preserves typed key equality, invalid keys, source order and exact bytes',()=>{
 const tags=[['a',2],new Date(3),'x',3,NaN,{},new Uint8Array([2,3]),new Uint8Array([2,3]).buffer,3,new Date(3),['a',2],[]];const value={tags},before=[...tags],factory={cmp:compareSandboxKeys};
 assert.deepEqual(localIDBRecordUsage(store(),'primary',value,measure,limits,factory),previous('primary',value,factory));assert.deepEqual(tags,before);
});
test('distinct multiEntry accounting comparisons grow subquadratically and measure primary key once',()=>{
 const tags=Array.from({length:4096},(_,i)=>(i*2003)%4096),value={tags};let comparisons=0,keyMeasures=0;
 const result=localIDBRecordUsage(store(),'primary',value,(v,...rest)=>{if(v==='primary')keyMeasures++;return measure(v,...rest)},limits,{cmp(a,b){comparisons++;return compareSandboxKeys(a,b)}});
 assert.equal(result.indexEntries,4096);assert.equal(keyMeasures,1);assert.ok(comparisons<100000,'comparison count='+comparisons);assert.equal(new Set(tags).size,4096);
});
test('compound non-multiEntry and empty indexes retain exact accounting',()=>{
 const source={indexNames:['compound','missing'],index(name){return name==='compound'?{keyPath:['a','b'],multiEntry:false}:{keyPath:'absent',multiEntry:false}}};
 const value={a:2,b:'b'},key=new Date(40),result=localIDBRecordUsage(source,key,value,measure,limits,{cmp:compareSandboxKeys});
 assert.equal(result.indexEntries,1);assert.equal(result.bytes,64+measure(key,limits.quotaBytes)+measure(value,limits.quotaBytes)+32+measure([2,'b'],limits.quotaBytes)+measure(key,limits.quotaBytes));
});

test('empty native index keyPath indexes the whole value rather than a property named empty string',()=>{
 const value=['a','b','a'],source={indexNames:['whole'],index(){return{keyPath:'',multiEntry:true}}};
 const result=localIDBRecordUsage(source,1,value,measure,limits,{cmp:compareSandboxKeys});assert.equal(result.indexEntries,2);
 const primitive=localIDBRecordUsage({indexNames:['whole'],index(){return{keyPath:'',multiEntry:false}}},1,'whole',measure,limits,{cmp:compareSandboxKeys});assert.equal(primitive.indexEntries,1);
});

test('compound native index keyPath may contain the empty whole-value component',()=>{
 const source={indexNames:['compound-whole'],index(){return{keyPath:[''],multiEntry:false}}},value='whole';
 const result=localIDBRecordUsage(source,1,value,measure,limits,{cmp:compareSandboxKeys});assert.equal(result.indexEntries,1);assert.equal(result.bytes,64+measure(1,limits.quotaBytes)+measure(value,limits.quotaBytes)+32+measure(['whole'],limits.quotaBytes)+measure(1,limits.quotaBytes));
});
