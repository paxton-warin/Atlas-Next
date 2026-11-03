import { provisionBackupCatalogTestIndexes } from "./hubBackupsV2Readiness.js";
import Fastify from "fastify";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  encodePortableValue,
  decodePortableValue,
  hubNamespace,
  canonicalBackupJson,
  backupManifestIdentity,
  type BackupCheckpointV2,
} from "@atlas-link-dispenser/shared";
import {
  registerHubBackupsV2Routes,
  runBackupMaintenanceSlice,
  withBackupTransaction,
  resolvedCTE,
  collectBackupGarbageSlice,
} from "./hubBackupsV2.js";
import { runBackupMaintenanceBurst } from "./hubBackupsV2Maintenance.js";
import { prepareBackupCatalog } from "./hubBackupsV2Catalog.js";
import {
  acquireRestorePin,
  renewRestorePins,
  releaseRestorePin,
  collectExpiredRestorePins,
  restoreReaderId,
} from "./hubBackupsV2RestorePins.js";
import { profileUsage } from "./hubProfilePolicy.js";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import {
  registerHubLegacyConversionRoutes,
  runLegacyConversionJob,
} from "./hubBackupsV2Legacy.js";
import {
  runBackupAccountingSlice,
  runBackupAccountingActivation,
} from "./hubBackupsV2Accounting.js";
import { encrypt } from "./security.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
run(
  "Independent immutable catalog reference races — isolated PostgreSQL",
  () => {
    let admin: Pool, pool: Pool, app: ReturnType<typeof Fastify>;
    const schema = "backuprefs_" + randomUUID().replaceAll("-", ""),
      user = randomUUID(),
      profile = randomUUID(),
      branch = randomUUID(),
      session = randomUUID(),
      context = randomUUID();
    const namespace = {
        kind: "idb" as const,
        origin: "https://save.example",
        name: "saves",
      },
      master = "isolated-fixture-master",
      key = "isolated-fixture-profile";
    const sessionValue = {
      protocol: 1 as const,
      userId: user,
      profileId: profile,
      branchId: branch,
      sessionId: session,
      contextId: context,
      expiresAt: Date.now() + 86400000,
      grantExpiresAt: Date.now() + 86400000,
    };
    const root = "/api/hub/branch/profile/backups/v2";
    beforeAll(async () => {
      if (
        !["localhost", "127.0.0.1"].includes(new URL(url!).hostname) ||
        !new URL(url!).pathname.endsWith("_test")
      )
        throw Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
      admin = new Pool({ connectionString: url });
      await admin.query("CREATE SCHEMA " + schema);
      pool = new Pool({
        connectionString: url,
        max: 8,
        application_name: schema,
        options: "-c search_path=" + schema + ",public",
      });
      await pool.query(
        "CREATE TABLE users(id uuid PRIMARY KEY,email text,normalized_email text);CREATE TABLE links(id uuid PRIMARY KEY);CREATE TABLE sessions(id uuid PRIMARY KEY);CREATE TABLE audit_events(id serial PRIMARY KEY,admin_id uuid,action text,target_type text,target_id text,after jsonb)",
      );
      for (const file of [
        "0009_hub_core.sql",
        "0013_hub_writer_handoff.sql",
        "0015_hub_profile_recovery.sql",
        "0016_hub_profile_policy.sql",
        "0018_hub_stream_budget.sql",
        "0019_hub_profile_delete_refs.sql",
        "0025_hub_backups_v2.sql",
        "0026_hub_backup_catalog_scalability.sql",
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
      await provisionBackupCatalogTestIndexes(pool);
      await pool.query("INSERT INTO users VALUES($1,$2,$2)", [
        user,
        "member@example.test",
      ]);
      await pool.query("INSERT INTO links VALUES($1)", [branch]);
      await pool.query("INSERT INTO sessions VALUES($1)", [session]);
      await pool.query(
        "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$1,$2,$3)",
        [branch, "https://branch.example", "0".repeat(64)],
      );
      await pool.query(
        "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,$3,true)",
        [profile, user, encrypt(key, master)],
      );
      app = Fastify({ logger: false });
      app.setErrorHandler((e: any, _r: any, reply: any) =>
        reply
          .code(e.status || e.statusCode || 500)
          .send({ error: { code: e.code, message: e.message } }),
      );
      registerHubBackupsV2Routes(app, {
        pool,
        identity: { authenticate: async () => sessionValue } as any,
        encryptionKey: master,
        maintenance: false,
      });
      registerHubLegacyConversionRoutes(app, {
        pool,
        identity: { authenticate: async () => sessionValue } as any,
        encryptionKey: master,
        startWorker: false,
      });
      registerHubProfileRoutes(app, {
        pool,
        identity: { authenticate: async () => sessionValue } as any,
        encryptionKey: master,
      });
      await app.ready();
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE hub_backup_catalog_pages,hub_backup_replicas,hub_backup_parts,hub_backup_jobs,hub_streams,hub_profile_recoveries,hub_profile_chunk_refs,hub_chunks,hub_commits,hub_writers CASCADE",
      );
      await pool.query(
        "UPDATE hub_profiles SET bytes=0,backup_v2_bytes=0,backup_v2_staging_bytes=0,backup_v2_staging_parts=0,backup_v2_migration_credit=0,backup_v1_canonical_bytes=0,backup_v1_staging_bytes=0,backup_v1_staging_chunks=0,backup_accounting_version=1,backup_accounting_epoch=0",
      );
      await pool.query(
        "INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '1 day') ON CONFLICT(id) DO NOTHING",
        [session, user, profile, branch, "1".repeat(64), context],
      );
      await pool.query(
        "UPDATE hub_profile_policy_defaults SET profile_bytes=$1",
        [256 * 1024 * 1024],
      );
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (admin) {
        await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        await admin.end();
      }
    });
    async function register(seedCheckpointId?: string, label = "Test Chrome") {
      const b = {
        replicaId: randomUUID(),
        incarnation: randomUUID(),
        label,
        ...(seedCheckpointId ? { seedCheckpointId } : {}),
      };
      const response = await app.inject({
        method: "POST",
        url: root + "/replicas",
        payload: b,
      });
      expect(response.statusCode, response.body).toBe(200);
      return b;
    }
    async function make(
      replica: { replicaId: string; incarnation: string },
      options: {
        sequence?: number;
        parent?: BackupCheckpointV2;
        records?: any[];
        kind?: "baseline" | "delta" | "deleted";
        value?: any;
        cut?: number;
      } = {},
    ) {
      const id = randomUUID(),
        records = options.records || [
          {
            operation: "put",
            store: "items",
            storeEpoch: 0,
            key: { t: "string", v: "save" },
            value: await encodePortableValue(options.value ?? { score: 5 }),
            generation: options.cut || 1,
          },
        ];
      const parts: Buffer[] = [],
        metadata: any[] = [];
      for (const record of options.kind === "deleted" ? [] : records) {
        const raw = Buffer.from(canonicalBackupJson(record)),
          recordId = hash(
            canonicalBackupJson({
              namespace,
              store: record.store,
              key: record.key || null,
              operationKey:
                record.operation === "schema"
                  ? "schema"
                  : record.operation === "clear-store"
                    ? "clear"
                    : "record",
            }),
          );
        const page = Buffer.from(
          JSON.stringify({
            format: "atlas-record-page-v2",
            namespaceVersionId: id,
            records: [
              {
                recordId,
                index: 0,
                count: 1,
                totalBytes: raw.length,
                sha256: hash(raw),
                data: raw.toString("base64"),
              },
            ],
          }),
        );
        parts.push(page);
        metadata.push({
          ordinal: metadata.length,
          sha256: hash(page),
          bytes: page.length,
        });
      }
      const m: BackupCheckpointV2 = {
        format: "atlas-checkpoint-v2",
        checkpointId: randomUUID(),
        replicaId: replica.replicaId,
        incarnation: replica.incarnation,
        sequence:
          options.sequence ||
          (options.parent ? options.parent.sequence + 1 : 1),
        parentCheckpointId: options.parent?.checkpointId || null,
        adoptedThrough: options.parent?.sequence || 0,
        manifestDigest: "",
        namespaces: [
          {
            namespace,
            namespaceVersionId: id,
            parentNamespaceVersionId:
              options.kind === "delta"
                ? options.parent!.namespaces[0].namespaceVersionId
                : null,
            localCut: options.cut || mCut(options.parent),
            schemaEpoch: 1,
            kind: options.kind || "baseline",
            coverage: "complete-at-cut",
            rootDigest: hash(canonicalBackupJson(metadata)),
            parts: metadata,
          },
        ],
      };
      m.manifestDigest = hash(backupManifestIdentity(m));
      return { m, parts };
    }
    function mCut(p?: BackupCheckpointV2) {
      return p ? p.namespaces[0].localCut + 1 : 1;
    }
    async function prepare(m: BackupCheckpointV2) {
      return app.inject({
        method: "POST",
        url: root + "/replicas/" + m.replicaId + "/checkpoints",
        payload: m,
      });
    }
    async function upload(b: Awaited<ReturnType<typeof make>>) {
      for (const part of b.parts) {
        const r = await app.inject({
          method: "PUT",
          url: root + "/staging/" + b.m.checkpointId + "/parts/" + hash(part),
          headers: { "content-type": "application/octet-stream" },
          payload: part,
        });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().acknowledged).toBeUndefined();
      }
    }
    async function publish(b: Awaited<ReturnType<typeof make>>) {
      const p = await prepare(b.m);
      expect(p.statusCode, p.body).toBe(200);
      await upload(b);
      const r = await app.inject({
        method: "POST",
        url: root + "/staging/" + b.m.checkpointId + "/publish",
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    }
    function tombstone(
      replica: any,
      parent: BackupCheckpointV2 | undefined,
      indices: number[],
    ): BackupCheckpointV2 {
      const m: BackupCheckpointV2 = {
        format: "atlas-checkpoint-v2",
        checkpointId: randomUUID(),
        replicaId: replica.replicaId,
        incarnation: replica.incarnation,
        sequence: (parent?.sequence || 0) + 1,
        parentCheckpointId: parent?.checkpointId || null,
        adoptedThrough: parent?.sequence || 0,
        manifestDigest: "",
        namespaces: indices.map((i) => ({
          namespace: {
            kind: "local",
            origin: "https://n" + String(i).padStart(4, "0") + ".many.example",
          },
          namespaceVersionId: randomUUID(),
          parentNamespaceVersionId: null,
          kind: "baseline" as const,
          localCut: (parent?.sequence || 0) + 1,
          schemaEpoch: 1,
          parts: [],
          rootDigest: hash("[]"),
          coverage: "complete-at-cut" as const,
        })),
      };
      m.manifestDigest = hash(backupManifestIdentity(m));
      return m;
    }
    async function publishManifest(m: BackupCheckpointV2) {
      return publish({ m, parts: [] });
    }
    async function pages(id: string) {
      let cursor: string | undefined,
        namespaces: any[] = [],
        rootDigest: string | undefined;
      do {
        const r = await app.inject({
          url:
            root +
            "/checkpoints/" +
            id +
            "/namespaces" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        });
        expect(r.statusCode, r.body).toBe(200);
        expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(65536);
        const p = r.json();
        expect(p.checkpointId).toBe(id);
        expect(p.namespaces.length).toBeLessThanOrEqual(32);
        if (rootDigest) expect(p.rootDigest).toBe(rootDigest);
        rootDigest = p.rootDigest;
        namespaces.push(...p.namespaces);
        cursor = p.nextCursor;
      } while (cursor);
      return namespaces;
    }

    async function gc(slices = 1) {
      for (let i = 0; i < slices; i++)
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          collectBackupGarbageSlice(c, pool, { profileId: profile }),
        );
    }
    async function pinLease(
      id: string,
      actor: {
        branchId: string;
        sessionId: string;
        contextId: string;
      } = sessionValue,
    ) {
      return (
        await pool.query(
          "SELECT lease_id FROM hub_backup_restore_pins WHERE profile_id=$1 AND checkpoint_id=$2 AND reader_id=$3 ORDER BY expires_at DESC LIMIT 1",
          [profile, id, restoreReaderId(actor)],
        )
      ).rows[0].lease_id as string;
    }
    async function exactCounters() {
      const totals = (
        await pool.query(
          `SELECT COALESCE(sum(bytes) FILTER(WHERE published_refs>0),0)::bigint canonical,COALESCE(sum(bytes) FILTER(WHERE published_refs=0),0)::bigint staging,count(*) FILTER(WHERE published_refs=0)::int staging_parts FROM hub_backup_parts WHERE profile_id=$1`,
          [profile],
        )
      ).rows[0];
      const p = (
        await pool.query("SELECT * FROM hub_profiles WHERE id=$1", [profile])
      ).rows[0];
      expect(Number(p.backup_v2_bytes)).toBe(Number(totals.canonical));
      expect(Number(p.backup_v2_staging_bytes)).toBe(Number(totals.staging));
      expect(Number(p.backup_v2_staging_parts)).toBe(
        Number(totals.staging_parts),
      );
      expect(Number(p.bytes)).toBe(
        Number(p.backup_v1_canonical_bytes) +
          Math.max(
            0,
            Number(totals.canonical) - Number(p.backup_v2_migration_credit),
          ),
      );
      const mismatches = await pool.query(
        `SELECT p.hash,p.published_refs,count(r.hash) FILTER(WHERE r.ref_held OR cp.catalog_version=0 AND cp.status='complete') expected FROM hub_backup_parts p LEFT JOIN hub_backup_checkpoint_parts r USING(profile_id,hash) LEFT JOIN hub_backup_checkpoints cp ON cp.profile_id=r.profile_id AND cp.checkpoint_id=r.checkpoint_id WHERE p.profile_id=$1 GROUP BY p.hash,p.published_refs HAVING p.published_refs<>count(r.hash) FILTER(WHERE r.ref_held OR cp.catalog_version=0 AND cp.status='complete')`,
        [profile],
      );
      expect(mismatches.rows).toEqual([]);
      const brokenHeads = await pool.query(
        `SELECT r.replica_id FROM hub_backup_replicas r LEFT JOIN hub_backup_checkpoints cp ON cp.profile_id=r.profile_id AND cp.checkpoint_id=r.head_checkpoint_id WHERE r.profile_id=$1 AND r.deleted_at IS NULL AND r.head_checkpoint_id IS NOT NULL AND cp.status IS DISTINCT FROM 'complete'`,
        [profile],
      );
      expect(brokenHeads.rows).toEqual([]);
    }
    it("protects seed registration against concurrent replica retirement and GC between source lookup and seed INSERT", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      const blocker = await pool.connect(),
        lockKey = 911237;
      await pool.query(
        `CREATE FUNCTION pause_seed_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.label='paused-seed' THEN PERFORM set_config('lock_timeout','2000ms',true); PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END$$;CREATE TRIGGER pause_seed_insert BEFORE INSERT ON hub_backup_replicas FOR EACH ROW EXECUTE FUNCTION pause_seed_insert()`,
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
      const b = {
        replicaId: randomUUID(),
        incarnation: randomUUID(),
        label: "paused-seed",
        seedCheckpointId: first.m.checkpointId,
      };
      const pending = app.inject({
        method: "POST",
        url: root + "/replicas",
        payload: b,
      });
      let registration;
      try {
        for (let n = 0; n < 100; n++) {
          const waiting = (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO hub_backup_replicas%'`,
              [schema],
            )
          ).rowCount;
          if (waiting) break;
          if (n === 99) throw Error("SEED_REGISTRATION_DID_NOT_REACH_GATE");
          await new Promise((r) => setTimeout(r, 5));
        }
        const remove = await app.inject({
          method: "DELETE",
          url: root + "/replicas/" + a.replicaId,
        });
        expect(remove.statusCode, remove.body).toBe(503);
        await gc(3);
        expect(
          (
            await pool.query(
              "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
              [first.m.checkpointId],
            )
          ).rows[0].status,
        ).toBe("complete");
        expect(
          (
            await pool.query(
              "SELECT published_refs FROM hub_backup_parts WHERE hash=$1",
              [hash(first.parts[0])],
            )
          ).rows[0].published_refs,
        ).toBe("1");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        registration = await pending;
        await pool.query(
          "DROP TRIGGER pause_seed_insert ON hub_backup_replicas;DROP FUNCTION pause_seed_insert()",
        );
      }
      expect(registration.statusCode, registration.body).toBe(200);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: root + "/replicas/" + a.replicaId,
          })
        ).statusCode,
      ).toBe(200);
      await gc(12);
      await exactCounters();
      expect(
        (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
          .rawPayload,
      ).toEqual(first.parts[0]);
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("complete");
    });
    it("releases cancelled prepared inherited holds exactly once without charging or deleting the protected latest", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      await exactCounters();
      for (let n = 0; n < 6; n++) {
        const next = tombstone(a, first.m, [100 + n]);
        expect((await prepare(next)).statusCode).toBe(200);
        await prepareBackupCatalog(
          (work) =>
            withBackupTransaction(pool, new AbortController().signal, work),
          profile,
          next.checkpointId,
          resolvedCTE,
          new AbortController().signal,
        );
        expect(
          Number(
            (
              await pool.query(
                "SELECT published_refs FROM hub_backup_parts WHERE hash=$1",
                [hash(first.parts[0])],
              )
            ).rows[0].published_refs,
          ),
        ).toBe(2);
        await exactCounters();
        expect(
          (
            await app.inject({
              method: "DELETE",
              url: root + "/staging/" + next.checkpointId,
            })
          ).statusCode,
        ).toBe(200);
        await Promise.all(Array.from({ length: 4 }, () => gc(4)));
        await exactCounters();
        expect(
          Number(
            (
              await pool.query(
                "SELECT published_refs FROM hub_backup_parts WHERE hash=$1",
                [hash(first.parts[0])],
              )
            ).rows[0].published_refs,
          ),
        ).toBe(1);
        expect(
          (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
            .rawPayload,
        ).toEqual(first.parts[0]);
      }
    });
    it("keeps latest checkpoints of independent replicas after concurrent publish/cancel/delete and bounded GC", async () => {
      const a = await register(),
        b = await register(),
        first = await make(a, { value: "A" }),
        second = await make(b, { value: "B" });
      await publish(first);
      await publish(second);
      await exactCounters();
      for (let n = 0; n < 5; n++) {
        const pending = await make(a, {
          parent: first.m,
          value: "pending-" + n,
        });
        expect((await prepare(pending.m)).statusCode).toBe(200);
        await upload(pending);
        const responses = await Promise.all([
          app.inject({
            method: "POST",
            url: root + "/staging/" + pending.m.checkpointId + "/publish",
          }),
          app.inject({
            method: "DELETE",
            url: root + "/staging/" + pending.m.checkpointId,
          }),
        ]);
        expect(responses.some((r) => r.statusCode === 200)).toBe(true);
        for (const r of responses) expect([200, 409]).toContain(r.statusCode);
        await gc(12);
        await exactCounters();
        const head = (
          await pool.query(
            "SELECT head_checkpoint_id FROM hub_backup_replicas WHERE replica_id=$1",
            [a.replicaId],
          )
        ).rows[0].head_checkpoint_id;
        if (head === pending.m.checkpointId) break;
      }
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [second.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("complete");
      expect(
        (await app.inject({ url: root + "/parts/" + hash(second.parts[0]) }))
          .rawPayload,
      ).toEqual(second.parts[0]);
      await exactCounters();
    });
    it("protects every live replica head while pruning a large same-day backlog in committed200ms bursts", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      await pool.query(
        `INSERT INTO hub_backup_checkpoints(profile_id,checkpoint_id,replica_id,sequence,manifest_digest,manifest,status,catalog_version,catalog_ready,catalog_count,catalog_digest,publication_ordinal,receipt,history_day) SELECT $1,gen_random_uuid(),$2,n,$3,'{}','complete',1,true,0,$3,n,'{}',CURRENT_DATE FROM generate_series(2,650)n`,
        [profile, a.replicaId, "a".repeat(64)],
      );
      await pool.query(
        `UPDATE hub_backup_replicas SET head_sequence=650,head_checkpoint_id=(SELECT checkpoint_id FROM hub_backup_checkpoints WHERE profile_id=$1 AND sequence=650),adopted_through=650 WHERE profile_id=$1 AND replica_id=$2`,
        [profile, a.replicaId],
      );
      // A deterministic tiny per-row latency makes unbounded512-retirement transactions exceed the burst budget.
      await pool.query(
        `CREATE FUNCTION bounded_retention_probe() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.status='complete' AND NEW.status='retired' THEN PERFORM pg_sleep(0.002); END IF; RETURN NEW; END$$;CREATE TRIGGER bounded_retention_probe BEFORE UPDATE ON hub_backup_checkpoints FOR EACH ROW EXECUTE FUNCTION bounded_retention_probe()`,
      );
      try {
        for (let n = 0; n < 4; n++) {
          await runBackupMaintenanceBurst(pool, { budgetMs: 200 });
          await new Promise((r) => setTimeout(r, 5));
        }
        const counts = (
          await pool.query(
            `SELECT count(*) FILTER(WHERE status='complete')::int complete,count(*) FILTER(WHERE status='retired')::int retired FROM hub_backup_checkpoints WHERE profile_id=$1`,
            [profile],
          )
        ).rows[0];
        expect(counts.complete).toBeLessThan(650);
        expect(counts.complete).toBeGreaterThanOrEqual(1);
        expect(
          (
            await pool.query(
              "SELECT cp.status FROM hub_backup_replicas r JOIN hub_backup_checkpoints cp ON cp.checkpoint_id=r.head_checkpoint_id WHERE r.replica_id=$1",
              [a.replicaId],
            )
          ).rows[0].status,
        ).toBe("complete");
        await exactCounters();
      } finally {
        await pool.query(
          "DROP TRIGGER bounded_retention_probe ON hub_backup_checkpoints;DROP FUNCTION bounded_retention_probe()",
        );
      }
    }, 15000);
    it("upgrades a retained flat completed catalog to COW without double charge or losing inherited immutable parts", async () => {
      const a = await register(),
        first = await make(a, { value: "flat-compatible-save" });
      expect((await prepare(first.m)).statusCode).toBe(200);
      await pool.query(
        "UPDATE hub_backup_checkpoints SET catalog_version=0,catalog_cursor=NULL WHERE checkpoint_id=$1",
        [first.m.checkpointId],
      );
      await upload(first);
      const legacy = await app.inject({
        method: "POST",
        url: root + "/staging/" + first.m.checkpointId + "/publish",
      });
      expect(legacy.statusCode, legacy.body).toBe(200);
      await exactCounters();
      const upgraded = tombstone(a, first.m, [50]);
      await publishManifest(upgraded);
      await exactCounters();
      await Promise.all(Array.from({ length: 3 }, () => gc(12)));
      await exactCounters();
      expect((await pages(upgraded.checkpointId)).length).toBe(2);
      expect(
        (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
          .rawPayload,
      ).toEqual(first.parts[0]);
      const p = (
        await pool.query(
          "SELECT backup_v2_bytes,backup_v2_staging_bytes FROM hub_profiles WHERE id=$1",
          [profile],
        )
      ).rows[0];
      expect(Number(p.backup_v2_bytes)).toBe(first.parts[0].length);
      expect(Number(p.backup_v2_staging_bytes)).toBe(0);
      expect(
        Number(
          (
            await pool.query(
              "SELECT published_refs FROM hub_backup_parts WHERE hash=$1",
              [hash(first.parts[0])],
            )
          ).rows[0].published_refs,
        ),
      ).toBe(1);
    });

    it("deletes profile-scoped COW and rollup pins atomically and rejects a stale prepared publisher afterward", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      await withBackupTransaction(pool, new AbortController().signal, (c) =>
        acquireRestorePin(c, sessionValue, first.m.checkpointId),
      );
      const next = await make(a, { parent: first.m, value: "unpublished" });
      expect((await prepare(next.m)).statusCode).toBe(200);
      await upload(next);
      const job = randomUUID();
      await pool.query(
        "INSERT INTO hub_backup_jobs(id,profile_id,kind,namespace_version_id) VALUES($1,$2,'rollup',$3)",
        [job, profile, first.m.namespaces[0].namespaceVersionId],
      );
      await pool.query(
        "INSERT INTO hub_backup_rollup_sources(profile_id,job_id,namespace_version_id,source_form,depth) VALUES($1,$2,$3,'index',0)",
        [profile, job, first.m.namespaces[0].namespaceVersionId],
      );
      await pool.query(
        "INSERT INTO hub_backup_rollup_epochs(profile_id,job_id,store_name,store_epoch) VALUES($1,$2,'items',1)",
        [profile, job],
      );
      try {
        await expect(
          pool.query("DELETE FROM hub_profiles WHERE id=$1", [profile]),
        ).resolves.toBeDefined();
        for (const table of [
          "hub_backup_checkpoints",
          "hub_backup_namespace_versions",
          "hub_backup_parts",
          "hub_backup_catalog_pages",
          "hub_backup_catalog_pins",
          "hub_backup_rollup_sources",
          "hub_backup_rollup_epochs",
          "hub_backup_restore_pins",
        ])
          expect(
            (
              await pool.query(
                "SELECT count(*) FROM " + table + " WHERE profile_id=$1",
                [profile],
              )
            ).rows[0].count,
          ).toBe("0");
        const stale = await app.inject({
          method: "POST",
          url: root + "/staging/" + next.m.checkpointId + "/publish",
        });
        expect(stale.statusCode).toBe(401);
      } finally {
        await pool.query(
          "INSERT INTO hub_profiles(id,user_id,encrypted_key,backup_accounting_version) VALUES($1,$2,$3,1)",
          [profile, user, encrypt(key, master)],
        );
      }
      const old = await app.inject({
        method: "POST",
        url: root + "/staging/" + next.m.checkpointId + "/publish",
      });
      expect(old.statusCode).toBe(404);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_checkpoints WHERE profile_id=$1",
            [profile],
          )
        ).rows[0].count,
      ).toBe("0");
    });

    it("keeps a selected completed checkpoint readable through concurrent newer publication and same-day retention", async () => {
      const a = await register(),
        first = await make(a, { value: "selected-save" });
      await publish(first);
      await pool.query(
        "UPDATE hub_backup_parts SET created_at=now()-interval '2 days'",
      );
      const latest = await app.inject({
        url: root + "/checkpoints/latest?catalog=paged",
      });
      expect(latest.statusCode).toBe(200);
      expect(latest.json().checkpoint.checkpointId).toBe(first.m.checkpointId);
      const selected = await app.inject({
        url: root + "/checkpoints/" + first.m.checkpointId + "?catalog=paged",
      });
      expect(selected.statusCode).toBe(200);
      const next = await make(a, { parent: first.m, value: "newer-save" });
      await publish(next);
      await gc(16);
      await exactCounters();
      const metadata = await app.inject({
        url: root + "/checkpoints/" + first.m.checkpointId + "?catalog=paged",
      });
      expect(metadata.statusCode, metadata.body).toBe(200);
      const namespaces = await app.inject({
        url: root + "/checkpoints/" + first.m.checkpointId + "/namespaces",
      });
      expect(namespaces.statusCode, namespaces.body).toBe(200);
      const records = await app.inject({
        url:
          root +
          "/namespace-versions/" +
          first.m.namespaces[0].namespaceVersionId +
          "/records",
      });
      expect(records.statusCode, records.body).toBe(200);
      const bytes = await app.inject({
        url: root + "/parts/" + hash(first.parts[0]),
      });
      expect(bytes.statusCode, bytes.body).toBe(200);
      expect(bytes.rawPayload).toEqual(first.parts[0]);
      expect(
        Number(
          (
            await pool.query(
              "SELECT backup_v2_bytes FROM hub_profiles WHERE id=$1",
              [profile],
            )
          ).rows[0].backup_v2_bytes,
        ),
      ).toBe(first.parts[0].length + next.parts[0].length);
      const released = await app.inject({
        method: "POST",
        url: root + "/checkpoints/" + first.m.checkpointId + "/restore-release",
        payload: { leaseId: await pinLease(first.m.checkpointId) },
      });
      expect(released.statusCode, released.body).toBe(200);
      await gc(20);
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].count,
      ).toBe("0");
    });

    it("bounds restore pins, isolates reader contexts and coalesces progress renewals without invented quota credit", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      const sessions = Array.from({ length: 9 }, (_, i) => ({
        ...sessionValue,
        contextId: "restore-context-" + i,
      }));
      for (let n = 0; n < 8; n++)
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          acquireRestorePin(c, sessions[n], first.m.checkpointId),
        );
      await expect(
        withBackupTransaction(pool, new AbortController().signal, (c) =>
          acquireRestorePin(c, sessions[8], first.m.checkpointId),
        ),
      ).rejects.toMatchObject({ code: "BACKUP_BUSY" });
      await expect(
        withBackupTransaction(pool, new AbortController().signal, (c) =>
          acquireRestorePin(c, sessions[0], first.m.checkpointId),
        ),
      ).resolves.toHaveProperty("checkpointId", first.m.checkpointId);
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          renewRestorePins(c, sessions[0], {
            checkpointId: first.m.checkpointId,
          }),
        ),
      ).toEqual({ active: 1, renewed: 0 });
      await pool.query(
        "UPDATE hub_backup_restore_pins SET expires_at=now()+interval '89 seconds' WHERE reader_id=$1",
        [restoreReaderId(sessions[0])],
      );
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          renewRestorePins(c, sessions[0], {
            namespaceVersionId: first.m.namespaces[0].namespaceVersionId,
          }),
        ),
      ).toEqual({ active: 1, renewed: 1 });
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          renewRestorePins(c, sessions[8], { partHash: hash(first.parts[0]) }),
        ),
      ).toEqual({ active: 0, renewed: 0 });
      const currentLease = await pinLease(first.m.checkpointId, sessions[0]);
      await withBackupTransaction(pool, new AbortController().signal, (c) =>
        releaseRestorePin(c, sessions[0], first.m.checkpointId, currentLease),
      );
      await withBackupTransaction(pool, new AbortController().signal, (c) =>
        releaseRestorePin(c, sessions[0], first.m.checkpointId, currentLease),
      );
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_restore_pins WHERE profile_id=$1",
            [profile],
          )
        ).rows[0].count,
      ).toBe("7");
      await exactCounters();
      await pool.query(
        "UPDATE hub_backup_restore_pins SET expires_at=now()-interval '1 second'",
      );
      await pool.query(
        "INSERT INTO hub_backup_restore_pins(profile_id,checkpoint_id,reader_id,expires_at) SELECT $1,$2,lpad(to_hex(n),64,'0'),now()-interval '1 second' FROM generate_series(1,40)n",
        [profile, first.m.checkpointId],
      );
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          collectExpiredRestorePins(c, profile),
        ),
      ).toBe(32);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_restore_pins WHERE profile_id=$1",
            [profile],
          )
        ).rows[0].count,
      ).toBe("15");
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          collectExpiredRestorePins(c, profile),
        ),
      ).toBe(15);
      await exactCounters();
    });

    it("expires an abandoned restore lease and requeues bounded retention without another backup publication", async () => {
      const a = await register(),
        first = await make(a, { value: "abandoned-reader" });
      await publish(first);
      await pool.query(
        "UPDATE hub_backup_parts SET created_at=now()-interval '2 days'",
      );
      expect(
        (
          await app.inject({
            url:
              root + "/checkpoints/" + first.m.checkpointId + "?catalog=paged",
          })
        ).statusCode,
      ).toBe(200);
      const next = await make(a, { parent: first.m, value: "current-head" });
      await publish(next);
      await gc(16);
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("complete");
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_jobs WHERE profile_id=$1 AND kind='prune' AND status='pending'",
            [profile],
          )
        ).rows[0].count,
      ).toBe("0");
      await pool.query(
        "UPDATE hub_backup_restore_pins SET expires_at=now()-interval '1 second' WHERE checkpoint_id=$1",
        [first.m.checkpointId],
      );
      await gc(20);
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_restore_pins WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        Number(
          (
            await pool.query(
              "SELECT backup_v2_bytes FROM hub_profiles WHERE id=$1",
              [profile],
            )
          ).rows[0].backup_v2_bytes,
        ),
      ).toBe(next.parts[0].length);
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [next.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("complete");
    });

    it("bounds same-day published churn while preserving an active restore and fresh never-published orphan grace", async () => {
      const a = await register(),
        orphanReplica = await register(),
        orphan = await make(orphanReplica, { value: "unknown-orphan" });
      expect((await prepare(orphan.m)).statusCode).toBe(200);
      await upload(orphan);
      await pool.query(
        "UPDATE hub_backup_checkpoints SET status='expired',expires_at=now()-interval '1 second' WHERE checkpoint_id=$1",
        [orphan.m.checkpointId],
      );
      const first = await make(a, { value: "restore-protected" });
      await publish(first);
      const selected = await app.inject({
        url: root + "/checkpoints/" + first.m.checkpointId + "?catalog=paged",
      });
      expect(selected.statusCode).toBe(200);
      let current = first;
      for (let n = 0; n < 10; n++) {
        const next = await make(a, { parent: current.m, value: "churn-" + n });
        await publish(next);
        current = next;
        await gc(12);
        await exactCounters();
      }
      const stats = (
        await pool.query(
          "SELECT count(*)::int parts,count(*) FILTER(WHERE published_refs>0)::int canonical FROM hub_backup_parts WHERE profile_id=$1",
          [profile],
        )
      ).rows[0];
      expect(stats).toEqual({ parts: 3, canonical: 2 });
      expect(
        (
          await pool.query(
            "SELECT gc_eligible_at FROM hub_backup_parts WHERE hash=$1",
            [hash(orphan.parts[0])],
          )
        ).rows[0].gc_eligible_at,
      ).toBeNull();
      expect(
        (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
          .rawPayload,
      ).toEqual(first.parts[0]);
      expect(
        (
          await app.inject({
            method: "POST",
            url:
              root +
              "/checkpoints/" +
              first.m.checkpointId +
              "/restore-release",
            payload: { leaseId: await pinLease(first.m.checkpointId) },
          })
        ).statusCode,
      ).toBe(200);
      await gc(16);
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_backup_parts WHERE profile_id=$1",
            [profile],
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        Number(
          (
            await pool.query(
              "SELECT backup_v2_staging_bytes FROM hub_profiles WHERE id=$1",
              [profile],
            )
          ).rows[0].backup_v2_staging_bytes,
        ),
      ).toBe(orphan.parts[0].length);
    });
    it("retains each replica latest plus seven daily points, with temporary active readers protected beyond ordinary history", async () => {
      const a = await register(),
        first = await make(a, { value: "day-0" });
      await publish(first);
      await pool.query(
        "UPDATE hub_backup_checkpoints SET history_day=CURRENT_DATE-9 WHERE checkpoint_id=$1",
        [first.m.checkpointId],
      );
      expect(
        (
          await app.inject({
            url:
              root + "/checkpoints/" + first.m.checkpointId + "?catalog=paged",
          })
        ).statusCode,
      ).toBe(200);
      let current = first;
      for (let n = 1; n < 10; n++) {
        const next = await make(a, { parent: current.m, value: "day-" + n });
        await publish(next);
        current = next;
        await pool.query(
          "UPDATE hub_backup_checkpoints SET history_day=CURRENT_DATE-$2::int WHERE checkpoint_id=$1",
          [current.m.checkpointId, 9 - n],
        );
      }
      await gc(40);
      await exactCounters();
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM hub_backup_checkpoints WHERE profile_id=$1 AND status='complete'",
              [profile],
            )
          ).rows[0].count,
        ),
      ).toBe(9);
      expect(
        (
          await app.inject({
            method: "POST",
            url:
              root +
              "/checkpoints/" +
              first.m.checkpointId +
              "/restore-release",
            payload: { leaseId: await pinLease(first.m.checkpointId) },
          })
        ).statusCode,
      ).toBe(200);
      await gc(40);
      await exactCounters();
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM hub_backup_checkpoints WHERE profile_id=$1 AND status='complete'",
              [profile],
            )
          ).rows[0].count,
        ),
      ).toBe(8);
      expect(
        (
          await pool.query(
            "SELECT cp.status FROM hub_backup_replicas r JOIN hub_backup_checkpoints cp ON cp.checkpoint_id=r.head_checkpoint_id WHERE r.replica_id=$1",
            [a.replicaId],
          )
        ).rows[0].status,
      ).toBe("complete");
    });

    it("fences delayed old GET, renew, release and expiry cleanup from a newer same-context restore attempt", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      const oldId = randomUUID(),
        newId = randomUUID();
      const old = await app.inject({
        url:
          root +
          "/checkpoints/" +
          first.m.checkpointId +
          "?catalog=paged&restoreId=" +
          oldId,
      });
      expect(old.statusCode, old.body).toBe(200);
      expect(old.json().restoreReaderPin.leaseId).toBe(oldId);
      const newer = await app.inject({
        url:
          root +
          "/checkpoints/" +
          first.m.checkpointId +
          "?catalog=paged&restoreId=" +
          newId,
      });
      expect(newer.statusCode, newer.body).toBe(200);
      expect(newer.json().restoreReaderPin.leaseId).toBe(newId);
      const before = (
        await pool.query(
          "SELECT expires_at FROM hub_backup_restore_pins WHERE lease_id=$1",
          [newId],
        )
      ).rows[0].expires_at.getTime();
      const delayed = await app.inject({
        url:
          root +
          "/checkpoints/" +
          first.m.checkpointId +
          "?catalog=paged&restoreId=" +
          oldId,
      });
      expect(delayed.statusCode).toBe(200);
      expect(
        (
          await pool.query(
            "SELECT expires_at FROM hub_backup_restore_pins WHERE lease_id=$1",
            [newId],
          )
        ).rows[0].expires_at.getTime(),
      ).toBe(before);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_restore_pins WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].count,
      ).toBe("2");
      const released = await app.inject({
        method: "POST",
        url: root + "/checkpoints/" + first.m.checkpointId + "/restore-release",
        payload: { leaseId: oldId },
      });
      expect(released.statusCode, released.body).toBe(200);
      expect(released.json().released).toBe(true);
      const again = await app.inject({
        method: "POST",
        url: root + "/checkpoints/" + first.m.checkpointId + "/restore-release",
        payload: { leaseId: oldId },
      });
      expect(again.json().released).toBe(false);
      expect(
        (
          await app.inject({
            method: "POST",
            url:
              root + "/checkpoints/" + first.m.checkpointId + "/restore-renew",
            payload: { leaseId: oldId },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await pool.query(
            "SELECT expires_at FROM hub_backup_restore_pins WHERE lease_id=$1",
            [newId],
          )
        ).rows[0].expires_at.getTime(),
      ).toBe(before);
      await acquireRestorePinForTest(oldId);
      await pool.query(
        "UPDATE hub_backup_restore_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_id=$1",
        [oldId],
      );
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          collectExpiredRestorePins(c, profile),
        ),
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_restore_pins WHERE lease_id=$1",
            [newId],
          )
        ).rows[0].count,
      ).toBe("1");
      await pool.query(
        "UPDATE hub_backup_restore_pins SET expires_at=clock_timestamp()+interval '89 seconds' WHERE lease_id=$1",
        [newId],
      );
      const unrenewed = (
        await pool.query(
          "SELECT expires_at FROM hub_backup_restore_pins WHERE lease_id=$1",
          [newId],
        )
      ).rows[0].expires_at.getTime();
      expect(
        (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await pool.query(
            "SELECT expires_at FROM hub_backup_restore_pins WHERE lease_id=$1",
            [newId],
          )
        ).rows[0].expires_at.getTime(),
      ).toBe(unrenewed);
      const renewed = await app.inject({
        method: "POST",
        url: root + "/checkpoints/" + first.m.checkpointId + "/restore-renew",
        payload: { leaseId: newId },
      });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().leaseId).toBe(newId);
      expect(
        (
          await pool.query(
            "SELECT expires_at>clock_timestamp()+interval '110 seconds' renewed FROM hub_backup_restore_pins WHERE lease_id=$1",
            [newId],
          )
        ).rows[0].renewed,
      ).toBe(true);
      await exactCounters();
      async function acquireRestorePinForTest(id: string) {
        return withBackupTransaction(pool, new AbortController().signal, (c) =>
          acquireRestorePin(c, sessionValue, first.m.checkpointId, id),
        );
      }
    });

    it("extends a locked valid attempt across an expiry-boundary delay and every explicit retry returns a real full TTL", async () => {
      const a = await register(),
        first = await make(a);
      await publish(first);
      const leaseId = randomUUID();
      await withBackupTransaction(pool, new AbortController().signal, (c) =>
        acquireRestorePin(c, sessionValue, first.m.checkpointId, leaseId),
      );
      await pool.query(
        "UPDATE hub_backup_restore_pins SET expires_at=clock_timestamp()+interval '50 milliseconds' WHERE lease_id=$1",
        [leaseId],
      );
      let delayed = false;
      const result = await withBackupTransaction(
        pool,
        new AbortController().signal,
        async (c) => {
          const wrapped = new Proxy(c, {
            get(target, key) {
              if (key === "query")
                return async (...args: any[]) => {
                  if (
                    typeof args[0] === "string" &&
                    args[0].startsWith(
                      "UPDATE hub_backup_restore_pins p SET expires_at",
                    )
                  ) {
                    delayed = true;
                    await new Promise((r) => setTimeout(r, 80));
                  }
                  return (target.query as any)(...args);
                };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return renewRestorePins(wrapped, sessionValue, {
            checkpointId: first.m.checkpointId,
            leaseId,
          });
        },
      );
      expect(delayed).toBe(true);
      expect(result).toEqual({ active: 1, renewed: 1 });
      expect(
        (
          await pool.query(
            "SELECT expires_at>clock_timestamp()+interval '110 seconds' extended FROM hub_backup_restore_pins WHERE lease_id=$1",
            [leaseId],
          )
        ).rows[0].extended,
      ).toBe(true);
      expect(
        await withBackupTransaction(pool, new AbortController().signal, (c) =>
          renewRestorePins(c, sessionValue, {
            checkpointId: first.m.checkpointId,
            leaseId,
          }),
        ),
      ).toEqual({ active: 1, renewed: 1 });
      await exactCounters();
    });

    async function largeHead(
      replica: any,
      parent?: BackupCheckpointV2,
      char = "a",
    ) {
      const records = [];
      for (let n = 0; n < 4; n++)
        records.push({
          operation: "put",
          store: "items",
          storeEpoch: 1,
          key: { t: "string", v: "k" + n },
          value: await encodePortableValue(char.repeat(140000)),
          generation: parent ? 2 : 1,
        });
      return make(replica, { parent, records, cut: parent ? 2 : 1 });
    }
    it("keeps reader and seed protected old heads charged, then atomically replaces under the same exact prepared identity", async () => {
      await pool.query(
        "UPDATE hub_profile_policy_defaults SET profile_bytes=1048576",
      );
      const a = await register(),
        first = await largeHead(a);
      await publish(first);
      const seed = await register(first.m.checkpointId),
        leaseId = randomUUID();
      expect(
        (
          await app.inject({
            url:
              root +
              "/checkpoints/" +
              first.m.checkpointId +
              "?catalog=paged&restoreId=" +
              leaseId,
          })
        ).statusCode,
      ).toBe(200);
      const next = await largeHead(a, first.m, "b");
      expect((await prepare(next.m)).statusCode).toBe(200);
      await upload(next);
      const publishNext = () =>
        app.inject({
          method: "POST",
          url: root + "/staging/" + next.m.checkpointId + "/publish",
        });
      expect((await publishNext()).statusCode).toBe(413);
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("complete");
      expect(
        (
          await app.inject({
            method: "POST",
            url:
              root +
              "/checkpoints/" +
              first.m.checkpointId +
              "/restore-release",
            payload: { leaseId },
          })
        ).statusCode,
      ).toBe(200);
      expect((await publishNext()).statusCode).toBe(413);
      await exactCounters();
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: root + "/replicas/" + seed.replicaId,
          })
        ).statusCode,
      ).toBe(200);
      const done = await publishNext();
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().checkpointId).toBe(next.m.checkpointId);
      expect(done.json().manifestDigest).toBe(next.m.manifestDigest);
      expect(done.json().historyShortened).toBe(true);
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT head_checkpoint_id FROM hub_backup_replicas WHERE replica_id=$1",
            [a.replicaId],
          )
        ).rows[0].head_checkpoint_id,
      ).toBe(next.m.checkpointId);
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("retired");
      await gc(20);
      await exactCounters();
      expect(
        Number(
          (
            await pool.query(
              "SELECT backup_v2_bytes FROM hub_profiles WHERE id=$1",
              [profile],
            )
          ).rows[0].backup_v2_bytes,
        ),
      ).toBe(next.parts.reduce((n, b) => n + b.length, 0));
    });
    it("rolls back replacement credit after the candidate complete-row update but before its head update, then retries exactly once", async () => {
      await pool.query(
        "UPDATE hub_profile_policy_defaults SET profile_bytes=1048576",
      );
      const a = await register(),
        first = await largeHead(a);
      await publish(first);
      const next = await largeHead(a, first.m, "c");
      expect((await prepare(next.m)).statusCode).toBe(200);
      await upload(next);
      const original = pool.connect.bind(pool);
      let injected = false;
      (pool as any).connect = async () => {
        const client = await original();
        return new Proxy(client, {
          get(target, key) {
            if (key === "query")
              return (...args: any[]) => {
                const text =
                    typeof args[0] === "string" ? args[0] : args[0]?.text || "",
                  values = args[1] || [];
                if (
                  !injected &&
                  text.startsWith(
                    "UPDATE hub_backup_replicas SET head_checkpoint_id=",
                  ) &&
                  values[2] === next.m.checkpointId
                ) {
                  injected = true;
                  throw Object.assign(
                    Error(
                      "FIXTURE_FAILURE_AFTER_CANDIDATE_COMPLETE_BEFORE_HEAD",
                    ),
                    { code: "FIXTURE_ROLLBACK" },
                  );
                }
                return (target.query as any)(...args);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      try {
        const failed = await app.inject({
          method: "POST",
          url: root + "/staging/" + next.m.checkpointId + "/publish",
        });
        expect(failed.statusCode, failed.body).toBe(500);
        expect(injected).toBe(true);
      } finally {
        (pool as any).connect = original;
      }
      await exactCounters();
      expect(
        (
          await pool.query(
            "SELECT head_checkpoint_id FROM hub_backup_replicas WHERE replica_id=$1",
            [a.replicaId],
          )
        ).rows[0].head_checkpoint_id,
      ).toBe(first.m.checkpointId);
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [first.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("complete");
      expect(
        (
          await pool.query(
            "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [next.m.checkpointId],
          )
        ).rows[0].status,
      ).toBe("prepared");
      expect(
        (
          await pool.query(
            "SELECT published_refs FROM hub_backup_parts WHERE hash=ANY($1::text[])",
            [first.parts.map(hash)],
          )
        ).rows.every((r) => Number(r.published_refs) === 1),
      ).toBe(true);
      const done = await app.inject({
        method: "POST",
        url: root + "/staging/" + next.m.checkpointId + "/publish",
      });
      expect(done.statusCode, done.body).toBe(200);
      const again = await app.inject({
        method: "POST",
        url: root + "/staging/" + next.m.checkpointId + "/publish",
      });
      expect(again.json()).toEqual(done.json());
      await exactCounters();
      await gc(20);
      await exactCounters();
    });
  },
);
