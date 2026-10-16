import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodePool } from "../server/node-pool.mjs";
import { openStore, digest } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

const origin = "http://frontend.example";
const localStats = (activeSessions = 0, connections = activeSessions) => ({
  activeSessions,
  connections,
});

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-ccu-"));
  const store = openStore(directory);
  const pool = createNodePool(store, {
    runtimeOrigin: "http://runtime.example",
    sameOriginRuntime: true,
  });
  pool.setLocalRelayStats(() => localStats());
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function node(relay = localStats()) {
    let id, secret;
    const state = { relay, validId: true, authenticated: false };
    const server = createServer((req, reply) => {
      state.authenticated = req.headers.authorization === "Bearer " + secret;
      if (!state.authenticated || req.url !== "/node/health") {
        reply.writeHead(401).end();
        return;
      }
      reply.writeHead(200, { "Content-Type": "application/json" });
      reply.end(JSON.stringify({
        id: state.validId ? id : "unpaired-node",
        status: "ok",
        connections: state.relay?.connections || 0,
        relay: state.relay,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const created = pool.add({
      name: "Traffic node",
      endpoint: "http://127.0.0.1:" + server.address().port,
    });
    id = created.id;
    secret = created.token;
    return { id, secret, state, heartbeat: (connections = 0) =>
      pool.heartbeat(id, secret, connections) };
  }
  return { pool, store, node };
}

test("CCU counts connected sessions rather than raw connections or idle pinned assignments", async (t) => {
  const { pool, store } = await fixture(t);
  pool.setLocalConnections(() => 90);
  pool.setLocalRelayStats(() => localStats(7, 90));
  const now = Date.now();
  for (let i = 0; i < 30; i++)
    store.db.prepare("INSERT INTO browse_leases(hash,node,origin,created,seen) VALUES(?,?,?,?,?)")
      .run("idle-assignment-" + i, "local", origin, now, now);
  const local = pool.list({ includeConcurrency: true })[0];
  assert.equal(local.connections, 90);
  assert.equal(local.sessions, 30);
  assert.equal(local.activeSessions, 7);
  assert.deepEqual({ ...pool.ccu(), updatedAt: 0 }, {
    activeSessions: 7, complete: true, reportingNodes: 1, totalNodes: 1,
    updatedAt: 0, freshnessMs: 45000,
  });
  pool.setLocalRelayStats(() => localStats(0, 0));
  assert.equal(pool.ccu().activeSessions, 0, "saved assignments without a live relay are not CCU");
  assert.equal(pool.list()[0].sessions, 30);
});

test("paired health supplies remote CCU and heartbeat connection totals are not substituted", async (t) => {
  const { pool, node } = await fixture(t);
  pool.setLocalRelayStats(() => localStats(2, 9));
  const remote = await node(localStats(7, 90));
  await remote.heartbeat(199);
  const row = pool.list({ includeConcurrency: true }).find((n) => n.id === remote.id);
  assert.equal(remote.state.authenticated, true);
  assert.equal(row.connections, 199);
  assert.equal(row.activeSessions, 7);
  assert.ok(row.activeSessionsUpdatedAt > 0);
  assert.equal(pool.ccu().activeSessions, 9);
  assert.equal(pool.ccu().complete, true);
});

test("missing, old, and malformed metric reports remain unknown, never connection-count estimates", async (t) => {
  const { pool, node } = await fixture(t);
  const remote = await node({ connections: 90, sessions: 30 });
  assert.equal(pool.list({ includeConcurrency: true }).find((n) => n.id === remote.id).activeSessions, null);
  await remote.heartbeat(90);
  assert.equal(pool.ccu().complete, false);
  assert.equal(pool.ccu().reportingNodes, 1);
  for (const activeSessions of [-1, 1.5, "7", 91, 100001, null]) {
    remote.state.relay = { connections: 90, activeSessions };
    await remote.heartbeat(90);
    assert.equal(pool.list({ includeConcurrency: true }).find((n) => n.id === remote.id).activeSessions, null);
  }
  remote.state.relay = localStats(0, 90);
  await remote.heartbeat(90);
  assert.equal(pool.ccu().complete, true, "a real measured zero is known");
});

test("stale or offline reports yield a partial fleet total, not cached-live CCU or a fake zero", async (t) => {
  const { pool, node } = await fixture(t);
  pool.setLocalRelayStats(() => localStats(2, 8));
  const remote = await node(localStats(5, 40));
  await remote.heartbeat(40);
  const observedAt = pool.list({ includeConcurrency: true }).find((n) => n.id === remote.id).activeSessionsUpdatedAt;
  const realNow = Date.now;
  Date.now = () => observedAt + 45000;
  try {
    const row = pool.list({ includeConcurrency: true }).find((n) => n.id === remote.id);
    assert.equal(row.online, false);
    assert.equal(row.activeSessions, null);
    assert.equal(row.activeSessionsUpdatedAt, observedAt);
    assert.equal(pool.ccu().activeSessions, 2);
    assert.equal(pool.ccu().complete, false);
    assert.equal(pool.ccu().reportingNodes, 1);
    assert.equal(pool.ccu().totalNodes, 2);
  } finally {
    Date.now = realNow;
  }
});

test("failed endpoint verification cannot replace a valid measured report", async (t) => {
  const { pool, node } = await fixture(t);
  const remote = await node(localStats(4, 20));
  await remote.heartbeat(20);
  remote.state.validId = false;
  remote.state.relay = localStats(19, 20);
  await assert.rejects(remote.heartbeat(20), /endpoint check failed/);
  assert.equal(pool.ccu().activeSessions, 4);
  await assert.rejects(pool.heartbeat(remote.id, "wrong-secret", 20), /verification failed/);
  assert.equal(pool.ccu().activeSessions, 4);
});

test("coordinator restart requires fresh relay telemetry and node removal discards its contribution", async (t) => {
  const { pool, store, node } = await fixture(t);
  const remote = await node(localStats(3, 20));
  await remote.heartbeat(20);
  const restarted = createNodePool(store, { runtimeOrigin: "http://runtime.example", sameOriginRuntime: true });
  restarted.setLocalRelayStats(() => localStats());
  assert.equal(restarted.ccu().complete, false);
  assert.equal(restarted.list({ includeConcurrency: true }).find((n) => n.id === remote.id).activeSessions, null);
  pool.remove(remote.id);
  assert.equal(pool.ccu().activeSessions, 0);
  assert.equal(pool.ccu().complete, true);
  assert.equal(pool.ccu().totalNodes, 1);
});

test("public node-list consumers do not run relay authorization scans", async (t) => {
  const { pool } = await fixture(t);
  let calls = 0;
  pool.setLocalRelayStats(() => { calls++; return localStats(1, 3); });
  assert.equal(pool.list()[0].activeSessions, undefined);
  assert.equal(calls, 0);
  assert.equal(pool.ccu().activeSessions, 1);
  assert.equal(calls, 1);
  pool.setLocalRelayStats(() => { throw Error("not ready"); });
  assert.equal(pool.ccu().complete, false);
});

test("CCU endpoints require an administrator and expose aggregates without browser identities", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-ccu-api-"));
  const app = await createApp({ dataDir: directory, appOrigin: origin,
    runtimeOrigin: "http://runtime.example", staticDir: "/not-built" });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  app.nodePool.setLocalRelayStats(() => localStats(3, 25));
  for (const url of ["/api/admin/ccu", "/api/admin/overview", "/api/admin/nodes"])
    assert.equal((await app.inject(url)).statusCode, 401);
  const admin = "ccu-test-administrator";
  const now = Date.now();
  app.store.db.prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .run(digest(admin), "csrf-fixture", now, now);
  const headers = { cookie: "atlas-admin=" + admin };
  const response = await app.inject({ url: "/api/admin/ccu", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().activeSessions, 3);
  assert.equal(response.json().complete, true);
  assert.doesNotMatch(response.body, /ccu-test-administrator|csrf-fixture|sessionHash|lease|ticket|secret|origin/);
  const overview = (await app.inject({ url: "/api/admin/overview", headers })).json();
  assert.equal(overview.ccu.activeSessions, 3);
  const nodes = (await app.inject({ url: "/api/admin/nodes", headers })).json();
  assert.equal(nodes[0].activeSessions, 3);
  assert.equal((await app.inject({ url: "/api/admin/ccu", headers: {
    ...headers, origin: "http://other.example",
  } })).statusCode, 403);
});
