import test from 'node:test';import assert from 'node:assert/strict';import{openBackupNamespaceCatalog}from'../runtime/backup-v2-catalog.ts';import{createBackupV2FetchTransport}from'../web/src/backup-v2-fetch.ts';
const id='11111111-1111-4111-8111-111111111111',restoreId='22222222-2222-4222-8222-222222222222';
test('genuinely advancing checkpoint JSON can span multiple lease lifetimes: protection starts at headers, not body completion',async()=>{
 let time=0,next=0,bodyController,renewals=0,releases=0;const timers=new Map(),lost=[];
 const clock={now:()=>time,setTimeout(f,ms){const id=++next;timers.set(id,{f,at:time+ms});return id},clearTimeout:id=>timers.delete(id)};
 const raw={checkpoint:{checkpointId:id,namespaces:[]},restoreReaderPin:{version:1,leaseId:restoreId,ttlMs:120000,renewAfterMs:30000}};
 const transport=createBackupV2FetchTransport({headers:()=>({}),fetch:async(url,init)=>{
  if(url.endsWith('/restore-renew')){renewals++;assert.deepEqual(JSON.parse(init.body),{leaseId:restoreId});return Response.json({renewed:true,leaseId:restoreId,ttlMs:120000});}
  if(url.endsWith('/restore-release')){releases++;return Response.json({released:true});}
  return new Response(new ReadableStream({start(c){bodyController=c;c.enqueue(new TextEncoder().encode(' '));}}),{headers:{'content-type':'application/json','x-atlas-restore-reader':'v1'}});
 }});
 const pending=openBackupNamespaceCatalog(transport,id,undefined,restoreId,{readerLost:e=>lost.push(e),readerClock:clock});await new Promise(r=>setTimeout(r,0));
 assert.ok(timers.size>0,'reader watch must exist before full JSON');
 for(let round=0;round<8;round++){bodyController.enqueue(new TextEncoder().encode(' '));await new Promise(r=>setTimeout(r,0));time+=30000;for(const[k,t]of[...timers])if(t.at<=time){timers.delete(k);t.f();}await new Promise(r=>setTimeout(r,0));}
 assert.equal(renewals,8);assert.deepEqual(lost,[]);
 bodyController.enqueue(new TextEncoder().encode(JSON.stringify(raw)));bodyController.close();const result=await pending;
 assert.ok(result.reader);assert.equal(result.readerPin.leaseId,restoreId);result.reader.close();await new Promise(r=>setTimeout(r,0));assert.equal(releases,1);assert.equal(timers.size,0);
});
test('provisional header protection is released if the completed JSON contradicts it',async()=>{
 let releases=0;const transport=createBackupV2FetchTransport({headers:()=>({}),fetch:async(url)=>{if(url.endsWith('/restore-release')){releases++;return Response.json({released:true});}return Response.json({checkpoint:{checkpointId:id,namespaces:[]}},{headers:{'x-atlas-restore-reader':'v1'}});}});
 await assert.rejects(openBackupNamespaceCatalog(transport,id,undefined,restoreId,{readerLost(){}}),{code:'BACKUP_CATALOG_INVALID'});assert.equal(releases,1);
});
