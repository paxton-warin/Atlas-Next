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
import {drainProfileQueue, changeNamespace} from '../runtime/profile-sync.ts';
import {hubNamespace, hubSiteGroup} from '../runtime/hub-contracts.ts';
import {temporaryProfileFailure} from '../web/src/profile-errors.ts';
import {rebasePreferenceChanges} from '../web/src/profile-preferences.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
// Run actual ProfileClient control flow and native queue drain algorithm. The
// deterministic I/O adapters hold committed journals, receipts and writer leases;
// no browser, account, database, or save is created by this test.
function fixture({replenishAd=false,preferencesConflict=false,unacknowledged=false,replenishTarget=false,hasTarget=true,takeoverError=false,busy=false,ackFailures=0,ackFalse=false,holdRenew=false,checkpointError=false,holdCheckpoint=false,checkpointSave=false,handoffRequests,ackExpired=false,commitWriterLost=false,preferenceFixture,releaseLostResponse=false,waitingTakeover=false,backupFailures=0,invalidBackupWriter=false}={}) {
 const source=readFileSync(process.env.ATLAS_PROFILE_CLIENT_SOURCE || new URL('../web/src/profile-client.ts',import.meta.url),'utf8');
 const events=[], calls=[], storage=new Map(), entries=[], heads=new Map(), permits=[], listeners=new Map();
 const origin='https://orteil.dashnet.org';
 const session={authenticated:true,grant:{profileId:'profile',contextId:'source',sessionId:'session'}};
 const clockBase=Date.now();let sequence=0,acknowledged=false,timerNow=0,nextTimer=0,hintWake,watchClosed=false,releaseRenew,releaseCheckpoint,writerReleased=false,takeoverReady=false;const renewGate=holdRenew?new Promise(r=>releaseRenew=r):null;const checkpointGate=holdCheckpoint?new Promise(r=>releaseCheckpoint=r):null;const timers=new Map();
 const writer={epoch:4,expiresAt:new Date(clockBase+90000).toISOString(),siteGroup:'dashnet.org',contextId:'source'};
 const add=(kind,entryOrigin,payload)=>entries.push({entry:{id:'journal-'+ ++sequence,profileId:'profile',kind,origin:entryOrigin,payload,createdAt:sequence,bytes:50},database:'native',store:'journal',key:sequence,arrayKeys:false});
 const addTarget=()=>add('local',origin,{change:{op:'set',key:'save',value:'cookies-42'},revision:sequence+1});
 const addAd=()=>add('cookies','https://ads.example',{changes:[{op:'set',cookie:{domain:'ads.example',id:'ad',name:'ad',value:'1'}}]});
 if(hasTarget)addTarget();
 const queue={
  list:async()=>{if(replenishAd&&!entries.some(c=>c.entry.origin==='https://ads.example'))addAd();return [...entries]},
  head:async c=>heads.get(hubNamespace(changeNamespace(c)).key)||{revision:0,epoch:writer.epoch},
  prepared:async()=>null,
  prepare:async()=>{},
  acknowledge:async(c,head)=>{heads.set(hubNamespace(changeNamespace(c)).key,head);entries.splice(entries.indexOf(c),1);if(replenishTarget&&c.entry.origin===origin)addTarget()},
 };
 if(preferenceFixture){storage.set('atlas.profile.user.pending:profile','pending-0000000000000001');storage.set('atlas.profile.user:profile:atlas.history',preferenceFixture.local);}
 if(preferencesConflict){storage.set('atlas.profile.user.pending:profile','pending-0000000000000001');storage.set('atlas.profile.user:profile:atlas.history','local history');}
 const no=()=>{};
 const imports={'../../runtime/profile-locks':{withProfileGroupLock},
  '../../runtime/profile-limits.ts':{setProfileLimits:no},
  './profile-wakeup':{watchProfileWriters:wake=>{hintWake=wake;watchClosed=false;calls.push({path:'[watch-open]'});return{close:()=>{watchClosed=true;calls.push({path:'[watch-close]'})},closed:()=>watchClosed}}},
  // This VM harness crosses realms; the real JSON response and client data live
  // in one shell realm. Copy serialized inputs into the helper's test realm.
  './profile-local-store':{createProfileLocalStore:()=>({queue,pendingNamespaces:async()=>entries.map(changeNamespace),prepareRecovery:async()=>null,prepareWire:async value=>value,prepareQueueWire:async change=>change.entry.payload,decodeWire:async value=>value,revokePermit:async scope=>{const permit={...scope,revoked:true,expiresAt:0};permits.push(permit);calls.push({path:"[local-permit]",permit});return true},setPermit:async permit=>{permits.push(permit);calls.push({path:'[local-permit]',permit})},readHead:async()=>null,restore:async()=>{},exportSnapshots:async()=>[],preserveRecovery:async()=>{},dispose:()=>calls.push({path:'[local-dispose]'})})},
  './profile-preferences':{rebasePreferenceChanges:(changes,canonical)=>rebasePreferenceChanges(structuredClone(changes),structuredClone(canonical))},
  './profile-checkpoint':{checkpointProfileGroup:async group=>{calls.push({path:'[checkpoint]',group});if(checkpointGate)await checkpointGate;if(checkpointError&&group==='dashnet.org')throw Object.assign(Error('Native save failed'),{code:'PROFILE_CHECKPOINT_SAVE_FAILED'});if(checkpointSave)addTarget();calls.push({path:'[checkpoint-complete]',group})}},
  './profile-sync-scheduler':{createProfileSyncScheduler},'./profile-chunk-restore':{restoreProfileChunks},'./hub-client-state':{registerHubInitializer:no,getHubSession:()=>session,hubProfileRequest:async(path,method,body)=>{
   calls.push({path,method,body});
   if(path==='/writers'&&method==='POST'&&body.useLatestBackup===true){
    if(!waitingTakeover||body.handoffId!=='pending-handoff')throw Error('Invalid confirmed handoff');
    if(backupFailures-->0)throw Object.assign(Error('Saved version unavailable'),{status:503});
    return{writer:{...writer,epoch:5,contextId:invalidBackupWriter?'other':'source',expiresAt:new Date(clockBase+timerNow+90000).toISOString()}};
   }
   if(path==='/writers'&&method==='POST'&&waitingTakeover&&!takeoverReady)throw Object.assign(Error('Previous owner is still active'),{status:409,code:'HUB_WRITER_BUSY'});
   if(path==='/writers'&&method==='POST'&&busy)throw Object.assign(Error('This website is open in another browser context.'),{status:409,code:'HUB_WRITER_BUSY'});
   if(path==='/writers'&&(method==='PUT'||method==='POST')){if(method==='PUT'&&renewGate)await renewGate;return{writer:{...writer,expiresAt:new Date(clockBase+timerNow+90000).toISOString()}};}
   if(path==='/writers'&&method==='DELETE'){writerReleased=true;if(releaseLostResponse)throw Object.assign(Error('Release response lost'),{status:503});return{ok:true};}
   if(path==='/writers/takeover'){
    if(takeoverError)throw Object.assign(Error('Other browser is still saving.'),{status:409});
    if(waitingTakeover&&!takeoverReady)return{handoffId:'pending-handoff',status:'waiting'};
    return{available:true};
   }
   if(path==='/writers/requests')return{requests:acknowledged||waitingTakeover?[]:(handoffRequests||[{id:'handoff',siteGroup:'dashnet.org',epoch:4}])};
   if(/^\/writers\/requests\/[^/]+\/ack$/.test(path)){if(ackExpired)throw Object.assign(Error('Expired transfer'),{status:409,code:'HUB_HANDOFF_EXPIRED'});if(ackFalse)return{acknowledged:false};acknowledged=true;if(ackFailures-->0)throw Object.assign(Error('Acknowledgement response lost'),{status:503});return{acknowledged:true};}
   if(path.startsWith('/receipts/'))throw Object.assign(Error('No receipt'),{status:404});
   if(path==='/stream')return{revision:heads.get(hubNamespace(body.namespace).key)?.revision||0};
   if(path==='/commits'&&commitWriterLost)throw Object.assign(Error('Writer lost'),{status:409,code:'HUB_WRITER_LOST'});
   if(path==='/commits')return{acknowledged:!unacknowledged,revision:body.baseRevision+1};
   if(path==='/preferences'&&preferenceFixture){if(method==='GET'){if(preferenceFixture.concurrent!==undefined){storage.set('atlas.profile.user:profile:atlas.history',preferenceFixture.concurrent);storage.set('atlas.profile.user.pending:profile','pending-newer-write-0000000001')}return{values:{'atlas.history':preferenceFixture.canonical}};}if(calls.filter(c=>c.path==='/preferences'&&c.method==='POST').length===1)throw Object.assign(Error('Settings conflict'),{status:409,code:'HUB_CONFLICT'});return{acknowledged:true,revision:9};}
   if(path==='/preferences'&&method==='POST')throw Object.assign(Error('These settings changed in another browser. Your local version is retained.'),{status:409,code:'HUB_CONFLICT'});
   if(path==='')return{streams:[],writers:writerReleased?[]:[writer]};
   throw Error('Unexpected request '+method+' '+path);
  }},
  '../../runtime/profile-context':{setActiveProfile:no,setActiveProfileContext:no,setProfileDocumentGuard:no},
  '../../runtime/profile-permissions':{setProfilePermit:async(_db,permit)=>{permits.push(permit);calls.push({path:'[local-permit]',permit})},invalidateProfilePermits:no},
  '../../runtime/profile-store':{exportProfileSnapshots:async()=>[],restoreProfileStream:async()=>{},readProfileStreamHead:async()=>null},
  '../../runtime/profile-sync':{drainProfileQueue,nativeProfileQueue:()=>queue,preserveProfileRecovery:async()=>{},changeNamespace},
  '../../runtime/hub-contracts':{HUB_LIMITS:{streamBytes:999999},encodePortableValue:async v=>v,decodePortableValue:async v=>v,hubNamespace,hubSiteGroup},
  './model':{portableAtlasKey:k=>k==='atlas.history'},
  './profile-errors':{temporaryProfileFailure},
  './profile-stream':{loadProfileStreamHead,loadProfileStream:async()=>{}},
  './profile-import':{reserveLegacyOwner:async()=>{},runInitialProfileImport:async()=>{}},
  './profile-legacy-migration':{legacyWebsiteOriginHints:()=>[],migrateLegacyOrigin:async()=>({backedUp:0,newBackups:0,adoptedGroups:[],preservedGroups:[],partialGroups:[]})},
 };
 const exports={};
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const window={
  setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,at:timerNow+delay});return id},
  clearTimeout:id=>timers.delete(id),
  addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn)},
  removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),
  dispatchEvent:e=>{events.push(e);calls.push({path:'[event]',type:e.type,detail:e.detail});for(const fn of listeners.get(e.type)||[])fn(e)},
 };
 runInNewContext(compiled+'\nexports.createTestClient=s=>{const client=new ProfileClient(s);active=client;return client;};',{
  exports,require:name=>{if(!(name in imports))throw Error('Unknown import '+name);return imports[name]},window,
  navigator:{onLine:true,locks:{request:(_name,...args)=>Promise.resolve().then(args.at(-1))}},
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),get length(){return storage.size},key:i=>[...storage.keys()][i]},
  CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},
  indexedDB:{},crypto:webcrypto,TextEncoder,TextDecoder,URL,Date:class ClockDate extends Date {constructor(...args){super(...(args.length?args:[clockBase+timerNow]))}static now(){return clockBase+timerNow}},Error,Uint8Array,setTimeout,clearTimeout,clearInterval,
 });
 const client=exports.createTestClient(session);client.ready=true;if(preferenceFixture)client.userBase={'atlas.history':preferenceFixture.base};
 client.writers.set('dashnet.org',{namespace:{kind:'local',origin},writer});
 return{client,calls,events,storage,permits,entries,queue,origin,exports,window,timers,finishNormal:()=>{takeoverReady=true;client.writersChanged()},hint:()=>hintWake?.(),closeWatch:()=>watchClosed=true,releaseRenew:()=>releaseRenew?.(),releaseCheckpoint:()=>releaseCheckpoint?.(),clearCheckpointFailure:()=>checkpointError=false,async advance(ms){const end=timerNow+ms;while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);timerNow=next[1].at;next[1].callback();await turn();}timerNow=end},get acknowledged(){return acknowledged},get status(){return exports.getProfileStatus()}};
}

