import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import {
  registerHubSessionTransfer,
  HUB_TRANSFER_COOKIE,
  transferReturnPath,
} from "./hubSessionTransfer.js";
import { hashSecret, randomToken } from "./security.js";
import { AppError } from "./errors.js";
const url = process.env.TEST_DATABASE_URL,
  suite = url ? describe : describe.skip;
suite("Destination/browser-bound one-use Hub session transfer", () => {
  const schema = "hub_transfer_" + randomUUID().replaceAll("-", ""),
    secret = "local-fixture-session-secret-at-least32",
    source = "https://old.example",
    destination = "https://new.example";
  let pool: Pool,
    maintenance: Pool,
    issueFailure = false;
  const app = Fastify({ trustProxy: true });
  let user: string, oldSession: string;
  const headers = (origin: string, extra: Record<string, string> = {}) => ({
    host: new URL(origin).host,
    "x-forwarded-proto": "https",
    origin,
    ...extra,
  });
  const request = async (
    method: "GET" | "POST",
    path: string,
    origin = destination,
    payload?: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: path,
      headers: headers(origin, extra),
      ...(payload ? { payload } : {}),
    });
  const rowCount = async () =>
    Number((await pool.query("SELECT count(*) FROM sessions")).rows[0].count);
  async function start(returnTo = "/support") {
    const r = await request(
      "POST",
      "/api/hub/session-transfer/start",
      destination,
      { source, returnTo },
    );
    expect(r.statusCode).toBe(200);
    const target = new URL(r.json().redirect),
      id = target.searchParams.get("request")!;
    return {
      id,
      cookie: r.cookies.find((c) => c.name === HUB_TRANSFER_COOKIE)!.value,
      headers: r.headers,
    };
  }
  async function authorize(id: string) {
    return request(
      "POST",
      "/api/hub/session-transfer/authorize",
      source,
      { request: id },
      { cookie: "session=source-token", "x-csrf-token": "source-csrf" },
    );
  }
  async function ready() {
    const r = await start(),
      a = await authorize(r.id);
    expect(a.statusCode).toBe(200);
    return { ...r, code: new URL(a.json().redirect).searchParams.get("code")! };
  }
  async function exchange(
    r: { id: string; cookie: string; code: string },
    extra: Record<string, string> = {},
  ) {
    return request(
      "POST",
      "/api/hub/session-transfer/exchange",
      destination,
      { request: r.id, code: r.code },
      { cookie: HUB_TRANSFER_COOKIE + "=" + r.cookie, ...extra },
    );
  }
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith("_test"))
      throw Error("Dedicated test database required");
    maintenance = new Pool({ connectionString: url });
    await maintenance.query("SELECT pg_advisory_lock(870412201)");
    try {
      await maintenance.query(
        "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
      );
      const ext = (
        await maintenance.query(
          "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'",
        )
      ).rows[0];
      if (ext.nspname !== "public")
        await maintenance.query("ALTER EXTENSION pgcrypto SET SCHEMA public");
    } finally {
      await maintenance.query("SELECT pg_advisory_unlock(870412201)");
    }
    await maintenance.query("CREATE SCHEMA " + schema);
    pool = new Pool({
      connectionString: url,
      options: "-c search_path=" + schema + ",public",
      max: 1,
    });
    for (const file of [
      "0001_initial.sql",
      "0010_hub_cloud.sql",
      "0017_hub_session_transfer.sql",
    ])
      await pool.query(
        await readFile(
          new URL(
            "../../../packages/database/migrations/" + file,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await app.register(cookie);
    app.setErrorHandler((error, _r, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 500)
        .send({
          error: {
            message: error instanceof Error ? error.message : "Unknown error",
          },
        }),
    );
    const session = async (r: any) =>
      (
        await pool.query(
          'SELECT u.id,u.role,u.status,s.id AS "sessionId",s.csrf_hash AS "csrfHash" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()',
          [hashSecret(r.cookies.session || "", secret)],
        )
      ).rows[0] || null;
    registerHubSessionTransfer(app, {
      pool,
      sessionSecret: secret,
      session,
      csrf: (r, u) => {
        if (
          hashSecret(String(r.headers["x-csrf-token"] || ""), secret) !==
          u.csrfHash
        )
          throw new AppError("FORBIDDEN", "CSRF failed", 403);
      },
      issueSession: async (id, r, reply, db) => {
        const token = randomToken(),
          csrf = randomToken();
        await db.query(
          "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",
          [id, hashSecret(token, secret), hashSecret(csrf, secret)],
        );
        reply.setCookie("session", token, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "strict",
        });
        reply.setCookie("csrf", csrf, {
          path: "/",
          secure: true,
          sameSite: "strict",
        });
        if (issueFailure) throw Error("Simulated commit failure");
        return csrf;
      },
    });
    await app.ready();
  });
  beforeEach(async () => {
    issueFailure = false;
    await pool.query(
      "TRUNCATE hub_session_transfers,hub_cloud_endpoints,hub_cloud_accounts,sessions,users CASCADE",
    );
    user = randomUUID();
    oldSession = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,normalized_email) VALUES($1,'pending@example.com','pending@example.com')",
      [user],
    );
    await pool.query(
      "INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
      [
        oldSession,
        user,
        hashSecret("source-token", secret),
        hashSecret("source-csrf", secret),
      ],
    );
    const account = (
      await pool.query(
        "INSERT INTO hub_cloud_accounts(label,expected_account_id,status) VALUES('fixture','111111111111','connected') RETURNING id",
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO hub_cloud_endpoints(role,logical_id,account_id,distribution_id,url,origin_host,state) VALUES('hub','hub',$1,'OLD',$2,'origin.example','transition'),('hub','hub',$1,'NEW',$3,'origin.example','active')",
      [account, source, destination],
    );
    await pool.query(
      "INSERT INTO app_settings(key,value) VALUES('hub_current_origin',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(destination)],
    );
  });
  afterAll(async () => {
    await app.close();
    await pool?.end();
    await maintenance?.query("DROP SCHEMA " + schema + " CASCADE");
    await maintenance?.end();
  });
  it("offers only approved old Hub origins at the active current Hub", async () => {
    expect(
      (await request("GET", "/api/hub/session-transfer/availability")).json()
        .sources,
    ).toEqual([source]);
    expect(
      (
        await request(
          "GET",
          "/api/hub/session-transfer/availability",
          "https://evil.example",
        )
      ).json().sources,
    ).toEqual([]);
  });
  it("issues fresh host-only session and CSRF cookies once, without eligibility or role elevation", async () => {
    const r = await ready();
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    expect(r.headers["set-cookie"]).toContain("Secure");
    const response = await exchange(r);
    expect(response.statusCode).toBe(200);
    expect(response.json().redirect).toBe("/support");
    expect(response.cookies.find((c) => c.name === "session")?.value).not.toBe(
      "source-token",
    );
    expect(response.cookies.find((c) => c.name === "csrf")?.value).not.toBe(
      "source-csrf",
    );
    expect(String(response.headers["set-cookie"])).not.toContain("Domain=");
    expect(await rowCount()).toBe(2);
    expect(
      (
        await pool.query("SELECT role,verified_at FROM users WHERE id=$1", [
          user,
        ])
      ).rows[0],
    ).toEqual({ role: "user", verified_at: null });
    expect((await exchange(r)).statusCode).toBe(400);
    expect(await rowCount()).toBe(2);
  });
  it("requires source CSRF and ignores no-session source without manufacturing an account", async () => {
    const r = await start();
    const bad = await request(
      "POST",
      "/api/hub/session-transfer/authorize",
      source,
      { request: r.id },
      { cookie: "session=source-token" },
    );
    expect(bad.statusCode).toBe(403);
    const none = await request(
      "POST",
      "/api/hub/session-transfer/authorize",
      source,
      { request: r.id },
    );
    expect(none.statusCode).toBe(200);
    expect(none.json().redirect).toContain("failed=1");
    expect(await rowCount()).toBe(1);
  });
  it("rejects Origin null and unapproved/open-redirect destinations", async () => {
    expect(
      (
        await request(
          "POST",
          "/api/hub/session-transfer/start",
          destination,
          { source, returnTo: "/" },
          { origin: "null" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", "/api/hub/session-transfer/start", destination, {
          source: "https://evil.example",
          returnTo: "/",
        })
      ).statusCode,
    ).toBe(400);
    for (const value of [
      "//evil.example",
      "/\\evil",
      "https://evil.example",
      "/hub/session-transfer/callback",
    ])
      expect(() => transferReturnPath(value)).toThrow();
  });
  it("binds verifier, browser cookie and exact destination", async () => {
    const r = await ready();
    expect(
      (
        await request(
          "POST",
          "/api/hub/session-transfer/exchange",
          destination,
          { request: r.id, code: r.code },
        )
      ).statusCode,
    ).toBe(400);
    const parts = r.cookie.split(".");
    parts[1] = randomToken();
    expect((await exchange({ ...r, cookie: parts.join(".") })).statusCode).toBe(
      400,
    );
    const mismatch = await request(
      "POST",
      "/api/hub/session-transfer/exchange",
      source,
      { request: r.id, code: r.code },
      { cookie: HUB_TRANSFER_COOKIE + "=" + r.cookie },
    );
    expect(mismatch.statusCode).toBe(400);
    expect((await exchange(r)).statusCode).toBe(200);
  });
  it("checks source revocation and original session expiry again at exchange", async () => {
    const r = await ready();
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      oldSession,
    ]);
    expect((await exchange(r)).statusCode).toBe(400);
    expect(await rowCount()).toBe(1);
    await pool.query(
      "UPDATE sessions SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1",
      [oldSession],
    );
    expect((await exchange(r)).statusCode).toBe(400);
  });
  it("rejects expired transfers and deactivated target revisions", async () => {
    const r = await ready();
    await pool.query(
      "UPDATE hub_session_transfers SET expires_at=now()-interval '1 second' WHERE id=$1",
      [r.id],
    );
    expect((await exchange(r)).statusCode).toBe(400);
    const r2 = await ready();
    await pool.query(
      "UPDATE hub_cloud_endpoints SET state='retired' WHERE url=$1",
      [destination],
    );
    expect((await exchange(r2)).statusCode).toBe(400);
  });
  it("rolls back issuance and cookie publication on failure, then allows a single retry", async () => {
    const r = await ready();
    issueFailure = true;
    const failed = await exchange(r);
    expect(failed.statusCode).toBe(500);
    expect(failed.cookies.some((c) => c.name === "session")).toBe(false);
    expect(await rowCount()).toBe(1);
    issueFailure = false;
    expect((await exchange(r)).statusCode).toBe(200);
    expect(await rowCount()).toBe(2);
  });
  it("permits only one successful concurrent exchange with a one-connection pool", async () => {
    const r = await ready();
    const responses = await Promise.all([exchange(r), exchange(r)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rowCount()).toBe(2);
  });
  it("refuses replacing a different destination account session", async () => {
    const r = await ready(),
      other = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,normalized_email) VALUES($1,'other@example.com','other@example.com')",
      [other],
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,'none',now()+interval '1 day')",
      [other, hashSecret("other-token", secret)],
    );
    expect(
      (
        await exchange(r, {
          cookie:
            HUB_TRANSFER_COOKIE + "=" + r.cookie + "; session=other-token",
        })
      ).statusCode,
    ).toBe(409);
    expect(await rowCount()).toBe(2);
  });
});
