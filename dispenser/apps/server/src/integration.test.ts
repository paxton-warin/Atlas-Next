import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allocateLink,
  withSerializableRetry,
  type AssignmentSettings,
} from "./allocation.js";
import type { DriveVerificationProvider } from "./googleDrive.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl ? describe : describe.skip;

class FakeDrive implements DriveVerificationProvider {
  codes = new Map<string, string>();
  fail = false;
  async createVerificationFile(email: string, code: string) {
    if (this.fail) throw new Error("simulated Drive outage");
    this.codes.set(email, code);
    return {
      fileId: `file-${email}`,
      permissionId: `permission-${email}`,
      url: `https://drive.google.com/file/d/file-${email}/view`,
    };
  }
  async removeVerificationFile() {
    return;
  }
  async testConnection() {
    return "Google Drive connection is working.";
  }
}

const cookies = (headers: Record<string, unknown>) =>
  (headers["set-cookie"] as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
integration("database-backed application flow", () => {
  let pool: Pool;
  let redis: Redis;
  let app: Awaited<ReturnType<(typeof import("./app.js"))["buildApp"]>>["app"];
  const drive = new FakeDrive();
  let adminCookie = "";
  let csrf = "";
  let userCookie = "";
  let userCsrf = "";
  beforeAll(async () => {
    if (!databaseUrl!.includes("_test"))
      throw new Error(
        "TEST_DATABASE_URL must identify a dedicated _test database",
      );
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const migrationDir = resolve(
      import.meta.dirname,
      "../../../packages/database/migrations",
    );
    for (const name of (await readdir(migrationDir))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(resolve(migrationDir, name), "utf8"));
    redis = new Redis(redisUrl!);
    await redis.flushdb();
    const module = await import("./app.js");
    app = (await module.buildApp({ pool, redis, drive })).app;
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await pool?.end();
  });

  it("bootstraps exactly one administrator with a secure session", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/setup/status" })).json(),
    ).toEqual({ initialized: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/bootstrap",
      payload: {
        email: "admin@example.com",
        token: process.env.BOOTSTRAP_TOKEN,
      },
    });
    expect(response.statusCode).toBe(200);
    csrf = response.json().csrfToken;
    adminCookie = cookies(response.headers);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup/bootstrap",
          payload: {
            email: "admin@example.com",
            token: process.env.BOOTSTRAP_TOKEN,
          },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("recovers the bootstrap administrator without Google Drive", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/recover",
      payload: {
        email: "admin@example.com",
        token: process.env.BOOTSTRAP_TOKEN,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().csrfToken).toBeTypeOf("string");
    const recoveredSession = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookies(response.headers) },
    });
    expect(recoveredSession.json().user).toMatchObject({
      email: "admin@example.com",
      role: "admin",
    });
  });
  it("enforces CSRF and administrator authorization", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/links",
          headers: { cookie: adminCookie },
          payload: { name: "One", url: "https://example.com" },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/links",
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        name: "One",
        url: "https://example.com",
        capacity: 2,
        weight: 1,
      },
    });
    expect(created.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/admin/links",
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        name: "Two",
        url: "https://two.example.com",
        capacity: 2,
        weight: 1,
      },
    });
    expect(second.statusCode).toBe(200);
  });
  it("requests a mocked Drive file, verifies once, and persists a user session", async () => {
    const request = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "person@example.com" },
    });
    expect(request.statusCode).toBe(200);
    const attempt = request.json();
    expect(drive.codes.get("person@example.com")).toMatch(/^\d{6}$/);
    const wrongCode =
      drive.codes.get("person@example.com") === "000000" ? "111111" : "000000";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          payload: { verificationId: attempt.verificationId, code: wrongCode },
        })
      ).statusCode,
    ).toBe(400);
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        verificationId: attempt.verificationId,
        code: drive.codes.get("person@example.com"),
      },
    });
    expect(verified.statusCode).toBe(200);
    userCookie = cookies(verified.headers);
    userCsrf = verified.json().csrfToken;
    const verifiedUser = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE normalized_email='person@example.com'",
    );
    await redis.set(
      `rate:assignment:${verifiedUser.rows[0]!.id}`,
      "999",
      "EX",
      3600,
    );
    const first = await app.inject({
      method: "POST",
      url: "/api/assignment",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/assignment",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().assignment.id).not.toBe(first.json().assignment.id);
    expect(second.json().assignment.url).not.toBe(first.json().assignment.url);
    expect(Date.parse(first.json().assignment.assignedAt)).not.toBeNaN();
    const listed = await app.inject({
      method: "GET",
      url: "/api/assignment",
      headers: { cookie: userCookie },
    });
    expect(listed.json().assignments).toHaveLength(2);
    const exhausted = await app.inject({
      method: "POST",
      url: "/api/assignment",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
    });
    expect(exhausted.statusCode).toBe(503);
    expect(exhausted.json().error.code).toBe("NO_LINK_AVAILABLE");
    const report = await app.inject({
      method: "POST",
      url: "/api/reports",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
      payload: {
        assignmentId: first.json().assignment.id,
        category: "does_not_load",
      },
    });
    expect(report.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/reports",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
      payload: {
        assignmentId: first.json().assignment.id,
        category: "very_slow",
      },
    });
    expect(duplicate.json().deduplicated).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/links",
          headers: { cookie: userCookie, "x-csrf-token": userCsrf },
          payload: { name: "No", url: "https://example.org" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("disables and re-enables a link without deleting its history", async () => {
    const link = (
      await pool.query<{ id: string }>(
        "SELECT link_id id FROM link_assignments WHERE user_id=(SELECT id FROM users WHERE normalized_email='person@example.com') ORDER BY assigned_at LIMIT 1",
      )
    ).rows[0]!;
    const before = await pool.query(
      "SELECT count(*)::int count FROM link_assignments WHERE link_id=$1",
      [link.id],
    );
    const disabled = await app.inject({
      method: "PUT",
      url: `/api/admin/links/${link.id}/enabled`,
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      enabled: false,
      health_status: "disabled",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM link_assignments WHERE link_id=$1",
          [link.id],
        )
      ).rows[0].count,
    ).toBe(before.rows[0].count);
    const disabledHistory = (
      await app.inject({
        method: "GET",
        url: "/api/assignment",
        headers: { cookie: userCookie },
      })
    ).json().assignments;
    expect(disabledHistory).toHaveLength(2);
    expect(disabledHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unavailable",
          available: false,
          url: "",
        }),
      ]),
    );
    const enabled = await app.inject({
      method: "PUT",
      url: `/api/admin/links/${link.id}/enabled`,
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      enabled: true,
      health_status: "unknown",
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/assignment",
          headers: { cookie: userCookie },
        })
      ).json().assignments,
    ).toHaveLength(2);
  });
  it("permanently deletes a link and restores the user's weekly quota", async () => {
    await pool.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{linksPerWeek}','2'::jsonb) WHERE key='assignments'",
    );
    const blocked = await app.inject({
      method: "POST",
      url: "/api/assignment",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
    });
    expect(blocked.statusCode).toBe(429);
    const link = (
      await pool.query<{ id: string }>(
        "SELECT link_id id FROM link_assignments WHERE user_id=(SELECT id FROM users WHERE normalized_email='person@example.com') LIMIT 1",
      )
    ).rows[0]!;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/links/${link.id}`,
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      ok: true,
      deleted: true,
      assignments: 1,
    });
    expect(
      (
        await pool.query("SELECT count(*)::int count FROM links WHERE id=$1", [
          link.id,
        ])
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM link_assignments WHERE link_id=$1",
          [link.id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM reports WHERE link_id=$1",
          [link.id],
        )
      ).rows[0].count,
    ).toBe(0);
    const listed = await app.inject({
      method: "GET",
      url: "/api/assignment",
      headers: { cookie: userCookie },
    });
    expect(listed.json().assignments).toHaveLength(1);
    await app.inject({
      method: "POST",
      url: "/api/admin/links",
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        name: "Replacement",
        url: "https://replacement.example",
        capacity: 10,
        weight: 1,
      },
    });
    const replacement = await app.inject({
      method: "POST",
      url: "/api/assignment",
      headers: { cookie: userCookie, "x-csrf-token": userCsrf },
    });
    expect(replacement.statusCode).toBe(200);
  });
  it("applies email deny rules and normalizes case", async () => {
    const denialMessage =
      "This address is blocked. Use your organization email address.";
    const rule = await app.inject({
      method: "POST",
      url: "/api/admin/email-rules",
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        kind: "domain",
        action: "deny",
        pattern: "@blocked.example",
        priority: 500,
        enabled: true,
        note: "Blocked test",
        denialMessage,
      },
    });
    expect(rule.statusCode).toBe(200);
    expect(rule.json().denialMessage).toBe(denialMessage);
    const ruleId = rule.json().id as string;

    const legacyUpdate = await app.inject({
      method: "PUT",
      url: `/api/admin/email-rules/${ruleId}`,
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        kind: "domain",
        action: "deny",
        pattern: "@blocked.example",
        priority: 500,
        enabled: true,
        note: "Updated by a client without the new field",
      },
    });
    expect(legacyUpdate.statusCode).toBe(200);
    expect(legacyUpdate.json().denialMessage).toBe(denialMessage);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/email-rules",
      headers: { cookie: adminCookie },
    });
    expect(
      listed.json().rules.find((item: { id: string }) => item.id === ruleId)
        .denialMessage,
    ).toBe(denialMessage);

    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/email-rules/test",
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: { email: "preview@blocked.example" },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      allowed: false,
      rule: { id: ruleId, denialMessage },
    });

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "USER@BLOCKED.EXAMPLE" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("EMAIL_NOT_ALLOWED");
    expect(blocked.json().error.message).toBe(denialMessage);

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/admin/email-rules/${ruleId}`,
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        kind: "domain",
        action: "deny",
        pattern: "@blocked.example",
        priority: 500,
        enabled: true,
        note: "Blocked test",
        denialMessage: "",
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().denialMessage).toBe("");
    const generic = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "another@blocked.example" },
    });
    expect(generic.statusCode).toBe(403);
    expect(generic.json().error.message).toBe(
      "This email address is not eligible to register.",
    );

    const tooLong = await app.inject({
      method: "POST",
      url: "/api/admin/email-rules",
      headers: { cookie: adminCookie, "x-csrf-token": csrf },
      payload: {
        kind: "domain",
        action: "deny",
        pattern: "@long-message.example",
        priority: 1,
        enabled: true,
        denialMessage: "x".repeat(501),
      },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toMatch(/500 characters or fewer/);

    const legacyRule = await pool.query<{
      id: string;
      denial_message: string;
    }>(
      "INSERT INTO email_rules(kind,action,pattern,priority,enabled,note) VALUES('domain','deny','@legacy.example',1,false,'Legacy rule') RETURNING id,denial_message",
    );
    expect(legacyRule.rows[0]?.denial_message).toBe("");
  });
  it("normalizes Drive failures into a safe typed response", async () => {
    drive.fail = true;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "outage@example.com" },
    });
    drive.fail = false;
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("GOOGLE_DRIVE_UNAVAILABLE");
    expect(response.body).not.toContain("simulated Drive outage");
  });
  it("persists attempt lockout and expiry states", async () => {
    const brute = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "brute@example.com" },
    });
    const bruteId = brute.json().verificationId;
    const bruteWrong =
      drive.codes.get("brute@example.com") === "999999" ? "888888" : "999999";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { verificationId: bruteId, code: bruteWrong },
      });
      expect(response.statusCode).toBe(attempt === 5 ? 429 : 400);
    }
    expect(
      (
        await pool.query(
          "SELECT status,attempt_count FROM verifications WHERE id=$1",
          [bruteId],
        )
      ).rows[0],
    ).toMatchObject({ status: "failed", attempt_count: 5 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          payload: {
            verificationId: bruteId,
            code: drive.codes.get("brute@example.com"),
          },
        })
      ).statusCode,
    ).toBe(400);

    const expired = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "expired@example.com" },
    });
    await pool.query(
      "UPDATE verifications SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.json().verificationId],
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        verificationId: expired.json().verificationId,
        code: drive.codes.get("expired@example.com"),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VERIFICATION_EXPIRED");
    expect(
      (
        await pool.query("SELECT status FROM verifications WHERE id=$1", [
          expired.json().verificationId,
        ])
      ).rows[0].status,
    ).toBe("expired");
  });
  it("serves validated settings, report aggregation, user details, and audit data", async () => {
    const headers = { cookie: adminCookie, "x-csrf-token": csrf };
    const activeAssignments = (
      await app.inject({
        method: "GET",
        url: "/api/assignment",
        headers: { cookie: userCookie },
      })
    ).json().assignments;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/reports",
          headers: { cookie: userCookie, "x-csrf-token": userCsrf },
          payload: {
            assignmentId: activeAssignments[0].id,
            category: "does_not_load",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/settings/verification",
          headers,
          payload: { codeLength: 99 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/admin/settings/verification",
          headers,
          payload: {
            codeLength: 6,
            lifetimeMinutes: 12,
            maxAttempts: 5,
            resendCooldownSeconds: 60,
          },
        })
      ).statusCode,
    ).toBe(200);
    const reports = await app.inject({
      method: "GET",
      url: "/api/admin/reports",
      headers: { cookie: adminCookie },
    });
    expect(reports.statusCode).toBe(200);
    expect(reports.json().aggregates[0]).toMatchObject({
      reports: 1,
      unique_users: 1,
    });
    const users = (
      await app.inject({
        method: "GET",
        url: "/api/admin/users?q=person",
        headers: { cookie: adminCookie },
      })
    ).json().users;
    expect(users).toHaveLength(1);
    expect(users[0].active_assignment_count).toBe(2);
    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/users/${users[0].id}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().assignments).toHaveLength(2);
    expect(detail.json().reports).toHaveLength(1);
    const quotaUpdate = await app.inject({
      method: "PUT",
      url: `/api/admin/users/${users[0].id}`,
      headers,
      payload: {
        status: "active",
        adminNotes: "weekly override",
        quotaOverride: { linksPerWeek: 3 },
      },
    });
    expect(quotaUpdate.statusCode).toBe(200);
    expect(quotaUpdate.json().quota_override).toEqual({ linksPerWeek: 3 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${users[0].id}/revoke-sessions`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/assignment",
          headers: { cookie: userCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/audit",
          headers: { cookie: adminCookie },
        })
      ).json().events.length,
    ).toBeGreaterThan(3);
  });
  it("never exceeds capacity under 100 simultaneous allocation requests", async () => {
    await pool.query("UPDATE links SET enabled=false");
    const link = (
      await pool.query<{ id: string }>(
        "INSERT INTO links(name,url,capacity,health_status) VALUES('Capacity test','https://capacity.example',50,'healthy') RETURNING id",
      )
    ).rows[0]!;
    const users = (
      await pool.query<{ id: string }>(
        `INSERT INTO users(email,normalized_email,verified_at) SELECT 'load-'||n||'@example.com','load-'||n||'@example.com',now() FROM generate_series(1,100) n RETURNING id`,
      )
    ).rows;
    const settings: AssignmentSettings = {
      strategy: "balanced_random",
      linksPerWeek: 3,
      assignmentLifetimeHours: 24,
    };
    const outcomes = await Promise.allSettled(
      users.map((user) =>
        withSerializableRetry(() => allocateLink(pool, user.id, settings), 10),
      ),
    );
    const count = Number(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*)::text count FROM link_assignments WHERE link_id=$1",
          [link.id],
        )
      ).rows[0]!.count,
    );
    expect(count).toBeLessThanOrEqual(50);
    expect(count).toBe(50);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      50,
    );
  });
});
