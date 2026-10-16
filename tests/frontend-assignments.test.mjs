import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { digest, token } from "../server/store.mjs";
const origin = "http://frontend.example";
async function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-frontend-assignments-"));
  const app = await createApp({
    dataDir: directory,
    staticDir: "/not-built",
    appOrigin: origin,
    runtimeOrigin: "https://runtime.invalid",
    localRelayMode: "frontend",
    ...extra,
  });
  const nodes = [];
  t.after(async () => {
    await Promise.all(nodes.map((n) => n.close()));
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    app,
    pool: app.nodePool,
    db: app.store.db,
    async remote() {
      let credential;
      const node = await createNodeService({
        pairing: { verify: () => true, save: (value) => (credential = value) },
      });
      nodes.push(node);
      await node.listen({ host: "127.0.0.1", port: 0 });
      const endpoint = "http://127.0.0.1:" + node.server.address().port;
      const { id } = await app.nodePool.attach(
        { endpoint, name: "Remote", code: "test" },
        origin,
      );
      return { id, node, endpoint, secret: () => credential.secret };
    },
  };
}
test("Main frontend lease allocation does not require a runtime hostname or another host node", async (t) => {
  const f = await fixture(t);
  assert.equal(f.pool.list().find((n) => n.id === "local").online, false);
  const result = await f.pool.frontendAssignments.operate(
    { intent: "new" },
    origin,
  );
  assert.equal(result.node.id, "local");
  assert.equal(result.runtimeOrigin, origin);
  assert.equal(result.relayOrigin, origin);
  assert.equal(result.protocol, 2);
  assert.equal(result.pendingCommit, false);
  const row = f.db
    .prepare("SELECT * FROM browse_leases WHERE hash=?")
    .get(result.sessionHash);
  assert.equal(row.runtime_node, null);
  assert.equal(
    f.pool.frontendAssignments.validate(
      f.pool.frontendAssignments.identity(result.session, origin, 1),
    ),
    true,
  );
  assert.equal(
    f.pool.frontendAssignments.identity(
      result.session,
      "http://other.example",
      1,
    ),
    null,
  );
  await assert.rejects(
    f.pool.operate(
      { intent: "restore", session: result.session },
      origin,
      "https://runtime.invalid",
    ),
    { code: "RUNTIME_PROTOCOL_REQUIRED" },
  );
  await assert.rejects(
    f.pool.select(result.session, origin, "https://runtime.invalid", "local"),
    { code: "RUNTIME_PROTOCOL_REQUIRED" },
  );
});
test("renewal keeps same pin/raw owner/frame hostname; outage never chooses healthy alternative", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  f.pool.update("local", { state: "disabled", weight: 1 });
  const first = await f.pool.frontendAssignments.operate(
    { intent: "new" },
    origin,
  );
  const next = await f.pool.frontendAssignments.operate(
    { intent: "renew", session: first.session, generation: 1 },
    origin,
  );
  assert.equal(next.session, first.session);
  assert.equal(next.node.id, remote.id);
  assert.equal(next.runtimeOrigin, origin);
  f.db.prepare("UPDATE nodes SET state='active' WHERE id='local'").run();
  f.db.prepare("UPDATE nodes SET seen=0 WHERE id=?").run(remote.id);
  await assert.rejects(
    f.pool.frontendAssignments.operate(
      { intent: "renew", session: first.session, generation: 1 },
      origin,
    ),
    { code: "NODE_UNAVAILABLE" },
  );
  assert.equal(
    f.db
      .prepare("SELECT node FROM browse_leases WHERE hash=?")
      .get(first.sessionHash).node,
    remote.id,
  );
  assert.equal(
    f.pool.frontendAssignments.validate(
      f.pool.frontendAssignments.identity(first.session, origin, 1),
    ),
    true,
    "storage owner authority does not require a live traffic node",
  );
});
test("combined assignment requires both relay and native-resource protocol support without silently changing an existing pin", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  f.pool.update("local", { state: "disabled", weight: 1 });
  const capabilities = f.app.store.get("nodeCapabilities");
  f.app.store.set("nodeCapabilities", {
    ...capabilities,
    [remote.id]: ["frontend-controller-relay-v2"],
  });
  await assert.rejects(
    f.pool.frontendAssignments.operate({ intent: "new" }, origin),
    { code: "NODE_UNAVAILABLE" },
  );
  f.app.store.set("nodeCapabilities", capabilities);
  const first = await f.pool.frontendAssignments.operate(
    { intent: "new" },
    origin,
  );
  assert.equal(first.node.id, remote.id);
  f.app.store.set("nodeCapabilities", {
    ...capabilities,
    [remote.id]: ["frontend-controller-relay-v2"],
  });
  f.db.prepare("UPDATE nodes SET state='active' WHERE id='local'").run();
  await assert.rejects(
    f.pool.frontendAssignments.operate(
      { intent: "renew", session: first.session, generation: 1 },
      origin,
    ),
    { code: "NODE_UNAVAILABLE" },
  );
  assert.equal(
    f.db
      .prepare("SELECT node FROM browse_leases WHERE hash=?")
      .get(first.sessionHash).node,
    remote.id,
  );
});
test("replacement reserve/probe/commit retains previous lease until explicit successful confirmation", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  const previous = await f.pool.frontendAssignments.operate(
    { intent: "new" },
    origin,
  );
  const candidate = await f.pool.frontendAssignments.select(
    previous.session,
    origin,
    remote.id,
  );
  assert.equal(candidate.pendingCommit, true);
  assert.equal(candidate.replaces, previous.sessionHash);
  assert.ok(
    f.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(previous.sessionHash),
  );
  const repeated = await f.pool.frontendAssignments.operate(
    { intent: "restore", session: previous.session, generation: 1 },
    origin,
  );
  assert.equal(
    repeated.session,
    previous.session,
    "pending replacement is reused across windows",
  );
  const result = await f.pool.frontendAssignments.commit(
    previous.session,
    candidate.session,
    origin,
    1,
  );
  assert.equal(result.pendingCommit, false);
  assert.equal(result.node.id, remote.id);
  const duplicate = await f.pool.frontendAssignments.commit(
    previous.session,
    candidate.session,
    origin,
    1,
  );
  assert.equal(duplicate.session, result.session);
  assert.equal(duplicate.pendingCommit, false);
  assert.equal(duplicate.replaces, undefined);
  await assert.rejects(
    f.pool.frontendAssignments.commit(
      "x".repeat(43),
      candidate.session,
      origin,
      1,
    ),
    { code: "INVALID_SESSION" },
  );
  assert.equal(
    f.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(previous.sessionHash),
    undefined,
  );
  assert.equal(
    f.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(previous.sessionHash).reason,
    "revoked",
  );
});
test("candidate node failure, expiry and previous revocation never destroy the original valid pin", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  const old = await f.pool.frontendAssignments.operate({}, origin);
  const candidate = await f.pool.frontendAssignments.select(
    old.session,
    origin,
    remote.id,
  );
  f.db.prepare("UPDATE nodes SET seen=0 WHERE id=?").run(remote.id);
  await assert.rejects(
    f.pool.frontendAssignments.commit(
      old.session,
      candidate.session,
      origin,
      1,
    ),
    { code: "NODE_UNAVAILABLE" },
  );
  assert.ok(
    f.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(old.sessionHash),
  );
  f.db
    .prepare(
      "UPDATE frontend_assignments SET reservation_expires=0 WHERE hash=?",
    )
    .run(candidate.sessionHash);
  f.pool.frontendAssignments.cleanup();
  assert.equal(
    f.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(candidate.sessionHash),
    undefined,
  );
  assert.ok(
    f.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(old.sessionHash),
  );
});
test("ordinary idle expiry reserves fresh owner on previous healthy node; next-day windows get same reservation", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  f.pool.update("local", { state: "disabled", weight: 1 });
  const old = await f.pool.frontendAssignments.operate({}, origin);
  f.db
    .prepare("UPDATE browse_leases SET seen=? WHERE hash=?")
    .run(Date.now() - 12 * 3600000 - 100, old.sessionHash);
  const first = await f.pool.frontendAssignments.operate(
    { intent: "restore", session: old.session, generation: 1 },
    origin,
  );
  const second = await f.pool.frontendAssignments.operate(
    { intent: "restore", session: old.session, generation: 1 },
    origin,
  );
  assert.notEqual(first.session, old.session);
  assert.equal(first.session, second.session);
  assert.equal(first.node.id, remote.id);
  assert.equal(first.pendingCommit, true);
  const committed = await f.pool.frontendAssignments.commit(
    old.session,
    first.session,
    origin,
    1,
  );
  assert.equal(committed.pendingCommit, false);
  await assert.rejects(
    f.pool.frontendAssignments.operate(
      { intent: "restore", session: old.session },
      origin,
    ),
    { code: "SESSION_REVOKED" },
  );
});
test("revocation or assignment mutation during async node negotiation cannot commit stale replacement", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  const old = await f.pool.frontendAssignments.operate({}, origin);
  const candidate = await f.pool.frontendAssignments.select(
    old.session,
    origin,
    remote.id,
  );
  f.pool.release(old.session, origin);
  await assert.rejects(
    f.pool.frontendAssignments.commit(
      old.session,
      candidate.session,
      origin,
      1,
    ),
    { code: "SESSION_REVOKED" },
  );
  assert.equal(
    f.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(old.sessionHash).reason,
    "revoked",
  );
});
test("frontend owner validation respects generation, idle expiry and revoke without granting another origin", async (t) => {
  const f = await fixture(t);
  const lease = await f.pool.frontendAssignments.operate({}, origin),
    owner = f.pool.frontendAssignments.identity(lease.session, origin, 1);
  assert.equal(
    f.pool.frontendAssignments.validate({
      ...owner,
      origin: "http://other.example",
    }),
    false,
  );
  assert.equal(
    f.pool.frontendAssignments.validate({ ...owner, generation: 2 }),
    false,
  );
  f.db
    .prepare("UPDATE browse_leases SET seen=0 WHERE hash=?")
    .run(digest(lease.session));
  assert.equal(f.pool.frontendAssignments.validate(owner), false);
});

