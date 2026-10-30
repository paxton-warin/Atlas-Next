import {withProfileGroupLock} from '../runtime/profile-locks.ts';
import {createProfileSyncScheduler} from '../web/src/profile-sync-scheduler.ts';
import {restoreProfileChunks} from '../web/src/profile-chunk-restore.ts';
import {loadProfileStream,loadProfileStreamHead} from '../web/src/profile-stream.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { hubNamespace, hubSiteGroup } from '../runtime/hub-contracts.ts';
import { changeNamespace } from '../runtime/profile-sync.ts';
import { profileSyncRepairAvailable } from '../web/src/profile-status-view.ts';

function fixture({ack=true,failRestore=false,busy=false}={}) {
 const calls=[],events=[],values=new Map(),session={grant:{profileId:'profile',contextId:'context',sessionId:'session'}};
 const q=[{entry:{id:'change',kind:'local',origin:'https://example.com',payload:{key:'draft',value:'local-only'}},key:'change',database:'native',store:'meta',arrayKeys:false}];
 let acknowledge=ack,restoreFailure=failRestore;
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
 const local={pendingNamespaces:async()=>q.map(changeNamespace),prepareRecovery:async()=>({wire:{snapshots:[{payload:{draft:'local-only'}}]},changes:q.length}),finishRecovery:async()=>{calls.push('local-recovery');q.splice(0,q.length);},queue:{list:async()=>q},revokePermit:async()=>true,setPermit:async p=>calls.push(p.revoked?'fence':'permit'),exportSnapshots:async()=>[{namespace:{kind:'local',origin:'https://example.com'},payload:{draft:'local-only'}}],preserveRecovery:async(id,changes,payload)=>{calls.push('local-recovery');assert.equal(payload.snapshots[0].payload.draft,'local-only');q.splice(0,q.length);}};
 const raw=async(path='',method,body)=>{calls.push(path||'manifest');if(path==='/writers'){if(busy)throw Object.assign(Error('busy'),{code:'HUB_WRITER_BUSY'});return{writer:{epoch:2,siteGroup:'example.com',contextId:'context',expiresAt:new Date(Date.now()+90000).toISOString()}};}if(path==='/recoveries'){assert.equal(body.payload.snapshots[0].payload.draft,'local-only');return{acknowledged:acknowledge,id:body.id};}if(path==='')return{streams:[]};throw Error('Unexpected request '+path);};
 const no=()=>{},imports={'../../runtime/profile-locks':{withProfileGroupLock},'./profile-checkpoint':{checkpointProfileGroup:async()=>calls.push('checkpoint')},'./profile-stream':{loadProfileStream,loadProfileStreamHead},'./profile-sync-scheduler':{createProfileSyncScheduler},'./profile-chunk-restore':{restoreProfileChunks},'./hub-client-state':{registerHubInitializer:no,getHubSession:()=>session,hubProfileRequest:raw},'./profile-local-store':{createProfileLocalStore:()=>local},'../../runtime/hub-contracts.ts':{hubNamespace,hubSiteGroup},'../../runtime/profile-sync':{changeNamespace,drainProfileQueue:async()=>{assert.equal(q.length,0);return 0;}},'./profile-errors':{temporaryProfileFailure:()=>false}};
 let lockHeld=false;
 const heldLocks=new Set();
 const locks={request:async(name,...args)=>{const work=args.at(-1);assert.equal(heldLocks.has(name),false,'repair must not recursively acquire the same non-reentrant resource lock');heldLocks.add(name);lockHeld=true;try{return await work();}finally{heldLocks.delete(name);lockHeld=heldLocks.size>0;}}};
 const exports={};let source=readFileSync(process.env.ATLAS_PROFILE_CLIENT_SOURCE||new URL('../web/src/profile-client.ts',import.meta.url),'utf8');source=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(source+'\nexports.client=new ProfileClient(getHubSession());active=exports.client;', {exports,require:n=>imports[n]||imports[n+'.ts']||{},window:{addEventListener:no,removeEventListener:no,dispatchEvent:e=>events.push(e),clearTimeout},navigator:{onLine:true,locks},localStorage:storage,indexedDB:{},crypto:webcrypto,TextEncoder,TextDecoder,URL,Date,Error,Uint8Array,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},setTimeout,clearTimeout,clearInterval,getHubSession:()=>session});
 const client=exports.client;client.wire=async v=>v;client.restoreLocked=async(n,epoch,force)=>{assert.equal(lockHeld,true);assert.equal(force,true,'archived local changes require an authoritative restore even if the old head happens to match');calls.push('restore');if(restoreFailure)throw Error('restore failed');assert.equal(n.origin,'https://example.com');};
 return {client,calls,events,q,values,setAck:v=>acknowledge=v,setRestoreFailure:v=>restoreFailure=v};
}
test('repair requires a cloud backup ACK, then a local archive, before restoration and ready',async()=>{
 const f=fixture();const a=f.client.repairSync();assert.equal(f.client.repairSync(),a);await a;
 assert.ok(f.calls.indexOf('/recoveries')<f.calls.indexOf('local-recovery'));assert.ok(f.calls.indexOf('local-recovery')<f.calls.indexOf('restore'));assert.ok(f.calls.indexOf('restore')<f.calls.indexOf('permit'));
 assert.equal(f.q.length,0);assert.equal(f.values.size,0);assert.ok(f.events.some(e=>e.type==='atlas:profile-ready'));assert.equal(f.client.repairFlight,undefined);
});
test('missing backup acknowledgement never removes local outbox entries or restores over them',async()=>{
 const f=fixture({ack:false});await assert.rejects(f.client.repairSync(),/not been backed up/);assert.equal(f.q.length,1);assert.equal(f.calls.includes('local-recovery'),false);assert.equal(f.calls.includes('restore'),false);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
 f.setAck(true);await f.client.repairSync();assert.equal(f.q.length,0);
});
test('interrupted restoration remains repairable even after archived outbox entries are retired',async()=>{
 const f=fixture({failRestore:true});await assert.rejects(f.client.repairSync(),/restore failed/);assert.equal(f.q.length,0);assert.ok(f.values.has('atlas.profile.repair.pending:profile'));await assert.rejects(f.client.drain(),/PROFILE_REPAIR_REQUIRED/);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
 f.setRestoreFailure(false);await f.client.repairSync();assert.equal(f.values.has('atlas.profile.repair.pending:profile'),false);assert.ok(f.events.some(e=>e.type==='atlas:profile-ready'));
});
test('repair never forces another browser out or mutates its cloud revision',async()=>{
 const f=fixture({busy:true});await assert.rejects(f.client.repairSync(),/busy/);assert.equal(f.q.length,1);assert.equal(f.calls.includes('/recoveries'),false);assert.equal(f.calls.includes('fence'),false);assert.equal(f.calls.includes('restore'),false);
});
test('the repair action is offered for native sync conflicts, not quotas, offline failures or handoffs',()=>{
 for(const code of ['PROFILE_REVISION_CONFLICT','PROFILE_RECOVERY_REQUIRED','PROFILE_RESTORE_REQUIRED','PROFILE_REPAIR_REQUIRED'])assert.equal(profileSyncRepairAvailable({state:'conflict',message:code}),true);
 for(const extra of [{canContinue:true},{handoff:{phase:'waiting',siteGroup:'example.com'}}])assert.equal(profileSyncRepairAvailable({state:'conflict',message:'PROFILE_REVISION_CONFLICT',...extra}),false);
 assert.equal(profileSyncRepairAvailable({state:'error',message:'QuotaExceededError'}),false);
});

