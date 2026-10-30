import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// An explicit, logged-out official-CDN snapshot is captured in this incident's
// public-v15 directory. Never load HAR credentials or account/browser sessions.
const evidence=resolve('evidence/chat-stream-20261029');
const baseline=process.env.ATLAS_RENDERER_BASELINE==='1';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const source=resolve('runtime/opaque-renderer.ts');
const bundle=(await build({entryPoints:[source],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',plugins:baseline?[{name:'retained-renderer-baseline',setup(b){b.onLoad({filter:/opaque-renderer\.ts$/},async({path})=>path===source?{contents:await readFile(resolve(evidence,'original/runtime/opaque-renderer.ts'),'utf8'),loader:'ts',resolveDir:resolve('runtime')}:undefined);}}]:[]})).outputFiles[0].text;
const qualification=JSON.parse(await readFile(resolve(evidence,'public-v15/QUALIFICATION.json'),'utf8'));
const html=await readFile(resolve(evidence,'public-v15/runner.html'),'utf8');
const module=await readFile(resolve(evidence,'public-v15',new URL(qualification.module.url).pathname.split('/').at(-1)),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
assert.equal(sha(html),qualification.sha256);assert.equal(sha(module),qualification.module.sha256);
const app=Fastify({logger:false});
app.get('/',(_r,reply)=>reply.type('text/html').send('<!doctype html><title>Native opaque renderer qualification</title><textarea>parent draft retained</textarea>'));
app.get('/adapter.js',(_r,reply)=>reply.type('application/javascript').send(bundle));
app.get('/snapshot',()=>({qualification,html,module}));
let browser;
const report={command:(baseline?'ATLAS_RENDERER_BASELINE=1 ':'')+'node tests/public-renderer-v15-browser.mjs',baseline,productionChanged:false,sourceSHA256:sha(await readFile(source)),publicHTMLSHA256:qualification.sha256,publicModuleSHA256:qualification.module.sha256};
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 report.browser=browser.version();const page=await browser.newPage();let spawnedWorkers=0;page.on('worker',()=>spawnedWorkers++);
 await page.goto(origin);
 report.checks=await page.evaluate(async({baseline})=>{
  const adapter=await import('/adapter.js'),snapshot=await(await fetch('/snapshot')).json(),url=new URL(snapshot.qualification.url);
  const selected=adapter.rendererTarget(url.href,'https://chatgpt.com/')?.href;
  if(baseline)return{selected:selected??null};
  const fetched=[];
  const fetchResource=async(target,credentials,kind)=>{
   fetched.push({url:target.href,credentials,kind});
   if(target.href===url.href)return{status:200,type:'text/html',text:snapshot.html,policies:[]};
   if(target.href===snapshot.qualification.module.url)return{status:200,type:'application/javascript',text:snapshot.module,policies:[],allowOrigin:snapshot.qualification.module.headers['access-control-allow-origin']};
   throw Error('UNEXPECTED_FETCH_DESTINATION');
  };
  const prepared=await adapter.prepareOpaqueDocument(window,url,fetchResource);
  const frame=document.createElement('iframe');frame.title='Public OpenAI v15 renderer';frame.sandbox='allow-scripts';
  let timeout;
  const ready=new Promise((resolve,reject)=>{
   const handler=e=>{
    if(e.source!==frame.contentWindow||e.data?.__oaiDilFrame!==true||e.data.kind!=='ready')return;
    clearTimeout(timeout);removeEventListener('message',handler);
    const port=e.ports[0];window.__v15ReadyPort=port;port.start();
    resolve({origin:e.origin,protocolVersion:e.data.protocolVersion,portCount:e.ports.length,nativePort:port instanceof MessagePort});
   };
   addEventListener('message',handler);timeout=setTimeout(()=>{removeEventListener('message',handler);reject(Error('PUBLIC_V15_READY_TIMEOUT'));},10000);
  });
  frame.srcdoc=prepared.html;document.body.append(frame);window.__v15Frame=frame;
  const handshake=await ready;let parentAccessDenied=false;try{void frame.contentWindow.document.body;}catch(e){parentAccessDenied=e.name==='SecurityError';}
  const parsed=new DOMParser().parseFromString(prepared.html,'text/html'),policy=parsed.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  const deny=async(change)=>{
   try{await adapter.prepareOpaqueDocument(window,url,async(target,c,k)=>{
    const response=await fetchResource(target,c,k);return k==='module'?change(response):response;
   });return null;}catch(e){return e.message;}
  };
  const rejectedCORS=await deny(r=>({...r,allowOrigin:'https://chatgpt.com'}));
  const rejectedDependencies=await deny(r=>({...r,text:r.text+'\nimport "./unexpected-dependency.js";'}));
  window.__v15Prepared=prepared;
  return{selected,fetched:fetched.slice(0,2),resources:prepared.resources,handshake,parentAccessDenied,sandbox:frame.getAttribute('sandbox'),policy,inlineModuleCount:parsed.querySelectorAll('script[type="module"]:not([src])').length,unknownVersionRejected:adapter.rendererTarget(url.href.replace('/v15/','/v16/'),'https://chatgpt.com/')===undefined,rejectedCORS,rejectedDependencies};
 },{baseline});
 if(baseline){assert.equal(report.checks.selected,null);report.result='BASELINE_REPRODUCED';console.log('RENDERER BASELINE: v15 not selected; opaque renderer retains broken service-worker path');}
 else{
  const c=report.checks;assert.equal(c.selected,qualification.url);assert.equal(c.resources,2);assert.equal(c.handshake.protocolVersion,15);assert.equal(c.handshake.origin,'null');assert.equal(c.handshake.portCount,1);assert.equal(c.handshake.nativePort,true);assert.equal(c.parentAccessDenied,true);assert.equal(c.sandbox,'allow-scripts');assert.equal(c.inlineModuleCount,1);assert.equal(c.unknownVersionRejected,true);assert.equal(c.rejectedCORS,'renderer_module_cors');assert.equal(c.rejectedDependencies,'renderer_module_dependencies');assert.match(c.policy,/default-src 'none'/);assert.match(c.policy,/frame-src 'none'/);assert.match(c.policy,/'sha256-/);assert.doesNotMatch(c.policy,/'unsafe-inline'/);
  const child=page.frames().find(f=>f.parentFrame()===page.mainFrame());assert.ok(child);
  report.nativeChecks=await child.evaluate(async()=>{
   let denied=false;try{void localStorage.length;}catch(e){denied=e.name==='SecurityError';}
   const script=document.createElement('script');script.textContent='document.body.dataset.unauthorized="executed"';document.head.append(script);await new Promise(r=>setTimeout(r,50));return{localStorageDenied:denied,unauthorizedInlineExecuted:document.body.dataset.unauthorized==='executed'};
  });
  assert.equal(report.nativeChecks.localStorageDenied,true);assert.equal(report.nativeChecks.unauthorizedInlineExecuted,false);
  report.spawnedWorkers=spawnedWorkers;assert.ok(spawnedWorkers>=1,'official self-contained renderer starts its native embedded worker');
  await page.evaluate(()=>{window.__v15ReadyPort.close();window.__v15Frame.remove();});
  report.result='PASS';console.log('RENDERER V15 PASS: official module ready protocol15 + native MessagePort, opaque sandbox/CSP retained, worker starts, unreviewed version/dependencies/CORS rejected');
 }
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}
finally{await writeFile(resolve(evidence,baseline?'PUBLIC_V15_BASELINE.json':'PUBLIC_V15_BROWSER.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
