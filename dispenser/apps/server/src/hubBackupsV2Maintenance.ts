import { requireBackupCatalogReady } from "./hubBackupsV2Readiness.js";
/** Bounded, resumable maintenance. No native-storage actor, HTTP request or
 * control-pool connection depends on this scheduler. All row work is metadata. */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  withBackupTransaction,
  collectBackupGarbageSlice,
} from "./hubBackupsV2.js";
import { runBoundedRollupPage } from "./hubBackupsV2BoundedRollup.js";
import { runBackupAccountingSlice } from "./hubBackupsV2Accounting.js";

export type MaintenanceCategory = "rollup" | "gc" | "accounting";
export type MaintenanceSlice = {
  worked: boolean;
  category: MaintenanceCategory;
  profileId?: string;
  jobId?: string;
  complete?: boolean;
  records?: number;
  examinedRecords?: number;
  collectedParts?: number;
  collectedBytes?: number;
  deferred?: boolean;
};
export type MaintenanceBurst = {
  worked: boolean;
  durationMs: number;
  slices: number;
  records: number;
  examinedRecords: number;
  completedJobs: number;
  collectedParts: number;
  collectedBytes: number;
  deferredSlices: number;
  budgetExhausted: boolean;
  categorySlices: Record<MaintenanceCategory, number>;
  errors: { busy: number; database: number; unexpected: number };
};

/** Logs aggregate numbers only. Tenant/job identities and raw SQL errors never
 * enter the process telemetry, including bursts between reporting intervals. */
export function createBackupMaintenanceCounters() {
  const empty = () => ({
    bursts: 0,
    workedBursts: 0,
    slices: 0,
    records: 0,
    examinedRecords: 0,
    completedJobs: 0,
    collectedParts: 0,
    collectedBytes: 0,
    deferredSlices: 0,
    budgetExhaustions: 0,
    durationMs: 0,
    categorySlices: { rollup: 0, gc: 0, accounting: 0 },
    errors: { busy: 0, database: 0, unexpected: 0 },
  });
  let totals = empty();
  return {
    add(value: MaintenanceBurst) {
      totals.bursts++;
      totals.workedBursts += Number(value.worked);
      for (const key of [
        "slices",
        "records",
        "examinedRecords",
        "completedJobs",
        "collectedParts",
        "collectedBytes",
        "deferredSlices",
        "durationMs",
      ] as const)
        totals[key] += value[key];
      totals.budgetExhaustions += Number(value.budgetExhausted);
      for (const key of ["rollup", "gc", "accounting"] as const)
        totals.categorySlices[key] += value.categorySlices[key];
      for (const key of ["busy", "database", "unexpected"] as const)
        totals.errors[key] += value.errors[key];
    },
    snapshot(reset = false) {
      const result = structuredClone(totals);
      if (reset) totals = empty();
      return result;
    },
  };
}
export async function pauseBackupMaintenance(
  milliseconds: number,
  signal: AbortSignal,
) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, Math.min(60000, milliseconds)));
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
const categories: MaintenanceCategory[] = ["rollup", "gc", "accounting"];
const nilSignal = () => new AbortController().signal;
const eligibleJob = `((j.status='pending' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now()) OR j.status='running' AND j.lease_expires_at<now()) AND (n.namespace_version_id IS NOT NULL OR j.cursor->>'phase'='cleanup') OR j.status='complete' AND (EXISTS(SELECT 1 FROM hub_backup_rollup_sources pin WHERE pin.job_id=j.id) OR EXISTS(SELECT 1 FROM hub_backup_rollup_epochs epoch WHERE epoch.job_id=j.id)))`;
const gcEligible = `(EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=p.id AND pin.expires_at<=now()) OR EXISTS(SELECT 1 FROM hub_backup_parts b WHERE b.profile_id=p.id AND b.published_refs=0 AND(b.ever_published OR b.gc_eligible_at<=now() OR b.created_at<now()-interval '24 hours')) OR EXISTS(SELECT 1 FROM hub_backup_checkpoints x WHERE x.profile_id=p.id AND ((x.status='prepared' AND x.expires_at<now()) OR x.status IN ('expired','retired'))) OR EXISTS(SELECT 1 FROM hub_backup_jobs j WHERE j.profile_id=p.id AND j.kind='prune' AND j.status IN ('pending','running')))`;