const settledTick=async f=>{await f.client.tick();await f.client.handoffFlight?.catch(()=>{});await f.advance(1000);await f.client.handoffFlight?.catch(()=>{});await turn()};

test('endpoint replacement checkpoints the mounted native game before quiesce, fencing, cloud ACK and lease release',async()=>{
 const f=fixture({checkpointSave:true});await f.client.prepareReplacement();
 const at=path=>f.calls.findIndex(c=>c.path===path);
 const checkpoint=at('[checkpoint-complete]'),quiesce=f.calls.findIndex(c=>c.path==='[event]'&&c.type==='atlas:profile-quiesce'),fence=f.calls.findIndex(c=>c.path==='[local-permit]'&&c.permit.revoked),commit=at('/commits'),release=f.calls.findIndex(c=>c.path==='/writers'&&c.method==='DELETE');
 assert.ok(checkpoint>=0&&checkpoint<quiesce&&quiesce<fence&&fence<commit&&commit<release);
 assert.equal(f.entries.length,0);assert.equal(f.client.writers.size,0);assert.equal(f.calls.filter(c=>c.path==='/commits').length,2,'fresh native checkpoint enters the actual durable queue before draining');
});
test('replacement checkpoint failure preserves pages, permits and ownership and can be retried without data loss',async()=>{
 const f=fixture({checkpointError:true});await assert.rejects(f.client.prepareReplacement(),/Native save failed/);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);assert.equal(f.permits.length,0);assert.equal(f.client.writers.size,1);assert.equal(f.entries.length,1);assert.equal(f.client.replacementFences.size,0);
 f.clearCheckpointFailure();await f.client.prepareReplacement();assert.equal(f.entries.length,0);assert.equal(f.client.writers.size,0);
});
test('a held replacement checkpoint coalesces calls and leaves the game mounted until it answers',async()=>{
 const f=fixture({holdCheckpoint:true});const a=f.client.prepareReplacement(),b=f.client.prepareReplacement();assert.equal(a,b);await turn();
 assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);assert.equal(f.entries.length,1);f.releaseCheckpoint();await a;assert.equal(f.client.writers.size,0);
});
test('replacement rejects unacknowledged cloud saves and never releases or redirects a pending writer',async()=>{
 const f=fixture({unacknowledged:true});await assert.rejects(f.client.prepareReplacement(),/PROFILE_ACK_INVALID/);assert.equal(f.entries.length,1);assert.equal(f.client.writers.size,1);assert.equal(f.calls.some(c=>c.path==='/writers'&&c.method==='DELETE'),false);assert.equal(f.client.replacementFences.has('dashnet.org'),true);
 const renewals=f.calls.filter(c=>c.path==='/writers'&&c.method==='PUT').length;await settledTick(f);assert.equal(f.calls.filter(c=>c.path==='/writers'&&c.method==='PUT').length,renewals,'a failed transfer cannot revive its fenced writer');
});
test('replacement reconciles a lost writer-release response against authoritative live ownership',async()=>{
 const f=fixture({releaseLostResponse:true});await f.client.prepareReplacement();assert.equal(f.client.writers.size,0);assert.ok(f.calls.some(c=>c.path===''));assert.equal(f.entries.length,0);
});

