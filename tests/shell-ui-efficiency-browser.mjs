import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import TabStrip from './TabStrip.tsx';import Catalog from './Catalog.tsx';import{createLocalFirstProfile}from'./local-first-profile.ts';import{readLocal,writeLocal}from'./model.ts';import{setActiveLocalAuthority,setActiveProfile}from'../../runtime/profile-context.ts';import './styles.css';import './v21-tokens.css';import './atlas-v21.css';
window.fixture={calls:[],pending:[],trackStyles:false,styleReads:0,changed:0};const nativeStyle=getComputedStyle;window.getComputedStyle=(...args)=>{if(fixture.trackStyles)fixture.styleReads++;return nativeStyle(...args)};const root=createRoot(document.querySelector('#mount')),noop=()=>{};const tabs=Array.from({length:20},(_,i)=>({id:'tab'+i,url:'https://example.test/'+i,title:'Synthetic tab '+i,engine:'runtime'}));
window.renderTabs=()=>flushSync(()=>root.render(<TabStrip tabs={[...tabs]} active="tab0" closedCount={1} previewEnabled={false} onActivate={noop} onNew={noop} onClose={noop} onPin={noop} onMove={noop} onStep={noop} onUndo={noop}/>));
const items=Array.from({length:60},(_,i)=>({id:'game'+i,name:'Game '+String(i).padStart(2,'0'),description:'Synthetic '+i,url:'https://example.test/'+i,category:i%2?'Arcade':'Puzzle',kind:'game',artwork:''}));window.renderCatalog=()=>flushSync(()=>root.render(<Catalog items={items} kind="game" launch={noop}/>));
window.state={enabled:true,authenticated:true,csrf:'synthetic',grant:{profileId:'11111111-1111-4111-8111-111111111111',sessionId:'synthetic-session',contextId:'synthetic-context'}};
window.openProfile=()=>createLocalFirstProfile(state,{current:()=>state,onStatus:noop},0,true);window.api={readLocal,writeLocal,setActiveProfile,setActiveLocalAuthority};
window.marker='atlas.profile.mirror-seeded.v1:'+state.grant.profileId+':22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333';window.preferencePrefix='atlas.profile.user:'+state.grant.profileId+':replica:22222222-2222-4222-8222-222222222222:';
renderTabs();`;
const output = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', outfile: 'fixture.js', logLevel: 'silent',
  plugins: [{ name: 'local-coordinator-seams', setup(b) {
    b.onResolve({ filter: /^\.\/(backup-v2-actor|replica-control-v2|local-receipt-probe-v2)\.ts$/ }, a => a.importer.endsWith('/local-first-profile.ts') ? { path: a.path, namespace: 'fixture-seam' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'fixture-seam' }, a => ({ loader: 'js', contents:
      a.path.includes('receipt-probe') ? 'export async function probeLocalReceiptsV2(){}' :
      a.path.includes('replica-control') ? `export function createReplicaControlV2(){return {async initialize(){return {account:{hasLocal:true,cloudChecked:true,replicaId:'22222222-2222-4222-8222-222222222222',incarnation:'33333333-3333-4333-8333-333333333333'}}},dispose(){}}}` :
      `export function createBackupV2Actor(){fixture.mirrored??=new Map();fixture.deferred??=new Set();fixture.generation??=0;return {initialize:async()=>{},status:()=>({state:'idle',message:'Saved locally',deferred:[]}),stop(){},dirty(){},foreground(){},async preferenceKeys(){return{keys:[...new Set([...fixture.mirrored.keys(),...fixture.deferred])]};},async latest(){return {checkpoint:null}},async preferences(values,deferred){fixture.calls.push({values:{...values},deferred:[...deferred]});if(Object.entries(values).every(([k,v])=>(v===null?!fixture.mirrored.has(k):fixture.mirrored.get(k)===v)&&!fixture.deferred.has(k))&&deferred.every(k=>fixture.deferred.has(k)))return false;await new Promise((resolve,reject)=>fixture.pending.push({resolve,reject}));for(const[k,v]of Object.entries(values)){fixture.deferred.delete(k);v===null?fixture.mirrored.delete(k):fixture.mirrored.set(k,v)}for(const k of deferred)fixture.deferred.add(k);fixture.generation++;return true;}}}` }));
  } }], stdin: { resolveDir: resolve('web/src'), contents: fixture, loader: 'tsx' } });
const js = output.outputFiles.find(f => f.path.endsWith('.js')).text,
  css = output.outputFiles.find(f => f.path.endsWith('.css')).text;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'application/javascript' : req.url === '/fixture.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/fixture.js' ? js : req.url === '/fixture.css' ? css : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><body class="atlas-v21" data-v21-theme="forest" data-v21-mode="dark"><main class="atlas" style="--accent:#123456;--text:var(--v21-text)"><div id="mount"></div></main><script type="module" src="/fixture.js"></script>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const report = { command: 'node tests/shell-ui-efficiency-browser.mjs', checks: {}, qualification: 'Synthetic focused correctness and operation-count checks; no device latency qualification.' };
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => typeof renderTabs === 'function');
  report.checks.closedPortal = await page.evaluate(() => { fixture.styleReads = 0; fixture.trackStyles = true; for (let i = 0; i < 40; i++) renderTabs(); fixture.trackStyles = false; return { renders: 40, computedStyleReads: fixture.styleReads }; });
  assert.equal(report.checks.closedPortal.computedStyleReads, 0);
  await page.getByRole('button', { name: 'Search open tabs', exact: true }).click();
  await page.getByRole('dialog', { name: 'Search open tabs' }).waitFor();
  report.checks.portalThemes = [];
  for (const theme of ['forest', 'sand', 'violet', 'ocean', 'rose', 'ink']) for (const mode of ['light', 'dark']) {
    await page.evaluate(({ theme, mode }) => {
      document.body.dataset.v21Theme = theme; document.body.dataset.v21Mode = mode;
      const shell = document.querySelector('.atlas'); shell.dataset.v21Theme = theme; shell.dataset.mode = mode;
    }, { theme, mode });
    await page.waitForFunction(() => {
      const portal = document.querySelector('[data-atlas-tab-portal]'), shell = document.querySelector('.atlas');
      return portal && getComputedStyle(portal).getPropertyValue('--canvas') === getComputedStyle(shell).getPropertyValue('--canvas');
    });
    const result = await page.evaluate(async ({ theme, mode }) => {
      const shell = document.querySelector('.atlas');
      const portal = document.querySelector('[data-atlas-tab-portal]'), a = getComputedStyle(shell), b = getComputedStyle(portal);
      return { theme, mode, canvas: b.getPropertyValue('--canvas').trim(), expectedCanvas: a.getPropertyValue('--canvas').trim(), accent: b.getPropertyValue('--accent').trim() };
    }, { theme, mode });
    assert.equal(result.canvas, result.expectedCanvas); assert.equal(result.accent, '#123456'); report.checks.portalThemes.push(result);
  }
  await page.getByRole('textbox', { name: 'Find an open tab' }).fill('Synthetic tab 19');
  assert.equal(await page.locator('.tab-search-results button').count(), 1);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('[data-atlas-tab-portal]').count(), 0);
  report.checks.catalog = await page.evaluate(() => { renderCatalog(); return { initial: document.querySelectorAll('.game-card').length }; });
  assert.equal(report.checks.catalog.initial, 48);
  await page.getByRole('button', { name: 'Load more', exact: true }).click(); assert.equal(await page.locator('.game-card').count(), 60);
  await page.getByRole('textbox', { name: 'Search games' }).fill('Game 59'); assert.equal(await page.locator('.game-card').count(), 1);
  await page.getByRole('button', { name: 'Favorite Game 59', exact: true }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click(); assert.equal(await page.locator('.game-card').count(), 1);
  await page.getByRole('textbox', { name: 'Search games' }).fill(''); assert.equal(await page.locator('.game-card').count(), 1);
  await page.getByRole('button', { name: 'All games', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter games by category' }).selectOption('Puzzle');
  await page.getByRole('combobox', { name: 'Sort games' }).selectOption('A–Z');
  assert.equal(await page.locator('.game-card').count(), 30);
  assert.equal(await page.locator('.game-card h3').first().textContent(), 'Game 00');
  report.checks.catalog.filterSortFavoritesAndPagination = 'PASS';
  report.checks.seedStart = await page.evaluate(async () => {
    localStorage.setItem(preferencePrefix + 'atlas.settings', '{"theme":"forest"}');
    localStorage.setItem(preferencePrefix + 'atlas.onboarded', 'true');
    window.profile = await openProfile(); return { callsAtReadiness: fixture.calls.length, markerAtReadiness: localStorage.getItem(marker) };
  });
  assert.equal(report.checks.seedStart.callsAtReadiness, 0); assert.equal(report.checks.seedStart.markerAtReadiness, null);
  await page.waitForFunction(() => fixture.pending.length === 1);
  assert.equal(await page.evaluate(() => localStorage.getItem(marker)), null);
  await page.evaluate(() => { api.writeLocal('atlas.settings', { theme: 'rose' }); fixture.pending.shift().resolve(); });
  await page.waitForFunction(() => fixture.calls.length === 2 && fixture.pending.length === 1);
  assert.equal(await page.evaluate(() => localStorage.getItem(marker)), null);
  assert.equal(await page.evaluate(() => fixture.calls[1].values['atlas.settings']), '{"theme":"rose"}');
  await page.evaluate(() => fixture.pending.shift().resolve());
  await page.waitForFunction(() => fixture.mirrored.get('atlas.settings') === '{"theme":"rose"}');
  report.checks.seedAcknowledgementAndWriteRace = 'PASS';
  const prior = await page.evaluate(async () => { const n = fixture.generation; localStorage.setItem(marker, '1'); profile.stop(); window.profile = await openProfile(); return n; });
  await page.waitForTimeout(350); assert.equal(await page.evaluate(() => fixture.generation), prior);
  const readsOnly = await page.evaluate(() => { const n = fixture.calls.length; for (let i = 0; i < 40; i++) api.readLocal('atlas.settings', {}); return n; });
  await page.waitForTimeout(300); assert.equal(await page.evaluate(() => fixture.calls.length), readsOnly);
  report.checks.perStartReconciliationAndPureReadsDoNotRedirty = 'PASS';
  await page.evaluate(() => api.writeLocal('atlas.chats', 'x'.repeat(140 * 1024)));
  await page.waitForFunction(() => fixture.pending.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.calls.at(-1).deferred), ['atlas.chats']);
  await page.evaluate(() => { api.writeLocal('atlas.chats', { small: 'one' }); fixture.pending.shift().resolve(); });
  await page.waitForFunction(() => fixture.pending.length === 1 && fixture.calls.at(-1).values['atlas.chats'] === '{"small":"one"}');
  await page.evaluate(() => fixture.pending.shift().resolve());
  await page.waitForTimeout(20);
  await page.evaluate(() => api.writeLocal('atlas.chats', 'y'.repeat(140 * 1024)));
  await page.waitForFunction(() => fixture.pending.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.calls.at(-1).deferred), ['atlas.chats']);
  await page.evaluate(() => fixture.pending.shift().resolve()); await page.waitForTimeout(20);
  await page.evaluate(() => api.writeLocal('atlas.chats', { small: 'one' }));
  await page.waitForFunction(() => fixture.pending.length === 1 && fixture.calls.at(-1).values['atlas.chats'] === '{"small":"one"}');
  await page.evaluate(() => fixture.pending.shift().resolve()); await page.waitForTimeout(20);
  report.checks.deferredNormalDeferredAcknowledgementRace = 'PASS';
  await page.evaluate(async () => { api.writeLocal('atlas.onboarded', false); profile.stop(); window.profile = await openProfile(); });
  await page.waitForFunction(() => fixture.pending.length === 1);
  await page.evaluate(() => fixture.pending.shift().reject(Error('controlled mirror failure')));
  await page.waitForTimeout(20); assert.equal(await page.evaluate(() => fixture.mirrored.get('atlas.onboarded')), 'true');
  assert.equal(await page.evaluate(() => { api.writeLocal('atlas.onboarded', false); return api.readLocal('atlas.onboarded', true); }), false);
  await page.evaluate(() => profile.stop());
  report.checks.mirrorFailureKeepsLocalWritesAndSeedIncomplete = 'PASS';
  report.result = 'PASS'; console.log('SHELL_UI_EFFICIENCY PASS closed portals perform zero style reads; 12 theme/mode portals; catalog; detached acknowledged seed; write race; retry/local persistence');
} catch (error) { report.result = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  const dir = resolve(process.env.ATLAS_EVIDENCE_DIR || 'evidence/performance-remediation-20261029/shell');
  await mkdir(dir, { recursive: true }); await writeFile(resolve(dir, 'FOCUSED_BROWSER.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await new Promise(r => server.close(r));
}
