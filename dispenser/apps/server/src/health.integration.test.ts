import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Redis } from "ioredis";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildApp, checkLink } from "./app.js";
import { assertPublicDestination } from "./bulkLinks.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";

vi.mock("./bulkLinks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bulkLinks.js")>()),
  assertPublicDestination: vi.fn(),
}));

const databaseUrl = process.env.TEST_HEALTH_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const healthSettings = {
  enabled: true,
  intervalMinutes: 5,
  timeoutSeconds: 8,
  path: "",
  failureThreshold: 3,
  successThreshold: 2,
  expectedStatuses: [200, 204, 301, 302, 307, 308],
};

integration("database-backed link health checks", () => {
  let pool: Pool;
  let maintenance: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  const schema = `health_test_${randomUUID().replaceAll("-", "")}`;
  const fetchMock = vi.fn<typeof fetch>();
  const destinationMock = vi.mocked(assertPublicDestination);
  const adminCookie = "ald_session=health-admin";
  const userCookie = "ald_session=health-user";

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error("Use a dedicated _test database for health tests");
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
    await pool.query(`
      CREATE FUNCTION reject_health_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced status update failure';
      END;
      $$;
      CREATE TRIGGER reject_health_update BEFORE UPDATE ON links
      FOR EACH ROW WHEN (NEW.name = 'force-update-failure')
      EXECUTE FUNCTION reject_health_update();
    `);
    for (const [role, token] of [
      ["admin", "health-admin"],
      ["user", "health-user"],
    ]) {
      const user = (
        await pool.query(
          "INSERT INTO users(email,normalized_email,role) VALUES($1,$1,$2) RETURNING id",
          [`${role}@health.test`, role],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [
          user,
          hashSecret(token!, config.sessionSecret),
          hashSecret("health-csrf", config.sessionSecret),
        ],
      );
    }
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

  beforeEach(async () => {
    await pool.query("TRUNCATE links CASCADE");
    await pool.query("UPDATE app_settings SET value=$1 WHERE key='health'", [
      JSON.stringify(healthSettings),
    ]);
    destinationMock.mockReset().mockImplementation(async (url) => new URL(url));
    fetchMock.mockReset().mockImplementation(async () => new Response(null));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
    }
  });

  async function createLink(name = "Health fixture") {
    return (
      await pool.query<{ id: string }>(
        "INSERT INTO links(name,url) VALUES($1,$2) RETURNING id",
        [name, `https://health.example/${randomUUID()}?original=1`],
      )
    ).rows[0]!.id;
  }

  async function state(id: string) {
    return (
      await pool.query(
        "SELECT health_status,consecutive_successes,consecutive_failures FROM links WHERE id=$1",
        [id],
      )
    ).rows[0];
  }

  async function history(id: string) {
    return (
      await pool.query(
        "SELECT healthy,status_code,duration_ms,error FROM health_checks WHERE link_id=$1 ORDER BY checked_at,id",
        [id],
      )
    ).rows;
  }

  it("persists degraded then healthy success statuses using the PostgreSQL enum", async () => {
    const id = await createLink();
    for (const [count, healthStatus] of [
      [1, "degraded"],
      [2, "healthy"],
    ] as const) {
      expect(await checkLink(pool, id)).toEqual({
        healthy: true,
        healthStatus,
        statusCode: 200,
        duration: expect.any(Number),
        error: null,
      });
      expect(await state(id)).toEqual({
        health_status: healthStatus,
        consecutive_successes: count,
        consecutive_failures: 0,
      });
      const checks = await history(id);
      expect(checks).toHaveLength(count);
      expect(checks[count - 1]).toEqual({
        healthy: true,
        status_code: 200,
        duration_ms: expect.any(Number),
        error: null,
      });
      expect(checks[count - 1].duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("reaches unavailable after consecutive failures and recovers at the success threshold", async () => {
    const id = await createLink();
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 503 }),
    );
    for (let count = 1; count <= healthSettings.failureThreshold; count++) {
      const healthStatus = count < 3 ? "degraded" : "unavailable";
      expect(await checkLink(pool, id)).toMatchObject({
        healthy: false,
        statusCode: 503,
        healthStatus,
        error: null,
      });
      expect(await state(id)).toEqual({
        health_status: healthStatus,
        consecutive_successes: 0,
        consecutive_failures: count,
      });
    }
    expect(await history(id)).toHaveLength(3);
    expect((await history(id)).every((row) => row.status_code === 503)).toBe(
      true,
    );
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 204 }),
    );
    for (const [count, healthStatus] of [
      [1, "degraded"],
      [2, "healthy"],
    ] as const) {
      expect(await checkLink(pool, id)).toMatchObject({
        healthy: true,
        statusCode: 204,
        healthStatus,
      });
      expect(await state(id)).toEqual({
        health_status: healthStatus,
        consecutive_successes: count,
        consecutive_failures: 0,
      });
    }
    expect(await history(id)).toHaveLength(5);
  });

  it("uses configured path/statuses and falls back from HEAD 405 to GET, cancelling the body", async () => {
    const id = await createLink();
    await pool.query("UPDATE app_settings SET value=$1 WHERE key='health'", [
      JSON.stringify({
        ...healthSettings,
        path: "ready",
        expectedStatuses: [202],
      }),
    ]);
    const getResponse = new Response("fixture", { status: 202 });
    const cancel = vi.spyOn(getResponse.body!, "cancel");
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(getResponse);
    expect(await checkLink(pool, id)).toMatchObject({
      healthy: true,
      healthStatus: "degraded",
      statusCode: 202,
      error: null,
    });
    expect(destinationMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [index, method] of ["HEAD", "GET"].entries()) {
      const [url, options] = fetchMock.mock.calls[index]!;
      expect(String(url)).toBe("https://health.example/ready");
      expect(options).toMatchObject({ method, redirect: "manual" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(await history(id)).toHaveLength(1);
  });

  it.each(["fetch", "destination"] as const)(
    "records a %s exception as an unhealthy result without losing its error",
    async (source) => {
      const id = await createLink();
      const error = new Error(`${source} fixture failure`);
      if (source === "fetch") fetchMock.mockRejectedValueOnce(error);
      else destinationMock.mockRejectedValueOnce(error);
      expect(await checkLink(pool, id)).toMatchObject({
        healthy: false,
        healthStatus: "degraded",
        statusCode: null,
        error: error.message,
      });
      expect(await state(id)).toEqual({
        health_status: "degraded",
        consecutive_successes: 0,
        consecutive_failures: 1,
      });
      expect(await history(id)).toEqual([
        {
          healthy: false,
          status_code: null,
          duration_ms: expect.any(Number),
          error: error.message,
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(source === "fetch" ? 1 : 0);
    },
  );

  it.each([200, 503])(
    "rolls back the check log and counters if the %s status update fails",
    async (status) => {
      const id = await createLink("force-update-failure");
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      const before = await state(id);
      let failure: unknown;
      try {
        await checkLink(pool, id);
      } catch (error) {
        failure = error;
      }
      expect.soft(await history(id)).toEqual([]);
      expect.soft(await state(id)).toEqual(before);
      expect(failure).toMatchObject({
        code: "P0001",
        message: "forced status update failure",
      });
      expect((await pool.query("SELECT 1 AS ready")).rows[0]).toEqual({
        ready: 1,
      });
    },
  );

  it.each([200, 503])(
    "preserves a link disabled while its %s request is in flight",
    async (status) => {
      const id = await createLink();
      fetchMock.mockImplementationOnce(async () => {
        await pool.query(
          "UPDATE links SET enabled=false,health_status='disabled' WHERE id=$1",
          [id],
        );
        return new Response(null, { status });
      });
      expect(await checkLink(pool, id)).toMatchObject({
        healthy: status === 200,
        healthStatus: "disabled",
        statusCode: status,
        error: null,
      });
      expect(await state(id)).toEqual({
        health_status: "disabled",
        consecutive_successes: status === 200 ? 1 : 0,
        consecutive_failures: status === 503 ? 1 : 0,
      });
      expect(
        (await pool.query("SELECT enabled FROM links WHERE id=$1", [id]))
          .rows[0],
      ).toEqual({ enabled: false });
      expect(await history(id)).toEqual([
        {
          healthy: status === 200,
          status_code: status,
          duration_ms: expect.any(Number),
          error: null,
        },
      ]);
    },
  );

  it("returns the persisted health status through the authenticated check endpoint", async () => {
    const id = await createLink();
    for (const healthStatus of ["degraded", "healthy"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/links/${id}/check`,
        headers: { cookie: adminCookie, "x-csrf-token": "health-csrf" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        healthy: true,
        healthStatus,
        statusCode: 200,
        duration: expect.any(Number),
        error: null,
      });
      expect((await state(id)).health_status).toBe(healthStatus);
    }
    expect(await history(id)).toHaveLength(2);
  });

  it.each([
    ["missing session", "", "health-csrf", 401, "UNAUTHORIZED"],
    ["non-admin", userCookie, "health-csrf", 403, "FORBIDDEN"],
    ["missing CSRF", adminCookie, "", 403, "FORBIDDEN"],
    ["incorrect CSRF", adminCookie, "incorrect", 403, "FORBIDDEN"],
  ])(
    "rejects %s without fetching or writing a check",
    async (_label, cookie, csrf, status, code) => {
      const id = await createLink();
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/links/${id}/check`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(destinationMock).not.toHaveBeenCalled();
      expect(await history(id)).toEqual([]);
      expect((await state(id)).health_status).toBe("unknown");
    },
  );

  it("returns LINK_UNAVAILABLE for a missing link before fetching", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/links/${randomUUID()}/check`,
      headers: { cookie: adminCookie, "x-csrf-token": "health-csrf" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "LINK_UNAVAILABLE", message: "Link not found." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(destinationMock).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM health_checks"))
        .rows[0].count,
    ).toBe(0);
  });
});
