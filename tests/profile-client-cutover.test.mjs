import {withProfileGroupLock} from '../runtime/profile-locks.ts';
import {createProfileSyncScheduler} from '../web/src/profile-sync-scheduler.ts';
import {restoreProfileChunks} from '../web/src/profile-chunk-restore.ts';
import {loadProfileStream,loadProfileStreamHead} from '../web/src/profile-stream.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {createProfileHydration} from '../runtime/profile-hydration.ts';
import {hubNamespace,hubSiteGroup} from '../runtime/hub-contracts.ts';

// Actual client orchestration, deterministic boundary adapters. Native formats,
// receipt validation, and browser restore are separately exercised by the real
// legacy/compaction browser suites; this suite verifies their production wiring.
function fixture({owns=true,report={},remoteRevision=129}={}) {
 const calls=[],storage=new Map(),cookieStores=['__runtimekit_controller','__scramjet_controller'].map(database=>({database,namespace:{kind:'cookies',origin:'https://example.test'},payload:{format:'atlas-cookie-snapshot-v1',cookies:[{id:database,value:database}]}}));
 let migration,cloud,decoded=0,compacted;
 const session={authenticated:true,grant:{profileId:'profile',contextId:'context',sessionId:'session'}};
 const no=()=>{};
 const request=async(path='',method='GET',body)=>{
  calls.push({path,method,body});
  if(path==='')return{initialized:true,profileId:'profile',revision:1,streams:[]};
  if(path==='/preferences')return{revision:1,values:{}};
  if(path.startsWith('/receipts/'))return{acknowledged:true,namespace:['local','https://example.test',''],revision:1,mode:'snapshot',payloadHash:'fixture'};
  throw Error('Unexpected request '+path);
 };
 const hydrate=createProfileHydration({decode:async v=>{decoded++;return v.decoded},prepare:async v=>v},{restore:async()=>{},compact:async(n,s)=>{compacted={n,s};return{folded:true}}});
 const imports={'../../runtime/profile-locks':{withProfileGroupLock},
  '../../runtime/profile-limits.ts':{setProfileLimits:no},
  './profile-wakeup':{watchProfileWriters:()=>({close:no,closed:()=>false})},
  './profile-checkpoint':{checkpointProfileGroup:no},
  './profile-preferences':{},
  './profile-local-store':{createProfileLocalStore:()=>({beginHydration:async s=>hydrate.begin(s),hydrateValue:hydrate.value,hydrateChunk:hydrate.chunk,finishHydration:hydrate.finish,abortHydration:async h=>hydrate.abort(h),prepareWire:async v=>v,decodeWire:async v=>{decoded++;return v.decoded},queue:{list:async()=>[]},compact:async(n,s)=>{compacted={n,s};return{folded:true}},readHead:async()=>null,revokePermit:async()=>true,setPermit:no,restore:no})},
  './profile-sync-scheduler':{createProfileSyncScheduler},'./profile-chunk-restore':{restoreProfileChunks},'./hub-client-state':{registerHubInitializer:no,getHubSession:()=>session,hubProfileRequest:request},
  '../../runtime/profile-context':{setActiveProfile:no,setActiveProfileContext:no,setProfileDocumentGuard:no},
  '../../runtime/profile-permissions':{invalidateProfilePermits:no},
  '../../runtime/profile-store':{exportLegacyProfileData:async()=>({snapshots:[],hostStorage:[],cookieStores})},
  '../../runtime/profile-sync':{drainProfileQueue:async(_q,c)=>{cloud=c},changeNamespace:no},
  '../../runtime/hub-contracts':{HUB_LIMITS:{streamBytes:128*1024*1024},hubNamespace,hubSiteGroup,encodePortableValue:async v=>v,decodePortableValue:async v=>{decoded++;return v.decoded}},
  './model':{portableAtlasKey:()=>false},'./profile-errors':{},
  './profile-stream':{loadProfileStreamHead,loadProfileStream:async()=>({revision:remoteRevision,snapshotRevision:128,snapshot:{decoded:{format:'snapshot'}},journal:[{revision:129,payload:{decoded:{format:'journal'}}}]})},
  './profile-import':{reserveLegacyOwner:async()=>owns,runInitialProfileImport:no},
  './profile-legacy-migration':{legacyWebsiteOriginHints:()=>[],migrateLegacyOrigin:async options=>{migration=options;await options.entries();return{backedUp:2,newBackups:2,adoptedGroups:[],preservedGroups:[],partialGroups:[],...report}}},
 };
 const window={addEventListener:no,removeEventListener:no,dispatchEvent:no,setInterval:()=>1,setTimeout:()=>1,clearInterval:no,clearTimeout:no};
 const exports={};
 const source=readFileSync(process.env.ATLAS_PROFILE_CLIENT_SOURCE||new URL('../web/src/profile-client.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(compiled+'\nexports.make=s=>{const c=new ProfileClient(s);active=c;c.tick=async()=>{};return c};',{
  exports,require:n=>{if(!(n in imports))throw Error('Unknown import '+n);return imports[n]},window,
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),get length(){return storage.size},key:i=>[...storage.keys()][i]},
  navigator:{locks:{request:async(_n,...args)=>args.at(-1)()},serviceWorker:{getRegistrations:async()=>[]}},location:{origin:'https://old-a.example'},
  fetch:async()=>({ok:true,json:async()=>({runtimeProtocols:{profile:{engine:'scramjet-controller'}}})}),
  indexedDB:{},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},crypto:webcrypto,TextEncoder,TextDecoder,URL,Uint8Array,setTimeout,clearTimeout,clearInterval,
 });
 const client=exports.make(session);
 return{client,exports,calls,cookieStores,get migration(){return migration},get cloud(){return cloud},get decoded(){return decoded},get compacted(){return compacted}};
}
const plain=v=>JSON.parse(JSON.stringify(v));
test('production migration wiring backs up each known cookie jar as recovery-only Atlas metadata',async()=>{
 const f=fixture();await f.client.initialize();const entries=await f.migration.entries();assert.equal(entries.length,2);
 for(let i=0;i<2;i++)assert.deepEqual(plain(entries[i]),{namespace:{kind:'atlas'},payload:{format:'atlas-legacy-cookie-store-v1',database:f.cookieStores[i].database,namespace:f.cookieStores[i].namespace,snapshot:f.cookieStores[i].payload}});
});
test('production migration wiring exposes real account-bound immutable receipts for partial-import resume',async()=>{
 const f=fixture();await f.client.initialize();assert.equal(typeof f.migration.receipt,'function');const receipt=await f.migration.receipt('legacy-origin-test');assert.equal(receipt.acknowledged,true);assert.equal(f.calls.at(-1).path,'/receipts/legacy-origin-test');
});
test('later account never exports claimed legacy cookies or starts migration',async()=>{
 const f=fixture({owns:false});await f.client.initialize();assert.equal(f.migration,undefined);
});
test('production queue hook reduces only pinned acknowledged cloud payloads in the local worker',async()=>{
 const f=fixture();await f.client.drainQueue({list:async()=>[]});assert.equal(typeof f.cloud.snapshot,'function');
 const result=await f.cloud.snapshot({kind:'local',origin:'https://example.test'},129);
 assert.deepEqual(plain(result),{revision:129,payload:{folded:true},encoded:true});assert.equal(f.decoded,2);
 assert.deepEqual(plain(f.compacted.s),{revision:129,snapshotRevision:128,snapshot:{format:'snapshot'},journal:[{revision:129,payload:{format:'journal'}}]});
});
test('cloud compaction source race never folds or writes live native data',async()=>{
 const f=fixture({remoteRevision:130});await f.client.drainQueue({list:async()=>[]});await assert.rejects(()=>f.cloud.snapshot({kind:'local',origin:'https://example.test'},129),/PROFILE_REVISION_CONFLICT/);assert.equal(f.compacted,undefined);assert.equal(f.decoded,0);
});
test('unreviewed divergent old saves prevent replacement before fencing or releasing writers',async()=>{
 const f=fixture({report:{preservedGroups:['example.test']}});await f.client.initialize();let attempts=0;f.client.prepareReplacement=async()=>{attempts++};
 await assert.rejects(()=>f.exports.prepareProfileReplacement(),e=>e.code==='PROFILE_MIGRATION_REVIEW_REQUIRED');assert.equal(attempts,0);
 await f.exports.prepareProfileReplacement({acceptRecoveredSaves:true});assert.equal(attempts,1);
});
test('incomplete portable import also needs explicit review, never a successful full-transfer label',async()=>{
 const f=fixture();await f.client.initialize();f.client.incomplete=true;let attempts=0;f.client.prepareReplacement=async()=>{attempts++};await assert.rejects(()=>f.exports.prepareProfileReplacement(),e=>e.code==='PROFILE_MIGRATION_REVIEW_REQUIRED');assert.equal(attempts,0);
});

test('previously backed-up conflicts still need review after closing and reopening the old address',async()=>{
 const f=fixture({report:{newBackups:0,preservedGroups:['example.test']}});await f.client.initialize();let attempts=0;f.client.prepareReplacement=async()=>{attempts++};await assert.rejects(()=>f.exports.prepareProfileReplacement(),e=>e.code==='PROFILE_MIGRATION_REVIEW_REQUIRED');assert.equal(attempts,0);
});

test('recovery-only divergent old cookie jars require review even when canonical sitegroups were absent',async()=>{
 const f=fixture({report:{newBackups:0,preservedGroups:[]}});await f.client.initialize();f.client.prepareReplacement=async()=>{throw Error('Must not fence')};await assert.rejects(()=>f.exports.prepareProfileReplacement(),e=>e.code==='PROFILE_MIGRATION_REVIEW_REQUIRED');
});
