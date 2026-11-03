/** Existing profiles activate maintained accounting only after a stable, bounded metadata cut. */
import type { Pool } from "pg";
import { withBackupTransaction } from "./hubBackupsV2.js";
const accountingCursors = new WeakMap<Pool, string>();
type SliceOptions = {
  profileId?: string;
  activeOnly?: boolean;
  legacyOnly?: boolean;
  excludeProfiles?: string[];
  signal?: AbortSignal;
};
const activeAccountingCursors = new WeakMap<Pool, string>();
export async function runBackupAccountingSlice(
  pool: Pool,
  options: SliceOptions = {},
) {
  const cursors = options.activeOnly
    ? activeAccountingCursors
    : accountingCursors;
  return withBackupTransaction(
    pool,
    options.signal ?? new AbortController().signal,
    async (c) => {
      const select = (cursor?: string) =>
        c.query(
          `SELECT p.* FROM hub_profiles p WHERE p.backup_accounting_version=0
 AND ($1::uuid IS NULL OR p.id>$1) AND ($2::uuid IS NULL OR p.id=$2) AND p.id<>ALL($3::uuid[])
 AND (NOT $4::boolean OR EXISTS(SELECT 1 FROM hub_backup_replicas r WHERE r.profile_id=p.id AND r.deleted_at IS NULL))
 AND (NOT $5::boolean OR NOT EXISTS(SELECT 1 FROM hub_backup_replicas r WHERE r.profile_id=p.id AND r.deleted_at IS NULL))
 ORDER BY p.id LIMIT 1 FOR NO KEY UPDATE OF p SKIP LOCKED`,
          [
            cursor || null,
            options.profileId || null,
            options.excludeProfiles || [],
            !!options.activeOnly,
            !!options.legacyOnly,
          ],
        );
      let p = (await select(options.profileId ? undefined : cursors.get(pool)))
        .rows[0];
      if (!p && !options.profileId && cursors.has(pool))
        p = (await select()).rows[0];
      if (!p) return { worked: false };
      if (!options.profileId) cursors.set(pool, p.id);
      if (
        Number(p.chunk_accounting_version) !== 1 &&
        (
          await c.query(
            "SELECT 1 FROM hub_chunks WHERE profile_id=$1 LIMIT 1",
            [p.id],
          )
        ).rowCount
      )
        return {
          worked: true,
          complete: false,
          deferred: "LEGACY_REFERENCE_ACCOUNTING_PENDING",
          profileId: p.id,
        };
      let job = (
        await c.query(
          "SELECT * FROM hub_backup_jobs WHERE profile_id=$1 AND kind='reconcile' AND status IN ('pending','running') ORDER BY created_at LIMIT 1 FOR UPDATE",
          [p.id],
        )
      ).rows[0];
      const fresh = () => ({
        phase: "streams",
        epoch: String(p.backup_accounting_epoch),
        last: "",
        canonical: 0,
        staged: 0,
        chunks: 0,
      });
      if (!job)
        job = (
          await c.query(
            "INSERT INTO hub_backup_jobs(profile_id,kind,cursor) VALUES($1,'reconcile',$2) RETURNING *",
            [p.id, fresh()],
          )
        ).rows[0];
      let cursor = job.cursor;
      if (!cursor || cursor.epoch !== String(p.backup_accounting_epoch))
        cursor = fresh();
      const limit = 128;
      if (cursor.phase === "streams") {
        const rows = (
          await c.query(
            "SELECT namespace,bytes FROM hub_streams WHERE profile_id=$1 AND namespace>$2 ORDER BY namespace LIMIT 129",
            [p.id, cursor.last],
          )
        ).rows;
        for (const row of rows.slice(0, limit))
          cursor.canonical += Number(row.bytes);
        if (rows.length > limit) cursor.last = rows[127].namespace;
        else {
          cursor.phase = "recoveries";
          cursor.last = "";
        }
      } else if (cursor.phase === "recoveries") {
        const rows = (
          await c.query(
            "SELECT id,bytes FROM hub_profile_recoveries WHERE profile_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 129",
            [p.id, cursor.last || null],
          )
        ).rows;
        for (const row of rows.slice(0, limit))
          cursor.canonical += Number(row.bytes);
        if (rows.length > limit) cursor.last = rows[127].id;
        else {
          cursor.phase = "chunks";
          cursor.last = "";
        }
      } else {
        const rows = (
          await c.query(
            "SELECT c.hash,c.bytes,(SELECT count(*) FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash) refs FROM hub_chunks c WHERE c.profile_id=$1 AND c.hash>$2 ORDER BY c.hash LIMIT 129",
            [p.id, cursor.last],
          )
        ).rows;
        for (const row of rows.slice(0, limit)) {
          const refs = Number(row.refs);
          if (refs > 0) cursor.canonical += Number(row.bytes);
          else {
            cursor.staged += Number(row.bytes);
            cursor.chunks++;
          }
        }
        if (rows.length)
          await c.query(
            "UPDATE hub_chunks c SET backup_reference_count=x.refs FROM jsonb_to_recordset($2::jsonb) x(hash text,refs bigint) WHERE c.profile_id=$1 AND c.hash=x.hash",
            [
              p.id,
              JSON.stringify(
                rows
                  .slice(0, limit)
                  .map((row) => ({ hash: row.hash, refs: Number(row.refs) })),
              ),
            ],
          );
        if (rows.length > limit) cursor.last = rows[127].hash;
        else {
          await c.query(
            "UPDATE hub_profiles SET backup_v1_canonical_bytes=$2,backup_v1_staging_bytes=$3,backup_v1_staging_chunks=$4,backup_accounting_version=1,bytes=$2+GREATEST(0,backup_v2_bytes-backup_v2_migration_credit) WHERE id=$1 AND backup_accounting_epoch=$5",
            [
              p.id,
              cursor.canonical,
              cursor.staged,
              cursor.chunks,
              cursor.epoch,
            ],
          );
          await c.query(
            "UPDATE hub_backup_jobs SET status='complete',cursor=$2,updated_at=now() WHERE id=$1",
            [job.id, cursor],
          );
          return { worked: true, complete: true, profileId: p.id };
        }
      }
      await c.query(
        "UPDATE hub_backup_jobs SET cursor=$2,status='pending',updated_at=now() WHERE id=$1",
        [job.id, cursor],
      );
      return {
        worked: true,
        complete: false,
        phase: cursor.phase,
        profileId: p.id,
      };
    },
  );
}

