import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";

const origin = "https://branch.example";
const serviceSecret = "test-service-".repeat(4);
const prefix = "/api/hub/profile/backups/v2";

// Use Main's real callback/session verification and request-limit hooks. The
// upstream only replaces Hub networking; no Main authentication or limiter is
// stubbed, unlike a restore-only transport fixture.
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-backup-rate-"));
  const branchId = randomUUID();
  const users = new Map();
  const forwarded = [];
  let pendingGrant, state;
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    appOrigin: origin,
    runtimeOrigin: "https://runtime.example",
    dynamicOrigins: false,
    hubOrigin: "https://hub.example",
    hubBranchId: branchId,
    hubBranchSecret: "b".repeat(43),
    hubUiOnlyLab: true,
    hubControlMutations: true,
    hubServiceSecret: serviceSecret,
    hubFetch: async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/exchange")) {
        const token = String(users.size + 1).repeat(43);
        users.set(token, pendingGrant);
        return Response.json({ branchSession: token, grant: pendingGrant, state });
      }
      const grant = users.get(options.headers["x-atlas-branch-session"]);
      if (!grant)
        return Response.json(
          { error: { code: "HUB_SESSION_EXPIRED" } },
          { status: 401 },
        );
      if (path.endsWith("/session")) return Response.json({ grant });
      forwarded.push({ method: options.method, url });
      return Response.json({ profileId: grant.profileId, acknowledged: true });
    },
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function policy() {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/hub/control",
      headers: { authorization: "Bearer " + serviceSecret },
      payload: {
        operation: "requestLimits.update",
        input: { rules: { api: { max: 1 } } },
      },
    });
    assert.equal(response.statusCode, 200);
    forwarded.length = 0;
  }
  async function login() {
    pendingGrant = {
      protocol: 1,
      branchId,
      userId: randomUUID(),
      profileId: randomUUID(),
      sessionId: randomUUID(),
      contextId: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    };
    const start = await app.inject({
      method: "POST",
      url: "/api/hub/signin",
      headers: { origin },
      payload: { returnTo: "/" },
    });
    assert.equal(start.statusCode, 200);
    state = new URL(start.json().redirect).searchParams.get("state");
    const done = await app.inject({
      url: "/auth/hub/callback?code=" + "c".repeat(43) + "&state=" + state,
      headers: { cookie: start.headers["set-cookie"].split(";")[0] },
    });
    assert.equal(done.statusCode, 302);
    const cookie = done.headers["set-cookie"]
      .find((value) => value.startsWith("__Host-atlas-hub="))
      .split(";")[0];
    const current = await app.inject({
      url: "/api/hub/state",
      headers: { cookie },
    });
    assert.equal(current.statusCode, 200);
    return { cookie, csrf: current.json().csrf, grant: pendingGrant };
  }
  return { app, forwarded, login, policy };
}

test("backup-v2 catalog/records/part routes share one finite authenticated budget, not the NAT budget", async (t) => {
  const f = await fixture(t);
  const a = await f.login(), b = await f.login();
  await f.policy();
  const checkpoint = randomUUID(), version = randomUUID(), restore = randomUUID();
  const hash = "a".repeat(64);
  const paths = [
    "/capabilities",
    "/checkpoints/latest?catalog=paged",
    `/checkpoints/${checkpoint}?catalog=paged&restoreId=${restore}`,
    `/checkpoints/${checkpoint}?restoreId=${restore}`,
    `/checkpoints/${checkpoint}/namespaces?cursor=opaque_catalog.cursor-1`,
    `/namespace-versions/${version}/records?cursor=${hash}`,
    `/parts/${hash}`,
    `/checkpoints/${checkpoint}?catalog=paged`,
    `/namespace-versions/${version}/records`,
    `/checkpoints/${checkpoint}/namespaces`,
  ];
  for (const path of paths) {
    const response = await f.app.inject({
      url: prefix + path,
      headers: { cookie: a.cookie },
    });
    assert.equal(response.statusCode, 200, path);
  }
  assert.equal(f.forwarded.length, 10, "all recognized routes reach authenticated upstream");
  assert.equal(
    (await f.app.inject({ url: prefix + `/parts/${hash}`, headers: { cookie: a.cookie } })).statusCode,
    429,
    "route changes do not reset or escape the shared profile budget",
  );
  assert.equal(f.forwarded.length, 10, "exhausted requests stop before upstream work");
  assert.equal(
    (await f.app.inject({ url: prefix + `/parts/${hash}`, headers: { cookie: b.cookie } })).statusCode,
    200,
    "a separate account on the same IP has an independent authenticated budget",
  );
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) n FROM limits WHERE key LIKE 'api:%'").get().n,
    0,
    "recognized backups do not consume either IP or ordinary-account API allowance",
  );
  assert.deepEqual(
    f.app.store.db.prepare("SELECT count FROM limits WHERE key LIKE 'profile-sync:%' ORDER BY count").all().map((row) => row.count),
    [1, 11],
  );
});

test("unknown backup paths/queries and invalid authentication retain the generic IP budget", async (t) => {
  const checkpoint = randomUUID(), version = randomUUID(), hash = "b".repeat(64);
  const cases = [
    ["unknown path", { url: prefix + "/unimplemented" }],
    ["unknown query", { url: prefix + `/parts/${hash}?unapproved=1` }],
    ["invalid records cursor", { url: prefix + `/namespace-versions/${version}/records?cursor=not-a-hash` }],
    ["duplicate catalog query", { url: prefix + `/checkpoints/${checkpoint}?catalog=paged&catalog=paged` }],
    ["invalid restore identity", { url: prefix + `/checkpoints/${checkpoint}?catalog=paged&restoreId=invalid` }],
    ["missing CSRF", { method: "POST", url: prefix + `/checkpoints/${checkpoint}/restore-release`, headers: { origin }, payload: { leaseId: randomUUID() } }],
    ["unauthenticated", { url: prefix + `/parts/${hash}`, unauthenticated: true }],
  ];
  for (const [label, entry] of cases) {
    await t.test(label, async (t) => {
      const f = await fixture(t), a = await f.login();
      await f.policy();
      const { unauthenticated, ...input } = entry;
      input.headers = {
        ...(unauthenticated ? {} : { cookie: a.cookie }),
        ...input.headers,
      };
      assert.ok([401, 403, 404].includes((await f.app.inject(input)).statusCode), label);
      assert.equal((await f.app.inject(input)).statusCode, 429, label);
      assert.equal(f.forwarded.length, 0, "invalid operation never reaches Hub");
      assert.equal(
        (await f.app.inject({ url: prefix + `/parts/${hash}`, headers: { cookie: a.cookie } })).statusCode,
        200,
        "exhausted generic IP allowance does not block a valid authenticated restore",
      );
    });
  }
});
