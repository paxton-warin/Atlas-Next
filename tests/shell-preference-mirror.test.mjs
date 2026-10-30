import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readLocal, writeLocal, profileLocalKey, seedPortableAtlasPreferences } from '../web/src/model.ts';
import { setActiveProfile, setActiveLocalAuthority } from '../runtime/profile-context.ts';

const authority = { version: 2, profileId: '11111111-1111-4111-8111-111111111111',
  replicaId: '22222222-2222-4222-8222-222222222222', localAuthGeneration: 'synthetic_generation_123',
  browserSessionId: 'synthetic_session_123' };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
function storage() {
  const values = new Map(); let reads = 0;
  return { values, get reads() { return reads; }, get length() { return values.size; },
    key(index) { reads++; return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } };
}
function setup() {
  const local = storage(), events = new EventTarget();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  setActiveProfile(authority.profileId); setActiveLocalAuthority(authority);
  return { local, events };
}
function scheduler() {
  const work = [];
  return { work, schedule(run) { const item = { run, cancelled: false }; work.push(item); return () => { item.cancelled = true; }; },
    tick() { const next = work.shift(); if (next && !next.cancelled) next.run(); },
    drain() { let limit = 100; while (work.length && limit--) this.tick(); assert.ok(limit > 0, 'bounded scan converges'); } };
}
afterEach(() => {
  setActiveLocalAuthority(null); setActiveProfile(null);
  for (const [key, descriptor] of [['localStorage', originalStorage], ['window', originalWindow]])
    descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
});
test('portable reads are pure, retain parsing/fallback semantics and never emit change hints', async () => {
  const { local, events } = setup(); let changes = 0;
  events.addEventListener('atlas:profile-user-change', () => changes++);
  local.setItem(profileLocalKey('atlas.history'), '[{"title":"saved"}]');
  for (let i = 0; i < 40; i++) assert.deepEqual(readLocal('atlas.history', []), [{ title: 'saved' }]);
  local.setItem(profileLocalKey('atlas.settings'), '{broken');
  assert.deepEqual(readLocal('atlas.settings', { fallback: true }), { fallback: true });
  await Promise.resolve(); assert.equal(changes, 0);
});
test('writes dispatch once only after persistence and preserve unchanged-write deduplication', () => {
  const { local, events } = setup(); let changes = 0;
  events.addEventListener('atlas:profile-user-change', event => {
    changes++; assert.equal(local.getItem(profileLocalKey(event.detail.key)), event.detail.value);
  });
  assert.equal(writeLocal('atlas.onboarded', true), true);
  assert.equal(writeLocal('atlas.onboarded', true), true);
  assert.equal(changes, 1); assert.equal(readLocal('atlas.onboarded', false), true);
});
test('explicit seeding starts asynchronously, caps enumeration slices and reads only this replica', () => {
  const { local } = setup(), clock = scheduler(), entries = []; let completed = false;
  for (let i = 0; i < 48; i++) local.setItem(profileLocalKey(`atlas.windows.v1.${String(i).padStart(36, '0')}`), JSON.stringify({ i }));
  local.setItem(`atlas.profile.user:${authority.profileId}:atlas.settings`, '"legacy"');
  local.setItem(`atlas.profile.user:${authority.profileId}:replica:33333333-3333-4333-8333-333333333333:atlas.settings`, '"other replica"');
  local.setItem(profileLocalKey('not-portable'), '"unrelated"');
  seedPortableAtlasPreferences(authority, (key, value) => entries.push([key, value]),
    { storage: local, schedule: clock.schedule, now: () => 0, complete: () => { completed = true; } });
  assert.equal(entries.length, 0); assert.equal(local.reads, 0);
  clock.tick(); assert.equal(local.reads, 16); assert.equal(entries.length, 16); assert.equal(completed, false);
  clock.drain(); assert.equal(entries.length, 48); assert.equal(completed, true);
  assert.ok(entries.every(([key]) => key.startsWith('atlas.windows.v1.')));
});
test('seed values are current at visit time and oversized values are not truncated', () => {
  const { local } = setup(), clock = scheduler(), entries = [];
  local.setItem(profileLocalKey('atlas.settings'), '"before"');
  const large = 'x'.repeat(64 * 1024); local.setItem(profileLocalKey('atlas.chats'), large);
  local.setItem(profileLocalKey('atlas.onboarded'), 'true');
  seedPortableAtlasPreferences(authority, (key, value) => entries.push([key, value]),
    { storage: local, schedule: clock.schedule, now: () => 0 });
  local.setItem(profileLocalKey('atlas.settings'), '"after"');
  clock.tick(); assert.deepEqual(entries[0], ['atlas.settings', '"after"']);
  assert.equal(entries[1][1], large); assert.equal(entries.length, 2);
  clock.drain(); assert.deepEqual(entries[2], ['atlas.onboarded', 'true']);
});
test('account-generation changes and cancellation stop delayed seeding without completing it', () => {
  const { local } = setup(), clock = scheduler(); let visits = 0, completed = 0;
  local.setItem(profileLocalKey('atlas.settings'), '{}');
  const cancel = seedPortableAtlasPreferences(authority, () => visits++, { storage: local, schedule: clock.schedule,
    complete: () => completed++ });
  setActiveLocalAuthority({ ...authority, localAuthGeneration: 'a_new_generation_123' });
  clock.drain(); cancel(); assert.equal(visits, 0); assert.equal(completed, 0);
  setActiveLocalAuthority(authority);
  const cancelAgain = seedPortableAtlasPreferences(authority, () => visits++, { storage: local, schedule: clock.schedule });
  cancelAgain(); clock.drain(); assert.equal(visits, 0);
});
test('storage failures leave seeding incomplete instead of throwing through website readiness', () => {
  setup(); const clock = scheduler(); let completed = false;
  seedPortableAtlasPreferences(authority, () => assert.fail('must not visit'), { schedule: clock.schedule,
    storage: { length: 1, key() { throw Error('storage unavailable'); }, getItem() { return null; } },
    complete: () => { completed = true; } });
  assert.doesNotThrow(() => clock.drain()); assert.equal(completed, false);
});
