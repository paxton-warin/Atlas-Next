import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {installBackupV2Proxy,backupV2Operation} from '../server/hub-backups-v2-proxy.mjs';
const base='/api/hub/profile/backups/v2',id='11111111-1111-4111-8111-111111111111',sha='a'.repeat(64);
const fail=(message,statusCode=400,code='INVALID')=>Object.assign(new Error(message),{statusCode,code});
async function fixture(t,fetcher){const app=Fastify();let authenticated=0,csrf=0;installBackupV2Proxy(app,{enabled:true,requireSession:async()=>{authenticated++;return {token:'session',branch:{id,secret:'secret'}};},csrf:()=>{csrf++;},hubOrigin:'https://hub.test',requestFetch:fetcher,fail});await app.ready();t.after(()=>app.close());return {app,counts:()=>({authenticated,csrf})};}
test('bounded binary upload streams through Main without JSON or base64 conversion',async t=>{
 let captured;const {app,counts}=await fixture(t,async(url,init)=>{const chunks=[];for await(const chunk of init.body)chunks.push(chunk);captured={url,init,bytes:Buffer.concat(chunks)};return Response.json({stored:true});});
 const bytes=Buffer.alloc(262144,173),response=await app.inject({method:'PUT',url:base+`/staging/${id}/parts/${sha}`,headers:{'content-type':'application/octet-stream'},payload:bytes});
 assert.equal(response.statusCode,200);assert.deepEqual(captured.bytes,bytes);assert.equal(captured.init.duplex,'half');assert.equal(captured.init.headers['content-type'],'application/octet-stream');assert.deepEqual(counts(),{authenticated:1,csrf:1});
});
test('binary download and gateway HTTP status are retained without JSON parsing',async t=>{
 const {app}=await fixture(t,async()=>new Response(Buffer.from([0,255,17]),{headers:{'content-type':'application/octet-stream'}}));
 const response=await app.inject({method:'GET',url:base+'/parts/'+sha});assert.equal(response.statusCode,200);assert.deepEqual(response.rawPayload,Buffer.from([0,255,17]));assert.equal(response.headers['cache-control'],'no-store');
 const other=await fixture(t,async()=>new Response('<h1>Temporarily unavailable</h1>',{status:503,headers:{'content-type':'text/html'}}));
 const error=await other.app.inject({url:base+'/capabilities'});assert.equal(error.statusCode,503);assert.match(error.body,/Temporarily/);
});
test('oversized streams are bounded and no caller-selected proxy route is accepted',async t=>{
 const {app}=await fixture(t,async(_url,init)=>{for await(const _chunk of init.body){}return Response.json({stored:true});});
 const response=await app.inject({method:'PUT',url:base+`/staging/${id}/parts/${sha}`,headers:{'content-type':'application/octet-stream'},payload:Buffer.alloc(262145)});
 assert.equal(response.statusCode,413);
 for(const url of [base+'/checkpoints?token=x',base+'/checkpoints?cursor=1&cursor=2',base+'/parts/'+sha+'?cursor=1',base+'/../secret'])assert.equal(backupV2Operation({method:'GET',url}),false);
 assert.equal(backupV2Operation({method:'GET',url:base+'/checkpoints?cursor=999'}),true);
 assert.equal(backupV2Operation({method:'GET',url:base+`/namespace-versions/${id}/records?cursor=${sha}`}),true);
});

test('reader attempt queries and exact control routes stay narrowly authenticated',async t=>{
 for(const url of [base+`/checkpoints/${id}?catalog=paged&restoreId=${id}`,base+`/checkpoints/${id}?restoreId=${id}&catalog=paged`,base+`/checkpoints/${id}?restoreId=${id}`])assert.equal(backupV2Operation({method:'GET',url}),true);
 for(const url of [base+`/checkpoints/latest?catalog=paged&restoreId=${id}`,base+`/checkpoints/${id}?catalog=paged&restoreId=bad`,base+`/checkpoints/${id}?restoreId=${id}&restoreId=${id}`,base+`/checkpoints/${id}?restoreId=${id}&cursor=x`,base+`/parts/${sha}?restoreId=${id}`])assert.equal(backupV2Operation({method:'GET',url}),false);
 const{app,counts}=await fixture(t,async(_url,init)=>Response.json({method:init.method}));
 for(const path of [`/checkpoints/${id}/restore-renew`,`/checkpoints/${id}/restore-release`,`/replicas/${id}/cancellations/adopt`]){const result=await app.inject({method:'POST',url:base+path,payload:{leaseId:id}});assert.equal(result.statusCode,200);}
 assert.deepEqual(counts(),{authenticated:3,csrf:3});
});
