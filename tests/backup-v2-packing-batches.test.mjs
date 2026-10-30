import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeBackupNamespace } from '../runtime/backup-v2-resume.ts';
import { BACKUP_V2_LIMITS, backupSHA256, canonicalBackupJSON } from '../runtime/backup-v2-contracts.ts';
import { encodePortableValue } from '../runtime/hub-contracts.ts';
import { encodeBackupKey } from '../runtime/backup-v2-keys.ts';

const encoder = new TextEncoder(), clone = value => structuredClone(value);
async function fixture(count = 120, { bigAt = -1, contentSize = 16 } = {}) {
  const control = { format: 2, namespace: 'fixture', incarnation: 'fixture-incarnation', generation: 1,
    acknowledgedGeneration: 0, schemaEpoch: 1, trackingEpoch: 1, storeEpochs: { rows: 1 }, deleted: false };
  const rows = [];
  for (let i = 0; i < count; i++) rows.push({ id: i.toString(16).padStart(64, '0'),
    bytes: encoder.encode(JSON.stringify({ operation: 'put', store: 'rows', key: encodeBackupKey(i),
      value: await encodePortableValue(i === bigAt ? new Uint8Array(180 * 1024).fill(7) : 'x'.repeat(contentSize)), generation: 1 })) });
  let job = { format: 1, sourceId: 'fixture', versionId: '11111111-1111-4111-8111-111111111111',
    parentVersionId: null, baseline: true, initial: control, final: control, phase: 'parts', scanKind: 'baseline',
    scanAfter: 0, scanTarget: 1, target: 1, pass: 0, parts: [], updatedAt: 0 };
  const parts = new Map(), commits = [], reads = [];
  const f = { rows, parts, commits, reads, beforeCommit: undefined, afterCommit: undefined, beforeRead: undefined,
    source: { id: 'fixture', namespace: { kind: 'idb', origin: 'https://example.test', name: 'rows' }, readControl: async () => clone(control) },
    spool: {
      captureJob: async () => clone(job),
      async *records(_version, after) { for (const row of rows) if (!after || row.id > after) {
        f.beforeRead?.(row); reads.push(row.id); yield clone(row);
      } },
      async commitCapture(next, _records = [], added = []) {
        f.beforeCommit?.(next, added);
        const saved = clone(next), savedParts = added.map(p => clone(p));
        for (const p of savedParts) parts.set(p.sha256, p.bytes);
        job = saved; commits.push(clone(next)); f.afterCommit?.(next, added);
      },
      async dropCapture() { job = null; },
    },
    job: () => clone(job),
  };
  return f;
}
async function reference(f) {
  const parts = []; let page = { format: 'atlas-record-page-v2', namespaceVersionId: f.job().versionId, records: [] };
  async function flush() {
    if (!page.records.length) return;
    const bytes = encoder.encode(JSON.stringify(page)); parts.push({ ordinal: parts.length, sha256: await backupSHA256(bytes), bytes: bytes.length });
    page = { ...page, records: [] };
  }
  for (const row of f.rows) {
    const count = Math.ceil(row.bytes.length / BACKUP_V2_LIMITS.fragmentBytes), sha256 = await backupSHA256(row.bytes);
    for (let index = 0; index < count; index++) {
      const fragment = row.bytes.subarray(index * BACKUP_V2_LIMITS.fragmentBytes, (index + 1) * BACKUP_V2_LIMITS.fragmentBytes);
      const item = { recordId: row.id, index, count, totalBytes: row.bytes.length, sha256, data: Buffer.from(fragment).toString('base64') };
      if (page.records.length >= 256 || encoder.encode(JSON.stringify({ ...page, records: [...page.records, item] })).length > BACKUP_V2_LIMITS.partBytes) await flush();
      page.records.push(item);
    }
  }
  await flush(); return { parts, rootDigest: await backupSHA256(canonicalBackupJSON(parts)) };
}
async function assertWire(f, result, expected) {
  assert.deepEqual(result.version.parts, expected.parts); assert.equal(result.version.rootDigest, expected.rootDigest);
  const found = new Map();
  for (const part of result.version.parts) {
    const bytes = f.parts.get(part.sha256); assert.equal(await backupSHA256(bytes), part.sha256);
    for (const item of JSON.parse(new TextDecoder().decode(bytes)).records) {
      const key = item.recordId + ':' + item.index; assert.equal(found.has(key), false, 'no duplicate fragment'); found.set(key, item);
    }
  }
  for (const row of f.rows) {
    const count = Math.ceil(row.bytes.length / BACKUP_V2_LIMITS.fragmentBytes);
    const restored = Buffer.concat(Array.from({ length: count }, (_, i) => Buffer.from(found.get(row.id + ':' + i).data, 'base64')));
    assert.deepEqual(restored, Buffer.from(row.bytes));
  }
}
const options = { now: () => 0, yield: async () => {} };
test('small records checkpoint in batches while keeping exact existing wire bytes and completed identity', async () => {
  const f = await fixture(), expected = await reference(f);
  const result = await resumeBackupNamespace(f.source, f.spool, null, options);
  const boundaries = f.commits.filter(j => j.phase === 'parts');
  assert.ok(boundaries.length <= 4, `expected batched writes, saw ${boundaries.length}`);
  assert.equal(boundaries[0].partsAfter, f.rows[31].id);
  await assertWire(f, result, expected);
  const commits = f.commits.length;
  assert.deepEqual(await resumeBackupNamespace(f.source, f.spool, null, options), result);
  assert.equal(f.commits.length, commits, 'completed capture is not repacked or republished');
});
for (const point of ['before', 'after']) test(`restart ${point} an atomic batch commit has bounded redo and no lost/duplicate fragments`, async () => {
  const f = await fixture(), expected = await reference(f); let crash = true;
  f[point === 'before' ? 'beforeCommit' : 'afterCommit'] = next => {
    if (crash && next.phase === 'parts') { crash = false; throw Error('ACTOR_CRASH_' + point); }
  };
  await assert.rejects(resumeBackupNamespace(f.source, f.spool, null, options), /ACTOR_CRASH/);
  assert.ok(f.reads.length <= 32);
  const firstReads = f.reads.length, savedCursor = f.job().partsAfter;
  assert.equal(savedCursor, point === 'before' ? undefined : f.rows[31].id);
  const result = await resumeBackupNamespace(f.source, f.spool, null, options);
  assert.ok(f.reads.length - f.rows.length <= 32, 'redo at most one 32-record batch');
  if (point === 'after') assert.equal(f.reads.length, f.rows.length, 'ack loss does not replay a committed batch');
  assert.ok(firstReads > 1); await assertWire(f, result, expected);
});
test('byte threshold flushes preceding records and isolates a valid record spanning multiple parts', async () => {
  const f = await fixture(20, { bigAt: 8, contentSize: 6000 }), expected = await reference(f);
  const result = await resumeBackupNamespace(f.source, f.spool, null, options);
  let previous = -1;
  for (const j of f.commits.filter(j => j.phase === 'parts')) {
    const end = f.rows.findIndex(r => r.id === j.partsAfter), batch = f.rows.slice(previous + 1, end + 1);
    const bytes = batch.reduce((n, r) => n + r.bytes.length, 0);
    assert.ok(batch.length <= 32); assert.ok(bytes <= 64 * 1024 || (batch.length === 1 && bytes <= BACKUP_V2_LIMITS.encodedRecordBytes));
    if (batch.some(r => r.id === f.rows[8].id)) assert.equal(batch.length, 1);
    previous = end;
  }
  await assertWire(f, result, expected);
});
test('elapsed-time threshold checkpoints a small pending batch without waiting for 32 records', async () => {
  const f = await fixture(20); let clock = 0;
  f.beforeRead = () => { clock += 25; };
  await resumeBackupNamespace(f.source, f.spool, null, { now: () => clock, yield: async () => {} });
  assert.ok(f.commits.filter(j => j.phase === 'parts').length >= 4);
  assert.ok(f.commits.filter(j => j.phase === 'parts').every(j => Number.parseInt(j.partsAfter, 16) < 20));
});
for (const action of ['abort', 'pause']) test(`${action} during a multi-part record checkpoints only the complete record`, async () => {
  const f = await fixture(3, { bigAt: 0 }), expected = await reference(f), controller = new AbortController();
  let clock = 0, used = 0, tripped = false;
  const budget = { limit: 8 * 1024 * 1024, get used() { return used; }, set used(v) {
    used = v; if (!tripped) { tripped = true; action === 'abort' ? controller.abort(Error('ACTOR_CANCELLED')) : clock = 200; }
  } };
  await assert.rejects(resumeBackupNamespace(f.source, f.spool, null, { now: () => clock, yield: async () => {},
    visitMs: 100, signal: controller.signal, workBudget: budget }), action === 'abort' ? /ACTOR_CANCELLED/ : { code: 'BACKUP_VISIT_YIELDED' });
  assert.equal(tripped, true); assert.equal(f.job().partsAfter, f.rows[0].id);
  assert.ok(f.job().parts.length > 0); assert.equal(f.job().phase, 'parts');
  await assertWire(f, await resumeBackupNamespace(f.source, f.spool, null, options), expected);
});
test('termination inside a fragmented record retains the preceding atomic batch and replays no partial fragments', async () => {
  const f = await fixture(20, { bigAt: 8 }), expected = await reference(f); let used = 0, crash = true;
  const budget = { limit: 8 * 1024 * 1024, get used() { return used; }, set used(v) {
    used = v; if (crash) { crash = false; throw Error('ACTOR_TERMINATED_DURING_FRAGMENT'); }
  } };
  await assert.rejects(resumeBackupNamespace(f.source, f.spool, null, { ...options, workBudget: budget }), /ACTOR_TERMINATED_DURING_FRAGMENT/);
  assert.equal(f.job().partsAfter, f.rows[7].id, 'only preceding complete batch survives');
  assert.equal(f.job().parts.length, 0, 'in-progress fragment parts have not been committed');
  await assertWire(f, await resumeBackupNamespace(f.source, f.spool, null, options), expected);
});
