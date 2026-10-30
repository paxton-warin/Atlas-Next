import {withProfileGroupLock} from '../runtime/profile-locks.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {createProfileSyncScheduler} from '../web/src/profile-sync-scheduler.ts';
import {restoreProfileChunks} from '../web/src/profile-chunk-restore.ts';
import {loadProfileStream,loadProfileStreamHead} from '../web/src/profile-stream.ts';
import {hubNamespace,hubSiteGroup} from '../runtime/hub-contracts.ts';
import {drainProfileQueue,changeNamespace} from '../runtime/profile-sync.ts';
import {temporaryProfileFailure} from '../web/src/profile-errors.ts';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return{promise,release}};
const nativeEvent=(kind='local',profileId='profile')=>({type:'atlas:profile-native-change',detail:{kind,profileId,origin:'https://example.com'}});
/** Runs actual ProfileClient and durable queue drain; only network/storage boundary
 * adapters are deterministic. No production/browser/customer state is modified. */
function fixture({pending=true,holdCommit=false,failCommit=false,handoffs=[]}={}){
 const calls=[],events=[],permits=[],storage=new Map(),timers=new Map(),entries=[],heads=new Map();const clockBase=Date.now();let now=0,nextTimer=0;
 const commitGate=gate(),session={grant:{profileId:'profile',contextId:'context',sessionId:'session'}},origin='https://example.com';
 const writerFor=group=>({epoch:4,contextId:'context',siteGroup:group,expiresAt:new Date(clockBase+now+90000).toISOString()});
 if(pending)entries.push({entry:{id:'journal-0000000000000001',profileId:'profile',kind:'local',origin,createdAt:1,bytes:64,payload:{change:{op:'set',key:'draft',value:'durable-local-value'},revision:1}},database:'native',store:'journal',key:1,arrayKeys:false});
 const queue={list:async()=>[...entries],metadata:async()=>[...entries],head:async c=>heads.get(hubNamespace(changeNamespace(c)).key)||{revision:0,epoch:4},prepared:async()=>null,prepare:async()=>{},acknowledge:async(c,head)=>{heads.set(hubNamespace(changeNamespace(c)).key,head);entries.splice(entries.indexOf(c),1)}};
 const local={queue,readHead:async()=>null,revokePermit:async()=>true,setPermit:async p=>{permits.push(p)},dispose:()=>{},pendingNamespaces:async()=>entries.map(changeNamespace),prepareQueueWire:async c=>c.entry.payload,prepareWire:async v=>v};
 const no=()=>{};
 const request=async(path='',method='GET',body)=>{calls.push({path,method,body});
  if(path==='/writers'&&(method==='PUT'||method==='POST'))return{writer:writerFor(hubNamespace(body.namespace).siteGroup)};
  if(path==='/writers/requests')return{requests:handoffs};
  if(path==='/stream')return{revision:0,snapshotRevision:0,restoreBytes:0,snapshotBytes:0};
  if(path.startsWith('/receipts/'))throw Object.assign(Error('No receipt'),{status:404});
  if(path==='/commits'){if(holdCommit)await commitGate.promise;if(failCommit)throw Object.assign(Error('Cloud backup unavailable'),{status:503});return{acknowledged:true,revision:body.baseRevision+1}};
  if(path==='')return{profileId:'profile',initialized:true,streams:[],writers:[]};
  if(path==='/preferences')return{revision:0,values:{}};
  throw Error('Unexpected request '+method+' '+path);
 };
 const imports={'../../runtime/profile-locks':{withProfileGroupLock},'./profile-sync-scheduler':{createProfileSyncScheduler},'./profile-chunk-restore':{restoreProfileChunks},'./profile-stream':{loadProfileStream,loadProfileStreamHead},'./profile-wakeup':{watchProfileWriters:()=>({closed:()=>false,close:no})},'./profile-checkpoint':{checkpointProfileGroup:no},'./profile-preferences':{},'./profile-local-store':{createProfileLocalStore:()=>local},'./hub-client-state':{getHubSession:()=>session,registerHubInitializer:no,hubProfileRequest:request},'../../runtime/profile-limits.ts':{},'../../runtime/profile-context':{setProfileDocumentGuard:no},'../../runtime/profile-permissions':{invalidateProfilePermits:no},'../../runtime/profile-store':{},'../../runtime/profile-sync':{drainProfileQueue,changeNamespace},'../../runtime/hub-contracts':{hubNamespace,hubSiteGroup,HUB_LIMITS:{streamBytes:128*1024*1024}},'./model':{portableAtlasKey:()=>false},'./profile-errors':{temporaryProfileFailure},'./profile-import':{},'./profile-legacy-migration':{}};
 const window={setTimeout:(work,delay)=>{const id=++nextTimer;timers.set(id,{work,at:now+delay});return id},clearTimeout:id=>timers.delete(id),addEventListener:no,removeEventListener:no,dispatchEvent:e=>events.push(e),document:{removeEventListener:no}};
 const ClockDate=class extends Date{constructor(...args){super(...(args.length?args:[clockBase+now]))}static now(){return clockBase+now}};
 const source=readFileSync(process.env.ATLAS_PROFILE_CLIENT_SOURCE||new URL('../web/src/profile-client.ts',import.meta.url),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,exports={};
 runInNewContext(compiled+'\nexports.client=new ProfileClient(getHubSession());active=exports.client;', {exports,require:name=>{if(!imports[name])throw Error('Unexpected import '+name);return imports[name]},getHubSession:()=>session,window,Date:ClockDate,navigator:{onLine:true,locks:{request:async(_,...args)=>args.at(-1)()}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),get length(){return storage.size},key:i=>[...storage.keys()][i]},indexedDB:{},crypto:webcrypto,TextEncoder,TextDecoder,URL,Uint8Array,Error,AbortController,DOMException,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},setTimeout,clearTimeout,clearInterval});
 const client=exports.client;client.ready=true;client.writers.set('example.com',{namespace:{kind:'local',origin},writer:writerFor('example.com')});client.readyGroups.set('example.com',4);
 return{client,calls,events,permits,timers,entries,origin,releaseCommit:commitGate.release,async advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].work();await turn();}now=end;await turn();},setRemainingLease(ms){client.writers.get('example.com').writer.expiresAt=new Date(clockBase+now+ms).toISOString()}};
}
const backupRequests=f=>f.calls.filter(c=>['/commits','/stream','/preferences'].includes(c.path)||c.path.startsWith('/receipts/'));
test('ordinary dirty bursts coalesce for one second while the durable journal remains local',async()=>{
 const f=fixture();for(let i=0;i<100;i++)f.client.changed(nativeEvent());await turn();
 assert.equal(backupRequests(f).length,0);assert.equal(f.entries.length,1);await f.advance(999);assert.equal(backupRequests(f).length,0);await f.advance(1);
 assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);assert.equal(f.entries.length,0);assert.equal(f.events.at(-1).detail.state,'synced');f.client.stop();
});
test('continuous normal writes retain the first-change deadline rather than postponing indefinitely',async()=>{
 const f=fixture();f.client.changed(nativeEvent());for(let i=0;i<9;i++){await f.advance(100);f.client.changed(nativeEvent())}assert.equal(backupRequests(f).length,0);await f.advance(100);assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);f.client.stop();
});
test('page hide and explicit flush bypass batching but still require positive durable acknowledgement',async()=>{
 for(const action of ['flush','leaving']){const f=fixture();f.client.changed(nativeEvent());await f.advance(100);await f.client[action]();await f.client.flight;await turn();assert.equal(f.entries.length,0);assert.equal(f.calls.filter(c=>c.path==='/commits').length,1);assert.equal(f.timers.size,0);f.client.stop()}
});
test('idle maintenance performs no backup or manifest requests and skips premature lease renewal',async()=>{
 const f=fixture({pending:false});await f.client.tick();await turn();assert.equal(backupRequests(f).length,0);assert.equal(f.calls.some(c=>c.path===''),false);assert.equal(f.calls.some(c=>c.path==='/writers'&&c.method==='PUT'),false);f.client.stop();
});
test('a held background cloud upload cannot hold maintenance renewal or ready local browsing',async()=>{
 const f=fixture({holdCommit:true});f.client.changed(nativeEvent());await f.advance(1000);assert.ok(f.calls.some(c=>c.path==='/commits'));f.setRemainingLease(30000);
 let complete=false;const maintenance=f.client.tick().then(()=>complete=true);await turn();assert.equal(complete,true,'renewal/control loop must not await background upload');await maintenance;
 assert.ok(f.calls.some(c=>c.path==='/writers'&&c.method==='PUT'));await f.client.ensureOrigin(f.origin);assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);assert.equal(f.entries.length,1);
 f.releaseCommit();await f.client.flight;await turn();assert.equal(f.entries.length,0);f.client.stop();
});
test('backup outage backs off without unloading a ready site or suppressing due writer renewal',async()=>{
 const f=fixture({failCommit:true});f.client.changed(nativeEvent());await f.advance(1000);assert.equal(f.entries.length,1);await f.client.ensureOrigin(f.origin);assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);
 const count=f.calls.filter(c=>c.path==='/commits').length;for(let i=0;i<50;i++)f.client.changed(nativeEvent());await f.advance(500);assert.equal(f.calls.filter(c=>c.path==='/commits').length,count,'dirty events cannot defeat backoff');f.setRemainingLease(30000);await f.client.tick();await turn();assert.ok(f.calls.some(c=>c.path==='/writers'&&c.method==='PUT'));assert.equal(f.entries.length,1);f.client.stop();
});
test('foreign-profile events cannot schedule a backup and sign out cancels all scheduled work',async()=>{
 const f=fixture();f.client.changed(nativeEvent('local','other'));assert.equal(f.timers.size,0);f.client.changed(nativeEvent());assert.equal(f.timers.size,1);const before=f.calls.length;f.client.stop();await f.advance(30000);assert.equal(f.calls.length,before);assert.equal(f.entries.length,1);assert.equal(f.timers.size,0);
});

