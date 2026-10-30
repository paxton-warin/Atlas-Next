import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { createProfileSyncScheduler } from '../web/src/profile-sync-scheduler.ts';
import { restoreProfileChunks } from '../web/src/profile-chunk-restore.ts';
import { loadProfileStream, loadProfileStreamHead } from '../web/src/profile-stream.ts';
import { hubNamespace, hubSiteGroup, HUB_LIMITS } from '../runtime/hub-contracts.ts';
import { drainProfileQueue, changeNamespace } from '../runtime/profile-sync.ts';
import { temporaryProfileFailure } from '../web/src/profile-errors.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let release; const promise = new Promise(resolve => release = resolve); return { promise, release }; };
const eventually = async (predicate, message) => {
  for (let i = 0; i < 40; i++) { if (predicate()) return; await turn(); }
  assert.ok(predicate(), message);
};

/** Browser-like FIFO shared/exclusive lock arbitration. Unlike older profile
 * fixtures this actually suspends conflicting callbacks until their holder exits. */
function lockManager() {
  const resources = new Map(), log = [];
  const resource = name => { if (!resources.has(name)) resources.set(name, { held: [], waiting: [] }); return resources.get(name); };
  const pump = (name) => {
    const value = resource(name);
    if (value.held.some(item => item.mode === 'exclusive')) return;
    while (value.waiting.length) {
      const next = value.waiting[0];
      if (next.mode === 'exclusive' && value.held.length) return;
      if (next.mode === 'exclusive' && value.held.length === 0 || next.mode === 'shared') {
        value.waiting.shift(); next.granted = true; value.held.push(next);
        next.signal?.removeEventListener('abort', next.abort);
        log.push({ type: 'acquired', name, mode: next.mode });
        Promise.resolve().then(() => next.run({ name, mode: next.mode })).then(next.resolve, next.reject).finally(() => {
          value.held.splice(value.held.indexOf(next), 1);
          log.push({ type: 'released', name, mode: next.mode }); pump(name);
        });
        if (next.mode === 'exclusive') return;
      }
    }
  };
  return {
    log,
    request(name, options, run) {
      if (typeof options === 'function') { run = options; options = {}; }
      options ||= {}; const value = resource(name), mode = options.mode || 'exclusive';
      log.push({ type: 'requested', name, mode });
      if (options.ifAvailable && (value.held.length || value.waiting.length)) return Promise.resolve().then(() => run(null));
      if (options.signal?.aborted) return Promise.reject(options.signal.reason);
      return new Promise((resolve, reject) => {
        const item = { mode, run, resolve, reject, signal: options.signal, granted: false };
        item.abort = () => { if (item.granted) return; value.waiting.splice(value.waiting.indexOf(item), 1); reject(options.signal.reason); pump(name); };
        options.signal?.addEventListener('abort', item.abort, { once: true });
        value.waiting.push(item); pump(name);
      });
    },
  };
}

function loadModule(path, globals, imports = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { ...globals, exports, require: name => {
    if (imports[name]) return imports[name];
    throw Error('Unexpected import: ' + name);
  }});
  return exports;
}