test('continuous unrelated ad-cookie writes do not block an acknowledged website handoff or claim global Synced',async()=>{
 const f=fixture({replenishAd:true});await settledTick(f);
 assert.equal(f.acknowledged,true);
 assert.equal(f.entries.some(c=>c.entry.origin===f.origin),false);
 assert.equal(f.entries.some(c=>c.entry.origin==='https://ads.example'),true);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-status'&&e.detail.state==='synced'),false);
 assert.equal(f.status.handoff.phase,'paused');
 assert.equal(f.events.find(e=>e.type==='atlas:profile-quiesce').detail.siteGroup,'dashnet.org');
 const fence=f.permits.find(p=>p.revoked);
 assert.equal(fence.group,'dashnet.org');assert.equal(fence.expiresAt,0);
 const fenceAt=f.calls.findIndex(c=>c.path==='[local-permit]'&&c.permit.revoked);
 const commitAt=f.calls.findIndex(c=>c.path==='/commits'&&c.body.namespace.origin===f.origin);
 const ackAt=f.calls.findIndex(c=>c.path==='/writers/requests/handoff/ack');
 assert.ok(fenceAt<commitAt&&commitAt<ackAt,'local writes are fenced before commit and handoff acknowledgement');
});

test('unrelated preferences CAS conflicts do not block website handoff and remain explicitly unsynchronized',async()=>{
 const f=fixture({preferencesConflict:true});await settledTick(f);
 assert.equal(f.acknowledged,true);
 assert.ok(f.calls.some(c=>c.path==='/preferences'));
 assert.ok(f.storage.has('atlas.profile.user.pending:profile'));
 assert.ok(f.storage.has('atlas.profile.preferences.prepared:profile'));
 assert.equal(f.status.state,'error');
 assert.match(f.status.message,/settings changed in another browser/);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-status'&&e.detail.state==='synced'),false);
});

test('a requested website journal without positive acknowledgement prevents handoff and is retained',async()=>{
 const f=fixture({unacknowledged:true});await settledTick(f);
 assert.equal(f.acknowledged,false);
 assert.equal(f.entries.filter(c=>c.entry.origin===f.origin).length,1);
 assert.match(f.status.message,/PROFILE_ACK_INVALID/);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-status'&&e.detail.state==='synced'),false);
});

test('a newly committed requested-group journal prevents a premature handoff acknowledgement',async()=>{
 const f=fixture({replenishTarget:true});await settledTick(f);
 assert.equal(f.acknowledged,false);
 assert.ok(f.entries.some(c=>c.entry.origin===f.origin));
 assert.equal(f.status.state,'pending');
 assert.match(f.status.message,/sync pending/);
});

test('native-change flush rejection surfaces the actual sync failure rather than remaining pending',async()=>{
 const f=fixture({preferencesConflict:true,hasTarget:false});f.client.changed();
 await f.advance(1000);await turn();
 assert.equal(f.status.state,'error');
 assert.match(f.status.message,/settings changed in another browser/);
 assert.ok(f.storage.has('atlas.profile.user.pending:profile'));
});

test('verified takeover clears handoff metadata; account stop clears stale continuation capability',async()=>{
 const f=fixture({hasTarget:false});await f.client.takeover(f.origin);
 assert.equal(f.status.handoff,undefined);assert.equal(f.status.canContinue,false);
 assert.equal(f.status.state,'synced');
 assert.equal(f.events.find(e=>e.type==='atlas:profile-ready').detail.siteGroup,'dashnet.org');
 f.client.stop();assert.equal(f.status.handoff,undefined);assert.equal(f.status.canContinue,false);
});


test('failed takeover restores the offered action and retains its actual failure reason',async()=>{
 const f=fixture({hasTarget:false,busy:true,takeoverError:true});f.client.writers.clear();
 await assert.rejects(f.client.ensureOrigin(f.origin),/Select Continue here/);
 assert.equal(f.status.handoff.phase,'offered');
 f.window.dispatchEvent({type:'atlas:profile-continue'});await turn();await turn();
 assert.equal(f.status.handoff.phase,'offered');assert.equal(f.status.canContinue,true);
 assert.match(f.status.message,/Other browser is still saving/);
 assert.ok(f.events.some(e=>e.type==='atlas:profile-status'&&e.detail.handoff?.phase==='waiting'));
});

test('unrelated successful flushes retain an unresolved continuation offer',async()=>{
 const f=fixture({hasTarget:false,busy:true});f.client.writers.clear();
 await assert.rejects(f.client.ensureOrigin(f.origin),/Select Continue here/);
 await f.client.flush();
 assert.equal(f.status.handoff.phase,'offered');assert.equal(f.status.canContinue,true);
 assert.equal(f.status.handoff.siteGroup,'dashnet.org');
});


test('a noninteractive embedded origin remains denied without offering a global foreground takeover',async()=>{
 const f=fixture({hasTarget:false,busy:true});f.client.writers.clear();const before=f.status;
 await assert.rejects(f.client.ensureOrigin('https://ads.example',{interactive:false}),/Select Continue here/);
 assert.equal(f.status,before);
 assert.equal(f.status.canContinue,undefined);assert.equal(f.status.handoff,undefined);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-status'),false);
});

test('a foreground ownership refusal still offers Continue here explicitly',async()=>{
 const f=fixture({hasTarget:false,busy:true});f.client.writers.clear();
 await assert.rejects(f.client.ensureOrigin(f.origin,{interactive:true}),/Select Continue here/);
 assert.equal(f.status.canContinue,true);assert.equal(f.status.handoff.phase,'offered');
 assert.equal(f.status.handoff.siteGroup,'dashnet.org');
});

test('an embedded refusal never replaces an existing unrelated foreground continuation offer',async()=>{
 const f=fixture({hasTarget:false,busy:true});f.client.writers.clear();
 await assert.rejects(f.client.ensureOrigin(f.origin),/Select Continue here/);const before=f.status;
 await assert.rejects(f.client.ensureOrigin('https://ads.example',{interactive:false}),/Select Continue here/);
 assert.equal(f.status,before);assert.equal(f.status.handoff.siteGroup,'dashnet.org');
});

