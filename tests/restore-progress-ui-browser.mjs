import Fastify from 'fastify';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const E = resolve(process.env.ATLAS_EVIDENCE_DIR || 'evidence/restore-progress-20261028');
const grant = { protocol: 2, userId: 'test-user', profileId: '11111111-1111-4111-8111-111111111111', branchId: '22222222-2222-4222-8222-222222222222', sessionId: 'fixture-session', contextId: 'fixture-context', expiresAt: '2030-01-01T00:00:00Z', grantExpiresAt: '2030-01-01T00:00:00Z' };
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import HubGate from './HubGate.tsx';import{registerHubInitializer}from './hub-client-state';import './styles.css';import './v21-tokens.css';
window.fixture={calls:0,pending:[],skips:[]};registerHubInitializer(s=>{fixture.calls++;return new Promise((resolve,reject)=>fixture.pending.push({resolve,reject,state:s}));});
addEventListener('atlas:backup-restore-skip',e=>fixture.skips.push(e.detail));
createRoot(document.getElementById('root')).render(<HubGate><main data-testid="application">Atlas application ready</main></HubGate>);`;
const result = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', outfile: 'fixture.js', logLevel: 'silent',
 plugins: [{ name: 'profile-network-scope', setup(b) { b.onResolve({ filter: /^\.\/profile-client$/ }, a => a.importer.endsWith('/HubGate.tsx') ? { path: 'fixture-profile', namespace: 'profile' } : undefined);
 b.onLoad({ filter: /.*/, namespace: 'profile' }, () => ({ loader: 'js', contents: `export async function flushProfile(){};export function getLocalFirstProfile(){return null};export async function prepareProfileReplacement(){};export function stopProfile(){};export function getProfileStatus(){return {importing:false,message:''}};export async function listProfileRecoveries(){return {recoveries:[]}};export async function downloadProfileRecovery(){}` })); } }],
 stdin: { resolveDir: resolve('web/src'), contents: fixture, loader: 'tsx' } });
const js = result.outputFiles.find(f => f.path.endsWith('.js')).text, css = result.outputFiles.find(f => f.path.endsWith('.css')).text;
const app = Fastify({ logger: false });
let stateRequests = 0;
app.get('/', (_q, r) => r.type('text/html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/fixture.css"><body class="atlas-v21" data-v21-theme="forest" data-v21-mode="dark"><div id="root"></div><script type="module" src="/fixture.js"></script>'));
app.get('/api/hub/state', (_q, r) => { stateRequests++; return r.send({ enabled: true, authenticated: true, csrf: 'synthetic-test-csrf', hubOrigin: 'https://hub.example.test', branchAvailable: true, grant }); });
app.get('/fixture.js', (_q,r) => r.type('application/javascript').send(js));
app.get('/fixture.css', (_q,r) => r.type('text/css').send(css));
app.get('/fonts.css', async (_q,r) => r.type('text/css').send(await readFile('web/public/fonts.css')));
app.get('/fonts/*', async (q,r) => { const p=resolve('web/public/fonts',q.params['*']);if(!p.startsWith(resolve('web/public/fonts')+'/'))return r.code(404).send();return r.type('font/woff2').send(await readFile(p)); });
const report = { command:'node tests/restore-progress-ui-browser.mjs', productionChanged:false, actualHubGate:true, actualHubSessionState:true, mocked:'Only profile-client network facade and registered deferred initializer; synthetic /api/hub/state account scope', checks:[], screenshots:[], errors:[] };
let browser;
try {
 await mkdir(E,{recursive:true});
 const base=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
 const page=await browser.newPage({viewport:{width:1366,height:768}});
 page.on('pageerror',e=>report.errors.push(e.message));
 const emit=async(phase,changes={},scope={})=>page.evaluate(({phase,changes,scope,grant})=>dispatchEvent(new CustomEvent('atlas:backup-restore-progress',{detail:{profileId:grant.profileId,contextId:grant.contextId,sessionId:grant.sessionId,...scope,progress:{phase,completedBytes:0,completedRecords:0,downloadedBytes:0,namespaces:0,elapsedMs:10000,...changes}}})),{phase,changes,scope,grant});
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 await page.goto(base);await page.waitForFunction(()=>fixture.calls===1);await page.getByText('Restoring your browser…',{exact:true}).waitFor();
 await emit('planning');
 const bar=page.getByRole('progressbar');await bar.waitFor();
 assert.equal(await bar.getAttribute('aria-valuenow'),null);assert.equal(await bar.getAttribute('aria-label'),'Checking backup contents…');
 assert.equal(await page.getByTestId('application').count(),0);
 for(const scope of [{profileId:'99999999-9999-4999-8999-999999999999'},{contextId:'another-context'},{sessionId:'another-session'}]){await emit('ready',{},scope);await settle();assert.equal(await bar.getAttribute('aria-valuenow'),null);}
 report.checks.push('Wrong profile, context and session events cannot advance the held account restore');
 // Actual elapsed time, no accelerated browser clock: cross the old15s total timeout.
 const heldStarted=performance.now();await page.waitForTimeout(15500);
 assert.equal(await page.evaluate(()=>fixture.calls),1);assert.equal(await page.getByTestId('application').count(),0);
 assert.equal(await page.getByRole('heading',{name:'Set up your browser'}).count(),0);
 assert.equal(await bar.getAttribute('aria-valuenow'),null);assert.equal(stateRequests,1,'15s polling does not start another restore while pending');
 report.heldMs=Math.round(performance.now()-heldStarted);report.checks.push('Held initializer remains one stable gate beyond15s; no premature application/setup or duplicate initialization');
 await emit('restoring',{completedBytes:500,totalBytes:1000,completedRecords:5,totalRecords:10,downloadedBytes:750,totalNamespaces:2,namespaces:1,elapsedMs:10000});
 await page.getByText('49%',{exact:true}).waitFor();assert.equal(await bar.getAttribute('aria-valuenow'),'49');
 await page.getByText('About 10 seconds remaining',{exact:true}).waitFor();
 report.checks.push('50% applied bytes presents49%, with measured-work ETA; never success before ready');
 for(const [width,height,motion,phase] of [[1366,768,'no-preference','restoring'],[320,844,'reduce','planning'],[320,844,'reduce','restoring']]){
   await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:motion});
   if(phase==='planning')await emit('planning');else await emit('restoring',{completedBytes:500,totalBytes:1000,completedRecords:5,totalRecords:10,elapsedMs:10000});
   await settle();const card=page.locator('[data-entry-card]');
   const bounds=await card.evaluate(el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,controls:[...el.querySelectorAll('button,a')].map(x=>({text:x.textContent,height:x.getBoundingClientRect().height}))};});
   assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=height,JSON.stringify(bounds));assert.ok(bounds.scrollWidth<=bounds.clientWidth,'no horizontal card clipping');assert.ok(bounds.controls.every(x=>x.height>=44),'44px actions');
   const font=await page.evaluate(()=>({ready:document.fonts.status,inter:document.fonts.check('14px Inter'),display:document.fonts.check('24px "Inter Tight"')}));assert.equal(font.ready,'loaded');assert.ok(font.inter&&font.display);
   if(motion==='reduce'){const computed=await bar.locator('span').evaluate(el=>({animation:getComputedStyle(el).animationName,transition:getComputedStyle(el).transitionDuration}));assert.equal(computed.animation,'none');assert.ok(computed.transition.split(',').every(v=>parseFloat(v)<=0.001),'reduced motion removes visible transitions');}
   const image=`UI-${width}x${height}-${motion}-${phase}.png`;await page.screenshot({path:resolve(E,image),fullPage:true});report.screenshots.push({image,width,height,motion,phase,bounds,font});
 }
 const keepLocal=page.getByRole('button',{name:'Continue without restoring',exact:true});await keepLocal.focus();await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>fixture.skips.at(-1)),{profileId:grant.profileId,contextId:grant.contextId,sessionId:grant.sessionId});assert.equal(await page.getByTestId('application').count(),0);
 report.checks.push('Keyboard Continue emits only scoped explicit skip; gate never fabricates readiness');
 await emit('finalizing',{completedBytes:1000,totalBytes:1000});await page.getByText('99%',{exact:true}).waitFor();assert.equal(await bar.getAttribute('aria-valuenow'),'99');assert.equal(await keepLocal.count(),0);
 await emit('ready',{completedBytes:1000,totalBytes:1000});await page.getByText('100%',{exact:true}).waitFor();assert.equal(await bar.getAttribute('aria-valuenow'),'100');assert.equal(await page.getByTestId('application').count(),0);
 await page.evaluate(()=>fixture.pending[0].resolve({ready:true}));await page.getByTestId('application').waitFor();assert.equal(await page.getByRole('progressbar').count(),0);
 report.checks.push('Finalizing stays99%; ready event reaches100%; application mounts only after successful initializer resolves');
 await page.reload();await page.waitForFunction(()=>fixture.calls===1);await emit('error');await page.evaluate(()=>fixture.pending[0].reject(new Error('Your backup could not finish loading. Retry, or continue without restoring. Your cloud backup is unchanged.')));
 await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('progressbar').count(),0);await page.getByRole('button',{name:'Retry',exact:true}).waitFor();await page.getByRole('button',{name:'Continue without restoring',exact:true}).waitFor();assert.equal(await page.getByTestId('application').count(),0);
 await settle();const errorImage='UI-320x844-error.png';await page.screenshot({path:resolve(E,errorImage),fullPage:true});report.screenshots.push({image:errorImage,width:320,height:844,phase:'error',motion:'reduce'});
 await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>fixture.calls===2);await page.getByRole('alert').waitFor({state:'hidden'});assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.getByTestId('application').count(),0);
 await emit('error');await page.evaluate(()=>fixture.pending[1].reject(new Error('Restore paused.')));await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();await page.getByRole('button',{name:'Continue without restoring',exact:true}).click();await page.waitForFunction(()=>fixture.calls===3);assert.equal(await page.evaluate(profileId=>sessionStorage.getItem('atlas.backup.skip-once:'+profileId),grant.profileId),grant.contextId);assert.equal(await page.getByTestId('application').count(),0);
 report.checks.push('Failure exposes Retry and explicit Continue; Retry reinitializes; Continue records account-scoped opt-out and retries, never shows fake backed-up state');
 assert.deepEqual(report.errors,[]);report.result='PASS';console.log('RESTORE_PROGRESS_UI PASS actual HubGate; scoped events; >15s held; indeterminate/49%/ETA/99%/100%; retry/skip;320px+1366px; reduced motion/fonts');
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}
finally{await mkdir(E,{recursive:true});await writeFile(resolve(E,'UI.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
