/** Authenticated bounded read leases, never native-write/publication authority.
 * A client-chosen random attempt identity fences delayed cleanup from newer
 * restores even when account, branch, session and checkpoint are identical. */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { HubSession } from "./hubIdentity.js";
import { AppError } from "./errors.js";
export type RestoreReaderSession = Pick<
  HubSession,
  "branchId" | "userId" | "profileId" | "sessionId" | "contextId"
>;
export const RESTORE_PIN_LIMITS = Object.freeze({
  ttlSeconds: 120,
  renewAfterSeconds: 30,
  activePerProfile: 8,
  expiredPerSlice: 32,
});
export function restoreReaderId(
  s: Pick<HubSession, "branchId" | "sessionId" | "contextId">,
) {
  return createHash("sha256")
    .update(JSON.stringify([s.branchId, s.sessionId, s.contextId]))
    .digest("hex");
}
async function lockProfile(c: PoolClient, s: RestoreReaderSession) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM hub_profiles WHERE id=$1 AND user_id=$2 FOR NO KEY UPDATE",
        [s.profileId, s.userId],
      )
    ).rowCount
  )
    throw new AppError(
      "HUB_SESSION_EXPIRED",
      "This cloud profile is no longer available.",
      401,
    );
}
/** Short account lock makes source selection+pin atomic against retirement.
 * No attempt is rebound to another lease. Legacy GETs reuse one separate row. */
export async function acquireRestorePin(
  c: PoolClient,
  s: RestoreReaderSession,
  checkpointId: string,
  attemptId?: string,
) {
  await lockProfile(c, s);
  const reader = restoreReaderId(s),
    cp = (
      await c.query(
        `SELECT cp.checkpoint_id FROM hub_backup_checkpoints cp JOIN hub_backup_replicas owner USING(profile_id,replica_id) WHERE cp.profile_id=$1 AND cp.checkpoint_id=$2 AND cp.status='complete' AND(owner.deleted_at IS NULL OR EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=cp.profile_id AND seed.seed_checkpoint_id=cp.checkpoint_id AND seed.deleted_at IS NULL AND seed.head_checkpoint_id IS NULL) OR EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=cp.profile_id AND pin.checkpoint_id=cp.checkpoint_id AND pin.reader_id=$3 AND pin.expires_at>clock_timestamp())) FOR KEY SHARE OF cp`,
        [s.profileId, checkpointId, reader],
      )
    ).rows[0];
  if (!cp)
    throw new AppError(
      "BACKUP_NOT_FOUND",
      "The selected completed backup is no longer available. Retry with the latest backup.",
      404,
    );
  const legacy = attemptId === undefined;
  const old = legacy
    ? (
        await c.query(
          "SELECT lease_id FROM hub_backup_restore_pins WHERE profile_id=$1 AND checkpoint_id=$2 AND reader_id=$3 AND legacy ORDER BY expires_at DESC LIMIT 1",
          [s.profileId, checkpointId, reader],
        )
      ).rows[0]
    : undefined;
  const leaseId = attemptId ?? old?.lease_id ?? randomUUID();
  const existing = (
    await c.query(
      "SELECT 1 FROM hub_backup_restore_pins WHERE profile_id=$1 AND checkpoint_id=$2 AND reader_id=$3 AND lease_id=$4 AND expires_at>clock_timestamp()",
      [s.profileId, checkpointId, reader, leaseId],
    )
  ).rowCount;
  if (!existing) {
    const count =
      (
        await c.query(
          "SELECT 1 FROM hub_backup_restore_pins WHERE profile_id=$1 AND expires_at>clock_timestamp() LIMIT 8",
          [s.profileId],
        )
      ).rowCount || 0;
    if (count >= 8)
      throw new AppError(
        "BACKUP_BUSY",
        "Other backup restores are still finishing. Retry shortly; local saves remain available.",
        503,
      );
  }
  const pin = (
    await c.query(
      "INSERT INTO hub_backup_restore_pins(profile_id,checkpoint_id,reader_id,lease_id,legacy,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '120 seconds') ON CONFLICT(profile_id,checkpoint_id,reader_id,lease_id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING expires_at,lease_id",
      [s.profileId, checkpointId, reader, leaseId, legacy],
    )
  ).rows[0];
  return {
    checkpointId,
    expiresAt: pin.expires_at.toISOString(),
    leaseId: pin.lease_id,
  };
}
type Selector = {
  leaseId?: string;
  checkpointId?: string;
  namespaceVersionId?: string;
  partHash?: string;
};
const filter = `pin.profile_id=$1 AND pin.reader_id=$2 AND pin.expires_at>clock_timestamp() AND(($6::uuid IS NOT NULL AND pin.lease_id=$6) OR($6::uuid IS NULL AND pin.legacy)) AND($3::uuid IS NOT NULL AND pin.checkpoint_id=$3 OR $4::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs r WHERE r.profile_id=pin.profile_id AND r.checkpoint_id=pin.checkpoint_id AND r.namespace_version_id=$4) OR $5::text IS NOT NULL AND EXISTS(SELECT 1 FROM hub_backup_checkpoint_parts r WHERE r.profile_id=pin.profile_id AND r.checkpoint_id=pin.checkpoint_id AND r.hash=$5))`;
/** Implicit resource progress renews LEGACY rows only. Explicit attempt pins
 * require their leaseId heartbeat and cannot be kept alive by another restore.
 * The common fresh-pin lookup takes no account write lock. A due extension
 * takes account->pin locks, rechecks real clock/status, then changes <=8 rows. */
