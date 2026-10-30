/** Native cookie-cache operation counts and ordering; no latency benchmark. */
import Fastify from 'fastify';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const evidence = resolve(process.env.ATLAS_COOKIE_MRU_EVIDENCE || 'evidence/performance-remediation-20261029/cookie-warm-header');
const source = resolve(process.env.ATLAS_COOKIE_MRU_SOURCE || 'runtime/local-cookie-jar-v2.ts');
const baseline = process.env.ATLAS_COOKIE_MRU_BASELINE === '1';
await mkdir(evidence, { recursive: true });
const bytes = await readFile(source), code = (await build({ stdin: { contents: bytes.toString(), resolveDir: resolve('runtime'), sourcefile: source, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' })).outputFiles[0].text;
const app = Fastify({ logger: false });
app.get('/', (_q, r) => r.type('text/html').send('<!doctype html><title>Cookie header MRU correctness</title>'));
app.get('/jar.js', (_q, r) => r.type('application/javascript').send(code));
let browser;
const report = { command: 'node tests/cookie-header-mru-browser.mjs', variant: baseline ? 'baseline' : 'modified', sourceSHA256: createHash('sha256').update(bytes).digest('hex'), scope: 'Real LocalCookieJarV2/native IndexedDB, synthetic isolated browser context, private Map operation counts and cache semantics. No CPU timing or device qualification.' };
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  report.browser = browser.version();
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); await page.goto(origin);
  report.checks = await page.evaluate(async baseline => {
    const { LocalCookieJarV2 } = await import('/jar.js');
    const authority = { version: 2, profileId: '11111111-1111-4111-8111-111111111111', replicaId: '22222222-2222-4222-8222-222222222222', localAuthGeneration: 'mru_generation_0123456789', browserSessionId: 'mru_session_0123456789' };
    let now = 1700000000000, reads = 0, commits = 0;
    const jar = new LocalCookieJarV2({ factory: indexedDB, profileId: authority.replicaId, localAuthority: authority, browserSessionId: authority.browserSessionId, forbiddenOrigins: [location.origin], now: () => now, onNativeCommit: () => commits++ });
    const ctx = url => ({ requestURL: url, documentURL: url, topLevelURL: url, credentials: 'include', method: 'GET' });
    const a = ctx('https://alpha.test/a'), b = ctx('https://beta.test/b');
    const names = [], check = (condition, name) => { if (!condition) throw Error(name); names.push(name); };
    const nativeGetAll = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function (...args) { reads++; return Reflect.apply(nativeGetAll, this, args); };
    const map = jar.headerViews, set = map.set, drop = map.delete;
    let sets = 0, deletes = 0;
    map.set = function (...args) { sets++; return Reflect.apply(set, this, args); };
    map.delete = function (...args) { deletes++; return Reflect.apply(drop, this, args); };
    const counts = () => ({ sets, deletes }), reset = () => { sets = deletes = 0; };
    const keyFor = input => JSON.stringify([new URL(input.requestURL).origin, new URL(input.requestURL).pathname, new URL(input.documentURL).origin, 'https://' + new URL(input.documentURL).hostname, new URL(input.topLevelURL).origin, input.method, false, true, true]);
    const keyA = keyFor(a), keyB = keyFor(b);
    try {
      await jar.storeResponseCookies(['session=one;Secure;Path=/;SameSite=Lax'], a);
      await jar.storeResponseCookies(['other=two;Secure;Path=/;SameSite=Lax'], b);
      check(await jar.getRequestHeader(a) === 'session=one', 'warm HTTP header is correct');
      const view = map.get(keyA), nativeReads = reads, nativeCommits = commits;
      reset();
      for (let i = 0; i < 100; i++) check(await jar.getRequestHeader(a) === 'session=one', 'warm repeated value ' + i);
      const warm = counts();
      check(warm.sets === (baseline ? 100 : 0) && warm.deletes === (baseline ? 100 : 0), 'already-MRU100hits map operations match baseline/candidate');
      check(map.get(keyA) === view && reads === nativeReads && commits === nativeCommits, 'warm hits retain exact view identity and perform no native read/write');
      await jar.getRequestHeader(b); reset();
      for (let i = 0; i < 10; i++) await jar.getRequestHeader(i % 2 ? b : a);
      check(sets === 10 && deletes === 10, 'non-MRU hits still promote on every alternation');
      check(JSON.stringify([...map.keys()]) === JSON.stringify([keyA, keyB]), 'alternation preserves exact LRU ordering');
      reset(); await jar.getRequestHeader({ ...b, requestURL: b.requestURL + '?version=2#ignored' });
      check(sets === (baseline ? 1 : 0) && deletes === (baseline ? 1 : 0), 'query/hash identity equivalence is unchanged');
      const beforeSiteChange = map.get(keyB);
      await jar.storeResponseCookies(['session=changed;Secure;Path=/;SameSite=Lax'], a);
      check(!map.has(keyA) && map.get(keyB) === beforeSiteChange, 'site invalidation removes only affected views');
      reset(); await jar.getRequestHeader(b);
      check(sets === (baseline ? 1 : 0) && deletes === (baseline ? 1 : 0), 'unrelated invalidation retains current MRU hint');
      await jar.getRequestHeader(a); check(map.get(keyA).view.value === 'session=changed', 'affected view refreshes after native commit');
      jar.dropView(keyA); check(!map.has(keyA), 'explicit MRU removal drops its view');
      await jar.getRequestHeader(a); reset(); await jar.getRequestHeader(a);
      check(sets === (baseline ? 1 : 0) && deletes === (baseline ? 1 : 0), 'reinserted view establishes current MRU');
      await jar.storeResponseCookies(['soon=temporary;Secure;Path=/a;Max-Age=1'], a);
      check((await jar.getRequestHeader(a)).includes('soon=temporary'), 'expiring cookie is visible before its boundary');
      now += 1000;
      check(await jar.getRequestHeader(a) === 'session=changed', 'exact expiry boundary rebuilds rather than reuses stale MRU');
      const nativeBeforeClear = reads;
      jar.invalidateViews(); check(map.size === 0 && jar.headerViewBytes === 0, 'global invalidation clears views and byte accounting');
      await jar.getRequestHeader(a); check(reads === nativeBeforeClear + 1, 'global invalidation still performs authoritative native partition read');
      reset(); await jar.getRequestHeader(a);
      check(sets === (baseline ? 1 : 0) && deletes === (baseline ? 1 : 0), 'post-reset insertion restores the MRU optimization');
      // Fill the derived-view cap, then compare with a simple insertion-order LRU.
      jar.invalidateViews(); const order = new Map();
      for (let i = 0; i < 260; i++) {
        const item = ctx('https://alpha.test/path-' + i), key = keyFor(item);
        await jar.getRequestHeader(item); if (order.has(key)) order.delete(key);
        if (order.size >= 256) order.delete(order.keys().next().value); order.set(key, true);
      }
      check(map.size === 256 && JSON.stringify([...map.keys()]) === JSON.stringify([...order.keys()]), 'derived-view256entry eviction order stays exact');
      const last = ctx('https://alpha.test/path-259'); reset(); await jar.getRequestHeader(last);
      check(sets === (baseline ? 1 : 0) && deletes === (baseline ? 1 : 0), 'eviction leaves newest view as MRU');
      const firstRetained = ctx('https://alpha.test/path-4'); await jar.getRequestHeader(firstRetained);
      order.delete(keyFor(firstRetained)); order.set(keyFor(firstRetained), true);
      check(JSON.stringify([...map.keys()]) === JSON.stringify([...order.keys()]), 'oldest retained hit still changes eviction priority');
      const newItem = ctx('https://alpha.test/after-cap'); await jar.getRequestHeader(newItem); order.delete(order.keys().next().value); order.set(keyFor(newItem), true);
      check(JSON.stringify([...map.keys()]) === JSON.stringify([...order.keys()]), 'subsequent admission evicts the same oldest view');
      // Abort and authorization checks remain before the fast cached return.
      const ac = new AbortController(); ac.abort(new DOMException('fixture abort', 'AbortError'));
      let aborted = false; try { await jar.getRequestHeader({ ...newItem, signal: ac.signal }); } catch (e) { aborted = e.name === 'AbortError'; }
      check(aborted, 'aborted read cannot bypass pre-cache signal check');
      return { warm100: warm, alternating10: { sets: 10, deletes: 10 }, assertions: names.length, names, semanticScope: 'Same exact header eligibility, query/path context, invalidation, expiry, view identity, count cap, native IO, abort and LRU order.' };
    } finally { IDBIndex.prototype.getAll = nativeGetAll; await jar.close(); }
  }, baseline);
  assert.deepEqual(errors, []); report.result = 'PASS'; report.pageErrors = errors;
  console.log('COOKIE_HEADER_MRU=' + (baseline ? 'BASELINE' : 'MODIFIED') + ';PASS;warm100=' + JSON.stringify(report.checks.warm100) + ';LRU/expiry/invalidation/256cap preserved');
  await context.close();
} catch (error) { report.result = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally { await writeFile(resolve(evidence, baseline ? 'BASELINE.json' : 'MODIFIED.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await app.close(); }