test('takeover does not mark unrelated pending journals or preferences globally Synced',async()=>{
 for(const options of [{hasTarget:false,replenishAd:true},{hasTarget:false,preferencesConflict:true}]){
  const f=fixture(options);await f.client.takeover(f.origin);
  assert.equal(f.status.state,'pending');assert.equal(f.status.handoff,undefined);
  assert.equal(f.events.some(e=>e.type==='atlas:profile-status'&&e.detail.state==='synced'),false);
  assert.equal(f.timers.size,1);f.client.stop();assert.equal(f.timers.size,0);
 }
});

test('continuously replenished native saves remain pending and back off instead of a100ms retry storm',async()=>{
 const f=fixture({replenishTarget:true});f.client.changed();await f.advance(1000);
 assert.equal(f.status.state,'pending');assert.equal(f.timers.size,1);
 const firstAttempts=f.calls.filter(c=>c.path==='/commits').length;assert.equal(firstAttempts,1);
 await f.advance(1000);assert.equal(f.calls.filter(c=>c.path==='/commits').length,firstAttempts,'background retries respect backoff');
 assert.ok(f.entries.some(c=>c.entry.origin===f.origin));
 assert.equal(f.events.some(e=>e.type==='atlas:profile-status'&&e.detail.state==='error'),false);
 await assert.rejects(f.client.flush(),e=>e.code==='PROFILE_SYNC_PENDING');assert.ok(f.entries.length);f.client.stop();
});

test('account stop cancels a scheduled pending-drain retry without retiring its journal',async()=>{
 const f=fixture({replenishTarget:true});f.client.changed();await f.advance(1000);
 const pending=f.entries.length,calls=f.calls.length;assert.equal(f.timers.size,1);
 f.client.stop();await f.advance(1000);
 assert.equal(f.timers.size,0);assert.equal(f.entries.length,pending);
 const request=c=>!c.path.startsWith('[');
 assert.equal(f.calls.filter(request).length,f.calls.slice(0,calls).filter(request).length);
});



test('paused source preserves its origin and its real Continue event performs a reverse takeover',async()=>{
 const f=fixture();await settledTick(f);
 assert.equal(f.status.handoff.phase,'paused');
 assert.equal(f.status.handoff.origin,f.origin);assert.equal(f.status.canContinue,true);
 await f.client.flush();
 assert.equal(f.status.handoff.phase,'paused');assert.equal(f.status.handoff.origin,f.origin);
 const before=f.calls.length;
 f.window.dispatchEvent({type:'atlas:profile-continue',detail:{origin:f.origin}});
 await turn();await turn();
 assert.ok(f.calls.slice(before).some(c=>c.path==='/writers/takeover'&&c.body.namespace.origin===f.origin));
 assert.ok(f.events.some(e=>e.type==='atlas:profile-ready'&&e.detail.origin===f.origin));
 assert.equal(f.status.handoff,undefined);assert.equal(f.status.canContinue,false);
});

test('reverse continuation falls back to the authoritative handoff origin without stale global origin',async()=>{
 const f=fixture();await settledTick(f);await f.client.flush();
 f.window.dispatchEvent({type:'atlas:profile-continue'});await turn();await turn();
 assert.ok(f.calls.some(c=>c.path==='/writers/takeover'&&c.body.namespace.origin===f.origin));
 assert.equal(f.status.handoff,undefined);
});

test('an explicit Continue event for a different site group cannot take over or replace the waiting website',async()=>{
 const f=fixture();await settledTick(f);const before=f.calls.length;
 f.window.dispatchEvent({type:'atlas:profile-continue',detail:{origin:'https://unrelated.example'}});
 await turn();await turn();
 assert.equal(f.calls.slice(before).some(c=>c.path==='/writers/takeover'),false);
 assert.equal(f.status.handoff.siteGroup,'dashnet.org');assert.equal(f.status.handoff.origin,f.origin);
 assert.match(f.status.message,/Select the website/);
});


test('a writer hint services a requested handoff immediately without waiting for the twenty-second renewal',async()=>{
 const f=fixture();f.client.ensureWakeup();f.hint();await f.client.handoffFlight;
 assert.equal(f.acknowledged,true);assert.equal(f.status.handoff.phase,'paused');
 assert.equal(f.calls.some(c=>c.path==='/writers'&&c.method==='PUT'),false);
 assert.equal(f.calls.filter(c=>c.path==='[watch-open]').length,1);
 f.client.ensureWakeup();assert.equal(f.calls.filter(c=>c.path==='[watch-open]').length,1);
 f.closeWatch();f.client.ensureWakeup();assert.equal(f.calls.filter(c=>c.path==='[watch-open]').length,2);
 f.client.stop();assert.ok(f.calls.some(c=>c.path==='[watch-close]'));
});

test('writer hints wake the existing target waiter; stop cancels waiting without a leaked timer',async()=>{
 const f=fixture({hasTarget:false});const wait=f.client.waitForWriterHint(f.client.writerHint);assert.equal(f.timers.size,1);
 f.client.writersChanged();await wait;await f.client.handoffFlight;assert.equal(f.timers.size,0);
 const next=f.client.waitForWriterHint(f.client.writerHint);f.client.stop();await next;assert.equal(f.timers.size,0);
});

test('rapid duplicate source hints coalesce and cannot acknowledge or quiesce a request twice',async()=>{
 const f=fixture();f.client.ensureWakeup();f.hint();f.hint();f.hint();await f.client.handoffFlight;
 assert.equal(f.calls.filter(c=>c.path==='/writers/requests/handoff/ack').length,1);
 assert.equal(f.events.filter(e=>e.type==='atlas:profile-quiesce').length,1);
});

test('duplicate Continue actions share one canonical takeover flight',async()=>{
 const f=fixture({hasTarget:false});const a=f.client.takeover(f.origin),b=f.client.takeover(f.origin);
 assert.equal(a,b);await Promise.all([a,b]);
 assert.equal(f.calls.filter(c=>c.path==='/writers/takeover').length,1);assert.equal(f.client.takeovers.size,0);
});

test('an ACK response lost after commit retries idempotently and keeps the source fence intact',async()=>{
 const f=fixture({ackFailures:1});await settledTick(f);
 assert.equal(f.calls.filter(c=>c.path==='/writers/requests/handoff/ack').length,2);
 assert.equal(f.status.handoff.phase,'paused');assert.equal(f.client.releases.size,0);
 const fence=f.permits.findIndex(p=>p.revoked);
 assert.ok(f.permits.slice(fence).every(p=>p.revoked),'no renewal or availability fallback revives a released writer');
});

test('a prolonged lost ACK retains its request and fence; a later retry completes even when pending GET is empty',async()=>{
 const f=fixture({ackFailures:2});await settledTick(f);
 assert.equal(f.client.releases.size,1);assert.equal(f.status.handoff.phase,'releasing');assert.equal(f.status.state,'error');
 assert.equal(f.permits.at(-1).revoked,true);
 await assert.rejects(f.client.ensureOrigin(f.origin),e=>e.code==='PROFILE_HANDOFF_PENDING');
 await settledTick(f);assert.equal(f.client.releases.size,0);assert.equal(f.status.handoff.phase,'paused');
 assert.equal(f.calls.filter(c=>c.path==='/writers/requests/handoff/ack').length,3);
});

