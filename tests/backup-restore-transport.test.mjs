import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

// Bundle the production module: no hand-copied timeout/decoder implementation.
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const built = await build({ entryPoints: [resolve('web/src/backup-v2-fetch.ts')], bundle: true,
  write: false, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
const { createBackupV2FetchTransport } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function streamFixture(chunks, { interval = 15, stall = false, headers = {}, status = 200 } = {}) {
  const observed = { calls: 0, aborted: 0, cancelled: 0, delivered: 0, signal: undefined };
  return { observed, fetch: async (_url, options) => {
    observed.calls++; observed.signal = options.signal;
    let timer, closed = false, at = 0, controller;
    const stop = () => { clearTimeout(timer); closed = true; };
    const body = new ReadableStream({
      start(c) {
        controller = c;
        const emit = () => {
          if (closed) return;
          if (at < chunks.length) { c.enqueue(chunks[at++]); observed.delivered++; }
          if (at < chunks.length) timer = setTimeout(emit, interval);
          else if (!stall) { stop(); c.close(); }
        };
        timer = setTimeout(emit, interval);
      },
      cancel() { observed.cancelled++; stop(); },
    });
    const aborted = () => { observed.aborted++; if (!closed) { stop(); controller.error(options.signal.reason); } };
    if (options.signal.aborted) aborted();
    else options.signal.addEventListener('abort', aborted, { once: true });
    return new Response(body, { status, headers });
  } };
}
function transport(fixture, timeoutMs = 60) {
  return createBackupV2FetchTransport({ headers: () => ({ 'x-test': 'fixture' }), fetch: fixture.fetch, timeoutMs });
}

test('continuous binary progress survives several inactivity windows without duplicate request', async () => {
  const fixture = streamFixture(Array.from({ length: 12 }, (_, n) => Uint8Array.of(n)), { interval: 15 });
  const started = performance.now(), actual = await transport(fixture).download('/parts/example');
  assert.deepEqual([...actual], Array.from({ length: 12 }, (_, n) => n));
  assert.ok(performance.now() - started > 120, 'total transfer exceeds twice the 60ms inactivity deadline');
  assert.equal(fixture.observed.calls, 1); assert.equal(fixture.observed.aborted, 0);
  await sleep(70); assert.equal(fixture.observed.aborted, 0, 'completed transfer clears its timer');
});

test('continuous metadata JSON progress also survives total transfer longer than deadline', async () => {
  const fixture = streamFixture([...'{"ok":true}'].map(c => encoder.encode(c)), { interval: 15 });
  assert.deepEqual(await transport(fixture).request('/checkpoints/id'), { ok: true });
  assert.equal(fixture.observed.calls, 1); assert.equal(fixture.observed.aborted, 0);
});

test('a real body stall aborts the fetch/body instead of waiting indefinitely', async () => {
  const fixture = streamFixture([Uint8Array.of(7)], { interval: 5, stall: true });
  const started = performance.now();
  await assert.rejects(transport(fixture, 35).download('/parts/stalled'), e => e.code === 'BACKUP_TRANSFER_STALLED' && e.name === 'TimeoutError');
  assert.ok(performance.now() - started < 500); assert.equal(fixture.observed.aborted, 1);
  assert.equal(fixture.observed.calls, 1);
});

test('manual abort preserves the caller reason and cancels an advancing stream', async () => {
  const fixture = streamFixture(Array.from({ length: 100 }, () => Uint8Array.of(1)), { interval: 10 });
  const controller = new AbortController(), reason = new DOMException('Caller cancelled restore', 'AbortError');
  const pending = transport(fixture).download('/parts/cancelled', controller.signal);
  setTimeout(() => controller.abort(reason), 25);
  await assert.rejects(pending, e => e === reason);
  assert.equal(fixture.observed.aborted, 1); assert.ok(fixture.observed.delivered < 100);
});

test('a metadata request stalled before headers is cancelled by inactivity deadline', async () => {
  let observed;
  const t = createBackupV2FetchTransport({ timeoutMs: 30, headers: () => ({}), fetch: async (_url, { signal }) => {
    observed = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(t.request('/latest'), e => e.code === 'BACKUP_TRANSFER_STALLED');
  assert.equal(observed.aborted, true);
});

test('exactly 256KiB decoded binary is admitted; 256KiB+1 cancels despite tiny wire length', async () => {
  const limit = 256 * 1024;
  const exact = streamFixture([new Uint8Array(limit)], { interval: 0 });
  assert.equal((await transport(exact).download('/parts/exact')).byteLength, limit);
  // Fetch exposes decompressed body chunks. The bound must not trust wire-size headers.
  const excessive = streamFixture([new Uint8Array(limit), Uint8Array.of(1)], {
    interval: 0, stall: true, headers: { 'content-length': '32', 'content-encoding': 'gzip' },
  });
  await assert.rejects(transport(excessive).download('/parts/excess'), e => e.code === 'BACKUP_RESPONSE_TOO_LARGE');
  assert.equal(excessive.observed.cancelled, 1); assert.equal(excessive.observed.calls, 1);
});

test('nonempty progress is required; empty chunks cannot hold a restore alive', async () => {
  const fixture = streamFixture(Array.from({ length: 100 }, () => new Uint8Array()), { interval: 5 });
  await assert.rejects(transport(fixture, 30).download('/parts/no-progress'), e => e.code === 'BACKUP_TRANSFER_STALLED');
  assert.equal(fixture.observed.aborted, 1);
});

test('HTTP status and bounded Retry-After survive malformed gateway JSON', async () => {
  const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => new Response('<html>gateway</html>', { status: 503, headers: { 'retry-after': '12' } }) });
  await assert.rejects(t.request('/latest'), e => e.status === 503 && e.code === 'BACKUP_RESPONSE_INVALID' && e.retryAfterMs === 12000);
});

test('JSON error and binary failures preserve status plus bounded Retry-After without mutation replay', async () => {
  let calls = 0;
  const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async (_url, options) => {
    calls++; assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ error: { code: 'BACKUP_ADMISSION_BUSY', message: 'Later' } }), { status: 429, headers: { 'retry-after': '900' } });
  } });
  await assert.rejects(t.request('/prepare', 'POST', { exact: 'identity' }), e => e.status === 429 && e.code === 'BACKUP_ADMISSION_BUSY' && e.retryAfterMs === 900000);
  assert.equal(calls, 1);
  await assert.rejects(t.download('/parts/held'), e => e.status === 429 && e.code === 'BACKUP_ADMISSION_BUSY' && e.retryAfterMs === 900000);
  assert.equal(calls, 2);
});

