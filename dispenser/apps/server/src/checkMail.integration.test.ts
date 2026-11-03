import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import type { DriveVerificationProvider } from "./googleDrive.js";
import { hashSecret } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl ? describe : describe.skip;
const key = "integration-check-mail-secret-never-return-this";

class DriveFixture implements DriveVerificationProvider {
  codes = new Map<string, string>();
  calls: string[] = [];
  async createVerificationFile(email: string, code: string) {
    this.codes.set(email, code);
    this.calls.push(email);
    return {
      fileId: `fixture-${randomUUID()}`,
      permissionId: `permission-${randomUUID()}`,
      url: "https://drive.google.com/file/d/local-fixture/view",
    };
  }
  async removeVerificationFile() {}
  async testConnection() {
    return "Local Drive fixture only.";
  }
}

integration("Check-Mail registration and administrator integration", () => {
  let maintenance: Pool;
  let pool: Pool;
  let secondPool: Pool;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let secondApp: Awaited<ReturnType<typeof buildApp>>["app"];
  const schema = `check_mail_test_${randomUUID().replaceAll("-", "")}`;
  const prefix = randomUUID();
  const drive = new DriveFixture();
  const providerCalls: { email: string; url: string; authorization: string }[] =
    [];
  let providerResponse: (email: string) => Promise<Response>;
  const adminCookie = `ald_session=${prefix}-admin`;
  const userCookie = `ald_session=${prefix}-user`;
  const csrfToken = `${prefix}-csrf`;
  const headers = { cookie: adminCookie, "x-csrf-token": csrfToken };
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = String(input);
    const email = new URLSearchParams(String(init?.body ?? "")).get("email");
    expect(url).toBe("https://api.check-mail.org/v2/");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get("authorization")).toBe(`Bearer ${key}`);
    expect(requestHeaders.get("content-type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(email).toBeTruthy();
    providerCalls.push({
      email: email!,
      url,
      authorization: requestHeaders.get("authorization")!,
    });
    return providerResponse(email!);
  };
  const allowed = (email: string) =>
    new Response(
      JSON.stringify({
        valid: true,
        block: false,
        is_disposable: false,
        domain: email.split("@")[1],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-requests-remaining": "999",
        },
      },
    );
  const rejected = (email: string) =>
    new Response(
      JSON.stringify({
        valid: true,
        block: true,
        is_disposable: true,
        domain: email.split("@")[1],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error("Check-Mail tests require a dedicated _test database.");
    if (!new URL(redisUrl!).pathname.match(/^\/(?:1[0-5]|[1-9])$/))
      throw new Error("Check-Mail tests require a non-default Redis database.");
    maintenance = new Pool({ connectionString: databaseUrl });
    await maintenance.query(`CREATE SCHEMA ${schema}`);
    const connection = {
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    };
    pool = new Pool(connection);
    secondPool = new Pool(connection);
    const migrationDir = resolve(
      import.meta.dirname,
      "../../../packages/database/migrations",
    );
    for (const name of (await readdir(migrationDir))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(resolve(migrationDir, name), "utf8"));
    redis = new Redis(redisUrl!, { keyPrefix: `${prefix}:` });
    for (const [role, email, token] of [
      ["admin", "admin@integration.example", `${prefix}-admin`],
      ["user", "returning@integration.example", `${prefix}-user`],
    ]) {
      const user = (
        await pool.query<{ id: string }>(
          "INSERT INTO users(email,normalized_email,role,verified_at) VALUES($1,$1,$2::role,now()) RETURNING id",
          [email, role],
        )
      ).rows[0]!;
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [
          user.id,
          hashSecret(token!, config.sessionSecret),
          hashSecret(csrfToken, config.sessionSecret),
        ],
      );
    }
    app = (await buildApp({ pool, redis, drive, checkMailFetch: fetchFixture }))
      .app;
    secondApp = (
      await buildApp({
        pool: secondPool,
        redis,
        drive,
        checkMailFetch: fetchFixture,
      })
    ).app;
    await Promise.all([app.ready(), secondApp.ready()]);
  });
  beforeEach(async () => {
    providerCalls.length = 0;
    drive.calls.length = 0;
    drive.codes.clear();
    providerResponse = async (email) => allowed(email);
    await pool.query(
      "TRUNCATE check_mail_attempts,check_mail_cache,check_mail_allowlist,verifications RESTART IDENTITY CASCADE",
    );
    await pool.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{rateLimitPerHour}','1000') WHERE key='registration'",
    );
    await pool.query("DELETE FROM email_rules");
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/check-mail",
      headers,
      payload: { enabled: true, apiKey: key, monthlyLimit: 1000 },
    });
    expect(response.statusCode, response.body).toBe(200);
  });
  afterAll(async () => {
    await secondApp?.close();
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${prefix}:*`);
      // ioredis prefixes DEL arguments; strip the prefix returned by KEYS.
      if (keys.length)
        await redis.del(...keys.map((name) => name.slice(prefix.length + 1)));
      await redis.quit();
    }
    await secondPool?.end();
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
    }
  });

  async function request(email: string, target = app) {
    return target.inject({
      method: "POST",
      url: "/api/auth/request",
      remoteAddress: "127.0.0.42",
      payload: { email },
    });
  }
  async function verify(
    response: Awaited<ReturnType<typeof request>>,
    email: string,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        verificationId: response.json().verificationId,
        code: drive.codes.get(email),
      },
    });
  }
  async function configure(payload: Record<string, unknown>) {
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/check-mail",
      headers,
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  }
  async function allowlist(
    kind: "exact" | "domain" | "regex",
    pattern: string,
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/check-mail/allowlist",
      headers,
      payload: { kind, pattern, enabled: true, note: "Integration fixture" },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  }

  it("requires administrator sessions and CSRF for configuration", async () => {
    for (const cookie of ["", userCookie]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/check-mail",
        headers: { cookie },
      });
      expect([401, 403]).toContain(response.statusCode);
    }
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/check-mail",
      headers: { cookie: adminCookie },
      payload: { apiKey: "unauthorized-key", enabled: true },
    });
    expect(response.statusCode).toBe(403);
    expect(providerCalls).toHaveLength(0);
  });

  it("encrypts the key outside generic settings and excludes it from responses and audits", async () => {
    const stored = (
      await pool.query<{ encrypted_api_key: string }>(
        "SELECT encrypted_api_key FROM check_mail_settings",
      )
    ).rows[0]!.encrypted_api_key;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(key);
    const publicSettings = await pool.query(
      "SELECT key,value FROM app_settings",
    );
    expect(JSON.stringify(publicSettings.rows)).not.toContain(key);
    expect(JSON.stringify(publicSettings.rows)).not.toContain(stored);
    for (const url of [
      "/api/admin/check-mail",
      "/api/admin/settings",
      "/api/admin/audit",
    ]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(key);
      expect(response.body).not.toContain(stored);
    }
  });

  it("never checks a returning account during request or verification", async () => {
    providerResponse = async () => {
      throw new Error("Returning users must not contact Check-Mail.");
    };
    const response = await request("  RETURNING@integration.example  ");
    expect(response.statusCode, response.body).toBe(200);
    const result = await verify(response, "returning@integration.example");
    expect(result.statusCode, result.body).toBe(200);
    expect(providerCalls).toHaveLength(0);
    expect(drive.calls).toEqual(["returning@integration.example"]);
  });

  it("checks a new account once before Drive and reuses the verdict at verification", async () => {
    const email = "new-allowed@integration.example";
    providerResponse = async (email) => {
      expect(drive.calls).toHaveLength(0);
      return allowed(email);
    };
    const response = await request(email);
    expect(response.statusCode, response.body).toBe(200);
    expect(providerCalls).toHaveLength(1);
    const verified = await verify(response, email);
    expect(verified.statusCode, verified.body).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(
      (
        await pool.query("SELECT id FROM users WHERE normalized_email=$1", [
          email,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it.each([
    ["domain", "fcpsschools.net", "student@fcpsschools.net"],
    ["exact", "trusted@integration.example", "trusted@integration.example"],
    ["regex", "^student[0-9]+@school\\.example$", "student12@school.example"],
  ] as const)(
    "bypasses Check-Mail for a local %s allowlist match",
    async (kind, pattern, email) => {
      await allowlist(kind, pattern);
      const tested = await app.inject({
        method: "POST",
        url: "/api/admin/check-mail/test",
        headers,
        payload: { email },
      });
      expect(tested.statusCode, tested.body).toBe(200);
      const response = await request(email);
      expect(response.statusCode, response.body).toBe(200);
      expect((await verify(response, email)).statusCode).toBe(200);
      expect(providerCalls).toHaveLength(0);
    },
  );

  it("does not treat an unrelated or suffix-spoofed domain as an allowlist match", async () => {
    await allowlist("domain", "fcpsschools.net");
    const response = await request("student@notfcpsschools.net");
    expect(response.statusCode, response.body).toBe(200);
    expect(providerCalls).toHaveLength(1);
  });

  it("updates, disables, deletes, and locally tests whitelist rules without provider calls", async () => {
    const created = await allowlist("domain", "school.example");
    const id = created.json().id;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/admin/check-mail/allowlist/${id}`,
      headers,
      payload: {
        kind: "exact",
        pattern: "changed@school.example",
        enabled: false,
        note: "Disabled fixture",
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/check-mail/test",
      headers,
      payload: { email: "changed@school.example" },
    });
    expect(tested.statusCode, tested.body).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/check-mail/allowlist/${id}`,
      headers,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/check-mail",
      headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(JSON.stringify(list.json().allowlist)).not.toContain(id);
    expect(providerCalls).toHaveLength(0);
  });

  it("rejects unsafe regex and malformed domain whitelist rules without quota", async () => {
    for (const rule of [
      { kind: "regex", pattern: "(a+)+$" },
      { kind: "domain", pattern: "https://school.example" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/check-mail/allowlist",
        headers,
        payload: rule,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("rejects malformed whitelist IDs before database operations", async () => {
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/api/admin/check-mail/allowlist/not-a-uuid",
        headers,
        ...(method === "PUT"
          ? { payload: { kind: "domain", pattern: "school.example" } }
          : {}),
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("keeps registration denial authoritative over the Check-Mail allowlist", async () => {
    const email = "denied@fcpsschools.net";
    await allowlist("domain", "fcpsschools.net");
    await pool.query(
      "INSERT INTO email_rules(kind,action,pattern,priority) VALUES('exact','deny',$1,100)",
      [email],
    );
    const response = await request(email);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("EMAIL_NOT_ALLOWED");
    expect(providerCalls).toHaveLength(0);
    expect(drive.calls).toHaveLength(0);
  });

  it("applies rate limits and pending-verification cooldown before provider quota", async () => {
    const rateEmail = "rate-limited@integration.example";
    await redis.set(`rate:verify-email:${rateEmail}`, "1000", "EX", 3600);
    expect((await request(rateEmail)).statusCode).toBe(429);
    const cooldownEmail = "cooldown@integration.example";
    await pool.query(
      "INSERT INTO verifications(email,code_hash,expires_at,max_attempts) VALUES($1,'fixture',now()+interval '10 minutes',5)",
      [cooldownEmail],
    );
    expect((await request(cooldownEmail)).statusCode).toBe(429);
    expect(providerCalls).toHaveLength(0);
    expect(drive.calls).toHaveLength(0);
  });

  it("blocks disposable accounts before Drive and caches the rejection", async () => {
    providerResponse = async (email) => rejected(email);
    const email = "blocked@integration.example";
    for (let i = 0; i < 2; i++) {
      const response = await request(email);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe("CHECK_MAIL_REJECTED");
    }
    expect(providerCalls).toHaveLength(1);
    expect(drive.calls).toHaveLength(0);
    expect(
      (await pool.query("SELECT id FROM verifications WHERE email=$1", [email]))
        .rowCount,
    ).toBe(0);
  });

  it("checks an old pending verification before it can create a new account", async () => {
    await configure({ enabled: false });
    const email = "old-pending@integration.example";
    const response = await request(email);
    expect(response.statusCode, response.body).toBe(200);
    await configure({ enabled: true });
    providerResponse = async (email) => rejected(email);
    const result = await verify(response, email);
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().error.code).toBe("CHECK_MAIL_REJECTED");
    expect(providerCalls).toHaveLength(1);
    expect(
      (
        await pool.query("SELECT id FROM users WHERE normalized_email=$1", [
          email,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("deduplicates simultaneous normalized-email requests across application instances", async () => {
    providerResponse = async (email) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return allowed(email);
    };
    const responses = await Promise.all([
      request("parallel@integration.example"),
      request(" PARALLEL@integration.example ", secondApp),
    ]);
    expect(responses.some((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(
      responses.every((response) =>
        [200, 429, 503].includes(response.statusCode),
      ),
    ).toBe(true);
    expect(providerCalls).toHaveLength(1);
  });

  it("reserves the local monthly budget atomically across application instances", async () => {
    await configure({ monthlyLimit: 1 });
    providerResponse = async (email) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return allowed(email);
    };
    const responses = await Promise.all([
      request("quota-one@integration.example"),
      request("quota-two@integration.example", secondApp),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 503,
    ]);
    expect(providerCalls).toHaveLength(1);
    expect(drive.calls).toHaveLength(1);
  });

  it("verifies ten first accounts without starving the PostgreSQL connection pool", async () => {
    const parallelPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 1,
    });
    // A single available connection makes a nested second pool acquisition
    // fail deterministically, without an artificial transaction barrier.
    const parallelApp = (
      await buildApp({
        pool: parallelPool,
        redis,
        drive,
        checkMailFetch: fetchFixture,
      })
    ).app;
    await parallelApp.ready();
    const emails = Array.from(
      { length: 10 },
      (_, index) => `pool-account-${index}@integration.example`,
    );
    const responses = await Promise.all(
      emails.map((email) => request(email, parallelApp)),
    );
    responses.forEach((response) =>
      expect(response.statusCode, response.body).toBe(200),
    );
    expect(providerCalls).toHaveLength(10);
    const verifications = responses.map((response, index) =>
      parallelApp.inject({
        method: "POST",
        url: "/api/auth/verify",
        remoteAddress: "127.0.0.43",
        payload: {
          verificationId: response.json().verificationId,
          code: drive.codes.get(emails[index]!),
        },
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    try {
      const result = await Promise.race([
        Promise.all(verifications).then((value) => {
          completed = true;
          return value;
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 2_000);
        }),
      ]);
      expect(
        result,
        "Valid first-account verifications must not exhaust their own connection pool.",
      ).not.toBeNull();
      result!.forEach((response) =>
        expect(response.statusCode, response.body).toBe(200),
      );
      expect(providerCalls).toHaveLength(10);
    } finally {
      if (timer) clearTimeout(timer);
      if (!completed) {
        // Rescue only the independent test pool so a failing regression leaves
        // no permanently blocked requests or database connections behind.
        parallelPool.options.max = 30;
        const rescue = await Promise.all(
          Array.from({ length: 10 }, () => parallelPool.connect()),
        );
        rescue.forEach((client) => client.release());
      }
      await Promise.allSettled(verifications);
      await parallelApp.close();
      await parallelPool.end();
    }
  });

  it.each(["outage", "malformed", "provider-limit"])(
    "fails closed for provider %s without leaking keys or consuming retries",
    async (mode) => {
      providerResponse = async () => {
        if (mode === "outage")
          throw new Error(`Untrusted provider error ${key}`);
        if (mode === "provider-limit")
          return new Response("limited", { status: 429 });
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      };
      const email = `${mode}@integration.example`;
      const response = await request(email);
      expect(response.statusCode, response.body).toBe(503);
      expect(response.body).not.toContain(key);
      expect(drive.calls).toHaveLength(0);
      const retry = await request(email);
      expect(retry.statusCode).toBe(503);
      expect(providerCalls).toHaveLength(1);
    },
  );

  it("clears the stored credential and disables checking through the administrator API", async () => {
    await configure({ clearApiKey: true, enabled: false });
    const stored = (
      await pool.query(
        "SELECT encrypted_api_key,enabled FROM check_mail_settings",
      )
    ).rows[0];
    expect(stored.encrypted_api_key).toBeNull();
    expect(stored.enabled).toBe(false);
    expect((await request("disabled@integration.example")).statusCode).toBe(
      200,
    );
    expect(providerCalls).toHaveLength(0);
  });
});
