import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { createRuntime } from "../server/runtime.mjs";
import { signTicket, verifyTicket } from "../server/node-ticket.mjs";
import { digest } from "../server/store.mjs";

const origin = "http://main.example";
const runtimeOrigin = "http://runtime.example";
const hour = 3600000;

async function fixture(t, { remote = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-session-lifecycle-"));
  const app = await createApp({
    dataDir: directory,
    staticDir: "/not-built",
    appOrigin: origin,
    runtimeOrigin,
  });
  const nodes = [];
  t.after(async () => {
    await Promise.all(nodes.map((node) => node.service.close()));
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function addNode() {
    let credentials;
    const control = { handler: null };
    const service = await createNodeService({
      pairing: {
        verify: () => true,
        save: (value) => {
          credentials = value;
        },
      },
    });
    service.addHook("preHandler", async (request) => {
      await control.handler?.(request);
    });
    await service.listen({ port: 0, host: "127.0.0.1" });
    const endpoint = "http://127.0.0.1:" + service.server.address().port;
    const { id } = await app.nodePool.attach(
      { name: "Fixture node", endpoint, code: "fixture" },
      origin,
    );
    const node = {
      id,
      endpoint,
      service,
      control,
      get credentials() {
        return credentials;
      },
    };
    nodes.push(node);
    return node;
  }
  if (remote) {
    await addNode();
    app.nodePool.update("local", { state: "disabled", weight: 1 });
  }
  const post = (body) =>
    app.inject({
      method: "POST",
      url: "/api/browse/session",
      headers: { host: "main.example", origin },
      payload: body,
    });
  const operate = (body) => app.nodePool.operate(body, origin, runtimeOrigin);
  return { app, nodes, addNode, post, operate };
}

function clock(t) {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  return {
    advance: (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
  };
}

test("typed session API renews one generation and reports invalid and revoked state explicitly", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const created = await f.post({ intent: "new" });
  assert.equal(created.statusCode, 200);
  const lease = created.json();
  assert.equal(lease.generation, 1);
  assert.equal(lease.sessionHash, digest(lease.session));
  assert.equal(lease.ticketExpiresAt, lease.expiresAt);
  assert.equal(lease.leaseExpiresAt, lease.serverTime + 12 * hour);
  time.advance(5 * 60000);
  const renewed = (
    await f.post({ intent: "renew", session: lease.session, generation: 1 })
  ).json();
  assert.equal(renewed.session, lease.session);
  assert.equal(renewed.generation, 1);
  assert.ok(renewed.ticketExpiresAt > lease.ticketExpiresAt);
  assert.ok(renewed.leaseExpiresAt > lease.leaseExpiresAt);
  const invalid = await f.post({ intent: "renew", session: "unknown" });
  assert.equal(invalid.statusCode, 409);
  assert.equal(invalid.json().code, "INVALID_SESSION");
  assert.equal(invalid.json().retryable, false);
  assert.equal(invalid.json().serverTime, time.now());
  const mismatch = await f.post({
    intent: "renew",
    session: lease.session,
    generation: 2,
  });
  assert.equal(mismatch.json().code, "SESSION_GENERATION_MISMATCH");
  f.app.nodePool.release(lease.session, origin);
  const revoked = await f.post({ intent: "restore", session: lease.session });
  assert.equal(revoked.json().code, "SESSION_REVOKED");
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    0,
  );
  const explicit = await f.post({ intent: "new", session: "unknown" });
  assert.equal(explicit.statusCode, 200);
  assert.notEqual(explicit.json().session, "unknown");
});

test("next-day restore retains the prior healthy node, increments generation once, and rejects old transports", async (t) => {
  const f = await fixture(t, { remote: true });
  const time = clock(t);
  const lease = await f.operate({ intent: "new" });
  const oldPayload = verifyTicket(
    lease.ticket,
    f.nodes[0].credentials.secret,
    lease.runtimeOrigin,
  );
  time.advance(13 * hour);
  f.app.store.db
    .prepare("UPDATE nodes SET seen=? WHERE id=?")
    .run(time.now(), f.nodes[0].id);
  f.app.nodePool.list();
  const tombstone = f.app.store.db
    .prepare("SELECT * FROM browse_lease_tombstones")
    .get();
  assert.equal(tombstone.hash, digest(lease.session));
  assert.equal(tombstone.reason, "expired");
  assert.equal(JSON.stringify(tombstone).includes(lease.session), false);
  await assert.rejects(
    f.operate({ intent: "renew", session: lease.session, generation: 1 }),
    (error) => error.code === "SESSION_EXPIRED",
  );
  const [restored, duplicate] = await Promise.all([
    f.operate({ intent: "restore", session: lease.session, generation: 1 }),
    f.operate({ intent: "restore", session: lease.session, generation: 1 }),
  ]);
  assert.equal(restored.session, lease.session);
  assert.equal(restored.node.id, lease.node.id);
  assert.equal(restored.runtimeOrigin, lease.runtimeOrigin);
  assert.equal(restored.generation, 2);
  assert.deepEqual(restored, duplicate);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
  const stale = signTicket(
    { ...oldPayload, expires: time.now() + hour },
    f.nodes[0].credentials.secret,
  );
  const rejected = await f.nodes[0].service.inject({
    url: "/runtime-config",
    headers: {
      authorization: "Bearer " + stale,
      host: new URL(lease.runtimeOrigin).host,
    },
  });
  assert.equal(rejected.statusCode, 410);
  assert.equal(rejected.json().code, "SESSION_REVOKED");
  const valid = await fetch(lease.runtimeOrigin + "/runtime-config", {
    headers: { authorization: "Bearer " + restored.ticket },
  });
  assert.equal(valid.status, 200);
});

test("offline and stale-control failures never replace a valid or expired assignment", async (t) => {
  const f = await fixture(t, { remote: true });
  const time = clock(t);
  const lease = await f.operate({ intent: "new" });
  await f.addNode();
  time.advance(46000);
  const stale = await fetch(lease.runtimeOrigin + "/runtime-config", {
    headers: { authorization: "Bearer " + lease.ticket },
  });
  assert.equal(stale.status, 503);
  assert.equal((await stale.json()).code, "CONTROL_UNAVAILABLE");
  f.app.store.db
    .prepare("UPDATE nodes SET seen=0 WHERE id=?")
    .run(lease.node.id);
  await assert.rejects(
    f.operate({ intent: "renew", session: lease.session, generation: 1 }),
    (error) => error.code === "NODE_UNAVAILABLE" && error.retryable,
  );
  assert.equal(
    f.app.store.db
      .prepare("SELECT node FROM browse_leases WHERE hash=?")
      .get(digest(lease.session)).node,
    lease.node.id,
  );
  time.advance(13 * hour);
  await assert.rejects(
    f.operate({ intent: "restore", session: lease.session }),
    (error) => error.code === "NODE_UNAVAILABLE",
  );
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    0,
  );
  assert.equal(
    f.app.store.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(digest(lease.session)).reason,
    "expired",
  );
});

test("new sessions reserve before release, roll back failures, and cannot overwrite a concurrent revocation", async (t) => {
  const f = await fixture(t, { remote: true });
  const lease = await f.operate({ intent: "new" });
  f.app.nodePool.update(lease.node.id, { state: "draining", weight: 1 });
  await assert.rejects(
    f.operate({ intent: "new", session: lease.session, generation: 1 }),
    (error) => error.statusCode === 503,
  );
  assert.equal(
    (
      await f.operate({
        intent: "renew",
        session: lease.session,
        generation: 1,
      })
    ).session,
    lease.session,
  );
  f.app.nodePool.update(lease.node.id, { state: "active", weight: 1 });
  const replacement = await f.operate({
    intent: "new",
    session: lease.session,
    generation: 1,
  });
  assert.notEqual(replacement.session, lease.session);
  await assert.rejects(
    f.operate({ intent: "restore", session: lease.session }),
    (error) => error.code === "SESSION_REVOKED",
  );
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let entered;
  const requested = new Promise((resolve) => {
    entered = resolve;
  });
  f.nodes[0].control.handler = async (request) => {
    if (request.url === "/node/control") {
      entered();
      await gate;
    }
  };
  const renewal = f.operate({
    intent: "renew",
    session: replacement.session,
    generation: 1,
  });
  await requested;
  f.app.nodePool.release(replacement.session, origin);
  releaseGate();
  await assert.rejects(renewal, (error) => error.code === "SESSION_REVOKED");
});

test("seven-day tombstone retention is bounded and does not resurrect revoked capabilities", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const lease = await f.operate({ intent: "new" });
  f.app.nodePool.release(lease.session, origin);
  time.advance(7 * 24 * hour + 1);
  f.app.nodePool.list();
  assert.equal(
    f.app.store.db
      .prepare("SELECT count(*) AS n FROM browse_lease_tombstones")
      .get().n,
    0,
  );
  await assert.rejects(
    f.operate({ intent: "restore", session: lease.session }),
    (error) => error.code === "INVALID_SESSION",
  );
});