test('HTTP success without positive handoff acknowledgement never releases the local writer record',async()=>{
 const f=fixture({ackFalse:true});await settledTick(f);
 assert.equal(f.client.releases.size,1);assert.equal(f.client.writers.has('dashnet.org'),true);
 assert.equal(f.status.handoff.phase,'releasing');assert.equal(f.status.state,'error');assert.match(f.status.message,/not been acknowledged/);
});

test('a renewal response begun before quiesce cannot undo the release fence',async()=>{
 const f=fixture({holdRenew:true});f.client.writers.get('dashnet.org').writer.expiresAt=new Date(Date.now()+30000).toISOString();const tick=f.client.tick();await turn();assert.ok(f.calls.some(c=>c.path==='/writers'&&c.method==='PUT'),'test must hold a real due renewal');
 const handoff=f.client.processHandoffs();await handoff;f.releaseRenew();await tick;
 const fence=f.permits.findIndex(p=>p.revoked);assert.ok(fence>=0);
 assert.ok(f.permits.slice(fence).every(p=>p.revoked));assert.equal(f.client.writers.has('dashnet.org'),false);
});

test('a scoped writer loss pauses only its own website and preserves unrelated writers and local journals',async()=>{
 const f=fixture();const other={namespace:{kind:'local',origin:'https://other.example'},writer:{epoch:2,expiresAt:new Date(Date.now()+90000).toISOString()}};
 f.client.writers.set('other.example',other);const retained=f.entries.length;
 await f.client.syncFailure(Object.assign(Error('Writer changed'),{code:'HUB_WRITER_LOST',siteGroup:'dashnet.org',origin:f.origin}));
 assert.equal(f.client.writers.has('dashnet.org'),false);assert.equal(f.client.writers.get('other.example'),other);
 assert.equal(f.entries.length,retained);assert.equal(f.status.handoff.phase,'paused');
 assert.ok(f.events.filter(e=>e.type==='atlas:profile-quiesce').every(e=>e.detail?.siteGroup==='dashnet.org'));
});

test('an expired handoff pauses its group and retains journals instead of retrying an obsolete request forever',async()=>{
 const f=fixture();f.client.releases.set('expired',{id:'expired',siteGroup:'dashnet.org',epoch:4,origin:f.origin,fenced:true});
 const retained=f.entries.length;await f.client.syncFailure(f.client.writerFailure(Object.assign(Error('Transfer expired'),{code:'HUB_HANDOFF_EXPIRED'}),{kind:'local',origin:f.origin}));
 assert.equal(f.client.releases.size,0);assert.equal(f.client.writers.has('dashnet.org'),false);assert.equal(f.entries.length,retained);assert.equal(f.status.handoff.phase,'paused');
});

test('a background writer loss cannot overwrite the active website continuation offer or its origin',async()=>{
 const f=fixture({busy:true,hasTarget:false});f.client.writers.clear();await assert.rejects(f.client.ensureOrigin(f.origin),/Continue here/);const previous=f.status;
 await f.client.syncFailure(Object.assign(Error('Background writer lost'),{code:'HUB_WRITER_LOST',siteGroup:'ads.example',origin:'https://ads.example'}));
 assert.equal(f.status,previous);assert.equal(f.status.handoff.siteGroup,'dashnet.org');assert.equal(f.status.origin,f.origin);
});

test('native checkpoint persists live game before teardown, fencing, cloud commit and positive handoff ACK',async()=>{
 const f=fixture({hasTarget:false,checkpointSave:true});await settledTick(f);
 const at=path=>f.calls.findIndex(c=>c.path===path);
 const quiesce=f.calls.findIndex(c=>c.path==='[event]'&&c.type==='atlas:profile-quiesce');
 assert.ok(at('[checkpoint]')>=0);
 assert.ok(at('[checkpoint-complete]')<quiesce);
 const fence=f.calls.findIndex(c=>c.path==='[local-permit]'&&c.permit.revoked);
 assert.ok(quiesce<fence&&fence<at('/commits')&&at('/commits')<at('/writers/requests/handoff/ack'));
 assert.equal(f.entries.length,0);assert.equal(f.acknowledged,true);
});

test('failed native checkpoint retains live website and writer, never quiesces or ACKs',async()=>{
 const f=fixture({checkpointError:true});await settledTick(f);
 assert.ok(f.calls.some(c=>c.path==='[checkpoint]'));
 assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);
 assert.equal(f.permits.some(p=>p.revoked),false);
 assert.equal(f.acknowledged,false);assert.equal(f.client.writers.has('dashnet.org'),true);
 assert.equal(f.client.releases.get('handoff').fenced,undefined);
 assert.equal(f.status.state,'error');assert.match(f.status.message,/still open.*not finished saving/);
 assert.equal(f.status.handoff,undefined,'failed checkpoint must not cover the still-live game');
 await f.client.markOffline();assert.equal(f.permits.at(-1).revoked,false);
 const renewCount=f.calls.filter(c=>c.path==='/writers'&&c.method==='PUT').length;
 await f.advance(100000);await settledTick(f);
 assert.ok(f.calls.filter(c=>c.path==='/writers'&&c.method==='PUT').length>renewCount);
 assert.ok(f.permits.at(-1).expiresAt>Date.now()+90000,'failed checkpoint continues renewing its live writer beyond the lease interval');
 await f.client.flush();assert.equal(f.status.state,'error','unrelated cloud ACK cannot erase a failed native checkpoint');
 assert.equal(f.status.handoff,undefined);assert.equal(f.acknowledged,false);
});

test('duplicate wakeups while checkpoint is pending do not execute two native saves or fence early',async()=>{
 const f=fixture({holdCheckpoint:true});f.client.ensureWakeup();f.hint();await turn();
 f.hint();f.hint();await turn();
 assert.equal(f.calls.filter(c=>c.path==='[checkpoint]').length,1);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);
 assert.equal(f.acknowledged,false);f.releaseCheckpoint();await f.client.handoffFlight;
 assert.equal(f.calls.filter(c=>c.path==='[checkpoint]').length,1);assert.equal(f.acknowledged,true);
});

test('account stop during checkpoint never completes source release in the old account',async()=>{
 const f=fixture({holdCheckpoint:true});const flight=f.client.processHandoffs();await turn();
 f.client.stop();f.releaseCheckpoint();await assert.rejects(flight,/account changed|signed out|Sign in/i);
 assert.equal(f.acknowledged,false);assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);
});

