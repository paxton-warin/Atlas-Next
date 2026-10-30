import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowTabsPersistence, orderTabs } from '../web/src/tab-state.ts';
import { patchTab } from '../web/src/model.ts';
const tab = (id, extra = {}) => ({ id, url: 'https://' + id + '.example/', title: id, engine: 'runtime', status: 'ready', workspace: 'browser', ...extra });
const initial = () => ({ version: 1, tabs: [tab('a'), tab('b')], order: ['a', 'b'], active: 'a', updatedAt: 1000 });
function fixture(previous = initial()) {
  let time = 0, next = 0, current = true; const tasks = new Map(), writes = [];
  const clock = { now: () => time, wallNow: () => 2000 + time,
    schedule(work, delay) { const id = ++next; tasks.set(id, { at: time + delay, work }); return id; }, cancel(id) { tasks.delete(id); } };
  const p = createWindowTabsPersistence({ previous, current: () => current, write: value => { writes.push({ at: time, value }); return true; }, clock });
  return { p, tasks, writes, stale() { current = false; },
    update(tabs = previous.tabs, extra = {}) { return p.update({ tabs, order: previous.order, active: previous.active, restore: true, ...extra }); },
    advance(ms) { const end = time + ms; for (;;) { const next = [...tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; time = next[1].at; tasks.delete(next[0]); next[1].work(); } time = end; },
  };
}
test('repeated runtime fields and unknown targets preserve exact tab array identity', () => {
  const tabs = [tab('a'), tab('b')];
  for (const change of [{ status: 'ready' }, { title: 'a' }, { url: tabs[0].url }, { favicon: undefined }, {}]) assert.equal(patchTab(tabs, 'a', change), tabs);
  assert.equal(patchTab(tabs, 'unknown', { status: 'loading' }), tabs);
  const changed = patchTab(tabs, 'a', { status: 'loading' }); assert.notEqual(changed, tabs); assert.equal(changed[1], tabs[1]); assert.equal(changed[0].status, 'loading');
});
test('ephemeral field changes schedule no write and retain zero storage work', () => {
  const f = fixture(); assert.equal(f.update(), false);
  for (let i = 0; i < 100; i++) assert.equal(f.update([tab('a', { status: i % 2 ? 'error' : 'loading', message: 'ephemeral', favicon: 'data:image/png;base64,AA==' }), tab('b')]), false);
  assert.equal(f.tasks.size, 0); f.advance(2000); assert.equal(f.writes.length, 0);
});
test('changed titles coalesce for250ms and retain intentional layout recency', () => {
  const f = fixture(); f.update([tab('a', { title: 'one' }), tab('b')]); f.advance(200);
  f.update([tab('a', { title: 'two' }), tab('b')]); f.advance(249); assert.equal(f.writes.length, 0);
  f.advance(1); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].value.tabs[0].title, 'two'); assert.equal(f.writes[0].value.updatedAt, 1000);
});
test('continuous changes flush at most1second after the first dirty edit', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { f.update([tab('a', { title: 'title' + i }), tab('b')]); f.advance(100); }
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].at, 1000); assert.equal(f.writes[0].value.tabs[0].title, 'title9');
});
test('layout change then change-back still advances recency without rewriting website state', () => {
  const f = fixture(); f.update(undefined, { active: 'b' }); f.advance(10); f.update(); f.p.flush();
  assert.equal(f.writes[0].value.active, 'a'); assert.equal(f.writes[0].value.updatedAt, 2010); assert.equal(f.tasks.size, 0);
});
test('new window does not inherit a peer window timestamp', () => {
  const f = fixture(null); f.p.update({ tabs: [tab('a')], order: ['a'], active: 'a', restore: true }); f.p.flush();
  assert.equal(f.writes[0].value.updatedAt, 2000);
});
test('pagehide-style flush writes latest pending metadata once and stale account cleanup writes nothing', () => {
  const f = fixture(); f.update([tab('a', { title: 'last edit' }), tab('b')]); f.p.flush(); f.p.flush(); f.advance(1000); assert.equal(f.writes.length, 1);
  f.update([tab('a', { title: 'old account edit' }), tab('b')]); f.stale(); assert.equal(f.p.flush(), false); f.advance(1000); assert.equal(f.writes.length, 1);
});
test('disabled restore saves an intentional empty layout and ignores live-tab changes until reenabled', () => {
  const f = fixture(); f.update(undefined, { restore: false }); f.p.flush(); assert.deepEqual(f.writes[0].value.tabs, []); assert.deepEqual(f.writes[0].value.order, []); assert.equal(f.writes[0].value.active, '');
  assert.equal(f.update([tab('changed')], { restore: false }), false); f.update(); f.p.flush(); assert.equal(f.writes.length, 2);
});
test('local write failure is not acknowledged and remains retryable without a hot timer loop', () => {
  let calls = 0, failures = 0, saved = false;
  const p = createWindowTabsPersistence({ previous: initial(), current: () => true, write: () => { calls++; return saved; }, failed: () => failures++ });
  p.update({ tabs: [tab('a', { title: 'latest' }), tab('b')], order: ['a', 'b'], active: 'a', restore: true });
  assert.equal(p.flush(), false); assert.equal(failures, 1); saved = true; assert.equal(p.flush(), true); assert.equal(calls, 2); p.cancel();
});
test('ordering uses constant-time original-position lookup instead of comparator indexOf scans', () => {
  const tabs = [tab('a'), tab('b'), tab('p', { pinned: true })]; tabs.indexOf = () => assert.fail('no comparator scans');
  assert.deepEqual(orderTabs(tabs, ['b']).map(t => t.id), ['p', 'b', 'a']);
});