test('one failed due renewal cannot suppress an independent due writer or pause its ready local page',async()=>{
 const f=fixture({pending:false});f.setRemainingLease(30000);const other='independent.example';f.client.writers.set(other,{namespace:{kind:'local',origin:'https://'+other},writer:{epoch:8,contextId:'context',siteGroup:other,expiresAt:new Date(Date.now()+30000).toISOString()}});f.client.readyGroups.set(other,8);
 const original=f.client.request.bind(f.client);f.client.request=async(path,method,body)=>{if(path==='/writers'&&method==='PUT'){if(body.namespace.origin===f.origin)throw Object.assign(Error('Temporary renewal failure'),{status:503});f.calls.push({path,method,body});return{writer:{epoch:8,contextId:'context',siteGroup:other,expiresAt:new Date(Date.now()+90000).toISOString()}}}return original(path,method,body)};
 await f.client.tick();await turn();assert.ok(f.calls.some(c=>c.path==='/writers'&&c.body.namespace.origin==='https://'+other));assert.equal(f.client.writers.get(other).writer.epoch,8);assert.equal(f.events.some(e=>e.type==='atlas:profile-quiesce'),false);await f.client.ensureOrigin('https://'+other);assert.equal(backupRequests(f).length,0);f.client.stop();
});

test('explicit Retry resumes a terminally paused backup without discarding its pending journal',async()=>{
 const f=fixture();let reject=true;const request=f.client.request.bind(f.client);f.client.request=async(path,...args)=>{if(path==='/commits'&&reject)throw Object.assign(Error('Repair needed'),{code:'PROFILE_REVISION_CONFLICT',status:409});return request(path,...args)};
 f.client.changed(nativeEvent());await f.advance(1000);assert.equal(f.entries.length,1);const paused=f.events.at(-1).detail;assert.notEqual(paused.state,'synced');f.client.changed(nativeEvent());await f.advance(30000);assert.equal(f.entries.length,1);assert.equal(f.events.at(-1).detail.message,paused.message,'new dirty events cannot hide a paused error');
 reject=false;await f.client.retryBackup();assert.equal(f.entries.length,0);assert.equal(f.events.at(-1).detail.state,'synced');f.client.stop();
});

