import test from 'node:test';
import assert from 'node:assert/strict';
import { watchPageLoad } from '../runtime/page-load-watchdog.ts';

function fixture(kind) {
  const timers = new Map(), calls = [];
  let serial = 0;
  const clock = {
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const stop = watchPageLoad({ clock, delayMs: 30000, kind,
    slow: () => calls.push('slow'), expired: () => calls.push('expired') });
  const task = [...timers.values()][0];
  return { calls, timers, stop, task };
}
test('a normal website past30s gets one notice, not a failed load or teardown', () => {
  const f = fixture('website');
  assert.equal(f.task.delay, 30000);
  f.task.fn(); f.task.fn();
  assert.deepEqual(f.calls, ['slow']);
  f.stop(); assert.equal(f.timers.size, 0);
});
test('a load completing before the notice removes its timer and ignores queued callbacks', () => {
  const f = fixture('website'); f.stop(); f.task.fn();
  assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
});
test('normal load can finish or be closed after a notice without a late expiry', () => {
  const f = fixture('website'); f.task.fn(); f.stop(); f.task.fn();
  assert.deepEqual(f.calls, ['slow']); assert.equal(f.timers.size, 0);
});
test('a broken slow-notice observer never becomes a page-load failure', () => {
  let callback, failures = 0;
  const stop = watchPageLoad({ clock: { setTimeout(fn) { callback = fn; return 1; }, clearTimeout() {} },
    delayMs: 30000, kind: 'website', slow() { throw Error('observer fixture'); }, expired() { failures++; } });
  assert.doesNotThrow(() => callback()); assert.equal(failures, 0); stop();
});
test('the independent opaque content-proof budget remains a fatal deadline', () => {
  const f = fixture('opaque-proof'); f.task.fn(); f.task.fn();
  assert.deepEqual(f.calls, ['expired']); f.stop();
});
test('canceled opaque proof never emits a delayed expiry against a replacement document', () => {
  const f = fixture('opaque-proof'); f.stop(); f.stop(); f.task.fn();
  assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
});
