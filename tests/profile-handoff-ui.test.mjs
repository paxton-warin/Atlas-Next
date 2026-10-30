import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {profileHandoffForWebsite, profileStatusForWebsite, profileHandoffTabLabel} from '../web/src/profile-handoff-view.ts';
import {profileStatusLabel} from '../web/src/profile-status-view.ts';

const status = (phase, extra = {}) => ({
  state: ['waiting','releasing'].includes(phase) ? 'pending' : 'conflict',
  message: 'Authoritative profile state',
  handoff: {phase, siteGroup:'dashnet.org', origin:'https://orteil.dashnet.org'},
  ...extra,
});

test('handoff states replace ownership errors only in the affected website group', () => {
  for (const phase of ['offered','waiting','releasing','paused']) {
    const view = profileHandoffForWebsite(status(phase), 'https://orteil.dashnet.org/cookieclicker/');
    assert.equal(view.kind, phase);
    assert.equal(view.canContinue, ['offered','paused'].includes(phase));
    assert.equal(view.busy, ['waiting','releasing'].includes(phase));
    assert.equal(profileHandoffForWebsite(status(phase), 'https://assets.dashnet.org/').kind, phase);
    assert.equal(profileHandoffForWebsite(status(phase), 'https://other.test/'), null);
    assert.equal(profileHandoffForWebsite(status(phase), 'about:blank'), null);
    assert.equal(profileHandoffForWebsite(status(phase), 'not an address'), null);
  }
});

test('waiting and continued-elsewhere copy never pretend a website or upload failed', () => {
  const waiting = profileHandoffForWebsite(status('waiting'), 'https://orteil.dashnet.org/cookieclicker/');
  assert.equal(waiting.title, 'Finishing your saves…');
  assert.doesNotMatch(waiting.message, /synced|progress|failed|try again/i);
  const paused = profileHandoffForWebsite(status('paused'), 'https://orteil.dashnet.org/cookieclicker/');
  assert.equal(paused.title, 'Open in your other browser');
  assert.equal(paused.canContinue, true);
  assert.equal(paused.busy, false);
});

test('ordinary errors, pending changes and partial backups never gain a handoff action or a synced label', () => {
  for (const state of ['pending','error','offline','synced','local','restoring','conflict'])
    assert.equal(profileHandoffForWebsite({state,message:'Normal state'}, 'https://orteil.dashnet.org/cookieclicker/'), null);
  assert.equal(profileStatusLabel({state:'pending',message:'Saving…'}), 'Sync pending');
  assert.equal(profileStatusLabel({state:'local',message:'Portable saves are backed up. Some data remains locally.'}), 'Partial backup');
  assert.equal(profileStatusLabel(status('waiting')), 'Finishing saves…');
  assert.equal(profileStatusLabel(status('paused')), 'Open elsewhere');
  assert.equal(profileStatusLabel(status('offered')), 'Continue here');
});

test('a failed handoff keeps its real failure detail beside the retryable choice', () => {
  const failure = 'Your other browser has not finished saving. Retry when it is online.';
  const view = profileHandoffForWebsite(status('offered', {message:failure}), 'https://orteil.dashnet.org/');
  assert.equal(view.message, failure);
  assert.equal(view.canContinue, true);
});

test('background upload acknowledgements do not replace the ownership explanation', () => {
  for (const [state,message] of [['synced','Synced'],['pending','Saved locally · sync pending'],['local','Saved locally']]) {
    const view = profileHandoffForWebsite(status('offered', {state,message}), 'https://orteil.dashnet.org/');
    assert.equal(view.title, 'Continue this website here?');
    assert.equal(view.message, 'This website is open in another browser. Its latest saves will finish before it opens here.');
  }
});