test('new independent site saves without retrying a known terminally failed group; manual Retry still resumes it',async()=>{
 const f=fixture();let blocked=true;const attempts=[],request=f.client.request.bind(f.client);
 f.client.request=async(path,method,body)=>{if(path==='/commits'){attempts.push(body.namespace.origin);if(blocked&&body.namespace.origin===f.origin)throw Object.assign(Error('Example save needs repair'),{code:'PROFILE_REVISION_CONFLICT',status:409})}return request(path,method,body)};
 f.client.changed(nativeEvent());await f.advance(1000);assert.deepEqual(attempts,[f.origin]);assert.equal(f.entries.length,1);
 const other='https://independent.example';f.client.writers.set('independent.example',{namespace:{kind:'local',origin:other},writer:{epoch:4,contextId:'context',siteGroup:'independent.example',expiresAt:new Date(Date.now()+90000).toISOString()}});f.client.readyGroups.set('independent.example',4);
 for(let i=0;i<2;i++)f.entries.push({entry:{id:'other-durable-journal-'+i,profileId:'profile',kind:'local',origin:other,createdAt:i+2,bytes:64,payload:{change:{op:'set',key:'draft',value:'independent-'+i},revision:i+1}},database:'native',store:'journal',key:i+2,arrayKeys:false});
 f.client.changed({type:'atlas:profile-native-change',detail:{kind:'local',profileId:'profile',origin:other}});await f.advance(1000);
 assert.equal(attempts.filter(origin=>origin===f.origin).length,1,'independent background work must not retry the paused site');assert.equal(attempts.filter(origin=>origin===other).length,2);assert.equal(f.entries.length,1);assert.equal(f.entries[0].entry.origin,f.origin);assert.notEqual(f.events.at(-1).detail.state,'synced');assert.match(f.events.at(-1).detail.message,/repair/);
 blocked=false;await f.client.retryBackup();assert.equal(f.entries.length,0);assert.equal(attempts.filter(origin=>origin===f.origin).length,2);assert.equal(f.events.at(-1).detail.state,'synced');f.client.stop();
});

