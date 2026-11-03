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

integration("manual verification directories and account access", () => {
  let maintenance: Pool;
  let pool: Pool;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let studentId: string;
  const schema = `manual_review_test_${randomUUID().replaceAll("-", "")}`;
  const prefix = randomUUID();
  const csrf = `${prefix}-csrf`;
  const codes = new Map<string, string>();
  const providerCalls: string[] = [];
  const driveCalls: string[] = [];
  const admin = {
    cookie: `ald_session=${prefix}-admin`,
    "x-csrf-token": csrf,
  };
  const student = {
    cookie: `ald_session=${prefix}-student`,
    "x-csrf-token": csrf,
  };
  const other = {
    cookie: `ald_session=${prefix}-other`,
    "x-csrf-token": csrf,
  };
  const form = {
    name: "Fixture Student",
    schoolName: "Fixture High School",
    additionalInformation: "Please review this synthetic test account.",
  };

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error(
        "Manual review tests require a dedicated _test database.",
      );
    if (!new URL(redisUrl!).pathname.match(/^\/(?:1[0-5]|[1-9])$/))
      throw new Error(
        "Manual review tests require a non-default Redis database.",
      );
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
    for (const [label, email, role] of [
      ["admin", "administrator@school.example", "admin"],
      ["student", "student123@school.example", "user"],
      ["other", "student456@school.example", "user"],
    ]) {
      const user = (
        await pool.query<{ id: string }>(
          "INSERT INTO users(email,normalized_email,role,verified_at) VALUES($1,$1,$2::role,now()) RETURNING id",
          [email, role],
        )
      ).rows[0]!;
      if (label === "student") studentId = user.id;
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [
          user.id,
          hashSecret(`${prefix}-${label}`, config.sessionSecret),
          hashSecret(csrf, config.sessionSecret),
        ],
      );
    }
    app = (
      await buildApp({
        pool,
        redis,
        drive: {
          async createVerificationFile(email, code) {
            codes.set(email, code);
            driveCalls.push(email);
            return {
              fileId: `fixture-${randomUUID()}`,
              permissionId: "fixture",
              url: "https://drive.google.com/file/d/fixture/view",
            };
          },
          async removeVerificationFile() {},
          async testConnection() {
            return "Local fixture only.";
          },
        },
        checkMailFetch: async (_input, init) => {
          const email = new URLSearchParams(String(init?.body ?? "")).get(
            "email",
          )!;
          providerCalls.push(email);
          return new Response(
            JSON.stringify({
              valid: true,
              block: false,
              is_disposable: false,
              domain: email.split("@")[1],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      })
    ).app;
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE manual_verification_domains,manual_verification_requests,links,verifications,check_mail_attempts,check_mail_cache,check_mail_allowlist RESTART IDENTITY CASCADE",
    );
    await pool.query("DELETE FROM email_rules");
    await pool.query("UPDATE users SET status='active'");
    await pool.query(
      "UPDATE app_settings SET value=$1::jsonb WHERE key='registration'",
      [JSON.stringify({ defaultMode: "allow", rateLimitPerHour: 1000 })],
    );
    await pool.query("UPDATE check_mail_settings SET enabled=false");
    codes.clear();
    providerCalls.length = 0;
    driveCalls.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length)
        await redis.del(...keys.map((key) => key.slice(prefix.length + 1)));
      await redis.quit();
    }
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
    }
  });

  async function createDomain(domain = "school.example") {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/manual-verification/domains",
      headers: admin,
      payload: { domain, enabled: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function createSchool(
    domainId: string,
    text?: string,
    name = "Fixture High School",
  ) {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/manual-verification/domains/${domainId}/schools`,
      headers: admin,
      payload: { name, enabled: true, ...(text ? { text } : {}) },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function state(headers: Record<string, string> = student) {
    const response = await app.inject({
      method: "GET",
      url: "/api/manual-verification",
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function submit(
    revision = 0,
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = student,
  ) {
    return app.inject({
      method: "PUT",
      url: "/api/manual-verification",
      headers,
      payload: { ...form, revision, ...overrides },
    });
  }
  async function review(
    id: string,
    revision: number,
    decision = "approved",
    headers: Record<string, string> = admin,
  ) {
    return app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/requests/${id}/review`,
      headers,
      payload: { decision, revision, reviewNote: "Fixture review." },
    });
  }
  async function enableChecker() {
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/check-mail",
      headers: admin,
      payload: {
        enabled: true,
        apiKey: "fixture-manual-check-mail-key",
        monthlyLimit: 1000,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  const requestCode = (email: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/request",
      remoteAddress: "127.0.0.44",
      payload: { email },
    });
  const verifyCode = (verificationId: string, email: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { verificationId, code: codes.get(email) },
    });

  it("protects directory administration and request data with authentication and CSRF", async () => {
    for (const headers of [{}, student]) {
      const result = await app.inject({
        method: "GET",
        url: "/api/admin/manual-verification/domains",
        headers,
      });
      expect([401, 403]).toContain(result.statusCode);
    }
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/manual-verification",
    });
    expect(unauthenticated.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/admin/manual-verification/domains",
      headers: { cookie: admin.cookie },
      payload: { domain: "school.example", enabled: true },
    });
    expect(noCsrf.statusCode).toBe(403);
    await createDomain();
    expect((await submit(0, {}, { cookie: student.cookie })).statusCode).toBe(
      403,
    );
  });

  it("gates existing verified users dynamically but exempts administrators", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/assignment",
      headers: student,
    });
    expect(before.statusCode).toBe(200);
    await createDomain();
    const response = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: student,
    });
    expect(response.json().manualVerification).toMatchObject({
      required: true,
      status: "required",
      domain: "school.example",
      request: null,
    });
    expect((await state(admin)).required).toBe(false);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/users",
          headers: admin,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("denies both historical link reads and new allocations while leaving logout accessible", async () => {
    await createDomain();
    const link = (
      await pool.query<{ id: string }>(
        "INSERT INTO links(name,url) VALUES('Fixture','https://fixture.example/') RETURNING id",
      )
    ).rows[0]!;
    await pool.query(
      "INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)",
      [studentId, link.id],
    );
    for (const [method, url, payload] of [
      ["GET", "/api/assignment", undefined],
      ["POST", "/api/assignment", {}],
      [
        "POST",
        "/api/reports",
        { assignmentId: randomUUID(), category: "other" },
      ],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: student,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe("MANUAL_VERIFICATION_REQUIRED");
      expect(response.body).not.toContain("https://fixture.example/");
    }
    const code = await requestCode("student456@school.example");
    const verified = await verifyCode(
      code.json().verificationId,
      "student456@school.example",
    );
    expect(verified.statusCode, verified.body).toBe(200);
    const cookies = verified.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: cookies, "x-csrf-token": verified.json().csrfToken },
    });
    expect(logout.statusCode, logout.body).toBe(200);
  });

  it("applies directory flags only after email ownership verification", async () => {
    await createDomain();
    const email = "student789@school.example";
    const code = await requestCode(email);
    expect(code.statusCode, code.body).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM manual_verification_requests",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await app.inject({ method: "GET", url: "/api/session" })).json().user,
    ).toBeNull();
    const verified = await verifyCode(code.json().verificationId, email);
    expect(verified.statusCode, verified.body).toBe(200);
    const cookie = verified.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(session.json().manualVerification).toMatchObject({
      required: true,
      status: "required",
      request: null,
    });
  });

  it("stores one editable request across submissions and normal sign-ins", async () => {
    await createDomain();
    const first = await submit();
    expect(first.statusCode, first.body).toBe(200);
    const one = first.json();
    expect(one).toMatchObject({
      required: true,
      status: "pending",
      request: { ...form, userId: studentId, revision: 1 },
    });
    const second = await submit(one.request.revision, {
      additionalInformation: "Updated synthetic information.",
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().request.id).toBe(one.request.id);
    expect(second.json().request.revision).toBe(2);
    const email = "student123@school.example";
    const code = await requestCode(email);
    const verified = await verifyCode(code.json().verificationId, email);
    expect(verified.statusCode, verified.body).toBe(200);
    const cookie = verified.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    expect((await state({ cookie })).request).toMatchObject({
      id: one.request.id,
      additionalInformation: "Updated synthetic information.",
      revision: 2,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM manual_verification_requests WHERE user_id=$1",
          [studentId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("uses atomic request revisions for concurrent first submissions", async () => {
    await createDomain();
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM manual_verification_requests WHERE user_id=$1",
          [studentId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await state()).request.revision).toBe(1);
  });

  it("rejects blank and oversized form fields without creating a request", async () => {
    await createDomain();
    for (const field of ["name", "schoolName", "additionalInformation"]) {
      const response = await submit(0, { [field]: "  " });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(
      (await submit(0, { additionalInformation: "x".repeat(100_001) }))
        .statusCode,
    ).toBe(400);
    expect((await state()).request).toBeNull();
  });

  it("does not allow one account to choose another account's request identity", async () => {
    await createDomain();
    const first = await submit();
    expect(first.statusCode).toBe(200);
    expect((await state(other)).request).toBeNull();
    const second = await submit(
      0,
      { userId: studentId, id: first.json().request.id },
      other,
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().request.userId).not.toBe(studentId);
    expect(second.json().request.id).not.toBe(first.json().request.id);
    expect((await state()).request.name).toBe(form.name);
  });

  it("requires current revision and administrator CSRF for approval", async () => {
    await createDomain();
    const first = await submit();
    const request = first.json().request;
    expect(
      (await review(request.id, request.revision, "approved", student))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await review(request.id, request.revision, "approved", {
          cookie: admin.cookie,
        })
      ).statusCode,
    ).toBe(403);
    const edited = await submit(request.revision, { name: "Edited fixture" });
    expect(edited.statusCode).toBe(200);
    const stale = await review(request.id, request.revision);
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await state()).status).toBe("pending");
    const approved = await review(request.id, edited.json().request.revision);
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await state()).required).toBe(false);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/assignment",
          headers: student,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps an explicit denial authoritative over later directory membership and user edits", async () => {
    const domain = await createDomain();
    const first = await submit();
    const denied = await review(
      first.json().request.id,
      first.json().request.revision,
      "denied",
    );
    expect(denied.statusCode, denied.body).toBe(200);
    await createSchool(domain.id, "student123@school.example");
    const before = await state();
    expect(before).toMatchObject({ required: true, status: "denied" });
    const edited = await submit(before.request.revision, {
      additionalInformation: "Please reconsider this synthetic fixture.",
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({
      required: true,
      status: "denied",
      request: { id: first.json().request.id },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/assignment",
          headers: student,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("supports multiple exact domains and school-scoped directories without suffix matching", async () => {
    const domain = await createDomain();
    await createDomain("second.example");
    await createSchool(
      domain.id,
      "STUDENT123@school.example\nstudent123@school.example\n",
      "School One",
    );
    await createSchool(domain.id, "student999@school.example", "School Two");
    expect((await state()).required).toBe(false);
    expect((await state(other)).required).toBe(true);
    const email = "student123@notschool.example";
    const code = await requestCode(email);
    const verified = await verifyCode(code.json().verificationId, email);
    expect(verified.statusCode, verified.body).toBe(200);
    const cookie = verified.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    expect((await state({ cookie })).required).toBe(false);
    const domains = await app.inject({
      method: "GET",
      url: "/api/admin/manual-verification/domains",
      headers: admin,
    });
    expect(domains.statusCode).toBe(200);
    expect(JSON.stringify(domains.json())).toContain("second.example");
  });

  it("adds or replaces a school's directory without changing another school", async () => {
    const domain = await createDomain();
    const first = await createSchool(
      domain.id,
      "student123@school.example",
      "First",
    );
    await createSchool(domain.id, "student456@school.example", "Second");
    const added = await app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/schools/${first.id}/emails`,
      headers: admin,
      payload: {
        mode: "add",
        text: "student789@school.example\nSTUDENT123@school.example",
      },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().total).toBe(2);
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/schools/${first.id}/emails`,
      headers: admin,
      payload: { mode: "replace", text: "student789@school.example" },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().total).toBe(1);
    expect((await state()).required).toBe(true);
    expect((await state(other)).required).toBe(false);
  });

  it("rejects mismatched-domain imports atomically", async () => {
    const domain = await createDomain();
    const school = await createSchool(domain.id, "student123@school.example");
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/schools/${school.id}/emails`,
      headers: admin,
      payload: {
        mode: "replace",
        text: "student456@school.example\nintruder@elsewhere.example",
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect((await state()).required).toBe(false);
    expect((await state(other)).required).toBe(true);
  });

  it("filters and paginates the administrator queue", async () => {
    await createDomain();
    expect((await submit()).statusCode).toBe(200);
    expect((await submit(0, { name: "Other Fixture" }, other)).statusCode).toBe(
      200,
    );
    const queue = await app.inject({
      method: "GET",
      url: "/api/admin/manual-verification/requests?status=pending&page=1&pageSize=1",
      headers: admin,
    });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json().requests).toHaveLength(1);
    expect(queue.json().pagination.total).toBe(2);
    const single = await app.inject({
      method: "GET",
      url: "/api/admin/manual-verification/requests?status=pending&q=student123",
      headers: admin,
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().requests).toHaveLength(1);
    expect(single.json().requests[0].email).toBe("student123@school.example");
  });

  it("checks registration regex before spending Check-Mail requests even for known directory emails", async () => {
    const domain = await createDomain();
    await createSchool(domain.id, "not-a-student@school.example");
    await enableChecker();
    await pool.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{defaultMode}','\"deny\"') WHERE key='registration'",
    );
    await pool.query(
      "INSERT INTO email_rules(kind,action,pattern,priority) VALUES('regex','allow','^student[0-9]+@school\\.example$',10)",
    );
    const denied = await requestCode("not-a-student@school.example");
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe("EMAIL_NOT_ALLOWED");
    expect(providerCalls).toHaveLength(0);
    expect(driveCalls).toHaveLength(0);
  });

  it("rechecks changed registration policy before Check-Mail at code verification", async () => {
    const email = "changed-policy@school.example";
    const code = await requestCode(email);
    expect(code.statusCode, code.body).toBe(200);
    await enableChecker();
    await pool.query(
      "INSERT INTO email_rules(kind,action,pattern,priority) VALUES('exact','deny',$1,100)",
      [email],
    );
    const verified = await verifyCode(code.json().verificationId, email);
    expect(verified.statusCode, verified.body).toBe(403);
    expect(verified.json().error.code).toBe("EMAIL_NOT_ALLOWED");
    expect(providerCalls).toHaveLength(0);
    expect(
      (
        await pool.query("SELECT id FROM users WHERE normalized_email=$1", [
          email,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("requires another review when an approved request is edited", async () => {
    await createDomain();
    const submitted = await submit();
    const request = submitted.json().request;
    const approved = await review(request.id, request.revision);
    expect(approved.statusCode, approved.body).toBe(200);
    const saved = await state();
    expect(saved.status).toBe("approved");
    const edited = await submit(saved.request.revision, {
      name: "Changed approved fixture",
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({
      required: true,
      status: "pending",
      request: { id: request.id, reviewedAt: null, reviewNote: "" },
    });
  });

  it("never approves stale content during a concurrent edit and review", async () => {
    await createDomain();
    const first = await submit();
    const request = first.json().request;
    const responses = await Promise.all([
      submit(request.revision, { name: "Concurrent changed fixture" }),
      review(request.id, request.revision),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const current = await state();
    if (current.status === "approved")
      expect(current.request.name).toBe(form.name);
    else expect(current.request.name).toBe("Concurrent changed fixture");
    expect(current.request.revision).toBe(request.revision + 1);
  });

  it("honors intentional school and domain policy disable/delete operations", async () => {
    const domain = await createDomain();
    const school = await createSchool(domain.id, "student123@school.example");
    expect((await state()).required).toBe(false);
    const disabledSchool = await app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/schools/${school.id}`,
      headers: admin,
      payload: { enabled: false },
    });
    expect(disabledSchool.statusCode, disabledSchool.body).toBe(200);
    expect((await state()).required).toBe(true);
    const disabledDomain = await app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/domains/${domain.id}`,
      headers: admin,
      payload: { enabled: false },
    });
    expect(disabledDomain.statusCode, disabledDomain.body).toBe(200);
    expect((await state()).required).toBe(false);
    const enabledDomain = await app.inject({
      method: "PUT",
      url: `/api/admin/manual-verification/domains/${domain.id}`,
      headers: admin,
      payload: { enabled: true },
    });
    expect(enabledDomain.statusCode).toBe(200);
    expect((await state()).required).toBe(true);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/manual-verification/domains/${domain.id}`,
      headers: admin,
    });
    expect(removed.statusCode).toBe(200);
    expect((await state()).required).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM manual_verification_known_emails",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("never exposes school directory emails to ordinary accounts", async () => {
    const domain = await createDomain();
    const school = await createSchool(domain.id, "student123@school.example");
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/manual-verification/schools/${school.id}/emails`,
      headers: student,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("student123@school.example");
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: other,
    });
    expect(session.body).not.toContain("student123@school.example");
  });

  it("does not spend Check-Mail requests for returning verified users who need manual review", async () => {
    await createDomain();
    await enableChecker();
    const email = "student123@school.example";
    const code = await requestCode(email);
    expect(code.statusCode, code.body).toBe(200);
    const verified = await verifyCode(code.json().verificationId, email);
    expect(verified.statusCode, verified.body).toBe(200);
    expect(providerCalls).toHaveLength(0);
  });
});
