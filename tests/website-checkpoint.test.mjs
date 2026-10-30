import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkpointControllerRoot,
  checkpointElementVisible,
  checkpointWebsiteRoot,
  cookieClickerStoredSave,
} from '../runtime/website-checkpoint.ts';
const website = 'https://orteil.dashnet.org/cookieclicker/';
function fixture({ failed = false, throws = false, key = 'CookieClickerGame', website: url = website } = {}) {
  const storage = new Map([['CookieClickerGame', cookieClickerStoredSave('old bakery|10|')]]), calls = [];
  const root = { name: 'CookieClicker', document: {}, localStorage: { getItem(key) { return storage.get(key) ?? null; } } };
  root.Game = { ready: 1, useLocalStorage: 1, Objects: {}, SaveTo: key, lastSaveData: 'old bakery|10|', WriteSave(...args) {
    calls.push({ args, receiver: this }); this.lastSaveData = 'fresh bakery|42|☘\u{1F36A}';
    if (throws) throw Error('QuotaExceededError');
    if (!failed) storage.set(this.SaveTo, cookieClickerStoredSave(this.lastSaveData));
  } };
  const record = { element: { contentWindow: root }, checkpointRoot: { window: root, document: root.document, logicalURL: () => url } };
  return { root, storage, calls, record, run: () => checkpointControllerRoot(record, new URL(url).origin) };
}
test('official Cookie Clicker checkpoint calls native DEFAULT save with its receiver and verifies actual Unicode storage', () => {
  const f = fixture();
  assert.deepEqual(f.run(), { supported: true });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args, []); assert.equal(f.calls[0].receiver, f.root.Game);
  assert.equal(f.storage.get('CookieClickerGame'), cookieClickerStoredSave(f.root.Game.lastSaveData));
});
test('native swallowed write failure cannot pass using updated lastSaveData or a stale nonempty save key', () => {
  const f = fixture({ failed: true }), old = f.storage.get('CookieClickerGame');
  assert.throws(f.run, { code: 'PROFILE_CHECKPOINT_SAVE_FAILED' });
  assert.equal(f.storage.get('CookieClickerGame'), old);
  assert.equal(f.root.Game.lastSaveData, 'fresh bakery|42|☘\u{1F36A}');
});
test('thrown local save errors propagate instead of acknowledging release', () => {
  const f = fixture({ throws: true }); assert.throws(f.run, /QuotaExceededError/);
});
test('unsupported sites never inspect or invoke a Game-shaped API and remain committed-data-only', () => {
  for (const url of ['https://example.test/', 'https://orteil.dashnet.org/other/', 'https://orteil.dashnet.org/cookieclicker/beta/', 'https://orteil.dashnet.org.evil.test/cookieclicker/', 'http://orteil.dashnet.org/cookieclicker/']) {
    let inspected = false;
    const root = { get Game() { inspected = true; throw Error('arbitrary API accessed'); } };
    assert.deepEqual(checkpointWebsiteRoot({ root, website: url, expectedOrigin: new URL(url).origin }), { supported: false });
    assert.equal(inspected, false);
  }
});
test('a changed logical origin rejects before native save', () => {
  const f = fixture(); assert.throws(() => checkpointControllerRoot(f.record, 'https://other.test'), { code: 'PROFILE_CHECKPOINT_ORIGIN_CHANGED' });
  assert.equal(f.calls.length, 0);
});
test('physical root identity survives website window.name changes but rejects a nested or replaced document', () => {
  const f = fixture(); f.root.name = 'unrelated-user-selected-name'; assert.deepEqual(f.run(), { supported: true });
  f.record.element.contentWindow = { ...f.root }; assert.throws(f.run, { code: 'PROFILE_CHECKPOINT_DOCUMENT_CHANGED' });
  f.record.element.contentWindow = f.root; f.root.document = {}; assert.throws(f.run, { code: 'PROFILE_CHECKPOINT_DOCUMENT_CHANGED' });
  assert.equal(f.calls.length, 1);
});
test('not-ready, wrong-key, legacy-cookie mode and async save APIs are not presented as a valid checkpoint', () => {
  for (const patch of [{ ready: 0 }, { SaveTo: 'other-key' }, { useLocalStorage: 0 }, { WriteSave: async () => undefined }]) {
    const f = fixture(); Object.assign(f.root.Game, patch);
    assert.throws(f.run, { code: 'PROFILE_CHECKPOINT_NOT_READY' }); assert.equal(f.calls.length, 0);
  }
});
test('native ascent, ongoing save and per-building minigame loading block checkpoint before save invocation', () => {
  for (const patch of [{ OnAscend: 1 }, { isSaving: true }, { Objects: { Farm: { minigameLoading: true } } }]) {
    const f = fixture(); Object.assign(f.root.Game, patch);
    assert.throws(f.run, { code: 'PROFILE_CHECKPOINT_SAVE_BUSY' }); assert.equal(f.calls.length, 0);
  }
});
test('a normal function returning deferred save work cannot report a completed checkpoint', () => {
  const f = fixture(); f.root.Game.WriteSave = () => Promise.resolve();
  assert.throws(f.run, { code: 'PROFILE_CHECKPOINT_ASYNC_UNSUPPORTED' });
});
test('frame names and accessible child windows never become checkpoint candidates', () => {
  const f = fixture(), child = fixture();
  f.root.frames = [child.root]; f.root.name = child.root.name = 'view-same-name';
  assert.deepEqual(f.run(), { supported: true }); assert.equal(child.calls.length, 0);
});
test('candidate visibility respects hidden ancestors and layout-hidden containers', () => {
  const ancestor = { hidden: true, parentElement: null }, element = { parentElement: ancestor, style: {}, getClientRects: () => [{}] };
  assert.equal(checkpointElementVisible(element), false);
  ancestor.hidden = false; assert.equal(checkpointElementVisible(element), true);
  element.getClientRects = () => []; assert.equal(checkpointElementVisible(element), false);
});