test("signed initial request is exact-frontend/browser bound and concurrent retries describe one assignment", async (t) => {
  const f = await fixture(t),
    browserSessionId = token(),
    request = f.pool.frontendAssignments.bootstrap(origin, browserSessionId),
    body = { intent: "new", requestId: request.requestId };
  const [a, b] = await Promise.all([
    f.pool.frontendAssignments.operate(body, origin, { browserSessionId }),
    f.pool.frontendAssignments.operate(body, origin, { browserSessionId }),
  ]);
  assert.equal(a.session, b.session);
  assert.equal(a.node.id, b.node.id);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
  await assert.rejects(
    f.pool.frontendAssignments.operate(body, "http://other.example", {
      browserSessionId,
    }),
    { code: "INITIAL_REQUEST_BINDING_MISMATCH" },
  );
  await assert.rejects(
    f.pool.frontendAssignments.operate(body, origin, {
      browserSessionId: token(),
    }),
    { code: "INITIAL_REQUEST_BINDING_MISMATCH" },
  );
  const tampered =
    body.requestId.slice(0, -1) + (body.requestId.endsWith("A") ? "B" : "A");
  await assert.rejects(
    f.pool.frontendAssignments.operate(
      { ...body, requestId: tampered },
      origin,
      { browserSessionId },
    ),
    { code: "INITIAL_REQUEST_BINDING_MISMATCH" },
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
});

test("initial reservation survives failed node negotiation and retry never chooses a healthy alternative", async (t) => {
  const f = await fixture(t),
    remote = await f.remote();
  f.pool.update("local", { state: "disabled", weight: 1 });
  await remote.node.close();
  const browserSessionId = token(),
    request = f.pool.frontendAssignments.bootstrap(origin, browserSessionId),
    body = { intent: "new", requestId: request.requestId };
  await assert.rejects(
    f.pool.frontendAssignments.operate(body, origin, { browserSessionId }),
    { code: "CONTROL_UNAVAILABLE" },
  );
  const pinned = f.db.prepare("SELECT * FROM browse_leases").all();
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].node, remote.id);
  f.pool.update("local", { state: "active", weight: 1 });
  await assert.rejects(
    f.pool.frontendAssignments.operate(body, origin, { browserSessionId }),
    { code: "CONTROL_UNAVAILABLE" },
  );
  const retained = f.db.prepare("SELECT * FROM browse_leases").all();
  assert.equal(retained.length, 1);
  assert.equal(retained[0].hash, pinned[0].hash);
  assert.equal(retained[0].node, remote.id);
});