test('backup receipt from a different recovery cannot retire local data',async()=>{
 const f=fixture();const original=f.client.request.bind(f.client);
 f.client.request=async(path,...rest)=>path==='/recoveries'?{acknowledged:true,id:'wrong-recovery'}:original(path,...rest);
 await assert.rejects(f.client.repairSync(),/not been backed up/);
 assert.equal(f.q.length,1);assert.equal(f.calls.includes('local-recovery'),false);assert.equal(f.calls.includes('restore'),false);
});
test('a failed repair fences only its own group, and unrelated saves still drain',async()=>{
 const f=fixture({ack:false});
 const other={entry:{id:'other',kind:'local',origin:'https://independent.example',payload:{value:'independent'}},key:'other'};
 f.q.push(other);
 await assert.rejects(f.client.repairSync(),/not been backed up/);
 const marked=JSON.parse(f.values.get('atlas.profile.repair.pending:profile'));
 assert.deepEqual(marked.map(n=>n.origin),['https://example.com']);
 let drained=[];f.client.drainQueue=async queue=>{drained=await queue.list();f.q.splice(f.q.indexOf(other),1)};
 await assert.rejects(f.client.drain(),/PROFILE_REPAIR_REQUIRED/);
 assert.deepEqual([...drained],[other]);assert.equal(f.q.length,1);assert.equal(f.q[0].entry.id,'change');
});
test('repair checkpoints a live website before quiescing or fencing its local saves',async()=>{
 const f=fixture();await f.client.repairSync();assert.ok(f.calls.indexOf('checkpoint')<f.calls.indexOf('fence'));
});

