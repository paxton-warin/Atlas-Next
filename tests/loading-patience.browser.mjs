/** Native-clock 35s first-load regression. Actual FrontendBrowser composition,
 * ScramjetWebsiteDocument, profile context and DOM iframe lifecycle are used.
 * A trusted dependency seam supplies synthetic assignment/owners, and a local
 * runtime fixture emits source+origin-authenticated events after native load.
 * It does NOT qualify production WSS, rewriting, local persistence or speed. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
const E = resolve(process.env.ATLAS_LOADING_PATIENCE_EVIDENCE || 'evidence/loading-timeout-20261030/loading-patience'); await mkdir(E, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = process.env.ATLAS_LOADING_BASELINE_SOURCE
  ? await readFile(process.env.ATLAS_LOADING_BASELINE_SOURCE)
  : execFileSync('git', ['show', '267412b:runtime/frontend-browser.ts']);
assert.equal(sha(baseline), 'ef2e137ddc129ff951909213aee6bf8ab8ae919144e95143c8a25d6e2c30218b', 'baseline must be exact pre-change source');
const current = await readFile('runtime/frontend-browser.ts');
const scripts = {};
for (const [variant, source] of [['baseline', baseline], ['modified', current]]) {
  const bundle = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', stdin: { loader: 'ts', resolveDir: resolve('runtime'), contents: source.toString() + '\nexport {setActiveProfile,setActiveProfileContext,setProfileDocumentGuard} from "./profile-context.ts";' } });
  scripts['/entry-' + variant + '.js'] = bundle.outputFiles[0].contents;
}
const requests = [], pendingResponses = new Set(), serverTimers = new Set();
const runtimeHTML = `<!doctype html><title>Controlled trusted runtime</title><main id="frames"></main><script>
let started=false;window.navigateCalls=0;
const send=(type,values={})=>parent.postMessage({atlas:1,type,...values},location.origin);
addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.atlas!==1)return;
 const data=event.data;
 if(data.type==='ping'){send('ready');return}
 if(data.type!=='navigate'||started)return;
 started=true;window.navigateCalls++;window.ownerId=data.id;send('loading',{id:data.id});
 const frame=document.createElement('iframe');frame.title='Controlled delayed website';frame.id='website';
 frame.src='/fixture-site.html?case='+new URL(location.href).searchParams.get('case');
 frame.onload=()=>{if(frame.contentWindow.slowScriptLoaded)send('loaded',{id:data.id})};
 document.querySelector('main').append(frame);
});send('ready');</script>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname; requests.push({ path, case: url.searchParams.get('case'), at: Date.now(), method: req.method }); res.setHeader('cache-control', 'no-store');
  if (scripts[path]) { res.setHeader('content-type', 'application/javascript'); res.end(scripts[path]); return; }
  if (path === '/api/browse/controller/runtime') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 2, engine: 'scramjet-controller', runtimePath: '/browse/runtime/', documentOrigin: 'same-origin', bootstrap: '/browse/assets/document-0123456789abcdef.js', trustedRewriter: '/browse/assets/rewriter-0123456789abcdef.js', workers: { storage: '/browse/assets/storage-0123456789abcdef.js', cookies: '/browse/assets/cookies-0123456789abcdef.js', relay: '/browse/assets/relay-0123456789abcdef.js' } })); return; }
  if (path === '/api/browse/controller/runtime-ticket') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ runtimeTicket: 'synthetic-runtime-ticket', runtimePath: '/browse/runtime/index.html?case=' + url.searchParams.get('case') })); return; }
  if (path === '/browse/runtime/index.html') { res.setHeader('content-type', 'text/html'); res.end(runtimeHTML); return; }
  if (path === '/fixture-site.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Slow native load</title><h1>Draft available before load</h1><label>Draft <input id="draft" value="retained draft"></label><script>window.domAvailableAt=performance.now()</script><script async src="/delayed35.js?case=' + url.searchParams.get('case') + '"></script>'); return; }
  if (path === '/delayed35.js') { pendingResponses.add(res); const timer = setTimeout(() => { serverTimers.delete(timer); pendingResponses.delete(res); if (!res.destroyed) { res.setHeader('content-type', 'application/javascript'); res.end('window.slowScriptLoaded=true;'); } }, 35000); serverTimers.add(timer); return; }
  res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Loading patience regression</title><main id="browser"></main>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const pages = [], rows = [], errors = []; let report;
async function launch(variant, label) {
  const context = await browser.newContext(), page = await context.newPage(); pages.push({ context, page }); page.on('pageerror', error => errors.push({ label, message: error.message })); await page.goto(origin);
  await page.evaluate(async ({ variant, label }) => {
    const m = await import('/entry-' + variant + '.js'); m.setActiveProfile('00000000-0000-4000-8000-000000000001'); m.setActiveProfileContext('fixture-local-context'); m.setProfileDocumentGuard(async () => {});
    window.states=[];window.runtimeEvents=[];window.counts={starts:0,storage:0,cookies:0,storageDisposed:0,cookiesDisposed:0,coordinatorStopped:0};window.caseLabel=label;
    // Count authentic control requests while keeping the production fetch path.
    const fetch=window.fetch.bind(window);window.controlCalls=[];window.fetch=(path,init)=>{controlCalls.push(String(path));return fetch(String(path).startsWith('/api/browse/controller/runtime-ticket')?String(path)+'?case='+label:path,init)};
    const assignment={protocol:2,session:'synthetic-session',sessionHash:'a'.repeat(64),generation:1,frontendOrigin:location.origin,relayOrigin:'https://assigned-node.invalid',browserSessionId:'browser_session_fixture_0123456789',ticket:'synthetic-ticket',node:{id:'fixed-node',name:'Fixture node'}};
    const owner=(kind)=>async()=>{counts[kind]++;return{live:true,bind(){throw Error('fixture does not emulate local persistence')},getRequestHeader:async()=>'',storeResponseCookies:async()=>{},dispose(){counts[kind+'Disposed']++}}};
    window.frontend=await m.createFrontendBrowser({container:document.querySelector('#browser'),timeoutMs:30000,onState:state=>states.push({...state,at:performance.now()}),onRuntimeEvent:event=>runtimeEvents.push({...event,at:performance.now()}),components:{storage:owner('storage'),cookies:owner('cookies'),coordinator(options){const c={current:null,state:{status:'new'},transport:{request(){throw Error('no fixture network delegation')},connectWebSocket(){throw Error('no fixture sockets')}},async start(){counts.starts++;c.current=assignment;c.state={status:'ready'};options.onAssignment({assignment,previous:null,reason:'startup',identityChanged:true});options.onState(c.state);return assignment},stop(){counts.coordinatorStopped++}};return c}}});
    window.startedAt=performance.now();window.outcome={status:'pending'};window.startPromise=frontend.start('https://website.invalid/slow').then(()=>outcome={status:'ready',at:performance.now()},error=>outcome={status:'error',code:error.code||error.message,at:performance.now()});
  }, { variant, label });
  await page.waitForFunction(() => !!frontend.document?.frame?.contentDocument?.querySelector('#website')?.contentDocument?.querySelector('#draft'));
  await page.evaluate(() => { window.initialRuntimeFrame=frontend.document.frame;window.initialDocumentId=frontend.document.documentId;window.initialWebsite=initialRuntimeFrame.contentDocument.querySelector('#website'); });
  return page;
}
try {
  // These concurrent contexts are correctness timer cases, not performance runs.
  const baselinePage=await launch('baseline','baseline'), modifiedPage=await launch('modified','modified'), closedPage=await launch('modified','closed');
  await closedPage.evaluate(()=>{frontend.dispose();window.closedAt=performance.now();window.closedEvents=runtimeEvents.length;window.closedStates=states.length;});
  for(const page of[baselinePage,modifiedPage])await page.waitForFunction(()=>performance.now()-startedAt>=31000,null,{timeout:40000});
  const baseline31=await baselinePage.evaluate(()=>({elapsed:performance.now()-startedAt,outcome,frameCount:document.querySelectorAll('#browser iframe').length,documentLive:frontend.document?.live??false,states,runtimeEvents,counts,controlCalls}));
  assert.ok(baseline31.elapsed>=30000);assert.equal(baseline31.outcome.status,'error');assert.equal(baseline31.outcome.code,'FRONTEND_DOCUMENT_CONTENT_TIMEOUT');assert.equal(baseline31.frameCount,0);assert.equal(baseline31.documentLive,false);rows.push({case:'baseline-30s-destroys-still-loading-document',at31s:baseline31});
  const editable=modifiedPage.frameLocator('iframe[title="Atlas browsing runtime"]').frameLocator('iframe[title="Controlled delayed website"]').locator('#draft');await editable.fill('typed while native load pending');
  const modified31=await modifiedPage.evaluate(()=>({elapsed:performance.now()-startedAt,outcome,frameSame:frontend.document?.frame===initialRuntimeFrame,documentSame:frontend.document?.documentId===initialDocumentId,draft:initialWebsite.contentDocument.querySelector('#draft').value,nativeReadyState:initialWebsite.contentDocument.readyState,scriptLoaded:!!initialWebsite.contentWindow.slowScriptLoaded,states,runtimeEvents,counts,controlCalls,navigateCalls:initialRuntimeFrame.contentWindow.navigateCalls}));
  assert.ok(modified31.elapsed>=30000);assert.equal(modified31.outcome.status,'pending');assert.equal(modified31.frameSame,true);assert.equal(modified31.documentSame,true);assert.equal(modified31.draft,'typed while native load pending');assert.equal(modified31.scriptLoaded,false);assert.ok(modified31.runtimeEvents.some(event=>event.type==='slow'));assert.equal(modified31.states.some(state=>state.status==='error'),false);assert.equal(modified31.counts.starts,1);assert.equal(modified31.navigateCalls,1);assert.equal(modified31.controlCalls.filter(path=>path.startsWith('/api/browse/controller/runtime-ticket')).length,1);
  await modifiedPage.waitForFunction(()=>outcome.status==='ready',null,{timeout:15000});const modified35=await modifiedPage.evaluate(()=>({elapsed:performance.now()-startedAt,outcome,frameSame:frontend.document?.frame===initialRuntimeFrame,documentSame:frontend.document?.documentId===initialDocumentId,draft:initialWebsite.contentDocument.querySelector('#draft').value,scriptLoaded:!!initialWebsite.contentWindow.slowScriptLoaded,states,runtimeEvents,counts,controlCalls,navigateCalls:initialRuntimeFrame.contentWindow.navigateCalls}));assert.ok(modified35.elapsed>=35000);assert.equal(modified35.frameSame,true);assert.equal(modified35.documentSame,true);assert.equal(modified35.draft,'typed while native load pending');assert.equal(modified35.scriptLoaded,true);assert.equal(modified35.counts.starts,1);assert.equal(modified35.navigateCalls,1);assert.equal(modified35.states.filter(state=>state.status==='ready').length,1);rows.push({case:'modified-35s-retains-editable-document-then-readies',at31s:modified31,afterLoad:modified35});
  await closedPage.waitForFunction(()=>performance.now()-startedAt>=36000,null,{timeout:15000});const closed=await closedPage.evaluate(()=>({elapsed:performance.now()-startedAt,outcome,live:frontend.live,frameCount:document.querySelectorAll('#browser iframe').length,documentPresent:!!frontend.document,newRuntimeEvents:runtimeEvents.length-closedEvents,newStates:states.length-closedStates,counts}));assert.equal(closed.live,false);assert.equal(closed.frameCount,0);assert.equal(closed.documentPresent,false);assert.equal(closed.outcome.status,'error');assert.equal(closed.newRuntimeEvents,0);assert.equal(closed.newStates,0);assert.equal(closed.counts.starts,1);assert.equal(closed.counts.storageDisposed,1);assert.equal(closed.counts.cookiesDisposed,1);assert.equal(closed.counts.coordinatorStopped,1);rows.push({case:'close-pending-does-not-resurrect-after35s',afterDeadline:closed});
  report={result:'PASS',command:'node tests/loading-patience.browser.mjs',browser:browser.version(),baselineSHA256:sha(baseline),modifiedSHA256:sha(current),scramjetDocumentSHA256:sha(await readFile('runtime/scramjet-document.ts')),scope:'Actual FrontendBrowser+ScramjetWebsiteDocument/native iframe clock; trusted assignment/storage/cookie owner seam and controlled runtime source+origin messages. No WSS/rewriter/persistence/performance or App UI qualification.',rows,errors,requests};console.log('LOADING_PATIENCE=PASS;baseline30s destroys pending frame;modified31s draft editable+same frame;native35s load publishes ready once;closed pending owner never resurrects');
}catch(error){report={result:'FAIL',error:error.stack,rows,errors,requests};console.error(error);process.exitCode=1}
finally{await writeFile(E+'/BROWSER.json',JSON.stringify(report,null,2)+'\n');for(const{page}of pages)await page.evaluate(()=>window.frontend?.dispose()).catch(()=>{});await browser.close();for(const timer of serverTimers)clearTimeout(timer);for(const response of pendingResponses)response.destroy();await new Promise(r=>server.close(r))}
