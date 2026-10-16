/** Actual default runtime + controller and authenticated frontend helper.
 * Only fixed logical website response bodies are deterministic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
let source=await fs.readFile('tests/frontend-browser-browser.mjs','utf8');
function section(start,end,replacement){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);source=source.slice(0,a)+replacement+source.slice(b)}
source=source.replaceAll('https://site.example','https://chatgpt.com');
source=source.replace('  await page.goto(frontend);','  const physicalRequests=[];page.on("request",r=>physicalRequests.push(r.url()));\n  await page.goto(frontend);');
const runner='https://cdn.platform.openai.com/deployments/dil/v14/runner.html';
const module='https://cdn.platform.openai.com/assets/dil/runner-fixture123.js';
const policy="default-src 'none'; script-src https://cdn.platform.openai.com/assets/dil/ 'unsafe-eval'; frame-src 'none'; style-src 'unsafe-inline'";
const moduleSource=`const channel=new MessageChannel();channel.port1.onmessage=e=>{if(e.data?.type==='render')channel.port1.postMessage({type:'rendered',text:e.data.text,origin:self.origin})};parent.postMessage({type:'reviewed-ready'},'*',[channel.port2]);`;
const html=`<!doctype html><html><head><title>Reviewed renderer fixture</title></head><body><iframe title="Reviewed static renderer" sandbox="allow-scripts" src="${runner}"></iframe><script>window.rendererResults=[];addEventListener('message',e=>{if(e.data?.type!=='reviewed-ready'||e.ports.length!==1)return;const p=e.ports[0];p.onmessage=e=>{rendererResults.push(e.data);window.jointResult={renderer:true}};p.start();p.postMessage({type:'render',text:'visible response'})});</script></body></html>`;
section('  const html = `','  const boot =',`  const html=${JSON.stringify(html)};\n`);
source=source.replace("connect-src 'none'\"","connect-src 'none'; frame-src https://cdn.platform.openai.com/deployments/dil/v14/runner.html\"");
const anchor='      } else if (request.url === "https://assets.example/image") {';
assert.equal(source.split(anchor).length,2);
source=source.replace(anchor,`      } else if(request.url===${JSON.stringify(runner)}){body=${JSON.stringify('<!doctype html><html><head><script type="module" src="'+module+'"></script></head><body><output>Reviewed renderer</output></body></html>')};type='text/html';extra=[['content-security-policy',${JSON.stringify(policy)}]];
      } else if(request.url===${JSON.stringify(module)}){body=${JSON.stringify(moduleSource)};type='application/javascript';extra=[['access-control-allow-origin','null'],['access-control-allow-credentials','true']];
`+anchor);
section('  try {\n    await frame.waitForFunction','} finally {',`
  try {await frame.waitForFunction(()=>window.rendererResults?.length===1,null,{timeout:35000});}catch(error){console.error(JSON.stringify({errors,states:await page.evaluate(()=>jointStates),calls:await page.evaluate(()=>jointCalls),frames:page.frames().map(f=>f.url())}));throw error}
  assert.deepEqual(await frame.evaluate(()=>rendererResults),[{type:'rendered',text:'visible response',origin:'null'}]);
  await frame.evaluate(runner=>{for(const order of ['src-first','sandbox-first']){const f=document.createElement('iframe');f.title=order;if(order==='src-first'){f.src=runner;f.sandbox='allow-scripts'}else{f.sandbox='allow-scripts';f.src=runner}document.body.append(f)}},${JSON.stringify(runner)});
  try{await frame.waitForFunction(()=>rendererResults.length===3,null,{timeout:35000})}catch(error){console.error(JSON.stringify({stage:'dynamic-renderer',results:await frame.evaluate(()=>rendererResults),errors,calls:await page.evaluate(()=>jointCalls),frames:page.frames().map(f=>f.url()),declarations:await frame.evaluate(()=>Array.from(document.querySelectorAll('iframe')).map(f=>({title:f.title,src:f.src,sandbox:f.getAttribute('sandbox')})))}));throw error}

  assert.deepEqual(await frame.evaluate(()=>rendererResults.map(v=>v.text)),['visible response','visible response','visible response']);
  const child=page.frames().find(f=>f.url().startsWith(frontend+'/browse/renderer/v1/'));assert.ok(child);
  assert.equal(new URL(frame.url()).origin,frontend);assert.equal(new URL(child.url()).origin,frontend);
  const native=await child.evaluate(()=>{const r={origin:self.origin,hasRuntimeClient:!!self[Symbol.for('runtimekit client global')],nonce:document.querySelector('script')?.nonce??''};try{localStorage.getItem('x');r.storage='allowed'}catch(e){r.storage=e.name}try{parent.document;r.parent='allowed'}catch(e){r.parent=e.name}try{top.document;r.frontend='allowed'}catch(e){r.frontend=e.name}return r});
  assert.equal(native.origin,'null');assert.equal(native.hasRuntimeClient,false);assert.equal(native.storage,'SecurityError');assert.equal(native.parent,'SecurityError');assert.equal(native.frontend,'SecurityError');assert.equal(native.nonce,'');
  const calls=await page.evaluate(()=>jointCalls);assert.ok(calls.some(c=>c.url===${JSON.stringify(runner)}&&c.destination==='iframe'));assert.ok(calls.some(c=>c.url===${JSON.stringify(module)}&&c.destination==='script'));assert.ok(calls.every(c=>c.documentURL==='https://chatgpt.com/page'||c.documentURL==='https://chatgpt.com/start'));
  const repeat=await page.evaluate(async url=>(await fetch(url)).status,child.url());assert.equal(repeat,404);
  const denied=await app.inject({method:'POST',url:'/api/browse/controller/renderer',headers:{host:new URL(frontend).host,origin:'null'},payload:{parentDocumentId:'doc_'+'1'.repeat(32),scriptHashes:["'sha256-"+'A'.repeat(43)+"='"]}});assert.equal(denied.statusCode,403);
  assert.equal(physicalRequests.some(url=>url.includes('/~/')||url.startsWith('https://cdn.platform.openai.com/')),false);
  const result={result:'default_opaque_renderer_verified',assets:Object.keys(manifest.files).length,defaultController:true,defaultOpaqueDocument:true,authenticatedHelper:true,privateOriginalDocumentRendezvous:true,renderMessage:true,dynamicSourceOrders:2,noObsoleteNativeRendererRequest:true,native,consumedReplay:repeat,nullOriginAPI:denied.statusCode,errors,scope:'deterministic reviewed runner fixture; no named public ChatGPT rendering claim'};
  await fs.writeFile('evidence/renderer-default-integration-20261016/DEFAULT-RESULT.json',JSON.stringify(result,null,2)+'\\n');console.log(JSON.stringify(result));await page.evaluate(()=>frontendBrowser.dispose());
`);
if(process.env.ATLAS_DEFAULT_RENDERER_BASELINE==='1'){
 const before=await fs.readFile('evidence/renderer-default-integration-20261016/before/runtime/original-document-plan.ts','utf8');
 const anchor='  const bundle = await build({';assert.equal(source.split(anchor).length,2);
 source=source.replace(anchor,anchor+`plugins:[{name:'preserved-renderer-plan',setup(builder){builder.onLoad({filter:/original-document-plan\\.ts$/},()=>({contents:${JSON.stringify(before)},loader:'ts',resolveDir:resolve('runtime')}))}}],`);
 source=source.replace('  await page.evaluate(boot, { html, png });',`  try{await page.evaluate(boot,{html,png})}catch(error){if(!String(error).includes('original_plan_unsupported_element'))throw error;console.log('BASELINE: original_plan_unsupported_element; reviewed renderer not loaded');throw Error('BASELINE_EXPECTED_RENDERER_REJECTION')}`);
}
const path='tests/.default-renderer-generated-'+process.pid+'.mjs';await fs.writeFile(path,source);
try{const code=await new Promise(resolve=>{const child=spawn(process.execPath,[path],{stdio:'inherit',env:process.env});child.on('exit',resolve)});process.exitCode=code??1}finally{await fs.rm(path,{force:true})}