const immutablePart = '/parts/' + 'a'.repeat(64);
const immutableRecords = '/namespace-versions/00000000-0000-4000-8000-000000000001/records';
test('transient part admission pressure retries the exact immutable URL and preserves prior progress', async () => {
  const urls = []; let progress = 0;
  const t = createBackupV2FetchTransport({ headers: () => ({}), onActivity: () => progress++, fetch: async url => {
    urls.push(url);
    if (urls.length === 1) return new Response('{"error":{"code":"BACKUP_BUSY","message":"Capacity busy"}}', { status: 429 });
    return new Response(Uint8Array.of(8, 9));
  } });
  assert.deepEqual([...await t.download(immutablePart)], [8, 9]);
  assert.equal(urls.length, 2); assert.equal(urls[0], urls[1]);
  assert.equal(progress, 2, 'only successful headers and successful body count as restore data');
});

test('restore metadata 503 retries the same cursor without repeating previous pages', async () => {
  const urls = []; let failed = false;
  const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async url => {
    urls.push(url);
    if (url.includes('?cursor=') && !failed) { failed = true; return new Response('{"error":{"code":"BACKUP_BUSY"}}', { status: 503 }); }
    return Response.json({ records: [], cursor: url.includes('?cursor=') ? 'second' : 'first' });
  } });
  assert.equal((await t.request(immutableRecords)).cursor, 'first');
  assert.equal((await t.request(immutableRecords + '?cursor=' + 'b'.repeat(64))).cursor, 'second');
  assert.equal(urls.length, 3); assert.equal(urls[1], urls[2]); assert.notEqual(urls[0], urls[1]);
});

test('server Retry-After is honored before an immutable retry', async () => {
  const starts = []; let calls = 0;
  const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => {
    starts.push(performance.now());
    return ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response(Uint8Array.of(1));
  } });
  await t.download(immutablePart);
  assert.equal(calls, 2); assert.ok(starts[1] - starts[0] >= 980);
});

