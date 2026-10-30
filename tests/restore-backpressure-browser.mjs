import Fastify from 'fastify';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// The fixture calls production restore + transport through actual HTTP in real
// Chrome. A 429 at the binary boundary must not restart namespace planning.
const baseline = process.env.ATLAS_BACKPRESSURE_BASELINE === '1';
const evidence = resolve('evidence/restore-rate-limit-20261029');
await mkdir(evidence, { recursive: true });
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const transportPath = resolve('web/src/backup-v2-fetch.ts');
const api = (await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  stdin: { resolveDir: resolve('runtime'), contents: `export * from './backup-v2-restore.ts';export * from './backup-v2-contracts.ts';export * from './backup-v2-keys.ts';export {encodePortableValue} from './hub-contracts.ts';export {createBackupV2FetchTransport} from '../web/src/backup-v2-fetch.ts';` },
  plugins: baseline ? [{ name: 'retained-baseline-transport', setup(b) { b.onLoad({ filter: /backup-v2-fetch\.ts$/ }, async args => args.path === transportPath ? { contents: await readFile(resolve(evidence, 'original/web/src/backup-v2-fetch.ts'), 'utf8'), loader: 'ts', resolveDir: resolve('web/src') } : undefined); } }] : [],
})).outputFiles[0].text;
const app = Fastify({ logger: false });
let fixture, browser, firstFailureAt = 0, retryAt = 0;
const counts = new Map(), methods = [], headers = [];
app.get('/', (_req, reply) => reply.type('text/html').send('<!doctype html><title>Restore backpressure regression</title><textarea autofocus>local draft</textarea>'));
app.get('/api.js', (_req, reply) => reply.type('text/javascript').send(api));
app.route({ method: ['GET', 'POST', 'PUT', 'DELETE'], url: '/api/hub/profile/backups/v2/*', handler(req, reply) {
  const u = new URL(req.url, 'https://fixture.invalid'), path = u.pathname.slice('/api/hub/profile/backups/v2'.length);
  methods.push(req.method); counts.set(path, (counts.get(path) || 0) + 1);
  if (path === '/checkpoints/' + fixture.checkpointId) {
    headers.push(u.searchParams.get('restoreId'));
    return { checkpoint: { checkpointId: fixture.checkpointId, publicationOrdinal: '1', namespaces: fixture.namespaces } };
  }
  if (path.startsWith('/namespace-versions/')) {
    const id = path.split('/')[2]; return { records: fixture.records[id] };
  }
  if (path.startsWith('/parts/')) {
    const hash = path.split('/')[2];
    if (!firstFailureAt) {
      firstFailureAt = performance.now();
      return reply.code(429).header('retry-after', '1').send({ error: { code: 'BACKUP_BUSY', message: 'Bulk slot temporarily busy.' } });
    }
    if (!retryAt) retryAt = performance.now();
    return reply.type('application/octet-stream').send(Buffer.from(fixture.parts[hash], 'base64'));
  }
  return reply.code(404).send({ error: { code: 'FIXTURE_NOT_FOUND' } });
} });
const report = { command: (baseline ? 'ATLAS_BACKPRESSURE_BASELINE=1 ' : '') + 'node tests/restore-backpressure-browser.mjs', productionChanged: false, baseline, checks: {} };
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  report.browser = browser.version();
  const page = await browser.newPage(); await page.goto(origin);
  fixture = await page.evaluate(async () => {
    const a = window.api = await import('/api.js'), namespaces = [], records = {}, parts = {};
    const enc = new TextEncoder();
    const b64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
    for (let i = 0; i < 12; i++) {
      const namespace = { kind: 'idb', origin: 'https://restore.example', name: 'sample-' + i }, namespaceVersionId = crypto.randomUUID();
      const header = { format: 'atlas-local-schema-v2', kind: 'idb', version: 1, stores: [{ name: 'rows', keyPath: null, autoIncrement: false, generator: null, indexes: [] }] };
      const values = [ { operation: 'schema', store: '', generation: 1, value: await a.encodePortableValue(header) },
        { operation: 'put', store: 'rows', generation: 1, key: a.encodeBackupKey('draft'), value: await a.encodePortableValue({ text: 'saved-' + i, number: i }) },
        { operation: 'put', store: 'rows', generation: 1, key: a.encodeBackupKey('counter'), value: await a.encodePortableValue(i) } ];
      const fragments = [], metas = [];
      for (const value of values) {
        const bytes = enc.encode(a.canonicalBackupJSON(value)), sha256 = await a.backupSHA256(bytes), recordId = await a.backupSHA256(a.canonicalBackupJSON({ namespace, store: value.store, key: value.key || null, operationKey: value.operation === 'schema' ? 'schema' : 'record' }));
        metas.push({ recordId, store: value.store, operation: value.operation, totalBytes: bytes.byteLength, sha256, fragments: [] });
        fragments.push({ recordId, index: 0, count: 1, totalBytes: bytes.byteLength, sha256, data: b64(bytes) });
      }
      const bytes = enc.encode(a.canonicalBackupJSON({ format: 'atlas-record-page-v2', namespaceVersionId, records: fragments })), hash = await a.backupSHA256(bytes);
      parts[hash] = b64(bytes);
      for (let index = 0; index < metas.length; index++) metas[index].fragments.push({ sha256: hash, index });
      records[namespaceVersionId] = metas.sort((x, y) => x.recordId.localeCompare(y.recordId));
      namespaces.push({ namespaceVersionId, parentNamespaceVersionId: null, namespace, localCut: 1, schemaEpoch: 1, kind: 'baseline', rootDigest: 'a'.repeat(64), parts: [{ ordinal: 0, sha256: hash, bytes: bytes.byteLength }], coverage: 'complete-at-cut' });
    }
    return { checkpointId: crypto.randomUUID(), stagingReplicaId: crypto.randomUUID(), namespaces, records, parts };
  });
  const result = await page.evaluate(async ({ checkpointId, stagingReplicaId }) => {
    const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const done = t => new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onabort = () => reject(t.error); });
    const r = indexedDB.open('foreground-independent-storage', 1); r.onupgradeneeded = () => r.result.createObjectStore('drafts');
    const local = await req(r), transport = api.createBackupV2FetchTransport({ headers: () => ({}) });
    let localWrites = 0, timer, stopped = false;
    const localEdit = async () => {
      if (stopped) return;
      const t = local.transaction('drafts', 'readwrite'), end = done(t); t.objectStore('drafts').put('typed-' + (++localWrites), 'draft'); await end;
      document.querySelector('textarea').value = 'typed-' + localWrites;
      timer = setTimeout(localEdit, 25);
    };
    await localEdit();
    const start = performance.now(); let staged, error;
    try { staged = await api.prepareBackupV2Restore({ factory: indexedDB, transport, checkpointId, stagingReplicaId }); }
    catch (e) { error = { code: e.code, message: e.message, status: e.status }; }
    finally { stopped = true; clearTimeout(timer); }
    const elapsedMs = performance.now() - start;
    const t = local.transaction('drafts'), end = done(t), draft = await req(t.objectStore('drafts').get('draft')); await end; local.close();
    const restored = [];
    if (staged) for (const descriptor of staged.descriptors) {
      const db = await req(indexedDB.open(descriptor.database)), t = db.transaction('rows'), end = done(t), value = await req(t.objectStore('rows').get('draft')), counter = await req(t.objectStore('rows').get('counter')); await end; db.close(); restored.push({ name: descriptor.namespace.name, value, counter });
    }
    return { error, stagingReplicaId: staged?.stagingReplicaId, restored, localWrites, draft, elapsedMs, focus: document.activeElement.tagName };
  }, fixture);
  report.checks = { ...result, metadataCalls: [...counts].filter(([p]) => p.endsWith('/records')), checkpointCalls: counts.get('/checkpoints/' + fixture.checkpointId), partCalls: [...counts].filter(([p]) => p.startsWith('/parts/')), methods, retryDelayMs: retryAt ? retryAt - firstFailureAt : null, uniqueParts: Object.keys(fixture.parts).length };
  assert.equal(report.checks.checkpointCalls, 1);
  assert.equal(report.checks.metadataCalls.length, 12);
  assert.ok(report.checks.metadataCalls.every(([, n]) => n === 1), 'already-fetched records must never be replayed');
  assert.ok(methods.every(m => m === 'GET'), 'restore must not replay any cloud mutation');
  assert.equal(new Set(headers).size, 1, 'one restore identity');
  if (baseline) {
    assert.equal(result.error?.status, 429); assert.equal(result.restored.length, 0); assert.equal(retryAt, 0);
    report.result = 'BASELINE_REPRODUCED';
    console.log('BASELINE_REPRODUCED: first part 429 aborts restore after 12 records requests; no retry');
  } else {
    assert.equal(result.error, undefined); assert.equal(result.stagingReplicaId, fixture.stagingReplicaId); assert.equal(result.restored.length, 12);
    assert.ok(report.checks.retryDelayMs >= 990, 'Retry-After is honored');
    assert.equal(report.checks.partCalls.reduce((n, [, count]) => n + count, 0), 13, '12 shared parts plus exactly one failed attempt');
    assert.equal(report.checks.partCalls.filter(([, n]) => n === 2).length, 1);
    assert.ok(report.checks.partCalls.every(([, n]) => n <= 2));
    assert.ok(result.localWrites >= 10, 'foreground native writes progress during retry');
    assert.equal(result.draft, 'typed-' + result.localWrites); assert.equal(result.focus, 'TEXTAREA');
    for (const { name, value, counter } of result.restored) { const n = Number(name.split('-')[1]); assert.deepEqual(value, { text: 'saved-' + n, number: n }); assert.equal(counter, n); }
    report.result = 'PASS';
    console.log('RESTORE_429 PASS: 12 namespaces, 12 records reads, 12 unique parts + 1 retry, same staging, native writes continue');
  }
} catch (error) { report.result = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally { await writeFile(resolve(evidence, baseline ? 'BROWSER_429_BASELINE.json' : 'BROWSER_429.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await app.close(); }
