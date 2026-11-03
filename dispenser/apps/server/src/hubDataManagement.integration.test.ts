import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";
import {
  encodePortableValue,
  hubNamespace,
  decodePortableValue,
  hubSiteGroup,
} from "@atlas-link-dispenser/shared";
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
integration(
  "User cloud-data deletion and administrator account removal (isolated PostgreSQL)",
  () => {
    const schema = "hubdelete_" + randomUUID().replaceAll("-", "");
    let maintenance: Pool,
      pool: Pool,
      app: Awaited<ReturnType<typeof buildApp>>["app"];
    const secret = randomUUID(),
      csrf = "fixture-csrf-" + secret;
    let userId: string,
      otherId: string,
      branch: any,
      headers: any,
      headers2: any;
    const browser = (label = "user") => ({
      cookie: "ald_session=" + secret + label,
      "x-csrf-token": csrf,
    });
    async function request(
      method: any,
      path: string,
      body?: unknown,
      h = headers,
    ) {
      return app.inject({
        method,
        url: path,
        headers: h,
        ...(body === undefined ? {} : { payload: body as any }),
      });
    }
    async function login(label = "user", contextId = randomUUID()) {
      const verifier =
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const codeChallenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const handoff = await request(
        "POST",
        "/api/hub/handoffs",
        {
          branchId: branch.id,
          codeChallenge,
          state: "fixture-state-123456789",
        },
        browser(label),
      );
      expect(handoff.statusCode).toBe(200);
      const exchanged = await request(
        "POST",
        "/api/hub/branch/exchange",
        { code: handoff.json().code, verifier, contextId },
        {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
        },
      );
      expect(exchanged.statusCode).toBe(200);
      return {
        headers: {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
          "x-atlas-branch-session": exchanged.json().branchSession,
        },
        grant: exchanged.json().grant,
        code: handoff.json().code,
        verifier,
      };
    }
    beforeAll(async () => {
      if (!new URL(url!).pathname.endsWith("_test"))
        throw Error("Dedicated _test PostgreSQL required");
      maintenance = new Pool({ connectionString: url });
      const extensionSetup = await maintenance.connect();
      try {
        await extensionSetup.query("SELECT pg_advisory_lock(870412201)");
        await extensionSetup.query(
          "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
        );
        const extension = await extensionSetup.query(
          "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname='pgcrypto'",
        );
        if (extension.rows[0]?.schema !== "public")
          await extensionSetup.query(
            "ALTER EXTENSION pgcrypto SET SCHEMA public",
          );
      } finally {
        await extensionSetup.query("SELECT pg_advisory_unlock(870412201)");
        extensionSetup.release();
      }
      await maintenance.query("CREATE SCHEMA " + schema);
      pool = new Pool({
        connectionString: url,
        options: "-c search_path=" + schema + ",public",
      });
      for (const file of (
        await readdir(
          resolve(import.meta.dirname, "../../../packages/database/migrations"),
        )
      )
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(
          await readFile(
            resolve(
              import.meta.dirname,
              "../../../packages/database/migrations",
              file,
            ),
            "utf8",
          ),
        );
      for (const [label, role] of [
        ["admin", "admin"],
        ["user", "user"],
        ["other", "user"],
      ]) {
        const r = (
          await pool.query(
            "INSERT INTO users(email,normalized_email,role,verified_at)VALUES($1,$1,$2::role,now())RETURNING id",
            [label + "@example.test", role],
          )
        ).rows[0];
        if (label === "user") userId = r.id;
        if (label === "other") otherId = r.id;
        await pool.query(
          "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 day')",
          [
            r.id,
            hashSecret(secret + label, config.sessionSecret),
            hashSecret(csrf, config.sessionSecret),
          ],
        );
      }
      const redis = {
        status: "ready",
        ping: async () => "PONG",
        incr: async () => 1,
        expire: async () => 1,
      };
      app = (await buildApp({ pool, redis: redis as any, hubEnabled: true }))
        .app;
      await app.ready();
      const link = (
        await pool.query(
          "INSERT INTO links(name,url,health_status)VALUES('Fixture branch','https://branch.example.test','healthy')RETURNING id",
        )
      ).rows[0];
      for (const id of [userId, otherId])
        await pool.query(
          "INSERT INTO link_assignments(user_id,link_id)VALUES($1,$2)",
          [id, link.id],
        );
      const enrolled = await request(
        "POST",
        "/api/admin/hub/branches",
        { linkId: link.id },
        browser("admin"),
      );
      expect(enrolled.statusCode).toBe(200);
      branch = { ...enrolled.json().branch, secret: enrolled.json().secret };
      headers = (await login()).headers;
      headers2 = (await login()).headers;
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await maintenance?.query("DROP SCHEMA " + schema + " CASCADE");
      await maintenance?.end();
    });

    it("requires sign-in, CSRF, typed confirmation and the exact own profile", async () => {
      const own = (await login()).grant.profileId, other = (await login("other")).grant.profileId;
      expect((await request("DELETE", "/api/hub/profile", {profileId:own,confirmation:"DELETE"}, {})).statusCode).toBe(401);
      expect((await request("DELETE", "/api/hub/profile", {profileId:own,confirmation:"DELETE"}, {cookie:browser().cookie})).statusCode).toBe(403);
      expect((await request("DELETE", "/api/hub/profile", {profileId:own,confirmation:"no"}, browser())).statusCode).toBe(400);
      expect((await request("DELETE", "/api/hub/profile", {profileId:other,confirmation:"DELETE"}, browser())).statusCode).toBe(409);
      expect((await pool.query("SELECT id FROM hub_profiles WHERE id=ANY($1::uuid[])", [[own,other]])).rowCount).toBe(2);
    });
    it("atomically deletes only the confirmed profile and invalidates old browser grants", async () => {
      const a=await login(), other=await login("other"), id=a.grant.profileId;
      await pool.query("INSERT INTO hub_streams(profile_id,namespace,encrypted_payload,bytes)VALUES($1,'fixture','opaque',6)",[id]);
      await pool.query("INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes)VALUES($1,$2,'opaque',6)",[id,"a".repeat(64)]);
      const response=await request("DELETE", "/api/hub/profile", {profileId:id,confirmation:"DELETE"}, browser());
      expect(response.statusCode).toBe(200);expect(response.json()).toEqual({acknowledged:true,deleted:true,localDeviceDataErased:false});
      for(const table of ["hub_profiles","hub_streams","hub_chunks","hub_branch_sessions"]){const column=table==="hub_profiles"?"id":"profile_id";expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[id])).rowCount).toBe(0);}
      expect((await request("GET", "/api/hub/branch/profile", undefined,a.headers)).statusCode).toBe(401);
      expect((await pool.query("SELECT id FROM hub_profiles WHERE id=$1",[other.grant.profileId])).rowCount).toBe(1);
      expect((await pool.query("SELECT id FROM users WHERE id=$1",[userId])).rowCount).toBe(1);
      expect((await pool.query("SELECT id FROM link_assignments WHERE user_id=$1",[userId])).rowCount).toBeGreaterThan(0);
      expect((await request("GET","/api/hub/profile",undefined,browser())).json().profile).toBeNull();
      expect((await pool.query("SELECT id FROM audit_events WHERE action='profile.delete' AND target_id=$1",[id])).rowCount).toBe(1);
      const next=await login();expect(next.grant.profileId).not.toBe(id);
      expect((await request("DELETE", "/api/hub/profile", {profileId:id,confirmation:"DELETE"}, browser())).statusCode).toBe(409);
      expect((await pool.query("SELECT id FROM hub_profiles WHERE id=$1",[next.grant.profileId])).rowCount).toBe(1);
    });
    it("retains the entire profile when deletion audit fails, rather than returning a false partial success", async () => {
      const id=(await login()).grant.profileId;
      await pool.query("CREATE FUNCTION reject_profile_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='profile.delete' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_profile_delete_audit()");
      try {expect((await request("DELETE", "/api/hub/profile", {profileId:id,confirmation:"DELETE"}, browser())).statusCode).toBe(500);expect((await pool.query("SELECT id FROM hub_profiles WHERE id=$1",[id])).rowCount).toBe(1);expect((await pool.query("SELECT id FROM hub_branch_sessions WHERE profile_id=$1",[id])).rowCount).toBeGreaterThan(0);}
      finally {await pool.query("DROP TRIGGER fixture_audit_failure ON audit_events; DROP FUNCTION reject_profile_delete_audit()");}
    });
    it("uses the established administrator deletion permission and protects administrator accounts", async () => {
      expect((await request("DELETE", "/api/admin/users/"+otherId,undefined,browser())).statusCode).toBe(403);
      const admin=(await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0].id;
      expect((await request("DELETE", "/api/admin/users/"+admin,undefined,browser("admin"))).statusCode).toBe(400);
      const response=await request("DELETE", "/api/admin/users/"+otherId,undefined,browser("admin"));expect(response.statusCode).toBe(200);expect(response.json().ok).toBe(true);
      expect((await pool.query("SELECT id FROM users WHERE id=$1",[otherId])).rowCount).toBe(0);
      expect((await pool.query("SELECT id FROM hub_profiles WHERE user_id=$1",[otherId])).rowCount).toBe(0);
      expect((await pool.query("SELECT id FROM users WHERE id=$1",[userId])).rowCount).toBe(1);
    });
  },
);
