import test from 'node:test';
import assert from 'node:assert/strict';
import { createScramjetWebsiteDocument } from '../runtime/scramjet-document.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('normal host forwards managed popup state and controls without replacing the root frame', async () => {
  const listeners = new Map(), sent = [], events = [], states = [], locations = [];
  const origin = 'https://front.test';
  const child = { postMessage(value, target) { sent.push({value, target}); } };
  const frame = { style: {}, contentWindow: child, remove() { this.removed = true; } };
  const owner = {
    crypto: globalThis.crypto, location: {origin}, document: { createElement: () => frame },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
    setInterval, clearInterval,
  };
  const container = { ownerDocument: { defaultView: owner }, appendChild(value) { assert.equal(value, frame); } };
  const binding = createScramjetWebsiteDocument({ container, website: 'https://site.test/',
    profileId: '11111111-1111-4111-8111-111111111111', profileContextId: 'context', browserSessionId: 'browser',
    createVisibility: () => ({ install: () => ({ dispose() {} }), dispose() {} }),
    runtimeTicket: async () => ({runtimeTicket: 'signed-grant', runtimePath: '/browse/runtime/'}),
    onLocation: value => locations.push(value), onRuntimeEvent: event => events.push(event),
    onContentState: value => states.push(value), cookieProvider: {},
  });
  const send = (type, extra = {}) => listeners.get('message')({ source: child, origin, data: {atlas:1, type, id:binding.documentId, ...extra} });
  try {
    await tick(); send('ready'); send('loaded'); await binding.ready;
    assert.equal(states.at(-1), 'ready'); assert.equal(sent.at(-1).value.type, 'navigate');
    send('popup-created', {id:'child-popup', openerId:binding.documentId, url:'about:blank'});
    assert.equal(events.at(-1).id, 'child-popup'); assert.equal(events.at(-1).openerId, undefined);
    send('navigation', {id:'child-popup', url:'https://oauth.test/'});
    send('title', {id:'child-popup', title:'Sign in'});
    send('favicon', {id:'child-popup', favicon:'data:image/png;base64,AA=='});
    send('focus-search', {id:'child-popup'}); send('panic', {id:'child-popup', key:'escape'});
    assert.equal(binding.runtimeControl('back','child-popup'),true);
    assert.equal(sent.at(-1).value.id,'child-popup'); assert.equal(sent.at(-1).value.type,'back');
    assert.equal(binding.runtimeControl('navigate','child-popup',{url:'https://next.test/'}),true);
    assert.equal(sent.at(-1).value.url,'https://next.test/');
    send('loading'); send('loaded');
    assert.deepEqual(events.slice(-2).map(event=>event.type),['loading','loaded']);
    send('navigation',{url:'https://site.test/next'}); assert.deepEqual(locations,['https://site.test/next']);
    const count = events.length; send('title',{id:'not-a-managed-page',title:'ignored'}); assert.equal(events.length,count);
    send('popup-closed',{id:'child-popup',openerId:binding.documentId});
    assert.equal(binding.runtimeControl('activate','child-popup'),false);
    assert.equal(binding.runtimeControl('arbitrary-privileged-action'),false);
    assert.equal(frame.removed,undefined);
  } finally { binding.dispose(); }
  assert.equal(frame.removed,true); assert.equal(listeners.has('message'),false);
});

test('normal profile keeps module worker source at its hierarchical URL instead of a data-module wrapper',async()=>{
 const {readFile}=await import('node:fs/promises');
 const host=await readFile(new URL('../runtime/host.ts',import.meta.url),'utf8');
 assert.match(host,/if \(profileBridge\) \{[\s\S]{0,300}controller\.runtimekitConfig\.flags\.encapsulateWorkers = false/);
});