/** Prioritize real v2 publishers without placing reconciliation on an HTTP or native-write path.
 * Each slice commits/releases its client before the next. One shared200ms signal bounds
 * acquisition, SQL and the entire burst; an impossible profile is visited only once/tick. */
export async function runBackupAccountingActivation(
  pool: Pool,
  options: {
    budgetMs?: number;
    maxSlicesPerProfile?: number;
    maxProfiles?: number;
    afterSlice?: (profileId: string) => Promise<void>;
  } = {},
) {
  const budget = Math.max(10, Math.min(200, options.budgetMs ?? 200)),
    maxSlices = Math.max(1, Math.min(8, options.maxSlicesPerProfile ?? 8)),
    maxProfiles = Math.max(1, Math.min(16, options.maxProfiles ?? 16));
  const control = new AbortController(),
    timer = setTimeout(() => control.abort(), budget),
    started = performance.now(),
    visited = new Set<string>();
  const result = {
    worked: false,
    profiles: 0,
    slices: 0,
    completedProfiles: 0,
    deferredProfiles: 0,
    budgetExhausted: false,
  };
  try {
    while (
      !control.signal.aborted &&
      visited.size < maxProfiles &&
      performance.now() - started < budget
    ) {
      let current = await runBackupAccountingSlice(pool, {
        activeOnly: true,
        excludeProfiles: [...visited],
        signal: control.signal,
      });
      if (!current.worked || !current.profileId) break;
      result.worked = true;
      result.profiles++;
      visited.add(current.profileId);
      let slices = 0;
      for (;;) {
        result.slices++;
        slices++;
        if (options.afterSlice) await options.afterSlice(current.profileId!);
        if (current.complete) {
          result.completedProfiles++;
          break;
        }
        if (current.deferred) {
          result.deferredProfiles++;
          break;
        }
        if (
          control.signal.aborted ||
          slices >= maxSlices ||
          performance.now() - started >= budget
        )
          break;
        current = await runBackupAccountingSlice(pool, {
          profileId: current.profileId,
          signal: control.signal,
        });
        if (!current.worked) break;
      }
    }
    result.budgetExhausted =
      control.signal.aborted || performance.now() - started >= budget;
    return result;
  } catch (error) {
    if (control.signal.aborted || (error as any)?.code === "BACKUP_BUSY")
      return { ...result, budgetExhausted: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
