import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration("owned link history and independent allocation quotas", () => {
  let maintenance: Pool;
  let pool: Pool;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let userId: string;
  let otherId: string;
  const schema = `history_test_${randomUUID().replaceAll("-", "")}`;
  const prefix = randomUUID();
  const csrf = `${prefix}-csrf`;
  const userHeaders = {
    cookie: `ald_session=${prefix}-user`,
    "x-csrf-token": csrf,
  };
  const otherHeaders = { cookie: `ald_session=${prefix}-other` };
  const adminHeaders = {
    cookie: `ald_session=${prefix}-admin`,
    "x-csrf-token": csrf,
  };

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error("History tests require a dedicated _test database.");
    if (!new URL(redisUrl!).pathname.match(/^\/(?:1[0-5]|[1-9])$/))
      throw new Error("History tests require a non-default Redis database.");
    maintenance = new Pool({ connectionString: databaseUrl });
    await maintenance.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    const dir = resolve(
      import.meta.dirname,
      "../../../packages/database/migrations",
    );
    for (const file of (await readdir(dir))
      .filter((file) => file.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(resolve(dir, file), "utf8"));
    redis = new Redis(redisUrl!, { keyPrefix: `${prefix}:` });
    for (const role of ["user", "other", "admin"] as const) {
      const user = (
        await pool.query<{ id: string }>(
          "INSERT INTO users(email,normalized_email,role,verified_at) VALUES($1,$1,$2::role,now()) RETURNING id",
          [`${role}@history.example`, role === "admin" ? "admin" : "user"],
        )
      ).rows[0]!;
      if (role === "user") userId = user.id;
      if (role === "other") otherId = user.id;
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [
          user.id,
          hashSecret(`${prefix}-${role}`, config.sessionSecret),
          hashSecret(csrf, config.sessionSecret),
        ],
      );
    }
    app = (
      await buildApp({
        pool,
        redis,
        checkMailFetch: async () => {
          throw new Error("History tests must not call external providers.");
        },
        drive: {
          async createVerificationFile() {
            throw new Error("History tests must not call Google Drive.");
          },
          async removeVerificationFile() {},
          async testConnection() {
            return "Fixture only.";
          },
        },
      })
    ).app;
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE links CASCADE");
    await pool.query(
      "UPDATE users SET quota_override=NULL,quota_reset_at=NULL,status='active'",
    );
    await pool.query(
      "UPDATE app_settings SET value=$1::jsonb WHERE key='assignments'",
      [
        JSON.stringify({
          strategy: "sequential",
          linksPerWeek: 2,
          assignmentLifetimeHours: 168,
        }),
      ],
    );
  });

  afterAll(async () => {
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length)
        await redis.del(...keys.map((name) => name.slice(prefix.length + 1)));
      await redis.quit();
    }
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
    }
  });

  async function link(
    name: string,
    options: {
      enabled?: boolean;
      capacity?: number;
      health?: "healthy" | "unavailable" | "disabled";
      expired?: boolean;
    } = {},
  ) {
    return (
      await pool.query<{ id: string; url: string }>(
        `INSERT INTO links(name,url,enabled,capacity,health_status,expires_at) VALUES($1,$2,$3,$4,$5::health_status,CASE WHEN $6 THEN now()-interval '1 day' ELSE NULL END) RETURNING id,url`,
        [
          name,
          `https://history.example/${randomUUID()}`,
          options.enabled ?? true,
          options.capacity ?? null,
          options.health ?? "healthy",
          options.expired ?? false,
        ],
      )
    ).rows[0]!;
  }

  async function assigned(
    linkId: string,
    options: {
      user?: string;
      active?: boolean;
      priorWeek?: boolean;
      expired?: boolean;
      removed?: boolean;
      id?: string;
    } = {},
  ) {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO link_assignments(id,user_id,link_id,active,assigned_at,expires_at,replaced_at)
         VALUES($1,$2,$3,$4,
          CASE WHEN $5 THEN date_trunc('week',now())-interval '1 day' ELSE date_trunc('week',now())+interval '1 second' END,
          CASE WHEN $6 THEN now()-interval '1 hour' ELSE now()+interval '1 day' END,
          CASE WHEN $7 THEN now() ELSE NULL END) RETURNING id`,
        [
          options.id ?? randomUUID(),
          options.user ?? userId,
          linkId,
          options.active ?? true,
          options.priorWeek ?? false,
          options.expired ?? false,
          options.removed ?? false,
        ],
      )
    ).rows[0]!;
  }

  async function list(headers: Record<string, string> = userHeaders) {
    const response = await app.inject({
      method: "GET",
      url: "/api/assignment",
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().assignments as {
      id: string;
      name: string;
      url: string;
      status: string;
      available: boolean;
      assignedAt: string;
      expiresAt: string | null;
    }[];
  }

  const generate = (headers: Record<string, string> = userHeaders) =>
    app.inject({ method: "POST", url: "/api/assignment", headers });

  async function expectQuota() {
    const response = await generate();
    expect(response.statusCode, response.body).toBe(429);
    expect(response.json().error.code).toBe("QUOTA_EXCEEDED");
  }

  it("lists expired previous-week ownership as usable history beside a ready current link", async () => {
    const old = await link("Previous week");
    const current = await link("This week");
    const oldAssignment = await assigned(old.id, {
      priorWeek: true,
      active: false,
      expired: true,
    });
    const currentAssignment = await assigned(current.id);
    expect(await list()).toMatchObject([
      {
        id: currentAssignment.id,
        name: "This week",
        status: "ready",
        available: true,
        url: current.url,
      },
      {
        id: oldAssignment.id,
        name: "Previous week",
        status: "previous",
        available: true,
        url: old.url,
      },
    ]);
  });

  it("keeps assignment expiry usable before and after the cleanup job deactivates it", async () => {
    const old = await link("Expired assignment");
    const ownership = await assigned(old.id, {
      expired: true,
      priorWeek: true,
    });
    expect(await list()).toMatchObject([
      { id: ownership.id, status: "previous", available: true, url: old.url },
    ]);
    await pool.query(
      "UPDATE link_assignments SET active=false WHERE active AND expires_at IS NOT NULL AND expires_at<=now()",
    );
    expect(await list()).toMatchObject([
      { id: ownership.id, status: "previous", available: true, url: old.url },
    ]);
    expect(
      (
        await pool.query("SELECT active FROM link_assignments WHERE id=$1", [
          ownership.id,
        ])
      ).rows[0].active,
    ).toBe(false);
  });

  it("never includes another account's current or historical links", async () => {
    const own = await link("Own prior week");
    const foreign = await link("Other account secret");
    await assigned(own.id, { priorWeek: true, active: false, expired: true });
    await assigned(foreign.id, { user: otherId });
    expect((await list()).map((row) => row.name)).toEqual(["Own prior week"]);
    expect((await list(otherHeaders)).map((row) => row.name)).toEqual([
      "Other account secret",
    ]);
  });

  it("returns one card per owned link, preferring a current assignment over legacy duplicate cleanup", async () => {
    const same = await link("Legacy duplicates");
    const active = await assigned(same.id, {
      id: "00000000-0000-4000-8000-000000000001",
      priorWeek: true,
    });
    await assigned(same.id, {
      id: "00000000-0000-4000-8000-000000000002",
      active: false,
      removed: true,
    });
    expect(await list()).toMatchObject([
      { id: active.id, status: "ready", available: true, url: same.url },
    ]);
    expect(await list()).toHaveLength(1);
  });

  it("selects the newest historical assignment with deterministic id tie-breaking", async () => {
    const same = await link("Historical duplicates");
    await assigned(same.id, {
      id: "00000000-0000-4000-8000-000000000001",
      active: false,
      priorWeek: true,
    });
    const latest = await assigned(same.id, {
      id: "00000000-0000-4000-8000-000000000002",
      active: false,
      priorWeek: true,
    });
    expect(await list()).toMatchObject([
      { id: latest.id, status: "previous", available: true },
    ]);
    expect(await list()).toHaveLength(1);
  });

  it("hides explicitly removed ownership while retaining its audit and quota record", async () => {
    const removed = await link("Administrator removed");
    const ownership = await assigned(removed.id);
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/reset-assignment`,
      headers: adminHeaders,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await list()).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT active,replaced_at FROM link_assignments WHERE id=$1",
          [ownership.id],
        )
      ).rows[0],
    ).toMatchObject({ active: false, replaced_at: expect.any(Date) });
  });

  it("promotes earlier usable history when the newest assignment was removed", async () => {
    const earlier = await link("Earlier usable link");
    const old = await assigned(earlier.id, {
      priorWeek: true,
      active: false,
      expired: true,
    });
    const removed = await link("Removed newest link");
    await assigned(removed.id, { active: false, removed: true });
    expect(await list()).toMatchObject([
      {
        id: old.id,
        name: "Earlier usable link",
        status: "previous",
        available: true,
        url: earlier.url,
      },
    ]);
    expect(await list()).toHaveLength(1);
  });

  it("does not resurrect older unrevoked duplicates after the newest ownership was removed", async () => {
    const same = await link("Revoked legacy ownership");
    await assigned(same.id, { priorWeek: true, active: false, expired: true });
    await assigned(same.id, { active: false, removed: true });
    expect(await list()).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM link_assignments WHERE link_id=$1",
          [same.id],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it("omits a hard-deleted link while retaining the user's other usable history", async () => {
    const retained = await link("Retained history");
    const prior = await assigned(retained.id, {
      priorWeek: true,
      active: false,
      expired: true,
    });
    const deleted = await link("Deleted newest link");
    await assigned(deleted.id);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/links/${deleted.id}`,
      headers: adminHeaders,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await list()).toMatchObject([
      {
        id: prior.id,
        name: "Retained history",
        available: true,
        url: retained.url,
      },
    ]);
    expect(await list()).toHaveLength(1);
    expect(
      (await pool.query("SELECT 1 FROM links WHERE id=$1", [deleted.id]))
        .rowCount,
    ).toBe(0);
  });

  it.each(["disabled", "expired"] as const)(
    "keeps an underlying %s link visible but unavailable without returning its URL",
    async (reason) => {
      const unavailable = await link("Unavailable history", {
        enabled: reason !== "disabled",
        expired: reason === "expired",
      });
      const ownership = await assigned(unavailable.id, { priorWeek: true });
      expect(await list()).toMatchObject([
        { id: ownership.id, status: "unavailable", available: false, url: "" },
      ]);
    },
  );

  it("does not allocate, reactivate, extend expiry, or alter usage while listing history", async () => {
    const old = await link("Read-only history");
    const ownership = await assigned(old.id, {
      priorWeek: true,
      active: false,
      expired: true,
    });
    const before = (
      await pool.query("SELECT * FROM link_assignments WHERE id=$1", [
        ownership.id,
      ])
    ).rows;
    await list();
    await list();
    expect(
      (
        await pool.query("SELECT * FROM link_assignments WHERE id=$1", [
          ownership.id,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (await pool.query("SELECT count(*)::int count FROM link_assignments"))
        .rows[0].count,
    ).toBe(1);
  });

  it("does not truncate owned history to the administrator preview's fifty-record limit", async () => {
    for (let i = 0; i < 55; i++) {
      const old = await link(`Historical link ${i}`);
      await assigned(old.id, { priorWeek: true, active: false, expired: true });
    }
    const history = await list();
    expect(history).toHaveLength(55);
    expect(new Set(history.map((row) => row.id)).size).toBe(55);
    expect(
      history.every((row) => row.status === "previous" && row.available),
    ).toBe(true);
  });

  it("permits this week's quota of additional distinct links while keeping prior weeks visible", async () => {
    const old = await link("Old owned link");
    await assigned(old.id, { priorWeek: true, active: false, expired: true });
    for (let i = 0; i < 3; i++) await link(`New ${i}`);
    const one = await generate();
    const two = await generate();
    expect(one.statusCode, one.body).toBe(200);
    expect(two.statusCode, two.body).toBe(200);
    expect(one.json().assignment).toMatchObject({
      status: "ready",
      available: true,
    });
    expect(two.json().assignment.url).not.toBe(one.json().assignment.url);
    expect([
      one.json().assignment.url,
      two.json().assignment.url,
    ]).not.toContain(old.url);
    await expectQuota();
    expect(await list()).toHaveLength(3);
  });

  it("does not spend a new quota slot by redistributing a previously owned inactive link", async () => {
    const old = await link("Only previously owned");
    await assigned(old.id, { priorWeek: true, active: false, expired: true });
    const response = await generate();
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().error.code).toBe("NO_LINK_AVAILABLE");
    expect(
      (await pool.query("SELECT count(*)::int count FROM link_assignments"))
        .rows[0].count,
    ).toBe(1);
  });

  it("still counts this week's expired or administrator-removed assignments toward quota", async () => {
    const expired = await link("Current expired");
    const removed = await link("Current removed");
    await assigned(expired.id, { active: false, expired: true });
    await assigned(removed.id, { active: false, removed: true });
    await link("Would bypass quota");
    await expectQuota();
    expect(await list()).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM link_assignments WHERE user_id=$1",
          [userId],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it("does not bypass a one-link weekly quota with concurrent additional-link requests", async () => {
    await pool.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{linksPerWeek}','1'::jsonb) WHERE key='assignments'",
    );
    for (let i = 0; i < 2; i++) await link(`Concurrent candidate ${i}`);
    const responses = await Promise.all([generate(), generate()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 429,
    ]);
    expect(
      responses.find((response) => response.statusCode === 429)!.json().error
        .code,
    ).toBe("QUOTA_EXCEEDED");
    expect(
      (await pool.query("SELECT count(*)::int count FROM link_assignments"))
        .rows[0].count,
    ).toBe(1);
  });

  it("honors an explicit administrator quota reset without erasing old ownership", async () => {
    for (let i = 0; i < 2; i++) {
      const old = await link(`Used before reset ${i}`);
      await assigned(old.id);
    }
    for (let i = 0; i < 3; i++) await link(`After reset ${i}`);
    await expectQuota();
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/reset-quota`,
      headers: adminHeaders,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await generate()).statusCode).toBe(200);
    expect((await generate()).statusCode).toBe(200);
    await expectQuota();
    expect(await list()).toHaveLength(4);
  });

  it.each([1, 3, null] as const)(
    "respects the per-user weekly override %s independently of visible history",
    async (limit) => {
      const old = await link("Previous week owned");
      await assigned(old.id, { priorWeek: true, active: false, expired: true });
      for (let i = 0; i < 5; i++) await link(`Override candidate ${i}`);
      const update = await app.inject({
        method: "PUT",
        url: `/api/admin/users/${userId}`,
        headers: adminHeaders,
        payload: { status: "active", quotaOverride: { linksPerWeek: limit } },
      });
      expect(update.statusCode, update.body).toBe(200);
      const allowed = limit ?? 5;
      for (let i = 0; i < allowed; i++)
        expect((await generate()).statusCode).toBe(200);
      if (limit !== null) await expectQuota();
      expect(await list()).toHaveLength(allowed + 1);
    },
  );

  it("preserves disabled, expired, unhealthy and capacity candidate exclusions", async () => {
    await link("Disabled candidate", { enabled: false });
    await link("Expired candidate", { expired: true });
    await link("Unhealthy candidate", { health: "unavailable" });
    const full = await link("Capacity full", { capacity: 1 });
    await assigned(full.id, { user: otherId });
    const usable = await link("Eligible additional", { capacity: 1 });
    const response = await generate();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().assignment.url).toBe(usable.url);
    const unavailable = await generate();
    expect(unavailable.statusCode, unavailable.body).toBe(503);
    expect(unavailable.json().error.code).toBe("NO_LINK_AVAILABLE");
  });

  it("requires authentication for history and CSRF for additional allocation", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/assignment" })).statusCode,
    ).toBe(401);
    expect((await generate({ cookie: userHeaders.cookie })).statusCode).toBe(
      403,
    );
    await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [
      userId,
    ]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/assignment",
          headers: userHeaders,
        })
      ).statusCode,
    ).toBe(403);
  });
});