test("renewed long-lived relay socket survives its original ticket deadline but revocation closes it", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const lease = await f.operate({ intent: "new" });
  const runtime = await createRuntime({
    appOrigin: origin,
    runtimeOrigin,
    staticDir: "/not-built",
    authorize: (...args) => f.app.nodePool.resolve(...args),
  });
  await runtime.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => runtime.close());
  const address =
    "ws://127.0.0.1:" +
    runtime.server.address().port +
    "/relay/" +
    encodeURIComponent(lease.ticket) +
    "/";
  const socket = new WebSocket(address, { origin: runtimeOrigin });
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "open");
  time.advance(11 * hour);
  const renewed = await f.operate({
    intent: "renew",
    session: lease.session,
    generation: 1,
  });
  time.advance(2 * hour);
  assert.throws(
    () => f.app.nodePool.resolve(lease.ticket, runtimeOrigin, "relay"),
    (error) => error.code === "TICKET_EXPIRED",
  );
  assert.equal(
    f.app.nodePool.resolve(renewed.ticket, runtimeOrigin, "relay").generation,
    1,
  );
  runtime.recheckConnections();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(runtime.connectionCount(), 1);
  const closed = once(socket, "close");
  f.app.nodePool.release(lease.session, origin);
  runtime.recheckConnections();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runtime.connectionCount(), 0);
});