test('a failed native checkpoint cannot starve another website group handoff',async()=>{
 const f=fixture({checkpointError:true,handoffRequests:[{id:'handoff',siteGroup:'dashnet.org',epoch:4},{id:'healthy',siteGroup:'other.example',epoch:4}]});
 f.client.writers.set('other.example',{namespace:{kind:'local',origin:'https://other.example'},writer:{epoch:4,contextId:'source',siteGroup:'other.example',expiresAt:new Date(Date.now()+90000).toISOString()}});
 await assert.rejects(f.client.processHandoffs(),/Native save failed/);
 assert.equal(f.calls.some(c=>c.path==='/writers/requests/handoff/ack'),false);
 assert.equal(f.calls.filter(c=>c.path==='/writers/requests/healthy/ack').length,1);
 assert.equal(f.client.writers.has('dashnet.org'),true);assert.equal(f.client.writers.has('other.example'),false);
 assert.deepEqual(f.events.filter(e=>e.type==='atlas:profile-quiesce').map(e=>e.detail.siteGroup),['other.example']);
});


test('actual expired release ACK clears obsolete request and exposes a fresh continuation instead of permanent retry',async()=>{
 const f=fixture({ackExpired:true});await settledTick(f);
 assert.equal(f.client.releases.size,0);assert.equal(f.client.writers.has('dashnet.org'),false);
 assert.equal(f.status.handoff.phase,'paused');assert.equal(f.status.canContinue,true);
 assert.equal(f.permits.at(-1).revoked,true);assert.equal(f.acknowledged,false);
});
test('actual writer loss during release commit preserves unacknowledged journal and clears stale release',async()=>{
 const f=fixture({commitWriterLost:true});await settledTick(f);
 assert.equal(f.client.releases.size,0);assert.equal(f.client.writers.has('dashnet.org'),false);
 assert.equal(f.entries.length,1);assert.equal(f.status.handoff.phase,'paused');assert.equal(f.status.canContinue,true);
 assert.equal(f.permits.at(-1).revoked,true);assert.equal(f.acknowledged,false);
});

test('a first-group checkpoint error cannot hide terminal expiry cleanup in a later group',async()=>{
 const f=fixture({checkpointError:true,ackExpired:true,handoffRequests:[{id:'handoff',siteGroup:'dashnet.org',epoch:4},{id:'expired',siteGroup:'other.example',epoch:4}]});
 f.client.writers.set('other.example',{namespace:{kind:'local',origin:'https://other.example'},writer:{epoch:4,contextId:'source',siteGroup:'other.example',expiresAt:new Date(Date.now()+90000).toISOString()}});
 await assert.rejects(f.client.processHandoffs(),/Native save failed/);
 assert.equal(f.client.releases.has('handoff'),true);assert.equal(f.client.releases.has('expired'),false);
 assert.equal(f.client.writers.has('dashnet.org'),true);assert.equal(f.client.writers.has('other.example'),false);
 assert.equal(f.status.handoff.phase,'paused');assert.equal(f.status.handoff.siteGroup,'other.example');
 assert.equal(f.status.canContinue,true);assert.equal(f.permits.some(p=>p.group==='dashnet.org'&&p.revoked),false);
});


const visit=(url,time)=>({url:'https://'+url+'.example/',title:url,time});
test('real preferences drain rebases additive concurrent history with a new idempotency key and a positive ACK',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('a',3),visit('old',1)]),canonical=JSON.stringify([visit('b',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical}});await f.client.drainPreferences();
 const post=f.calls.filter(c=>c.path==='/preferences'&&c.method==='POST');assert.equal(post.length,2);assert.notEqual(post[0].body.idempotencyKey,post[1].body.idempotencyKey);
 const changed=post[1].body.payload.changes[0];assert.equal(changed.base,canonical);
 assert.deepEqual(JSON.parse(changed.value).map(x=>x.title),['a','b','old']);
 assert.equal(f.storage.get('atlas.profile.user:profile:atlas.history'),changed.value);assert.equal(f.client.userBase['atlas.history'],changed.value);
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);assert.equal(f.storage.has('atlas.profile.preferences.prepared:profile'),false);
});
test('new local visit during preferences rebase retains both that visit and the other browser additions',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('a',3),visit('old',1)]),canonical=JSON.stringify([visit('b',2),visit('old',1)]),concurrent=JSON.stringify([visit('c',4),visit('a',3),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical,concurrent}});await f.client.drainPreferences();
 assert.deepEqual(JSON.parse(f.storage.get('atlas.profile.user:profile:atlas.history')).map(x=>x.title),['c','a','b','old']);
 assert.deepEqual(JSON.parse(f.client.userBase['atlas.history']).map(x=>x.title),['a','b','old']);
 assert.equal(f.storage.get('atlas.profile.user.pending:profile'),'pending-newer-write-0000000001');
});
test('a user history clear during preferences rebase is never resurrected by the acknowledged merge',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('a',3),visit('old',1)]),canonical=JSON.stringify([visit('b',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical,concurrent:'[]'}});await f.client.drainPreferences();
 assert.equal(f.storage.get('atlas.profile.user:profile:atlas.history'),'[]');
 assert.equal(f.storage.get('atlas.profile.user.pending:profile'),'pending-newer-write-0000000001');
});


test('account stop waits for worker durable revocation before disposal',async()=>{
 const f=fixture();let finish;const gate=new Promise(r=>finish=r),setter=f.client.local.revokePermit;
 f.client.local.revokePermit=async permit=>{await gate;return setter(permit)};
 f.client.stop();await turn();assert.equal(f.calls.some(c=>c.path==='[local-dispose]'),false);
 finish();await turn();assert.equal(f.calls.at(-1).path,'[local-dispose]');
 assert.equal(f.permits.at(-1).revoked,true);assert.equal(f.acknowledged,false);
});