function sharedState() {
  const locks = lockManager(), storage = new Map(), entries = [], heads = new Map(), prepared = new Map();
  const calls = [], events = [], permits = [], clients = [], commitGates = new Map(), commits = [], acknowledgements = [];
  const manifestOrigins = new Set(), remoteHeads = new Map();
  const queue = {
    list: async () => [...entries], metadata: async () => [...entries],
    head: async c => heads.get(hubNamespace(changeNamespace(c)).key) || { revision: 0, epoch: 4 },
    prepared: async c => prepared.get(c.entry.id) || null,
    prepare: async (c, value) => prepared.set(c.entry.id, value),
    acknowledge: async (c, head) => {
      const index = entries.findIndex(item => item.entry.id === c.entry.id);
      assert.ok(index >= 0, 'a durable journal entry cannot be acknowledged twice');
      heads.set(hubNamespace(changeNamespace(c)).key, head); entries.splice(index, 1);
      acknowledgements.push(c.entry.id); prepared.delete(c.entry.id);
    },
  };
  const no = () => {};
  const state = { locks, storage, entries, heads, calls, events, permits, clients, commitGates, commits, acknowledgements, manifestOrigins, remoteHeads, queue };
  state.add = (origin, count = 1, profileId = 'profile') => {
    const start = entries.length;
    for (let i = 0; i < count; i++) entries.push({
      entry: { id: 'journal-' + profileId + '-' + origin + '-' + (start + i), profileId, kind: 'local', origin, createdAt: start + i + 1, bytes: 64,
        payload: { change: { op: 'set', key: 'draft', value: 'durable-' + (start + i) }, revision: start + i + 1 } },
      database: 'native', store: 'journal', key: start + i + 1, arrayKeys: false,
    });
  };
  state.client = (profileId = 'profile') => {
    const session = { grant: { profileId, contextId: 'context', sessionId: 'session' } };
    const writerFor = group => ({ epoch: 4, contextId: 'context', siteGroup: group, expiresAt: new Date(Date.now() + 90000).toISOString() });
    const request = async (path = '', method = 'GET', body) => {
      calls.push({ path, method, body, profileId });
      if (path === '/writers') return { writer: writerFor(hubNamespace(body.namespace).siteGroup) };
      if (path === '/commits') {
        commits.push(body.idempotencyKey);
        const blocker = commitGates.get(body.namespace.origin); if (blocker) await blocker.promise;
        const key = hubNamespace(body.namespace).key, revision = remoteHeads.get(key) || 0;
        assert.equal(body.baseRevision, revision, 'commits must use the acknowledged current base');
        remoteHeads.set(key, revision + 1);
        return { acknowledged: true, revision: revision + 1 };
      }
      if (path === '/stream') {
        const revision = remoteHeads.get(hubNamespace(body.namespace).key) || 0;
        return body.headOnly ? { revision, snapshotRevision: revision, restoreBytes: 0, snapshotBytes: 0 }
          : { revision, snapshotRevision: revision, snapshot: null, journal: [] };
      }
      if (path === '') return { profileId, initialized: true, streams: [...manifestOrigins].map(origin => ({ namespace: ['local', origin, ''], revision: 0, snapshotRevision: 0 })), writers: [] };
      if (path === '/preferences') return { revision: 0, values: {} };
      if (path.startsWith('/receipts/')) throw Object.assign(Error('No receipt'), { status: 404 });
      throw Error('Unexpected request ' + method + ' ' + path);
    };
    const local = {
      queue, dispose: no, prepareQueueWire: async c => c.entry.payload, prepareWire: async v => v,
      pendingNamespaces: async () => entries.map(changeNamespace),
      readHead: async n => heads.get(hubNamespace(n).key) || null,
      setPermit: async p => permits.push(p), revokePermit: async () => true,
      beginHydration: async input => ({ input }), hydrateValue: async () => {},
      finishHydration: async handle => { heads.set(hubNamespace(handle.input.namespace).key, handle.input.head); },
      abortHydration: async () => {},
    };
    const localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k), get length() { return storage.size; }, key: i => [...storage.keys()][i] };
    const window = { setTimeout, clearTimeout, addEventListener: no, removeEventListener: no, dispatchEvent: event => events.push(event), document: { removeEventListener: no } };
    const globals = { window, navigator: { onLine: true, locks }, localStorage, indexedDB: {}, crypto: webcrypto, TextEncoder, TextDecoder, URL, Date, Error, Uint8Array, AbortController, DOMException, setTimeout, clearTimeout, clearInterval, queueMicrotask, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } };
    const imports = {
      './profile-sync-scheduler': { createProfileSyncScheduler }, './profile-chunk-restore': { restoreProfileChunks }, './profile-stream': { loadProfileStream, loadProfileStreamHead },
      './profile-wakeup': { watchProfileWriters: () => ({ closed: () => false, close: no }) }, './profile-checkpoint': { checkpointProfileGroup: no }, './profile-preferences': {},
      './profile-local-store': { createProfileLocalStore: () => local }, './hub-client-state': { getHubSession: () => session, registerHubInitializer: no, hubProfileRequest: request },
      '../../runtime/profile-limits.ts': {}, '../../runtime/profile-context': { setProfileDocumentGuard: no }, '../../runtime/profile-permissions': { invalidateProfilePermits: no }, '../../runtime/profile-store': {},
      '../../runtime/profile-sync': { drainProfileQueue, changeNamespace }, '../../runtime/hub-contracts': { hubNamespace, hubSiteGroup, HUB_LIMITS }, './model': { portableAtlasKey: () => false },
      './profile-errors': { temporaryProfileFailure }, './profile-import': {}, './profile-legacy-migration': {},
    };
    try {
      const helper = loadModule(new URL('../runtime/profile-locks.ts', import.meta.url), globals);
      imports['../../runtime/profile-locks'] = helper; imports['../../runtime/profile-locks.ts'] = helper;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const source = readFileSync(process.env.ATLAS_PROFILE_CLIENT_SOURCE || new URL('../web/src/profile-client.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source + '\n(globalThis as any).__client = new ProfileClient(getHubSession()!); active = (globalThis as any).__client;', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const context = { ...globals, exports: {}, require: name => {
      if (imports[name]) return imports[name];
      if (imports[name.replace(/\.ts$/, '')]) return imports[name.replace(/\.ts$/, '')];
      throw Error('Unexpected import ' + name);
    } };
    runInNewContext(compiled, context); const client = context.__client; client.ready = true;
    client.addReady = origin => { const group = hubSiteGroup(origin); client.writers.set(group, { namespace: { kind: 'local', origin }, writer: writerFor(group) }); client.readyGroups.set(group, 4); };
    clients.push(client); return client;
  };
  state.close = async () => { for (const blocker of commitGates.values()) blocker.release(); await Promise.allSettled(clients.map(c => c.flight)); for (const client of clients) client.stop(); };
  return state;
}

