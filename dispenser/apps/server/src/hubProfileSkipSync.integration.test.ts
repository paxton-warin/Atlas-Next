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
  "Confirmed last saved version handoffs (isolated PostgreSQL)",
  () => {
    const schema = "hub_" + randomUUID().replaceAll("-", "");
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
    let fixtureClient = 0;
    async function request(
      method: any,
      path: string,
      body?: unknown,
      h = headers,
      remoteAddress?: string,
    ) {
      return app.inject({
        method,
        url: path,
        headers: h,
        ...(remoteAddress ? { remoteAddress } : {}),
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
        "198.51.100." + ++fixtureClient,
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
    const writersPath = "/api/hub/branch/profile/writers";
    const namespaceFor = () => ({ kind: "local", origin: "https://skip-" + randomUUID() + ".test" });
    async function waiting() {
      const a = await login(), b = await login(), namespace = namespaceFor();
      const acquired = await request("POST", writersPath, { namespace }, a.headers);
      expect(acquired.statusCode).toBe(200);
      const takeover = await request("POST", writersPath + "/takeover", { namespace }, b.headers);
      expect(takeover.statusCode).toBe(200);
      expect(takeover.json().status).toBe("waiting");
      return { a, b, namespace, epoch: acquired.json().writer.epoch as number, handoffId: takeover.json().handoffId as string };
    }
    const useBackup = (f: Awaited<ReturnType<typeof waiting>>, extra = {}, h = f.b.headers) => request("POST", writersPath, { namespace: f.namespace, handoffId: f.handoffId, useLatestBackup: true, ...extra }, h);
    const owner = async (f: Awaited<ReturnType<typeof waiting>>) => (await pool.query("SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2", [f.a.grant.profileId, hubSiteGroup(f.namespace.origin)])).rows[0];
    const ack = (f: Awaited<ReturnType<typeof waiting>>) => request("POST", `${writersPath}/requests/${f.handoffId}/ack`, { flushed: true }, f.a.headers);
    async function expireOwner(f: Awaited<ReturnType<typeof waiting>>) {
      await pool.query("UPDATE hub_writers SET expires_at=now()-interval '1 second' WHERE profile_id=$1 AND site_group=$2", [f.a.grant.profileId, hubSiteGroup(f.namespace.origin)]);
    }

    it("keeps the default handoff waiting until the source has acknowledged saving", async () => {
      const f = await waiting(), before = await owner(f);
      for (const extra of [{}, { useLatestBackup: false }]) {
        const response = await request("POST", writersPath, { namespace: f.namespace, handoffId: f.handoffId, ...extra }, f.b.headers);
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("HUB_CONFLICT");
      }
      expect(await owner(f)).toEqual(before);
      expect((await pool.query("SELECT status FROM hub_writer_handoffs WHERE id=$1", [f.handoffId])).rows[0].status).toBe("waiting");
    });

    it("rejects useLatestBackup without its exact handoff and rejects non-boolean options", async () => {
      const a = await login(), namespace = namespaceFor();
      for (const extra of [{ useLatestBackup: true }, { useLatestBackup: "true" }, { useLatestBackup: 1 }, { useLatestBackup: null }]) {
        const response = await request("POST", writersPath, { namespace, ...extra }, a.headers);
        expect(response.statusCode).toBe(400);
      }
      expect((await pool.query("SELECT count(*)::int n FROM hub_writers WHERE profile_id=$1 AND site_group=$2", [a.grant.profileId, hubSiteGroup(namespace.origin)])).rows[0].n).toBe(0);
    });

    it("a confirmed waiting handoff atomically fences the source without claiming a save acknowledgement", async () => {
      const f = await waiting(), response = await useBackup(f);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ writer: { contextId: f.b.grant.contextId, epoch: f.epoch + 1 }, takeover: true });
      expect(response.json()).not.toHaveProperty("acknowledged");
      expect((await owner(f)).session_id).toBe(f.b.grant.sessionId);
      expect((await pool.query("SELECT status FROM hub_writer_handoffs WHERE id=$1", [f.handoffId])).rows[0].status).toBe("used");
      const renewed = await request("PUT", writersPath, { namespace: f.namespace, epoch: f.epoch }, f.a.headers);
      expect(renewed.statusCode).toBe(409);
      expect(renewed.json().error.code).toBe("HUB_WRITER_LOST");
    });

    it("normal ready handoffs still work without the optional skip flag", async () => {
      const f = await waiting();
      expect((await ack(f)).json()).toEqual({ acknowledged: true });
      const response = await request("POST", writersPath, { namespace: f.namespace, handoffId: f.handoffId }, f.b.headers);
      expect(response.statusCode).toBe(200);
      expect(response.json().writer.epoch).toBe(f.epoch + 1);
    });

    it("the confirmed option also consumes an already-ready handoff", async () => {
      const f = await waiting();
      expect((await ack(f)).statusCode).toBe(200);
      const response = await useBackup(f);
      expect(response.statusCode).toBe(200);
      expect(response.json().writer.epoch).toBe(f.epoch + 1);
    });

    it("a different authenticated account cannot consume another profile's handoff", async () => {
      const f = await waiting(), other = await login("other"), before = await owner(f);
      expect((await useBackup(f, {}, other.headers)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("a different session in the same context cannot consume the request", async () => {
      const f = await waiting(), peer = await login("user", f.b.grant.contextId), before = await owner(f);
      expect(peer.grant.contextId).toBe(f.b.grant.contextId);
      expect(peer.grant.sessionId).not.toBe(f.b.grant.sessionId);
      expect((await useBackup(f, {}, peer.headers)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("the same authenticated session with a changed context cannot consume the request", async () => {
      const f = await waiting(), before = await owner(f);
      await pool.query("UPDATE hub_branch_sessions SET context_id=$2 WHERE id=$1", [f.b.grant.sessionId, randomUUID()]);
      try { expect((await useBackup(f)).statusCode).toBe(409); }
      finally { await pool.query("UPDATE hub_branch_sessions SET context_id=$2 WHERE id=$1", [f.b.grant.sessionId, f.b.grant.contextId]); }
      expect(await owner(f)).toEqual(before);
    });

    it("a different website group cannot reuse the confirmed handoff", async () => {
      const f = await waiting(), before = await owner(f);
      expect((await useBackup(f, { namespace: namespaceFor() })).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("an expired waiting handoff is not an override capability", async () => {
      const f = await waiting(), before = await owner(f);
      await pool.query("UPDATE hub_writer_handoffs SET expires_at=now()-interval '1 second' WHERE id=$1", [f.handoffId]);
      expect((await useBackup(f)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("a stale owner epoch cannot steal ownership from the newer browser", async () => {
      const f = await waiting(), newer = await login();
      await expireOwner(f);
      const acquired = await request("POST", writersPath, { namespace: f.namespace }, newer.headers);
      expect(acquired.statusCode).toBe(200);
      expect(acquired.json().writer.epoch).toBe(f.epoch + 1);
      const before = await owner(f);
      expect((await useBackup(f)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("the handoff must match the current owner context as well as epoch", async () => {
      const f = await waiting();
      await pool.query("UPDATE hub_writer_handoffs SET owner_context=$2 WHERE id=$1", [f.handoffId, randomUUID()]);
      const before = await owner(f);
      expect((await useBackup(f)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("unrepresentable epoch metadata cannot alias a different current owner epoch", async () => {
      const f = await waiting();
      await pool.query("UPDATE hub_writers SET epoch=9007199254740993 WHERE profile_id=$1 AND site_group=$2", [f.a.grant.profileId, hubSiteGroup(f.namespace.origin)]);
      await pool.query("UPDATE hub_writer_handoffs SET owner_epoch=9007199254740992 WHERE id=$1", [f.handoffId]);
      const before = await owner(f);
      expect((await useBackup(f)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("a lost success response retries the same exact writer epoch even after request expiry", async () => {
      const f = await waiting(), first = await useBackup(f);
      expect(first.statusCode).toBe(200);
      await pool.query("UPDATE hub_writer_handoffs SET expires_at=now()-interval '1 second' WHERE id=$1", [f.handoffId]);
      await expireOwner(f);
      const retry = await useBackup(f);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().writer.epoch).toBe(first.json().writer.epoch);
      expect(retry.json().writer.contextId).toBe(f.b.grant.contextId);
      expect(Date.parse(retry.json().writer.expiresAt)).toBeGreaterThan(Date.now());
      expect((await owner(f)).session_id).toBe(f.b.grant.sessionId);
    });

    it("an old successful request cannot replay after another writer acquires a newer epoch", async () => {
      const f = await waiting(), first = await useBackup(f), newer = await login();
      expect(first.statusCode).toBe(200);
      await expireOwner(f);
      const acquired = await request("POST", writersPath, { namespace: f.namespace }, newer.headers);
      expect(acquired.statusCode).toBe(200);
      expect(acquired.json().writer.epoch).toBe(f.epoch + 2);
      const before = await owner(f);
      expect((await useBackup(f)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(before);
    });

    it("two simultaneous copies of the same confirmation produce one new epoch", async () => {
      const f = await waiting(), responses = await Promise.all([useBackup(f), useBackup(f)]);
      expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
      expect(responses.map(r => r.json().writer.epoch)).toEqual([f.epoch + 1, f.epoch + 1]);
      expect(Number((await owner(f)).epoch)).toBe(f.epoch + 1);
    });

    it("competing confirmations cannot both consume the source epoch", async () => {
      const f = await waiting(), c = await login();
      const second = await request("POST", writersPath + "/takeover", { namespace: f.namespace }, c.headers);
      expect(second.statusCode).toBe(200);
      const responses = await Promise.all([useBackup(f), useBackup(f, { handoffId: second.json().handoffId }, c.headers)]);
      expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
      expect(Number((await owner(f)).epoch)).toBe(f.epoch + 1);
    });

    it("a racing normal completion and confirmed last-backup choice preserve fencing", async () => {
      const f = await waiting(), responses = await Promise.all([ack(f), useBackup(f)]);
      expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
      const before = await owner(f);
      expect(Number(before.epoch)).toBe(f.epoch + 1);
      expect(before.session_id).toBe(f.b.grant.sessionId);
      expect((await ack(f)).statusCode).toBe(200);
      expect(await owner(f)).toEqual(before);
    });

    it("last acknowledged backup bytes survive; late old ACK, fresh commit and renewal cannot replace them", async () => {
      const f = await waiting(), snapshot = { format: "atlas-local-snapshot-v1", revision: 1, entries: [["save", "acknowledged-checkpoint"]] };
      const canonical = await request("POST", "/api/hub/branch/profile/commits", { namespace: f.namespace, epoch: f.epoch, baseRevision: 0, idempotencyKey: randomUUID(), mode: "snapshot", payload: await encodePortableValue(snapshot) }, f.a.headers);
      expect(canonical.statusCode).toBe(200);
      const profileBefore = (await pool.query("SELECT revision,bytes FROM hub_profiles WHERE id=$1", [f.a.grant.profileId])).rows[0];
      const streamBefore = (await pool.query("SELECT * FROM hub_streams WHERE profile_id=$1 AND namespace=$2", [f.a.grant.profileId, hubNamespace(f.namespace as any).key])).rows[0];
      expect((await useBackup(f)).statusCode).toBe(200);
      const ownerBefore = await owner(f);
      expect((await ack(f)).statusCode).toBe(200);
      const late = await request("POST", "/api/hub/branch/profile/commits", { namespace: f.namespace, epoch: f.epoch, baseRevision: 1, idempotencyKey: randomUUID(), mode: "journal", payload: await encodePortableValue({ revision: 2, change: { op: "set", key: "save", value: "unuploaded-old-context" } }) }, f.a.headers);
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe("HUB_WRITER_LOST");
      expect((await request("PUT", writersPath, { namespace: f.namespace, epoch: f.epoch }, f.a.headers)).statusCode).toBe(409);
      expect(await owner(f)).toEqual(ownerBefore);
      expect((await pool.query("SELECT revision,bytes FROM hub_profiles WHERE id=$1", [f.a.grant.profileId])).rows[0]).toEqual(profileBefore);
      expect((await pool.query("SELECT * FROM hub_streams WHERE profile_id=$1 AND namespace=$2", [f.a.grant.profileId, hubNamespace(f.namespace as any).key])).rows[0]).toEqual(streamBefore);
      const restored = await request("POST", "/api/hub/branch/profile/stream", { namespace: f.namespace }, f.b.headers);
      expect(restored.statusCode).toBe(200);
      expect(restored.json().revision).toBe(1);
      expect(restored.json().journal).toEqual([]);
      expect(decodePortableValue(restored.json().snapshot)).toEqual(snapshot);
    });

    it("confirmed takeover leaves unrelated website writers and handoffs unchanged", async () => {
      const f = await waiting(), other = await waiting(), beforeOwner = await owner(other);
      const beforeHandoff = (await pool.query("SELECT * FROM hub_writer_handoffs WHERE id=$1", [other.handoffId])).rows[0];
      expect((await useBackup(f)).statusCode).toBe(200);
      expect(await owner(other)).toEqual(beforeOwner);
      expect((await pool.query("SELECT * FROM hub_writer_handoffs WHERE id=$1", [other.handoffId])).rows[0]).toEqual(beforeHandoff);
    });
  },
);