test('waiting alone never bypasses saves; confirmed backup wakes the same flight and acquires only its exact handoff',async()=>{
 const f=fixture({hasTarget:false,waitingTakeover:true});f.client.writers.clear();
 const normal=f.client.takeover(f.origin);await turn();
 assert.equal(f.status.handoff.phase,'waiting');assert.equal(f.status.handoff.canUseBackup,true);
 assert.equal(f.calls.some(c=>c.path==='/writers'&&c.method==='POST'),false);
 const explicit=f.client.useLatestBackup(f.origin);assert.equal(explicit,normal);await explicit;
 const force=f.calls.filter(c=>c.path==='/writers'&&c.method==='POST');assert.equal(force.length,1);
 assert.equal(force[0].body.useLatestBackup,true);assert.equal(force[0].body.handoffId,'pending-handoff');
 assert.equal(f.client.writers.get('dashnet.org').writer.epoch,5);assert.equal(f.status.handoff,undefined);
 assert.ok(f.events.some(e=>e.detail?.handoff?.backupPending===true));
 assert.equal(f.calls.some(c=>c.path.includes('/ack')||c.path==='/commits'),false,'using a backup never claims that source data uploaded');
});
test('backup click for an unrelated site or after ordinary completion cannot acquire a writer',async()=>{
 const f=fixture({hasTarget:false,waitingTakeover:true});f.client.writers.clear();const normal=f.client.takeover(f.origin);await turn();
 await f.client.useLatestBackup('https://unrelated.test');assert.equal(f.calls.some(c=>c.body?.useLatestBackup),false);
 f.finishNormal();await normal;const count=f.calls.filter(c=>c.path==='/writers'&&c.method==='POST').length;await f.client.useLatestBackup(f.origin);assert.equal(f.calls.filter(c=>c.path==='/writers'&&c.method==='POST').length,count);assert.equal(f.calls.some(c=>c.body?.useLatestBackup),false);
});
test('duplicate confirmed clicks share one writer request and one restored website',async()=>{
 const f=fixture({hasTarget:false,waitingTakeover:true});f.client.writers.clear();const normal=f.client.takeover(f.origin);await turn();
 const a=f.client.useLatestBackup(f.origin),b=f.client.useLatestBackup(f.origin);await Promise.all([a,b,normal]);
 assert.equal(f.calls.filter(c=>c.body?.useLatestBackup).length,1);assert.equal(f.events.filter(e=>e.type==='atlas:profile-ready').length,1);
});
test('a failed backup operation exposes the actual retryable waiting error and preserves source journals',async()=>{
 const f=fixture({hasTarget:false,waitingTakeover:true,backupFailures:2});f.client.writers.clear();const normal=f.client.takeover(f.origin);await turn();
 const explicit=f.client.useLatestBackup(f.origin);await turn();await turn();
 assert.match(f.status.handoff.error,/Saved version unavailable/);assert.equal(f.status.handoff.canUseBackup,true);assert.equal(f.status.handoff.backupPending,undefined);
 assert.equal(f.client.writers.size,0);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
 f.finishNormal();await Promise.all([normal,explicit]);
});
test('lost backup response retries only the identical confirmed operation, not another handoff',async()=>{
 const f=fixture({hasTarget:false,waitingTakeover:true,backupFailures:1});f.client.writers.clear();const normal=f.client.takeover(f.origin);await turn();await f.client.useLatestBackup(f.origin);await normal;
 const calls=f.calls.filter(c=>c.body?.useLatestBackup);assert.equal(calls.length,2);assert.equal(JSON.stringify(calls[0].body),JSON.stringify(calls[1].body));assert.equal(f.client.writers.get('dashnet.org').writer.epoch,5);
});
test('an unconfirmed or wrong-context writer result never restores a website or marks it synchronized',async()=>{
 const f=fixture({hasTarget:false,waitingTakeover:true,invalidBackupWriter:true});f.client.writers.clear();const normal=f.client.takeover(f.origin);void normal.catch(()=>{});await turn();
 await assert.rejects(f.client.useLatestBackup(f.origin),/not confirmed/);assert.equal(f.client.writers.size,0);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
});

const cookieEvent=(profileId='profile')=>({type:'atlas:profile-native-change',detail:{kind:'cookies',profileId,origin:'https://orteil.dashnet.org'}});
test('cookie background sync waits 15 seconds and coalesces pending status instead of flushing every native commit',async()=>{
 const f=fixture();for(let i=0;i<100;i++)f.client.changed(cookieEvent());await turn();
 assert.equal(f.calls.filter(c=>c.path==='/commits').length,0);assert.equal(f.events.filter(e=>e.type==='atlas:profile-status').length,1);assert.equal(f.timers.size,1);
 await f.advance(14999);assert.equal(f.calls.filter(c=>c.path==='/commits').length,0);
 await f.advance(1);assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);assert.equal(f.entries.length,0);assert.equal(f.status.state,'synced');
});
test('continuous cookie writes do not move the first-change deadline',async()=>{
 const f=fixture();f.client.changed(cookieEvent());for(let i=0;i<14;i++){await f.advance(1000);f.client.changed(cookieEvent())}
 assert.equal(f.calls.filter(c=>c.path==='/commits').length,0);await f.advance(1000);assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);
});
test('explicit sync and best-effort page hide bypass the cookie interval without deleting journals',async()=>{
 for(const action of ['flush','leaving']){const f=fixture();f.client.changed(cookieEvent());await f.advance(3000);await f.client[action]();await f.client.flight;assert.equal(f.entries.length,0);assert.equal(f.timers.size,0)}
});
test('cookie events from a different profile are ignored and sign out cancels the pending timer',async()=>{
 const f=fixture();f.client.changed(cookieEvent('other'));assert.equal(f.timers.size,0);f.client.changed(cookieEvent());assert.equal(f.timers.size,1);f.client.stop();assert.equal(f.timers.size,0);await f.advance(30000);f.client.changed(cookieEvent());assert.equal(f.calls.some(c=>c.path==='/commits'),false);assert.equal(f.entries.length,1);
});
test('cookie changes arriving during a real drain keep their15second batch deadline',async()=>{
 const f=fixture();let release;const held=new Promise(r=>release=r),request=f.client.request.bind(f.client);
 f.client.request=async(path,...args)=>{if(path==='/commits')await held;return request(path,...args)};
 f.client.changed();await f.advance(1000);assert.ok(f.client.flight);
 f.entries.push({entry:{id:'new-cookie-change',profileId:'profile',kind:'cookies',origin:'https://dashnet.org',payload:{changes:[{op:'set',cookie:{domain:'dashnet.org',id:'new',name:'new',value:'1'}}]},createdAt:2,bytes:64},database:'native',store:'journal',key:99,arrayKeys:false});
 f.client.changed(cookieEvent());release();await f.client.flight?.catch(()=>{});await turn();assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);assert.equal(f.entries.length,1);
 await f.advance(14999);assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);await f.advance(1);assert.equal(f.calls.filter(c=>c.path==='/commits').length,2);assert.equal(f.entries.length,0);f.client.stop();
});
test('preferences use the1second batch and handoff checkpoints still bypass cookie batching',async()=>{
 const f=fixture();f.client.changed(cookieEvent());f.client.changed({type:'atlas:profile-user-change'});assert.equal(f.calls.some(c=>c.path==='/commits'),false);await f.advance(1000);assert.equal(f.entries.length,0);assert.equal(f.timers.size,0);
 const g=fixture({checkpointSave:true});g.client.changed(cookieEvent());await g.client.prepareReplacement();assert.equal(g.entries.length,0);assert.equal(g.client.writers.size,0);assert.equal(g.timers.size,0);
});