async function nextCategory(
  pool: Pool,
  signal: AbortSignal,
  excluded: MaintenanceCategory[],
) {
  return withBackupTransaction(pool, signal, async (c) => {
    const row = (
      await c.query(
        "SELECT category,turn FROM hub_backup_maintenance_schedule WHERE category<>ALL($1::text[]) ORDER BY last_served_at,category LIMIT 1 FOR UPDATE SKIP LOCKED",
        [excluded],
      )
    ).rows[0];
    if (!row || !categories.includes(row.category)) return null;
    await c.query(
      "UPDATE hub_backup_maintenance_schedule SET last_served_at=clock_timestamp(),turn=turn+1 WHERE category=$1",
      [row.category],
    );
    return {
      category: row.category as MaintenanceCategory,
      turn: BigInt(row.turn) + 1n,
    };
  });
}

/** Claim is committed before the heavier page transaction. A killed/cancelled
 * page leaves a10s durable lease, so an impossible job cannot spin or starve peers. */
export async function runBackupRollupSlice(
  pool: Pool,
  options: {
    signal?: AbortSignal;
    urgent?: boolean;
    afterClaim?: (jobId: string) => Promise<void>;
  } = {},
): Promise<MaintenanceSlice> {
  const signal = options.signal ?? nilSignal(),
    owner = randomUUID();
  const job = await withBackupTransaction(pool, signal, async (c) => {
    const choose = (urgent: boolean) =>
      c.query(
        `SELECT j.* FROM hub_backup_jobs j LEFT JOIN hub_backup_namespace_versions n USING(profile_id,namespace_version_id) LEFT JOIN hub_backup_maintenance_profiles m ON m.profile_id=j.profile_id WHERE j.kind='rollup' AND ${eligibleJob} AND (NOT $1::boolean OR n.depth>=14) ORDER BY COALESCE(m.rollup_served_at,'-infinity'::timestamptz),j.last_served_at,j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [urgent],
      );
    let row = (await choose(!!options.urgent)).rows[0];
    if (!row && options.urgent) row = (await choose(false)).rows[0];
    if (!row) return null;
    await c.query(
      "UPDATE hub_backup_jobs SET status='running',owner_token=$2,attempts=attempts+1,lease_expires_at=now()+interval '10 seconds',last_served_at=clock_timestamp(),updated_at=now() WHERE id=$1",
      [row.id, owner],
    );
    await c.query(
      "INSERT INTO hub_backup_maintenance_profiles(profile_id,rollup_served_at) VALUES($1,clock_timestamp()) ON CONFLICT(profile_id) DO UPDATE SET rollup_served_at=EXCLUDED.rollup_served_at",
      [row.profile_id],
    );
    return row;
  });
  if (!job) return { worked: false, category: "rollup" };
  await options.afterClaim?.(job.id);
  return withBackupTransaction(pool, signal, async (c) => {
    const current = (
      await c.query(
        "SELECT cursor FROM hub_backup_jobs WHERE id=$1 AND owner_token=$2 AND status='running' AND lease_expires_at>now() FOR UPDATE",
        [job.id, owner],
      )
    ).rows[0];
    if (!current) return { worked: false, category: "rollup", deferred: true };
    const page = await runBoundedRollupPage(c, job, current.cursor);
    const complete = page.complete;
    await c.query(
      "UPDATE hub_backup_jobs SET status=$3,cursor=$4,lease_expires_at=NULL,owner_token=NULL,error_code=NULL,last_served_at=clock_timestamp(),updated_at=now() WHERE id=$1 AND owner_token=$2",
      [job.id, owner, complete ? "complete" : "pending", page.cursor],
    );
    return {
      worked: true,
      category: "rollup",
      profileId: job.profile_id,
      jobId: job.id,
      complete,
      records: page.records,
      examinedRecords: page.examinedRecords,
    };
  });
}

async function claimProfile(
  pool: Pool,
  category: "gc" | "accounting",
  signal: AbortSignal,
  activePriority: boolean,
) {
  const owner = randomUUID(),
    served = category + "_served_at",
    lease = category + "_lease_expires_at",
    token = category + "_owner_token";
  const profile = await withBackupTransaction(pool, signal, async (c) => {
    const criteria =
      category === "gc" ? gcEligible : "p.backup_accounting_version=0";
    const choose = (active: boolean) =>
      c.query(
        `SELECT p.id FROM hub_profiles p LEFT JOIN hub_backup_maintenance_profiles m ON m.profile_id=p.id WHERE ${criteria} AND (m.${lease} IS NULL OR m.${lease}<now()) AND (NOT $1::boolean OR EXISTS(SELECT 1 FROM hub_backup_replicas r WHERE r.profile_id=p.id AND r.deleted_at IS NULL)) ORDER BY COALESCE(m.${served},'-infinity'::timestamptz),p.id LIMIT 1 FOR NO KEY UPDATE OF p SKIP LOCKED`,
        [active],
      );
    let row = (await choose(category === "accounting" && activePriority))
      .rows[0];
    if (!row && category === "accounting" && activePriority)
      row = (await choose(false)).rows[0];
    if (!row) return null;
    await c.query(
      `INSERT INTO hub_backup_maintenance_profiles(profile_id,${served},${lease},${token}) VALUES($1,clock_timestamp(),now()+interval '10 seconds',$2) ON CONFLICT(profile_id) DO UPDATE SET ${served}=EXCLUDED.${served},${lease}=EXCLUDED.${lease},${token}=EXCLUDED.${token}`,
      [row.id, owner],
    );
    return row.id as string;
  });
  return profile ? { profile, owner, lease, token } : null;
}

export async function runBackupProfileMaintenanceSlice(
  pool: Pool,
  category: "gc" | "accounting",
  options: { signal?: AbortSignal; activePriority?: boolean } = {},
): Promise<MaintenanceSlice> {
  const signal = options.signal ?? nilSignal(),
    claim = await claimProfile(
      pool,
      category,
      signal,
      options.activePriority !== false,
    );
  if (!claim) return { worked: false, category };
  let result: {
    worked: boolean;
    deferred?: unknown;
    complete?: boolean;
    collectedParts?: number;
    collectedBytes?: number;
  };
  if (category === "gc")
    result = await withBackupTransaction(pool, signal, (c) =>
      collectBackupGarbageSlice(c, pool, { profileId: claim.profile }),
    );
  else
    result = await runBackupAccountingSlice(pool, {
      profileId: claim.profile,
      signal,
    });
  const progressed = result.worked && !result.deferred;
  await withBackupTransaction(pool, signal, (c) =>
    c.query(
      `UPDATE hub_backup_maintenance_profiles SET ${claim.lease}=${progressed ? "NULL" : "now()+interval '10 seconds'"},${claim.token}=NULL WHERE profile_id=$1 AND ${claim.token}=$2`,
      [claim.profile, claim.owner],
    ),
  );
  return {
    worked: progressed,
    category,
    profileId: claim.profile,
    complete: result.complete,
    collectedParts: result.collectedParts,
    collectedBytes: result.collectedBytes,
    deferred: !!result.deferred,
  };
}

/** Work-conserving, fair200ms burst; every slice commits/releases the one client.
 * Urgent rollup(depth>=14) is bounded to every fourth rollup selection. */
export async function runBackupMaintenanceBurst(
  pool: Pool,
  options: {
    signal?: AbortSignal;
    budgetMs?: number;
    maxSlices?: number;
    onSlice?: (slice: MaintenanceSlice) => Promise<void>;
  } = {},
): Promise<MaintenanceBurst> {
  const budget = Math.max(10, Math.min(200, options.budgetMs ?? 200)),
    maxSlices = Math.max(1, Math.min(32, options.maxSlices ?? 32));
  const control = new AbortController(),
    cancel = () => control.abort(),
    timer = setTimeout(cancel, budget),
    started = performance.now();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const result: MaintenanceBurst = {
    worked: false,
    durationMs: 0,
    slices: 0,
    records: 0,
    examinedRecords: 0,
    completedJobs: 0,
    collectedParts: 0,
    collectedBytes: 0,
    deferredSlices: 0,
    budgetExhausted: false,
    categorySlices: { rollup: 0, gc: 0, accounting: 0 },
    errors: { busy: 0, database: 0, unexpected: 0 },
  };
  const excluded = new Set<MaintenanceCategory>();
  try {
    await withBackupTransaction(pool, control.signal, (c) =>
      requireBackupCatalogReady(c, pool),
    );
    while (
      !control.signal.aborted &&
      result.slices < maxSlices &&
      excluded.size < 3
    ) {
      const next = await nextCategory(pool, control.signal, [...excluded]);
      if (!next) break;
      try {
        const slice =
          next.category === "rollup"
            ? await runBackupRollupSlice(pool, {
                signal: control.signal,
                urgent: next.turn % 4n === 0n,
              })
            : await runBackupProfileMaintenanceSlice(pool, next.category, {
                signal: control.signal,
                activePriority: next.turn % 4n !== 0n,
              });
        result.slices++;
        result.categorySlices[slice.category]++;
        result.deferredSlices += Number(!!slice.deferred);
        if (slice.worked) {
          result.worked = true;
          result.records += slice.records || 0;
          result.examinedRecords += slice.examinedRecords || 0;
          result.completedJobs += Number(!!slice.complete);
          result.collectedParts += slice.collectedParts || 0;
          result.collectedBytes += slice.collectedBytes || 0;
        } else excluded.add(next.category);
        await options.onSlice?.(slice);
      } catch (error) {
        if (control.signal.aborted) break;
        const code = (error as { code?: string })?.code;
        if (code === "BACKUP_BUSY" || ["57014", "55P03"].includes(code || ""))
          result.errors.busy++;
        else if (/^[0-9A-Z]{5}$/.test(code || "")) result.errors.database++;
        else result.errors.unexpected++;
        excluded.add(next.category);
      }
    }
  } catch (error) {
    if (!control.signal.aborted) {
      const code = (error as { code?: string })?.code;
      code === "BACKUP_BUSY" ? result.errors.busy++ : result.errors.database++;
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    result.durationMs = Math.round((performance.now() - started) * 10) / 10;
    result.budgetExhausted =
      control.signal.aborted || result.durationMs >= budget;
  }
  return result;
}

/** Bounded samples, explicitly not unbounded COUNT(*) telemetry on hot tables. */
export async function sampleBackupMaintenanceBacklog(
  pool: Pool,
  signal: AbortSignal = nilSignal(),
) {
  const control = new AbortController(),
    cancel = () => control.abort(),
    timer = setTimeout(cancel, 200);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await withBackupTransaction(pool, control.signal, async (c) => {
      const r = (
        await c.query(
          `WITH jobs AS MATERIALIZED (SELECT kind,status,created_at FROM hub_backup_jobs WHERE status IN ('pending','running') ORDER BY created_at,id LIMIT 1025), parts AS MATERIALIZED (SELECT profile_id FROM hub_backup_parts WHERE published_refs=0 AND(ever_published OR gc_eligible_at<=now() OR created_at<now()-interval '24 hours') LIMIT 1025), accounting AS MATERIALIZED (SELECT id FROM hub_profiles WHERE backup_accounting_version=0 LIMIT 1025) SELECT (SELECT count(*) FROM jobs) jobs,(SELECT count(*) FROM jobs WHERE kind='rollup') rollups,(SELECT count(*) FROM jobs WHERE kind='prune') prunes,(SELECT count(*) FROM parts) gc_parts,(SELECT count(*) FROM accounting) accounting_profiles,COALESCE((SELECT EXTRACT(EPOCH FROM(now()-min(created_at))) FROM jobs),0) oldest_seconds`,
        )
      ).rows[0];
      return {
        sampledJobs: Math.min(Number(r.jobs), 1024),
        rollupJobs: Math.min(Number(r.rollups), 1024),
        pruneJobs: Math.min(Number(r.prunes), 1024),
        sampledGcParts: Math.min(Number(r.gc_parts), 1024),
        sampledAccountingProfiles: Math.min(
          Number(r.accounting_profiles),
          1024,
        ),
        truncated: [r.jobs, r.gc_parts, r.accounting_profiles].some(
          (n) => Number(n) > 1024,
        ),
        oldestJobAgeSeconds: Math.max(0, Math.round(Number(r.oldest_seconds))),
      };
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/** Observability cannot turn productive maintenance into a failure/backoff loop.
 * SQL sampling remains bounded by its own deadline and emits no raw exception. */
export async function backupMaintenanceTelemetry(read: () => Promise<unknown>) {
  try {
    return { backlog: await read(), telemetryErrors: 0 };
  } catch {
    return { backlog: { unavailable: true }, telemetryErrors: 1 };
  }
}
