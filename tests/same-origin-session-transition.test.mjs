import test from "node:test";
import assert from "node:assert/strict";
import {
  browsingLeaseStorageKeys,
  restoreBrowsingLeaseOnStartup,
  SESSION_STORAGE_KEY,
  LEASE_STORAGE_KEY,
  SAME_ORIGIN_SESSION_STORAGE_KEY,
  SAME_ORIGIN_LEASE_STORAGE_KEY,
} from "../web/src/browsing-session.ts";

const enabled = { runtimeProtocols: { sameOrigin: { activated: true } } };

test("first same-origin startup ignores stale legacy assignment metadata without clearing saved state", async () => {
  const existing = new Map([
    [SESSION_STORAGE_KEY, "stale-legacy-session"],
    [LEASE_STORAGE_KEY, { session: "stale-legacy-session", generation: 99 }],
    ["atlas.frontend.assignment.v2", "opaque-assignment-unrelated"],
    ["atlas.settings", { theme: "forest", restore: true }],
    ["atlas.tabs", [{ url: "https://website.example/game" }]],
    ["https://website.example@game-save", "777 cookies"],
  ]);
  const saved = new Map(existing);
  const reads = [],
    requests = [];
  const keys = browsingLeaseStorageKeys(enabled);
  const result = await restoreBrowsingLeaseOnStartup(
    () => {
      reads.push(keys.session);
      return saved.get(keys.session);
    },
    async (session, intent) => {
      requests.push({ session, intent });
      assert.equal(session, "");
      return { session: "same-origin-session", node: { id: "node-a" } };
    },
    (session) => saved.set(keys.session, session),
  );
  saved.set(keys.lease, result);
  assert.deepEqual(requests, [{ session: "", intent: "restore" }]);
  assert.deepEqual(reads, [SAME_ORIGIN_SESSION_STORAGE_KEY]);
  assert.equal(saved.get(SAME_ORIGIN_SESSION_STORAGE_KEY), result.session);
  assert.equal(saved.get(SAME_ORIGIN_LEASE_STORAGE_KEY), result);
  for (const [name, value] of existing) assert.equal(saved.get(name), value);
});

test("same-origin reload restores its current node instead of allocating or replaying a legacy pin", async () => {
  const keys = browsingLeaseStorageKeys(enabled);
  const saved = new Map([
    [SESSION_STORAGE_KEY, "legacy-node-b-session"],
    [LEASE_STORAGE_KEY, { session: "legacy-node-b-session", generation: 12 }],
    [keys.session, "same-origin-node-a-session"],
    [keys.lease, { session: "same-origin-node-a-session", generation: 3 }],
  ]);
  const requests = [];
  for (let reload = 0; reload < 2; reload++) {
    const lease = await restoreBrowsingLeaseOnStartup(
      () => saved.get(keys.session),
      async (session, intent) => {
        requests.push({ session, intent });
        return { session, generation: 3, node: { id: "node-a" } };
      },
      (session) => saved.set(keys.session, session),
    );
    assert.equal(lease.node.id, "node-a");
    assert.equal(lease.session, "same-origin-node-a-session");
  }
  assert.deepEqual(requests, [
    { session: "same-origin-node-a-session", intent: "restore" },
    { session: "same-origin-node-a-session", intent: "restore" },
  ]);
  assert.equal(saved.get(SESSION_STORAGE_KEY), "legacy-node-b-session");
  assert.equal(saved.get(LEASE_STORAGE_KEY).generation, 12);
});

test("assignment namespaces change only for explicit same-origin activation", () => {
  for (const config of [
    undefined,
    {},
    { runtimeProtocols: { sameOrigin: { activated: false } } },
    { runtimeProtocols: { sameOrigin: { activated: "true" } } },
    { runtimeProtocols: { opaque: { activated: true } } },
  ])
    assert.deepEqual(browsingLeaseStorageKeys(config), {
      session: SESSION_STORAGE_KEY,
      lease: LEASE_STORAGE_KEY,
    });
  assert.deepEqual(browsingLeaseStorageKeys(enabled), {
    session: SAME_ORIGIN_SESSION_STORAGE_KEY,
    lease: SAME_ORIGIN_LEASE_STORAGE_KEY,
  });
});
