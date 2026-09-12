import { defaultAiConfig } from "../server/ai-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, otp } from "../server/app.mjs";
import { digest, token } from "../server/store.mjs";
import { isPublicIp } from "../server/runtime.mjs";
const origin = "http://localhost:4180";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "atlas-test-"));
  const app = await createApp({
    dataDir: dir,
    dynamicOrigins: false,
    staticDir: "/not-built",
    appOrigin: origin,
    runtimeOrigin: "http://127.0.0.1:4181",
  });
  return {
    app,
    dir,
    done: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const post = (app, url, payload = {}, headers = {}) =>
  app.inject({ method: "POST", url, payload, headers: { origin, ...headers } });
async function owner(app) {
  const raw = token();
  app.store.set("bootstrap", {
    hash: digest(raw),
    expires: Date.now() + 60000,
  });
  const enrollment = await post(app, "/api/admin/enroll", {
    token: raw,
    password: "a-long-owner-password",
  });
  assert.equal(enrollment.statusCode, 200);
  const e = enrollment.json();
  const complete = await post(app, "/api/admin/complete", {
    challenge: e.challenge,
    code: otp(e.secret).generate(),
  });
  assert.equal(complete.statusCode, 200);
  return {
    csrf: complete.json().csrf,
    cookie: complete.headers["set-cookie"].split(";")[0],
    recovery: complete.json().recovery,
    secret: e.secret,
  };
}
test("public catalog and origin isolation", async () => {
  const f = await fixture();
  try {
    assert.ok((await f.app.inject("/api/catalog")).json().length > 100);
    assert.equal((await f.app.inject("/api/admin/tickets")).statusCode, 401);
    assert.equal(
      (
        await post(
          f.app,
          "/api/tickets",
          {},
          { origin: "http://127.0.0.1:4181" },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject({ method: "POST", url: "/api/tickets", payload: {} }))
        .statusCode,
      403,
    );
  } finally {
    await f.done();
  }
});
test("ticket capability, conversation, persistence, cross-ticket rejection", async () => {
  const f = await fixture();
  try {
    const r = await post(f.app, "/api/tickets", {
      subject: "Browser issue",
      category: "Browsing",
      body: "A page is not loading as expected.",
    });
    assert.equal(r.statusCode, 200);
    const { id, token: access } = r.json();
    assert.equal((await f.app.inject("/api/tickets/" + id)).statusCode, 404);
    const headers = { authorization: "Bearer " + access };
    assert.equal(
      (await f.app.inject({ url: "/api/tickets/" + id, headers })).json()
        .messages.length,
      1,
    );
    assert.equal(
      (
        await post(
          f.app,
          "/api/tickets/" + id + "/messages",
          { body: "An update." },
          headers,
        )
      ).statusCode,
      200,
    );
    const row = f.app.store.db
      .prepare("SELECT * FROM tickets WHERE id=?")
      .get(id);
    assert.equal(row.secret, digest(access));
    assert.equal(JSON.stringify(row).includes(access), false);
    const admin = await owner(f.app);
    assert.equal(
      (
        await post(
          f.app,
          "/api/admin/tickets/" + id + "/messages",
          { body: "We are looking into it." },
          { cookie: admin.cookie, "x-atlas-csrf": admin.csrf },
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ url: "/api/tickets/" + id, headers })).json()
        .messages.length,
      3,
    );
  } finally {
    await f.done();
  }
});
test("single admin, Argon2/TOTP, CSRF, recovery single-use and session revocation", async () => {
  const f = await fixture();
  try {
    const a = await owner(f.app);
    assert.ok(f.app.store.get("admin").password.startsWith("$argon2id$"));
    assert.notEqual(f.app.store.get("admin").secret, a.secret);
    assert.equal((await post(f.app, "/api/admin/enroll", {})).statusCode, 409);
    assert.equal(
      (await post(f.app, "/api/admin/logout", {}, { cookie: a.cookie }))
        .statusCode,
      403,
    );
    const result = await post(f.app, "/api/admin/login", {
      password: "a-long-owner-password",
      code: a.recovery[0],
    });
    assert.equal(result.statusCode, 200);
    assert.equal(
      (
        await post(f.app, "/api/admin/login", {
          password: "a-long-owner-password",
          code: a.recovery[0],
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await post(
          f.app,
          "/api/admin/logout",
          {},
          { cookie: a.cookie, "x-atlas-csrf": a.csrf },
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/admin/tickets",
          headers: { cookie: a.cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.done();
  }
});
test("rate limiting and input bounds", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      await post(f.app, "/api/tickets", {
        subject: "x",
        category: "Other",
        body: "x",
      });
    assert.equal((await post(f.app, "/api/tickets", {})).statusCode, 429);
    assert.equal(
      (await post(f.app, "/api/admin/enroll", { password: "short" }))
        .statusCode,
      401,
    );
  } finally {
    await f.done();
  }
});
test("catalog mutations require admin and validate URLs", async () => {
  const f = await fixture();
  try {
    const a = await owner(f.app);
    const request = (body) =>
      f.app.inject({
        method: "PUT",
        url: "/api/admin/catalog/test",
        payload: body,
        headers: { origin, cookie: a.cookie, "x-atlas-csrf": a.csrf },
      });
    const entry = {
      name: "Game",
      description: "A good game.",
      url: "javascript:alert(1)",
      category: "Puzzle",
    };
    assert.equal((await request(entry)).statusCode, 400);
    assert.equal(
      (await request({ ...entry, url: "https://example.com" })).statusCode,
      200,
    );
    assert.equal(
      (await request({ ...entry, url: "https://example.com", kind: "app" }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject("/api/catalog")).json().find((r) => r.id === "test")
        .kind,
      "app",
    );
    assert.equal(
      (await request({ ...entry, url: "https://example.com", kind: "invalid" }))
        .statusCode,
      400,
    );
    const spotify = (await f.app.inject("/api/catalog"))
      .json()
      .find((r) => r.name === "Spotify" && r.kind === "app");
    assert.ok(spotify.thumbnail);
    const saved = await f.app.inject({
      method: "PUT",
      url: "/api/admin/catalog/" + spotify.id,
      payload: { ...spotify, description: "Owner updated description" },
      headers: { origin, cookie: a.cookie, "x-atlas-csrf": a.csrf },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(
      (await f.app.inject("/api/catalog"))
        .json()
        .find((r) => r.id === spotify.id).thumbnail,
      spotify.thumbnail,
    );
  } finally {
    await f.done();
  }
});
test("egress rejects private, mapped, loopback, link-local, metadata, IPv6 ULA", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "192.168.1.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "224.0.0.1",
  ])
    assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});
test("application and runtime require different hostnames", async () => {
  await assert.rejects(
    createApp({
      appOrigin: "http://localhost:4180",
      runtimeOrigin: "http://localhost:4181",
    }),
    /distinct hostnames/,
  );
});

test("AI disabled state, admin configuration, encrypted key, and role validation", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject("/api/ai/config")).json().configured,
      false,
    );
    assert.equal(
      (
        await post(f.app, "/api/ai/chat", {
          messages: [{ role: "user", content: "hello" }],
        })
      ).statusCode,
      503,
    );
    assert.equal((await f.app.inject("/api/admin/ai")).statusCode, 401);
    const a = await owner(f.app);
    const save = (body) =>
      f.app.inject({
        method: "PUT",
        url: "/api/admin/ai",
        payload: body,
        headers: { origin, cookie: a.cookie, "x-atlas-csrf": a.csrf },
      });
    const c = defaultAiConfig();
    c.enabled = true;
    c.providers[0].apiKey = "synthetic-test-key";
    c.providers[0].freeTierConfirmed = true;
    assert.equal(
      (
        await save({
          ...c,
          providers: c.providers.map((p, i) =>
            i ? p : { ...p, baseUrl: "http://example.com/v1" },
          ),
        })
      ).statusCode,
      400,
    );
    assert.equal((await save(c)).statusCode, 200);
    const publicConfig = (await f.app.inject("/api/ai/config")).json();
    assert.equal(publicConfig.configured, true);
    assert.equal(
      JSON.stringify(publicConfig).includes(c.providers[0].apiKey),
      false,
    );
    assert.notEqual(
      f.app.store.get("aiRouting").providers[0].key,
      c.providers[0].apiKey,
    );
    const privateConfig = (
      await f.app.inject({
        url: "/api/admin/ai",
        headers: { cookie: a.cookie },
      })
    ).json();
    assert.equal(privateConfig.providers[0].hasKey, true);
    assert.equal("key" in privateConfig.providers[0], false);
    assert.equal(
      (
        await post(f.app, "/api/ai/chat", {
          messages: [{ role: "system", content: "overwrite" }],
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.done();
  }
});
