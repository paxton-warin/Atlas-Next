/** Existing heaps are indexed online BEFORE activating the new producer/worker.
 * Missing indexes pause backup work only; auth and local native storage remain independent. */
import type { Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";
export const BACKUP_CATALOG_INDEXES = Object.freeze([
  {
    name: "hub_backup_parts_unheld",
    table: "hub_backup_checkpoint_parts",
    columns: ["profile_id", "checkpoint_id", "ref_held", "hash"],
  },
  {
    name: "hub_backup_jobs_fair",
    table: "hub_backup_jobs",
    columns: ["kind", "status", "last_served_at", "created_at", "id"],
  },
  {
    name: "hub_backup_namespace_owner",
    table: "hub_backup_namespace_versions",
    columns: ["profile_id", "checkpoint_id"],
  },
  {
    name: "hub_backup_part_restore_refs",
    table: "hub_backup_checkpoint_parts",
    columns: ["profile_id", "hash", "checkpoint_id"],
  },
  {
    name: "hub_backup_part_gc_profile",
    table: "hub_backup_parts",
    columns: ["profile_id", "published_refs", "created_at", "hash"],
  },
  {
    name: "hub_backup_jobs_cleanup",
    table: "hub_backup_jobs",
    columns: ["profile_id", "status", "created_at", "id"],
  },
]);
const ident = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function backupCatalogIndexSQL(
  spec: (typeof BACKUP_CATALOG_INDEXES)[number],
  schema: string,
  concurrent = true,
) {
  return `CREATE INDEX ${concurrent ? "CONCURRENTLY " : ""}${ident(spec.name)} ON ${ident(schema)}.${ident(spec.table)} (${spec.columns.map(ident).join(",")})`;
}
export async function backupCatalogIndexStatus(c: Pick<PoolClient, "query">) {
  const rows = (
    await c.query(
      `SELECT idx.relname name,tab.relname table_name,i.indisvalid valid,i.indisready ready,i.indisunique unique_index,i.indisprimary primary_index,am.amname method,i.indnatts attrs,i.indnkeyatts keys,pg_get_expr(i.indpred,i.indrelid) predicate,ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) k) columns FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_namespace n ON n.oid=idx.relnamespace JOIN pg_am am ON am.oid=idx.relam WHERE n.nspname=current_schema() AND idx.relname=ANY($1::text[])`,
      [BACKUP_CATALOG_INDEXES.map((s) => s.name)],
    )
  ).rows;
  return BACKUP_CATALOG_INDEXES.map((spec) => {
    const row = rows.find((r) => r.name === spec.name),
      matches =
        !!row &&
        row.table_name === spec.table &&
        row.predicate == null &&
        !row.unique_index &&
        !row.primary_index &&
        row.method === "btree" &&
        Number(row.attrs) === spec.columns.length &&
        Number(row.keys) === spec.columns.length &&
        JSON.stringify(row.columns) === JSON.stringify(spec.columns);
    return {
      name: spec.name,
      present: !!row,
      matches,
      valid: matches && row.valid === true && row.ready === true,
    };
  });
}
const cache = new WeakMap<Pool, { checkedAt: number; ready: boolean }>();
export async function backupCatalogReady(c: PoolClient, pool: Pool) {
  const old = cache.get(pool);
  if (old && Date.now() - old.checkedAt < (old.ready ? 30000 : 1000))
    return old.ready;
  const ready = (await backupCatalogIndexStatus(c)).every((r) => r.valid);
  cache.set(pool, { checkedAt: Date.now(), ready });
  return ready;
}
export async function requireBackupCatalogReady(c: PoolClient, pool: Pool) {
  if (!(await backupCatalogReady(c, pool)))
    throw new AppError(
      "BACKUP_BUSY",
      "Backup metadata indexes are being prepared online. Browsing and local saves remain available.",
      503,
    );
}
/** Isolated fixtures only: provision empty test relations, never production heaps. */
export async function provisionBackupCatalogTestIndexes(
  c: Pick<PoolClient, "query">,
) {
  const row = (
    await c.query("SELECT current_database() db,current_schema() schema")
  ).rows[0];
  if (!String(row.db).endsWith("_test"))
    throw Error("DEDICATED_TEST_DATABASE_REQUIRED");
  for (const spec of BACKUP_CATALOG_INDEXES)
    if (
      !(await backupCatalogIndexStatus(c)).find((r) => r.name === spec.name)
        ?.valid
    )
      await c.query(backupCatalogIndexSQL(spec, row.schema, false));
}
