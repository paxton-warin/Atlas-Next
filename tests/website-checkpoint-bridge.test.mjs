import test from 'node:test';
import assert from 'node:assert/strict';
import { createScramjetWebsiteDocument } from '../runtime/scramjet-document.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const listeners = new Map(), sent = [], timers = new Map(); let nextTimer = 0;
  const origin = 'https://front.test';
  const child = { name: 'any-page-controlled-name', postMessage(value, target) { sent.push({value,target}); } };
  const frame = { style: {}, contentWindow: child, remove() { this.removed = true; } };
  const owner = {
    crypto: globalThis.crypto, location: { origin }, document: { createElement: () => frame },
    addEventListener(type, callback) { listeners.set(type, callback); }, removeEventListener(type) { listeners.delete(type); },
    setInterval, clearInterval, setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id,{fn,ms}); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  const binding = createScramjetWebsiteDocument({
    container: { ownerDocument: { defaultView: owner }, appendChild() {} },
    website: 'https://orteil.dashnet.org/cookieclicker/', profileId: '11111111-1111-4111-8111-111111111111', profileContextId: 'context', browserSessionId: 'browser',
    createVisibility: () => ({ install: () => ({ dispose() {} }), dispose() {} }),
    runtimeTicket: async () => ({ runtimeTicket: 'test-grant', runtimePath: '/browse/runtime/' }),
    onLocation() {}, cookieProvider: {},
  });
  const receive = (extra = {}, source = child, eventOrigin = origin) => listeners.get('message')?.({ source, origin: eventOrigin, data: { atlas:1,id:binding.documentId,...extra } });
  return { binding, receive, sent, timers, child, frame, async ready() { await tick(); receive({type:'ready'}); receive({type:'loaded'}); await binding.ready; } };
}
test('actual controller checkpoint command uses a fresh request ID, physical iframe, logical origin and matching response', async () => {
  const f = fixture();
  try {
    await f.ready(); const operation = f.binding.checkpoint(); const message = f.sent.at(-1);
    assert.equal(message.target, 'https://front.test'); assert.equal(message.value.type,'profile-checkpoint');
    assert.equal(message.value.id,f.binding.documentId); assert.equal(message.value.origin,'https://orteil.dashnet.org');
    assert.match(message.value.requestId,/^[a-f0-9-]{36}$/i);
    assert.deepEqual([...f.timers.values()].map(v=>v.ms),[5000]);
    f.receive({type:'profile-checkpoint-result',requestId:message.value.requestId,ok:true}); await operation; assert.equal(f.timers.size,0);
  } finally { f.binding.dispose(); }
});
test('matching website names, nested sources, foreign origins, wrong roots and unrelated request IDs cannot resolve a checkpoint', async () => {
  const f = fixture();
  try {
    await f.ready(); let resolved = false; const operation = f.binding.checkpoint().then(()=>{resolved=true;});
    const requestId = f.sent.at(-1).value.requestId, valid = { type:'profile-checkpoint-result',requestId,ok:true };
    f.receive(valid,{name:f.child.name}); f.receive(valid,f.child,'https://other.test');
    f.receive({...valid,id:'unrelated-root'}); f.receive({...valid,requestId:crypto.randomUUID()}); await tick();
    assert.equal(resolved,false); f.child.name='renamed-by-site'; f.receive(valid); await operation; assert.equal(resolved,true);
  } finally { f.binding.dispose(); }
});
test('actual checkpoint save errors reject the command rather than becoming success or a whole-page error', async () => {
  const f = fixture();
  try {
    await f.ready(); const operation = f.binding.checkpoint(), requestId = f.sent.at(-1).value.requestId;
    const rejected = assert.rejects(operation, /PROFILE_CHECKPOINT_SAVE_FAILED/);
    f.receive({type:'profile-checkpoint-result',requestId,ok:false,code:'PROFILE_CHECKPOINT_SAVE_FAILED'}); await rejected;
    assert.equal(f.timers.size,0);
  } finally { f.binding.dispose(); }
});
test('a missing checkpoint response has a bounded deadline and late success cannot reverse the rejection', async () => {
  const f = fixture();
  try {
    await f.ready(); const operation = f.binding.checkpoint(), requestId = f.sent.at(-1).value.requestId;
    const rejected = assert.rejects(operation,/PROFILE_CHECKPOINT_TIMED_OUT/);
    [...f.timers.values()][0].fn(); await rejected;
    f.receive({type:'profile-checkpoint-result',requestId,ok:true});
  } finally { f.binding.dispose(); }
});
test('disposing the actual browsing document rejects outstanding checkpoints and removes the listener', async () => {
  const f = fixture();
  try {
    await f.ready(); const operation = f.binding.checkpoint();
    const rejected = assert.rejects(operation,/SCRAMJET_DOCUMENT_DISPOSED/); f.binding.dispose(); await rejected;
    assert.equal(f.timers.size,0); assert.equal(f.frame.removed,true);
  } finally { f.binding.dispose(); }
});