test('persistent admission failures stop after three retries and do not invent data activity', async () => {
  let calls = 0, progress = 0;
  const t = createBackupV2FetchTransport({ headers: () => ({}), onActivity: () => progress++, fetch: async () => {
    calls++;
    return new Response('{"error":{"code":"BACKUP_BUSY","message":"Local saves continue"}}', { status: 429 });
  } });
  const start = performance.now();
  await assert.rejects(t.download(immutablePart), e => e.status === 429 && e.code === 'BACKUP_BUSY' && e.message === 'Local saves continue');
  assert.equal(calls, 4); assert.equal(progress, 0);
  assert.ok(performance.now() - start < 10000, 'bounded recovery cannot become an indefinite retry loop');
});

test('abort during retry backoff cancels immediately without a follow-up GET', async () => {
  let calls = 0; const abort = new AbortController(), reason = new Error('fixture cancelled');
  const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '1' } }); } });
  const pending = t.download(immutablePart, abort.signal);
  setTimeout(() => abort.abort(reason), 25);
  await assert.rejects(pending, e => e === reason); await sleep(300);
  assert.equal(calls, 1);
});

test('long server cooldown, authorization errors, mutable reads and mutation requests are never replayed', async () => {
  for (const status of [401, 403, 404, 429]) {
    let calls = 0;
    const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => { calls++; return Response.json({ error: { code: 'HUB_RATE_LIMITED' } }, { status, headers: { 'retry-after': '16' } }); } });
    await assert.rejects(t.download(immutablePart), e => e.status === status);
    assert.equal(calls, 1);
  }
  for (const [method, path] of [['GET', '/checkpoints/latest?catalog=paged'], ['POST', immutableRecords], ['PUT', immutablePart]]) {
    let calls = 0;
    const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => { calls++; return Response.json({ error: { code: 'BACKUP_BUSY' } }, { status: 429 }); } });
    await assert.rejects(t.request(path, method, method === 'GET' ? undefined : { exact: 'identity' }), e => e.status === 429);
    assert.equal(calls, 1);
  }
});

test('binary error code and message are bounded and malformed bodies retain HTTP status', async () => {
  for (const body of ['<html>gateway</html>', JSON.stringify({ error: { code: 'x'.repeat(1000), message: 'm'.repeat(1000) } })]) {
    const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => new Response(body, { status: 503 }) });
    await assert.rejects(t.download('/parts/not-an-immutable-hash'), e => e.status === 503 && e.code === 'BACKUP_PART_UNAVAILABLE' && e.message === 'Backup part is temporarily unavailable.');
  }
});

test('invalid/out-of-range Retry-After never becomes an unbounded delay', async () => {
  for (const value of ['0', '901', '9999', '-1', '1.5', 'tomorrow']) {
    const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: async () => new Response('', { status: 503, headers: { 'retry-after': value } }) });
    await assert.rejects(t.request('/latest'), e => e.status === 503 && e.retryAfterMs === undefined);
  }
});


test('native Fetch gzip decompression is bounded by decoded size, not compressed transfer bytes', async () => {
  const limit = 256 * 1024;
  const server = createServer((req, res) => {
    const body = gzipSync(Buffer.alloc(req.url.endsWith('/exact') ? limit : limit + 1));
    assert.ok(body.length < 1024, 'fixture is small on the wire');
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const t = createBackupV2FetchTransport({ prefix: 'http://127.0.0.1:' + server.address().port, headers: () => ({}), timeoutMs: 1000 });
    assert.equal((await t.download('/exact')).byteLength, limit);
    await assert.rejects(t.download('/oversize'), e => e.code === 'BACKUP_RESPONSE_TOO_LARGE');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('activity signals reflect headers and nonempty chunks, never empty keepalive chunks', async () => {
  const fixture = streamFixture([Uint8Array.of(1), new Uint8Array(), Uint8Array.of(2)], { interval: 5 });
  let activity = 0;
  const t = createBackupV2FetchTransport({ headers: () => ({}), fetch: fixture.fetch, timeoutMs: 60, onActivity: () => activity++ });
  assert.deepEqual([...await t.download('/parts/progress')], [1, 2]);
  assert.equal(activity, 3, 'one headers event plus two actual data events');
});
