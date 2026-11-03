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
  "Profile compaction budgets and atomic snapshots (isolated PostgreSQL)",
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
    it("reports exact chunk-expanded restore and snapshot bytes without changing data", async () => {
      const namespace = { kind: "local" as const, origin: "https://budget-" + randomUUID() + ".test" };
      const head = () => request("POST", "/api/hub/branch/profile/stream", { namespace, headOnly: true });
      expect((await head()).json()).toEqual({ revision: 0, snapshotRevision: 0, restoreBytes: 0, snapshotBytes: 0 });
      const writer = (await request("POST", "/api/hub/branch/profile/writers", { namespace })).json().writer;
      const snapshot = await encodePortableValue({ format: "atlas-local-snapshot-v1", revision: 1, entries: [["save", "x".repeat(600000)]] });
      const encoded = Buffer.from(JSON.stringify(snapshot)), hash = sha(encoded.toString());
      expect((await request("POST", "/api/hub/branch/profile/chunks", { hash, data: encoded.toString("base64") })).statusCode).toBe(200);
      const wire = { codec: "atlas-chunks-v1", bytes: encoded.length, sha256: hash, hashes: [hash] };
      const submit = (mode: string, payload: unknown, baseRevision: number, idempotencyKey = randomUUID()) => request("POST", "/api/hub/branch/profile/commits", { namespace, mode, payload, baseRevision, idempotencyKey, epoch: writer.epoch });
      expect((await submit("snapshot", wire, 0)).statusCode).toBe(200);
      const journal = await encodePortableValue({ revision: 2, change: { op: "set", key: "new", value: "data" } });
      expect((await submit("journal", journal, 1)).statusCode).toBe(200);
      const before = (await pool.query("SELECT revision,snapshot_revision,bytes,restore_bytes FROM hub_streams WHERE profile_id=$1 AND namespace=$2", [(await request("GET", "/api/hub/branch/profile")).json().profileId, hubNamespace(namespace).key])).rows;
      for (let i = 0; i < 3; i++) expect((await head()).json()).toEqual({ revision: 2, snapshotRevision: 1, snapshotBytes: encoded.length, restoreBytes: encoded.length + Buffer.byteLength(JSON.stringify(journal)) });
      const full = (await request("POST", "/api/hub/branch/profile/stream", { namespace })).json();
      expect(full.snapshot).toEqual(wire); expect(full.journal).toHaveLength(1); expect(full.journal[0].payload).toEqual(journal);
      const after = (await pool.query("SELECT revision,snapshot_revision,bytes,restore_bytes FROM hub_streams WHERE profile_id=$1 AND namespace=$2", [(await request("GET", "/api/hub/branch/profile")).json().profileId, hubNamespace(namespace).key])).rows;
      expect(after).toEqual(before);
    });
    it("snapshot CAS fences stale revisions and exact lost-response replay stays immutable after lease loss", async () => {
      const namespace = { kind: "local" as const, origin: "https://cas-" + randomUUID() + ".test" };
      const acquired = await request("POST", "/api/hub/branch/profile/writers", { namespace });
      const epoch = acquired.json().writer.epoch;
      const journal = await encodePortableValue({ revision: 1, change: { op: "set", key: "save", value: "latest" } });
      const submit = (v: any) => request("POST", "/api/hub/branch/profile/commits", { namespace, epoch, ...v });
      expect((await submit({ mode: "journal", payload: journal, baseRevision: 0, idempotencyKey: randomUUID() })).statusCode).toBe(200);
      const payload = await encodePortableValue({ format: "atlas-local-snapshot-v1", revision: 1, entries: [["save", "latest"]] });
      const body = { mode: "snapshot", payload, baseRevision: 1, idempotencyKey: "compact-" + randomUUID() };
      expect((await submit({ ...body, baseRevision: 0 })).statusCode).toBe(409);
      const result = await submit(body); expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ acknowledged: true, revision: 2, replayed: false });
      const takeover = await request("POST", "/api/hub/branch/profile/writers/takeover", { namespace }, headers2);
      const next = await request("POST", "/api/hub/branch/profile/writers", { namespace, handoffId: takeover.json().handoffId, useLatestBackup: true }, headers2);
      expect(next.statusCode).toBe(200); expect(next.json().writer.epoch).toBe(epoch + 1);
      const replay = await submit(body); expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ acknowledged: true, revision: 2, replayed: true });
      expect((await submit({ ...body, idempotencyKey: randomUUID(), baseRevision: 2 })).statusCode).toBe(409);
      expect((await submit({ ...body, payload: journal })).statusCode).toBe(409);
      const receipt = await request("GET", "/api/hub/branch/profile/receipts/" + body.idempotencyKey);
      expect(receipt.statusCode).toBe(200); expect(receipt.json()).toMatchObject({ acknowledged: true, revision: 2, mode: "snapshot", namespace: JSON.parse(hubNamespace(namespace).key) });
      const stream = (await request("POST", "/api/hub/branch/profile/stream", { namespace })).json();
      expect(stream.revision).toBe(2); expect(stream.snapshotRevision).toBe(2); expect(stream.snapshot).toEqual(payload); expect(stream.journal).toEqual([]);
    });
    it("automatic application sweep preserves recovery/current/fresh data, drops obsolete chunks and leaves immutable receipts", async () => {
      const namespace = { kind: "local" as const, origin: "https://retention-" + randomUUID() + ".test" };
      const owner = (await request("POST", "/api/hub/branch/profile/writers", { namespace })).json().writer;
      const profile = (await request("GET", "/api/hub/branch/profile")).json().profileId;
      const otherSession = await login("other");
      const otherProfile = otherSession.grant.profileId;
      async function wire(value: unknown, h = headers) {
        const graph = await encodePortableValue(value), encoded = Buffer.from(JSON.stringify(graph)), hash = sha(encoded.toString());
        expect((await request("POST", "/api/hub/branch/profile/chunks", { hash, data: encoded.toString("base64") }, h)).statusCode).toBe(200);
        return { codec: "atlas-chunks-v1", bytes: encoded.length, sha256: hash, hashes: [hash] };
      }
      const first = await wire({ format: "atlas-local-snapshot-v1", revision: 1, entries: [["save", "x".repeat(300000)]] });
      const firstBody = { namespace, epoch: owner.epoch, mode: "snapshot", baseRevision: 0, idempotencyKey: randomUUID(), payload: first };
      expect((await request("POST", "/api/hub/branch/profile/commits", firstBody)).statusCode).toBe(200);
      for (let revision = 2; revision <= 13; revision++) {
        const journal = await wire({ revision, change: { op: "set", key: "save", value: String(revision).repeat(32768) } });
        expect((await request("POST", "/api/hub/branch/profile/commits", { namespace, epoch: owner.epoch, mode: "journal", baseRevision: revision - 1, idempotencyKey: randomUUID(), payload: journal })).statusCode).toBe(200);
      }
      const before = Number((await pool.query("SELECT bytes FROM hub_profiles WHERE id=$1", [profile])).rows[0].bytes);
      const recovery = await wire({ format: "atlas-recovery-v1", snapshots: [], changes: [{ save: "unresolved".repeat(15000) }] });
      const recoveryId = randomUUID();
      expect((await request("POST", "/api/hub/branch/profile/recoveries", { id: recoveryId, namespace, payload: recovery })).statusCode).toBe(200);
      const other = await wire({ format: "atlas-recovery-v1", snapshots: [], changes: [{ save: "other-account" }] }, otherSession.headers);
      const otherRecoveryId = randomUUID();
      expect((await request("POST", "/api/hub/branch/profile/recoveries", { id: otherRecoveryId, namespace, payload: other }, otherSession.headers)).statusCode).toBe(200);
      const otherBefore = (await pool.query("SELECT bytes,revision FROM hub_profiles WHERE id=$1", [otherProfile])).rows[0];
      const latest = await encodePortableValue({ format: "atlas-local-snapshot-v1", revision: 13, entries: [["save", "latest"]] });
      expect((await request("POST", "/api/hub/branch/profile/commits", { namespace, epoch: owner.epoch, mode: "snapshot", baseRevision: 13, idempotencyKey: randomUUID(), payload: latest })).statusCode).toBe(200);
      const after = Number((await pool.query("SELECT bytes FROM hub_profiles WHERE id=$1", [profile])).rows[0].bytes);
      expect(after).toBeLessThan(before);
      const rows = (await pool.query("SELECT encrypted_payload,bytes FROM hub_commits WHERE profile_id=$1 AND namespace=$2", [profile, hubNamespace(namespace).key])).rows;
      expect(rows).toHaveLength(14); expect(rows.every(row => row.encrypted_payload === null && Number(row.bytes) === 0)).toBe(true);
      // All reference-bearing chunks are deliberately older than the grace too.
      // They must survive while obsolete chunks become collectible.
      const fresh = await wire({ save: "fresh-retry-not-yet-committed" });
      await pool.query("UPDATE hub_chunks SET created_at=now()-interval '25 hours' WHERE profile_id=ANY($1) AND hash<>$2", [[profile, otherProfile], fresh.hashes[0]]);
      const deadline = Date.now() + 65000;
      while (Date.now() < deadline) {
        if (!(await pool.query("SELECT 1 FROM hub_chunks WHERE profile_id=$1 AND hash=$2", [profile, first.hashes[0]])).rowCount) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect((await pool.query("SELECT 1 FROM hub_chunks WHERE profile_id=$1 AND hash=$2", [profile, first.hashes[0]])).rowCount).toBe(0);
      for (const hash of [recovery.hashes[0], fresh.hashes[0]]) expect((await pool.query("SELECT 1 FROM hub_chunks WHERE profile_id=$1 AND hash=$2", [profile, hash])).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM hub_chunks WHERE profile_id=$1 AND hash=$2", [otherProfile, other.hashes[0]])).rowCount).toBe(1);
      expect((await pool.query("SELECT bytes,revision FROM hub_profiles WHERE id=$1", [otherProfile])).rows[0]).toEqual(otherBefore);
      const restored = (await request("POST", "/api/hub/branch/profile/stream", { namespace })).json();
      expect(restored.snapshot).toEqual(latest); expect(restored.journal).toEqual([]);
      expect((await request("GET", "/api/hub/branch/profile/recoveries/" + recoveryId)).json().payload).toEqual(recovery);
      expect((await request("GET", "/api/hub/branch/profile/recoveries/" + otherRecoveryId)).statusCode).toBe(404);
      const receipt = await request("GET", "/api/hub/branch/profile/receipts/" + firstBody.idempotencyKey);
      expect(receipt.statusCode).toBe(200); expect(receipt.json().acknowledged).toBe(true);
      expect((await request("POST", "/api/hub/branch/profile/commits", firstBody)).json()).toMatchObject({ acknowledged: true, replayed: true, revision: 1 });
      const adminTelemetry = await request("GET", "/api/admin/performance", undefined, browser("admin"));
      expect(adminTelemetry.statusCode).toBe(200); expect(adminTelemetry.json().metrics["profile.gc"].outcomes.ok).toBeGreaterThan(0);
      console.info("RETENTION_PROOF", JSON.stringify({ canonicalBytesBeforeCheckpoint: before, canonicalBytesAfterCheckpointIncludingRecovery: after, retainedReceipts: rows.length, retainedSnapshotReceiptPayloads: rows.filter(row => row.encrypted_payload !== null).length, obsoleteInitialChunkRemoved: true, unresolvedRecoveryRetained: true, freshStagingRetained: true, otherProfileUnchanged: true, actualTimerRuns: adminTelemetry.json().metrics["profile.gc"].outcomes.ok }));
    }, 75000);
  },
);