test('a paused website offers an explicit reverse handoff without automatically taking ownership', async () => {
  const view = profileHandoffForWebsite(status('paused'), 'https://orteil.dashnet.org/cookieclicker/');
  assert.equal(view.canContinue, true);
  assert.equal(view.busy, false);
  assert.match(view.message, /Continue here to bring it back/);
  const app = await readFile(new URL('../web/src/App.tsx',import.meta.url),'utf8');
  assert.match(app, /profileHandoff\.canContinue[\s\S]*?onClick=\{\(\) => \{[\s\S]*?atlas:profile-continue/);
  assert.doesNotMatch(app, /useEffect\([^)]*(?:takeover|profile-continue)/);
});

test('source flushing is visible before release and a real failure stops the spinner', () => {
  const moving = profileHandoffForWebsite(status('releasing'), 'https://orteil.dashnet.org/');
  assert.equal(moving.title, 'Finishing your saves…');
  assert.match(moving.message, /moving to your other browser/);
  assert.equal(moving.busy, true);
  assert.equal(moving.canRetry, false);
  for (const state of ['error','offline','conflict']) {
    const failed = profileHandoffForWebsite(status('releasing', {state,message:'Unrelated upload state',handoff:{phase:'releasing',siteGroup:'dashnet.org',error:'Network unavailable'}}), 'https://orteil.dashnet.org/');
    assert.equal(failed.title, 'Your saves need attention');
    assert.equal(failed.message, 'Network unavailable');
    assert.equal(failed.busy, false);
    assert.equal(failed.canRetry, true);
    assert.equal(failed.canContinue, false);
  }
});

test('legacy busy signals require an exact valid affected origin and remain an explicit choice', () => {
  const busy = {state:'conflict', message:'Busy', canContinue:true, origin:'https://orteil.dashnet.org'};
  assert.equal(profileHandoffForWebsite(busy, 'https://orteil.dashnet.org/cookieclicker/').kind, 'offered');
  assert.equal(profileHandoffForWebsite({...busy,origin:'invalid'}, 'https://orteil.dashnet.org/'), null);
  assert.equal(profileHandoffForWebsite({...busy,canContinue:false}, 'https://orteil.dashnet.org/'), null);
  assert.equal(profileHandoffForWebsite(busy, 'https://other.test/'), null);
});

test('unrelated embedded ownership labels do not replace the truthful global backup state', () => {
  for (const phase of ['offered','waiting','releasing','paused']) {
    const own = status(phase);
    const same = profileStatusForWebsite(own, 'https://orteil.dashnet.org/cookieclicker/');
    assert.equal(same, own);
    for (const state of ['pending','synced','offline','error']) {
      const unrelated = status(phase, {state, message:state});
      const contextual = profileStatusForWebsite(unrelated, 'https://unrelated.test/');
      assert.equal(contextual.state, state);
      assert.equal(contextual.message, state);
      assert.equal(contextual.handoff, undefined);
      assert.equal(profileStatusLabel(contextual), profileStatusLabel({state,message:state}));
      assert.equal(unrelated.handoff.phase, phase);
    }
  }
});

test('ownership badges leave operational tab identity and error state untouched', async () => {
  const tab = {id:'retained-tab', url:'https://orteil.dashnet.org/cookieclicker/', status:'error'};
  const before = {...tab};
  for (const [phase,label] of [['offered','Continue'],['waiting','Saving'],['releasing','Saving'],['paused','Paused']]) {
    const view = profileHandoffForWebsite(status(phase), tab.url);
    assert.equal(profileHandoffTabLabel(view), label);
    assert.deepEqual(tab, before);
  }
  assert.equal(profileHandoffTabLabel(profileHandoffForWebsite(status('releasing',{state:'error',message:'Try again',handoff:{phase:'releasing',siteGroup:'dashnet.org',error:'Try again'}}),tab.url)), 'Retry');
  const strip = await readFile(new URL('../web/src/TabStrip.tsx',import.meta.url),'utf8');
  assert.match(strip, /handoffs\?: Record<string, ProfileHandoffView \| null>/);
  assert.match(strip, /props\.onActivate\(t\)/);
  assert.match(strip, /handoffFor\(t\) \? \([\s\S]*?tab-handoff-status/);
  assert.doesNotMatch(strip, /t\.status\s*=(?!=)|t\.id\s*=(?!=)|window\.addEventListener\("atlas:profile-status"/);
});

test('the live shell centralizes ownership actions while preserving ordinary reconnect and retry paths', async () => {
  const app = await readFile(new URL('../web/src/App.tsx',import.meta.url),'utf8');
  const profile = await readFile(new URL('../web/src/ProfileStatus.tsx',import.meta.url),'utf8');
  assert.match(app, /<ProfileStatus website=\{showingSite && !current\?\.local \? current\?\.url : undefined\}/);
  assert.match(app, /profile-handoff[\s\S]*?aria-busy=\{profileHandoff\.busy\}/);
  assert.match(app, /profileHandoff\.canContinue[\s\S]*?atlas:profile-continue/);
  assert.match(app, /!profileHandoff &&[\s\S]*?className="runtime-error"/);
  assert.match(app, /connectionExpired \|\| config\?\.connectionError[\s\S]*?requestReconnect\(\)/);
  assert.match(app, /runtimeError[\s\S]*?restartRuntime\(\)/);
  assert.match(app, /navigate\(current\.url, false, current\.engine\)/);
  assert.doesNotMatch(profile, /className="profile-alert"|Continue here/);
  assert.match(profile, /profileStatusLabel\(profileStatusForWebsite\(s, website\)\)/);
  assert.match(app, /addEventListener\("atlas:profile-status", updateProfileStatus\);\s*setProfileStatus\(getProfileStatus\(\)\)/);
  assert.match(profile, /addEventListener\("atlas:hub-session", session\);\s*set\(getProfileStatus\(\)\)/);
  assert.doesNotMatch(app, /setInterval\([^)]*(?:takeover|profile-continue)/);
});


test('unrelated preferences failure cannot turn a healthy group handoff into a false failure',()=>{
 const own=status('releasing',{state:'error',message:'Unrelated settings conflict'});
 const view=profileHandoffForWebsite(own,'https://orteil.dashnet.org/');
 assert.equal(view.busy,true);assert.equal(view.canRetry,false);assert.equal(view.title,'Finishing your saves…');
 assert.doesNotMatch(view.message,/conflict|failed|attention/i);assert.equal(profileStatusLabel(own),'Finishing saves…');
 const retry={...own,handoff:{...own.handoff,error:'Actual save ACK failed'}};
 assert.equal(profileHandoffForWebsite(retry,'https://orteil.dashnet.org/').canRetry,true);
 assert.equal(profileHandoffForWebsite({...retry,state:'synced',message:'Unrelated successful upload'},'https://orteil.dashnet.org/').message,'Actual save ACK failed');
});

test('last saved version is available only for a waiting handoff with an explicit scoped server offer', () => {
  const url = 'https://orteil.dashnet.org/cookieclicker/';
  const waiting = status('waiting', {handoff:{phase:'waiting',siteGroup:'dashnet.org',origin:'https://orteil.dashnet.org',canUseBackup:true}});
  assert.equal(profileHandoffForWebsite(waiting,url).canUseBackup,true);
  for (const flag of [undefined,false,1,'true'])
    assert.equal(profileHandoffForWebsite({...waiting,handoff:{...waiting.handoff,canUseBackup:flag}},url).canUseBackup,false);
  for (const phase of ['offered','releasing','paused'])
    assert.equal(profileHandoffForWebsite({...waiting,handoff:{...waiting.handoff,phase}},url).canUseBackup,false);
  assert.equal(profileHandoffForWebsite(waiting,'https://unrelated.test/'),null);
  assert.equal(profileHandoffForWebsite(waiting,'about:blank'),null);
});

test('confirmed saved-version processing never offers another request or implies that new changes uploaded', () => {
  const waiting = status('waiting', {state:'synced',message:'Unrelated upload acknowledged',handoff:{phase:'waiting',siteGroup:'dashnet.org',canUseBackup:true,backupPending:true}});
  const view = profileHandoffForWebsite(waiting,'https://orteil.dashnet.org/');
  assert.equal(view.canUseBackup,false);assert.equal(view.backupPending,true);assert.equal(view.busy,true);
  assert.equal(view.canContinue,false);assert.equal(view.canRetry,false);
  assert.equal(view.title,'Opening saved version…');
  assert.doesNotMatch(view.message,/all|latest saves.*finish|synced|complete/i);
  assert.equal(profileHandoffTabLabel(view),'Opening');
  assert.equal(profileStatusLabel(waiting),'Opening saved version…');
});

test('a real saved-version failure stops waiting progress and retains its exact detail beside an explicit retry choice', () => {
  const failure='The saved version is temporarily unavailable. Your other browser is still saving.';
  const waiting=status('waiting',{state:'error',message:'Global unrelated failure',handoff:{phase:'waiting',siteGroup:'dashnet.org',canUseBackup:true,backupPending:false,error:failure}});
  const view=profileHandoffForWebsite(waiting,'https://orteil.dashnet.org/');
  assert.equal(view.title,'Saved version could not open');assert.equal(view.message,failure);
  assert.equal(view.busy,false);assert.equal(view.canUseBackup,true);assert.equal(view.canRetry,false);
  assert.equal(profileHandoffTabLabel(view),'Retry');assert.equal(profileStatusLabel(waiting),'Save issue');
  const withoutOffer={...waiting,handoff:{...waiting.handoff,canUseBackup:false}};
  assert.equal(profileHandoffForWebsite(withoutOffer,'https://orteil.dashnet.org/').canUseBackup,false);
});

test('the confirmation remains a scoped explicit action with no clearing, automatic takeover, or simulated success', async () => {
  const app=await readFile(new URL('../web/src/App.tsx',import.meta.url),'utf8');
  const component=await readFile(new URL('../web/src/ProfileBackupChoice.tsx',import.meta.url),'utf8');
  assert.match(app, /profileHandoff\.kind === "waiting"[\s\S]*?<ProfileBackupChoice/);
  assert.match(app, /origin=\{new URL\(current!\.url\)\.origin\}/);
  assert.match(app, /confirm=\{\(origin\) => \{[\s\S]*?atlas:profile-use-backup[\s\S]*?detail: \{ origin \}/);
  for(const copy of ['Use last saved version','Open last saved version','Keep waiting','Only data already uploaded to your account can be restored.','If there is no saved data, this website starts fresh.','Changes that haven’t uploaded won’t appear here.','Unsaved progress may be lost.','stops syncing this website','saves already stored there remain for recovery'])
    assert.ok(component.includes(copy),copy);
  assert.match(component,/if \(!available \|\| flight\.current\) return/);
  assert.match(component,/panel\.showModal\(\)/);assert.match(component,/onCancel=/);assert.match(component,/cancel\.current\?\.focus\(\)/);
  assert.doesNotMatch(component,/localStorage\.clear|indexedDB\.deleteDatabase|atlas:profile-continue|setInterval|setTimeout|fetch\(/);
});