export async function renewRestorePins(
  c: PoolClient,
  s: RestoreReaderSession,
  selector: Selector,
) {
  const reader = restoreReaderId(s),
    args = [
      s.profileId,
      reader,
      selector.checkpointId || null,
      selector.namespaceVersionId || null,
      selector.partHash || null,
      selector.leaseId || null,
    ];
  let rows = (
    await c.query(
      `SELECT pin.checkpoint_id,pin.lease_id,pin.expires_at<=clock_timestamp()+interval '90 seconds' due FROM hub_backup_restore_pins pin WHERE ${filter} ORDER BY pin.expires_at LIMIT 8`,
      args,
    )
  ).rows;
  if (!rows.length || (!selector.leaseId && !rows.some((r) => r.due)))
    return { active: rows.length, renewed: 0 };
  await lockProfile(c, s);
  rows = (
    await c.query(
      `SELECT pin.checkpoint_id,pin.lease_id FROM hub_backup_restore_pins pin JOIN hub_backup_checkpoints cp ON cp.profile_id=pin.profile_id AND cp.checkpoint_id=pin.checkpoint_id WHERE ${filter} AND cp.status='complete' ORDER BY pin.expires_at LIMIT 8 FOR UPDATE OF pin`,
      args,
    )
  ).rows;
  if (!rows.length) return { active: 0, renewed: 0 };
  const result = await c.query(
    `UPDATE hub_backup_restore_pins p SET expires_at=clock_timestamp()+interval '120 seconds' FROM jsonb_to_recordset($3::jsonb) x(checkpoint_id uuid,lease_id uuid) WHERE p.profile_id=$1 AND p.reader_id=$2 AND p.checkpoint_id=x.checkpoint_id AND p.lease_id=x.lease_id AND($4::boolean OR p.expires_at<=clock_timestamp()+interval '90 seconds')`,
    [s.profileId, reader, JSON.stringify(rows), !!selector.leaseId],
  );
  return { active: rows.length, renewed: result.rowCount || 0 };
}
export async function releaseRestorePin(
  c: PoolClient,
  s: RestoreReaderSession,
  checkpointId: string,
  leaseId: string,
) {
  const result = await c.query(
    "DELETE FROM hub_backup_restore_pins WHERE profile_id=$1 AND checkpoint_id=$2 AND reader_id=$3 AND lease_id=$4",
    [s.profileId, checkpointId, restoreReaderId(s), leaseId],
  );
  return { checkpointId, released: !!result.rowCount };
}
/** Include the full attempt PK: expired A must never delete live B owned by
 * the same session and checkpoint. No byte/reference quota credit is created. */
export async function collectExpiredRestorePins(
  c: PoolClient,
  profileId?: string,
) {
  const r = await c.query(
    `WITH expired AS(SELECT profile_id,checkpoint_id,reader_id,lease_id FROM hub_backup_restore_pins WHERE expires_at<=clock_timestamp() AND($1::uuid IS NULL OR profile_id=$1) ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED) DELETE FROM hub_backup_restore_pins p USING expired e WHERE p.profile_id=e.profile_id AND p.checkpoint_id=e.checkpoint_id AND p.reader_id=e.reader_id AND p.lease_id=e.lease_id`,
    [profileId || null],
  );
  return r.rowCount || 0;
}
