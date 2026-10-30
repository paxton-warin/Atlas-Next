/** Real React HubGate, ephemeral Vite server, deterministic synthetic I/O.
 * Asserts mounted iframe/draft identity through pending/error/retry overlays.
 * This does not qualify real Hub endpoint activation or website compatibility. */
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const root=process.cwd(),out=resolve(process.env.ATLAS_MIGRATION_OUT||'evidence/local-release-readiness-20261021/migration');mkdirSync(out,{recursive:true});
let browser,server;const virtual='\0migration-review:';
const gateStub=`
 export const getProfileStatus=()=>({state:'synced',message:'Synced'});
 export async function flushProfile(){window.fixture.flushes++;}
 export const stopProfile=()=>{};
 export const listProfileRecoveries=async()=>({recoveries:[]});
 export const downloadProfileRecovery=async()=>{};
 export async function prepareProfileReplacement(){window.fixture.checkpoints++;await new Promise((resolve,reject)=>{window.fixture.finish={resolve,reject}});}
`;
const stateStub=`export const setHubSession=()=>{};export async function initializeHubCloud(){return{ready:true}};`;
const entry=`
 import React,{useEffect} from 'react';import{createRoot}from'react-dom/client';
 import HubGate from '/web/src/HubGate.tsx';import '/web/src/v21-tokens.css';
 window.fixture={mounts:0,unmounts:0,checkpoints:0,flushes:0};
 function DraftPage(){useEffect(()=>{window.fixture.mounts++;return()=>window.fixture.unmounts++},[]);return <main><h1>Existing website</h1><input id="draft" defaultValue="unchanged draft"/><iframe title="Existing website fixture" srcDoc="<!doctype html><input id='game' value='live game draft'>"/></main>}
 createRoot(document.getElementById('root')).render(<HubGate><DraftPage/></HubGate>);
`;
try{
 server=await createServer({configFile:false,root,publicDir:resolve('web/public'),esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,watch:{ignored:['**/*']}},plugins:[{name:'migration-test-io',enforce:'pre',
  resolveId(source,importer){if(source==='/migration-entry.tsx')return virtual+'entry.tsx';if(importer?.split('?')[0]===resolve('web/src/HubGate.tsx')){if(source==='./profile-client')return virtual+'profile';if(source==='./hub-client-state')return virtual+'state';if(source==='../../runtime/profile-context')return virtual+'context';}},
  load(id){if(id===virtual+'entry.tsx')return ts.transpileModule(entry,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;if(id===virtual+'profile')return gateStub;if(id===virtual+'state')return stateStub;if(id===virtual+'context')return'export const setActiveProfile=()=>{};';},
  configureServer(s){s.middlewares.use('/migration-review',(req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/fonts.css"><style>*{box-sizing:border-box}body{margin:0}iframe{width:500px;max-width:100%;height:200px}</style></head><body class="atlas-v21" data-v21-mode="dark"><div id="root"></div><script type="module" src="/migration-entry.tsx"></script></body></html>');});}
 }]});await server.listen();const address=server.httpServer.address();const origin=`http://127.0.0.1:${address.port}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),p=await context.newPage();p.setDefaultTimeout(8000);let transitioning=false;const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/api/hub/state',route=>route.fulfill({json:{enabled:true,authenticated:true,hubOrigin:'https://migration-hub.example',csrf:'synthetic-test-csrf',grant:{profileId:'profile',contextId:'context',sessionId:'session'},...(transitioning?{endpointTransition:{revision:2,hubOrigin:'https://migration-hub.example'}}:{})}}));
 await p.goto(origin+'/migration-review');await p.locator('#draft').waitFor();await p.locator('#draft').fill('draft written before replacement');
 await p.frameLocator('iframe').locator('#game').fill('native game state');const frame=p.frames().find(f=>f.parentFrame());assert.ok(frame);const mounted=await p.evaluate(()=>window.fixture.mounts);assert.equal(mounted,1);
 transitioning=true;await p.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await p.waitForFunction(()=>window.fixture.checkpoints===1);await p.evaluate(()=>document.fonts.ready);
 assert.equal(await p.evaluate(()=>window.fixture.unmounts),0);assert.equal(await p.locator('#draft').inputValue(),'draft written before replacement');assert.equal(p.frames().find(f=>f.parentFrame()),frame);assert.equal(await frame.locator('#game').inputValue(),'native game state');
 await p.getByRole('heading',{name:'This address has moved',exact:true}).waitFor();await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await p.screenshot({path:resolve(out,'replacement-gate-pending-1440.png'),fullPage:true});
 await p.evaluate(()=>window.fixture.finish.reject(Error('This website has not finished saving. Retry before leaving this address.')));await p.getByRole('button',{name:'Retry transfer',exact:true}).waitFor();
 assert.equal(await p.evaluate(()=>window.fixture.unmounts),0);assert.equal(await p.evaluate(()=>window.fixture.flushes),0);assert.equal(await p.locator('#draft').inputValue(),'draft written before replacement');assert.equal(p.frames().find(f=>f.parentFrame()),frame);assert.equal(await frame.locator('#game').inputValue(),'native game state');
 await p.getByRole('heading',{name:'This address has moved',exact:true}).waitFor();await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await p.screenshot({path:resolve(out,'replacement-gate-error-1440.png'),fullPage:true});await p.setViewportSize({width:390,height:844});await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await p.screenshot({path:resolve(out,'replacement-gate-error-390.png'),fullPage:true});
 const bounds=await p.getByRole('button',{name:'Retry transfer',exact:true}).boundingBox();assert.ok(bounds&&bounds.width>=44&&bounds.height>=44&&bounds.x>=0&&bounds.x+bounds.width<=390);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.getByRole('button',{name:'Retry transfer',exact:true}).click();await p.waitForFunction(()=>window.fixture.checkpoints===2);assert.equal(await p.evaluate(()=>window.fixture.mounts),1);assert.equal(await p.evaluate(()=>window.fixture.unmounts),0);assert.equal(await frame.locator('#game').inputValue(),'native game state');
 assert.deepEqual(errors,[]);
 writeFileSync(resolve(out,'REPLACEMENT_GATE_BROWSER.json'),JSON.stringify({result:'PASS',browser:browser.version(),mounts:1,unmounts:0,iframeIdentityPreserved:true,draftPreserved:true,nativeGameDraftPreserved:true,checkpointFailureDidNotFlush:true,retryReachable:true,viewports:[{width:1440,height:1000},{width:390,height:844}],pageerrors:errors,screenshots:['replacement-gate-pending-1440.png','replacement-gate-error-1440.png','replacement-gate-error-390.png'],scope:'Real React HubGate with synthetic I/O, not live endpoint activation.'},null,2)+'\n');
 console.log('REPLACEMENT_GATE_BROWSER=PASS; ACTUAL_REACT=PASS; MOUNTS=1; UNMOUNTS=0; IFRAME_IDENTITY=UNCHANGED; DRAFTS=RETAINED; FAILED_CHECKPOINT_FLUSHES=0; RETRY=REACHABLE; MOBILE_OVERFLOW=NONE');
}catch(error){writeFileSync(resolve(out,'REPLACEMENT_GATE_BROWSER.json'),JSON.stringify({result:'FAIL',error:error.message},null,2)+'\n');console.error(error.stack);process.exitCode=1;}
finally{await browser?.close();await server?.close();}
