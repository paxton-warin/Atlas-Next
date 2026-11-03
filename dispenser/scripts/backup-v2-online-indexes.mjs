#!/usr/bin/env node
/** Dry-run by default. --apply requires recent DATABASE-HOST disk evidence.
 * Exactly six known indexes; no payload reads, broad UPDATE, WAL/fsync changes,
 * authenticated extra pool, or general-purpose schema/index deletion. */
import { createRequire } from "node:module";
const { Client } = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
)("pg");
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  BACKUP_CATALOG_INDEXES,
  backupCatalogIndexSQL,
  backupCatalogIndexStatus,
} from "../apps/server/dist/hubBackupsV2Readiness.js";
import { cancelBackupStatement } from "../apps/server/dist/hubBackupsV2Cancellation.js";
const apply = process.argv.includes("--apply"),
  headroomArg = process.argv.indexOf("--headroom-json"),
  headroomPath = headroomArg < 0 ? null : process.argv[headroomArg + 1];
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: "atlas-backup-online-indexes",
    connectionTimeoutMillis: 2000,
  }),
  steps = [];
let interrupted = false,
  current;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    void cancelBackupStatement(client).catch(() => false);
  });
const ident = (s) => '"' + s.replaceAll('"', '""') + '"';
try {
  await client.connect();
  await client.query(
    "SET lock_timeout='2000ms'; SET statement_timeout='15min'",
  );
  const server = (
    await client.query(
      "SELECT current_schema() schema,pg_size_bytes(current_setting('max_wal_size'))::text max_wal_bytes,current_setting('fsync') fsync,current_setting('wal_level') wal_level,(SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend') connections,current_setting('max_connections')::int max_connections,current_setting('superuser_reserved_connections')::int reserved",
    )
  ).rows[0];
  const tables = [...new Set(BACKUP_CATALOG_INDEXES.map((s) => s.table))],
    relations = (
      await client.query(
        "SELECT c.relname,pg_relation_size(c.oid)::text bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])",
        [tables],
      )
    ).rows;
  if (relations.length !== tables.length)
    throw Object.assign(Error(), { code: "BACKUP_SCHEMA_REQUIRED" });
  const before = await backupCatalogIndexStatus(client),
    targetBytes = relations.reduce((n, r) => n + Number(r.bytes), 0),
    maxWal = Number(server.max_wal_bytes);
  let evidence, walBytes;
  try {
    walBytes = Number(
      (
        await client.query(
          "SELECT COALESCE(sum(size),0)::text bytes FROM pg_ls_waldir()",
        )
      ).rows[0].bytes,
    );
  } catch {
    walBytes = undefined;
  }
  if (apply) {
    if (!headroomPath)
      throw Object.assign(Error(), {
        code: "RECENT_DATABASE_HOST_HEADROOM_REQUIRED",
      });
    evidence = JSON.parse(await readFile(headroomPath, "utf8"));
    const age = Date.now() - Date.parse(evidence.measuredAt);
    if (
      !Number.isFinite(age) ||
      age < -30000 ||
      age > 300000 ||
      !Number.isSafeInteger(evidence.freeDiskBytes) ||
      evidence.freeDiskBytes < 0
    )
      throw Object.assign(Error(), {
        code: "RECENT_DATABASE_HOST_HEADROOM_REQUIRED",
      });
    walBytes ??= evidence.walBytes;
    if (!Number.isSafeInteger(walBytes) || walBytes < 0)
      throw Object.assign(Error(), { code: "VERIFIED_WAL_HEADROOM_REQUIRED" });
    if (evidence.freeDiskBytes < 1073741824 + 2 * targetBytes + 2 * maxWal)
      throw Object.assign(Error(), {
        code: "INDEX_DISK_HEADROOM_INSUFFICIENT",
      });
    if (walBytes > 4 * maxWal)
      throw Object.assign(Error(), { code: "WAL_RETENTION_REQUIRES_REVIEW" });
    if (
      server.fsync !== "on" ||
      server.max_connections - server.reserved - server.connections < 4
    )
      throw Object.assign(Error(), {
        code: "DATABASE_DURABILITY_OR_CONNECTION_HEADROOM_REQUIRED",
      });
  }
  for (const spec of BACKUP_CATALOG_INDEXES) {
    current = spec.name;
    if (interrupted)
      throw Object.assign(Error(), { code: "INDEX_BUILD_INTERRUPTED" });
    let status = (await backupCatalogIndexStatus(client)).find(
      (i) => i.name === spec.name,
    );
    if (status.present && !status.matches)
      throw Object.assign(Error(), { code: "INDEX_DEFINITION_MISMATCH" });
    if (status.valid) {
      steps.push({ name: spec.name, action: "already-valid" });
      continue;
    }
    if (!apply) {
      steps.push({
        name: spec.name,
        action: status.present ? "would-rebuild-invalid" : "would-create",
      });
      continue;
    }
    const start = performance.now();
    if (status.present)
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS ${ident(server.schema)}.${ident(spec.name)}`,
      );
    await client.query(backupCatalogIndexSQL(spec, server.schema, true));
    status = (await backupCatalogIndexStatus(client)).find(
      (i) => i.name === spec.name,
    );
    if (!status?.valid)
      throw Object.assign(Error(), { code: "INDEX_NOT_VALID" });
    steps.push({
      name: spec.name,
      action: "created-concurrently",
      elapsedMs: Math.round(performance.now() - start),
    });
  }
  const after = await backupCatalogIndexStatus(client);
  console.log(
    JSON.stringify({
      ok: true,
      applied: apply,
      ready: after.every((i) => i.valid),
      targetHeapBytes: targetBytes,
      maxWalBytes: maxWal,
      walBytes: walBytes ?? null,
      freeDiskBytes: evidence?.freeDiskBytes ?? null,
      indexes: after,
      steps,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      code:
        typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : "INDEX_PREFLIGHT_FAILED",
      index: current || null,
      steps,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
