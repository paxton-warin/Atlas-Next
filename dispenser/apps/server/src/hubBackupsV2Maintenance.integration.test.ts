import { provisionBackupCatalogTestIndexes } from "./hubBackupsV2Readiness.js";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  runBackupMaintenanceBurst,
  runBackupRollupSlice,
  runBackupProfileMaintenanceSlice,
  sampleBackupMaintenanceBacklog,
  createBackupMaintenanceCounters,
  pauseBackupMaintenance,
  backupMaintenanceTelemetry,
} from "./hubBackupsV2Maintenance.js";
import { runBackupAccountingSlice } from "./hubBackupsV2Accounting.js";
import { withBackupTransaction, resolvedCTE } from "./hubBackupsV2.js";
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
run("Fair work-conserving backup maintenance — isolated PostgreSQL", () => {
  let admin: Pool, pool: Pool;
  const schema = "backupmaintenance_" + randomUUID().replaceAll("-", ""),
    branch = randomUUID();
  beforeAll(async () => {
    if (
      !["127.0.0.1", "localhost"].includes(new URL(url!).hostname) ||
      !new URL(url!).pathname.endsWith("_test")
    )
      throw Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: url });
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({
      connectionString: url,
      max: 6,
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
    await pool.query("INSERT INTO links VALUES($1)", [branch]);
    await pool.query(
      "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$1,'https://fixture.example','fixture')",
      [branch],
    );
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE users CASCADE");
    await pool.query(
      "UPDATE hub_backup_maintenance_schedule SET last_served_at='-infinity',turn=0",
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query("DROP SCHEMA " + schema + " CASCADE");
    await admin?.end();
  });
  async function tenant(accounting = 1) {
    const user = randomUUID(),
      profile = randomUUID(),
      replica = randomUUID(),
      checkpoint = randomUUID();
    await pool.query("INSERT INTO users VALUES($1,$2,$2)", [
      user,
      user + "@fixture.test",
    ]);
    await pool.query(
      "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized,backup_accounting_version,chunk_accounting_version) VALUES($1,$2,'fixture',true,$3,1)",
      [profile, user, accounting],
    );
    await pool.query(
      "INSERT INTO hub_backup_replicas(profile_id,replica_id,incarnation,branch_id,origin,label) VALUES($1,$2,$3,$4,'https://fixture.example','fixture')",
      [profile, replica, randomUUID(), branch],
    );
    await pool.query(
      "INSERT INTO hub_backup_checkpoints(profile_id,checkpoint_id,replica_id,sequence,manifest_digest,manifest,status) VALUES($1,$2,$3,1,$4,'{}','complete')",
      [profile, checkpoint, replica, "a".repeat(64)],
    );
    return { profile, replica, checkpoint };
  }
  async function namespace(
    t: Awaited<ReturnType<typeof tenant>>,
    records: number,
    depth = 8,
    parent?: string,
  ) {
    const version = randomUUID(),
      job = randomUUID();
    await pool.query(
      "INSERT INTO hub_backup_namespace_versions(profile_id,namespace_version_id,checkpoint_id,namespace,parent_version_id,kind,local_cut,schema_epoch,root_digest,manifest,depth) VALUES($1,$2,$3,$4,$5,$6,1,'1',$7,'{}',$8)",
      [
        t.profile,
        version,
        t.checkpoint,
        version,
        parent || null,
        parent ? "delta" : "baseline",
        "a".repeat(64),
        depth,
      ],
    );
    if (records)
      await pool.query(
        "INSERT INTO hub_backup_record_index(profile_id,namespace_version_id,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments) SELECT $1,$2,lpad(to_hex(n),64,'0'),'records',1,'put',$3,1,'[]'::jsonb FROM generate_series(1,$4::int)n",
        [t.profile, version, "b".repeat(64), records],
      );
    await pool.query(
      "INSERT INTO hub_backup_jobs(id,profile_id,kind,namespace_version_id) VALUES($1,$2,'rollup',$3)",
      [job, t.profile, version],
    );
    return { version, job };
  }
  it("commits64-reference set-based pages and lets a small later tenant complete before a large old job", async () => {
    const a = await tenant(),
      b = await tenant(),
      large = await namespace(a, 512),
      small = await namespace(b, 2);
    const order: string[] = [],
      result = await runBackupMaintenanceBurst(pool, {
        maxSlices: 6,
        onSlice: async (slice) => {
          if (slice.worked && slice.profileId) order.push(slice.profileId);
        },
      });
    expect(result.errors).toEqual({ busy: 0, database: 0, unexpected: 0 });
    expect(result.examinedRecords).toBeGreaterThanOrEqual(66);
    expect(result.slices).toBeLessThanOrEqual(6);
    expect(order.slice(0, 2)).toEqual([a.profile, b.profile]);
    expect(
      (
        await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
          small.job,
        ])
      ).rows[0].status,
    ).toBe("complete");
    const pending = (
      await pool.query(
        "SELECT status,cursor FROM hub_backup_jobs WHERE id=$1",
        [large.job],
      )
    ).rows[0];
    expect(["pending", "running"]).toContain(pending.status);
    expect(pending.cursor.epochAfter || pending.cursor.recordId).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_materialized_records WHERE namespace_version_id=$1",
            [large.version],
          )
        ).rows[0].count,
      ),
    ).toBeLessThan(512);
  });
  it("tenant last-served prevents a tenant with many old jobs monopolizing one small tenant", async () => {
    const a = await tenant(),
      b = await tenant();
    for (let i = 0; i < 12; i++) await namespace(a, 1);
    const small = await namespace(b, 1),
      order: string[] = [];
    await runBackupMaintenanceBurst(pool, {
      maxSlices: 5,
      onSlice: async (s) => {
        if (s.worked && s.profileId) order.push(s.profileId);
      },
    });
    expect(order.slice(0, 2)).toEqual([a.profile, b.profile]);
    expect(
      (
        await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
          small.job,
        ])
      ).rows[0].status,
    ).toBe("complete");
  });
  it("persists an interrupted claim lease, serves another job, and resumes expired cursor without duplicate records", async () => {
    const a = await tenant(),
      b = await tenant(),
      large = await namespace(a, 130),
      small = await namespace(b, 1),
      cancel = new AbortController();
    await expect(
      runBackupRollupSlice(pool, {
        signal: cancel.signal,
        afterClaim: async () => cancel.abort(),
      }),
    ).rejects.toMatchObject({ code: "BACKUP_BUSY" });
    expect(
      (
        await pool.query(
          "SELECT status,owner_token,lease_expires_at>now() leased FROM hub_backup_jobs WHERE id=$1",
          [large.job],
        )
      ).rows[0],
    ).toMatchObject({ status: "running", leased: true });
    expect((await runBackupRollupSlice(pool)).jobId).toBe(small.job);
    await pool.query(
      "UPDATE hub_backup_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [large.job],
    );
    for (let i = 0; i < 10; i++) {
      await runBackupRollupSlice(pool);
      if (
        (
          await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
            large.job,
          ])
        ).rows[0].status === "complete"
      )
        break;
    }
    expect(
      (
        await pool.query(
          "SELECT status,cursor,owner_token FROM hub_backup_jobs WHERE id=$1",
          [large.job],
        )
      ).rows[0],
    ).toMatchObject({ status: "complete", cursor: null, owner_token: null });
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_materialized_records WHERE namespace_version_id=$1",
            [large.version],
          )
        ).rows[0].count,
      ),
    ).toBe(130);
  });
  it("rotates rollup, GC and accounting categories while rollup remains busy", async () => {
    const rollup = await tenant(),
      gc = await tenant(),
      accounting = await tenant(0);
    await namespace(rollup, 512);
    await pool.query(
      "INSERT INTO hub_backup_parts(profile_id,hash,encrypted_payload,bytes,created_at) VALUES($1,$2,'fixture',1,now()-interval '2 days')",
      [gc.profile, "c".repeat(64)],
    );
    await pool.query(
      "UPDATE hub_profiles SET backup_v2_staging_bytes=1,backup_v2_staging_parts=1 WHERE id=$1",
      [gc.profile],
    );
    const result = {
      categorySlices: { rollup: 0, gc: 0, accounting: 0 },
      errors: { busy: 0, database: 0, unexpected: 0 },
      collectedParts: 0,
    };
    // A hard200ms deadline may interrupt a later claim under a parallel test
    // host. Fairness is durable across bursts, not a promise that every category
    // completes inside one wall-clock quantum on arbitrarily busy hardware.
    for (let round = 0; round < 12; round++) {
      const slice = await runBackupMaintenanceBurst(pool, { maxSlices: 12 });
      for (const key of ["rollup", "gc", "accounting"] as const)
        result.categorySlices[key] += slice.categorySlices[key];
      for (const key of ["busy", "database", "unexpected"] as const)
        result.errors[key] += slice.errors[key];
      result.collectedParts += slice.collectedParts;
      const ready =
        (
          await pool.query(
            "SELECT backup_accounting_version FROM hub_profiles WHERE id=$1",
            [accounting.profile],
          )
        ).rows[0].backup_accounting_version === 1;
      if (
        result.categorySlices.rollup &&
        result.categorySlices.gc &&
        result.categorySlices.accounting &&
        result.collectedParts &&
        ready
      )
        break;
    }
    expect(result.errors).toEqual({ busy: 0, database: 0, unexpected: 0 });
    expect(result.categorySlices.rollup).toBeGreaterThan(0);
    expect(result.categorySlices.gc).toBeGreaterThan(0);
    expect(result.categorySlices.accounting).toBeGreaterThan(0);
    expect(result.collectedParts).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT backup_accounting_version FROM hub_profiles WHERE id=$1",
          [accounting.profile],
        )
      ).rows[0].backup_accounting_version,
    ).toBe(1);
  });
  it("bounds priority near16 while preserving ordinary jobs and resets a completed chain without weakening its guard", async () => {
    const a = await tenant(),
      b = await tenant();
    let prior: string | undefined;
    for (let i = 0; i <= 16; i++) {
      const ns = await namespace(a, 1, i, prior);
      prior = ns.version;
      if (i !== 16)
        await pool.query(
          "UPDATE hub_backup_jobs SET status='complete' WHERE id=$1",
          [ns.job],
        );
    }
    const ordinary = await namespace(b, 1, 8);
    await pool.query(
      "UPDATE hub_backup_maintenance_schedule SET turn=3 WHERE category='rollup'",
    );
    await runBackupMaintenanceBurst(pool, { maxSlices: 5 });
    const n = (
      await pool.query(
        "SELECT depth,parent_version_id,materialized_ready FROM hub_backup_namespace_versions WHERE namespace_version_id=$1",
        [prior],
      )
    ).rows[0];
    expect(n).toMatchObject({
      depth: 0,
      parent_version_id: null,
      materialized_ready: true,
    });
    expect(
      (
        await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
          ordinary.job,
        ])
      ).rows[0].status,
    ).toBe("complete");
    await expect(
      pool.query(
        "UPDATE hub_backup_namespace_versions SET depth=17 WHERE namespace_version_id=$1",
        [prior],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("bounds blocked acquisition and leaves control/read SQL available with the one maintenance connection occupied", async () => {
    const maintenance = new Pool({
        connectionString: url,
        max: 1,
        options: "-c search_path=" + schema + ",public",
      }),
      held = await maintenance.connect();
    const a = await tenant();
    await namespace(a, 1);
    try {
      const start = performance.now(),
        work = runBackupMaintenanceBurst(maintenance, { budgetMs: 25 });
      expect(
        (await pool.query("SELECT count(*) FROM hub_backup_record_index"))
          .rows[0].count,
      ).toBe("1");
      expect((await pool.query("SELECT 42 answer")).rows[0].answer).toBe(42);
      const result = await work;
      expect(result.budgetExhausted).toBe(true);
      expect(performance.now() - start).toBeLessThan(300);
    } finally {
      held.release();
    }
    expect((await maintenance.query("SELECT 1 answer")).rows[0].answer).toBe(1);
    expect(maintenance.waitingCount).toBe(0);
    await maintenance.end();
  });
  it("emits bounded aggregate metrics without identity/error payloads and interrupts a long retry sleep on shutdown", async () => {
    const t = await tenant();
    await pool.query(
      "INSERT INTO hub_backup_jobs(profile_id,kind) SELECT $1,'reconcile' FROM generate_series(1,1100)",
      [t.profile],
    );
    let backlog:
      Awaited<ReturnType<typeof sampleBackupMaintenanceBacklog>> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        backlog = await sampleBackupMaintenanceBacklog(pool);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "BACKUP_BUSY") throw error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(backlog).toBeDefined();
    expect(backlog!.sampledJobs).toBe(1024);
    expect(backlog!.truncated).toBe(true);
    const counters = createBackupMaintenanceCounters(),
      result = await runBackupMaintenanceBurst(pool, { maxSlices: 3 });
    counters.add(result);
    counters.add(result);
    expect(counters.snapshot().bursts).toBe(2);
    expect(JSON.stringify(counters.snapshot())).not.toContain(t.profile);
    expect(counters.snapshot(true).slices).toBe(result.slices * 2);
    expect(counters.snapshot().bursts).toBe(0);
    const signal = new AbortController(),
      start = performance.now(),
      sleep = pauseBackupMaintenance(60000, signal.signal);
    signal.abort();
    await sleep;
    expect(performance.now() - start).toBeLessThan(100);
  });
  it("cancels executing SQL instead of accumulating detached backends while control reads stay available", async () => {
    const name = "cancel_" + randomUUID().replaceAll("-", ""),
      maintenance = new Pool({
        connectionString: url,
        max: 1,
        application_name: name,
        options: "-c search_path=" + schema + ",public",
      });
    try {
      for (let round = 0; round < 6; round++) {
        const control = new AbortController();
        let entered!: () => void;
        const begun = new Promise<void>((r) => {
          entered = r;
        });
        const pending = withBackupTransaction(
          maintenance,
          control.signal,
          async (c) => {
            entered();
            await c.query("SELECT pg_sleep(2)");
          },
        );
        const rejected = expect(pending).rejects.toMatchObject({
          code: "BACKUP_BUSY",
        });
        await begun;
        for (let n = 0; n < 100; n++) {
          const active = (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'",
              [name],
            )
          ).rowCount;
          if (active) break;
          if (n === 99) throw Error("SQL_NOT_EXECUTING");
          await new Promise((r) => setTimeout(r, 2));
        }
        const started = performance.now();
        control.abort();
        expect((await pool.query("SELECT 42 answer")).rows[0].answer).toBe(42);
        await rejected;
        expect(performance.now() - started).toBeLessThan(500);
        let executing = 1;
        for (let n = 0; n < 100; n++) {
          executing = (
            await pool.query(
              "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND state='active'",
              [name],
            )
          ).rows[0].n;
          if (!executing) break;
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(
          executing,
          "aborted statements must not continue using DB CPU/locks behind pool.max1",
        ).toBe(0);
        expect(maintenance.totalCount).toBeLessThanOrEqual(1);
        expect(maintenance.waitingCount).toBe(0);
      }
    } finally {
      await maintenance.end();
    }
  }, 10000);
  it("aborts an in-flight materialization transaction, releases its row locks and leaves a recoverable lease", async () => {
    const a = await tenant(),
      b = await tenant(),
      slow = await namespace(a, 130),
      small = await namespace(b, 1),
      signal = new AbortController();
    const maintenance = new Pool({
      connectionString: url,
      max: 1,
      application_name: "materialize_" + schema,
      options: "-c search_path=" + schema + ",public",
    });
    await pool.query(
      "UPDATE hub_backup_jobs SET status='complete' WHERE id=$1",
      [small.job],
    );
    for (let n = 0; n < 3; n++) await runBackupRollupSlice(maintenance);
    const priorMaterialized = (
      await pool.query(
        "SELECT count(*) FROM hub_backup_materialized_records WHERE namespace_version_id=$1",
        [slow.version],
      )
    ).rows[0].count;
    await pool.query(
      `CREATE FUNCTION slow_materialize_probe() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2);RETURN NEW;END$$;CREATE TRIGGER slow_materialize_probe BEFORE INSERT ON hub_backup_materialized_records FOR EACH ROW EXECUTE FUNCTION slow_materialize_probe()`,
    );
    try {
      const pending = runBackupRollupSlice(maintenance, {
          signal: signal.signal,
        }),
        rejected = expect(pending).rejects.toMatchObject({
          code: "BACKUP_BUSY",
        });
      for (let n = 0; n < 100; n++) {
        const active = (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'",
            ["materialize_" + schema],
          )
        ).rowCount;
        if (active) break;
        if (n === 99) throw Error("MATERIALIZATION_NOT_EXECUTING");
        await new Promise((r) => setTimeout(r, 5));
      }
      const started = performance.now();
      signal.abort();
      await rejected;
      expect(performance.now() - started).toBeLessThan(500);
      for (let n = 0; n < 100; n++) {
        const active = (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active'",
            ["materialize_" + schema],
          )
        ).rowCount;
        if (!active) break;
        if (n === 99) throw Error("CANCELLED_MATERIALIZATION_BACKEND_SURVIVED");
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_materialized_records WHERE namespace_version_id=$1",
            [slow.version],
          )
        ).rows[0].count,
      ).toBe(priorMaterialized);
      expect(
        (
          await pool.query(
            "SELECT status,lease_expires_at>now() leased FROM hub_backup_jobs WHERE id=$1",
            [slow.job],
          )
        ).rows[0],
      ).toMatchObject({ status: "running", leased: true });
      await pool.query(
        "DROP TRIGGER slow_materialize_probe ON hub_backup_materialized_records;DROP FUNCTION slow_materialize_probe()",
      );
      await pool.query(
        "UPDATE hub_backup_jobs SET status='pending' WHERE id=$1",
        [small.job],
      );
      expect((await runBackupRollupSlice(maintenance)).jobId).toBe(small.job);
      await pool.query(
        "UPDATE hub_backup_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [slow.job],
      );
      for (let n = 0; n < 10; n++) {
        await runBackupRollupSlice(maintenance);
        if (
          (
            await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
              slow.job,
            ])
          ).rows[0].status === "complete"
        )
          break;
      }
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_materialized_records WHERE namespace_version_id=$1",
            [slow.version],
          )
        ).rows[0].count,
      ).toBe("130");
    } finally {
      await maintenance.end();
      await pool.query(
        "DROP TRIGGER IF EXISTS slow_materialize_probe ON hub_backup_materialized_records;DROP FUNCTION IF EXISTS slow_materialize_probe()",
      );
    }
  }, 10000);
  it("remains tenant-fair while a hot tenant continuously adds jobs and rollup never becomes empty", async () => {
    const hot = await tenant(),
      others = await Promise.all(Array.from({ length: 6 }, () => tenant()));
    for (let n = 0; n < 8; n++) await namespace(hot, 512);
    const small = await Promise.all(others.map((t) => namespace(t, 1))),
      order: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const result = await runBackupRollupSlice(pool);
      if (result.profileId) order.push(result.profileId);
      if (result.profileId === hot.profile) await namespace(hot, 512);
    }
    for (let n = 0; n < others.length; n++) {
      expect(order.indexOf(others[n].profile)).toBeLessThanOrEqual(7);
      expect(
        (
          await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
            small[n].job,
          ])
        ).rows[0].status,
      ).toBe("complete");
    }
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_jobs WHERE profile_id=$1 AND status='pending'",
          [hot.profile],
        )
      ).rows[0].count,
    ).not.toBe("0");
  });

  it("uses one set-based rollup write per64 references and two chunk-accounting writes for129 rows", async () => {
    const sql: string[] = [],
      measured = Object.create(pool) as Pool;
    measured.connect = (async () => {
      const c = await pool.connect();
      return new Proxy(c, {
        get(target, key) {
          if (key === "query")
            return (...args: any[]) => {
              sql.push(
                typeof args[0] === "string" ? args[0] : args[0]?.text || "",
              );
              return (target.query as any)(...args);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as any;
    const a = await tenant(),
      n = await namespace(a, 130);
    let result;
    for (let i = 0; i < 4; i++) {
      result = await runBackupRollupSlice(measured);
      if (result.records) break;
    }
    expect(result?.records).toBe(64);
    expect(
      sql.filter((s) =>
        s.includes("INSERT INTO hub_backup_materialized_records"),
      ),
    ).toHaveLength(1);
    const b = await tenant(0);
    await pool.query(
      "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) SELECT $1,lpad(to_hex(n),64,'0'),'fixture',1 FROM generate_series(1,129)n",
      [b.profile],
    );
    sql.length = 0;
    let accounting;
    for (let i = 0; i < 4; i++)
      accounting = await runBackupAccountingSlice(measured, {
        profileId: b.profile,
      });
    expect(accounting?.complete).toBe(true);
    expect(sql.filter((s) => /UPDATE hub_chunks/.test(s))).toHaveLength(2);
    expect(
      (
        await pool.query(
          "SELECT backup_v1_staging_bytes,backup_v1_staging_chunks FROM hub_profiles WHERE id=$1",
          [b.profile],
        )
      ).rows[0],
    ).toMatchObject({
      backup_v1_staging_bytes: "129",
      backup_v1_staging_chunks: "129",
    });
  });
  it("makes committed progress for100000-record namespaces within bounded fair bursts", async () => {
    const a = await tenant(),
      b = await tenant(),
      large = await namespace(a, 100000),
      small = await namespace(b, 1);
    const summaries = [];
    for (let i = 0; i < 4; i++)
      summaries.push(
        await runBackupMaintenanceBurst(pool, { budgetMs: 200, maxSlices: 8 }),
      );
    expect(
      (
        await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
          small.job,
        ])
      ).rows[0].status,
    ).toBe("complete");
    const rows = Number(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_materialized_records WHERE namespace_version_id=$1",
          [large.version],
        )
      ).rows[0].count,
    );
    const state = (
      await pool.query("SELECT cursor FROM hub_backup_jobs WHERE id=$1", [
        large.job,
      ])
    ).rows[0].cursor;
    expect(
      rows > 0 ||
        (state?.format === "bounded-rollup-v2" && state.epochAfter > ""),
      "bounded bursts must commit durable epoch/key progress, not repeatedly rollback whole-namespace scans",
    ).toBe(true);
    expect(
      summaries.reduce((n, s) => n + s.examinedRecords, 0),
    ).toBeGreaterThan(64);
    expect(summaries.every((s) => s.durationMs < 500)).toBe(true);
  }, 15000);

  it("matches tombstone/clear/schema resolution while an ancestor materializes and detaches during the child scan", async () => {
    const t = await tenant(),
      grand = await namespace(t, 160, 0),
      parent = await namespace(t, 0, 1, grand.version),
      child = await namespace(t, 0, 2, parent.version);
    await pool.query(
      "UPDATE hub_backup_jobs SET status='complete' WHERE id=ANY($1::uuid[])",
      [[grand.job, parent.job]],
    );
    await pool.query(
      "UPDATE hub_backup_record_index SET store_epoch=1 WHERE namespace_version_id=$1",
      [grand.version],
    );
    const put = async (
      version: string,
      id: number,
      store: string,
      epoch: number,
      operation: string,
    ) =>
      pool.query(
        `INSERT INTO hub_backup_record_index(profile_id,namespace_version_id,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments) VALUES($1,$2,lpad(to_hex($3::int),64,'0'),$4,$5,$6,$7,1,'[]') ON CONFLICT(profile_id,namespace_version_id,record_id) DO UPDATE SET store_name=EXCLUDED.store_name,store_epoch=EXCLUDED.store_epoch,operation=EXCLUDED.operation`,
        [t.profile, version, id, store, epoch, operation, "a".repeat(64)],
      );
    await put(grand.version, 3, "other", 1, "put");
    await put(grand.version, 4, "records", 100, "put");
    await put(child.version, 1, "records", 1, "delete");
    await put(child.version, 2, "records", 2, "put");
    await put(child.version, 4, "records", 1, "put");
    await put(child.version, 5, "records", 2, "clear-store");
    await put(child.version, 161, "", 2, "schema");
    const fields =
      "record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments";
    const expected = (
      await pool.query(
        resolvedCTE + " SELECT " + fields + " FROM resolved ORDER BY record_id",
        [t.profile, child.version],
      )
    ).rows;
    const first = await runBackupRollupSlice(pool);
    expect(first.jobId).toBe(child.job);
    expect(first.records).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_rollup_sources WHERE job_id=$1",
          [child.job],
        )
      ).rows[0].count,
    ).toBe("3");
    await pool.query(
      "UPDATE hub_backup_jobs SET status='running',lease_expires_at=now()+interval '30 seconds' WHERE id=$1",
      [child.job],
    );
    await pool.query(
      "UPDATE hub_backup_jobs SET status='pending' WHERE id=$1",
      [parent.job],
    );
    for (let n = 0; n < 12; n++) {
      await runBackupRollupSlice(pool);
      if (
        (
          await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
            parent.job,
          ])
        ).rows[0].status === "complete"
      )
        break;
    }
    expect(
      (
        await pool.query(
          "SELECT materialized_ready,parent_version_id FROM hub_backup_namespace_versions WHERE namespace_version_id=$1",
          [parent.version],
        )
      ).rows[0],
    ).toMatchObject({ materialized_ready: true, parent_version_id: null });
    await expect(
      pool.query(
        "DELETE FROM hub_backup_namespace_versions WHERE namespace_version_id=$1",
        [grand.version],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(
      "UPDATE hub_backup_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [child.job],
    );
    for (let n = 0; n < 15; n++) {
      await runBackupRollupSlice(pool);
      if (
        (
          await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
            child.job,
          ])
        ).rows[0].status === "complete"
      )
        break;
    }
    expect(
      (
        await pool.query(
          "SELECT " +
            fields +
            " FROM hub_backup_materialized_records WHERE namespace_version_id=$1 ORDER BY record_id",
          [child.version],
        )
      ).rows,
    ).toEqual(expected);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_rollup_sources WHERE job_id=ANY($1::uuid[])",
          [[parent.job, child.job]],
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_rollup_epochs WHERE job_id=ANY($1::uuid[])",
          [[parent.job, child.job]],
        )
      ).rows[0].count,
    ).toBe("0");
    await expect(
      pool.query(
        "DELETE FROM hub_backup_namespace_versions WHERE namespace_version_id=$1",
        [grand.version],
      ),
    ).resolves.toBeDefined();
  });

  it("runs the actual compiled single-connection worker with bounded RSS, aggregate telemetry and prompt SIGTERM", async () => {
    const hot = await tenant(),
      cold = await tenant();
    await namespace(hot, 100000);
    const small = await namespace(cold, 1);
    const serverDir = fileURLToPath(new URL("../", import.meta.url)),
      repoDir = resolve(serverDir, "../.."),
      compiled = resolve(serverDir, "dist/hubBackupsV2Worker.js");
    const compose = await readFile(
      resolve(repoDir, "compose.backup-v2-worker.yaml"),
      "utf8",
    );
    expect(compose).toMatch(/cpus: 1\.0/);
    expect(compose).toMatch(/mem_limit: 1g/);
    expect(compose).toMatch(/max-old-space-size=768/);
    const database = new URL(url!);
    database.searchParams.set(
      "options",
      "-c search_path=" + schema + ",public",
    );
    const hashes: Record<string, string> = {};
    for (const f of [
      "hubBackupsV2Worker.js",
      "hubBackupsV2Maintenance.js",
      "hubBackupsV2BoundedRollup.js",
      "hubBackupsV2.js",
      "hubBackupsV2Cancellation.js",
    ])
      hashes[f] = createHash("sha256")
        .update(await readFile(resolve(serverDir, "dist", f)))
        .digest("hex");
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=768", compiled],
      {
        cwd: serverDir,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: database.href,
          DATA_ENCRYPTION_KEY: "isolated-fixture-master",
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      stderr = "";
    child.stdout.on("data", (v) => {
      output += v;
    });
    child.stderr.on("data", (v) => {
      stderr += v;
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const samples: Array<{
      rssKiB: number;
      cpuPercent: number;
      connections: number;
      controlMs: number;
    }> = [];
    let exit,
      shutdownMs = 0;
    try {
      for (let n = 0; n < 24; n++) {
        await new Promise((r) => setTimeout(r, 125));
        if (child.exitCode !== null)
          throw Error("WORKER_EXITED_EARLY:" + stderr.slice(0, 200));
        const ps = await promisify(execFile)("ps", [
            "-o",
            "rss=,pcpu=",
            "-p",
            String(child.pid),
          ]),
          [rssKiB, cpuPercent] = ps.stdout.trim().split(/\s+/).map(Number),
          start = performance.now();
        expect((await pool.query("SELECT 42 answer")).rows[0].answer).toBe(42);
        const controlMs = performance.now() - start;
        const connections = (
          await pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='atlas-maintenance' AND datname=current_database() AND query<>''",
          )
        ).rows[0].n;
        samples.push({ rssKiB, cpuPercent, connections, controlMs });
      }
      expect(
        Math.max(...samples.map((s) => s.connections)),
      ).toBeLessThanOrEqual(1);
      expect(Math.max(...samples.map((s) => s.rssKiB))).toBeLessThan(
        1024 * 1024,
      );
      expect(Math.max(...samples.map((s) => s.controlMs))).toBeLessThan(500);
      expect(
        (
          await pool.query("SELECT status FROM hub_backup_jobs WHERE id=$1", [
            small.job,
          ])
        ).rows[0].status,
      ).toBe("complete");
    } finally {
      const start = performance.now();
      child.kill("SIGTERM");
      exit = await Promise.race([
        closed,
        new Promise<never>((_r, reject) =>
          setTimeout(() => {
            child.kill("SIGKILL");
            reject(Error("WORKER_SHUTDOWN_EXCEEDED_3_SECONDS"));
          }, 3000).unref(),
        ),
      ]);
      shutdownMs = Math.round(performance.now() - start);
    }
    expect(exit.code).toBe(0);
    expect(shutdownMs).toBeLessThan(1000);
    expect(stderr).toBe("");
    const logs = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(logs.some((v) => v.event === "backup.maintenance")).toBe(true);
    expect(output).not.toContain(hot.profile);
    expect(output).not.toContain(cold.profile);
    const evidence = fileURLToPath(
      new URL("../../../../test-results/hub/maintenance/", import.meta.url),
    );
    await mkdir(evidence, { recursive: true });
    await writeFile(
      resolve(evidence, "WORKER_RESOURCES.json"),
      JSON.stringify(
        {
          result: "PASS",
          fixture:
            "Dedicated loopback PostgreSQL, actual compiled child worker",
          node: process.version,
          configured: {
            cpus: 1,
            memoryBytes: 1073741824,
            heapMiB: 768,
            poolConnections: 1,
          },
          qualification:
            "Actual host-process RSS/CPU observations plus candidateCompose resource configuration; this host process is not running inside a Linux cgroup",
          samples,
          shutdownMs,
          exit,
          logs,
          hashes,
        },
        null,
        2,
      ) + "\n",
    );
  }, 15000);
  it("keeps optional telemetry failures sanitized and independent from productive work/backoff", async () => {
    const observed = await backupMaintenanceTelemetry(async () => {
      throw Object.assign(Error("private query/profile detail"), {
        code: "57014",
      });
    });
    expect(observed).toEqual({
      backlog: { unavailable: true },
      telemetryErrors: 1,
    });
    expect(JSON.stringify(observed)).not.toContain("private");
    expect(
      await backupMaintenanceTelemetry(async () => ({ sampledJobs: 64 })),
    ).toEqual({ backlog: { sampledJobs: 64 }, telemetryErrors: 0 });
  });

  it("pauses new worker work when an online index is missing without blocking control SQL", async () => {
    const t = await tenant();
    await namespace(t, 1);
    await pool.query("DROP INDEX " + schema + ".hub_backup_parts_unheld");
    const paused = new Pool({
      connectionString: url,
      max: 1,
      options: "-c search_path=" + schema + ",public",
    });
    try {
      const result = await runBackupMaintenanceBurst(paused);
      expect(result.worked).toBe(false);
      expect(result.errors.busy).toBe(1);
      expect(result.slices).toBe(0);
      expect((await pool.query("SELECT 42 answer")).rows[0].answer).toBe(42);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_materialized_records",
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      await paused.end();
      await provisionBackupCatalogTestIndexes(pool);
    }
  });
});
