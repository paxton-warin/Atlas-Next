/** Focused real-PostgreSQL activity-write regression; no traffic generator. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { registerHubIdentityRoutes } from "./hubIdentity.js";
import { hashSecret } from "./security.js";
import { AppError } from "./errors.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Hub session activity writes are bounded without caching authorization", () => {
  async function fixture() {
    const target = new URL(url!);
    if (!target.pathname.endsWith("_test") || !["localhost", "127.0.0.1"].includes(target.hostname))
      throw Error("DEDICATED_LOOPBACK_TEST_DB_REQUIRED");
    const schema = "activity_" + randomUUID().replaceAll("-", "");
    const maintenance = new Pool({ connectionString: url, max: 2 });
    await maintenance.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await maintenance.query("CREATE SCHEMA " + schema);
    const pool = new Pool({ connectionString: url, max: 8, options: "-c search_path=" + schema + ",public" });
    for (const file of ["0001_initial.sql", "0009_hub_core.sql"])
      await pool.query(await readFile(resolve(import.meta.dirname, "../../../packages/database/migrations", file), "utf8"));
    const secret = "isolated-session-activity-secret-0123456789";
    const branchSecret = "b".repeat(43), token = "s".repeat(43);
    const user = (await pool.query("INSERT INTO users(email,normalized_email,verified_at) VALUES('activity@example.test','activity@example.test',now()) RETURNING id")).rows[0];
    const parent = (await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,'parent','csrf',now()+interval '1 day') RETURNING id", [user.id])).rows[0];
    const link = (await pool.query("INSERT INTO links(name,url) VALUES('Activity fixture','https://activity.example.test') RETURNING id")).rows[0];
    await pool.query("INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)", [user.id, link.id]);
    const branch = (await pool.query("INSERT INTO hub_branches(link_id,origin,secret_hash) VALUES($1,'https://activity.example.test',$2) RETURNING id", [link.id, hashSecret(branchSecret, secret)])).rows[0];
    const profile = (await pool.query("INSERT INTO hub_profiles(user_id,encrypted_key) VALUES($1,'fixture') RETURNING id", [user.id])).rows[0];
    const session = (await pool.query("INSERT INTO hub_branch_sessions(user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at,seen_at) VALUES($1,$2,$3,$4,$5,'fixture',now()+interval '1 hour',now()-interval '2 minutes') RETURNING id", [user.id, profile.id, branch.id, parent.id, hashSecret(token, secret)])).rows[0];
    await pool.query("CREATE TABLE activity_writes(n integer NOT NULL); INSERT INTO activity_writes VALUES(0)");
    await pool.query("CREATE FUNCTION count_activity_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE activity_writes SET n=n+1; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER activity_write AFTER UPDATE OF seen_at ON hub_branch_sessions FOR EACH ROW WHEN (NEW.seen_at>OLD.seen_at) EXECUTE FUNCTION count_activity_write()");
    const queryCounts = { sessions: 0, updates: 0, eligibility: 0 };
    const observedPool = { query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("SELECT bs.*")) queryCounts.sessions++;
      if (sql.startsWith("UPDATE hub_branch_sessions SET seen_at")) queryCounts.updates++;
      return pool.query(sql, values);
    }} as unknown as Pool;
    const identity = () => registerHubIdentityRoutes({ get() {}, post() {}, put() {}, delete() {} } as any, {
      pool: observedPool, sessionSecret: secret, encryptionKey: "unused",
      requireUser: async () => { throw Error("unused"); },
      requireEligibleUser: async () => { throw Error("unused"); },
      requireAdmin: async () => { throw Error("unused"); }, csrf() {},
      assertEligible: async user => {
        queryCounts.eligibility++;
        if (user.status !== "active") throw new AppError("FORBIDDEN", "Suspended", 403);
      },
    });
    const request = { method: "GET", url: "/api/hub/branch/profile/manifest", headers: {
      "x-atlas-branch-id": branch.id, authorization: "Bearer " + branchSecret,
      "x-atlas-branch-session": token,
    }} as unknown as FastifyRequest;
    const writes = async () => Number((await pool.query("SELECT n FROM activity_writes")).rows[0].n);
    const close = async () => { await pool.end(); await maintenance.query("DROP SCHEMA " + schema + " CASCADE"); await maintenance.end(); };
    return { pool, identity, request, writes, queryCounts, session, parent, user, branch, link, close };
  }

  it("coalesces concurrent instances atomically and skips UPDATE queries while fresh", async () => {
    const f = await fixture();
    try {
      const a = f.identity(), b = f.identity();
      await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).authenticate(f.request)));
      expect(await f.writes()).toBe(1);
      const updatesAfterRace = f.queryCounts.updates;
      for (let i = 0; i < 12; i++) await a.authenticate(f.request);
      expect(await f.writes()).toBe(1);
      expect(f.queryCounts.updates).toBe(updatesAfterRace);
      expect(f.queryCounts.sessions).toBe(36);
      expect(f.queryCounts.eligibility).toBe(36);
      // Simulate the next activity window without sleeping or changing host time.
      await f.pool.query("UPDATE hub_branch_sessions SET seen_at=now()-interval '61 seconds' WHERE id=$1", [f.session.id]);
      await Promise.all([a.authenticate(f.request), b.authenticate(f.request)]);
      expect(await f.writes()).toBe(2);
      const before = (await f.pool.query("SELECT expires_at FROM hub_branch_sessions WHERE id=$1", [f.session.id])).rows[0].expires_at;
      await a.authenticate(f.request);
      expect((await f.pool.query("SELECT expires_at FROM hub_branch_sessions WHERE id=$1", [f.session.id])).rows[0].expires_at).toEqual(before);
    } finally { await f.close(); }
  });

  it("rechecks live revocation, expiration, branch, assignment and eligibility within the activity window", async () => {
    const f = await fixture();
    try {
      const a = f.identity();
      await a.authenticate(f.request);
      for (const [sql, undo, code, status] of [
        ["UPDATE hub_branch_sessions SET revoked_at=now()", "UPDATE hub_branch_sessions SET revoked_at=NULL", "HUB_SESSION_EXPIRED", 401],
        ["UPDATE sessions SET revoked_at=now()", "UPDATE sessions SET revoked_at=NULL", "HUB_SESSION_EXPIRED", 401],
        ["UPDATE hub_branch_sessions SET expires_at=now()-interval '1 second'", "UPDATE hub_branch_sessions SET expires_at=now()+interval '1 hour'", "HUB_SESSION_EXPIRED", 401],
        ["UPDATE sessions SET expires_at=now()-interval '1 second'", "UPDATE sessions SET expires_at=now()+interval '1 day'", "HUB_SESSION_EXPIRED", 401],
        ["UPDATE hub_branches SET enabled=false", "UPDATE hub_branches SET enabled=true", "HUB_BRANCH_UNAUTHORIZED", 401],
        ["UPDATE links SET enabled=false", "UPDATE links SET enabled=true", "HUB_BRANCH_UNAUTHORIZED", 401],
        ["UPDATE link_assignments SET replaced_at=now()", "UPDATE link_assignments SET replaced_at=NULL", "HUB_BRANCH_UNAUTHORIZED", 403],
        ["UPDATE users SET status='suspended'", "UPDATE users SET status='active'", "FORBIDDEN", 403],
      ] as const) {
        await f.pool.query(sql);
        await expect(a.authenticate(f.request)).rejects.toMatchObject({ code, status });
        await f.pool.query(undo);
        await expect(a.authenticate(f.request)).resolves.toHaveProperty("sessionId", f.session.id);
      }
      expect(await f.writes()).toBe(1);
    } finally { await f.close(); }
  });
});