test('transient backoff automatically retries the same group rather than treating it as terminally paused',async()=>{
 const f=fixture();let unavailable=true,attempts=0;const request=f.client.request.bind(f.client);f.client.request=async(path,...args)=>{if(path==='/commits'){attempts++;if(unavailable)throw Object.assign(Error('Cloud temporarily unavailable'),{status:503})}return request(path,...args)};
 f.client.changed(nativeEvent());await f.advance(1000);assert.equal(attempts,1);assert.equal(f.entries.length,1);unavailable=false;await f.advance(4000);assert.equal(attempts,2);assert.equal(f.entries.length,0);assert.equal(f.events.at(-1).detail.state,'synced');f.client.stop();
});

function addSite(f,origin,id){const group=hubSiteGroup(origin);f.client.writers.set(group,{namespace:{kind:'local',origin},writer:{epoch:4,contextId:'context',siteGroup:group,expiresAt:new Date(Date.now()+90000).toISOString()}});f.client.readyGroups.set(group,4);f.entries.push({entry:{id:'journal-'+id,profileId:'profile',kind:'local',origin,createdAt:2,bytes:64,payload:{change:{op:'set',key:'draft',value:id},revision:1}},database:'native',store:'journal',key:id,arrayKeys:false})}
const changedSite=(client,origin)=>client.changed({type:'atlas:profile-native-change',detail:{profileId:'profile',kind:'local',origin}});
test('a transient second-site outage retries automatically while terminal first-site data stays paused',async()=>{
 const f=fixture(),other='https://transient.example';addSite(f,other,'other');let offline=true;const attempts=[],request=f.client.request.bind(f.client);
 f.client.request=async(path,method,body)=>{if(path==='/commits'){attempts.push(body.namespace.origin);if(body.namespace.origin===f.origin)throw Object.assign(Error('First site repair needed'),{status:409,code:'PROFILE_REVISION_CONFLICT'});if(offline)throw Object.assign(Error('Second site temporarily offline'),{status:503})}return request(path,method,body)};
 f.client.changed(nativeEvent());await f.advance(1000);assert.deepEqual(attempts,[f.origin,other]);assert.equal(f.entries.length,2);offline=false;await f.advance(4000);
 assert.equal(attempts.filter(o=>o===f.origin).length,1);assert.equal(attempts.filter(o=>o===other).length,2);assert.equal(f.entries.length,1);assert.equal(f.entries[0].entry.origin,f.origin);assert.match(f.events.at(-1).detail.message,/repair/);assert.equal(f.timers.size,0);f.client.stop();
});
test('two paused terminal groups remain isolated when a third group saves and cannot resume each other',async()=>{
 const f=fixture(),second='https://second.example',third='https://third.example';addSite(f,second,'second');const attempts=[],request=f.client.request.bind(f.client);
 f.client.request=async(path,method,body)=>{if(path==='/commits'){attempts.push(body.namespace.origin);if(body.namespace.origin!==third)throw Object.assign(Error('Repair '+body.namespace.origin),{status:409,code:'PROFILE_REVISION_CONFLICT'})}return request(path,method,body)};
 f.client.changed(nativeEvent());await f.advance(1000);assert.deepEqual(attempts,[f.origin,second]);for(let i=0;i<20;i++){changedSite(f.client,f.origin);changedSite(f.client,second)}await f.advance(5000);assert.equal(attempts.length,2);assert.equal(f.timers.size,0);
 addSite(f,third,'third');changedSite(f.client,third);await f.advance(1000);assert.deepEqual(attempts,[f.origin,second,third]);assert.equal(f.entries.length,2);assert.notEqual(f.events.at(-1).detail.state,'synced');f.client.stop();
});
test('account-wide quota pause is not bypassed by activity in a new independent site',async()=>{
 const f=fixture(),other='https://other.example';let attempts=0;f.client.request=async path=>{if(path==='/commits'){attempts++;throw Object.assign(Error('Account allowance exceeded'),{status:413,code:'HUB_PROFILE_QUOTA'})}if(path==='/stream')return{revision:0,snapshotRevision:0,restoreBytes:0,snapshotBytes:0};throw Error('Unexpected '+path)};
 f.client.changed(nativeEvent());await f.advance(1000);assert.equal(attempts,1);addSite(f,other,'other');changedSite(f.client,other);await f.advance(10000);assert.equal(attempts,1);assert.equal(f.entries.length,2);assert.equal(f.timers.size,0);assert.match(f.events.at(-1).detail.message,/allowance/);f.client.stop();
});
