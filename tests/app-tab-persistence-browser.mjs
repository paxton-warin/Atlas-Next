import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const contents = `import React from 'react';import{createRoot}from'react-dom/client';import App from './App.tsx';import{createLocalFirstProfile}from'./local-first-profile.ts';import{profileLocalKey}from'./model.ts';import{getActiveLocalAuthority}from'../../runtime/profile-context.ts';import './styles.css';import './v21-tokens.css';import './atlas-v21.css';import './sidebar-responsive.css';
window.fixture={commands:[],disposals:0,recording:false,reads:0,presentationReads:0,canonicalReads:0,otherReads:0,writes:0,stringifies:0,revokes:[]};window.state={enabled:true,authenticated:true,csrf:'synthetic',grant:{profileId:'11111111-1111-4111-8111-111111111111',sessionId:'session',contextId:'context'}};window.openProfile=()=>createLocalFirstProfile(state,{current:()=>state,onStatus:()=>{}},0,true);window.profile=await openProfile();
window.logical='atlas.windows.v1.44444444-4444-4444-8444-444444444444';window.name='atlas-window:44444444-4444-4444-8444-444444444444';window.physical=profileLocalKey(logical);
localStorage.setItem(profileLocalKey('atlas.onboarded'),'true');localStorage.setItem(profileLocalKey('atlas.settings'),JSON.stringify({restore:true,history:false,motion:false,mode:'dark',theme:'forest'}));localStorage.setItem(physical,JSON.stringify({version:1,tabs:[{id:'one',url:'https://one.example/',title:'One',engine:'runtime',workspace:'browser'},{id:'two',url:'https://two.example/',title:'Two',engine:'runtime',workspace:'browser'}],order:['one','two'],active:'one',updatedAt:1000}));
const get=Storage.prototype.getItem,set=Storage.prototype.setItem,stringify=JSON.stringify;Storage.prototype.getItem=function(key){if(fixture.recording&&key===physical){fixture.reads++;const stack=new Error().stack||'';if(stack.includes('canonicalPreference'))fixture.canonicalReads++;else if(stack.includes('writeLocal'))fixture.presentationReads++;else fixture.otherReads++}return get.call(this,key)};Storage.prototype.setItem=function(key,value){if(fixture.recording&&key===physical)fixture.writes++;return set.call(this,key,value)};JSON.stringify=function(...args){if(fixture.recording)fixture.stringifies++;return stringify.apply(JSON,args)};
addEventListener('atlas:profile-local-before-revoke',e=>fixture.revokes.push({generation:e.detail.generation,active:getActiveLocalAuthority()?.localAuthGeneration}));window.mountApp=()=>{window.root=createRoot(document.querySelector('#root'));root.render(<App/>)};mountApp();window.profileLocalKey=profileLocalKey;window.snapshot=()=>JSON.parse(get.call(localStorage,physical));window.begin=()=>{fixture.reads=fixture.presentationReads=fixture.canonicalReads=fixture.otherReads=fixture.writes=fixture.stringifies=0;fixture.recording=true};window.end=()=>{fixture.recording=false;return {reads:fixture.reads,presentationReads:fixture.presentationReads,canonicalReads:fixture.canonicalReads,otherReads:fixture.otherReads,writes:fixture.writes,stringifies:fixture.stringifies}};`;
const ui = /^\.\/(ProfileStatus|ProfileBackupChoice|HubSupportPanel|SetupWizard|Support|Settings|AiChat|Admin|BrowsingOptions)$/;
const bundle = await build({ bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, outfile: 'app.js', logLevel: 'silent',
  plugins: [{ name: 'mounted-app-boundaries', setup(b) {
    b.onResolve({ filter: ui }, a => a.importer.endsWith('/App.tsx') ? { path: a.path, namespace: 'ui-seam' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'ui-seam' }, () => ({ contents: 'export default function(){return null};export function HubSupportPanel(){return null};export function Settings(){return null};export function ReconnectDialog(){return null}', loader: 'js' }));
    b.onResolve({ filter: /^\.\/profile-client$/ }, a => a.importer.endsWith('/App.tsx') ? { path: a.path, namespace: 'profile-status' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'profile-status' }, () => ({ contents: 'export const getProfileStatus=()=>({state:"synced",message:"Saved locally"})', loader: 'js' }));
    b.onResolve({ filter: /^\.\/frontend-runtime$/ }, a => a.importer.endsWith('/App.tsx') ? { path: a.path, namespace: 'workspace' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'workspace' }, () => ({ loader: 'js', contents: `export const frontendRuntimeEnabled=c=>c?.fixtureWorkspace===true;export async function clearFrontendWebsiteData(){};export function createFrontendWorkspace(options){const frames=new Map();let active='';fixture.emit=options.onEvent;return{async connect(){options.onConnection({status:'ready'})},async command(type,args){fixture.commands.push({type,...args});if(type==='navigate'&&!frames.has(args.id)){const frame=document.createElement('iframe');frame.dataset.fixtureFrame=args.id;frame.src='/fixture-site?id='+args.id;frame.style.cssText='width:100%;height:100%;border:0';frames.set(args.id,frame);options.container.append(frame)}if(type==='activate'||type==='navigate'){active=args.id;for(const[id,frame]of frames)frame.hidden=id!==active}},get frame(){return frames.get(active)},dispose(){fixture.disposals++;for(const frame of frames.values())frame.remove()},async reconnect(){},async selectNode(){}}}` }));
    b.onResolve({ filter: /^\.\/(backup-v2-actor|replica-control-v2|local-receipt-probe-v2)\.ts$/ }, a => a.importer.endsWith('/local-first-profile.ts') ? { path: a.path, namespace: 'local-profile' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'local-profile' }, a => ({ loader: 'js', contents: a.path.includes('receipt-probe') ? 'export async function probeLocalReceiptsV2(){}' : a.path.includes('replica-control') ? `export function createReplicaControlV2(){return{async initialize(){return{account:{hasLocal:true,cloudChecked:true,replicaId:'22222222-2222-4222-8222-222222222222',incarnation:'33333333-3333-4333-8333-333333333333'}}},dispose(){}}}` : `export function createBackupV2Actor(){return{async initialize(){},status:()=>({state:'idle',message:'Saved locally',deferred:[]}),stop(){},dirty(){},foreground(){},async preferences(){},async preferenceKeys(){return{keys:[]}},async latest(){return{checkpoint:null}}}}` }));
  } }], stdin: { resolveDir: resolve('web/src'), loader: 'tsx', contents } });
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text, css = bundle.outputFiles.find(f => f.path.endsWith('.css')).text;
const site = '<!doctype html><style>body{height:2000px}input{margin-top:20px}</style><input name="draft" value="initial"><script>window.identity=crypto.randomUUID();window.ticks=0;setInterval(()=>ticks++,20)</script>';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ fixtureWorkspace: true, runtimeOrigin: 'http://127.0.0.1:' + server.address().port, nodeRouting: false })); }
  else if (url.pathname === '/api/catalog') { res.setHeader('Content-Type', 'application/json'); res.end('[]'); }
  else { res.setHeader('Content-Type', url.pathname === '/app.js' ? 'application/javascript' : url.pathname === '/app.css' ? 'text/css' : 'text/html'); res.end(url.pathname === '/app.js' ? js : url.pathname === '/app.css' ? css : url.pathname === '/fixture-site' ? site : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"><body class="atlas-v21"><div id="root"></div><script type="module" src="/app.js"></script>'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const report = { command: 'node tests/app-tab-persistence-browser.mjs', checks: {}, qualification: 'Mounted current App and real iframe; controlled transport/profile actors, correctness and operation counts only.' }; let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }); report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); page.on('pageerror', e => console.error('PAGE', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port); await page.frameLocator('iframe[data-fixture-frame="one"]').locator('input').waitFor(); await page.waitForTimeout(650);
  await page.frameLocator('iframe[data-fixture-frame="one"]').locator('input').fill('unsent draft survives shell events');
  await page.evaluate(() => { const frame = document.querySelector('iframe[data-fixture-frame="one"]'); window.savedFrame = frame; window.savedWindow = frame.contentWindow; window.savedIdentity = savedWindow.identity; savedWindow.scrollTo(0, 200); window.savedTicks = savedWindow.ticks; });
  report.checks.ephemeral = await page.evaluate(async () => {
    begin(); for (let i = 0; i < 40; i++) { fixture.emit({ type: i % 2 ? 'loading' : 'loaded', id: 'one' }); fixture.emit({ type: 'title', id: 'one', title: 'One' }); fixture.emit({ type: 'navigation', id: 'one', url: 'https://one.example/' }); fixture.emit({ type: 'favicon', id: 'one', favicon: 'invalid' }); await new Promise(r => setTimeout(r, 0)); } await new Promise(r => setTimeout(r, 300)); return end();
  });
  assert.deepEqual(report.checks.ephemeral, { reads: 0, presentationReads: 0, canonicalReads: 0, otherReads: 0, writes: 0, stringifies: 0 });
  report.checks.title = await page.evaluate(async () => { begin(); fixture.emit({ type: 'title', id: 'one', title: 'First update' }); await new Promise(r => setTimeout(r, 100)); fixture.emit({ type: 'title', id: 'one', title: 'Final update' }); await new Promise(r => setTimeout(r, 350)); const metrics = end(); return { ...metrics, saved: snapshot() }; });
  assert.equal(report.checks.title.writes, 1); assert.equal(report.checks.title.presentationReads, 1); assert.equal(report.checks.title.otherReads, 0); assert.equal(report.checks.title.stringifies, 1); assert.equal(report.checks.title.saved.updatedAt, 1000); assert.equal(report.checks.title.saved.tabs[0].title, 'Final update');
  await page.locator('[data-tab-id="two"] .tab-main').click(); await page.frameLocator('iframe[data-fixture-frame="two"]').locator('input').waitFor(); await page.locator('[data-tab-id="one"] .tab-main').click();
  report.checks.continuity = await page.evaluate(() => ({ frame: savedFrame === document.querySelector('iframe[data-fixture-frame="one"]'), window: savedWindow === savedFrame.contentWindow, identity: savedIdentity === savedWindow.identity, draft: savedWindow.document.querySelector('input').value, scroll: savedWindow.scrollY, ticking: savedWindow.ticks > savedTicks, disposals: fixture.disposals }));
  assert.equal(report.checks.continuity.frame, true); assert.equal(report.checks.continuity.window, true); assert.equal(report.checks.continuity.identity, true); assert.equal(report.checks.continuity.draft, 'unsent draft survives shell events'); assert.equal(report.checks.continuity.scroll, 200); assert.equal(report.checks.continuity.ticking, true); assert.equal(report.checks.continuity.disposals, 0);
  await page.evaluate(() => fixture.emit({ type: 'title', id: 'one', title: 'Last pagehide edit' }));
  await page.locator('[data-tab-id="one"] [aria-label="Last pagehide edit"]').waitFor({ state: 'attached' });
  report.checks.pagehide = await page.evaluate(() => { dispatchEvent(new Event('pagehide')); return snapshot().tabs[0].title; }); assert.equal(report.checks.pagehide, 'Last pagehide edit');
  await page.evaluate(() => fixture.emit({ type: 'title', id: 'one', title: 'Last logout edit' }));
  await page.locator('[data-tab-id="one"] [aria-label="Last logout edit"]').waitFor({ state: 'attached' });
  report.checks.logout = await page.evaluate(() => { profile.stop(); return { title: snapshot().tabs[0].title, revoke: fixture.revokes.at(-1) }; });
  assert.equal(report.checks.logout.title, 'Last logout edit'); assert.equal(report.checks.logout.revoke.generation, report.checks.logout.revoke.active);
  await page.evaluate(async () => {
    root.unmount(); window.profile = await openProfile(); mountApp();
    await new Promise(r => setTimeout(r, 350)); fixture.emit({ type: 'title', id: 'one', title: 'Do not spill into next account' }); await new Promise(r => setTimeout(r, 0));
  });
  await page.locator('[data-tab-id="one"] [aria-label="Do not spill into next account"]').waitFor({ state: 'attached' });
  report.checks.staleCleanup = await page.evaluate(async () => {
    const old = profile, saved = localStorage.getItem(physical), revokes = fixture.revokes.length;
    state = { ...state, grant: { ...state.grant, profileId: '55555555-5555-4555-8555-555555555555', sessionId: 'new-session', contextId: 'new-context' } }; profile = await openProfile(); old.stop();
    await new Promise(r => setTimeout(r, 350)); const value = { unchanged: localStorage.getItem(physical) === saved, noNewAccountWrite: localStorage.getItem(profileLocalKey(logical)) === null, staleRevoke: fixture.revokes.length !== revokes };
    root.unmount(); profile.stop(); return value;
  });
  assert.deepEqual(report.checks.staleCleanup, { unchanged: true, noNewAccountWrite: true, staleRevoke: false });
  report.result = 'PASS'; console.log('APP_TAB_PERSISTENCE PASS mounted App: zero JSON/storage for repeated ephemeral events; coalesced title recency; live iframe/draft/scroll/timers; pagehide and logout flush; stale-account cleanup isolated');
} catch (error) { report.result = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally { const dir = resolve(process.env.ATLAS_EVIDENCE_DIR || 'evidence/performance-remediation-20261029/tab-persistence'); await mkdir(dir, { recursive: true }); await writeFile(resolve(dir, 'MOUNTED_APP_BROWSER.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await new Promise(r => server.close(r)); }
