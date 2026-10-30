import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';
import {tmpdir}from'node:os';import {join,resolve}from'node:path';import {pathToFileURL}from'node:url';
import {randomUUID,randomBytes,createHash}from'node:crypto';
const {createApp}=await import(pathToFileURL(join(process.env.ATLAS_SERVER_SOURCE||resolve('.'),'server/app.mjs')).href);
import {OPAQUE_CORE_SOURCE_SHA256,OPAQUE_HTTPENGINE_SOURCE_SHA256}from'../server/runtime-capabilities.mjs';
const origin='https://atlas.example',branchId=randomUUID(),ip='198.51.100.77',url='https://docs.google.com/document/d/owned-link/edit',sha=v=>createHash('sha256').update(v).digest('hex');
async function fixture(t,{apiMax=600}={}){
 const directory=await mkdtemp(join(tmpdir(),'atlas-native-admission-')),assets=join(directory,'assets');await mkdir(assets);const files={},names={},subjects=new Map();
 for(const kind of['document','dedicated','storage','cookies','relay','httpengine','rewriter']){const bytes=Buffer.from('// native admission fixture '+kind),hash=sha(bytes),name=kind+'-'+hash.slice(0,16)+'.js';files[name]={sha256:hash};names[kind]=name;await writeFile(join(assets,name),bytes)}
 await writeFile(join(assets,'manifest.json'),JSON.stringify({version:2,activated:false,coreSourceSHA256:OPAQUE_CORE_SOURCE_SHA256,engineSourceSHA256:OPAQUE_HTTPENGINE_SOURCE_SHA256,adaptedCoreSHA256:'a'.repeat(64),adaptedEngineSHA256:files[names.httpengine].sha256,bootstrap:names.document,dedicatedWorker:names.dedicated,engine:names.httpengine,trustedRewriter:names.rewriter,workers:{storage:names.storage,cookies:names.cookies,relay:names.relay},files}));
 const app=await createApp({dataDir:join(directory,'data'),staticDir:'/not-built',appOrigin:origin,runtimeOrigin:'https://runtime.invalid',dynamicOrigins:false,localRelayMode:'frontend',sameOriginRuntime:true,profileRuntimeEnabled:true,profileRuntimeActivated:true,profileRuntimeEngine:'scramjet-controller',profileAssetsDir:assets,hubOrigin:'https://hub.example',hubBranchId:branchId,hubBranchSecret:'s'.repeat(43),hubServiceSecret:'control-'.repeat(6),hubControlMutations:true,hubFetch:async(target,options)=>{
  const grant=subjects.get(options.headers['x-atlas-branch-session']);if(!grant)return Response.json({error:{code:'HUB_SESSION_EXPIRED'}},{status:401});
  if(target.endsWith('/document-announcement/ack'))return Response.json({acknowledged:true,announcementId:sha(url)});
  if(target.endsWith('/document-announcement'))return Response.json({url,hubEnabled:true,browserEnabled:true,announcementId:sha(url),acknowledged:false});
  return Response.json({grant});
 }});
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true})});
 const policy=await app.inject({method:'POST',url:'/api/internal/hub/control',headers:{authorization:'Bearer '+'control-'.repeat(6)},payload:{operation:'requestLimits.update',input:{rules:{api:{max:apiMax},browse:{max:60}}}}});assert.equal(policy.statusCode,200,policy.body);
 function account(){const token=randomBytes(32).toString('base64url'),grant={protocol:1,branchId,userId:randomUUID(),profileId:randomUUID(),sessionId:randomUUID(),contextId:randomUUID(),expiresAt:new Date(Date.now()+3600000).toISOString(),grantExpiresAt:new Date(Date.now()+300000).toISOString()},csrf=randomBytes(32).toString('base64url');subjects.set(token,grant);return{csrf,cookie:'__Host-atlas-hub='+app.store.seal(JSON.stringify({generation:1,token,grant,csrf,origin}))}}
 function request(account,method,path,payload,extra={}){return app.inject({method,url:path,remoteAddress:ip,headers:{origin,...(account?{cookie:account.cookie}:{}),...extra},...(payload===undefined?{}:{payload})})}
 async function assignment(account){const bootstrap=await request(account,'POST','/api/browse/controller/bootstrap',{});assert.equal(bootstrap.statusCode,200,bootstrap.body);const cookie=account.cookie+'; '+bootstrap.headers['set-cookie'].split(';')[0],created=await request({...account,cookie},'POST','/api/browse/controller/session',{intent:'new',requestId:bootstrap.json().requestId});assert.equal(created.statusCode,200,created.body);const value=created.json();return{value,headers:{'x-atlas-browse-session':value.session,'x-atlas-browse-generation':String(value.generation)}}}
 return{app,account,request,assignment};
}
test('500 ordinary accounts on one IP complete cookie/storage owners, documents, announcements and releases without sharing an API budget',async t=>{
 const f=await fixture(t);let ownerRegisters=0,documentRegisters=0,ownerReleases=0,documentReleases=0,announcementChecks=0,announcementAcks=0;
 for(let i=0;i<500;i++){
  const account=f.account(),assignment=await f.assignment(account);
  const announcement=await f.request(account,'GET','/api/hub/document-announcement');assert.equal(announcement.statusCode,200,announcement.body);assert.equal(announcement.json().announcementId,sha(url));announcementChecks++;
  const ack=await f.request(account,'POST','/api/hub/document-announcement/ack',{announcementId:sha(url)},{'x-atlas-hub-csrf':account.csrf});assert.equal(ack.statusCode,200,ack.body);assert.equal(ack.json().acknowledged,true);announcementAcks++;
  for(const family of['cookies','storage']){
   const root='/api/browse/'+family,owner=await f.request(account,'POST',root+'/owners',{},assignment.headers);assert.equal(owner.statusCode,200,'account '+i+' '+owner.body);ownerRegisters++;const authorization='Bearer '+owner.json().capability,documentId='native_document_'+String(i).padStart(16,'0');
   const doc=await f.request(account,'POST',root+'/documents',{documentId},{authorization});assert.equal(doc.statusCode,200,doc.body);documentRegisters++;
   const released=await f.request(account,'DELETE',root+'/documents/'+documentId,undefined,{authorization});assert.equal(released.statusCode,204,released.body);documentReleases++;
   const gone=await f.request(account,'DELETE',root+'/owners',undefined,{authorization});assert.equal(gone.statusCode,204,gone.body);ownerReleases++;
  }
  const release=await f.request(account,'DELETE','/api/browse/controller/session',{session:assignment.value.session,generation:assignment.value.generation});assert.equal(release.statusCode,200,release.body);
 }
 assert.deepEqual({ownerRegisters,documentRegisters,ownerReleases,documentReleases,announcementChecks,announcementAcks},{ownerRegisters:1000,documentRegisters:1000,ownerReleases:1000,documentReleases:1000,announcementChecks:500,announcementAcks:500});
 assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM limits WHERE key LIKE 'api:%'").get().n,500,'only verified account API keys—not a shared IP key');
 console.log('NATIVE_ADMISSION_PROOF',JSON.stringify({ordinaryAccounts:500,sharedIPs:1,ownerRegisters,documentRegisters,ownerReleases,documentReleases,announcementChecks,announcementAcks,capacityQualification:false}));
});
test('owner rate scoping does not confer owner capability, generation, account assignment or announcement CSRF authority',async t=>{
 const f=await fixture(t),a=f.account(),b=f.account(),assigned=await f.assignment(a),root='/api/browse/storage';
 assert.equal((await f.request(null,'POST',root+'/owners',{},assigned.headers)).statusCode,401);
 assert.equal((await f.request({cookie:'__Host-atlas-hub=forged'},'POST',root+'/owners',{},assigned.headers)).statusCode,401);
 assert.equal((await f.request(b,'POST',root+'/owners',{},assigned.headers)).statusCode,403);
 assert.notEqual((await f.request(a,'POST',root+'/owners',{}, {...assigned.headers,'x-atlas-browse-generation':String(assigned.value.generation+1)})).statusCode,200);
 assert.equal((await f.request(a,'POST',root+'/owners',{}, {...assigned.headers,origin:'null'})).statusCode,403);
 const owner=await f.request(a,'POST',root+'/owners',{},assigned.headers);assert.equal(owner.statusCode,200,owner.body);const cap=owner.json().capability;
 assert.equal((await f.request(a,'POST',root+'/documents',{documentId:'valid_document_0123456789'},{authorization:'Bearer '+'x'.repeat(43)})).statusCode,401);
 assert.equal((await f.request(a,'DELETE',root+'/owners',undefined,{authorization:'Bearer '+'x'.repeat(43)})).statusCode,401);
 assert.equal((await f.request(a,'POST','/api/hub/document-announcement/ack',{announcementId:sha(url)})).statusCode,403);
 assert.equal((await f.request(a,'DELETE',root+'/owners',undefined,{authorization:'Bearer '+cap})).statusCode,204);
});
test('native lifecycle and invalid-capability calls retain per-account API ceilings; anonymous calls remain unauthorized',async t=>{
 const f=await fixture(t,{apiMax:3}),a=f.account(),b=f.account();
 for(const account of[a,b])for(let i=0;i<3;i++)assert.equal((await f.request(account,'GET','/api/hub/document-announcement')).statusCode,200);
 assert.equal((await f.request(a,'GET','/api/hub/document-announcement')).statusCode,429);assert.equal((await f.request(b,'GET','/api/hub/document-announcement')).statusCode,429);
 const c=f.account();
 for(let i=0;i<3;i++)assert.equal((await f.request(c,'POST','/api/browse/storage/documents',{documentId:'valid_document_0123456789'},{authorization:'Bearer '+'x'.repeat(43)})).statusCode,401);
 assert.equal((await f.request(c,'POST','/api/browse/storage/documents',{documentId:'valid_document_0123456789'},{authorization:'Bearer '+'x'.repeat(43)})).statusCode,429);
 // Existing Hub browsing authentication runs before the general API hook.
 // Keep that ordering: an anonymous caller never reaches owner work at all.
 for(let i=0;i<10;i++)assert.equal((await f.request(null,'POST','/api/browse/cookies/owners',{})).statusCode,401);
});
