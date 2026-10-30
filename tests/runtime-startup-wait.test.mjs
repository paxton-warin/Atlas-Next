import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const migration = await readFile(new URL('../runtime/runtime-migration.ts', import.meta.url), 'utf8');
const host = await readFile(new URL('../runtime/host.ts', import.meta.url), 'utf8');
const relay = await readFile(new URL('../runtime/relay-controller.ts', import.meta.url), 'utf8');
const flush = () => new Promise(setImmediate);
function transpile(text) { return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('export async function', 'async function').replaceAll('export function', 'function'); }
function declared(text, names) { const parsed = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true); return parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(parsed)).join('\n'); }
function fixture(extra = {}) {
  const timers = new Map(); let id = 0;
  const globals = { Promise, Error, Map, Set, URL, AbortController, console, setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(n) { timers.delete(n); }, ...extra };
  runInNewContext(transpile(migration) + ';globalThis.wait=waitForRuntimeStartup;', globals);
  return { globals, timers, wait: globals.wait };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
test('25s warning leaves genuine readiness pending; later success cleans timer and abort listener', async () => {
  const f = fixture(), work = deferred(), owner = new AbortController(); let slow = 0, result;
  const pending = f.wait(work.promise, { signal: owner.signal, slowAfterMs: 25000, onSlow() { slow++; } }).then(value => result = value);
  assert.equal([...f.timers.values()][0].ms, 25000); [...f.timers.values()][0].fn(); await flush();
  assert.equal(slow, 1); assert.equal(result, undefined); work.resolve('ready-after-26s'); await pending; assert.equal(result, 'ready-after-26s'); assert.equal(f.timers.size, 0);
  owner.abort(new Error('late owner')); assert.equal(result, 'ready-after-26s');
});
test('WASM/cookie error remains exact and fatal; slow callback exception cannot turn success into failure', async () => {
  const f = fixture(), failure = new Error('actual WASM fetch failure'); await assert.rejects(f.wait(Promise.reject(failure), { slowAfterMs: 25000 }), error => error === failure); assert.equal(f.timers.size, 0);
  const work = deferred(), pending = f.wait(work.promise, { slowAfterMs: 25000, onSlow() { throw Error('presentation only'); } }); [...f.timers.values()][0].fn(); work.resolve(1); assert.equal(await pending, 1); assert.equal(f.timers.size, 0);
});
test('canceled local readiness wait consumes late failure and removes its slow timer', async () => {
  const f = fixture(), work = deferred(), owner = new AbortController(), reason = new Error('root disposed'); const pending = f.wait(work.promise, { signal: owner.signal, slowAfterMs: 25000 }); owner.abort(reason); await assert.rejects(pending, error => error === reason); assert.equal(f.timers.size, 0); work.reject(new Error('late native failure')); await flush();
});
function relayFixture() {
  const scripts = [], removed = [], creations = []; const owner = new AbortController();
  const window = { HttpEngineTransport: { HttpEngineClient: class { constructor(config) { creations.push(['transport', config]); } } }, $runtimekitController: { config: {}, Controller: class { constructor(config) { creations.push(['controller', config]); } } } };
  const document = { createElement() { const script = { remove() { removed.push(script); } }; return script; }, head: { appendChild(script) { scripts.push(script); } } };
  const f = fixture({ window, document, location: { protocol: 'https:' } }); runInNewContext(transpile(relay) + ';globalThis.create=createRelayController;', f.globals); return { ...f, scripts, removed, creations, owner };
}
test('pending script cancellation removes handlers/element and never constructs late Controller', async () => {
  const f = relayFixture(), reason = new Error('root pagehide'), pending = f.globals.create({}, 'https://node.example', 'opaque-ticket', undefined, f.owner.signal); assert.equal(f.scripts.length, 1); const late = f.scripts[0].onload; f.owner.abort(reason); await assert.rejects(pending, error => error === reason); assert.equal(f.removed.length, 1); assert.equal(f.scripts[0].onload, null); assert.equal(f.scripts[0].onerror, null); late(); await flush(); assert.equal(f.scripts.length, 1); assert.equal(f.creations.length, 0);
});
test('sequential script dependencies and real asset failures remain intact', async () => {
  const f = relayFixture(), pending = f.globals.create({}, 'https://node.example', 'opaque-ticket', undefined, f.owner.signal); for (let i = 0; i < 4; i++) { assert.equal(f.scripts.length, i + 1); f.scripts[i].onload(); await flush(); } await pending; assert.equal(f.creations.length, 2); assert.equal(f.removed.length, 4);
  const broken = relayFixture(), failure = broken.globals.create({}, 'https://node.example', 'opaque-ticket', undefined, broken.owner.signal); broken.scripts[0].onerror(); await assert.rejects(failure, /Browsing asset failed to load/); assert.equal(broken.creations.length, 0); assert.equal(broken.removed.length, 1);
});
function navigationFixture() {
  const startup = deferred(), created = [], notices = [], owners = new Map(), records = new Map(), lifetime = new AbortController();
  const f = fixture({ navigationOwners: owners, records, runtimeLifetime: lifetime, startupSlowMessage: undefined, ensureInitialization: () => startup.promise, notify(type, data) { notices.push({ type, ...data }); }, createRecord(id, engine) { const record = { engine, element: { hidden: false, remove() {} }, frame: { go(url) { created.push({ id, url }); return Promise.resolve(); } } }; records.set(id, record); return record; }, controller: { frames: [], abortFrameRequests() {} }, diagnosticModes: new Map(), popups: new Map() });
  runInNewContext(transpile(declared(host, ['navigate', 'destroy'])) + ';globalThis.go=navigate;globalThis.close=destroy;', f.globals);
  return { ...f, startup, created, notices, records, owners, lifetime };
}
test('closed pending tab is not recreated when slow shared initialization finally resolves', async () => {
  const f = navigationFixture(), pending = f.globals.go('closed', 'https://one.example/', 'runtime'); f.globals.close('closed'); f.startup.resolve(); await pending; assert.equal(f.created.length, 0); assert.equal(f.records.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.owners.size, 0);
});
test('superseded pending navigation opens only final destination; live tabs are not discarded', async () => {
  const f = navigationFixture(), first = f.globals.go('same', 'https://first.example/', 'runtime'), second = f.globals.go('same', 'https://last.example/', 'runtime'); f.startup.resolve(); await Promise.all([first, second]); assert.deepEqual(f.created, [{ id: 'same', url: 'https://last.example/' }]); assert.equal(f.records.size, 1); assert.equal(f.owners.size, 0); assert.equal(f.timers.size, 1);
});
test('owner teardown during pending startup emits no late error, warning, or frame', async () => {
  const f = navigationFixture(), pending = f.globals.go('closed-root', 'https://one.example/', 'runtime'); f.lifetime.abort(); f.startup.reject(f.lifetime.signal.reason); await pending; assert.equal(f.created.length, 0); assert.equal(f.notices.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.owners.size, 0);
});
test('actual host startup routes only soft15/25s observers, keeps reviewed opaque proof deadline', () => {
  const init = declared(host, ['init']); assert.match(init, /activateWorker\("\/worker\.js",\s*\{\s*signal/); assert.match(init, /waitForRuntimeStartup\(initialize\(\),/); assert.match(init, /slowAfterMs:\s*25000/); assert.match(init, /await created\.wait\(\)/); assert.doesNotMatch(init, /Promise\.race|timed out/); assert.match(host, /renderer_resource_timeout/); assert.match(host, /\}, 15000\)/);
});
function initializationFixture() {
  const gate = deferred(), lifetime = new AbortController(), counts = { sockets: 0, channels: 0, sessions: 0 }, notices = [];
  const created = { config: {}, runtimekitConfig: { flags: {} }, transport: { session: { close() { counts.sessions++; } } }, disposeRequestChannel() { counts.channels++; }, wait() { return gate.promise; } };
  const f = fixture({ runtimeLifetime: lifetime, initialization: undefined, controller: undefined, profileBridge: {}, config: { relayOrigin: 'https://node.example', relayTicket: 'opaque-ticket' }, bootstrap: { loadRest() { throw Error('unexpected fallback'); } }, activateWorker: async () => ({}), createRelayController: async () => created, neutralizeScramjetCookies() {}, encodeTarget() {}, decodeTarget() {}, installProfileWebSocketTransport() { return () => counts.sockets++; }, startupSlow(message) { notices.push(message); }, startupSlowMessage: undefined, controllerCleanups: new WeakMap(), disposedControllers: new WeakSet() });
  f.globals.activateWorker = async () => ({});
  let text = declared(host, ['init', 'ensureInitialization', 'disposeController']);
  text = text.replace('const { loadRest } = await import(/* @vite-ignore */ bootstrapPath);', 'const { loadRest } = bootstrap;');
  runInNewContext(transpile(text) + ';globalThis.initialize=ensureInitialization;globalThis.dispose=disposeController;', f.globals);
  lifetime.signal.addEventListener('abort', () => f.globals.dispose(f.globals.controller));
  return { ...f, gate, lifetime, counts, notices, created };
}
test('actual host initialization stays live after25s; real failure releases exact profile wrapper/channel/session once', async () => {
  const f = initializationFixture(), pending = f.globals.initialize(); await flush(); assert.equal(f.globals.controller, f.created); [...f.timers.values()].find(timer => timer.ms === 25000).fn(); assert.equal(f.notices.length, 1); assert.deepEqual(f.counts, { sockets: 0, channels: 0, sessions: 0 });
  const failure = new Error('actual cookie readiness failure'); f.gate.reject(failure); await assert.rejects(pending, error => error === failure); assert.deepEqual(f.counts, { sockets: 1, channels: 1, sessions: 1 }); assert.equal(f.globals.controller, undefined); assert.equal(f.timers.size, 0); f.lifetime.abort(); assert.deepEqual(f.counts, { sockets: 1, channels: 1, sessions: 1 });
});
test('actual host owner-abort disposes current construction and late ready cannot revive it', async () => {
  const f = initializationFixture(), pending = f.globals.initialize(); await flush(); f.lifetime.abort(); await assert.rejects(pending, error => error === f.lifetime.signal.reason); assert.deepEqual(f.counts, { sockets: 1, channels: 1, sessions: 1 }); assert.equal(f.timers.size, 0); f.gate.resolve(); await flush(); assert.deepEqual(f.counts, { sockets: 1, channels: 1, sessions: 1 }); assert.equal(f.globals.controller, undefined);
});
