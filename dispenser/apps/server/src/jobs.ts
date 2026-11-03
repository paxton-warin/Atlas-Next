import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { DriveVerificationProvider } from "./googleDrive.js";
import { checkLink } from "./app.js";

export function startBackgroundJobs(
  pool: Pool,
  redis: Redis,
  drive: DriveVerificationProvider,
  log: { info: Function; error: Function },
) {
  let stopped = false;
  const lock = async (name: string, ttl: number, task: () => Promise<void>) => {
    const token = `${process.pid}:${Date.now()}`;
    if ((await redis.set(`job-lock:${name}`, token, "EX", ttl, "NX")) !== "OK")
      return;
    try {
      await task();
    } catch (error) {
      log.error({ err: error, job: name }, "background job failed");
    } finally {
      await redis.eval(
        "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
        1,
        `job-lock:${name}`,
        token,
      );
    }
  };
  const cleanup = () =>
    lock("cleanup", 240, async () => {
      await pool.query(
        `UPDATE link_assignments SET active=false WHERE active AND expires_at IS NOT NULL AND expires_at<=now()`,
      );
      await pool.query(
        `DELETE FROM sessions WHERE expires_at<now()-interval '7 days' OR revoked_at<now()-interval '7 days'`,
      );
      await pool.query(
        `UPDATE verifications SET status='expired' WHERE status='pending' AND expires_at<=now()`,
      );
      const abandoned = await pool.query<{
        id: string;
        google_drive_file_id: string;
      }>(
        `SELECT id,google_drive_file_id FROM verifications WHERE google_drive_file_id IS NOT NULL AND cleanup_status<>'complete' AND (status<>'pending' OR expires_at<=now()) ORDER BY created_at LIMIT 100`,
      );
      for (const attempt of abandoned.rows)
        try {
          await drive.removeVerificationFile(attempt.google_drive_file_id);
          await pool.query(
            `UPDATE verifications SET cleanup_status='complete' WHERE id=$1`,
            [attempt.id],
          );
        } catch (error) {
          await pool.query(
            `UPDATE verifications SET cleanup_status='retry' WHERE id=$1`,
            [attempt.id],
          );
          log.error(
            { err: error, verificationId: attempt.id },
            "Drive cleanup will retry",
          );
        }
    });
  const health = () =>
    lock("health", 300, async () => {
      const settings = await pool.query<{
        value: { enabled: boolean; intervalMinutes: number };
      }>("SELECT value FROM app_settings WHERE key='health'");
      if (!settings.rows[0]?.value.enabled) return;
      const links = await pool.query<{ id: string }>(
        `SELECT l.id FROM links l WHERE l.enabled AND l.health_monitoring AND NOT EXISTS(SELECT 1 FROM health_checks h WHERE h.link_id=l.id AND h.checked_at>now()-($1 || ' minutes')::interval) ORDER BY l.updated_at LIMIT 500`,
        [settings.rows[0].value.intervalMinutes],
      );
      for (const link of links.rows)
        await checkLink(pool, link.id).catch((error) =>
          log.error(
            { err: error, linkId: link.id },
            "link health check failed",
          ),
        );
    });
  void cleanup();
  void health();
  const cleanupTimer = setInterval(() => {
    if (!stopped) void cleanup();
  }, 5 * 60_000);
  const healthTimer = setInterval(() => {
    if (!stopped) void health();
  }, 60_000);
  cleanupTimer.unref();
  healthTimer.unref();
  return () => {
    stopped = true;
    clearInterval(cleanupTimer);
    clearInterval(healthTimer);
  };
}
