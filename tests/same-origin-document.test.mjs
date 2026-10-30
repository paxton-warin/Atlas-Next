import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {assertDocumentOrigin, resolveDocumentOrigin, documentContentPolicies} from '../runtime/document-origin.ts';
import {nestedDocumentSandbox} from '../runtime/opaque-nested-frames.ts';
import {createOriginalDocumentPolicy} from '../runtime/original-document-policy.ts';
import {createSandboxStorageFacades, rebindSandboxStorageFacades} from '../runtime/sandbox-local-storage.ts';
import {workerBootstrap} from '../runtime/opaque-workers.ts';
import {composeDocumentBootstrap} from '../scripts/build-opaque-runtime.mjs';

const physical='https://frontend.test';
test('trusted origin mode defaults opaque and same-origin matches the physical browser origin exactly',()=>{
 assert.equal(resolveDocumentOrigin(), 'opaque');
 assert.equal(assertDocumentOrigin({origin:'null'}), 'opaque');
 assert.equal(assertDocumentOrigin({origin:physical,location:{origin:physical}},'same-origin'),'same-origin');
 for(const mode of[null,'sameOrigin',true,{},''])assert.throws(()=>resolveDocumentOrigin(mode),TypeError);
 assert.throws(()=>assertDocumentOrigin({origin:physical,location:{origin:physical}}),TypeError);
 for(const owner of[{origin:'null',location:{origin:physical}},{origin:'https://other.test',location:{origin:physical}},{origin:'null',location:{origin:'null'}},{origin:physical},{origin:'data:invalid',location:{origin:'data:invalid'}}])assert.throws(()=>assertDocumentOrigin(owner,'same-origin'),TypeError);
});

test('generated entry captures only the trusted script attribute before the copied core executes',()=>{
 for(const[attr,expected]of[[undefined,'opaque'],['same-origin','same-origin'],['opaque','opaque'],['SAME-ORIGIN','opaque']]){
  const window={},document={currentScript:{dataset:attr===undefined?{}:{atlasDocumentOrigin:attr}}};
  const source=composeDocumentBootstrap({core:'document.currentScript.dataset.atlasDocumentOrigin="opaque";self.$runtimekit={fixture:true};',documentSource:'var AtlasOpaqueDocument={installOpaqueDocument(options){window.received=options;}};',wasm:Buffer.from([1,2,3])});
  const context={window,document,self:{},Uint8Array,atob};vm.runInNewContext(source.toString(),context);
  assert.equal(window.received.documentOrigin,expected);assert.deepEqual([...window.received.wasm],[1,2,3]);assert.equal(Object.hasOwn(context,'documentOrigin'),false);
 }
});

test('same-origin upstream policy removal does not change opaque policy qualification',()=>{
 const upstream=["sandbox allow-scripts; script-src 'none'"];
 assert.equal(documentContentPolicies('opaque',upstream),upstream);
 assert.throws(()=>createOriginalDocumentPolicy({documentURL:'https://website.test/',contentPolicies:documentContentPolicies('opaque',upstream)}),{code:'original_policy_unsupported_directive'});
 const policy=createOriginalDocumentPolicy({documentURL:'https://website.test/',contentPolicies:documentContentPolicies('same-origin',upstream)});
 assert.deepEqual(policy.snapshot,[]);assert.doesNotThrow(()=>policy.checkEval('javascript'));assert.deepEqual(upstream,["sandbox allow-scripts; script-src 'none'"]);
});

test('nested iframe sandbox follows only the explicit trusted document composition',()=>{
 assert.equal(nestedDocumentSandbox('opaque',null),'allow-scripts allow-popups');
 assert.equal(nestedDocumentSandbox('same-origin',null),'allow-scripts allow-popups allow-same-origin');
 assert.equal(nestedDocumentSandbox('opaque','allow-scripts allow-same-origin allow-forms'),'allow-scripts allow-forms');
 assert.equal(nestedDocumentSandbox('same-origin','allow-scripts allow-same-origin allow-forms'),'allow-scripts allow-forms allow-same-origin');
 assert.throws(()=>nestedDocumentSandbox('unexpected',null),TypeError);
});

