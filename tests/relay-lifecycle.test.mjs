import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { createRuntime } from '../server/runtime.mjs';
import { createNodeService } from '../server/node-service.mjs';

const origin = 'http://frontend.example';
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay();
  }
  assert.ok(check(), 'timed out waiting for relay state');
}
async function fixture(t, maintenance = {}) {
  let now = 100000;
  const service = await createRuntime({
    appOrigin: origin, runtimeOrigin: origin, staticDir: '/not-built', fixture: true,
    relayMaintenance: { now: () => now, intervalMs: 60000, pongTimeoutMs: 3600000, ...maintenance },
    authorize(raw) {
      const [session, deadline = '1', generation = '1'] = raw.split('.');
      return { session, ticketExpiresAt: Number(deadline), generation: Number(generation) };
    },
  });
  await service.listen({ host: '127.0.0.1', port: 0 });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await service.close();
  });
  return {
    service,
    track(socket) { sockets.push(socket); },
    advance(ms) { now += ms; },
    async open(ticket, options) {
      const socket = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/relay/${ticket}/`, { origin, ...options });
      sockets.push(socket);
      socket.on('error', () => {});
      const firstPacket = once(socket, 'message');
      await once(socket, 'open');
      assert.equal(new Uint8Array((await firstPacket)[0])[0], 3);
      await until(() => service.connectionStats().emptyConnections === sockets.filter(s => s.readyState === WebSocket.OPEN).length);
      return socket;
    },
  };
}

test('relay counts expose only aggregate capacity and sessions, and close releases capacity', async t => {
  const f = await fixture(t);
  const one = await f.open('one.1');
  await f.open('one.1');
  await f.open('two.1');
  const stats = f.service.connectionStats();
  assert.deepEqual(stats, {
    connections: 3, sessions: 2, maxConnectionsPerSession: 2,
    emptyConnections: 3, activeStreams: 0, capacity: 200, perSessionCapacity: 12,
    rejectedCapacity: 0, reclaimedRetired: 0, deadPeers: 0,
  });
  assert.doesNotMatch(JSON.stringify(stats), /one|two|ticket|lease|origin/);
  one.terminate();
  await until(() => f.service.connectionCount() === 2);
  assert.equal(f.service.connectionStats().maxConnectionsPerSession, 1);
});

test('only an empty older credential with a ready newer same-generation relay is reclaimed', async t => {
  const f = await fixture(t);
  const old = await f.open('same.1');
  const unique = await f.open('unique.1');
  const differentGeneration = await f.open('same.2.2');
  f.advance(61000);
  f.service.maintainConnections();
  assert.equal(old.readyState, WebSocket.OPEN, 'another generation is not a valid replacement');
  const fresh = await f.open('same.2');
  f.service.maintainConnections();
  await until(() => old.readyState === WebSocket.CLOSED);
  assert.equal(fresh.readyState, WebSocket.OPEN);
  assert.equal(unique.readyState, WebSocket.OPEN);
  assert.equal(differentGeneration.readyState, WebSocket.OPEN);
  assert.equal(f.service.connectionStats().reclaimedRetired, 1);
});

test('a quiet active TCP/website WebSocket stream survives old-relay retirement until stream closes', { timeout: 5000 }, async t => {
  const targetSockets = new Set();
  const target = createServer(socket => { targetSockets.add(socket); socket.on('close', () => targetSockets.delete(socket)); socket.on('data', data => socket.write(data)); });
  await new Promise((resolve, reject) => target.once('error', reject).listen(4199, '127.0.0.1', resolve));
  t.after(() => { for (const socket of targetSockets) socket.destroy(); return new Promise(resolve => target.close(resolve)); });
  const f = await fixture(t);
  const old = await f.open('same.1');
  const connect = Buffer.alloc(8 + '127.0.0.1'.length);
  connect[0] = 1; connect.writeUInt32LE(1, 1); connect[5] = 1;
  connect.writeUInt16LE(4199, 6); connect.write('127.0.0.1', 8);
  old.send(connect);
  await until(() => f.service.connectionStats().activeStreams === 1);
  // Open a newer credential directly: the earlier connection now has a stream,
  // so this test intentionally does not use the fixture's all-empty assertion.
  const newer = new WebSocket(`ws://127.0.0.1:${f.service.server.address().port}/relay/same.2/`, { origin });
  newer.on('error', () => {});
  f.track(newer);
  await once(newer, 'open');
  await delay();
  f.advance(61000);
  f.service.maintainConnections();
  assert.equal(old.readyState, WebSocket.OPEN);
  assert.equal(f.service.connectionStats().activeStreams, 1);
  const echoed = once(old, 'message');
  old.send(Buffer.from([2, 1, 0, 0, 0, 42]));
  assert.equal(new Uint8Array((await echoed)[0]).at(-1), 42);
  old.send(Buffer.from([4, 1, 0, 0, 0, 1]));
  await until(() => f.service.connectionStats().activeStreams === 0);
  f.advance(61000);
  f.service.maintainConnections();
  await until(() => old.readyState === WebSocket.CLOSED);
  assert.equal(newer.readyState, WebSocket.OPEN);
});

test('missed native pong closes a dead relay without touching a more recent live peer', async t => {
  const f = await fixture(t, { pongTimeoutMs: 65000 });
  const old = await f.open('one.1', { autoPong: false });
  f.advance(66000);
  const live = await f.open('two.1');
  f.service.maintainConnections();
  await until(() => old.readyState === WebSocket.CLOSED);
  assert.equal(live.readyState, WebSocket.OPEN);
  assert.equal(f.service.connectionStats().deadPeers, 1);
});

test('protected node health includes aggregate relay stats and rejects anonymous callers', async t => {
  const secret = 'a'.repeat(43);
  const service = await createNodeService({ id: 'fixture-node', secret, staticDir: '/not-built' });
  t.after(() => service.close());
  assert.equal((await service.inject('/node/health')).statusCode, 401);
  const response = await service.inject({ url: '/node/health', headers: { authorization: 'Bearer ' + secret } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().relay.capacity, 200);
  assert.equal(response.json().relay.sessions, 0);
});