test("expired initial lease tombstone does not become an unrequested replacement", async (t) => {
  const f = await fixture(t),
    browserSessionId = token(),
    request = f.pool.frontendAssignments.bootstrap(origin, browserSessionId),
    body = { intent: "new", requestId: request.requestId };
  const first = await f.pool.frontendAssignments.operate(body, origin, {
    browserSessionId,
  });
  f.db
    .prepare("UPDATE browse_leases SET seen=? WHERE hash=?")
    .run(Date.now() - 12 * 3600000 - 100, first.sessionHash);
  await assert.rejects(
    f.pool.frontendAssignments.operate(body, origin, { browserSessionId }),
    { code: "SESSION_EXPIRED" },
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(first.sessionHash).reason,
    "expired",
  );
});

test("initial response recovery survives coordinator server restart without raw capabilities stored server-side", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-initial-restart-")),
    options = {
      dataDir: directory,
      staticDir: "/not-built",
      appOrigin: origin,
      runtimeOrigin: "https://runtime.invalid",
      localRelayMode: "frontend",
    };
  let app = await createApp(options);
  try {
    const browserSessionId = token(),
      request = app.nodePool.frontendAssignments.bootstrap(
        origin,
        browserSessionId,
      ),
      body = { intent: "new", requestId: request.requestId };
    const first = await app.nodePool.frontendAssignments.operate(body, origin, {
      browserSessionId,
    });
    await app.close();
    app = await createApp(options);
    const recovered = await app.nodePool.frontendAssignments.operate(
      body,
      origin,
      { browserSessionId },
    );
    assert.equal(recovered.session, first.session);
    assert.equal(recovered.node.id, first.node.id);
    assert.equal(
      app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      1,
    );
    const serialized = JSON.stringify(
      app.store.db.prepare("SELECT * FROM frontend_assignments").all(),
    );
    assert.ok(!serialized.includes(first.session));
    assert.ok(!serialized.includes(request.requestId));
    assert.ok(!serialized.includes(browserSessionId));
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
