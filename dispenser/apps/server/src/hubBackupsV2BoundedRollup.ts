/** Immutable ancestry pins plus bounded indexed windows. A large namespace is
 * never re-sorted in full just to materialize its next64 record references. */
import type { PoolClient } from "pg";
type Cursor = {
  format: "bounded-rollup-v2";
  phase: "epochs" | "records" | "cleanup";
  recordId: string;
  epochAfter: string;
};
export type BoundedRollupPage = {
  cursor: Cursor | null;
  complete: boolean;
  records: number;
  examinedRecords: number;
};
const key = (v: unknown) =>
  typeof v === "string" && (v === "" || /^[a-f0-9]{64}$/.test(v));
const invalid = () =>
  Object.assign(new Error("Bounded immutable rollup metadata is invalid."), {
    code: "BACKUP_ROLLUP_INVALID",
  });
const columns = (full: boolean) =>
  "r.record_id,r.store_name,r.store_epoch,r.operation" +
  (full ? ",r.sha256,r.total_bytes,r.fragments" : "");
/** Each source index contributes at most65 keys, then only the next64 global
 * candidate keys are resolved. Tombstones/clears still advance this cursor. */
export function boundedRollupWindowSQL(full = false) {
  const fields = columns(full);
  return `WITH sources AS MATERIALIZED(SELECT * FROM hub_backup_rollup_sources WHERE profile_id=$1 AND job_id=$2), heads AS MATERIALIZED(
 SELECT h.record_id FROM sources s CROSS JOIN LATERAL (
 (SELECT r.record_id FROM hub_backup_record_index r WHERE s.source_form='index' AND r.profile_id=$1 AND r.namespace_version_id=s.namespace_version_id AND r.record_id>$3 ORDER BY r.record_id LIMIT 65)
 UNION ALL (SELECT r.record_id FROM hub_backup_materialized_records r WHERE s.source_form='materialized' AND r.profile_id=$1 AND r.namespace_version_id=s.namespace_version_id AND r.record_id>$3 ORDER BY r.record_id LIMIT 65)) h
 ), next_keys AS MATERIALIZED(SELECT DISTINCT record_id FROM heads ORDER BY record_id LIMIT 65), work_keys AS MATERIALIZED(SELECT record_id FROM next_keys ORDER BY record_id LIMIT 64), entries AS(
 SELECT r.*,s.depth FROM sources s CROSS JOIN work_keys k CROSS JOIN LATERAL(
 SELECT ${fields} FROM hub_backup_record_index r WHERE s.source_form='index' AND r.profile_id=$1 AND r.namespace_version_id=s.namespace_version_id AND r.record_id=k.record_id
 UNION ALL SELECT ${fields} FROM hub_backup_materialized_records r WHERE s.source_form='materialized' AND r.profile_id=$1 AND r.namespace_version_id=s.namespace_version_id AND r.record_id=k.record_id) r
 ), latest AS MATERIALIZED(SELECT DISTINCT ON(record_id) * FROM entries ORDER BY record_id,depth)`;
}
async function pinSources(c: PoolClient, job: any) {
  const existing = await c.query(
    "SELECT namespace_version_id,source_form,depth FROM hub_backup_rollup_sources WHERE profile_id=$1 AND job_id=$2 ORDER BY depth",
    [job.profile_id, job.id],
  );
  if (existing.rows.length) {
    if (existing.rows.length > 17 || Number(existing.rows[0].depth) !== 0)
      throw invalid();
    return;
  }
  const rows = (
    await c.query(
      `WITH RECURSIVE chain AS(SELECT namespace_version_id,parent_version_id,materialized_ready,0 depth FROM hub_backup_namespace_versions WHERE profile_id=$1 AND namespace_version_id=$2 UNION ALL SELECT n.namespace_version_id,n.parent_version_id,n.materialized_ready,p.depth+1 FROM chain p JOIN hub_backup_namespace_versions n ON n.profile_id=$1 AND n.namespace_version_id=p.parent_version_id WHERE p.depth<16 AND NOT p.materialized_ready) SELECT * FROM chain ORDER BY depth`,
      [job.profile_id, job.namespace_version_id],
    )
  ).rows;
  if (
    !rows.length ||
    rows.length > 17 ||
    new Set(rows.map((r) => r.namespace_version_id)).size !== rows.length ||
    (rows.at(-1).parent_version_id && !rows.at(-1).materialized_ready)
  )
    throw invalid();
  const locked = await c.query(
    "SELECT namespace_version_id FROM hub_backup_namespace_versions WHERE profile_id=$1 AND namespace_version_id=ANY($2::uuid[]) ORDER BY namespace_version_id FOR KEY SHARE",
    [job.profile_id, rows.map((r) => r.namespace_version_id)],
  );
  if (locked.rowCount !== rows.length) throw invalid();
  await c.query(
    `INSERT INTO hub_backup_rollup_sources(profile_id,job_id,namespace_version_id,source_form,depth) SELECT $1,$2,x.id,x.form,x.depth FROM jsonb_to_recordset($3::jsonb) x(id uuid,form text,depth smallint)`,
    [
      job.profile_id,
      job.id,
      JSON.stringify(
        rows.map((r) => ({
          id: r.namespace_version_id,
          form: r.materialized_ready ? "materialized" : "index",
          depth: Number(r.depth),
        })),
      ),
    ],
  );
}
async function cleanup(
  c: PoolClient,
  job: any,
  cursor: Cursor,
): Promise<BoundedRollupPage> {
  // <=17 ancestry pins. The source has already atomically switched to its
  // completed materialized table before these immutable ancestors are released.
  await c.query(
    "DELETE FROM hub_backup_rollup_sources WHERE profile_id=$1 AND job_id=$2",
    [job.profile_id, job.id],
  );
  await c.query(
    `DELETE FROM hub_backup_rollup_epochs e WHERE e.profile_id=$1 AND e.job_id=$2 AND e.store_name IN(SELECT store_name FROM hub_backup_rollup_epochs WHERE profile_id=$1 AND job_id=$2 ORDER BY store_name LIMIT 64)`,
    [job.profile_id, job.id],
  );
  const left = (
    await c.query(
      "SELECT 1 FROM hub_backup_rollup_epochs WHERE profile_id=$1 AND job_id=$2 LIMIT 1",
      [job.profile_id, job.id],
    )
  ).rowCount;
  return {
    cursor: left ? { ...cursor, phase: "cleanup" } : null,
    complete: !left,
    records: 0,
    examinedRecords: 0,
  };
}
/** The caller holds the job row/token, not the account publication lock. */
export async function runBoundedRollupPage(
  c: PoolClient,
  job: any,
  rawCursor: unknown,
): Promise<BoundedRollupPage> {
  const old = rawCursor as Partial<Cursor> | null;
  let cursor: Cursor;
  if (old?.format === "bounded-rollup-v2") {
    if (
      !["epochs", "records", "cleanup"].includes(old.phase || "") ||
      !key(old.recordId) ||
      !key(old.epochAfter)
    )
      throw invalid();
    cursor = old as Cursor;
  } else
    cursor = {
      format: "bounded-rollup-v2",
      phase: job.status === "complete" ? "cleanup" : "epochs",
      recordId: key(old?.recordId) ? old!.recordId! : "",
      epochAfter: "",
    };
  if (cursor.phase === "cleanup") return cleanup(c, job, cursor);
  await pinSources(c, job);
  let examinedRecords = 0;
  if (cursor.phase === "epochs") {
    const row = (
      await c.query(
        boundedRollupWindowSQL() +
          `, epochs AS(SELECT store_name,max(store_epoch) epoch FROM latest GROUP BY store_name), written AS(INSERT INTO hub_backup_rollup_epochs(profile_id,job_id,store_name,store_epoch) SELECT $1,$2,store_name,epoch FROM epochs ON CONFLICT(job_id,store_name) DO UPDATE SET store_epoch=GREATEST(hub_backup_rollup_epochs.store_epoch,EXCLUDED.store_epoch) RETURNING store_name) SELECT (SELECT count(*) FROM next_keys)::int page_count,(SELECT max(record_id) FROM work_keys) last_record,(SELECT count(*) FROM written)::int written_count`,
        [job.profile_id, job.id, cursor.epochAfter],
      )
    ).rows[0];
    const count = Number(row.page_count);
    if (!Number.isSafeInteger(count) || count < 0 || count > 65)
      throw invalid();
    examinedRecords = Math.min(count, 64);
    if (count > 64)
      return {
        cursor: { ...cursor, epochAfter: row.last_record },
        complete: false,
        records: 0,
        examinedRecords,
      };
    cursor = {
      ...cursor,
      phase: "records",
      epochAfter: row.last_record || cursor.epochAfter,
    };
  }
  const row = (
    await c.query(
      boundedRollupWindowSQL(true) +
        `, eligible AS(SELECT l.* FROM latest l JOIN hub_backup_rollup_epochs e ON e.profile_id=$1 AND e.job_id=$2 AND e.store_name=l.store_name WHERE l.operation='schema' OR(l.store_epoch=e.store_epoch AND l.operation='put')), written AS(INSERT INTO hub_backup_materialized_records(profile_id,namespace_version_id,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments) SELECT $1,$4,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments FROM eligible ON CONFLICT DO NOTHING RETURNING record_id) SELECT (SELECT count(*) FROM next_keys)::int page_count,(SELECT count(*) FROM written)::int written_count,(SELECT max(record_id) FROM work_keys) last_record`,
      [job.profile_id, job.id, cursor.recordId, job.namespace_version_id],
    )
  ).rows[0];
  const count = Number(row.page_count);
  if (!Number.isSafeInteger(count) || count < 0 || count > 65) throw invalid();
  const records = Number(row.written_count),
    next = { ...cursor, recordId: row.last_record || cursor.recordId };
  examinedRecords += Math.min(count, 64);
  if (count > 64)
    return { cursor: next, complete: false, records, examinedRecords };
  await c.query(
    "UPDATE hub_backup_namespace_versions SET materialized_ready=true,parent_version_id=NULL,depth=0,delta_bytes=0 WHERE profile_id=$1 AND namespace_version_id=$2",
    [job.profile_id, job.namespace_version_id],
  );
  const cleaned = await cleanup(c, job, { ...next, phase: "cleanup" });
  return { ...cleaned, records, examinedRecords };
}