test('a long repair still renews unrelated websites without reviving its own fenced permit',async()=>{
 const f=fixture();const expiresAt=new Date(Date.now()+30000).toISOString();
 f.client.writers.set('example.com',{namespace:{kind:'local',origin:'https://example.com'},writer:{epoch:2,contextId:'context',siteGroup:'example.com',expiresAt}});
 f.client.writers.set('independent.example',{namespace:{kind:'local',origin:'https://independent.example'},writer:{epoch:8,contextId:'context',siteGroup:'independent.example',expiresAt}});
 f.values.set('atlas.profile.repair.pending:profile',JSON.stringify([{kind:'local',origin:'https://example.com'}]));
 f.client.repairFlight=new Promise(()=>{});f.client.ensureWakeup=()=>{};const renewed=[];
 f.client.request=async(path,method,body)=>{assert.equal(path,'/writers');assert.equal(method,'PUT');renewed.push(body.namespace.origin);return{writer:{epoch:8,contextId:'context',siteGroup:'independent.example',expiresAt}}};
 await f.client.tick();assert.deepEqual(renewed,['https://independent.example']);assert.deepEqual(f.calls,['permit']);
 await assert.rejects(f.client.takeover('https://example.com'),/Finish the current synchronization repair/);
 f.client.repairFlight=undefined;
});

function usableBeforeRepair(f) {
 const writer={epoch:2,contextId:'context',siteGroup:'example.com',expiresAt:new Date(Date.now()+90000).toISOString()};
 f.client.writers.set('example.com',{namespace:{kind:'local',origin:'https://example.com'},writer});f.client.readyGroups.set('example.com',2);
 f.client.local.resumePermit=async p=>{f.calls.push('resume-local-permit');assert.equal(p.revoked,false);return true};f.client.local.revokePermit=async()=>{f.calls.push('conditional-fence');return true};
}
for(const failure of ['quota','network','rejected acknowledgement'])test(`failed ${failure} backup resumes an already usable local site only after authoritative same-epoch renewal`,async()=>{
 const f=fixture({ack:false});usableBeforeRepair(f);const original=f.client.request.bind(f.client);
 f.client.request=async(path,...args)=>{if(path==='/recoveries'&&failure!=='rejected acknowledgement')throw Object.assign(Error(failure+' backup failed'),failure==='quota'?{status:413,code:'HUB_PROFILE_QUOTA'}:{name:'TypeError'});return original(path,...args)};
 await assert.rejects(f.client.repairSync());assert.equal(f.q.length,1);assert.equal(f.calls.includes('restore'),false);assert.equal(f.calls.includes('local-recovery'),false);
 assert.equal(f.calls.includes('resume-local-permit'),true);assert.ok(f.values.has('atlas.profile.repair.pending:profile'));
 assert.ok(f.events.some(e=>e.type==='atlas:profile-ready'&&e.detail.localOnly===true));await f.client.ensureOrigin('https://example.com');
 assert.equal(f.events.at(-1).detail.state,'error');assert.match(f.events.at(-1).detail.message,/sync paused/);await assert.rejects(f.client.drain(),/PROFILE_REPAIR_REQUIRED/);
});
test('an unrestored local replica never becomes available merely because its backup failed',async()=>{
 const f=fixture({ack:false});f.client.local.resumePermit=async()=>{throw Error('Must not resume an unknown local replica')};await assert.rejects(f.client.repairSync());await assert.rejects(f.client.ensureOrigin('https://example.com'),/Repair synchronization/);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
});
test('a repair that began native restoration cannot resume the old replica after a publication failure',async()=>{
 const f=fixture({failRestore:true});usableBeforeRepair(f);await assert.rejects(f.client.repairSync(),/restore failed/);assert.equal(f.calls.includes('resume-local-permit'),false);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
});
test('a changed writer epoch cannot grant a local-only resume permit after backup failure',async()=>{
 const f=fixture({ack:false});usableBeforeRepair(f);const original=f.client.request.bind(f.client);
 f.client.request=async(path,method,...args)=>{const value=await original(path,method,...args);return path==='/writers'&&method==='PUT'?{writer:{...value.writer,epoch:3}}:value};
 await assert.rejects(f.client.repairSync());assert.equal(f.calls.includes('resume-local-permit'),false);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
});
test('an account stop cannot resume its formerly usable replica after backup failure',async()=>{
 const f=fixture({ack:false});usableBeforeRepair(f);const original=f.client.request.bind(f.client);
 f.client.request=async(path,...args)=>{const value=await original(path,...args);if(path==='/recoveries')f.client.stopped=true;return value};
 await assert.rejects(f.client.repairSync());assert.equal(f.calls.includes('resume-local-permit'),false);assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);
});
test('a newer native permit or a late release fence prevents unsafe local-only resume',async()=>{
 for(const late of [false,true]){const f=fixture({ack:false});usableBeforeRepair(f);f.client.local.resumePermit=async()=>{f.calls.push('resume-attempt');if(late)f.client.replacementFences.add('example.com');return late};await assert.rejects(f.client.repairSync());assert.equal(f.events.some(e=>e.type==='atlas:profile-ready'),false);if(late)assert.equal(f.calls.at(-1),'conditional-fence')}
});
