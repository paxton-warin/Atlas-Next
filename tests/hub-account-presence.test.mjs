import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, digest } from "../server/store.mjs";
import { createNodePool } from "../server/node-pool.mjs";
const origin = "https://branch.example",
  runtimeOrigin = "https://runtime.example";
const identity = () => ({
  userId: randomUUID(),
  profileId: randomUUID(),
  sessionId: randomUUID(),
  branchId: randomUUID(),
  contextId: randomUUID(),
});
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-presence-")),
    store = openStore(dir),
    pool = createNodePool(store, { runtimeOrigin });
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, pool };
}
test("account CCU uses only live authorized lease proofs and deduplicates concurrent account tabs", async (t) => {
  const { store, pool } = await fixture(t),
    a = identity(),
    b = identity();
  const leases = [];
  for (const grant of [a, a, b]) {
    const lease = await pool.operate({}, origin, runtimeOrigin);
    pool.bindHubLease(lease.sessionHash, grant);
    leases.push(lease);
  }
  pool.setRequireHubOwnership(true);
  let live = leases.map((l) => l.sessionHash);
  pool.setLocalRelaySessionIds(() => live);
  assert.deepEqual(
    new Set(pool.hubPresence().sources[0].accountIds),
    new Set([a.userId, b.userId]),
  );
  assert.equal(pool.hubPresence().sources[0].complete, true);
  live = live.slice(0, 2);
  assert.deepEqual(pool.hubPresence().sources[0].accountIds, [a.userId]);
  pool.revokeHubSession(a.sessionId);
  assert.deepEqual(pool.hubPresence().sources[0].accountIds, []);
  assert.equal(pool.hubPresence().sources[0].complete, false);
  assert.throws(
    () => pool.assertHubLease(leases[2].sessionHash, a),
    /another Hub session/,
  );
  assert.throws(
    () => pool.bindHubLease(leases[2].sessionHash, a),
    /another Hub session/,
  );
  pool.setLocalRelaySessionIds(() => null);
  assert.equal(pool.hubPresence().sources[0].accountIds, null);
  assert.ok(
    store.db.prepare("SELECT count(*) n FROM browse_leases").get().n === 3,
    "telemetry never retires saved assignments",
  );
});
test("Hub revocation deadline reaches remote grants; validation never extends the 12-hour idle lease", async (t) => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  const { store, pool } = await fixture(t),
    grant = identity(),
    lease = await pool.operate({}, origin, runtimeOrigin),
    hash = digest(lease.session),
    before = store.db
      .prepare("SELECT seen FROM browse_leases WHERE hash=?")
      .get(hash).seen;
  pool.bindHubLease(hash, grant, Date.now() - 30000);
  pool.setRequireHubOwnership(true);
  const deadline = pool.nodeState("local").grants[0].expiresAt;
  assert.ok(deadline <= Date.now() + 15000);
  pool.refreshHubIdentity(grant, Date.now());
  assert.equal(
    store.db.prepare("SELECT seen FROM browse_leases WHERE hash=?").get(hash)
      .seen,
    before,
  );
  pool.refreshHubIdentity(grant, Date.now() - 45001);
  assert.deepEqual(pool.nodeState("local").leases, [hash],
    "a delayed older validation must not replace the authoritative newer check");
  clock += 45001;
  assert.deepEqual(pool.nodeState("local").leases, []);
  pool.refreshHubIdentity(grant, Date.now());
  assert.deepEqual(pool.nodeState("local").leases, [hash]);
  store.db
    .prepare("UPDATE browse_leases SET seen=? WHERE hash=?")
    .run(Date.now() - 12 * 3600000 - 1, hash);
  const renewed = await pool.operate(
    { intent: "restore", session: lease.session, generation: lease.generation },
    origin,
    runtimeOrigin,
    { grant, validatedAt: Date.now() },
  );
  assert.equal(renewed.node.id, lease.node.id);
  assert.ok(renewed.generation > lease.generation);
});

test("authenticated controller bootstrap binds account before issuing relay authority and rejects peer or revoked sessions", async (t) => {
  const { default: Fastify } = await import("fastify");
  const { installHubBranch } = await import("../server/hub-branch.mjs");
  const { installFrontendControllerAPI } = await import(
    "../server/frontend-controller.mjs"
  );
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-controller-")),
    store = openStore(dir),
    pool = createNodePool(store, {
      runtimeOrigin: "https://runtime.invalid",
      localRelayMode: "frontend",
    }),
    app = Fastify();
  t.after(async () => {
    await app.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = Date.now(),
    revoked = false;
  const grant = {
      protocol: 1,
      ...identity(),
      expiresAt: new Date(clock + 86400000).toISOString(),
      grantExpiresAt: new Date(clock + 300000).toISOString(),
    },
    other = {
      ...grant,
      userId: randomUUID(),
      profileId: randomUUID(),
      sessionId: randomUUID(),
    };
  await installHubBranch(app, {
    config: {
      appOrigin: origin,
      hubOrigin: "https://hub.example",
      hubBranchId: grant.branchId,
      hubBranchSecret: "s".repeat(43),
      opaqueRuntimeActivated: true,
    },
    originFor: () => origin,
    store,
    pool,
    seal: store.seal,
    unseal: store.unseal,
    now: () => clock,
    fetch: async (_url, options) =>
      new Response(
        JSON.stringify(
          revoked
            ? { error: { code: "HUB_SESSION_EXPIRED" } }
            : {
                grant:
                  options.headers["x-atlas-branch-session"] === "t".repeat(43)
                    ? grant
                    : other,
              },
        ),
        { status: revoked ? 401 : 200 },
      ),
  });
  installFrontendControllerAPI(app, {
    pool,
    originFor: () => origin,
    limitBrowse: () => {},
    administrator: () => {
      throw Error("Not an administrator");
    },
  });
  const cookie = (g, token) =>
    "__Host-atlas-hub=" +
    store.seal(
      JSON.stringify({
        token,
        grant: g,
        generation: 1,
        csrf: "c".repeat(43),
        origin,
      }),
    );
  const auth = cookie(grant, "t".repeat(43));
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/browse/controller/bootstrap",
    headers: { origin, cookie: auth },
    payload: {},
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const browserCookie = bootstrap.headers["set-cookie"].split(";")[0],
    headers = { origin, cookie: auth + "; " + browserCookie };
  const created = await app.inject({
    method: "POST",
    url: "/api/browse/controller/session",
    headers,
    payload: { intent: "new", requestId: bootstrap.json().requestId },
  });
  assert.equal(created.statusCode, 200, created.body);
  const session = created.json(),
    binding = store.db
      .prepare("SELECT * FROM hub_browse_owners WHERE lease_hash=?")
      .get(session.sessionHash);
  assert.equal(binding.user_id, grant.userId);
  assert.equal(
    pool.resolve(session.ticket, origin, "relay", { relayOrigin: origin })
      .session,
    session.sessionHash,
  );
  const peer = await app.inject({
    method: "POST",
    url: "/api/browse/controller/session",
    headers: {
      origin,
      cookie: cookie(other, "p".repeat(43)) + "; " + browserCookie,
    },
    payload: {
      intent: "renew",
      session: session.session,
      generation: session.generation,
    },
  });
  assert.equal(peer.statusCode, 403, peer.body);
  revoked = true;
  clock += 31000;
  assert.equal(
    (
      await app.inject({ url: "/api/hub/state", headers: { cookie: auth } })
    ).json().authenticated,
    false,
  );
  assert.throws(
    () =>
      pool.resolve(session.ticket, origin, "relay", { relayOrigin: origin }),
    /Validate your Hub account/,
  );
});
