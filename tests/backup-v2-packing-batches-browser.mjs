import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const bundled = (await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  stdin: { resolveDir: resolve('runtime'), contents: `export{resumeBackupNamespace}from'./backup-v2-resume.ts';export{createIndexedDBBackupSpool}from'./backup-v2-spool.ts';export{encodePortableValue}from'./hub-contracts.ts';export{encodeBackupKey}from'./backup-v2-keys.ts';export{createBackupV2Service}from'../web/src/backup-v2-service.ts';` } })).outputFiles[0].text;
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/api.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/api.js' ? bundled : '<!doctype html><title>Actual spool batch fault fixture</title>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const report = { command: 'node tests/backup-v2-packing-batches-browser.mjs', checks: {}, qualification: 'Actual Chromium IndexedDB spool; correctness and transaction counts, not Chromebook latency.' };
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }); report.browser = browser.version();
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(async () => {
    window.api = await import('/api.js'); window.next = 0;
    window.make = async (count = 120, big = false) => {
      const replica = crypto.randomUUID(), incarnation = crypto.randomUUID(), versionId = crypto.randomUUID();
      const control = { format: 2, namespace: 'fixture', incarnation, generation: 1, acknowledgedGeneration: 0,
        schemaEpoch: 1, trackingEpoch: 1, storeEpochs: { rows: 1 }, deleted: false };
      const source = { id: 'fixture', namespace: { kind: 'idb', origin: 'https://example.test', name: 'rows' },
        readControl: async () => structuredClone(control), acknowledge: async cut => { control.acknowledgedGeneration = cut; } };
      const job = { format: 1, sourceId: source.id, versionId, parentVersionId: null, baseline: true, initial: control, final: control,
        phase: 'parts', scanKind: 'baseline', scanAfter: 0, scanTarget: 1, target: 1, pass: 0, parts: [], updatedAt: Date.now() };
      const rows = [];
      for (let i = 0; i < count; i++) rows.push({ id: i.toString(16).padStart(64, '0'), bytes: new TextEncoder().encode(JSON.stringify({
        operation: 'put', store: 'rows', key: api.encodeBackupKey(i), value: await api.encodePortableValue(big && i === 0 ? new Uint8Array(typeof big === 'number' ? big : 180 * 1024).fill(7) : 'value-' + i), generation: 1 })) });
      const spool = api.createIndexedDBBackupSpool(indexedDB, replica); await spool.commitCapture(job, rows); return { replica, incarnation, source, rows, spool, versionId };
    };
    window.check = async (f, result) => {
      const fragments = new Map();
      for (const part of result.version.parts) for (const r of JSON.parse(new TextDecoder().decode(await f.spool.part(part.sha256))).records) {
        const id = r.recordId + ':' + r.index; if (fragments.has(id)) throw Error('DUPLICATE_FRAGMENT'); fragments.set(id, r);
      }
      for (const row of f.rows) {
        let raw = '', count = Math.ceil(row.bytes.length / (180 * 1024));
        for (let i = 0; i < count; i++) raw += atob(fragments.get(row.id + ':' + i).data);
        if (raw.length !== row.bytes.length || row.bytes.some((v, i) => raw.charCodeAt(i) !== v)) throw Error('LOST_RECORD');
      }
      return { records: f.rows.length, fragments: fragments.size, parts: result.version.parts.length };
    };
  });
  report.checks.pagedReads = await page.evaluate(async () => {
    const f = await make(), original = IDBDatabase.prototype.transaction; let reads = 0;
    IDBDatabase.prototype.transaction = function(names, mode, ...rest) { if (this.name === 'atlas.backup.spool.v2:' + f.replica && (mode === undefined || mode === 'readonly') && Array.from(typeof names === 'string' ? [names] : names).includes('records')) reads++; return original.call(this, names, mode, ...rest); };
    let records = 0; try { for await (const row of f.spool.records(f.versionId)) { if (row.id !== f.rows[records].id) throw Error('ORDER'); records++; } } finally { IDBDatabase.prototype.transaction = original; }
    f.spool.dispose(); return { records, readonlyTransactions: reads };
  });
  assert.deepEqual(report.checks.pagedReads, { records: 120, readonlyTransactions: 5 });
  report.checks.oversizedReadPage = await page.evaluate(async () => {
    const f = await make(3, 240 * 1024), original = IDBDatabase.prototype.transaction; let reads = 0, records = 0;
    IDBDatabase.prototype.transaction = function(names, mode, ...rest) { if (this.name === 'atlas.backup.spool.v2:' + f.replica && (mode === undefined || mode === 'readonly') && Array.from(typeof names === 'string' ? [names] : names).includes('records')) reads++; return original.call(this, names, mode, ...rest); };
    try { for await (const row of f.spool.records(f.versionId)) { if (row.id !== f.rows[records].id) throw Error('ORDER'); records++; } } finally { IDBDatabase.prototype.transaction = original; }
    const oversizedRecordBytes = f.rows[0].bytes.length; f.spool.dispose(); return { records, readonlyTransactions: reads, oversizedRecordBytes };
  });
  assert.equal(report.checks.oversizedReadPage.readonlyTransactions, 3);
  assert.ok(report.checks.oversizedReadPage.oversizedRecordBytes > 256 * 1024);
  assert.ok(report.checks.oversizedReadPage.oversizedRecordBytes <= 1024 * 1024);
  report.checks.faults = [];
  for (const point of ['before', 'after', 'transaction-abort']) {
    const value = await page.evaluate(async point => {
      const f = await make(70, true), commit = f.spool.commitCapture.bind(f.spool); let fired = false;
      f.spool.commitCapture = async (job, rows, parts) => {
        if (!fired && job.phase === 'parts' && job.partsAfter) {
          fired = true;
          if (point === 'before') throw Error('ACTOR_CRASH_BEFORE');
          if (point === 'after') { await commit(job, rows, parts); throw Error('ACTOR_CRASH_AFTER'); }
          const original = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(value, key) { const request = original.call(this, value, key); if (this.name === 'jobs') this.transaction.abort(); return request; };
          try { await commit(job, rows, parts); } finally { IDBObjectStore.prototype.put = original; }
          return;
        }
        return commit(job, rows, parts);
      };
      let failed = false; try { await api.resumeBackupNamespace(f.source, f.spool, null, { now: () => 0, yield: async () => {} }); } catch { failed = true; }
      f.spool.dispose(); f.spool = api.createIndexedDBBackupSpool(indexedDB, f.replica);
      const saved = await f.spool.captureJob(f.source.id), result = await api.resumeBackupNamespace(f.source, f.spool, null, { now: () => 0, yield: async () => {} });
      const counts = await check(f, result); f.spool.dispose(); return { point, fired, failed, savedCursor: saved.partsAfter ?? null, savedParts: saved.parts.length, ...counts };
    }, point);
    assert.equal(value.fired, true); assert.equal(value.failed, true); assert.equal(value.records, 70);
    assert.equal(value.savedCursor, point === 'after' ? '0'.repeat(64) : null);
    assert.equal(value.savedParts > 0, point === 'after'); report.checks.faults.push(value);
  }
  report.checks.lostPublicationAcknowledgement = await page.evaluate(async () => {
    const f = await make(120); await api.resumeBackupNamespace(f.source, f.spool, null, { now: () => 0, yield: async () => {} });
    let receipt, publications = 0, manifest; const identities = [];
    const transport = { async request(path, method, body) {
      if (path === '/replicas') return { replicaId: f.replica, incarnation: f.incarnation, headSequence: 0, headCheckpointId: null, adoptedThrough: 0 };
      if (path.endsWith('/checkpoints')) { manifest = body; identities.push([body.checkpointId, body.manifestDigest]); return receipt ? { receipt } : { checkpointId: body.checkpointId, missingParts: body.namespaces.flatMap(n => n.parts.map(p => p.sha256)) }; }
      if (path.endsWith('/publish')) { publications++; receipt = { acknowledged: true, checkpointId: manifest.checkpointId, manifestDigest: manifest.manifestDigest, replicaId: f.replica,
        sequence: manifest.sequence, publicationOrdinal: '1', completedAt: new Date().toISOString(), coverage: manifest.namespaces.map(n => ({ namespaceVersionId: n.namespaceVersionId, localCut: n.localCut })), historyShortened: false };
        throw Object.assign(Error('ACK_LOST_AFTER_REMOTE_COMMIT'), { name: 'NetworkError' }); }
      if (path.endsWith('/adopt')) return { replicaId: f.replica, adoptedThrough: body.adoptedThrough };
      throw Error(path);
    }, async upload() {} };
    const create = () => api.createBackupV2Service({ replicaId: f.replica, incarnation: f.incarnation, label: 'fixture', spool: f.spool, source: async () => [f.source], transport, withLeadership: work => work() });
    let service = create(); await service.initialize(); try { await service.flush(); } catch {} const pending = await f.spool.pending(); service.stop();
    f.spool = api.createIndexedDBBackupSpool(indexedDB, f.replica); service = create(); await service.initialize(); await service.flush();
    const head = await f.spool.head(), finalPending = await f.spool.pending(); service.stop();
    return { publications, identities, hadExactPending: pending?.manifest.checkpointId === receipt?.checkpointId, sequence: head.sequence, finalPending };
  });
  assert.equal(report.checks.lostPublicationAcknowledgement.publications, 1);
  assert.equal(report.checks.lostPublicationAcknowledgement.hadExactPending, true);
  assert.deepEqual(report.checks.lostPublicationAcknowledgement.identities[0], report.checks.lostPublicationAcknowledgement.identities[1]);
  assert.equal(report.checks.lostPublicationAcknowledgement.sequence, 1); assert.equal(report.checks.lostPublicationAcknowledgement.finalPending, null);
  report.result = 'PASS'; console.log('PACKING_BATCHES_BROWSER PASS 120 records/5 readonly pages; atomic before/after/abort recovery including multi-part record; lost publication ACK retains one identity and one publication');
} catch (error) { report.result = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  const dir = resolve(process.env.ATLAS_EVIDENCE_DIR || 'evidence/performance-remediation-20261029/packing'); await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'ACTUAL_SPOOL_BROWSER.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await new Promise(r => server.close(r));
}
