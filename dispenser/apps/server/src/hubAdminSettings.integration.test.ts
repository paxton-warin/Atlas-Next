import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";
import { DEFAULT_ENTRY_LAUNCH_LINK } from "./entryLaunchLink.js";
const database = process.env.TEST_DATABASE_URL,
  run = database ? describe : describe.skip;
run("Generic admin settings only expose editable policy sections", () => {
  const schema = "admin_settings_" + randomUUID().replaceAll("-", ""),
    token = "fixture-admin-" + randomUUID(),
    csrf = "fixture-csrf-" + randomUUID(),
    userToken = "fixture-user-" + randomUUID(),
    userCSRF = "fixture-user-csrf-" + randomUUID();
  let pool: Pool,
    maintenance: Pool,
    app: Awaited<ReturnType<typeof buildApp>>["app"];
  const headers = { cookie: "ald_session=" + token, "x-csrf-token": csrf };
  const userHeaders = {
    cookie: "ald_session=" + userToken,
    "x-csrf-token": userCSRF,
  };
  beforeAll(async () => {
    if (!new URL(database!).pathname.endsWith("_test"))
      throw Error("Dedicated test database required");
    maintenance = new Pool({ connectionString: database });
    const c = await maintenance.connect();
    try {
      await c.query("SELECT pg_advisory_lock(870412201)");
      await c.query(
        "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
      );
    } finally {
      await c.query("SELECT pg_advisory_unlock(870412201)");
      c.release();
    }
    await maintenance.query("CREATE SCHEMA " + schema);
    pool = new Pool({
      connectionString: database,
      options: "-c search_path=" + schema + ",public",
    });
    const directory = new URL(
      "../../../packages/database/migrations/",
      import.meta.url,
    );
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(new URL(file, directory), "utf8"));
    const user = (
      await pool.query(
        "INSERT INTO users(email,normalized_email,role,verified_at)VALUES('admin@example.test','admin@example.test','admin',now())RETURNING id",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 day')",
      [
        user.id,
        hashSecret(token, config.sessionSecret),
        hashSecret(csrf, config.sessionSecret),
      ],
    );
    const ordinaryUser = (
      await pool.query(
        "INSERT INTO users(email,normalized_email,role,verified_at)VALUES('user@example.test','user@example.test','user',now())RETURNING id",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 day')",
      [
        ordinaryUser.id,
        hashSecret(userToken, config.sessionSecret),
        hashSecret(userCSRF, config.sessionSecret),
      ],
    );
    await pool.query(
      "INSERT INTO app_settings(key,value)VALUES('hub_current_origin',$1),('profile_policy',$2),('future_private',$3)",
      [
        JSON.stringify("https://replacement.example"),
        JSON.stringify({ private: true }),
        JSON.stringify("reserved"),
      ],
    );
    const redis = {
      status: "ready",
      ping: async () => "PONG",
      incr: async () => 1,
      expire: async () => 1,
    };
    app = (await buildApp({ pool, redis: redis as any, hubEnabled: false }))
      .app;
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await maintenance?.query("DROP SCHEMA " + schema + " CASCADE");
    await maintenance?.end();
  });
  it("returns only the same editable sections and keeps unrelated internal state out of the UI", async () => {
    const response = await app.inject({
      url: "/api/admin/settings",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().settings).sort()).toEqual([
      "assignments",
      "entryLaunchLink",
      "health",
      "registration",
      "reporting",
      "verification",
    ]);
    expect(response.body).not.toContain("hub_current_origin");
    expect(response.body).not.toContain("replacement.example");
    expect(response.body).not.toContain("profile_policy");
    expect(response.body).not.toContain("future_private");
    expect((await app.inject("/api/admin/settings")).statusCode).toBe(401);
  });
  it("denies writes to every hidden internal key while ordinary settings retain their update contract", async () => {
    for (const key of [
      "hub_current_origin",
      "profile_policy",
      "future_private",
    ])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/admin/settings/" + key,
            headers,
            payload: { value: "tamper" },
          })
        ).statusCode,
      ).toBe(400);
    const value = (
      await app.inject({ url: "/api/admin/settings", headers })
    ).json().settings.reporting;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/settings/reporting",
          headers,
          payload: value,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT value FROM app_settings WHERE key='hub_current_origin'",
        )
      ).rows[0].value,
    ).toBe("https://replacement.example");
  });
  it("returns the disabled public and administrative defaults without requiring a migration", async () => {
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app_settings WHERE key='entryLaunchLink'",
        )
      ).rowCount,
    ).toBe(0);
    const publicResponse = await app.inject("/api/hub/launch-link");
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.headers["cache-control"]).toBe("no-store");
    expect(publicResponse.json()).toEqual(DEFAULT_ENTRY_LAUNCH_LINK);
    const adminResponse = await app.inject({
      url: "/api/admin/settings/entryLaunchLink",
      headers,
    });
    expect(adminResponse.json()).toEqual({
      key: "entryLaunchLink",
      value: DEFAULT_ENTRY_LAUNCH_LINK,
    });
  });
  it("creates and updates either or both switches, preserves URL details, and records every change", async () => {
    const url = "https://example.test/document?tab=t.0&view=all#heading";
    for (const [hubEnabled, browserEnabled] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ]) {
      const value = { url, hubEnabled, browserEnabled };
      const response = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/entryLaunchLink",
        headers,
        payload: value,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ key: "entryLaunchLink", value });
      expect((await app.inject("/api/hub/launch-link")).json()).toEqual(value);
      expect(
        (await app.inject({ url: "/api/admin/settings", headers })).json()
          .settings.entryLaunchLink,
      ).toEqual(value);
    }
    const events = (
      await pool.query(
        "SELECT before,after FROM audit_events WHERE action='settings.update' AND target_id='entryLaunchLink' ORDER BY created_at",
      )
    ).rows;
    expect(events).toHaveLength(4);
    expect(events[0].before).toBeNull();
    expect(events[0].after).toEqual({
      url,
      hubEnabled: true,
      browserEnabled: false,
    });
    expect(events[1].before).toEqual(events[0].after);
    expect(events[3].after).toEqual({
      url,
      hubEnabled: false,
      browserEnabled: false,
    });
  });
  it("rejects invalid types, destinations, and unrecognized fields without changing stored settings", async () => {
    const original = (await app.inject("/api/hub/launch-link")).json();
    for (const payload of [
      {},
      { ...original, url: "javascript:alert(1)" },
      { ...original, url: "https://user:password@example.test" },
      { ...original, url: "https://example.test/" + "x".repeat(2048) },
      { ...original, hubEnabled: "false" },
      { ...original, browserEnabled: 1 },
      { ...original, extra: true },
      { url: original.url, hubEnabled: false },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/entryLaunchLink",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect((await app.inject("/api/hub/launch-link")).json()).toEqual(original);
  });
  it("requires an administrator and valid CSRF for writes, while public reads contain no private policy", async () => {
    const endpoint = "/api/admin/settings/entryLaunchLink";
    expect((await app.inject(endpoint)).statusCode).toBe(401);
    expect(
      (await app.inject({ url: endpoint, headers: userHeaders })).statusCode,
    ).toBe(403);
    for (const [requestHeaders, status] of [
      [{}, 401],
      [userHeaders, 403],
      [{ cookie: headers.cookie }, 403],
      [{ ...headers, "x-csrf-token": "incorrect" }, 403],
    ] as const) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: endpoint,
            headers: requestHeaders,
            payload: DEFAULT_ENTRY_LAUNCH_LINK,
          })
        ).statusCode,
      ).toBe(status);
    }
    expect(
      (await app.inject({ url: "/api/admin/settings/future_private", headers }))
        .statusCode,
    ).toBe(400);
    const publicValue = (await app.inject("/api/hub/launch-link")).json();
    expect(Object.keys(publicValue).sort()).toEqual([
      "browserEnabled",
      "hubEnabled",
      "url",
    ]);
  });
  it("fails closed for malformed stored configuration on both public and admin reads", async () => {
    await pool.query(
      "UPDATE app_settings SET value=$1 WHERE key='entryLaunchLink'",
      [
        JSON.stringify({
          url: "javascript:alert(1)",
          hubEnabled: true,
          browserEnabled: true,
        }),
      ],
    );
    expect((await app.inject("/api/hub/launch-link")).json()).toEqual(
      DEFAULT_ENTRY_LAUNCH_LINK,
    );
    expect(
      (await app.inject({ url: "/api/admin/settings", headers })).json()
        .settings.entryLaunchLink,
    ).toEqual(DEFAULT_ENTRY_LAUNCH_LINK);
  });
});
