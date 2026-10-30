import {withProfileGroupLock} from '../runtime/profile-locks.ts';
import {createProfileSyncScheduler} from '../web/src/profile-sync-scheduler.ts';
import {restoreProfileChunks} from '../web/src/profile-chunk-restore.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {hubNamespace,hubSiteGroup} from '../runtime/hub-contracts.ts';
import {temporaryProfileFailure} from '../web/src/profile-errors.ts';
import {createProfileHydration} from '../runtime/profile-hydration.ts';
import {loadProfileStream,loadProfileStreamHead} from '../web/src/profile-stream.ts';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve});return{promise,release}};
const chosen='https://chosen.example';
const ns=(origin,kind,name='')=>[kind,kind==='cookies'?new URL(origin).hostname:origin,name];
function fixture({pending=false,holdRestore=false,holdPermit=false}={}){
 const calls=[],events=[],storage=new Map(),heads=new Map();let remoteRevision=1,guard,session={authenticated:true,grant:{profileId:'profile',contextId:'context',sessionId:'session'}};
 const streams=[];for(let i=0;i<50;i++)for(const kind of ['local','cookies','idb'])streams.push({namespace:ns(`https://history${i}.example`,kind,kind==='idb'?'history-db':''),revision:1,snapshotRevision:1});
 for(const kind of ['local','cookies','idb'])streams.push({namespace:ns(chosen,kind,kind==='idb'?'chosen-db':''),revision:1,snapshotRevision:1});
 const entry={entry:{profileId:'profile',id:'retained-journal',kind:'local',origin:chosen,bytes:4,createdAt:1,payload:{mutations:[{type:'set',key:'draft',value:'retained'}]}},database:'fixture',store:'origins',key:['outbox','retained-journal'],arrayKeys:true};
 const pendingChanges=pending?[entry]:[],restoration=gate(),permit=gate(),no=()=>{};
 const local={queue:{list:async()=>pendingChanges,head:async()=>({revision:1,epoch:2})},readHead:async n=>heads.get(hubNamespace(n).key)||null,decodeWire:async v=>v,
  async restore(n,snapshot,journal,head){calls.push(['restore-start',n,snapshot,journal]);if(holdRestore)await restoration.promise;heads.set(hubNamespace(n).key,head);calls.push(['restore-complete',n]);},
  async setPermit(p){calls.push(['permit-start',p]);if(holdPermit)await permit.promise;calls.push(['permit-complete',p]);},dispose:no};
 const hydration=createProfileHydration({decode:async v=>v,prepare:async v=>v},{restore:local.restore,compact:async()=>{throw Error('Unexpected compaction')}});Object.assign(local,{beginHydration:async s=>hydration.begin(s),hydrateValue:hydration.value,hydrateChunk:hydration.chunk,finishHydration:hydration.finish,abortHydration:async h=>hydration.abort(h)});
 const request=async(path='',method='GET',body)=>{calls.push(['request',path,body]);if(path==='')return{initialized:true,profileId:'profile',revision:1,streams};if(path==='/preferences')return{revision:1,values:{}};
  if(path==='/writers')return{writer:{epoch:2,contextId:'context',siteGroup:hubSiteGroup(body.namespace.origin),expiresAt:new Date(Date.now()+90000).toISOString()}};
  if(path==='/stream'){if(body.headOnly)return{revision:remoteRevision,snapshotRevision:remoteRevision,restoreBytes:64,snapshotBytes:64};return{revision:remoteRevision,snapshotRevision:remoteRevision,snapshot:{format:'fixture',kind:body.namespace.kind,values:['cloud']},journal:[]};}throw Error('Unexpected request '+path)};
 const imports={'../../runtime/profile-locks':{withProfileGroupLock},'../../runtime/profile-limits.ts':{setProfileLimits:no},'./profile-wakeup':{watchProfileWriters:()=>({close:no,closed:()=>false})},'./profile-checkpoint':{},'./profile-preferences':{},'./profile-local-store':{createProfileLocalStore:()=>local},'./profile-sync-scheduler':{createProfileSyncScheduler},'./profile-chunk-restore':{restoreProfileChunks},'./hub-client-state':{registerHubInitializer:no,getHubSession:()=>session,hubProfileRequest:request},'../../runtime/profile-context':{setActiveProfile:no,setActiveProfileContext:no,setProfileDocumentGuard:value=>{guard=value}},'../../runtime/profile-permissions':{invalidateProfilePermits:no},'../../runtime/profile-store':{exportLegacyProfileData:async()=>{throw Error('Another account may not export legacy saves')}},'../../runtime/profile-sync':{changeNamespace:c=>({kind:c.entry.kind,origin:c.entry.origin})},'../../runtime/hub-contracts':{hubNamespace,hubSiteGroup,HUB_LIMITS:{streamBytes:128*1024*1024}},'./model':{portableAtlasKey:()=>false},'./profile-errors':{temporaryProfileFailure},'./profile-stream':{loadProfileStream,loadProfileStreamHead},'./profile-import':{reserveLegacyOwner:async()=>false},'./profile-legacy-migration':{}};
 const window={addEventListener:no,removeEventListener:no,dispatchEvent:e=>events.push(e),setInterval:()=>1,setTimeout:()=>1,clearTimeout:no,clearInterval:no,document:{addEventListener:no,removeEventListener:no}};
 const source=readFileSync(process.env.ATLAS_PROFILE_CLIENT_SOURCE||new URL('../web/src/profile-client.ts',import.meta.url),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,exports={};
 runInNewContext(compiled+'\nexports.client=new ProfileClient(getHubSession());active=exports.client;exports.client.tick=async()=>{};', {exports,getHubSession:()=>session,require:n=>{if(!imports[n])throw Error('Unexpected import '+n);return imports[n]},window,navigator:{onLine:true,locks:{request:async(_,...args)=>args.at(-1)()},serviceWorker:{getRegistrations:async()=>[]}},location:{origin:'https://atlas.example'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),get length(){return storage.size},key:i=>[...storage.keys()][i]},fetch:async()=>({ok:true,json:async()=>({runtimeProtocols:{profile:{engine:'scramjet-controller'}}})}),indexedDB:{},crypto:webcrypto,TextEncoder,TextDecoder,URL,Uint8Array,Date,Error,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},setTimeout,clearTimeout,clearInterval});
 return{client:exports.client,calls,events,restoration,permit,entry,heads,setRemoteRevision:v=>remoteRevision=v,get guard(){return guard},changeAccount(){session={...session,grant:{...session.grant,profileId:'different-profile'}}}};
}
const downloaded=f=>f.calls.filter(c=>c[0]==='request'&&c[1]==='/stream');
test('50 historical website groups never hydrate at entry; first chosen local/cookie/IDB group hydrates exactly once',async()=>{
 const f=fixture();await f.client.initialize();assert.equal(f.client.ready,true);assert.equal(downloaded(f).length,0,'Entry must not download any historical website payload');assert.equal(typeof f.guard,'function');
 await Promise.all([f.guard(chosen),f.guard(chosen,{interactive:false}),f.guard(chosen,{interactive:false})]);
 assert.equal(downloaded(f).length,3);assert.ok(downloaded(f).every(c=>hubNamespace(c[2].namespace).siteGroup==='chosen.example'));
 assert.deepEqual(f.calls.filter(c=>c[0]==='restore-complete').map(c=>c[1].kind).sort(),['cookies','idb','local']);
 await f.guard(chosen);assert.equal(downloaded(f).length,3,'Ready same-site documents must use the completed epoch fast path');
});
test('restored-tab/frame/worker requests cannot pass a held real stream restore or durable permit',async()=>{
 const f=fixture({holdRestore:true,holdPermit:true});await f.client.initialize();let passed=0;
 const opening=[f.guard(chosen),f.guard(chosen,{interactive:false}),f.guard(chosen,{interactive:false})].map(p=>p.then(()=>passed++));
 await turn();assert.equal(passed,0);assert.equal(f.calls.some(c=>c[0]==='permit-start'),false);f.restoration.release();await turn();assert.equal(passed,0);assert.equal(f.calls.some(c=>c[0]==='permit-start'),true);
 f.permit.release();await Promise.all(opening);assert.equal(passed,3);assert.equal(downloaded(f).length,3);
});
test('retained native journal wins over cloud hydration without blocking independent namespace restoration',async()=>{
 const f=fixture({pending:true});await f.client.initialize();assert.equal(downloaded(f).length,0);await f.guard(chosen);
 assert.deepEqual(downloaded(f).map(c=>c[2].namespace.kind).sort(),['cookies','idb']);assert.equal(f.calls.some(c=>c[0]==='restore-start'&&c[1].kind==='local'),false);assert.equal(f.entry.entry.payload.mutations[0].value,'retained');
});
test('account changes during real stream restore never activate a late old-account permit',async()=>{
 const f=fixture({holdRestore:true});await f.client.initialize();const opening=f.guard(chosen);const rejected=assert.rejects(opening,/account changed/);await turn();f.changeAccount();f.restoration.release();await rejected;assert.equal(f.calls.some(c=>c[0]==='permit-start'),false);
});

