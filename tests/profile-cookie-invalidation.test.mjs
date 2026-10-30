import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileLocalStore } from '../web/src/profile-local-store.ts';
const profile='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t) {
 const values=new Map();let counter=0;
 class Document { get cookie(){return [...values].map(([k,v])=>k+'='+v).join('; ')} set cookie(line){const[k,v]=line.split(';')[0].split('=');if(line.includes('Max-Age=0'))values.delete(k);else values.set(k,v)} }
 const old=globalThis.window;globalThis.window={Document,document:new Document(),location:{protocol:'https:'},crypto:{randomUUID:()=>String(++counter).padStart(32,'0')}};
 t.after(()=>{if(old===undefined)delete globalThis.window;else globalThis.window=old});
 const events=new EventTarget(),sent=[];
 const reply=(id,value)=>events.dispatchEvent(new MessageEvent('message',{data:{protocol:'atlas-profile-local-v1',id,...value}}));
 const worker={addEventListener:(...args)=>events.addEventListener(...args),removeEventListener:(...args)=>events.removeEventListener(...args),terminate(){},postMessage(data){sent.push(data);if(data.operation==='initialize')queueMicrotask(()=>reply(data.id,{ok:true}))}};
 const store=createProfileLocalStore(profile,{createWorker:()=>worker});t.after(()=>store.dispose());
 return {store,sent,reply,epoch:()=>values.get('__Host-atlas-cookie-view-epoch-v1')};
}
test('cookie profile restore invalidates before and after its authoritative worker acknowledgement',async t=>{
 const f=fixture(t),before=f.epoch();const pending=f.store.restore({kind:'cookies',origin:'https://fixture.example'},null,[],{epoch:1,revision:2});const during=f.epoch();assert.notEqual(during,before);await tick();const request=f.sent.at(-1);assert.equal(request.operation,'restore');f.reply(request.id,{ok:true});await pending;assert.notEqual(f.epoch(),during);
});
test('failed cookie restore still invalidates after uncertainty and preserves the exact error',async t=>{
 const f=fixture(t);const pending=f.store.restore({kind:'cookies',origin:'https://fixture.example'},null,[],{epoch:1,revision:2});const outcome=assert.rejects(pending,/RESTORE_FAILED/),during=f.epoch();await tick();f.reply(f.sent.at(-1).id,{ok:false,error:{name:'Error',message:'RESTORE_FAILED'}});await outcome;assert.notEqual(f.epoch(),during);
});
test('non-cookie restore does not introduce cookie metadata writes',async t=>{
 const f=fixture(t),before=f.epoch();const pending=f.store.restore({kind:'local',origin:'https://fixture.example'},null,[],{epoch:1,revision:2});await tick();assert.equal(f.epoch(),before);f.reply(f.sent.at(-1).id,{ok:true});await pending;assert.equal(f.epoch(),before);
});