const alpha = 'https://alpha.example', beta = 'https://beta.test';

test('fresh unrelated website restores while another website cloud commit is blocked', async () => {
  const f = sharedState(), held = gate(); f.add(alpha); f.manifestOrigins.add(beta); f.commitGates.set(alpha, held);
  const client = f.client(); client.addReady(alpha); const backup = client.flush();
  const settled = Promise.allSettled([backup]); let opening;
  try {
    await eventually(() => f.commits.length > 0, 'background commit started');
    let ready = false; opening = client.ensureOrigin(beta).then(() => { ready = true; });
    await eventually(() => ready, 'unrelated website must not wait for another site upload');
    assert.equal(f.acknowledgements.length, 0, 'blocked upload remains genuinely unacknowledged');
    assert.ok(f.permits.some(p => p.group === 'beta.test' && !p.revoked));
  } finally { held.release(); await settled; await opening; await f.close(); }
});

test('same website hydration cannot pass its unacknowledged commit', async () => {
  const f = sharedState(), held = gate(); f.add(alpha); f.commitGates.set(alpha, held);
  const client = f.client(); client.addReady(alpha); const backup = client.flush(), settled = Promise.allSettled([backup]); let restoration;
  try {
    await eventually(() => f.commits.length > 0, 'background commit started');
    let restored = false; restoration = client.restore({ kind: 'local', origin: alpha }, 4).then(() => { restored = true; });
    for (let i = 0; i < 3; i++) await turn(); assert.equal(restored, false);
    held.release(); await restoration; await backup; assert.equal(f.acknowledgements.length, 1);
  } finally { held.release(); await settled; await restoration; await f.close(); }
});

test('same-site drain rereads durable queue after cross-window lock admission', async () => {
  const f = sharedState(), held = gate(); f.add(alpha, 3); f.commitGates.set(alpha, held);
  const first = f.client(), second = f.client(); first.addReady(alpha); second.addReady(alpha);
  const a = first.flush(), doneA = Promise.allSettled([a]); let b;
  try {
    await eventually(() => f.commits.length > 0, 'first window commit started');
    b = second.flush(); const doneB = Promise.allSettled([b]); await turn(); held.release();
    assert.ok((await Promise.all([doneA, doneB])).flat().every(value => value.status === 'fulfilled'));
    assert.equal(f.commits.length, 3, 'another window must not replay already acknowledged entries from a stale snapshot');
    assert.equal(new Set(f.acknowledgements).size, 3); assert.equal(f.entries.length, 0);
  } finally { held.release(); await doneA; await Promise.allSettled([b]); await f.close(); }
});