async function storageFixture(origin,documentOrigin){
 const values=new WeakMap();
 const map=receiver=>{if(!values.has(receiver))throw new TypeError('Illegal invocation');return values.get(receiver);};
 class Storage{
  constructor(){values.set(this,new Map());}
  key(index){return[...map(this).keys()][index]??null;}
  getItem(key){return map(this).get(String(key))??null;}
  setItem(key,value){map(this).set(String(key),String(value));}
  removeItem(key){map(this).delete(String(key));}
  clear(){map(this).clear();}
  get length(){return map(this).size;}
 }
 class ACKXHR{open(){}setRequestHeader(){}send(){}get status(){return 200;}get responseText(){return'{"ok":true,"revision":1}';}}
 const owner={origin,location:{origin:physical,href:physical+'/'},MessageEvent,MessagePort,EventTarget,Uint8Array,XMLHttpRequest:ACKXHR,Storage,setTimeout,clearTimeout};
 const nativeGet=Storage.prototype.getItem,channel=new MessageChannel(),documentId='same_origin_storage_document';
 channel.port1.postMessage({type:'ready',documentId,snapshots:{local:{revision:0,entries:[['saved','hydrated']]},session:{revision:0,entries:[]}}});
 const facades=await createSandboxStorageFacades({window:owner,documentOrigin,documentId,endpoint:physical+'/browse/storage/commit/'+'a'.repeat(43),port:channel.port2});
 return{owner,nativeGet,facades,port:channel.port1,documentId,close(){facades.dispose();channel.port1.close();}};
}
for(const[origin,mode]of[['null',undefined],[physical,'same-origin']])test(`borrowed native Storage methods hydrate and retain receiver brands in ${mode||'opaque'} mode`,async()=>{
 const f=await storageFixture(origin,mode);try{
  const prototype=f.owner.Storage.prototype;assert.notEqual(prototype.getItem,f.nativeGet);
  assert.equal(prototype.getItem.call(f.facades.localStorage,'saved'),'hydrated');
  assert.equal(Object.getOwnPropertyDescriptor(prototype,'length').get.call(f.facades.localStorage),1);
  prototype.setItem.call(f.facades.localStorage,'next','committed');assert.equal(prototype.getItem.call(f.facades.localStorage,'next'),'committed');
  const native=new f.owner.Storage();prototype.setItem.call(native,'native','native-value');assert.equal(prototype.getItem.call(native,'native'),'native-value');
  assert.throws(()=>prototype.getItem.call({},'saved'),TypeError);
 }finally{f.close();}
});
test('ordinary same-origin frontend Storage prototype remains untouched without the explicit child mode',async()=>{
 const f=await storageFixture(physical,undefined);try{assert.equal(f.owner.Storage.prototype.getItem,f.nativeGet);}finally{f.close();}
});

test('normal profile installation clones hydrated views into each child without patching frontend Storage',async()=>{
 const f=await storageFixture(physical,undefined);
 const child=()=>{class Storage{key(){throw new TypeError('native brand');}getItem(){throw new TypeError('native brand');}setItem(){throw new TypeError('native brand');}removeItem(){throw new TypeError('native brand');}clear(){throw new TypeError('native brand');}get length(){throw new TypeError('native brand');}}return{Storage};};
 const first=child(),second=child();
 try{
  rebindSandboxStorageFacades(f.facades,first);rebindSandboxStorageFacades(f.facades,second);
  assert.equal(f.owner.Storage.prototype.getItem,f.nativeGet);
  assert.notEqual(first.localStorage,second.localStorage);assert.notEqual(first.localStorage,f.facades.localStorage);
  assert.equal(first.localStorage instanceof first.Storage,true);assert.equal(second.localStorage instanceof second.Storage,true);
  assert.equal(first.Storage.prototype.getItem.call(first.localStorage,'saved'),'hydrated');
  first.Storage.prototype.setItem.call(first.localStorage,'shared','committed');assert.equal(second.localStorage.getItem('shared'),'committed');
  assert.throws(()=>first.Storage.prototype.getItem.call({},'saved'),TypeError);
  f.facades.dispose();assert.throws(()=>second.localStorage.getItem('saved'),{name:'InvalidStateError'});
 }finally{f.close();}
});

