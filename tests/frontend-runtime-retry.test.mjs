import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendWorkspace } from '../web/src/frontend-runtime.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { const end=Date.now()+1000; while(!check()) { if(Date.now()>end) throw Error('Expected browser initialization did not start'); await tick(); } }
const rateLimited = () => Object.assign(Error('Control request failed.'), { status:429, code:'CONTROL_UNAVAILABLE', retryable:true });
function fixture(t, { failCreate = false, failStart = false, holdCreate = false, holdStart = false } = {}) {
  const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v) }; };
  const factoryCalls = [], browsers = [], events = [], requests = [];
  const owner = { crypto:globalThis.crypto, location:{origin:'https://front.test'}, sessionStorage:storage(), localStorage:storage() };
  owner.document = { defaultView:owner, createElement() { return { ownerDocument:this, style:{}, dataset:{}, hidden:false, remove(){this.removed=true;} }; } };
  const container = { ownerDocument:owner.document, children:[], appendChild(element){this.children.push(element);} };
  let releaseCreate, releaseStart;
  const createGate = holdCreate ? new Promise(r=>{releaseCreate=r;}) : null;
  const startGate = holdStart ? new Promise(r=>{releaseStart=r;}) : null;
  const workspace = createFrontendWorkspace({
    container, claimWindow:async()=>({id:'f'.repeat(32),dispose(){}}), onEvent:e=>events.push(e),
    createBrowser:async options=>{
      factoryCalls.push(options);
      if (failCreate && factoryCalls.length===1) { requests.push({path:'/api/browse/controller/runtime',status:429}); throw rateLimited(); }
      if (createGate) await createGate;
      requests.push({path:'/api/browse/controller/runtime',status:200});
      let connected=false, startAttempts=0;
      const browser = {
        calls:[], disposed:false, document:{frame:{}},
        async connect(){ if (!connected) { connected=true; browser.calls.push(['connect']); } },
        async start(url){
          browser.calls.push(['start',url]); startAttempts++;
          if (failStart && startAttempts===1) { requests.push({path:'/api/browse/controller/session',status:429}); throw rateLimited(); }
          await browser.connect(); if (startGate) await startGate;
          requests.push({path:'/api/browse/controller/session',status:200}); options.onLocation?.(url); options.onState?.({status:'ready'});
        },
        async navigate(url){
          if (!connected) throw Object.assign(Error('FRONTEND_BROWSER_DISPOSED'),{code:'FRONTEND_BROWSER_DISPOSED'});
          browser.calls.push(['navigate',url]); options.onLocation?.(url); options.onState?.({status:'ready'});
        },
        runtimeCommand(type){browser.calls.push(['runtime',type]);return true;},
        historyCommand(type){browser.calls.push(['history',type]);return true;},
        pageCommand(){return true;}, async reconnect(){browser.calls.push(['reconnect']);}, async check(){browser.calls.push(['check']);},
        dispose(){browser.disposed=true;},
      };
      browsers.push(browser); return browser;
    },
  });
  t.after(()=>workspace.dispose());
  return {workspace,container,factoryCalls,browsers,events,requests,releaseCreate:()=>releaseCreate?.(),releaseStart:()=>releaseStart?.()};
}
test('real workspace retries session429 through browser.start instead of treating a failed connection as started',async t=>{
  const f=fixture(t,{failStart:true});
  await assert.rejects(f.workspace.navigate('game','https://orteil.dashnet.org/cookieclicker/'),{status:429});
  assert.equal(f.requests.filter(r=>r.path==='/api/browse/controller/session').length,1);
  await f.workspace.navigate('game','https://orteil.dashnet.org/cookieclicker/');
  assert.deepEqual(f.requests.filter(r=>r.path==='/api/browse/controller/session').map(r=>r.status),[429,200]);
  assert.equal(f.factoryCalls.length,1,'healthy browser/controller instance is retained');
  assert.equal(f.browsers[0].calls.filter(c=>c[0]==='connect').length,1);
  assert.equal(f.events.at(-1).type,'loaded');
});
test('native reload retry reinitializes a failed session rather than sending reload into an unstarted runtime',async t=>{
  const f=fixture(t,{failStart:true});
  await assert.rejects(f.workspace.navigate('game','https://orteil.dashnet.org/cookieclicker/'),{status:429});
  await f.workspace.command('reload',{id:'game'});
  assert.deepEqual(f.requests.filter(r=>r.path==='/api/browse/controller/session').map(r=>r.status),[429,200]);
  assert.equal(f.browsers[0].calls.some(c=>c[0]==='history'),false);
});
test('explicit retry recreates only a rejected factory flight with the same tab/container identity',async t=>{
  const f=fixture(t,{failCreate:true});
  await assert.rejects(f.workspace.navigate('game','https://site.test/'),{status:429});
  const first=f.factoryCalls[0]; f.workspace.activate('game'); await tick();
  assert.equal(f.factoryCalls.length,1,'activation must not silently retry failed initialization');
  await f.workspace.command('reload',{id:'game'});
  assert.equal(f.factoryCalls.length,2); assert.equal(f.browsers.length,1);
  assert.equal(f.factoryCalls[1].container,first.container); assert.equal(f.factoryCalls[1].tabSessionId,first.tabSessionId);
  assert.equal(f.container.children.length,1); assert.equal(f.events.at(-1).type,'loaded');
});
test('concurrent retries after a rejected factory share one replacement and latest requested destination',async t=>{
  const f=fixture(t,{failCreate:true,holdCreate:true});
  await assert.rejects(f.workspace.navigate('game','https://site.test/fail'),{status:429});
  const first=f.workspace.navigate('game','https://site.test/older');
  const latest=f.workspace.navigate('game','https://site.test/latest');
  const outcomes=Promise.all([first,latest]); void outcomes.catch(()=>{});
  await until(()=>f.factoryCalls.length===2); f.releaseCreate(); await outcomes;
  assert.equal(f.browsers.length,1); assert.equal(f.browsers[0].calls.filter(c=>c[0]==='start').length,1);
  assert.deepEqual(f.browsers[0].calls.find(c=>c[0]==='start'),['start','https://site.test/latest']);
});
test('a newer navigation waits for pending startup without creating a second owner or connection',async t=>{
  const f=fixture(t,{holdStart:true}); const older=f.workspace.navigate('game','https://site.test/older');
  // Wait for the actual startup gate, not one event-loop turn: factory identity
  // hashing may still be pending under the full suite's default concurrency.
  await until(()=>f.browsers[0]?.calls.some(c=>c[0]==='start'&&c[1]==='https://site.test/older'));
  const latest=f.workspace.navigate('game','https://site.test/latest'); void latest.catch(()=>{}); await tick();
  assert.equal(f.browsers[0].calls.filter(c=>c[0]==='start').length,1);
  assert.deepEqual(f.browsers[0].calls.filter(c=>c[0]==='navigate'),[], 'latest navigation waits until the pending start completes');
  f.releaseStart(); await Promise.all([older,latest]);
  assert.equal(f.factoryCalls.length,1); assert.equal(f.browsers[0].calls.filter(c=>c[0]==='connect').length,1);
  assert.deepEqual(f.browsers[0].calls.filter(c=>c[0]==='navigate'),[['navigate','https://site.test/latest']]);
});
test('healthy reloads use their existing mounted history command and do not recreate or reconnect',async t=>{
  const f=fixture(t); await f.workspace.navigate('game','https://site.test/'); const frame=f.workspace.frame;
  await f.workspace.command('reload',{id:'game'}); f.workspace.activate('game'); await tick();
  assert.equal(f.factoryCalls.length,1); assert.equal(f.workspace.frame,frame);
  assert.equal(f.browsers[0].calls.filter(c=>c[0]==='start').length,1); assert.equal(f.browsers[0].calls.filter(c=>c[0]==='connect').length,1);
  assert.equal(f.browsers[0].disposed,false); assert.ok(f.browsers[0].calls.some(c=>c[0]==='history'&&c[1]==='reload'));
});
