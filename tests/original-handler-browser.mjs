/** Reuse the actual built frontend/opaque-document fixture, not a second
 * synthetic runtime. Only website response bytes are deterministic. Handler
 * execution uses the actual planner, logical/physical CSP and pinned rewriter.
 * No external website requests or production changes are performed. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve();
const base = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
const cut = base.indexOf("  const png =");
const cleanup = base.lastIndexOf("\n} finally {");
assert.ok(cut > 0 && cleanup > cut, "frontend fixture seams unchanged");
let source = base
  .slice(0, cut)
  .replace(
    /(from\s+["'])\.\.\/([^"']+)/g,
    (_match, start, path) => start + pathToFileURL(join(root, path)).href,
  );
source +=
  `
  const cases = [
    {name:'no-policy',policies:[],allow:true},
    {name:'explicit-allow',policies:["script-src 'nonce-dGVzdA==';script-src-attr 'unsafe-inline'"],allow:true},
    {name:'explicit-deny',policies:["script-src 'unsafe-inline';script-src-attr 'none'"],allow:false},
    {name:'nonce-fallback-deny',policies:["script-src 'nonce-dGVzdA==' 'unsafe-inline'"],allow:false},
    {name:'hash-fallback-deny',policies:["script-src 'nonce-dGVzdA==' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' 'unsafe-inline'"],allow:false},
    {name:'default-fallback-allow',policies:["default-src 'unsafe-inline'"],allow:true},
    {name:'strict-dynamic-deny',policies:["script-src 'nonce-dGVzdA==' 'strict-dynamic' 'unsafe-inline'"],allow:false},
    {name:'intersection-deny',policies:["script-src 'nonce-dGVzdA==';script-src-attr 'unsafe-inline'","script-src 'nonce-dGVzdA==';script-src-attr 'none'"],allow:false},
  ];
  const receipts=[];
  for (const item of cases) {
    const result=await page.evaluate(async item=>{
      const {createFrontendBrowser}=await import('/fixture.js');
      window.handlerBrowser?.dispose();
      const record="let frontendRead=false;try{frontendRead=!!parent.document.querySelector('main[data-trusted-frontend]')}catch{};window.handlerCalls.push({id:this.id,thisCorrect:this===document.getElementById(this.id),eventCorrect:event.type==='click'&&event.target===this&&event.currentTarget===this,frontendRead});this.dataset.hit='yes';return false";
      const html='<!doctype html><html><head><title>Handler fixture</title></head><body><button id="original" onclick="'+record+'">Original</button><script nonce="dGVzdA==">window.handlerCalls=[];window.handlerPrevented={};const original=document.getElementById("original");original.addEventListener("click",e=>window.handlerPrevented.original=e.defaultPrevented);const dynamic=document.createElement("button");dynamic.id="dynamic";dynamic.textContent="Dynamic";dynamic.setAttribute("onclick",'+JSON.stringify(record)+');dynamic.addEventListener("click",e=>window.handlerPrevented.dynamic=e.defaultPrevented);document.body.append(dynamic);window.handlerFixtureReady=true;</script></body></html>';
      const controller=await createFrontendBrowser({container:document.querySelector('main'),timeoutMs:15000,components:{fetch:()=>async request=>{if(request.url!=='https://site.example/handlers')throw Error('fixture_destination_denied');return{url:request.url,status:200,statusText:'OK',headers:[['content-type','text/html;charset=utf-8'],...item.policies.map(policy=>['content-security-policy',policy])],body:new TextEncoder().encode(html).buffer}}}});
      window.handlerBrowser=controller;
      await controller.start('https://site.example/handlers');
      return {frames:document.querySelectorAll('main iframe').length};
    },item);
    assert.equal(result.frames,1);
    const frame=page.frames().find(frame=>frame.url().startsWith(frontend+'/browse/frame/'));
    assert.ok(frame);
    await frame.waitForFunction(()=>window.handlerFixtureReady===true,null,{timeout:10000});
    await frame.locator('#original').click();
    await frame.locator('#dynamic').click();
    const observation=await frame.evaluate(()=>({calls:window.handlerCalls,prevented:window.handlerPrevented,hits:[document.getElementById('original').dataset.hit||null,document.getElementById('dynamic').dataset.hit||null],physicalAttributePolicy:[...document.querySelectorAll('meta[http-equiv]')].filter(meta=>meta.httpEquiv.toLowerCase()==='content-security-policy').map(meta=>meta.content).some(policy=>policy.includes("script-src-attr 'unsafe-inline'"))?'allow':'deny'}));
    assert.equal(observation.physicalAttributePolicy,item.allow?'allow':'deny');
    assert.deepEqual(observation.hits,item.allow?['yes','yes']:[null,null]);
    assert.deepEqual(observation.prevented,{original:item.allow,dynamic:item.allow});
    assert.deepEqual(observation.calls,item.allow?['original','dynamic'].map(id=>({id,thisCorrect:true,eventCorrect:true,frontendRead:false})):[]);
    const sandbox=await page.locator('main iframe').getAttribute('sandbox');
    assert.ok(sandbox.split(/\\s+/).includes('allow-scripts'));
    assert.equal(sandbox.split(/\\s+/).includes('allow-same-origin'),false);
    const session=await page.context().newCDPSession(frame);
    const tree=await session.send('Page.getFrameTree');
    const target=tree.frameTree.frame.url.startsWith(frontend+'/browse/frame/')?tree.frameTree:tree.frameTree.childFrames?.find(child=>child.frame.url.startsWith(frontend+'/browse/frame/'));
    assert.ok(target);
    const world=await session.send('Page.createIsolatedWorld',{frameId:target.frame.id,worldName:'handler-native-isolation',grantUniveralAccess:false});
    const native=await session.send('Runtime.evaluate',{contextId:world.executionContextId,expression:"(()=>{try{void parent.document;return 'allowed'}catch(error){return error.name}})()",returnByValue:true});
    assert.equal(native.result.value,'SecurityError');
    await session.detach();
    receipts.push({name:item.name,originalAndDynamicHandlers:item.allow?'executed':'denied',thisAndEventPreserved:true,frontendDOMDenied:true,nativeOriginOpaque:true,physicalAttributePolicy:observation.physicalAttributePolicy});
  }
  const javascriptURLGate=await page.evaluate(async()=>{
    window.handlerBrowser?.dispose();
    const {createFrontendBrowser}=await import('/fixture.js');
    const controller=await createFrontendBrowser({container:document.querySelector('main'),timeoutMs:15000,components:{fetch:()=>async request=>({url:request.url,status:200,statusText:'OK',headers:[['content-type','text/html;charset=utf-8']],body:new TextEncoder().encode('<!doctype html><a href="javascript:window.javascriptURLExecuted=true">Rejected</a>').buffer})}});
    try{await controller.start('https://site.example/javascript-url');return{rejected:false}}catch(error){return{rejected:true,code:error.code}}finally{controller.dispose()}
  });
  assert.deepEqual(javascriptURLGate,{rejected:true,code:'original_plan_handler_unsupported'});
  console.log(JSON.stringify({originalHandlers:receipts,javascriptURLGate,realPlannerAndPinnedRewriter:true,productionChanges:false}));
` + base.slice(cleanup);
const probe = join(root, "tests", `.original-handler-probe-${process.pid}.mjs`);
await fs.writeFile(probe, source);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await fs.rm(probe, { force: true });
}
