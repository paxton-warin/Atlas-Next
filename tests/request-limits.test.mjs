import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { digest } from "../server/store.mjs";
import {
  createRequestLimits,
  normalizeRequestLimits,
  environmentRequestLimits,
  normalizeClientIp,
  requestLimitRules,
} from "../server/request-limits.mjs";
const origin = "http://localhost:4180";
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-ip-test-"));
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    dynamicOrigins: false,
    appOrigin: origin,
    runtimeOrigin: "http://127.0.0.1:4181",
  });
  app.store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
    .run(digest("ip-owner"), "csrf", Date.now(), Date.now());
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const headers = {
    origin,
    cookie: "atlas-admin=ip-owner",
    "x-atlas-csrf": "csrf",
  };
  return {
    app,
    headers,
    save: (payload) =>
      app.inject({
        method: "PUT",
        url: "/api/admin/request-limits",
        headers,
        payload,
      }),
  };
}
test("IP policy validates exact IPv4/IPv6/CIDR and normalizes mapped addresses", () => {
  assert.equal(normalizeClientIp("::ffff:192.0.2.7"), "192.0.2.7");
  assert.deepEqual(
    normalizeRequestLimits({
      whitelist: [
        "192.0.2.19/24",
        "192.0.2.0/24",
        "::ffff:198.51.100.8/120",
        "2001:db8::1/48",
      ],
    }).whitelist,
    ["192.0.2.0/24", "198.51.100.0/24", "2001:db8::/48"],
  );
  for (const value of [
    "2130706433",
    "127.1",
    "192.0.2.1/33",
    "::/129",
    "::ffff:192.0.2.1/24",
    "example.com",
    "*",
    "::1%lo0",
    "192.0.2.1/x",
  ])
    assert.throws(() => normalizeRequestLimits({ whitelist: [value] }), {
      statusCode: 400,
    });
  for (const value of [
    { enabled: "false" },
    { rules: { nope: {} } },
    { rules: { api: { max: -1 } } },
    { rules: { api: { windowSeconds: 0 } } },
    { whitelist: Array(257).fill("::1") },
  ])
    assert.throws(() => normalizeRequestLimits(value), { statusCode: 400 });
  assert.equal(
    environmentRequestLimits({ IP_RATE_LIMIT_ENABLED: "false" }).enabled,
    false,
  );
  assert.equal(
    environmentRequestLimits({ IP_RATE_LIMIT_RULES: '{"api":{"max":2}}' }).rules
      .api.max,
    2,
  );
});
test("custom caps, disabling and trusted IPv4/IPv6 whitelist apply to every IP rule", async (t) => {
  const f = await fixture(t),
    calls = [];
  const policy = createRequestLimits(
    f.app.store,
    (...args) => calls.push(args),
    {},
  );
  policy.save({
    whitelist: ["192.0.2.0/24", "2001:db8:7::/48"],
    rules: { ticket: { max: 17, windowSeconds: 90 } },
    aiConcurrent: 4,
  });
  for (const rule of requestLimitRules)
    for (const address of ["192.0.2.8", "::ffff:192.0.2.8", "2001:db8:7::99"])
      policy.limit(address, rule.key);
  assert.equal(calls.length, 0);
  assert.equal(policy.aiCapacity("192.0.2.8"), Infinity);
  policy.limit("192.0.3.8", "ticket");
  assert.deepEqual(calls[0].slice(1), [17, 90000]);
  assert.equal(policy.aiCapacity("2001:db8:8::99"), 4);
  policy.save({ enabled: false });
  policy.limit("198.51.100.1", "api");
  assert.equal(calls.length, 1);
  assert.equal(policy.aiCapacity("198.51.100.1"), Infinity);
  policy.save({ enabled: true, rules: { api: { max: 0 } } });
  policy.limit("198.51.100.1", "api");
  assert.equal(calls.length, 1);
  assert.equal(
    createRequestLimits(f.app.store, () => {}, {}).current().rules.ticket.max,
    17,
  );
});
test("API thresholds enforce, owner recovery stays authenticated and policy edits retain non-IP budgets", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.save({ rules: { api: { max: 1 } } })).statusCode, 200);
  const request = () =>
    f.app.inject({ url: "/api/config", remoteAddress: "192.0.2.20" });
  assert.equal((await request()).statusCode, 200);
  assert.equal((await request()).statusCode, 429);
  assert.equal(
    (await f.app.inject("/api/admin/request-limits")).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/api/admin/state",
        headers: f.headers,
        remoteAddress: "192.0.2.20",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/admin/request-limits",
        headers: { origin, cookie: f.headers.cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  f.app.store.db
    .prepare("INSERT INTO limits VALUES (?,?,?)")
    .run("ai:day:fixture", 5, Date.now() + 100000);
  f.app.store.db
    .prepare("INSERT INTO limits VALUES (?,?,?)")
    .run("reply:fixture", 4, Date.now() + 100000);
  assert.equal((await f.save({ enabled: false })).statusCode, 200);
  assert.equal((await request()).statusCode, 200);
  assert.equal((await request()).statusCode, 200);
  assert.equal(
    f.app.store.db
      .prepare("SELECT count FROM limits WHERE key='ai:day:fixture'")
      .get().count,
    5,
  );
  assert.equal(
    f.app.store.db
      .prepare("SELECT count FROM limits WHERE key='reply:fixture'")
      .get().count,
    4,
  );
  assert.equal(
    JSON.stringify((await request()).json()).includes("whitelist"),
    false,
  );
});
test("untrusted forwarded headers cannot impersonate a whitelisted IP", async (t) => {
  const original = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  const f = await fixture(t);
  if (original !== undefined) process.env.TRUST_PROXY = original;
  await f.save({ whitelist: ["192.0.2.10"], rules: { api: { max: 1 } } });
  const request = () =>
    f.app.inject({
      url: "/api/config",
      remoteAddress: "198.51.100.7",
      headers: {
        "x-forwarded-for": "192.0.2.10",
        "x-atlas-viewer-ip": "192.0.2.10",
      },
    });
  assert.equal((await request()).statusCode, 200);
  assert.equal((await request()).statusCode, 429);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await f.app.inject({ url: "/api/config", remoteAddress: "192.0.2.10" }))
        .statusCode,
      200,
    );
});
