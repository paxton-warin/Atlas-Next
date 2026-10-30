import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireSharedAssignmentCoordinator as acquire } from '../runtime/shared-assignment-coordinator.ts';
function fixture() {
  const made = []; let gate, fail = false;
  const create = options => {
    const master = {
      calls: 0, stopped: 0, current: null, state: { status: 'connecting' },
      emit(reason = 'renew', change = false) {
        const previous = this.current;
        this.current = { session: change ? 'new' : 'same', node: { id: change ? 'B' : 'A' }, generation: change ? 2 : 1 };
        this.state = { status: 'ready' }; options.onState(this.state);
        options.onAssignment({ assignment: this.current, previous, reason, identityChanged: !previous || change });
        return this.current;
      },
      async start() { this.calls++; if (gate) await gate; if (fail) throw Error('probe failed'); return this.emit('startup'); },
      async check() { return this.emit(); }, async selectNode() { return this.emit('selection', true); }, async reconnect() { return this.emit('reconnect', true); },
      transport: { request: async x => x, connectWebSocket: () => ({ close() {} }), get assignment() { return master.current; } },
      stop() { this.stopped++; options.channel?.close(); },
    }; made.push(master); return master;
  };
  const bind = (window, scope, callbacks = {}, asset = '/relay.js') => acquire(window, scope, { workerURL: asset, ...callbacks }, create);
  return { made, bind, setGate: x => gate = x, setFail: x => fail = x };
}
test('one window/runtime scope shares the actual coordinator and concurrent authoritative startup flight', async () => {
  const f = fixture(), win = {}, scope = {}, aEvents = [], bEvents = [];
  const a = f.bind(win, scope, { onAssignment: e => aEvents.push(e) }), b = f.bind(win, scope, { onAssignment: e => bEvents.push(e) });
  const [one, two] = await Promise.all([a.start(), b.start()]);
  assert.equal(f.made.length, 1); assert.equal(f.made[0].calls, 1); assert.equal(one, two);
  assert.equal(aEvents.length, 1); assert.equal(bEvents.length, 1);
  assert.equal(aEvents[0].previous, null); assert.equal(bEvents[0].identityChanged, true);
  a.stop(); b.stop();
});
test('a later tab still makes an authoritative startup, but receives its own first mount event', async () => {
  const f = fixture(), win = {}, scope = {}, events = [];
  const a = f.bind(win, scope, { onAssignment: e => events.push(e) }); await a.start();
  const later = []; const b = f.bind(win, scope, { onAssignment: e => later.push(e) }); await b.start();
  assert.equal(f.made[0].calls, 2); assert.equal(events.at(-1).identityChanged, false);
  assert.equal(later[0].previous, null); assert.equal(later[0].identityChanged, true);
  a.stop(); b.stop();
});
test('closing a tab does not close a sibling relay/channel; a stopped lease cannot use shared authority', async () => {
  const f = fixture(), win = {}, scope = {}; let closed = 0;
  const a = f.bind(win, scope, { channel: { close() { closed++; } } }), b = f.bind(win, scope);
  await Promise.all([a.start(), b.start()]); a.stop(); a.stop();
  assert.equal(f.made[0].stopped, 0); assert.equal(closed, 0);
  await assert.rejects(a.transport.request('denied'), { code: 'FRONTEND_COORDINATOR_STOPPED' });
  assert.throws(() => a.transport.assignment, { code: 'FRONTEND_COORDINATOR_STOPPED' });
  assert.equal(await b.transport.request('retained'), 'retained'); b.stop(); assert.equal(closed, 1); assert.equal(f.made[0].stopped, 1);
  const c = f.bind(win, scope); await c.start(); assert.equal(f.made.length, 2); c.stop();
});
test('Window, runtime/profile storage scope and pinned relay asset never mix', async () => {
  const f = fixture(), win = {}, scope = {};
  const leases = [f.bind(win, scope), f.bind({}, scope), f.bind(win, {}), f.bind(win, scope, {}, '/other-relay.js')];
  await Promise.all(leases.map(l => l.start())); assert.equal(f.made.length, 4); leases.forEach(l => l.stop());
});
test('node selection, renewal and reconnect fan out without one observer breaking the others', async () => {
  const f = fixture(), win = {}, scope = {}, events = [], states = [];
  const a = f.bind(win, scope, { onAssignment() { throw Error('observer'); } });
  const b = f.bind(win, scope, { onAssignment: e => events.push(e), onState: s => states.push(s) });
  await Promise.all([a.start(), b.start()]); await a.check({ authoritative: true }); assert.equal(events.at(-1).identityChanged, false);
  await a.selectNode('B', 'fixture-csrf'); assert.equal(b.current.node.id, 'B'); assert.equal(events.at(-1).reason, 'selection');
  await b.reconnect(); assert.equal(events.at(-1).reason, 'reconnect'); assert.equal(states.at(-1).status, 'ready'); a.stop(); b.stop();
});
test('a failed shared probe does not poison subsequent startup or manufacture a ready assignment', async () => {
  const f = fixture(), win = {}, scope = {}, events = [];
  const a = f.bind(win, scope, { onAssignment: e => events.push(e) }); f.setFail(true);
  await assert.rejects(a.start(), /probe failed/); assert.equal(events.length, 0); assert.equal(a.current, null);
  f.setFail(false); await a.start(); assert.equal(f.made[0].calls, 2); assert.equal(events.length, 1); a.stop();
});
test('closing a subscriber during startup rejects only its lease and preserves a remaining subscriber', async () => {
  const f = fixture(), win = {}, scope = {}; let release;
  f.setGate(new Promise(r => release = r)); const a = f.bind(win, scope), b = f.bind(win, scope);
  const pending = a.start(), accepted = b.start(), rejected = assert.rejects(pending, { code: 'FRONTEND_COORDINATOR_STOPPED' });
  await Promise.resolve(); a.stop(); release(); await rejected; await accepted; assert.equal(f.made[0].stopped, 0); b.stop();
});
test('last-lease retirement ignores late events and a synchronous factory failure leaves no cached pool', async () => {
  const f = fixture(), win = {}, scope = {}; let release; const events = [];
  f.setGate(new Promise(r => release = r)); const a = f.bind(win, scope, { onAssignment: e => events.push(e) });
  const pending = a.start(), rejected = assert.rejects(pending, { code: 'FRONTEND_COORDINATOR_STOPPED' }); await Promise.resolve(); a.stop(); release(); await rejected;
  assert.equal(events.length, 0); assert.equal(f.made[0].stopped, 1);
  assert.throws(() => acquire({}, {}, { workerURL: '/relay.js' }, () => { throw Error('construction'); }), /construction/);
});
