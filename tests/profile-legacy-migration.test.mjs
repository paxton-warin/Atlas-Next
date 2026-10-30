import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { legacyWebsiteOriginHints, migrateLegacyOrigin } = await import(process.env.ATLAS_LEGACY_MIGRATION_SOURCE || new URL('../web/src/profile-legacy-migration.ts', import.meta.url));
import { readLegacyHostStorage } from '../runtime/profile-store.ts';
import { hubNamespace } from '../runtime/hub-contracts.ts';

const clone = v => structuredClone(v);
const hash = async value => createHash('sha256').update(value).digest('hex');
const local = (origin='https://game.example') => ({namespace:{kind:'local',origin},payload:{format:'atlas-local-snapshot-v1',revision:0,entries:[['save','old-progress']]}});
const idb = () => ({namespace:{kind:'idb',origin:'https://game.example',name:'save-db'},payload:{format:'atlas-idb-snapshot-v1',version:3,stores:[]}});
function fixture(options={}) {
 const rows=new Map(), calls=[], recoveries=new Map(), receipts=new Map(), streams=new Map(), snapshots=[local(),idb()]; let manifests=0,commitCount=0,reads=0,recoveryCount=0,changed=false;
 for(const n of options.existing||[])streams.set(hubNamespace(n).key,{namespace:JSON.parse(hubNamespace(n).key),revision:1});
 const o={ownsLegacy:true,profileId:'profile-A',sourceOrigin:'https://old-a.example',storage:{getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v)},check(){if(changed)throw Error('PROFILE_CONTEXT_CHANGED');},blockedGroups:new Set(),
  entries:async()=>{reads++;return clone(snapshots)},wire:async v=>clone(v),hash,
  recover:async value=>{calls.push({op:'backup',...clone(value)});recoveryCount++; if(options.backupFailure===recoveryCount)throw Error('network failed');if(options.falseBackup)return{acknowledged:false};const prior=recoveries.get(value.id);if(prior)assert.deepEqual(prior,value);recoveries.set(value.id,clone(value));if(options.lostBackupAck&&recoveryCount===1)throw Error('ACK lost');if(options.contextChangeAfterBackup)changed=true;return{acknowledged:true};},
  manifest:async()=>{manifests++;calls.push({op:'manifest'});if(options.occupyOnSecondManifest&&manifests===2)streams.set(hubNamespace(local().namespace).key,{namespace:['local','https://game.example',''],revision:2});return{streams:[...streams.values()]};},
  acquire:async n=>{calls.push({op:'acquire',namespace:clone(n)});if(options.busy)throw Object.assign(Error('busy'),{code:'HUB_WRITER_BUSY'});return{epoch:7};},
  commit:async value=>{calls.push({op:'commit',...clone(value)});commitCount++;if(options.commitFailure===commitCount)throw Error('commit network failed');assert.equal(value.baseRevision,0);assert.equal(value.epoch,7);assert.equal(value.mode,'snapshot');const n=hubNamespace(value.namespace);assert.equal(streams.has(n.key),false,'CAS0 cannot overwrite any stream');streams.set(n.key,{namespace:JSON.parse(n.key),revision:1});receipts.set(value.idempotencyKey,{acknowledged:true,namespace:JSON.parse(n.key),revision:1,mode:value.mode,payloadHash:await hash(JSON.stringify([n.key,value.mode,value.baseRevision,await hash(JSON.stringify(value.payload))]))});if(options.lostCommitAck===commitCount)throw Error('commit ACK lost');return{acknowledged:!options.falseCommit,revision:1};},
  release:async(namespace,epoch)=>{calls.push({op:'release',namespace:clone(namespace),epoch});return{ok:!options.falseRelease};},
 };
 if(options.withReceipts)o.receipt=async id=>{calls.push({op:'receipt',id});if(options.receiptError)throw Object.assign(Error('receipt temporarily unavailable'),{status:503});if(!receipts.has(id))throw Object.assign(Error('no receipt'),{status:404,code:'HUB_NOT_FOUND'});return clone(receipts.get(id));};
 return{o,rows,calls,recoveries,receipts,streams,snapshots,get reads(){return reads},run:()=>migrateLegacyOrigin(o)};
}
test('a later account cannot inspect or migrate legacy browser data',async()=>{const f=fixture();f.o.ownsLegacy=false;assert.equal((await f.run()).backedUp,0);assert.equal(f.reads,0);assert.equal(f.calls.length,0);});
test('every recognized namespace is durably recovered before any absent group is published',async()=>{const f=fixture();const r=await f.run();assert.equal(r.backedUp,2);assert.equal(r.newBackups,2);assert.deepEqual(r.adoptedGroups,['game.example']);assert.deepEqual(f.calls.filter(c=>['backup','acquire','commit','release'].includes(c.op)).map(c=>c.op),['backup','backup','acquire','commit','commit','release']);assert.equal(f.recoveries.size,2);assert.equal(f.streams.size,2);assert.ok(f.calls.filter(c=>c.op==='commit').every(c=>c.idempotencyKey.length<=96));});
test('an existing website group is not merged even if another namespace is absent',async()=>{const f=fixture({existing:[local().namespace]});const r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.equal(f.recoveries.size,2);assert.equal(f.streams.size,1);assert.equal(f.calls.some(c=>c.op==='acquire'||c.op==='commit'),false);});
test('allowlisted Atlas data is recovered but never silently changes existing preferences',async()=>{const f=fixture();f.snapshots.splice(0,2,{namespace:{kind:'atlas'},payload:{format:'atlas-user-snapshot-v1',values:{'atlas.theme':'forest'}}});const r=await f.run();assert.equal(r.backedUp,1);assert.equal(f.calls.some(c=>c.op==='acquire'||c.op==='commit'),false);});
test('recovery replay is stable after an actual lost acknowledgement and sets no false marker',async()=>{const f=fixture({lostBackupAck:true});await assert.rejects(f.run(),/ACK lost/);assert.equal(f.rows.size,0);const first=f.calls.find(c=>c.op==='backup').id;await f.run();const ids=f.calls.filter(c=>c.op==='backup').map(c=>c.id);assert.equal(ids[0],ids[1]);assert.equal(ids[1],first);assert.equal(f.recoveries.size,2);assert.equal(f.rows.size,3);});
test('a false recovery ACK neither creates a marker nor starts publication',async()=>{const f=fixture({falseBackup:true});await assert.rejects(f.run(),/not been acknowledged/);assert.equal(f.rows.size,0);assert.equal(f.calls.some(c=>c.op==='acquire'),false);});
test('one missing recovery blocks the whole publication, preserving already acknowledged backups',async()=>{const f=fixture({backupFailure:2});await assert.rejects(f.run(),/network failed/);assert.equal(f.recoveries.size,1);assert.equal(f.calls.some(c=>c.op==='acquire'),false);assert.equal(f.rows.size,1);});
test('source origins and accounts have distinct deterministic recovery IDs',async()=>{const a=fixture(),b=fixture(),c=fixture();b.o.sourceOrigin='https://old-b.example';c.o.profileId='profile-B';await Promise.all([a.run(),b.run(),c.run()]);assert.equal(new Set([a,b,c].map(f=>f.calls.find(c=>c.op==='backup').id)).size,3);});
test('fresh absence is rechecked after exclusive acquisition, without overwriting a racing stream',async()=>{const f=fixture({occupyOnSecondManifest:true});const r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.equal(f.calls.some(c=>c.op==='commit'),false);assert.equal(f.calls.at(-1).op,'release');});
test('a peer writer is never taken over simply to import old data',async()=>{const f=fixture({busy:true});const r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.equal(f.calls.some(c=>c.op==='commit'||c.op==='release'),false);});
test('a durable active-profile outbox prevents legacy adoption into an otherwise absent group',async()=>{const f=fixture();f.o.blockedGroups.add('game.example');const r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.equal(f.calls.some(c=>c.op==='acquire'),false);});
test('partial publication retains FULL backups and retries without overwriting or claiming a complete group',async()=>{const f=fixture({commitFailure:2});await assert.rejects(f.run(),/commit network failed/);assert.equal(f.recoveries.size,2);assert.equal(f.streams.size,1);assert.equal(f.calls.at(-1).op,'release');const n=f.calls.filter(c=>c.op==='commit').length;const r=await f.run();assert.deepEqual(r.partialGroups,['game.example']);assert.deepEqual(r.adoptedGroups,[]);assert.equal(r.newBackups,0);assert.equal(f.calls.filter(c=>c.op==='commit').length,n);assert.equal(f.streams.size,1);});
test('a false canonical ACK or release does not report successful completed migration',async()=>{for(const options of[{falseCommit:true},{falseRelease:true}]){const f=fixture(options);await assert.rejects(f.run(),/not been acknowledged|still finishing/);assert.equal(f.recoveries.size,2);assert.equal(f.calls.at(-1).op,'release');}});
test('account changes discard even a positive old-account response before writing a local marker',async()=>{const f=fixture({contextChangeAfterBackup:true});await assert.rejects(f.run(),/PROFILE_CONTEXT_CHANGED/);assert.equal(f.rows.size,0);assert.equal(f.calls.some(c=>c.op==='acquire'),false);});
test('revisiting acknowledged identical snapshots reuses backups without duplicates',async()=>{const f=fixture();await f.run();const r=await f.run();assert.equal(r.newBackups,0);assert.equal(f.recoveries.size,2);assert.equal(f.calls.filter(c=>c.op==='backup').length,2);});
test('malformed source origin cannot start an import',async()=>{const f=fixture();f.o.sourceOrigin='https://old-a.example/path';await assert.rejects(f.run(),/Invalid legacy browser address/);assert.equal(f.reads,0);});
test('exact-origin evidence uses only recognized browsing metadata schemas, without scraping arbitrary values',()=>{
 const hints=legacyWebsiteOriginHints({'atlas.history':JSON.stringify([{url:'https://orteil.dashnet.org/cookieclicker/',title:'Cookie Clicker',time:1},{url:'http://both.example/a'},{url:'javascript:alert(1)'},{url:'https://name:password@secret.example/'}]),'atlas.tabs':JSON.stringify([{url:'https://both.example/b'}]),'atlas.windows.v1.one':JSON.stringify({tabs:[{url:'https://window.example'}]}),'atlas.shortcuts':'malformed','atlas.admin.secret':JSON.stringify([{url:'https://must-not-read.example'}])});
 assert.deepEqual(hints,['https://orteil.dashnet.org','http://both.example','https://both.example','https://window.example']);
});
test('normal Scramjet HOST@key resolves only unambiguous origin evidence; ambiguous/raw saves are preserved without guessing',()=>{
 const values=new Map([['orteil.dashnet.org@CookieClickerGame','native cookie save'],['both.example@save','ambiguous'],['unknown.example@save','unknown'],['https://exact.example@save','explicit'],['atlas.admin.secret','private'],['frontend.example@credential','native own credential'],['arbitrary@field','unknown frontend field']]);
 const storage={get length(){return values.size},key:i=>[...values.keys()][i]||null,getItem:k=>values.get(k)??null};
 const result=readLegacyHostStorage(storage,['https://orteil.dashnet.org','http://both.example','https://both.example','not an origin'],'frontend.example');
 assert.deepEqual(result,[{host:'orteil.dashnet.org',entries:[['CookieClickerGame','native cookie save']],candidateOrigins:['https://orteil.dashnet.org']},{host:'both.example',entries:[['save','ambiguous']],candidateOrigins:['http://both.example','https://both.example']},{host:'unknown.example',entries:[['save','unknown']],candidateOrigins:[]}]);
 assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('credential'),false);
});

