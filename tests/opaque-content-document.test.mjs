import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOpaqueContentDocumentParity} from '../runtime/opaque-runtime-adapter.ts';
const names=['HTMLIFrameElement','HTMLFrameElement','HTMLObjectElement','HTMLEmbedElement'];
function fixture(){
 const realm={Object:{getOwnPropertyDescriptor:Object.getOwnPropertyDescriptor,defineProperty:Object.defineProperty},Reflect:{apply:Reflect.apply}};
 const receivers=new WeakMap(),traps=[],originals=[];
 for(const name of names){
  const prototype={};realm[name]={prototype};
  const original=function(){if(!receivers.has(this))throw new TypeError('Illegal invocation');const value=receivers.get(this);if(value instanceof Error)throw value;return value};
  Object.defineProperty(prototype,'contentDocument',{get:original,enumerable:true,configurable:true});originals.push(original);
 }
 const install=captureOpaqueContentDocumentParity(realm);
 for(const [index,name]of names.entries()){
  const prototype=realm[name].prototype;
  const trap=function(){traps.push({index,receiver:this});throw Object.assign(new Error('unqualified subcontext'),{name:'NotSupportedError'})};
  Object.defineProperty(prototype,'contentDocument',{get:trap,enumerable:index%2===0,configurable:true});
 }
 const receiver=(name,value)=>{const object=Object.create(realm[name].prototype);receivers.set(object,value);return object};
 return{realm,receivers,traps,originals,install,receiver};
}
test('only literal native null bypasses existing core trap, for all supported element brands',()=>{
 const f=fixture();assert.equal(f.install(),4);assert.equal(f.install(),4);
 for(const name of names){const receiver=f.receiver(name,null);Object.defineProperty(receiver,'constructor',{get(){throw Error('constructor must not be read')}});assert.equal(receiver.contentDocument,null)}
 assert.deepEqual(f.traps,[]);
});
test('native non-null Document always delegates core hookSubcontext denial; no native object escape',()=>{
 const f=fixture();f.install();
 for(const [i,name]of names.entries()){
  const privateDocument={defaultView:{nativeConstructor:class{}},sentinel:'native-not-readable'};
  const receiver=f.receiver(name,privateDocument);
  assert.throws(()=>receiver.contentDocument,{name:'NotSupportedError'});
  assert.equal(f.traps.at(-1).index,i);assert.equal(f.traps.at(-1).receiver,receiver);
 }
 assert.equal(f.traps.length,4);
});
test('native brands/errors precede constructor spoofing and are not normalized to null',()=>{
 const f=fixture();f.install();
 for(const name of names){
  const get=Object.getOwnPropertyDescriptor(f.realm[name].prototype,'contentDocument').get;
  const spoof={get constructor(){throw Error('spoof read')}};
  assert.throws(()=>Reflect.apply(get,spoof,[]),{name:'TypeError',message:'Illegal invocation'});
  const error=new Error('native failure'),receiver=f.receiver(name,error);
  assert.throws(()=>receiver.contentDocument,e=>e===error);
 }
 assert.equal(f.traps.length,0);
});
test('captured dispatch is stable after mutable realm intrinsics change; installed flags remain core flags',()=>{
 const f=fixture();f.install();
 f.realm.Reflect.apply=()=>{throw Error('poisoned apply')};f.realm.Object.getOwnPropertyDescriptor=()=>{throw Error('poisoned descriptor')};f.realm.Object.defineProperty=()=>{throw Error('poisoned define')};
 for(const [i,name]of names.entries()){
  const descriptor=Object.getOwnPropertyDescriptor(f.realm[name].prototype,'contentDocument');
  assert.equal(descriptor.enumerable,i%2===0);assert.equal(descriptor.configurable,true);assert.equal(descriptor.set,undefined);
  assert.equal(f.receiver(name,null).contentDocument,null);
  assert.throws(()=>f.receiver(name,{}).contentDocument,{name:'NotSupportedError'});
 }
});
test('missing native interfaces remain absent; missing core hook fails closed before wrapper installation',()=>{
 const realm={Object,Reflect};assert.equal(captureOpaqueContentDocumentParity(realm)(),0);
 const prototype={};const native=()=>({defaultView:'never-expose'});Object.defineProperty(prototype,'contentDocument',{get:native,configurable:true});
 const only={Object,Reflect,HTMLIFrameElement:{prototype}};
 const install=captureOpaqueContentDocumentParity(only);
 assert.throws(install,/core hook was not installed/);assert.equal(Object.getOwnPropertyDescriptor(prototype,'contentDocument').get,native);
});