// Each shell owns an in-memory base, while the Web Lock and acknowledged base
// are shared by all same-origin shells. A later drain must use the latter.
test('fresh preferences use another window acknowledged base without an avoidable409 or GET',async()=>{
 const base=JSON.stringify([visit('old',1)]),acknowledged=JSON.stringify([visit('other-window',2),visit('old',1)]),local=JSON.stringify([visit('latest',3),visit('other-window',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical:acknowledged}});
 f.storage.set('atlas.profile.user.base:profile',JSON.stringify({'atlas.history':acknowledged}));
 const calls=[];f.client.request=async(path,method,body)=>{calls.push({path,method,body});assert.equal(method,'POST');assert.equal(body.payload.changes[0].base,acknowledged);return{acknowledged:true,revision:10}};
 await f.client.drainPreferences();assert.equal(calls.length,1);assert.equal(f.client.userBase['atlas.history'],local);
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
});
test('another window already acknowledged the same value clears redundant local marker without HTTP',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('latest',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical:local}});
 f.storage.set('atlas.profile.user.base:profile',JSON.stringify({'atlas.history':local}));
 f.client.request=async()=>assert.fail('No request is needed for a durable same-origin acknowledged value');
 await f.client.drainPreferences();assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
 assert.equal(f.storage.has('atlas.profile.preferences.prepared:profile'),false);
});
test('malformed persisted preference base fails closed while preserving local pending values',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('latest',2),visit('old',1)]);
 for(const saved of ['{','null','[]','{"atlas.history":7}']){
  const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical:base}});
  f.storage.set('atlas.profile.user.base:profile',saved);f.client.request=async()=>assert.fail('Must not write from an invalid base');
  await assert.rejects(f.client.drainPreferences(),/Local settings recovery/);
  assert.equal(f.storage.get('atlas.profile.user:profile:atlas.history'),local);assert.equal(f.storage.has('atlas.profile.user.pending:profile'),true);
 }
});
test('retained uncertain preference request replays exact payload before newer local edit is saved',async()=>{
 const base=JSON.stringify([visit('old',1)]),preparedValue=JSON.stringify([visit('prepared',2),visit('old',1)]),local=JSON.stringify([visit('latest',3),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical:base}});
 const prepared={id:'retained-key-00000000000001',changes:[{key:'atlas.history',base,value:preparedValue}],payload:{format:'atlas-preferences-patch-v1',changes:[{key:'atlas.history',base,value:preparedValue}]}};
 f.storage.set('atlas.profile.preferences.prepared:profile',JSON.stringify(prepared));
 f.storage.set('atlas.profile.user.base:profile',JSON.stringify({'atlas.history':'do not rewrite an uncertain operation'}));
 const calls=[];f.client.request=async(path,method,body)=>{calls.push(body);return{acknowledged:true,revision:10}};
 await f.client.drainPreferences();assert.equal(calls.length,1);assert.equal(calls[0].idempotencyKey,prepared.id);assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)),prepared.payload);
 assert.equal(f.client.userBase['atlas.history'],preparedValue);assert.equal(f.storage.get('atlas.profile.user:profile:atlas.history'),local);
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),true);assert.equal(f.storage.has('atlas.profile.preferences.prepared:profile'),false);
 await f.client.drainPreferences();assert.equal(calls.length,2);assert.notEqual(calls[1].idempotencyKey,prepared.id);
 assert.equal(calls[1].payload.changes[0].base,preparedValue);assert.equal(calls[1].payload.changes[0].value,local);
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
});
test('a local revert before retry cannot discard a retained uncertain preference request or claim synced',async()=>{
 const base=JSON.stringify([visit('old',1)]),preparedValue=JSON.stringify([visit('prepared',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local:base,canonical:base}});
 const changes=[{key:'atlas.history',base,value:preparedValue}],prepared={id:'retained-key-00000000000001',changes,payload:{format:'atlas-preferences-patch-v1',changes}};
 f.storage.set('atlas.profile.preferences.prepared:profile',JSON.stringify(prepared));const calls=[];
 f.client.request=async(path,method,body)=>{calls.push(body);return{acknowledged:true,revision:10}};
 await f.client.drainPreferences();assert.equal(calls.length,1);assert.equal(calls[0].idempotencyKey,prepared.id);
 assert.equal(f.storage.get('atlas.profile.user:profile:atlas.history'),base);assert.equal(f.client.userBase['atlas.history'],preparedValue);
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),true);
 await f.client.drainPreferences();assert.equal(calls.length,2);assert.equal(calls[1].payload.changes[0].value,base);
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
});
test('lost preference ACK keeps its exact prepared request and pending marker for retry',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('latest',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical:base}});const calls=[];
 f.client.request=async(path,method,body)=>{calls.push(JSON.parse(JSON.stringify(body)));if(calls.length===1)throw Object.assign(Error('Response lost'),{status:503});return{acknowledged:true,revision:10}};
 await assert.rejects(f.client.drainPreferences(),/Response lost/);const retained=f.storage.get('atlas.profile.preferences.prepared:profile');assert.ok(retained);assert.equal(f.storage.has('atlas.profile.user.pending:profile'),true);
 f.storage.set('atlas.profile.user.base:profile',JSON.stringify({'atlas.history':'new shared base must not rewrite uncertain operation'}));
 await f.client.drainPreferences();assert.deepEqual(calls[1],calls[0]);assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
});
test('413 save rejection preserves native queue and live writer without false acknowledgement or fencing',async()=>{
 const f=fixture();const original=f.client.request.bind(f.client),before=JSON.stringify(f.entries);
 f.client.request=async(path,...args)=>{if(path==='/commits')throw Object.assign(Error('Account backup quota exceeded.'),{status:413,code:'HUB_QUOTA'});return original(path,...args)};
 await assert.rejects(f.client.drain(),e=>e.status===413&&e.code==='HUB_QUOTA');
 assert.equal(JSON.stringify(f.entries),before);assert.equal(f.client.writers.size,1);
 assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);assert.equal(f.permits.some(p=>p.revoked),false);
 assert.equal(f.status.state,'pending');
});
test('replaying a retained preference request preserves unrelated acknowledged base keys from another window',async()=>{
 const base=JSON.stringify([visit('old',1)]),local=JSON.stringify([visit('latest',2),visit('old',1)]);
 const f=fixture({hasTarget:false,preferenceFixture:{base,local,canonical:base}}),changes=[{key:'atlas.history',base,value:local}];
 f.storage.set('atlas.profile.preferences.prepared:profile',JSON.stringify({id:'retained-key-00000000000001',changes,payload:{format:'atlas-preferences-patch-v1',changes}}));
 f.storage.set('atlas.profile.user.base:profile',JSON.stringify({'atlas.history':base,'atlas.settings':'{"theme":"new-acknowledged-theme"}'}));
 f.client.request=async()=>({acknowledged:true,revision:10});await f.client.drainPreferences();
 assert.equal(JSON.parse(f.storage.get('atlas.profile.user.base:profile'))['atlas.settings'],'{"theme":"new-acknowledged-theme"}');
});
test('legacy deletion tombstones normalize to absence and a retained deletion ACK allows the next save',async()=>{
 const base=JSON.stringify([visit('old',1)]),f=fixture({hasTarget:false,preferenceFixture:{base,local:base,canonical:base}});
 f.storage.delete('atlas.profile.user:profile:atlas.history');
 f.storage.set('atlas.profile.user.base:profile',JSON.stringify({'atlas.history':base,'atlas.shortcuts':null}));
 const changes=[{key:'atlas.history',base,value:null}];
 f.storage.set('atlas.profile.preferences.prepared:profile',JSON.stringify({id:'retained-delete-000000000001',changes,payload:{format:'atlas-preferences-patch-v1',changes}}));
 const calls=[];f.client.request=async(path,method,body)=>{calls.push(body);return{acknowledged:true,revision:10}};
 await f.client.drainPreferences();assert.equal(calls[0].payload.changes[0].value,null);
 assert.deepEqual(JSON.parse(f.storage.get('atlas.profile.user.base:profile')),{});
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
 f.storage.set('atlas.profile.user:profile:atlas.history','[]');f.storage.set('atlas.profile.user.pending:profile','new-edit-after-delete-00001');
 await f.client.drainPreferences();assert.equal(calls.length,2);assert.equal(calls[1].payload.changes[0].base,null);assert.equal(calls[1].payload.changes[0].value,'[]');
 assert.equal(f.storage.has('atlas.profile.user.pending:profile'),false);
});
