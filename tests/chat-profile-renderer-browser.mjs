/** Actual built normal host/controller/SW/rewriter with synthetic remote HTTP.
 * Only the assigned transport is replaced; website/runner code uses native ports.
 * No user account, public-site request, cookies or conversations are accessed. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import Fastify from 'fastify';
import { chromium } from '@playwright/test';

const evidence = resolve('evidence/chat-stream-20261029');
await mkdir(evidence, { recursive: true });
const baseline = process.env.ATLAS_CHAT_RENDERER_BASELINE === '1';
const directory = resolve(baseline ? 'evidence/chat-stream-20261029/baseline-runtime' : 'dist/runtime');
const profileId = '11111111-1111-4111-8111-111111111111';
const target = 'https://chatgpt.com/test';
const runner = 'https://cdn.platform.openai.com/deployments/dil/v15/runner.html';
const moduleURL = 'https://cdn.platform.openai.com/assets/dil/runner-proof123456.js';
const policy = "default-src 'none'; script-src https://cdn.platform.openai.com/assets/dil/; frame-src 'none'; style-src 'unsafe-inline'";
const parts = ['first ', 'partial ', 'complete'];
const runnerModule = `const output=document.querySelector('output');const channel=new MessageChannel();let text='';let parentBlocked=false,storageBlocked=false;try{parent.document}catch(e){parentBlocked=e.name==='SecurityError'}try{localStorage.getItem('probe')}catch(e){storageBlocked=e.name==='SecurityError'}channel.port1.onmessage=e=>{if(e.data?.kind==='chunk'){text+=e.data.text;output.textContent=text;channel.port1.postMessage({kind:'rendered',text,origin:self.origin,parentBlocked,storageBlocked,hasRuntime:!!self[Symbol.for('runtimekit client global')]})}if(e.data?.kind==='complete'){output.dataset.complete='true';channel.port1.postMessage({kind:'complete',text})}};channel.port1.start();parent.postMessage({kind:'fixture-renderer-ready'},'*',[channel.port2]);`;
const runnerHTML = '<!doctype html><html><head><script type="module" src="'+moduleURL+'"></script></head><body><output></output></body></html>';
const parentHTML = `<!doctype html><html><head><title>Chat stream renderer regression</title></head><body><output id="chat-status">waiting</output><script>
window.rendererProof={chunks:[],rendered:[],ready:false,complete:false,profileBound:window.__fixtureProfileBound===true};let port;let pending=[];let done=false;
addEventListener('message',e=>{if(e.data?.kind!=='fixture-renderer-ready'||e.ports.length!==1)return;rendererProof.ready=true;port=e.ports[0];port.onmessage=e=>{if(e.data?.kind==='rendered'){rendererProof.rendered.push(e.data);document.querySelector('#chat-status').textContent=e.data.text}if(e.data?.kind==='complete'){rendererProof.complete=true;rendererProof.final=e.data.text}};port.start();for(const text of pending)port.postMessage({kind:'chunk',text});pending=[];if(done)port.postMessage({kind:'complete'})});
const child=document.createElement('iframe');child.title='Response renderer';child.sandbox='allow-scripts';child.src=${JSON.stringify(runner)};document.body.append(child);
(async()=>{const r=await fetch('/fixture-conversation');const reader=r.body.getReader();const decoder=new TextDecoder();for(;;){const next=await reader.read();if(next.done)break;const text=decoder.decode(next.value,{stream:true});rendererProof.chunks.push(text);if(port)port.postMessage({kind:'chunk',text});else pending.push(text)}done=true;rendererProof.streamFinished=true;if(port)port.postMessage({kind:'complete'})})().catch(e=>rendererProof.error=e.name);
</script></body></html>`;
const errors = [], physicalRequests = [], fallbacks = [], upstream = [];
const app = Fastify({ logger: false });
let origin, browser;
const types = { '.html':'text/html', '.js':'application/javascript', '.wasm':'application/wasm', '.json':'application/json', '.css':'text/css' };
const serve = async (file, reply) => {
  try { return reply.type(types[extname(file)] || 'application/octet-stream').header('cache-control','no-store').send(await readFile(file)); }
  catch { return reply.code(404).send('Fixture asset missing'); }
};
app.get('/', (_q, r) => r.type('text/html').send(`<!doctype html><title>Profile host fixture</title><iframe id="runtime" title="Atlas runtime"></iframe><script>
window.messages=[];window.preparations=[];window.installs=[];window.transportIdentities=[];addEventListener('message',e=>{if(e.data?.atlas===1)messages.push(e.data)});
const frame=document.querySelector('#runtime');const bridge={profileId:${JSON.stringify(profileId)},browserSessionId:'fixture-browser',frameId:'fixture-tab',profileContextId:'fixture-context',topLevelURL:()=>${JSON.stringify(target)},async prepareOrigin(){},async getRequestHeader(){return ''},async storeResponseCookies(){},async prepareDocument(o){preparations.push({id:o.documentId,website:o.website});return{documentId:o.documentId,website:o.website,profileId:${JSON.stringify(profileId)},install(win){win.__fixtureProfileBound=true;installs.push(o.documentId)},dispose(){}}},async bindWorkerIndexedDB(){const c=new MessageChannel();return{port:c.port2,dispose(){c.port1.close();c.port2.close()}}}};
window[Symbol.for('atlas.scramjet.profile.v1')]={get(win){return win===frame.contentWindow?bridge:undefined}};frame.src='/browse/runtime/#ticket=fixture-ticket';
</script>`));
app.get('/favicon.ico', (_q,r)=>r.code(204).send());
app.get('/runtime-config', (_q,r)=>r.send({appOrigin:origin,runtimeOrigin:origin,runtimePath:'/browse/runtime/',profileRuntime:true,relayOrigin:origin,relayTicket:'fixture-relay-ticket',session:'fixture-session',generation:1,node:{id:'fixture-node',name:'Fixture node'}}));
app.get('/clients/httpengine-client.js', (_q,r)=>r.type('application/javascript').send(`(()=>{const nativeFetch=fetch.bind(window);class HttpEngineClient{constructor(options){this.options=options;this.ready=true;parent.transportIdentities.push(options.relay)}async init(){}async request(remote,method,body,headers,signal){const r=await nativeFetch('/fixture-upstream?target='+encodeURIComponent(remote.href),{method,body:['GET','HEAD'].includes(method)?undefined:body,signal});return{url:remote.href,status:r.status,statusText:r.statusText,headers:[...r.headers],body:r.body}}connect(){throw Error('Fixture does not open sockets')}updateRelay(value){this.options.relay=value}}window.HttpEngineTransport={HttpEngineClient}})();`));
app.route({method:['GET','POST'],url:'/fixture-upstream',handler:async(q,r)=>{
 const remote=q.query.target;upstream.push(remote);
 if(remote===target)return r.type('text/html').send(parentHTML);
 if(remote===runner)return r.type('text/html').header('content-security-policy',policy).send(runnerHTML);
 if(remote===moduleURL)return r.type('application/javascript').header('access-control-allow-origin','*').send(runnerModule);
 if(remote==='https://chatgpt.com/fixture-conversation'){
  r.hijack();r.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
  for(const part of parts){r.raw.write(part);await new Promise(done=>setTimeout(done,650));}r.raw.end();return;
 }
 if(remote==='https://chatgpt.com/favicon.ico')return r.code(204).send();
 return r.code(404).type('text/plain').send('No synthetic response');
}});
app.get('/worker.js', (_q,r)=>{r.header('service-worker-allowed','/');return serve(join(directory,'worker.js'),r)});
app.get('/browse/runtime', (_q,r)=>r.redirect('/browse/runtime/'));
app.get('/browse/runtime/*', (q,r)=>serve(join(directory,q.params['*']||'index.html'),r));
for(const name of ['runtime','controller','bootstrap','clients'])app.get('/'+name+'/*',(q,r)=>serve(join(directory,name,q.params['*']),r));
app.get('/~/app/*',(q,r)=>{fallbacks.push(q.url);return r.code(503).type('text/plain').send('Proxy worker is not controlling this page. Reload Atlas and retry.')});
const report={baseline,command:(baseline?'ATLAS_CHAT_RENDERER_BASELINE=1 ':'')+'node tests/chat-profile-renderer-browser.mjs',productionChanged:false,fixtureTransportOnly:true,builtRuntimeDirectory:directory};
try{
 origin=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
 const context=await browser.newContext();
 await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==origin)return route.abort();return route.continue()});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text().replace(/https?:\/\/[^\s]+/g,'<URL>'))});page.on('request',q=>physicalRequests.push(new URL(q.url()).pathname));
 await page.goto(origin);await page.waitForFunction(()=>messages.some(m=>m.type==='ready'),null,{timeout:20000});
 await page.evaluate(({origin,target})=>document.querySelector('#runtime').contentWindow.postMessage({atlas:1,type:'navigate',id:'fixture-tab',url:target,engine:'runtime'},origin),{origin,target});
 let website;
 for(let i=0;i<200;i++){
  website=page.frames().find(f=>f.url().includes('/~/app/')&&f.url().includes('v1.'));
  if(website&&await website.evaluate(()=>!!window.rendererProof).catch(()=>false))break;
  await page.waitForTimeout(100);
 }
 assert.ok(website,'actual normal controller must load the website');
 let partialVisibleBeforeStreamEnd=false;
 if(!baseline){await website.waitForFunction(()=>rendererProof.rendered.length>0&&!rendererProof.streamFinished,null,{timeout:15000});const partial=await website.locator('#chat-status').innerText();assert.ok(partial.length>0&&partial.length<parts.join('').length);partialVisibleBeforeStreamEnd=true;}
 await website.waitForFunction(()=>rendererProof.streamFinished,null,{timeout:20000});
 assert.equal(await website.evaluate(()=>rendererProof.profileBound),true,'profile bridge must be active');
 if(baseline){
  await page.waitForTimeout(700);const proof=await website.evaluate(()=>rendererProof);
  assert.equal(proof.chunks.join(''),parts.join(''));assert.equal(proof.ready,false);assert.equal(proof.rendered.length,0);assert.ok(fallbacks.length>0);
  Object.assign(report,{result:'BASELINE_REPRODUCED',streamChunks:proof.chunks.length,rendererReady:false,renderer503:fallbacks.length});
  console.log('BASELINE_REPRODUCED: profile stream arrives; v15 opaque renderer 503; no visible response');
 }else{
  await website.waitForFunction(()=>rendererProof.complete,null,{timeout:15000});const proof=await website.evaluate(()=>rendererProof);
  assert.equal(proof.ready,true);assert.equal(proof.chunks.length,3);assert.equal(proof.rendered.length,3);assert.equal(proof.final,parts.join(''));assert.equal(proof.rendered[0].text,parts[0]);assert.equal(proof.rendered[1].text,parts.slice(0,2).join(''));
  assert.ok(proof.rendered.every(v=>v.origin==='null'&&v.parentBlocked&&v.storageBlocked&&v.hasRuntime===false));assert.equal(fallbacks.length,0,'managed opaque renderer must not leak obsolete proxy navigations');
  assert.ok(upstream.includes(runner)&&upstream.includes(moduleURL));
  let child;for(const candidate of website.childFrames())if(await candidate.locator('output').count().catch(()=>0)){child=candidate;break;}assert.ok(child,'real opaque renderer document exists');assert.equal(await child.evaluate(()=>self.origin),'null');assert.equal(await child.locator('output').innerText(),parts.join(''));assert.equal(await child.locator('output').getAttribute('data-complete'),'true');
  const identities=await page.evaluate(()=>transportIdentities);assert.deepEqual(identities,['ws://'+new URL(origin).host+'/relay/fixture-relay-ticket/']);
  Object.assign(report,{result:'PASS',streamChunks:proof.chunks.length,visibleUpdates:proof.rendered.map(v=>v.text.length),finalLength:proof.final.length,renderer503:fallbacks.length,opaqueIsolation:true,profileBound:true,relayUnchanged:true,partialVisibleBeforeStreamEnd});
  console.log('CHAT_PROFILE_RENDERER PASS: actual normal host + profile bridge + SW; streaming partial/final response; opaque isolation; same assigned relay');
 }
 report.preparations=await page.evaluate(()=>preparations.map(p=>({documentIdPresent:!!p.id,website:p.website})));report.installedDocumentCount=await page.evaluate(()=>installs.length);
 report.upstreamRequests=upstream;report.physicalRequestPaths=physicalRequests;report.errors=errors;
}catch(error){report.result='FAIL';report.error=error.stack;report.errors=errors;report.fallbackCount=fallbacks.length;console.error(error);if(browser){try{report.frames=(await browser.contexts()[0].pages()[0].frames()).map(f=>f.url().split('?')[0]);report.messages=await browser.contexts()[0].pages()[0].evaluate(()=>messages)}catch{}}process.exitCode=1;}
finally{await writeFile(join(evidence,baseline?'PROFILE_RENDERER_BASELINE.json':'PROFILE_RENDERER.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await app.close();}
