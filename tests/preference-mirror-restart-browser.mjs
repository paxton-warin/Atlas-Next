import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const bundle = async contents => (await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', stdin: { resolveDir: resolve('runtime'), contents } })).outputFiles[0].text;
const files = { '/api.js': await bundle(`export{createLocalFirstProfile}from'../web/src/local-first-profile.ts';export{writeLocal,readLocal,profileLocalKey}from'../web/src/model.ts';export*from'./profile-context.ts';export*from'./backup-v2-preferences.ts';export{localDirtyControlKey}from'./local-dirty-v2.ts';`),
  '/runtime/replica-native-control-worker-v2.ts': await bundle(`import './replica-native-control-worker-v2.ts';`),
  '/runtime/backup-v2-worker.ts': await bundle(`import './backup-v2-worker.ts';`), '/runtime/receipt-probe-worker-v2.ts': await bundle(`import './receipt-probe-worker-v2.ts';`) };
const server = createServer((req, res) => {
  if (files[req.url]) { res.setHeader('Content-Type', 'application/javascript'); res.end(files[req.url]); }
  else if (req.url.startsWith('/api/hub/')) { res.setHeader('Content-Type', 'application/json'); if (req.url.includes('/checkpoints/latest')) res.end('{"checkpoint":null}'); else { res.statusCode = 503; res.end('{"error":{"code":"HUB_UNAVAILABLE"}}'); } }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><input id="draft" value="preserve"><script>addEventListener("storage",e=>{if(window.suppressStorage)e.stopImmediatePropagation()},true)</script>'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const report = { command: 'node tests/preference-mirror-restart-browser.mjs', checks: {}, qualification: 'Actual local coordinator, Chromium IndexedDB and backup/catalog workers; no production data or deployment.' }; let browser;
async function until(page, predicate, arg) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await page.evaluate(predicate, arg)) return; await page.waitForTimeout(20); }
  throw Error('ACTUAL_MIRROR_CONDITION_TIMEOUT: ' + predicate.toString().slice(0, 180));
}
async function setup(page, origin) {
  await page.goto(origin);
  await page.evaluate(async () => {
    window.api = await import('/api.js');
    window.state = { enabled: true, authenticated: true, csrf: 'synthetic', grant: { profileId: '11111111-1111-4111-8111-111111111111', sessionId: 'session', contextId: 'context' } };
    window.openProfile = () => api.createLocalFirstProfile(state, { current: () => state, onStatus() {},
      scheduleReconciliation(work, delay) { window.reconciliationDelay = delay; window.reconcileTick = work; return () => { if (window.reconcileTick === work) window.reconcileTick = undefined; }; },
    }, 0, true);
    window.profile = await openProfile(); window.replica = profile.authority.replicaId;
    window.physical = key => 'atlas.profile.user:' + state.grant.profileId + ':replica:' + replica + ':' + key;
    const catalogRequest = indexedDB.open('atlas.local-first.catalog.v2', 1);
    const catalog = await new Promise((res, rej) => { catalogRequest.onsuccess = () => res(catalogRequest.result); catalogRequest.onerror = () => rej(catalogRequest.error); });
    const entries = await new Promise((res, rej) => { const q = catalog.transaction('accounts').objectStore('accounts').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    window.incarnation = entries.find(v => v?.replicaId === replica && v.incarnation)?.incarnation; catalog.close();
    window.mirror = async (key, id = replica) => {
      const r = indexedDB.open(api.atlasBackupDatabase(id), 1); r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('preferences'); };
      const db = await new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const t = db.transaction(['meta', 'preferences']), done = new Promise((res, rej) => { t.oncomplete = res; t.onabort = () => rej(t.error); });
      const request = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const [value, deferred, control] = await Promise.all([request(t.objectStore('preferences').get(key)), request(t.objectStore('meta').get(['atlas-deferred', key])), request(t.objectStore('meta').get(api.localDirtyControlKey(api.ATLAS_BACKUP_NAMESPACE)))]);
      await done; db.close(); return { value: value ?? null, deferred: deferred ?? null, generation: control?.generation ?? 0 };
    };
  });
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }); report.browser = browser.version();
  const context = await browser.newContext(), page = await context.newPage(), origin = 'http://127.0.0.1:' + server.address().port;
  await setup(page, origin);
  await page.evaluate(() => api.writeLocal('atlas.settings', { phase: 'seeded' }));
  await until(page, async () => (await mirror('atlas.settings')).value === '{"phase":"seeded"}');
  report.checks.seedCompleteThenStopBeforeAcknowledgement = await page.evaluate(async () => {
    const before = replica; localStorage.setItem('atlas.profile.mirror-seeded.v1:' + state.grant.profileId + ':' + replica + ':' + incarnation, '1');
    api.writeLocal('atlas.settings', { phase: 'newer canonical' }); profile.stop();
    window.profile = await openProfile(); return { sameReplica: profile.authority.replicaId === before, local: api.readLocal('atlas.settings', {}) };
  });
  assert.equal(report.checks.seedCompleteThenStopBeforeAcknowledgement.sameReplica, true);
  await until(page, async () => (await mirror('atlas.settings')).value === '{"phase":"newer canonical"}');
  report.checks.seedCompleteThenStopBeforeAcknowledgement.mirroredLatest = true;
  report.checks.coordinatorAbsentChangesAndDeletion = await page.evaluate(async () => {
    profile.stop(); localStorage.setItem(physical('atlas.history'), '["while coordinator absent"]'); localStorage.removeItem(physical('atlas.settings')); window.profile = await openProfile(); return api.readLocal('atlas.history', []);
  });
  await until(page, async () => (await mirror('atlas.settings')).value === null && (await mirror('atlas.history')).value === '["while coordinator absent"]');
  await page.evaluate(() => api.writeLocal('atlas.chats', 'x'.repeat(140 * 1024)));
  await until(page, async () => !!(await mirror('atlas.chats')).deferred);
  await page.evaluate(async () => { profile.stop(); localStorage.removeItem(physical('atlas.chats')); window.profile = await openProfile(); });
  await until(page, async () => (await mirror('atlas.chats')).deferred === null);
  report.checks.deletedDeferredPreference = 'PASS';
  for (const commitFirst of [false, true]) {
    await page.evaluate(commitFirst => {
      window.faultSeen = false; const original = profile.backup.preferences.bind(profile.backup);
      profile.backup.preferences = async (...args) => { if (commitFirst) await original(...args); await profile.backup.restart(); window.faultSeen = true; throw Error(commitFirst ? 'ACK_LOST_AFTER_COMMIT' : 'WORKER_FAILED_BEFORE_COMMIT'); };
      api.writeLocal('atlas.history', ['worker failure', commitFirst]);
    }, commitFirst);
    await page.waitForFunction(() => faultSeen);
    await page.evaluate(async () => { profile.stop(); window.profile = await openProfile(); });
    await until(page, async commitFirst => (await mirror('atlas.history')).value === JSON.stringify(['worker failure', commitFirst]), commitFirst);
    report.checks[commitFirst ? 'lostLocalAcknowledgementAfterCommit' : 'backupWorkerFailureBeforeCommit'] = 'PASS';
  }
  const generation = await page.evaluate(async () => (await mirror('atlas.history')).generation);
  await page.evaluate(async () => { profile.stop(); window.profile = await openProfile(); }); await page.waitForTimeout(700);
  assert.equal(await page.evaluate(async () => (await mirror('atlas.history')).generation), generation);
  report.checks.unchangedRestartDoesNotAdvanceDirtyGeneration = 'PASS';
  await page.evaluate(() => api.writeLocal('atlas.shortcuts', ['initial']));
  await until(page, async () => (await mirror('atlas.shortcuts')).value === '["initial"]');
  const other = await context.newPage(); await setup(other, origin); await other.waitForTimeout(350); await other.evaluate(() => profile.stop());
  await page.evaluate(() => {
    window.suppressStorage = true; window.gated = false; window.sent = []; const original = profile.backup.preferences.bind(profile.backup); let first = true;
    profile.backup.preferences = async (values, deferred) => { if ('atlas.shortcuts' in values) { sent.push(values['atlas.shortcuts']); if (first) { first = false; gated = true; await new Promise(resolve => { window.releaseGate = resolve; }); } } return original(values, deferred); };
    api.writeLocal('atlas.shortcuts', ['stale in flight']);
  });
  await page.waitForFunction(() => gated);
  const canonicalKey = await page.evaluate(() => physical('atlas.shortcuts'));
  await other.evaluate(key => localStorage.setItem(key, '["newer other window"]'), canonicalKey);
  await page.evaluate(() => releaseGate());
  await until(page, async () => sent.includes('["newer other window"]') && (await mirror('atlas.shortcuts')).value === '["newer other window"]');
  report.checks.staleOtherWindowAcknowledgement = await page.evaluate(() => ({ sent, canonical: api.readLocal('atlas.shortcuts', []) }));
  assert.deepEqual(report.checks.staleOtherWindowAcknowledgement.sent, ['["stale in flight"]', '["newer other window"]']);
  await other.evaluate(async () => { window.profile = await openProfile(); }); await other.waitForTimeout(350);
  await page.evaluate(() => {
    const original = profile.backup.preferences.bind(profile.backup); window.lateGate = false; window.staleCommitSeen = false;
    profile.backup.preferences = async (values, deferred) => {
      if (!('atlas.shortcuts' in values)) return original(values, deferred);
      lateGate = true; await new Promise(resolve => { window.releaseLate = resolve; });
      await original(values, deferred); window.staleCommitSeen = true; profile.stop(); throw Error('COORDINATOR_CRASH_AFTER_STALE_COMMIT_BEFORE_ACK');
    };
    api.writeLocal('atlas.shortcuts', ['late stale A']);
  });
  await page.waitForFunction(() => lateGate);
  await other.evaluate(() => api.writeLocal('atlas.shortcuts', ['live canonical B']));
  await until(other, async () => (await mirror('atlas.shortcuts')).value === '["live canonical B"]'); await other.waitForTimeout(30);
  await page.evaluate(() => releaseLate()); await page.waitForFunction(() => staleCommitSeen);
  assert.equal(await other.evaluate(async () => (await mirror('atlas.shortcuts')).value), '["late stale A"]');
  assert.deepEqual(await other.evaluate(() => api.readLocal('atlas.shortcuts', [])), ['live canonical B']);
  await other.evaluate(() => reconcileTick());
  await until(other, async () => (await mirror('atlas.shortcuts')).value === '["live canonical B"]');
  const repairedGeneration = await other.evaluate(async () => (await mirror('atlas.shortcuts')).generation);
  await other.evaluate(() => reconcileTick()); await other.waitForTimeout(450);
  assert.equal(await other.evaluate(async () => (await mirror('atlas.shortcuts')).generation), repairedGeneration);
  report.checks.scheduledActivePeerCrashRecovery = { staleNativeValueObserved: true, canonicalKept: true, clockIntervalMs: await other.evaluate(() => reconciliationDelay), repairedOnInjectedTick: true, unchangedTickDidNotDirty: true };
  assert.equal(report.checks.scheduledActivePeerCrashRecovery.clockIntervalMs, 60000);
  await other.evaluate(() => { const old = reconcileTick; profile.stop(); old(); });
  assert.equal(await other.evaluate(() => reconcileTick === undefined), true);
  report.checks.cancelledReconciliationClock = 'PASS';
  report.checks.nativeEqualityAndDeferredTransitions = await page.evaluate(async () => {
    const id = crypto.randomUUID(), key = 'atlas.settings';
    const first = await api.writeBackupPreferences(indexedDB, id, { [key]: 'same' }), a = await mirror(key, id);
    const repeat = await api.writeBackupPreferences(indexedDB, id, { [key]: 'same' }), b = await mirror(key, id);
    const deferred = await api.writeBackupPreferences(indexedDB, id, {}, [{ key, estimatedNativeBytes: 400000 }]), c = await mirror(key, id);
    const repeatDeferred = await api.writeBackupPreferences(indexedDB, id, {}, [{ key, estimatedNativeBytes: 400000 }]), d = await mirror(key, id);
    const normalAgain = await api.writeBackupPreferences(indexedDB, id, { [key]: 'same' }), e = await mirror(key, id);
    await api.writeBackupPreferences(indexedDB, id, {}, [{ key, estimatedNativeBytes: 400000 }]);
    const removed = await api.writeBackupPreferences(indexedDB, id, { [key]: null }), f = await mirror(key, id);
    const repeatRemoved = await api.writeBackupPreferences(indexedDB, id, { [key]: null }), g = await mirror(key, id);
    return { first, repeat, deferred, repeatDeferred, normalAgain, removed, repeatRemoved, generations: [a.generation, b.generation, c.generation, d.generation, e.generation, f.generation, g.generation], cleared: !e.deferred && !f.deferred && f.value === null };
  });
  const n = report.checks.nativeEqualityAndDeferredTransitions;
  assert.deepEqual([n.first, n.repeat, n.deferred, n.repeatDeferred, n.normalAgain, n.removed, n.repeatRemoved], [true, false, true, false, true, true, false]);
  assert.equal(n.generations[0], n.generations[1]); assert.equal(n.generations[2], n.generations[3]); assert.equal(n.generations[5], n.generations[6]); assert.equal(n.cleared, true);
  report.checks.boundedMirrorKeyPages = await page.evaluate(async () => {
    const id = crypto.randomUUID(), expected = [];
    for (let start = 0; start < 90; start += 30) { const values = {}; for (let i = start; i < Math.min(90, start + 30); i++) { const key = 'atlas.windows.v1.' + i.toString(16).padStart(36, '0'); expected.push(key); values[key] = '{}'; } await api.writeBackupPreferences(indexedDB, id, values); }
    await api.writeBackupPreferences(indexedDB, id, {}, [{ key: 'atlas.chats', estimatedNativeBytes: 400000 }]);
    let cursor, max = 0; const keys = []; do { const page = await api.readBackupPreferenceKeys(indexedDB, id, cursor); max = Math.max(max, page.keys.length); keys.push(...page.keys); cursor = page.nextCursor; } while (cursor);
    return { count: new Set(keys).size, max, all: [...expected, 'atlas.chats'].every(k => keys.includes(k)) };
  });
  assert.equal(report.checks.boundedMirrorKeyPages.count, 91); assert.ok(report.checks.boundedMirrorKeyPages.max <= 64); assert.equal(report.checks.boundedMirrorKeyPages.all, true);
  await page.evaluate(() => profile.stop()); await context.close(); report.result = 'PASS';
  console.log('PREFERENCE_MIRROR_RESTART PASS real workers: stop/crash/ACK loss recover canonical values; absent-coordinator edits/deletions; stale other-window ACK repair; unchanged generation dedup; deferred transitions; bounded key pages');
} catch (error) { report.result = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally { const dir = resolve(process.env.ATLAS_EVIDENCE_DIR || 'evidence/performance-remediation-20261029/mirror-reconcile'); await mkdir(dir, { recursive: true }); await writeFile(resolve(dir, 'ACTUAL_WORKERS_BROWSER.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await new Promise(r => server.close(r)); }