test("direct node retains an established renewed socket past ticket expiry and closes revoked generations", async (t) => {
  const f = await fixture(t, { remote: true });
  const time = clock(t);
  const lease = await f.operate({ intent: "new" });
  const node = f.nodes[0];
  const socket = new WebSocket(
    lease.runtimeOrigin.replace(/^http/, "ws") +
      "/relay/" +
      encodeURIComponent(lease.ticket) +
      "/",
    { origin: lease.runtimeOrigin },
  );
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "open");
  time.advance(11 * hour);
  f.app.store.db
    .prepare("UPDATE nodes SET seen=? WHERE id=?")
    .run(time.now(), node.id);
  await f.operate({ intent: "renew", session: lease.session, generation: 1 });
  time.advance(2 * hour);
  f.app.store.db
    .prepare("UPDATE nodes SET seen=? WHERE id=?")
    .run(time.now(), node.id);
  node.service.applyControl(f.app.nodePool.nodeState(node.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.readyState, WebSocket.OPEN);
  const stale = await fetch(lease.runtimeOrigin + "/runtime-config", {
    headers: { authorization: "Bearer " + lease.ticket },
  });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).code, "TICKET_EXPIRED");
  const closed = once(socket, "close");
  f.app.nodePool.release(lease.session, origin);
  node.service.applyControl(f.app.nodePool.nodeState(node.id));
  await closed;
});

test("relay authorization polling alone never extends the twelve-hour idle lease", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const lease = await f.operate({ intent: "new" });
  const hash = digest(lease.session);
  const initialSeen = f.app.store.db
    .prepare("SELECT seen FROM browse_leases WHERE hash=?")
    .get(hash).seen;
  for (let elapsed = 1; elapsed < 12; elapsed++) {
    time.advance(hour);
    f.app.nodePool.resolve(lease.ticket, runtimeOrigin, "relay", {
      established: true,
    });
    assert.equal(
      f.app.store.db
        .prepare("SELECT seen FROM browse_leases WHERE hash=?")
        .get(hash).seen,
      initialSeen,
    );
  }
  time.advance(hour + 1);
  assert.throws(
    () =>
      f.app.nodePool.resolve(lease.ticket, runtimeOrigin, "relay", {
        established: true,
      }),
    (error) => error.code === "SESSION_EXPIRED",
  );
  const restored = await f.operate({
    intent: "restore",
    session: lease.session,
    generation: lease.generation,
  });
  assert.equal(restored.node.id, lease.node.id);
  assert.equal(restored.generation, lease.generation + 1);
});
