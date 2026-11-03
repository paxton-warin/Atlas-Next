/** Small explicit request queue in front of the two-connection bulk pool. */
import { performance } from "node:perf_hooks";
import { AppError } from "./errors.js";
export type BackupOperation = "prepare" | "upload" | "publish" | "restore";
export function createBackupAdmission(
  limits = { active: 2, queued: 8, waitMs: 250 },
) {
  let active = 0,
    accepted = 0,
    rejected = 0,
    cancelled = 0,
    completed = 0,
    failed = 0,
    waitSumMs = 0,
    waitMaxMs = 0;
  const perOperation: Record<
    BackupOperation,
    { accepted: number; rejected: number; completed: number; failed: number }
  > = {
    prepare: { accepted: 0, rejected: 0, completed: 0, failed: 0 },
    upload: { accepted: 0, rejected: 0, completed: 0, failed: 0 },
    publish: { accepted: 0, rejected: 0, completed: 0, failed: 0 },
    restore: { accepted: 0, rejected: 0, completed: 0, failed: 0 },
  };
  type Waiter = {
    signal: AbortSignal;
    grant: () => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    abort: () => void;
    operation: BackupOperation;
    started: number;
  };
  const queue: Waiter[] = [];
  const busy = () =>
    new AppError(
      "BACKUP_BUSY",
      "Backup capacity is busy. Local saves continue; retry later.",
      429,
    );
  function dispatch() {
    while (active < limits.active && queue.length) {
      const w = queue.shift()!;
      clearTimeout(w.timer);
      w.signal.removeEventListener("abort", w.abort);
      if (w.signal.aborted) {
        cancelled++;
        w.reject(busy());
        continue;
      }
      active++;
      const wait = performance.now() - w.started;
      waitSumMs += wait;
      waitMaxMs = Math.max(waitMaxMs, wait);
      w.grant();
    }
  }
  async function acquire(signal: AbortSignal, operation: BackupOperation) {
    if (signal.aborted) {
      cancelled++;
      throw busy();
    }
    if (active < limits.active && queue.length === 0) {
      active++;
      return;
    }
    if (queue.length >= limits.queued) {
      rejected++;
      perOperation[operation].rejected++;
      throw busy();
    }
    await new Promise<void>((resolve, reject) => {
      const w = {} as Waiter;
      Object.assign(w, {
        signal,
        operation,
        started: performance.now(),
        grant: resolve,
        reject,
        abort: () => {
          const i = queue.indexOf(w);
          if (i < 0) return;
          queue.splice(i, 1);
          clearTimeout(w.timer);
          signal.removeEventListener("abort", w.abort);
          cancelled++;
          reject(busy());
        },
      });
      w.timer = setTimeout(() => {
        const i = queue.indexOf(w);
        if (i < 0) return;
        queue.splice(i, 1);
        signal.removeEventListener("abort", w.abort);
        rejected++;
        perOperation[operation].rejected++;
        reject(busy());
      }, limits.waitMs);
      queue.push(w);
      signal.addEventListener("abort", w.abort, { once: true });
      if (signal.aborted) w.abort();
    });
  }
  return {
    async run<T>(
      operation: BackupOperation,
      signal: AbortSignal,
      work: () => Promise<T>,
    ) {
      await acquire(signal, operation);
      accepted++;
      perOperation[operation].accepted++;
      try {
        if (signal.aborted) throw busy();
        const result = await work();
        completed++;
        perOperation[operation].completed++;
        return result;
      } catch (e) {
        failed++;
        perOperation[operation].failed++;
        throw e;
      } finally {
        active--;
        dispatch();
      }
    },
    snapshot() {
      return {
        limits: { ...limits },
        active,
        queued: queue.length,
        accepted,
        rejected,
        cancelled,
        completed,
        failed,
        waitSumMs,
        waitMaxMs,
        operations: structuredClone(perOperation),
      };
    },
  };
}
const admissions = new Set<ReturnType<typeof createBackupAdmission>>();
export function registerBackupAdmission() {
  const a = createBackupAdmission();
  admissions.add(a);
  return a;
}
export function unregisterBackupAdmission(
  a: ReturnType<typeof createBackupAdmission>,
) {
  admissions.delete(a);
}
export function backupAdmissionSnapshot() {
  return [...admissions].map((a) => a.snapshot());
}
const dbPhases = {
  acquire: { count: 0, sumMs: 0, maxMs: 0, buckets: Array(9).fill(0) },
  accountLockWait: { count: 0, sumMs: 0, maxMs: 0, buckets: Array(9).fill(0) },
  accountLockThroughCommit: {
    count: 0,
    sumMs: 0,
    maxMs: 0,
    buckets: Array(9).fill(0),
  },
};
const dbBounds = [1, 5, 10, 50, 100, 250, 1000, 4000];
export function recordBackupDbTiming(phase: keyof typeof dbPhases, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const row = dbPhases[phase];
  row.count++;
  row.sumMs += ms;
  row.maxMs = Math.max(row.maxMs, ms);
  const bucket = dbBounds.findIndex((n) => ms <= n);
  row.buckets[bucket < 0 ? 8 : bucket]++;
}
export function backupDatabaseSnapshot() {
  return {
    bucketUpperBoundsMs: [...dbBounds, null],
    phases: structuredClone(dbPhases),
  };
}