for(const failure of [{status:413,code:'HUB_PROFILE_QUOTA'},{status:503},{code:'PROFILE_REVISION_CONFLICT'}])test(`background ${JSON.stringify(failure)} never unloads an already ready owned local website`,async()=>{
 const f=fixture();await f.client.initialize();await f.guard(chosen);const before=downloaded(f).length;
 await f.client.syncFailure(Object.assign(Error('Background sync failed'),failure));
 await f.guard(chosen);assert.equal(downloaded(f).length,before);assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);
 f.changeAccount();await assert.rejects(f.guard(chosen),/account changed/);
});

const localNamespace={kind:'local',origin:chosen};
test('intact same-epoch stream uses only validated head metadata, not full payload or hydration',async()=>{
 const f=fixture();await f.client.initialize();await f.guard(chosen);const before=f.calls.filter(c=>c[0]==='restore-start').length;
 await f.client.restore(localNamespace,2);
 const requests=downloaded(f);assert.equal(requests.filter(c=>c[2].headOnly).length,1);assert.equal(requests.filter(c=>!c[2].headOnly).length,3);assert.equal(f.calls.filter(c=>c[0]==='restore-start').length,before);
});
test('changed-writer epoch and missing native head still require full restore',async()=>{
 for(const missing of [false,true]){const f=fixture();await f.client.initialize();await f.guard(chosen);const key=hubNamespace(localNamespace).key;if(missing)f.heads.delete(key);else f.heads.set(key,{revision:1,epoch:1});await f.client.restore(localNamespace,2);assert.equal(downloaded(f).filter(c=>c[2].headOnly).length,0);assert.equal(downloaded(f).length,4);assert.equal(f.heads.get(key).epoch,2)}
});
test('changed remote metadata falls back to authoritative payload; force repair always bypasses reuse',async()=>{
 const f=fixture();await f.client.initialize();await f.guard(chosen);f.setRemoteRevision(2);await f.client.restore(localNamespace,2);assert.equal(downloaded(f).filter(c=>c[2].headOnly).length,1);assert.equal(downloaded(f).filter(c=>!c[2].headOnly).length,4);assert.equal(f.heads.get(hubNamespace(localNamespace).key).revision,2);
 await f.client.restoreLocked(localNamespace,2,true);assert.equal(downloaded(f).filter(c=>c[2].headOnly).length,1);assert.equal(downloaded(f).filter(c=>!c[2].headOnly).length,5,'repair cannot reuse a matching head after archiving native changes');
});
