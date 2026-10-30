// Exercise Vite's actual production worker and its lazy codec chunk, not an
// esbuild-only replacement. This catches worker-format/code-splitting regressions.
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {resolve,basename} from 'node:path';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const assets=resolve('dist/web/assets'),workerName=(await readdir(assets)).find(n=>/^backup-v2-worker-.*\.js$/.test(n));
assert.ok(workerName,'pnpm build must produce the module worker');
const api=(await build({bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',stdin:{resolveDir:resolve('runtime'),contents:"export {createBackupV2Actor} from '../web/src/backup-v2-actor.ts';export {writeBackupPreferences} from './backup-v2-preferences.ts';"}})).outputFiles[0].text;
const app=Fastify({logger:false}),base='/api/hub/profile/backups/v2',requested=[],errors=[];let manifest,publishes=0,browser;
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Built backup worker</title><input id="draft" value="retained">'));
app.get('/api.js',(_q,r)=>r.type('application/javascript').send(api));
app.get('/assets/:name',async(q,r)=>{assert.equal(q.params.name,basename(q.params.name));requested.push(q.params.name);return r.type('application/javascript').send(await readFile(resolve(assets,q.params.name)));});
app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_r,b,done)=>done(null,b));
app.post(base+'/replicas',q=>({...q.body,headCheckpointId:null,headSequence:0,adoptedThrough:0}));
app.post(base+'/replicas/:id/checkpoints',q=>{manifest=q.body;return {checkpointId:manifest.checkpointId,status:'prepared',missingParts:manifest.namespaces.flatMap(n=>n.parts.map(p=>p.sha256))};});
app.put(base+'/staging/:id/parts/:hash',()=>({stored:true}));
app.post(base+'/staging/:id/publish',()=>{publishes++;return {acknowledged:true,checkpointId:manifest.checkpointId,replicaId:manifest.replicaId,manifestDigest:manifest.manifestDigest,sequence:manifest.sequence,publicationOrdinal:String(publishes),completedAt:new Date().toISOString(),coverage:manifest.namespaces.map(n=>({namespaceVersionId:n.namespaceVersionId,localCut:n.localCut})),historyShortened:false};});
app.post(base+'/replicas/:id/adopt',q=>({replicaId:q.params.id,adoptedThrough:q.body.adoptedThrough}));
const report={command:'node tests/backup-built-worker-browser.mjs',productionChanged:false,workerName};
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 await page.evaluate(async name=>{window.api=await import('/api.js');window.replica=crypto.randomUUID();await api.writeBackupPreferences(indexedDB,replica,{'atlas.settings':'{"theme":"moss"}'});window.actor=api.createBackupV2Actor({replicaId:replica,incarnation:crypto.randomUUID(),label:'built-worker',headers:{},worker:()=>new Worker('/assets/'+name,{type:'module'})});await actor.initialize();document.querySelector('#draft').focus();await actor.flush();},workerName);
 const state=await page.evaluate(()=>({status:actor.status(),draft:document.querySelector('#draft').value,focus:document.activeElement.id}));
 assert.equal(publishes,1);assert.equal(state.status.lastCompleted?.sequence,1);assert.equal(state.draft,'retained');assert.equal(state.focus,'draft');assert.ok(requested.some(n=>/^backup-v2-resume-.*\.js$/.test(n)),'actual lazy chunk must load');assert.deepEqual(errors,[]);
 report.result='PASS';report.requested=requested;report.publishes=publishes;report.state=state;console.log('BUILT_WORKER PASS module worker and lazy codec fetched; checkpoint acknowledged; draft/focus retained');await page.evaluate(()=>actor.stop());
}catch(error){report.result='FAIL';report.error=error.stack;process.exitCode=1;console.error(error);}
finally{await writeFile(resolve('evidence/backup-scalability-completion-20261028/BUILT_WORKER.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