test('long same-site backlog yields its lock so queued hydration is admitted between batches', async () => {
  const f = sharedState(), held = gate(); f.add(alpha, 24); f.commitGates.set(alpha, held);
  const client = f.client(); client.addReady(alpha); const backup = client.flush(), done = Promise.allSettled([backup]); let restoration;
  try {
    await eventually(() => f.commits.length > 0, 'first batch commit started');
    let countAtRestore;
    restoration = client.restore({ kind: 'local', origin: alpha }, 4).then(() => { countAtRestore = f.acknowledgements.length; });
    await turn(); held.release(); await restoration;
    assert.ok(countAtRestore > 0 && countAtRestore < 24, 'hydration should enter after a bounded batch, not after the complete backlog');
    await backup; assert.equal(f.entries.length, 0); assert.equal(f.commits.length, 24);
  } finally { held.release(); await done; await restoration; await f.close(); }
});

function helperFixture() {
  const locks = lockManager();
  return { locks, ...loadModule(new URL('../runtime/profile-locks.ts', import.meta.url), { navigator: { locks } }) };
}

test('group lock keeps mixed-version old account-exclusive operations mutually exclusive', async () => {
  const f = helperFixture(), held = gate(); let oldEntered = false, groupEntered = false;
  const old = f.locks.request('atlas-profile-drain:profile', async () => { oldEntered = true; await held.promise; });
  await eventually(() => oldEntered, 'old-version lock acquired');
  const next = f.withProfileGroupLock('profile', 'alpha.example', async () => { groupEntered = true; });
  await turn(); assert.equal(groupEntered, false, 'new client must not race an old exclusive account drain');
  held.release(); await Promise.all([old, next]); assert.equal(groupEntered, true);
});

test('group locks isolate accounts and sites and release both levels after a rejected task', async () => {
  const f = helperFixture(), held = gate(); let firstEntered = false;
  const first = f.withProfileGroupLock('profile', 'alpha.example', async () => { firstEntered = true; await held.promise; throw Error('deliberate failure'); });
  const outcome = Promise.allSettled([first]); await eventually(() => firstEntered, 'first group acquired');
  let otherSite = false, otherAccount = false, sameGroup = false;
  const b = f.withProfileGroupLock('profile', 'beta.test', async () => { otherSite = true; });
  const c = f.withProfileGroupLock('other-profile', 'alpha.example', async () => { otherAccount = true; });
  const d = f.withProfileGroupLock('profile', 'alpha.example', async () => { sameGroup = true; });
  await eventually(() => otherSite && otherAccount, 'independent site/account can run'); assert.equal(sameGroup, false);
  held.release(); const failed = await outcome; await Promise.all([b, c, d]);
  assert.equal(failed[0].status, 'rejected'); assert.match(failed[0].reason.message, /deliberate failure/); assert.equal(sameGroup, true);
  let exclusive = false; await f.locks.request('atlas-profile-drain:profile', () => { exclusive = true; }); assert.equal(exclusive, true);
});

test('repair isolates its website while an unrelated fresh website can restore', async () => {
  const f = sharedState(), held = gate(); f.add(alpha); f.manifestOrigins.add(alpha); f.manifestOrigins.add(beta);
  const client = f.client(); client.addReady(alpha);
  // Archive transport/content is tested by profile-sync-repair. Here its gate
  // keeps the actual repair coordinator and resource lock genuinely occupied.
  let archivalStarted = false;
  client.recoverLocal = async () => { archivalStarted = true; await held.promise; f.entries.splice(0, f.entries.length); };
  const repair = client.repairSync(), done = Promise.allSettled([repair]); let same, other;
  try {
    await eventually(() => archivalStarted, 'repair entered the archive step under its website lock');
    let sameReady = false, otherReady = false;
    same = client.restore({ kind: 'local', origin: alpha }, 4).then(() => { sameReady = true; });
    other = client.ensureOrigin(beta).then(() => { otherReady = true; });
    await eventually(() => otherReady, 'unrelated website must not wait for a repair archive upload');
    assert.equal(sameReady, false, 'same website remains excluded throughout repair');
    assert.equal(f.entries.length, 1, 'unfinished archival cannot discard pending native data');
    held.release(); await repair; await same; assert.equal(f.entries.length, 0);
  } finally { held.release(); await done; await Promise.allSettled([same, other]); await f.close(); }
});

