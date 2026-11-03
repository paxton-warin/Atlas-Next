import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";

const databaseUrl = process.env.TEST_PAGINATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("database-backed admin pagination", () => {
  let pool: Pool;
  let maintenance: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  const schema = `pagination_test_${randomUUID().replaceAll("-", "")}`;
  const adminCookie = "ald_session=pagination-admin";
  const userCookie = "ald_session=pagination-user";
  let targetId: string;
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error("Use a dedicated _test database for pagination tests");
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
    const admin = (
      await pool.query(
        "INSERT INTO users(email,normalized_email,role) VALUES('admin@pagination.test','admin@pagination.test','admin') RETURNING id",
      )
    ).rows[0].id;
    targetId = (
      await pool.query(
        "INSERT INTO users(email,normalized_email) VALUES('target@pagination.test','target@pagination.test') RETURNING id",
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO users(email,normalized_email,status,created_at) SELECT 'person-'||lpad(i::text,3,'0')||'@pagination.test','person-'||lpad(i::text,3,'0')||'@pagination.test',CASE WHEN i<=130 THEN 'suspended'::user_status ELSE 'active'::user_status END,'2026-01-01'::timestamptz FROM generate_series(1,300) i",
    );
    for (const [user, token] of [
      [admin, "pagination-admin"],
      [targetId, "pagination-user"],
    ])
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [
          user,
          hashSecret(token, config.sessionSecret),
          hashSecret("csrf", config.sessionSecret),
        ],
      );
    await pool.query(
      "INSERT INTO links(name,url,enabled,health_status,created_at) SELECT 'Fixture '||lpad(i::text,3,'0'),'https://fixture-'||i||'.example',i>130,CASE WHEN i<=130 THEN 'disabled'::health_status ELSE 'healthy'::health_status END,'2026-01-01'::timestamptz FROM generate_series(1,551) i",
    );
    await pool.query(
      "INSERT INTO verifications(email,code_hash,expires_at,max_attempts,created_at) SELECT 'target@pagination.test','fixture',now()+interval '1 day',5,'2026-01-01'::timestamptz FROM generate_series(1,551)",
    );
    await pool.query(
      "INSERT INTO email_rules(kind,action,pattern,priority,created_at) SELECT 'domain','deny','fixture-'||i||'.test',1,'2026-01-01'::timestamptz FROM generate_series(1,551) i",
    );
    await pool.query(
      "INSERT INTO denied_email_logins(email,decision_source,created_at) SELECT 'denied-'||lpad(i::text,3,'0')||'@pagination.test','default','2026-01-01'::timestamptz FROM generate_series(1,551) i",
    );
    await pool.query(
      "INSERT INTO audit_events(admin_id,action,target_type,target_id,created_at) SELECT $1,'fixture','link',i::text,'2026-01-01'::timestamptz FROM generate_series(1,551) i",
      [admin],
    );
    await pool.query(
      "INSERT INTO link_assignments(user_id,link_id,active,assigned_at) SELECT $1,id,false,'2026-01-01'::timestamptz FROM links",
      [targetId],
    );
    await pool.query(
      "INSERT INTO reports(user_id,assignment_id,link_id,category,created_at) SELECT user_id,id,link_id,'other','2026-01-01'::timestamptz FROM link_assignments",
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at,created_at) SELECT $1,'fixture-'||i,'fixture',now()-interval '1 day','2026-01-01'::timestamptz FROM generate_series(1,551) i",
      [targetId],
    );
    app = (
      await buildApp({
        pool,
        redis: { status: "ready" } as Redis,
        drive: {
          async createVerificationFile() {
            return {
              fileId: "fixture",
              permissionId: "fixture",
              url: "https://example.com",
            };
          },
          async removeVerificationFile() {},
          async testConnection() {
            return "fixture";
          },
        },
      })
    ).app;
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
    }
  });
  async function get(path: string, cookie = adminCookie) {
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/${path}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  it("reaches users after the former 250 cap with stable tied timestamps", async () => {
    const first = await get("users?page=1&pageSize=100");
    const second = await get("users?page=2&pageSize=100");
    const third = await get("users?page=3&pageSize=100");
    const fourth = await get("users?page=4&pageSize=100");
    expect(first.pagination).toEqual({
      page: 1,
      pageSize: 100,
      total: 302,
      totalPages: 4,
    });
    const ids = [
      ...first.users,
      ...second.users,
      ...third.users,
      ...fourth.users,
    ].map((row: { id: string }) => row.id);
    expect(ids).toHaveLength(302);
    expect(new Set(ids).size).toBe(302);
    expect((await get("users?page=2&pageSize=100")).users).toEqual(
      second.users,
    );
  });
  it("filters before counting and paging users and links", async () => {
    const users = await get(
      "users?q=person-&status=suspended&page=2&pageSize=100",
    );
    expect(users.pagination).toEqual({
      page: 2,
      pageSize: 100,
      total: 130,
      totalPages: 2,
    });
    expect(users.users).toHaveLength(30);
    expect(
      users.users.every(
        (row: { status: string }) => row.status === "suspended",
      ),
    ).toBe(true);
    const links = await get(
      "links?q=Fixture&status=disabled&page=2&pageSize=100",
    );
    expect(links.pagination.total).toBe(130);
    expect(links.links).toHaveLength(30);
    expect(
      links.links.every((row: { enabled: boolean }) => row.enabled === false),
    ).toBe(true);
  });
  it.each([
    ["links", "links"],
    ["email-rules", "rules"],
    ["reports", "reports"],
    ["verifications", "verifications"],
    ["denied-email-logins", "items"],
    ["audit", "events"],
  ])("reaches %s records beyond 500", async (path, key) => {
    const result = await get(`${path}?page=6&pageSize=100`);
    expect(result.pagination).toEqual({
      page: 6,
      pageSize: 100,
      total: 551,
      totalPages: 6,
    });
    expect(result[key]).toHaveLength(51);
    const first = await get(`${path}?page=1&pageSize=100`);
    expect(
      result[key].some((row: { id: string }) =>
        first[key].some((other: { id: string }) => other.id === row.id),
      ),
    ).toBe(false);
  });
  it("retains the full unpaginated links snapshot for the replacement helper", async () => {
    const result = await get("links");
    expect(result.links).toHaveLength(551);
    expect(result.pagination).toBeUndefined();
  });
  it("filters denied email logins before computing page totals", async () => {
    const result = await get(
      "denied-email-logins?q=denied-1&page=2&pageSize=50",
    );
    expect(result.pagination.total).toBe(100);
    expect(result.items).toHaveLength(50);
  });
  it("returns full user activity counts and paginated activity without secret session tokens", async () => {
    const result = await get(`users/${targetId}`);
    expect(result.counts).toEqual({
      assignments: 551,
      reports: 551,
      verifications: 551,
      sessions: 552,
    });
    for (const kind of [
      "assignments",
      "reports",
      "verifications",
      "sessions",
    ]) {
      const page = await get(
        `users/${targetId}/activity?kind=${kind}&page=6&pageSize=100`,
      );
      expect(page.pagination.total).toBe(kind === "sessions" ? 552 : 551);
      expect(page.items).toHaveLength(kind === "sessions" ? 52 : 51);
      expect(
        page.items.every(
          (row: Record<string, unknown>) =>
            !("token_hash" in row) &&
            !("csrf_hash" in row) &&
            !("code_hash" in row),
        ),
      ).toBe(true);
    }
  });
  it("clamps an empty final page after deletion", async () => {
    const before = await get("denied-email-logins?page=6&pageSize=100");
    await pool.query(
      "DELETE FROM denied_email_logins WHERE id=ANY($1::uuid[])",
      [before.items.map((row: { id: string }) => row.id)],
    );
    const after = await get("denied-email-logins?page=6&pageSize=100");
    expect(after.pagination).toEqual({
      page: 5,
      pageSize: 100,
      total: 500,
      totalPages: 5,
    });
    expect(after.items).toHaveLength(100);
  });
  it.each([
    "users?page=0",
    "users?pageSize=101",
    "links?page=1.5",
    "reports?page=-1",
    "audit?pageSize=0",
    "email-rules?page=1&page=2",
    "verifications?page=9007199254740992",
    "users?status=bogus",
    "links?status=bogus",
  ])("rejects invalid parameters for %s", async (path) => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/${path}`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(400);
  });
  it.each([
    "users",
    "links",
    "email-rules",
    "reports",
    "verifications",
    "denied-email-logins",
    "audit",
  ])("requires administrator authorization for %s", async (path) => {
    expect(
      (await app.inject({ method: "GET", url: `/api/admin/${path}?page=2` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/${path}?page=2`,
          headers: { cookie: userCookie },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("requires admin access, valid kind, and a real user for activity", async () => {
    const url = `/api/admin/users/${targetId}/activity?kind=sessions&page=2`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { cookie: userCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/users/${targetId}/activity?kind=secrets`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/users/${randomUUID()}/activity?kind=sessions`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(404);
  });
});
