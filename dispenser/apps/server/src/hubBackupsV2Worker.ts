/** Candidate external maintenance service. One CPU/1GiB enforced by companion compose. */
import { Pool } from "pg";
import {
  runBackupMaintenanceBurst,
  sampleBackupMaintenanceBacklog,
  createBackupMaintenanceCounters,
  pauseBackupMaintenance,
  backupMaintenanceTelemetry,
} from "./hubBackupsV2Maintenance.js";
import { collectExpiredProfileUploads } from "./hubProfilePolicy.js";
const connectionString = process.env.DATABASE_URL,
  key = process.env.DATA_ENCRYPTION_KEY;
if (!connectionString || !key)
  throw Error("Backup maintenance configuration required");
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 1000,
  statement_timeout: 2000,
  lock_timeout: 250,
  idle_in_transaction_session_timeout: 4000,
  application_name: "atlas-maintenance",
});
let stopping = false;
const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true;
    shutdown.abort();
  });
let lastTelemetry = 0,
  lastLegacySweep = 0,
  failures = 0;
const counters = createBackupMaintenanceCounters();
try {
  while (!stopping) {
    let pause = 1000;
    try {
      const progress = await runBackupMaintenanceBurst(pool, {
        signal: shutdown.signal,
      });
      const errors = Object.values(progress.errors).reduce(
        (n, value) => n + value,
        0,
      );
      counters.add(progress);
      failures = errors ? Math.min(6, failures + 1) : 0;
      pause = errors
        ? Math.min(60000, 1000 * 2 ** failures)
        : progress.worked
          ? 25
          : 1000;
      if (Date.now() - lastTelemetry >= 30000) {
        // Advance cadence even when this optional observer times out. A
        // telemetry error must not throttle successfully committed work.
        lastTelemetry = Date.now();
        const telemetry = await backupMaintenanceTelemetry(()=>sampleBackupMaintenanceBacklog(pool,shutdown.signal));
        console.info(
          JSON.stringify({
            event: "backup.maintenance",
            ...counters.snapshot(true),
            ...telemetry,
          }),
        );
      }
      if (!errors && !progress.worked && Date.now() - lastLegacySweep >= 60000) {
        lastLegacySweep = Date.now();
        const legacy = await collectExpiredProfileUploads(pool, key, 1, {
          budgetMs: 200,
        });
        if (legacy.failed || legacy.chunks)
          console.info(
            JSON.stringify({
              event: "backup.maintenance.legacy_gc",
              failedProfiles: legacy.failed,
              collectedChunks: legacy.chunks,
              collectedBytes: legacy.bytes,
            }),
          );
      }
    } catch (error) {
      if (!stopping) {
        failures = Math.min(6, failures + 1);
        pause = Math.min(60000, 1000 * 2 ** failures);
        const code = (error as { code?: string })?.code;
        console.warn(
          JSON.stringify({
            event: "backup.maintenance.failure",
            category: code === "BACKUP_BUSY" ? "busy" : "database",
            retryMs: pause,
          }),
        );
      }
    }
    if (!stopping) await pauseBackupMaintenance(pause, shutdown.signal);
  }
} finally {
  await pool.end();
}
