import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import {
  backupManifestIdentity,
  hubNamespace,
  type BackupCheckpointV2,
} from "@atlas-link-dispenser/shared";
import { publishCatalogZeroSQLFixture } from "./catalogZeroWriter.fixture.js";
import { encrypt } from "./security.js";
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
const script = new URL(
  "../../../scripts/backup-v2-additive-migration.mjs",
  import.meta.url,
).href;
run("Explicit additive0026 migration — isolated PostgreSQL only", () => {
  let admin: Pool, pool: Pool, schema: string;
  beforeEach(async () => {
    if (
      !["localhost", "127.0.0.1"].includes(new URL(url!).hostname) ||
      !new URL(url!).pathname.endsWith("_test")
    )
      throw Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: url });
    schema = "migration_" + randomUUID().replaceAll("-", "");
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({
      connectionString: url,
      max: 4,
      options: "-c search_path=" + schema + ",public",
    });
    await pool.query(
      "CREATE TABLE users(id uuid PRIMARY KEY,email text,normalized_email text); CREATE TABLE links(id uuid PRIMARY KEY); CREATE TABLE sessions(id uuid PRIMARY KEY); CREATE TABLE schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const f of [
      "0009_hub_core.sql",
      "0013_hub_writer_handoff.sql",
      "0015_hub_profile_recovery.sql",
      "0016_hub_profile_policy.sql",
      "0018_hub_stream_budget.sql",
      "0019_hub_profile_delete_refs.sql",
      "0025_hub_backups_v2.sql",
    ])
      await pool.query(
        await readFile(
          new URL(
            "../../../packages/database/migrations/" + f,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await pool.query(
      "INSERT INTO schema_migrations(id) VALUES('0025_hub_backups_v2.sql')",
    );
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      await admin.end();
    }
  });
  async function runner(c: any, options: any = {}) {
    return (await import(script)).applyBackupCatalogMigration(c, options);
  }
  it("is read-only by default, enforces exact previous migration and rejects unverified applied identities", async () => {
    const c = await pool.connect();
    try {
      expect((await runner(c)).applied).toBe(false);
      expect(
        (await c.query("SELECT to_regclass('hub_backup_catalog_pages') r"))
          .rows[0].r,
      ).toBe(null);
      await c.query("UPDATE schema_migrations SET id='0024_other.sql'");
      await expect(runner(c, { apply: true })).rejects.toMatchObject({
        code: "MIGRATION_EXACT_PRIOR_REQUIRED",
      });
      await c.query(
        "UPDATE schema_migrations SET id='0025_hub_backups_v2.sql'",
      );
      const result = await runner(c, { apply: true });
      expect(result.applied).toBe(true);
      expect((await runner(c, { apply: true })).alreadyApplied).toBe(true);
      await c.query(
        "UPDATE hub_backup_migration_receipts SET source_sha256=$1",
        ["0".repeat(64)],
      );
      await expect(runner(c, { apply: true })).rejects.toMatchObject({
        code: "MIGRATION_RECEIPT_MISMATCH",
      });
    } finally {
      c.release();
    }
  });
  it("adds constant defaults without heap rewrites or startup scans, while a newly authored pre-0026 SQL writer contract works before and after migration", async () => {
    const user = randomUUID(),
      profile = randomUUID(),
      branch = randomUUID();
    await pool.query("INSERT INTO users VALUES($1,$2,$2)", [
      user,
      "fixture@example.test",
    ]);
    await pool.query("INSERT INTO links VALUES($1)", [branch]);
    await pool.query(
      "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$1,$2,$3)",
      [branch, "https://fixture.example", "0".repeat(64)],
    );
    await pool.query(
      "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,$3,true)",
      [profile, user, encrypt("fixture-key", "fixture-master")],
    );
    await pool.query(
      "INSERT INTO hub_backup_parts(profile_id,hash,encrypted_payload,bytes) SELECT $1,lpad(to_hex(n),64,'0'),decode('01','hex'),1 FROM generate_series(1,1000) n",
      [profile],
    );
    // The original external old-server snapshot was deleted. This is an
    // independently authored SQL schema contract, not historical HTTP/auth proof.
    const makeManifest = (): BackupCheckpointV2 => {
      const manifest: BackupCheckpointV2 = {
        format: "atlas-checkpoint-v2",
        checkpointId: randomUUID(),
        replicaId: randomUUID(),
        incarnation: randomUUID(),
        sequence: 1,
        parentCheckpointId: null,
        manifestDigest: "",
        adoptedThrough: 0,
        namespaces: [
          {
            namespace: { kind: "local", origin: "https://save.example" },
            namespaceVersionId: randomUUID(),
            parentNamespaceVersionId: null,
            kind: "baseline",
            localCut: 1,
            schemaEpoch: 1,
            parts: [],
            rootDigest: createHash("sha256").update("[]").digest("hex"),
            coverage: "complete-at-cut",
          },
        ],
      };
      manifest.manifestDigest = createHash("sha256")
        .update(backupManifestIdentity(manifest))
        .digest("hex");
      return manifest;
    };
    const preMigration = makeManifest();
    const publish = (manifest: BackupCheckpointV2) =>
      publishCatalogZeroSQLFixture(pool, {
        profileId: profile,
        branchId: branch,
        origin: "https://fixture.example",
        manifest,
      });
    expect((await publish(preMigration)).acknowledged).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT status,manifest_digest,manifest FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2",
          [profile, preMigration.checkpointId],
        )
      ).rows[0],
    ).toMatchObject({
      status: "complete",
      manifest_digest: preMigration.manifestDigest,
      manifest: preMigration,
    });
    const before = (
      await pool.query(
        "SELECT c.relname,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'",
      )
    ).rows;
    const c = await pool.connect();
    try {
      await runner(c, { apply: true });
    } finally {
      c.release();
    }
    const after = new Map(
      (
        await pool.query(
          "SELECT c.relname,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'",
        )
      ).rows.map((r) => [r.relname, r.relfilenode]),
    );
    for (const row of before)
      expect(after.get(row.relname), row.relname).toBe(row.relfilenode);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM hub_backup_parts WHERE ever_published=false AND gc_eligible_at IS NULL",
        )
      ).rows[0].n,
    ).toBe(1000);
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conname='backup_catalog_count_bounded' AND conrelid='hub_backup_checkpoints'::regclass",
        )
      ).rows[0].convalidated,
    ).toBe(false);
    expect(
      (await pool.query("SELECT to_regclass('hub_backup_parts_unheld') r"))
        .rows[0].r,
    ).toBe(null);
    const postMigration = makeManifest();
    expect((await publish(postMigration)).acknowledged).toBe(true);
    for (const manifest of [preMigration, postMigration]) {
      const checkpoint = (
        await pool.query(
          "SELECT catalog_version,catalog_ready,catalog_count,catalog_digest,status,manifest,receipt FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2",
          [profile, manifest.checkpointId],
        )
      ).rows[0];
      // The fixture never names catalog columns: these are actual DDL defaults.
      expect(checkpoint).toMatchObject({
        catalog_version: 0,
        catalog_ready: false,
        catalog_count: 0,
        catalog_digest: null,
        status: "complete",
        manifest,
        receipt: { acknowledged: true, checkpointId: manifest.checkpointId },
      });
      expect(
        (
          await pool.query(
            "SELECT namespace,namespace_version_id FROM hub_backup_catalog_namespace_refs WHERE profile_id=$1 AND checkpoint_id=$2",
            [profile, manifest.checkpointId],
          )
        ).rows,
      ).toEqual([
        {
          namespace: hubNamespace(manifest.namespaces[0].namespace).key,
          namespace_version_id: manifest.namespaces[0].namespaceVersionId,
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT parts_ready FROM hub_backup_namespace_versions WHERE profile_id=$1 AND namespace_version_id=$2",
            [profile, manifest.namespaces[0].namespaceVersionId],
          )
        ).rows[0],
      ).toEqual({ parts_ready: false });
    }
  });
  it("retries a blocked additive DDL with fixed two-second lock deadline, and never partially records a failed attempt", async () => {
    const blocker = await pool.connect(),
      c = await pool.connect();
    let attempts = 0;
    await blocker.query("BEGIN");
    await blocker.query(
      "LOCK TABLE hub_backup_checkpoints IN ACCESS SHARE MODE",
    );
    const release = setTimeout(() => void blocker.query("ROLLBACK"), 2200);
    try {
      const result = await runner(c, {
        apply: true,
        maxAttempts: 2,
        retryDelayMs: 50,
        onAttempt: () => attempts++,
      });
      expect(result.attempts).toBe(2);
      expect(attempts).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_backup_migration_receipts",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      clearTimeout(release);
      await blocker.query("ROLLBACK");
      blocker.release();
      c.release();
    }
  }, 10000);
  it("resolves genuinely committed but lost COMMIT replies with the exact durable SQL hash", async () => {
    const c = await pool.connect();
    let once = true;
    const faulty = {
      query: async (...args: any[]) => {
        const result = await (c.query as any)(...args);
        if (args[0] === "COMMIT" && once) {
          once = false;
          throw Error("lost commit fixture");
        }
        return result;
      },
    };
    try {
      await expect(runner(faulty, { apply: true })).rejects.toMatchObject({
        code: "MIGRATION_COMMIT_UNCERTAIN",
      });
      const result = await runner(c, { apply: true });
      expect(result.alreadyApplied).toBe(true);
      expect(
        (
          await c.query(
            "SELECT count(*)::int n FROM hub_backup_migration_receipts",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      c.release();
    }
  });
});
