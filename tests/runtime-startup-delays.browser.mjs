/** Actual native Chrome ServiceWorker install and Controller/WASM delayed startup.
 * Delays exceed the former 15s/25s fatal deadlines. Dummy transport isolates
 * readiness; this is not website/WSS or physical-device performance evidence. */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import ts from 'typescript';
const E = resolve(process.env.ATLAS_STARTUP_EVIDENCE || 'evidence/loading-startup-20261030/transport-startup'); await mkdir(E, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
const migration = await readFile('runtime/runtime-migration.ts', 'utf8');
const js = ts.transpileModule(migration, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const assets = Object.fromEntries(await Promise.all([
  ['/runtime/runtimekit-normal.js', 'runtime/public/runtime/runtimekit-normal.js'],
  ['/runtime/runtimekit-utils.js', 'runtime/public/runtime/runtimekit-utils.js'],
  ['/controller/controller.api.js', 'runtime/public/controller/controller.api.js'],
  ['/controller/controller.worker.js', 'runtime/public/controller/controller.worker.js'],
  ['/runtime/runtimekit.wasm', 'runtime/public/runtime/runtimekit.wasm'],
].map(async ([url, path]) => [url, await readFile(path)])));
const held = new Map(), requests = [], rows = []; let holdInstall = true, holdWasm = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = createServer((q, r) => {
  const path = new URL(q.url, 'http://fixture.invalid').pathname; requests.push({ path, at: Date.now() });
  r.setHeader('cache-control', 'no-store');
  if (path === '/worker.js') { r.setHeader('content-type', 'application/javascript'); r.end("importScripts('/controller/controller.worker.js');" + (holdInstall ? "self.addEventListener('install',event=>event.waitUntil(fetch('/hold-install')));" : '')); return; }
  if (path === '/hold-install' || (path === '/runtime/runtimekit.wasm' && holdWasm)) { held.set(path, r); return; }
  if (path === '/migration.js') { r.setHeader('content-type', 'application/javascript'); r.end(js); return; }
  if (assets[path]) { r.setHeader('content-type', path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript'); r.end(assets[path]); return; }
  r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>Startup deadline regression</title><h1>Native delayed readiness</h1>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
function release(path) { const response = held.get(path); held.delete(path); if (response) { response.setHeader('content-type', path.endsWith('.wasm') ? 'application/wasm' : 'text/plain'); response.end(assets[path] || 'released'); } }
async function waitHeld(path) { for (let i = 0; i < 1000 && !held.has(path); i++) await sleep(10); assert.ok(held.has(path), path + ' must reach native held operation'); }
let report;
try {
  const context = await browser.newContext(), page = await context.newPage(); await page.goto(origin);
  await page.evaluate(async () => {
    window.startupModule = await import('/migration.js'); window.owner = new AbortController(); window.slowWorker = 0; window.workerStarted = performance.now(); window.workerState = 'pending'; localStorage.setItem('startup-retained', 'native-sentinel');
    window.workerPending = startupModule.activateWorker('/worker.js', { signal: owner.signal, onSlow() { slowWorker++; } }).then(worker => { window.selected = worker; workerState = 'ready'; return { state: worker.state, controlled: worker === navigator.serviceWorker.controller, delay: performance.now() - workerStarted }; }, error => { workerState = 'failed'; throw error; });
  });
  await waitHeld('/hold-install'); await sleep(16100);
  const duringInstall = await page.evaluate(() => ({ state: workerState, slow: slowWorker, elapsed: performance.now() - workerStarted })); assert.equal(duringInstall.state, 'pending'); assert.equal(duringInstall.slow, 1); assert.ok(duringInstall.elapsed > 15000); release('/hold-install');
  const activated = await page.evaluate(() => workerPending); assert.equal(activated.state, 'activated'); assert.equal(activated.controlled, true); rows.push({ case: 'native-install-over-15s', duringInstall, activated });
  holdInstall = false; holdWasm = true;
  await page.evaluate(async () => {
    const load = src => new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.append(script); });
    for (const src of ['/runtime/runtimekit-normal.js', '/controller/controller.api.js', '/runtime/runtimekit-utils.js']) await load(src);
    $runtimekitController.config.wasmPath = '/runtime/runtimekit.wasm'; window.controller = new $runtimekitController.Controller({ serviceworker: selected, transport: {} });
    window.slowEngine = 0; window.engineStarted = performance.now(); window.engineState = 'pending';
    window.enginePending = startupModule.waitForRuntimeStartup(controller.wait(), { signal: owner.signal, slowAfterMs: 25000, onSlow() { slowEngine++; } }).then(() => { engineState = 'ready'; return { delay: performance.now() - engineStarted, retained: localStorage.getItem('startup-retained') }; }, error => { engineState = 'failed'; throw error; });
  });
  await waitHeld('/runtime/runtimekit.wasm'); await sleep(26100);
  const duringWasm = await page.evaluate(() => ({ state: engineState, slow: slowEngine, elapsed: performance.now() - engineStarted })); assert.equal(duringWasm.state, 'pending'); assert.equal(duringWasm.slow, 1); assert.ok(duringWasm.elapsed > 25000); release('/runtime/runtimekit.wasm');
  const ready = await page.evaluate(() => enginePending); assert.equal(ready.retained, 'native-sentinel'); rows.push({ case: 'actual-pinned-controller-wasm-over-25s', duringWasm, ready });
  await page.evaluate(() => { controller.disposeRequestChannel(); owner.abort(); }); await context.close();
  // Browser-owned installation may finish after its requesting root cancels.
  // The canceled local owner must never adopt it or erase retained state.
  holdInstall = true; holdWasm = false;
  const canceledContext = await browser.newContext(), canceledPage = await canceledContext.newPage(); await canceledPage.goto(origin);
  await canceledPage.evaluate(async () => {
    const migration = await import('/migration.js'); window.owner = new AbortController(); window.selectedAfterClose = false; window.slowAfterClose = 0; localStorage.setItem('startup-retained', 'cancel-sentinel');
    window.canceledPending = migration.activateWorker('/worker.js', { signal: owner.signal, onSlow() { slowAfterClose++; } }).then(() => { selectedAfterClose = true; return { resolved: true }; }, error => ({ resolved: false, name: error.name, exact: error === owner.signal.reason }));
  });
  await waitHeld('/hold-install'); await canceledPage.evaluate(() => owner.abort()); const canceled = await canceledPage.evaluate(() => canceledPending); assert.deepEqual(canceled, { resolved: false, name: 'AbortError', exact: true }); release('/hold-install');
  await canceledPage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const late = await canceledPage.evaluate(() => ({ selectedAfterClose, slowAfterClose, retained: localStorage.getItem('startup-retained') })); assert.deepEqual(late, { selectedAfterClose: false, slowAfterClose: 0, retained: 'cancel-sentinel' }); rows.push({ case: 'owner-cancel-while-installing', canceled, late }); await canceledContext.close();
  report = { result: 'PASS', browser: browser.version(), command: 'node tests/runtime-startup-delays.browser.mjs', sourceSHA256: sha(migration), scope: 'Native install >15s and actual pinned Controller/WASM >25s with dummy transport; no production or physical-device qualification.', rows, requests };
  console.log('STARTUP_DELAYS=PASS;native install>15s pending+slow then ready;Controller/WASM>25s pending+slow then ready;owner cancel exact+no late adoption;data retained');
} catch (error) { report = { result: 'FAIL', error: error.stack, rows, requests }; console.error(error); process.exitCode = 1; }
finally { await writeFile(E + '/DELAYED_BROWSER.json', JSON.stringify(report, null, 2) + '\n'); for (const path of [...held.keys()]) release(path); await browser.close(); await new Promise(r => server.close(r)); }
