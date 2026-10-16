import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewedRendererFetch} from '../runtime/sandbox-renderer.ts';
import {createOriginalDocumentPolicy} from '../runtime/original-document-policy.ts';
const documentURL='https://chatgpt.com/page',runner='https://cdn.platform.openai.com/deployments/dil/v14/runner.html',module='https://cdn.platform.openai.com/assets/dil/runner-fixture123.js';
const policy="default-src 'none'; script-src https://cdn.platform.openai.com/assets/dil/; frame-src 'none'";
function fixture(responses,framePolicy='frame-src https://cdn.platform.openai.com/deployments/dil/v14/runner.html'){
  const calls=[],controller=new AbortController();let active=true;
  const fetch=createReviewedRendererFetch({window:{DOMParser:class{parseFromString(){return{querySelectorAll(){return []}}}}},documentId:'doc_'+'a'.repeat(32),documentURL,policy:createOriginalDocumentPolicy({documentURL,contentPolicies:[framePolicy]}),signal:controller.signal,active:()=>active,fetch:async(request,context)=>{calls.push({request,context});const value=responses.shift();assert.ok(value,'unexpected transport');return{url:request.url,status:200,statusText:'OK',headers:[['content-type',request.destination==='iframe'?'text/html':'application/javascript'],...(request.destination==='iframe'?[['content-security-policy',policy]]:[['access-control-allow-origin','null'],['access-control-allow-credentials','true']])],body:new TextEncoder().encode('fixture').buffer,...value}}});
  return{fetch,calls,controller,stale(){active=false}};
}
test('renderer source uses immutable parent identity and null module CORS, with no caller headers',async()=>{const f=fixture([{},{}]);await f.fetch(new URL(runner),'include','document');await f.fetch(new URL(module),'include','module');assert.equal(f.calls.length,2);for(const {request,context}of f.calls){assert.equal(context.documentId,'doc_'+'a'.repeat(32));assert.equal(context.documentURL,documentURL);assert.equal(context.origin,'https://chatgpt.com');assert.deepEqual(request.headers,[]);assert.equal(request.redirect,'manual')}assert.equal(f.calls[1].context.requestOrigin,'null');assert.equal(f.calls[1].context.referrerURL,runner)});
test('original frame policy denies before first pinned-node fetch',async()=>{const f=fixture([],"frame-src 'none'");await assert.rejects(f.fetch(new URL(runner)),{code:'original_policy_denied'});assert.equal(f.calls.length,0)});
test('redirect to frontend/other runner is denied before destination fetch',async()=>{for(const destination of ['https://front.test/api/admin/state','https://cdn.platform.openai.com/unreviewed.html']){const f=fixture([{status:302,headers:[['location',destination]]}]);await assert.rejects(f.fetch(new URL(runner)),{code:'RENDERER_DESTINATION_DENIED'});assert.equal(f.calls.length,1)}});
test('frame original policy is rechecked on exact runner redirects',async()=>{const f=fixture([{status:302,headers:[['location',runner+'?redirected=1']]},{}]);await f.fetch(new URL(runner));assert.equal(f.calls.length,2);assert.equal(f.calls[1].context.redirectCount,1)});
test('module each-hop URL, original script policy, CORS and response headers are enforced',async()=>{
  for(const response of [{status:302,headers:[['location',module]]},{status:302,headers:[['location','https://front.test/private'],['access-control-allow-origin','null'],['access-control-allow-credentials','true']]},{headers:[['content-type','application/javascript'],['access-control-allow-origin','*'],['access-control-allow-credentials','true']]},{headers:[['content-type','application/javascript'],['access-control-allow-origin','null'],['access-control-allow-credentials','true'],['set-cookie','x=y']]}]){const f=fixture([{},response]);await f.fetch(new URL(runner));await assert.rejects(f.fetch(new URL(module),'include','module'));assert.equal(f.calls.length,2)}
  const f=fixture([{headers:[['content-type','text/html'],['content-security-policy',"default-src 'none';script-src https://denied.test;frame-src 'none'"]]}]);await f.fetch(new URL(runner));await assert.rejects(f.fetch(new URL(module),'include','module'),{code:'RENDERER_MODULE_POLICY_DENIED'});assert.equal(f.calls.length,1);
});
test('unqualified child response framing policies and revoked parents remain held',async()=>{for(const headers of [[['x-frame-options','DENY']],[['content-security-policy',policy+"; frame-ancestors 'none'"]]]){const f=fixture([{headers:[['content-type','text/html'],...headers]}]);await assert.rejects(f.fetch(new URL(runner)),{code:'RENDERER_RESPONSE_POLICY_UNSUPPORTED'})}const f=fixture([]);f.stale();await assert.rejects(f.fetch(new URL(runner)),{code:'RENDERER_PARENT_STALE'});assert.equal(f.calls.length,0)});

test('trusted renderer bounds preparing plus pending before awaits and releases every failed slot',async()=>{
  const {createRendererHelperBroker}=await import(process.env.ATLAS_RENDERER_BUDGET_BASELINE==='1'?'../evidence/renderer-default-integration-20261016/before/runtime/renderer-helper-broker.ts':'../runtime/renderer-helper-broker.ts');
  const w=Object.assign(new EventTarget(),{location:{origin:'https://front.test'},MessagePort,MessageEvent,EventTarget,crypto,MessageChannel,setTimeout,clearTimeout});
  const parent={frames:[]},child={parent};parent.frames[0]=child;
  const rejects=[];
  const broker=createRendererHelperBroker({window:w,parentDocumentId:'doc_'+'a'.repeat(32),parentWindow:parent,website:documentURL,activeParent:()=>true,authorizeFrame(){},reserveHelper:async()=>{throw Error('unexpected helper API')},fetchResource:()=>new Promise((resolve,reject)=>rejects.push(reject))});
  const promises=Array.from({length:100},()=>broker.reserve({url:runner,slot:0}).then(()=> 'unexpected-ready',e=>e.code??e.message));
  assert.equal(rejects.length,8,'only eight preparing fetches enter trusted transport');
  for(const reject of rejects)reject(Error('delayed transport failed'));
  const results=await Promise.all(promises);assert.equal(results.filter(v=>v==='RENDERER_RESERVATION_DENIED').length,92);assert.equal(results.filter(v=>v==='delayed transport failed').length,8);
  const recovered=broker.reserve({url:runner,slot:0}).catch(e=>e.message);assert.equal(rejects.length,9);rejects.at(-1)(Error('recovered slot'));assert.equal(await recovered,'recovered slot');broker.dispose();
});
