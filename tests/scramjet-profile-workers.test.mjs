import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  installScramjetProfileWorkerInjection,
  installScramjetProfileWorkerConstructors,
  installScramjetProfileWorkerBootstrap,
} from "../runtime/scramjet-profile-workers.ts";

const protocol = "atlas-scramjet-profile-worker-v1";
const pause = () => new Promise(resolve => setTimeout(resolve, 15));
const ownerFields = { MessageEvent, MessagePort, MessageChannel, crypto };

test("normal injection retains classic/module order and repairs the pin's missing return without wrapping original source", () => {
  for (const returns of [true,false]) for (const module of [false,true]) {
    const original = (_meta,_module,script) => {
      const value=script("/normal-core.js")+script("/normal-init.js");
      if(returns)return value;
    };
    const iface={getWorkerInjectScripts:original},frame={fetchHandler:{context:{interface:iface}}};
    const handle=installScramjetProfileWorkerInjection(frame,"/profile-worker.js",{profileId:"account-A",profileContextId:"context-A"});
    const script=url=>module?`import ${JSON.stringify(url)};\n`:`importScripts(${JSON.stringify(url)});\n`;
    const value=iface.getWorkerInjectScripts({},module,script);
    assert.ok(value.includes(script("/normal-core.js")+script("/normal-init.js")));
    if(module)assert.ok(value.includes(script("/profile-worker.js")) && value.includes("import {$runtimekit$wrap"));
    else{
      const loaded=[],self={};
      const scope={self,Symbol,importScripts(url){loaded.push(url);if(url==='/normal-init.js')scope.importScripts=()=>{throw Error('stock rewriting would change bootstrap URL')};}};
      vm.runInNewContext(value,scope);
      assert.deepEqual(loaded,['/normal-core.js','/normal-init.js','/profile-worker.js']);
      assert.equal(self[Symbol.for('atlas.scramjet.profile.worker.import.v1')],undefined);
    }
    assert.ok(decodeURIComponent(value).includes('"profileId":"account-A"'));
    assert.doesNotMatch(value,/undefined|async function|async\(/);
    handle.dispose();assert.equal(iface.getWorkerInjectScripts,original);
  }
});

test("worker IDB opens queue before binding and never touch an origin@ native store", async () => {
  const owner=Object.assign(new EventTarget(),ownerFields,{location:{href:"https://front.test/worker.js"},postMessage(message){this.ready=message;}});
  let nativeCalls=0;owner.indexedDB={open(){nativeCalls++;throw Error("legacy fallback");}};
  const handle=installScramjetProfileWorkerBootstrap(owner,{url:{href:"https://site.test/worker.js"}});
  const request=owner.indexedDB.open("save-db",1);request.onerror=()=>{};
  await pause();assert.equal(nativeCalls,0);assert.equal(owner.ready.type,"ready");
  const backend=new MessageChannel(),service=new MessageChannel();
  const received=new Promise(resolve=>{backend.port2.onmessage=event=>resolve(event.data);});
  owner.dispatchEvent(new MessageEvent("message",{data:{protocol,type:"bind",documentId:handle.documentId},ports:[backend.port1,service.port1]}));
  const message=await received;
  assert.equal(message.protocol,"atlas-idb-v1");assert.equal(message.documentId,handle.documentId);
  assert.equal(message.name,"save-db");assert.equal(message.type,"open");assert.equal(nativeCalls,0);
  handle.dispose();backend.port2.close();service.port2.close();
});

test("normal stock message envelopes are bypassed by the private worker handshake and IDB transport", async () => {
  const nativePost=MessagePort.prototype.postMessage,nativeAdd=EventTarget.prototype.addEventListener;
  const nativeRemove=EventTarget.prototype.removeEventListener;
  const owner=Object.assign(new EventTarget(),ownerFields,{location:{href:'https://frontend.test/worker.js'}});
  const selfPost=function(message){this.ready=message;};
  let wrappedCalls=0;
  owner.postMessage=function(message){wrappedCalls++;selfPost.call(this,{$scramjet$data:message});};
  const client={url:{href:'https://site.test/worker.js'},natives:{store:{
    'self.postMessage':selfPost,'MessagePort.prototype.postMessage':nativePost,
    'EventTarget.prototype.addEventListener':nativeAdd,'EventTarget.prototype.removeEventListener':nativeRemove,
  }}};
  let handle;
  try{
    MessagePort.prototype.postMessage=function(...args){wrappedCalls++;return Reflect.apply(nativePost,this,[{$scramjet$data:args[0]},args[1]]);};
    EventTarget.prototype.addEventListener=function(...args){return Reflect.apply(nativeAdd,this,args);};
    handle=installScramjetProfileWorkerBootstrap(owner,client);
    owner.indexedDB.open('stock-envelope-proof',1);
  }finally{
    MessagePort.prototype.postMessage=nativePost;EventTarget.prototype.addEventListener=nativeAdd;
  }
  assert.equal(wrappedCalls,0);assert.equal(owner.ready.type,'ready');
  const backend=new MessageChannel(),service=new MessageChannel();
  const received=new Promise(resolve=>backend.port2.onmessage=event=>resolve(event.data));
  owner.dispatchEvent(new MessageEvent('message',{data:{protocol,type:'bind',documentId:handle.documentId},ports:[backend.port1,service.port1]}));
  assert.equal((await received).name,'stock-envelope-proof');
  handle.dispose();backend.port2.close();service.port2.close();
});

test("already-hooked Worker and native SharedWorker connect ports bind the requested profile owner and preserve public messages", async () => {
  class Worker extends EventTarget {
    static marker="normal-engine";
    constructor(...args){super();this.args=args;this.sent=[];this.terminated=false;}
    postMessage(message,ports=[]){this.sent.push({message,ports});}
    terminate(){this.terminated=true;}
  }
  class SharedWorker {
    constructor(...args){this.args=args;const c=new MessageChannel();this.port=c.port1;this.peer=c.port2;}
  }
  const nativeWorkerPost=Worker.prototype.postMessage;let stockEnvelopes=0;
  Worker.prototype.postMessage=function(message,ports){stockEnvelopes++;return Reflect.apply(nativeWorkerPost,this,[{$scramjet$data:message},ports]);};
  const owner={...ownerFields,Worker,SharedWorker},bindings=[],inputs=[];
  const bridge={profileId:"account-A",profileContextId:"context-A",async bindWorkerIndexedDB(input){
    inputs.push(input);const c=new MessageChannel();const value={port:c.port1,peer:c.port2,disposed:false,dispose(){this.disposed=true;this.port.close();this.peer.close();}};bindings.push(value);return value;
  }};
  const handle=installScramjetProfileWorkerConstructors(owner,{url:{href:"https://site.test/page"},natives:{store:{'Worker.prototype.postMessage':nativeWorkerPost}}},bridge);
  assert.equal(owner.Worker.marker,"normal-engine");
  const worker=new owner.Worker("/worker.js",{type:"module"});let publicMessages=0;
  worker.addEventListener("message",()=>publicMessages++);
  worker.dispatchEvent(new MessageEvent("message",{data:{protocol,type:"ready",documentId:"worker_test_document"}}));
  await pause();assert.equal(publicMessages,0);assert.equal(worker.sent[0].message.type,"bind");
  assert.equal(stockEnvelopes,0);
  assert.equal(inputs[0].website,"https://site.test/worker.js");assert.equal(worker.args[1].type,"module");
  worker.dispatchEvent(new MessageEvent("message",{data:{ordinary:true}}));assert.equal(publicMessages,1);
  const shared=new owner.SharedWorker("/shared.js",{name:"game",type:"module"});
  assert.match(shared.args[1].name,/account-A.*context-A.*game/);assert.equal(shared.args[1].type,"module");
  let sharedReply;shared.peer.onmessage=event=>{sharedReply=event;};
  shared.peer.postMessage({protocol,type:"ready",documentId:"worker_shared_document"});await pause();
  assert.equal(sharedReply.data.type,"bind");assert.equal(inputs[1].website,"https://site.test/shared.js");
  shared.peer.postMessage({protocol,type:"closed"});await pause();
  for(const port of sharedReply.ports)port.close();shared.port.close();shared.peer.close();
  worker.terminate();assert.equal(worker.terminated,true);assert.equal(bindings[0].disposed,true);
  for(const port of worker.sent[0].ports)port.close();
  handle.dispose();assert.equal(owner.Worker,Worker);assert.equal(owner.SharedWorker,SharedWorker);
  for(const binding of bindings)binding.dispose();
});

test("a worker-created worker queues its parent-owned profile bind until the upstream service arrives",async()=>{
  class Worker extends EventTarget{constructor(){super();this.sent=[];}postMessage(message,ports){this.sent.push({message,ports});}}
  const owner=Object.assign(new EventTarget(),ownerFields,{Worker,location:{href:'https://frontend.test/rewritten-worker'},postMessage(message){this.ready=message;}});
  const handle=installScramjetProfileWorkerBootstrap(owner,{url:{href:'https://website.test/worker.js'}});
  const nested=new owner.Worker('./nested.js');
  nested.dispatchEvent(new MessageEvent('message',{data:{protocol,type:'ready',documentId:'nested_worker_document'}}));
  await pause();assert.equal(nested.sent.length,0);
  const backend=new MessageChannel(),service=new MessageChannel();
  const request=new Promise(resolve=>service.port2.onmessage=event=>resolve(event.data));
  owner.dispatchEvent(new MessageEvent('message',{data:{protocol,type:'bind',documentId:handle.documentId},ports:[backend.port1,service.port1]}));
  const message=await request;assert.equal(message.type,'bind-idb');assert.equal(message.documentId,'nested_worker_document');
  assert.equal(message.website,'https://website.test/nested.js');
  const nestedBackend=new MessageChannel();
  service.port2.postMessage({protocol,type:'idb-bound',requestId:message.requestId},[nestedBackend.port1]);
  await pause();assert.equal(nested.sent[0].message.type,'bind');assert.equal(nested.sent[0].ports.length,2);
  handle.dispose();for(const port of nested.sent[0].ports)port.close();backend.port2.close();service.port2.close();nestedBackend.port2.close();
});

test("SharedWorker bootstrap uses each native connect port while retaining its first live profile backend",async()=>{
  const owner=Object.assign(new EventTarget(),ownerFields,{location:{href:'https://frontend.test/shared-worker'}});
  const handle=installScramjetProfileWorkerBootstrap(owner,{url:{href:'https://website.test/shared.js'}});
  const first=new MessageChannel(),second=new MessageChannel(),backend=new MessageChannel(),service=new MessageChannel();
  const firstReady=new Promise(resolve=>first.port2.onmessage=event=>resolve(event.data));
  owner.dispatchEvent(new MessageEvent('connect',{ports:[first.port1]}));assert.equal((await firstReady).type,'ready');
  const request=owner.indexedDB.open('shared-profile-store',1);request.onerror=()=>{};
  const open=new Promise(resolve=>backend.port2.onmessage=event=>resolve(event.data));
  first.port2.postMessage({protocol,type:'bind',documentId:handle.documentId},[backend.port1,service.port1]);
  assert.equal((await open).name,'shared-profile-store');
  const secondReady=new Promise(resolve=>second.port2.onmessage=event=>resolve(event.data));
  owner.dispatchEvent(new MessageEvent('connect',{ports:[second.port1]}));assert.equal((await secondReady).type,'ready');
  const extra=new MessageChannel(),extraService=new MessageChannel();
  const declined=new Promise(resolve=>second.port2.onmessage=event=>resolve(event.data));
  second.port2.postMessage({protocol,type:'bind',documentId:handle.documentId},[extra.port1,extraService.port1]);
  assert.equal((await declined).type,'declined');
  handle.dispose();for(const port of[first.port1,first.port2,second.port1,second.port2,backend.port2,service.port2,extra.port2,extraService.port2])port.close();
});