async function bootstrapFixture(origin,documentOrigin){
 const old=globalThis.self;let receive,bootOptions,closed=false,imported;
 globalThis.self={origin,location:{origin:physical},addEventListener(_type,listener){receive=listener;},removeEventListener(){},dispatchEvent(){},eval,importScripts(value){imported=value;},close(){closed=true;}};
 const channel=new MessageChannel();
 try{
  workerBootstrap(options=>{bootOptions=options;return{graph:{prepare:async()=>({entry:'prepared-classic-source'}),executableURL:value=>value},dispose(){}};});
  const reply=new Promise(resolve=>{channel.port2.onmessage=e=>resolve(e.data);});
  receive(new MessageEvent('message',{data:{type:'atlas-opaque-worker-init'},ports:[channel.port1]}));
  channel.port2.postMessage({type:'boot',kind:'classic',documentOrigin,source:{url:'https://website.test/worker.js'},credentials:'same-origin'});
  const result=await Promise.race([reply,new Promise((_,reject)=>setTimeout(()=>reject(Error('bootstrap result timed out')),1500).unref())]);
  return{result,bootOptions,closed,imported};
 }finally{channel.port1.close();channel.port2.close();if(old===undefined)delete globalThis.self;else globalThis.self=old;}
}
test('worker private bootstrap payload preserves opaque default and validates explicit same-origin before execution',async()=>{
 for(const[origin,mode]of[['null',undefined],[physical,'same-origin']]){
  const r=await bootstrapFixture(origin,mode);assert.equal(r.result.type,'ready');assert.equal(r.bootOptions.documentOrigin,mode||'opaque');assert.equal(r.imported,'prepared-classic-source');assert.equal(r.closed,false);
 }
 for(const[origin,mode]of[[physical,undefined],['null','same-origin'],[physical,'unexpected'],[physical,null]]){
  const r=await bootstrapFixture(origin,mode);assert.equal(r.result.type,'error');assert.equal(r.result.name,'TypeError');assert.equal(r.bootOptions,undefined);assert.equal(r.imported,undefined);assert.equal(r.closed,true);
 }
});

test('same-origin document omits restrictive execution CSP and passes the explicit mode to child components',async()=>{
 const source=await readFile(new URL('../runtime/opaque-document.ts',import.meta.url),'utf8');
 assert.match(source,/executionPolicy: originalPolicy && documentOrigin === "opaque"/);
 for(const component of['createSandboxStorageFacades','createOpaqueWorkerManager','createOpaqueNestedFrames','bootOpaqueRuntimeClient'])assert.match(source,new RegExp(component+'\\(\\{[\\s\\S]{0,220}documentOrigin'));
});


test('normal hydrated child views receive cross-document storage events in their own realm, not Atlas', async()=>{
 const f=await storageFixture(physical,undefined);
 class StorageEvent extends Event { constructor(type,values){super(type);Object.assign(this,values);} }
 const child=()=>{class Storage{key(){}getItem(){}setItem(){}removeItem(){}clear(){}get length(){return 0;}}return Object.assign(new EventTarget(),{Storage,StorageEvent,document:{URL:'https://site.test/page'}});};
 const a=child(),b=child(),eventsA=[],eventsB=[];
 a.addEventListener('storage',e=>eventsA.push(e));b.addEventListener('storage',e=>eventsB.push(e));
 try {
  const boundA=rebindSandboxStorageFacades(f.facades,a),boundB=rebindSandboxStorageFacades(f.facades,b);
  a.localStorage.setItem('game','durable');await new Promise(r=>setImmediate(r));
  assert.equal(eventsA.length,0);assert.equal(eventsB.length,1);assert.equal(eventsB[0].storageArea,b.localStorage);
  assert.equal(eventsB[0].key,'game');assert.equal(eventsB[0].newValue,'durable');assert.equal(eventsB[0].url,'https://site.test/page');
  f.port.postMessage({type:'snapshot',documentId:f.documentId,kind:'local',snapshot:{revision:5,entries:[['game','remote']]},change:{sourceDocumentId:'other_document',url:'https://site.test/other',key:'game',oldValue:'durable',newValue:'remote'}});
  await new Promise(r=>setTimeout(r,10));assert.equal(eventsA.length,1);assert.equal(eventsB.length,2);assert.equal(eventsA[0].storageArea,a.localStorage);assert.equal(a.localStorage.getItem('game'),'remote');
  boundA.dispose();boundB.dispose();f.close();
 }finally{f.close();}
});
