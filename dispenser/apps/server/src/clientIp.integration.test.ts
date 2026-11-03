import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import type { DriveVerificationProvider } from "./googleDrive.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl ? describe : describe.skip;
const caddy = "172.18.0.3";

class DriveFixture implements DriveVerificationProvider {
  codes = new Map<string, string>();
  async createVerificationFile(email: string, code: string) {
    this.codes.set(email, code);
    return {
      fileId: `fixture-${randomUUID()}`,
      permissionId: `permission-${randomUUID()}`,
      url: "https://drive.google.com/file/d/local-fixture/view",
    };
  }
  async removeVerificationFile() {}
  async testConnection() {
    return "Local fixture only.";
  }
}

integration("trusted edge client IP persistence and rate limits", () => {
  let maintenance: Pool;
  let pool: Pool;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let originalTrustedProxyCidrs: typeof config.trustedProxyCidrs;
  const schema = `client_ip_test_${randomUUID().replaceAll("-", "")}`;
  const prefix = `${randomUUID()}:`;
  const drive = new DriveFixture();

  async function clearRedis() {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length)
      await redis.del(...keys.map((name) => name.slice(prefix.length)));
  }

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error("Client IP tests require a dedicated _test database.");
    if (!new URL(redisUrl!).pathname.match(/^\/(?:1[0-5]|[1-9])$/))
      throw new Error("Client IP tests require a non-default Redis database.");
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
    redis = new Redis(redisUrl!, { keyPrefix: prefix });
    originalTrustedProxyCidrs = config.trustedProxyCidrs;
    config.trustedProxyCidrs = ["127.0.0.1/32", "::1/128", `${caddy}/32`];
    app = (
      await buildApp({
        pool,
        redis,
        drive,
        checkMailFetch: async () => {
          throw new Error("Client IP tests must not call external providers.");
        },
      })
    ).app;
    // This route exists only in the fixture, never in the shipped application.
    app.get("/fixture/client-ip", (request) => ({ ip: request.ip }));
    await app.ready();
  });

  beforeEach(async () => {
    await clearRedis();
    drive.codes.clear();
    await pool.query("TRUNCATE verifications,denied_email_logins,audit_events");
    // DELETE honors ON DELETE SET NULL on settings; TRUNCATE CASCADE would
    // discard those configuration rows even when updated_by is already null.
    await pool.query("DELETE FROM users");
    await pool.query("DELETE FROM email_rules");
    await pool.query(
      "UPDATE app_settings SET value=$1::jsonb WHERE key='registration'",
      [JSON.stringify({ defaultMode: "allow", rateLimitPerHour: 5 })],
    );
  });

  afterAll(async () => {
    await app?.close();
    if (originalTrustedProxyCidrs)
      config.trustedProxyCidrs = originalTrustedProxyCidrs;
    if (redis) {
      await clearRedis();
      await redis.quit();
    }
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
    }
  });

  async function requestVerification(
    email: string,
    ip: string,
    remoteAddress = caddy,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/auth/request",
      remoteAddress,
      headers: { "x-forwarded-for": ip },
      payload: { email },
    });
  }

  it.each(["198.51.100.24", "2001:db8:1234::9"])(
    "persists canonical viewer %s for verification requests and signed-in sessions",
    async (viewer) => {
      const email = "viewer@client-ip.example";
      const response = await requestVerification(email, viewer);
      expect(response.statusCode).toBe(200);
      const id = response.json().verificationId;
      expect(
        (
          await pool.query("SELECT request_ip FROM verifications WHERE id=$1", [
            id,
          ])
        ).rows,
      ).toEqual([{ request_ip: viewer }]);
      const verified = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        remoteAddress: caddy,
        headers: { "x-forwarded-for": viewer },
        payload: { verificationId: id, code: drive.codes.get(email) },
      });
      expect(verified.statusCode).toBe(200);
      expect((await pool.query("SELECT ip FROM sessions")).rows).toEqual([
        { ip: viewer },
      ]);
      expect(await redis.get(`rate:verify-ip:${viewer}`)).toBe("1");
      expect(await redis.get(`rate:code-ip:${viewer}`)).toBe("1");
      expect(await redis.get(`rate:verify-ip:${caddy}`)).toBeNull();
    },
  );

  it("records the viewer in denied email logins rather than the shared edge", async () => {
    await pool.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{defaultMode}','\"deny\"') WHERE key='registration'",
    );
    const viewer = "203.0.113.35";
    const response = await requestVerification(
      "denied@client-ip.example",
      viewer,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("EMAIL_NOT_ALLOWED");
    expect(
      (await pool.query("SELECT request_ip FROM denied_email_logins")).rows,
    ).toEqual([{ request_ip: viewer }]);
    expect(drive.codes.size).toBe(0);
  });

  it("records the viewer in administrator recovery sessions and audit metadata", async () => {
    await pool.query(
      "INSERT INTO users(email,normalized_email,role,verified_at) VALUES($1,$1,'admin',now())",
      [config.bootstrapEmail],
    );
    const viewer = "2001:db8:abcd::50";
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/recover",
      remoteAddress: caddy,
      headers: { "x-forwarded-for": viewer },
      payload: { email: config.bootstrapEmail, token: config.bootstrapToken },
    });
    expect(response.statusCode).toBe(200);
    expect((await pool.query("SELECT ip FROM sessions")).rows).toEqual([
      { ip: viewer },
    ]);
    expect(
      (
        await pool.query(
          "SELECT after FROM audit_events WHERE action='admin.recover'",
        )
      ).rows,
    ).toEqual([{ after: { ip: viewer } }]);
  });

  it.each(["203.0.113.61", "2001:db8:feed::61"])(
    "ignores spoofed forwarding and viewer headers from untrusted direct peer %s",
    async (peer) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/request",
        remoteAddress: peer,
        headers: {
          "x-forwarded-for": "198.51.100.99, 198.51.100.100",
          "cloudfront-viewer-address": "198.51.100.101:54321",
          "x-real-ip": "198.51.100.102",
        },
        payload: { email: "direct@client-ip.example" },
      });
      expect(response.statusCode).toBe(200);
      expect(
        (await pool.query("SELECT request_ip FROM verifications")).rows,
      ).toEqual([{ request_ip: peer }]);
      expect(await redis.get(`rate:verify-ip:${peer}`)).toBe("1");
      expect(await redis.get("rate:verify-ip:198.51.100.99")).toBeNull();
    },
  );

  it("stops at the closest untrusted hop instead of accepting a forged leading XFF", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/fixture/client-ip",
      remoteAddress: caddy,
      headers: { "x-forwarded-for": "192.0.2.200, 198.51.100.71" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: "198.51.100.71" });
  });

  it("falls back to the direct peer without using a CloudFront viewer header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/fixture/client-ip",
      remoteAddress: caddy,
      headers: { "cloudfront-viewer-address": "198.51.100.99:54321" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: caddy });
  });

  it.each(["not-an-ip", "198.51.100.92:54321", "[2001:db8::92]:54321"])(
    "rejects malformed trusted forwarding value %s before storage or rate limits",
    async (value) => {
      const response = await requestVerification(
        "invalid@client-ip.example",
        value,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_CLIENT_ADDRESS");
      expect(
        (await pool.query("SELECT count(*)::int count FROM verifications"))
          .rows[0].count,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM denied_email_logins",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(await redis.keys(`${prefix}rate:*`)).toEqual([]);
      expect(drive.codes.size).toBe(0);
    },
  );

  it("keeps different viewers behind one edge in separate verification rate limits", async () => {
    const first = "198.51.100.81";
    const second = "198.51.100.82";
    for (let i = 0; i < 10; i++) {
      expect(
        (await requestVerification(`first-${i}@client-ip.example`, first))
          .statusCode,
      ).toBe(200);
    }
    const limited = await requestVerification(
      "first-limited@client-ip.example",
      first,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("VERIFICATION_RATE_LIMITED");
    expect(
      (await requestVerification("second@client-ip.example", second))
        .statusCode,
    ).toBe(200);
    expect(await redis.get(`rate:verify-ip:${first}`)).toBe("11");
    expect(await redis.get(`rate:verify-ip:${second}`)).toBe("1");
    expect(await redis.get(`rate:verify-ip:${caddy}`)).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::int count FROM verifications"))
        .rows[0].count,
    ).toBe(11);
    expect(drive.codes.size).toBe(11);
  });
});
