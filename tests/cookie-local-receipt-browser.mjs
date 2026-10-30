/** Actual Chromium filesystem URL reads racing worker receipt publications. */
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const baseline=process.env.ATLAS_COOKIE_RECEIPT_BASELINE==='1';
const evidence=resolve('evidence/chat-stream-20261029');await mkdir(evidence,{recursive:true});
const path=baseline?resolve(evidence,'original/runtime/cookie-local-receipt.ts'):resolve('runtime/cookie-local-receipt.ts');
const source=await readFile(path,'utf8');
const{build}=createRequire(import.meta.resolve('vite'))('esbuild');
const code=(await build({stdin:{contents:source,resolveDir:resolve('runtime'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const app=Fastify({logger:false});let httpRequests=0;
app.addHook('onRequest',async()=>{httpRequests++;});
app.get('/',(_q,r)=>r.type('text/html').send('<!doctype html><title>Cookie receipt publication race</title>'));
app.get('/api.js',(_q,r)=>r.type('text/javascript').send(code));
app.get('/worker.js',(_q,r)=>r.type('text/javascript').send(`import{createCookieLocalReceiptWriter}from'/api.js';let writer;onmessage=({data})=>{if(data.type==='init'){writer=createCookieLocalReceiptWriter(self,'cookie_race_synthetic_0123456789');return postMessage({grant:writer?.grant});}if(data.type==='write')try{writer.write(data.seq,'x'.repeat(data.length));}catch(e){postMessage({error:e.name});}if(data.type==='inspect'){const fs=webkitRequestFileSystemSync(TEMPORARY,4*1024*1024),d=fs.root.getDirectory('atlas-cookie-receipts-v2',{create:false}).getDirectory(writer.grant.directory,{create:false});postMessage({files:d.createReader().readEntries().map(f=>f.name).sort()});}if(data.type==='dispose'){writer.dispose();postMessage({disposed:true});}}`));
let browser;const report={command:(baseline?'ATLAS_COOKIE_RECEIPT_BASELINE=1 ':'')+'node tests/cookie-local-receipt-browser.mjs',productionChanged:false,baseline,sourceSHA256:createHash('sha256').update(source).digest('hex')};
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
 const page=await browser.newPage();let rangeErrors=0;page.on('console',m=>{if(m.text().includes('ERR_REQUEST_RANGE_NOT_SATISFIABLE'))rangeErrors++;});await page.goto(origin);
 await page.evaluate(async()=>{const{createCookieLocalReceiptReader}=await import('/api.js');window.worker=new Worker('/worker.js',{type:'module'});const grant=await new Promise((res,rej)=>{worker.onerror=e=>rej(Error(e.message));worker.onmessage=e=>res(e.data.grant);worker.postMessage({type:'init'});});window.reader=createCookieLocalReceiptReader({host:window,documentId:'cookie_race_synthetic_0123456789',grant});if(reader.read(0)!=='atlas-local-receipt-probe')throw Error('probe failed');});
 const beforeHTTP=httpRequests;
 report.checks=await page.evaluate(async()=>{
  const rows=[];let misses=0;for(let seq=1;seq<=240;seq++){const length=seq%4===0?8:seq%4===1?50000:seq%4===2?1000:100000;worker.postMessage({type:'write',seq,length});const start=performance.now();let value=reader.read(seq);if(value===undefined)value=reader.read(seq);if(value?.length!==length)misses++;rows.push({sequence:seq,milliseconds:performance.now()-start,ok:value?.length===length});}
  // The same sequence can regenerate its lost receipt, without an extra native
  // website mutation. This helper does no website mutation itself.
  worker.postMessage({type:'write',seq:240,length:8});const replay=reader.read(240);
  const files=await new Promise((res,rej)=>{worker.onerror=e=>rej(Error(e.message));worker.onmessage=e=>res(e.data.files);worker.postMessage({type:'inspect'});});reader.dispose();await new Promise((res,rej)=>{worker.onerror=e=>rej(Error(e.message));worker.onmessage=e=>res(e.data.disposed);worker.postMessage({type:'dispose'});});worker.terminate();return{operations:rows.length,misses,firstMiss:rows.find(r=>!r.ok),maxMs:Math.max(...rows.map(r=>r.milliseconds)),sameSequenceRegenerated:replay==='x'.repeat(8),publishedFiles:files};
 });report.checks.httpRequestsDuringReceipts=httpRequests-beforeHTTP;report.checks.filesystemRangeErrors=rangeErrors;
 if(baseline){assert.ok(rangeErrors>0||report.checks.misses>0,'retained old writer must reproduce the race');report.result='BASELINE_REPRODUCED';console.log('COOKIE_BASELINE_REPRODUCED: in-place slot publication causes filesystem range errors or missing receipts');}
 else{assert.equal(report.checks.operations,240);assert.equal(report.checks.misses,0);assert.equal(rangeErrors,0);assert.equal(report.checks.httpRequestsDuringReceipts,0);assert.equal(report.checks.sameSequenceRegenerated,true);assert.deepEqual(report.checks.publishedFiles,['r0','r1']);report.result='PASS';console.log('COOKIE_ATOMIC PASS: 240 alternating receipts, zero range errors/misses, exact replay, two published slots, zero HTTP receipt traffic');}
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}
finally{await writeFile(resolve(evidence,baseline?'COOKIE_ATOMIC_BROWSER_BASELINE.json':'COOKIE_ATOMIC_BROWSER.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