test('repair of one website does not suppress pending backup discovery for another', async () => {
  const f = sharedState(); f.add(beta); const client = f.client();
  client.repairFlight = new Promise(() => {});
  f.storage.set('atlas.profile.repair.pending:profile', JSON.stringify([{ kind: 'local', origin: alpha }]));
  let discovered = 0;
  client.backgroundBackup = () => ({ pending: () => false, reconcileDirty: () => { discovered++; }, stop: () => {} });
  try { await client.checkPendingBackups(); assert.equal(discovered, 1); }
  finally { client.repairFlight = undefined; await f.close(); }
});

test('unrelated takeover proceeds during repair and keeps recovery plus hydration atomic with uploads', async () => {
  const f = sharedState(), held = gate(); f.add(beta); f.manifestOrigins.add(beta); const client = f.client();
  client.repairFlight = new Promise(() => {});
  f.storage.set('atlas.profile.repair.pending:profile', JSON.stringify([{ kind: 'local', origin: alpha }]));
  const original = client.request.bind(client);
  client.request = async (path, method, body) => path === '/writers/takeover' ? { available: true } : original(path, method, body);
  let archivalStarted = false;
  client.recoverLocal = async () => {
    archivalStarted = true; await held.promise;
    f.entries.splice(0, f.entries.length); // The acknowledged archive retired these exact entries.
  };
  const takeover = client.takeover(beta), done = Promise.allSettled([takeover]); let backup;
  try {
    await eventually(() => archivalStarted, 'independent takeover reached native recovery despite repair elsewhere');
    await assert.rejects(client.takeover(alpha), /synchronization repair/);
    backup = client.flush(); const backupDone = Promise.allSettled([backup]);
    for (let i = 0; i < 3; i++) await turn();
    assert.equal(f.commits.length, 0, 'cloud drain cannot race recovery before hydration publishes the new site head');
    held.release(); await takeover; await backupDone;
    assert.equal(f.commits.length, 0, 'retired archive entries cannot be replayed after taking over');
    assert.ok(f.permits.some(p => p.group === 'beta.test' && !p.revoked));
  } finally { held.release(); await done; await Promise.allSettled([backup]); client.repairFlight = undefined; await f.close(); }
});

test('handoff does not fence a website until an earlier same-site restore releases its lock', async () => {
  const f = sharedState(), held = gate(); f.add(beta); const client = f.client(); client.addReady(beta);
  const original = client.request.bind(client); let discovered = false;
  client.request = async (path, method, body) => {
    if (path === '/writers/requests') { discovered = true; return { requests: [{ id: 'handoff-beta', siteGroup: 'beta.test', epoch: 4 }] }; }
    if (path === '/writers/requests/handoff-beta/ack') return { acknowledged: true };
    return original(path, method, body);
  };
  let restoring = false;
  const restore = f.locks.request('atlas-profile-group:' + JSON.stringify(['profile', 'beta.test']), async () => { restoring = true; await held.promise; });
  await eventually(() => restoring, 'earlier restore acquired the site lock');
  const transfer = client.releaseRequestedGroups(), done = Promise.allSettled([transfer]);
  try {
    await eventually(() => discovered, 'handoff discovered');
    for (let i = 0; i < 3; i++) await turn();
    assert.equal(f.permits.some(p => p.group === 'beta.test' && p.revoked), false, 'handoff fence must not race a restoring permit');
    held.release(); await restore; await transfer;
    assert.equal(f.acknowledgements.length, 1); assert.equal(client.releases.size, 0);
  } finally { held.release(); await restore; await done; await f.close(); }
});

test('short repair marker updates preserve independent groups across windows', async () => {
  const f = sharedState(), first = f.client(), second = f.client();
  try {
    await Promise.all([
      first.updateRepairMarker('alpha.example', [{ kind: 'local', origin: alpha }]),
      second.updateRepairMarker('beta.test', [{ kind: 'local', origin: beta }]),
    ]);
    let record = JSON.parse(f.storage.get('atlas.profile.repair.pending:profile'));
    assert.deepEqual(record.map(n => n.origin).sort(), [alpha, beta].sort());
    await first.updateRepairMarker('alpha.example', []);
    record = JSON.parse(f.storage.get('atlas.profile.repair.pending:profile'));
    assert.deepEqual(record.map(n => n.origin), [beta]);
  } finally { await f.close(); }
});