test('an interrupted multi-stream import resumes only its receipt-proven revision-one writes',async()=>{
 const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run(),/commit network failed/);
 assert.equal(f.streams.size,1);const first=f.calls.find(c=>c.op==='commit');
 const r=await f.run();assert.deepEqual(r.adoptedGroups,['game.example']);assert.deepEqual(r.partialGroups,[]);assert.equal(r.newBackups,0);assert.equal(f.streams.size,2);
 assert.equal(f.calls.filter(c=>c.op==='commit'&&hubNamespace(c.namespace).key===hubNamespace(first.namespace).key).length,1,'acknowledged first stream is not republished');
 assert.equal(f.calls.filter(c=>c.op==='backup').length,2,'resuming does not duplicate complete backups');
 assert.equal(f.calls.at(-1).op,'release');
});
test('a lost final commit acknowledgement resumes from immutable receipts without duplicate publication',async()=>{
 const f=fixture({lostCommitAck:2,withReceipts:true});await assert.rejects(f.run(),/commit ACK lost/);assert.equal(f.streams.size,2);
 const r=await f.run();assert.deepEqual(r.adoptedGroups,['game.example']);assert.equal(f.calls.filter(c=>c.op==='commit').length,2);assert.equal(r.newBackups,0);
});
test('a newer cloud revision after partial import preserves the conflict and never fills in stale missing streams',async()=>{
 const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run());f.streams.get(hubNamespace(local().namespace).key).revision=2;
 const commits=f.calls.filter(c=>c.op==='commit').length,r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.deepEqual(r.partialGroups,['game.example']);assert.equal(f.calls.filter(c=>c.op==='commit').length,commits);assert.equal(f.streams.size,1);
});
test('a foreign stream within the cookie-sharing group prevents partial resume even with valid own receipts',async()=>{
 const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run());const n={kind:'local',origin:'https://sub.game.example'};f.streams.set(hubNamespace(n).key,{namespace:JSON.parse(hubNamespace(n).key),revision:1});
 const commits=f.calls.filter(c=>c.op==='commit').length,r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.deepEqual(r.partialGroups,['game.example']);assert.equal(f.calls.filter(c=>c.op==='commit').length,commits);
});
test('changed old-origin saves after partial publication become a new backup rather than altering canonical state',async()=>{
 const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run());f.snapshots[0].payload.entries[0][1]='later-old-origin-save';
 const r=await f.run();assert.deepEqual(r.adoptedGroups,[]);assert.deepEqual(r.partialGroups,['game.example']);assert.equal(r.newBackups,1);assert.equal(f.recoveries.size,3);assert.equal(f.streams.size,1);
});
test('malformed, missing, wrong-hash, wrong-namespace and unacknowledged receipts never authorize partial resume',async()=>{
 for(const kind of['missing','hash','namespace','mode','revision','ack']){
  const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run());const [key,receipt]=[...f.receipts][0];
  if(kind==='missing')f.receipts.delete(key);if(kind==='hash')receipt.payloadHash='0'.repeat(64);if(kind==='namespace')receipt.namespace=['local','https://other.example',''];if(kind==='mode')receipt.mode='journal';if(kind==='revision')receipt.revision=2;if(kind==='ack')receipt.acknowledged=false;
  const n=f.calls.filter(c=>c.op==='commit').length,r=await f.run();assert.deepEqual(r.adoptedGroups,[],kind);assert.deepEqual(r.partialGroups,['game.example'],kind);assert.equal(f.calls.filter(c=>c.op==='commit').length,n,kind);
 }
});
test('a temporary receipt failure reports retry rather than conflict or success and retains all old bytes',async()=>{
 const options={commitFailure:2,withReceipts:true},f=fixture(options);await assert.rejects(f.run());options.receiptError=true;
 await assert.rejects(f.run(),/temporarily unavailable/);assert.equal(f.streams.size,1);assert.equal(f.recoveries.size,2);assert.equal(f.snapshots[0].payload.entries[0][1],'old-progress');
});
test('forged local progress without immutable receipts cannot resume over a foreign revision-one stream',async()=>{
 const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run());f.receipts.clear();
 const r=await f.run();assert.deepEqual(r.preservedGroups,['game.example']);assert.equal(f.streams.size,1);assert.equal(f.calls.filter(c=>c.op==='commit').length,2);
});
test('partial resume rechecks the entire group after acquiring its writer and releases on a racing foreign write',async()=>{
 const f=fixture({commitFailure:2,withReceipts:true});await assert.rejects(f.run());const oldManifest=f.o.manifest;let n=0;
 f.o.manifest=async()=>{const result=await oldManifest();if(++n===2){const foreign={namespace:['local','https://sub.game.example',''],revision:1};f.streams.set(JSON.stringify(foreign.namespace),foreign);result.streams.push(foreign);}return result;};
 const r=await f.run();assert.deepEqual(r.adoptedGroups,[]);assert.deepEqual(r.partialGroups,['game.example']);assert.equal(f.calls.at(-1).op,'release');assert.equal(f.calls.filter(c=>c.op==='commit').length,2);
});
test('both old origins share a canonical profile: first exact save wins and second divergent save stays independently recovered',async()=>{
 const a=fixture({withReceipts:true}),b=fixture({withReceipts:true});b.o.sourceOrigin='https://old-b.example';b.snapshots[0].payload.entries[0][1]='old-b-progress';
 await a.run();b.o.manifest=async()=>({streams:[...a.streams.values()]});const r=await b.run();
 assert.deepEqual(r.preservedGroups,['game.example']);assert.equal(b.calls.some(c=>c.op==='commit'||c.op==='acquire'),false);
 assert.equal(a.recoveries.size,2);assert.equal(b.recoveries.size,2);assert.equal(new Set([...a.recoveries.keys(),...b.recoveries.keys()]).size,4);
 assert.equal([...a.recoveries.values()].find(c=>c.namespace.kind==='local').payload.snapshot.entries[0][1],'old-progress');assert.equal([...b.recoveries.values()].find(c=>c.namespace.kind==='local').payload.snapshot.entries[0][1],'old-b-progress');
});
