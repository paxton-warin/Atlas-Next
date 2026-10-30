import test from 'node:test';
import assert from 'node:assert/strict';
const {createSandboxPopupBroker}=await import(process.env.ATLAS_POPUP_SOURCE_PATH || '../runtime/sandbox-popups.ts');
function owner(){const listeners=new Set(),intervals=new Map();let serial=0;return {location:{origin:'https://front.example',hostname:'front.example'},crypto:globalThis.crypto,addEventListener(type,fn){assert.equal(type,'message');listeners.add(fn);},removeEventListener(_type,fn){listeners.delete(fn);},setInterval(fn){const n=++serial;intervals.set(n,fn);return n;},clearInterval(n){intervals.delete(n);},listeners,intervals,tick(){for(const fn of intervals.values())fn();}};}
const settle=()=>new Promise(res=>setImmediate(res));
test('initial429 spare reserve returns a disposable empty broker with bounded retries',async t=>{
 let now=100000,attempts=0,healthy=false,disposed=0;
 t.mock.method(Date,'now',()=>now);const win=owner(),posts=[];
 const broker=await createSandboxPopupBroker({window:win,parentWindow:{},documentId:'parent',website:()=> 'https://site.example/',active:()=>true,
  async reserve(input){attempts++;if(!healthy)throw Object.assign(Error('rate limited'),{status:429});return {frameURL:win.location.origin+'/browse/popup/'+input.documentId,resourceOrigin:'https://node.example',serverBootstrapNonce:true,expiresAt:now+120000,dispose(){disposed++;}};},bind(){assert.fail('No popup was opened');},post:m=>posts.push(m),deliverOpener(){assert.fail('No popup message');}});
 assert.equal(attempts,1);assert.deepEqual(broker.entries(),[]);assert.equal(typeof broker.dispose,'function');
 for(let i=0;i<100;i++)win.tick();await settle();assert.equal(attempts,1);
 now+=1000;win.tick();await settle();assert.equal(attempts,2);
 now+=1999;for(let i=0;i<100;i++)win.tick();await settle();assert.equal(attempts,2);
 now+=1;healthy=true;win.tick();await settle();assert.equal(attempts,4);assert.equal(broker.entries().length,2);
 assert.ok(posts.some(m=>m.type==='popup-pool'&&m.entries.length===0));
 broker.dispose();assert.equal(disposed,2);assert.equal(win.listeners.size,0);assert.equal(win.intervals.size,0);
 now+=60000;win.tick();await settle();assert.equal(attempts,4);
});
test('a partially reserved pool survives a later429 and disposal revokes the retained spare',async()=>{
 const win=owner();let calls=0,revoked=0;const broker=await createSandboxPopupBroker({window:win,parentWindow:{},documentId:'parent',website:()=> 'https://site.example/',active:()=>true,async reserve(input){if(++calls===2)throw Error('429');return {frameURL:win.location.origin+'/browse/popup/'+input.documentId,resourceOrigin:'https://node.example',serverBootstrapNonce:true,dispose(){revoked++;}};},bind(){assert.fail();},post(){},deliverOpener(){}});
 assert.equal(broker.entries().length,1);broker.dispose();assert.equal(revoked,1);assert.equal(win.listeners.size,0);assert.equal(win.intervals.size,0);
});
