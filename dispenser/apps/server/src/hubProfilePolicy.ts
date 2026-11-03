/** Account cloud allowance, trusted native policy and conservative chunk lifecycle.
 * Call lifecycle functions while holding the hub_profiles row lock. A live ref
 * always wins over GC; unreferenced uploads retain a 24-hour retry grace period. */
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { HUB_LIMITS } from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import { decrypt } from "./security.js";
import type { HubRouteOptions } from "./hubSupport.js";
import { acquireHubClient } from "./hubDatabaseWork.js";
import { performance } from "node:perf_hooks";
import type { HubPerformance } from "./hubPerformance.js";
export const PROFILE_CHUNK_GRACE_MS = 24 * 60 * 60 * 1000;
const MiB = 1024 * 1024;
export type ProfilePolicy = {
  profileBytes: number;
  localBytes: number;
  idbBytes: number;
};
export const PROFILE_POLICY_DEFAULTS: Readonly<ProfilePolicy> = Object.freeze({
  profileBytes: 256 * MiB,
  localBytes: 5 * MiB,
  idbBytes: 64 * MiB,
});
const columns = {
  profileBytes: "profile_bytes",
  localBytes: "local_bytes",
  idbBytes: "idb_bytes",
} as const;
const bounds = {
  profileBytes: [MiB, 8192 * MiB],
  localBytes: [65536, 32 * MiB],
  idbBytes: [MiB, 1024 * MiB],
} as const;
export function validateProfilePolicy(
  value: unknown,
  nullable = false,
): Record<keyof ProfilePolicy, number | null> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !Object.hasOwn(columns, k))
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose profile, localStorage and IndexedDB limits.",
    );
  const result = {} as Record<keyof ProfilePolicy, number | null>;
  for (const key of Object.keys(columns) as Array<keyof ProfilePolicy>) {
    const v = (value as any)[key];
    if (nullable && v === null) {
      result[key] = null;
      continue;
    }
    const [min, max] = bounds[key];
    if (!Number.isSafeInteger(v) || v < min || v > max)
      throw new AppError(
        "VALIDATION_ERROR",
        key + " is outside its supported byte range.",
      );
    result[key] = v;
  }
  return result;
}
export async function resolveProfilePolicy(
  c: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  userId: string,
): Promise<ProfilePolicy> {
  const row = (
    await c.query(
      "SELECT COALESCE(o.profile_bytes,d.profile_bytes) profile_bytes,COALESCE(o.local_bytes,d.local_bytes) local_bytes,COALESCE(o.idb_bytes,d.idb_bytes) idb_bytes FROM hub_profile_policy_defaults d LEFT JOIN hub_profile_policy_overrides o ON o.user_id=$1 WHERE d.singleton",
      [userId],
    )
  ).rows[0];
  if (!row)
    throw new AppError("HUB_INVALID", "Profile policy is unavailable.", 503);
  return {
    profileBytes: Number(row.profile_bytes),
    localBytes: Number(row.local_bytes),
    idbBytes: Number(row.idb_bytes),
  };
}
export function profileWireLimits(policy: ProfilePolicy) {
  return {
    ...HUB_LIMITS,
    ...policy,
    stagingBytes: Math.max(
      HUB_LIMITS.streamBytes,
      Math.min(policy.profileBytes, 256 * MiB),
    ),
    chunkGraceMs: PROFILE_CHUNK_GRACE_MS,
  };
}
type Owner = "stream" | "commit" | "recovery";
function chunkHashes(value: any): string[] {
  if (!value || typeof value !== "object" || value.codec !== "atlas-chunks-v1")
    return [];
  if (
    !Array.isArray(value.hashes) ||
    !value.hashes.length ||
    value.hashes.length > 64 ||
    value.hashes.some(
      (h: any) =>
        typeof h !== "string" || !/^\w{64}$/.test(h) || !/^[a-f0-9]+$/.test(h),
    )
  )
    throw new AppError(
      "HUB_INVALID",
      "Stored chunk manifest is invalid. No chunks were collected.",
      503,
    );
  return [...new Set(value.hashes)] as string[];
}
export async function replaceChunkReferences(
  c: PoolClient,
  profileId: string,
  kind: Owner,
  ownerKey: string,
  payload: unknown,
) {
  const hashes = chunkHashes(payload);
  await c.query(
    "DELETE FROM hub_profile_chunk_refs WHERE profile_id=$1 AND owner_kind=$2 AND owner_key=$3",
    [profileId, kind, ownerKey],
  );
  for (const hash of hashes)
    await c.query(
      "INSERT INTO hub_profile_chunk_refs(profile_id,hash,owner_kind,owner_key) VALUES($1,$2,$3,$4)",
      [profileId, hash, kind, ownerKey],
    );
}
export async function clearCommitChunkReferences(
  c: PoolClient,
  profileId: string,
  namespace: string,
) {
  await c.query(
    "DELETE FROM hub_profile_chunk_refs r USING hub_commits x WHERE r.profile_id=$1 AND r.owner_kind='commit' AND r.owner_key=x.idempotency_key AND x.profile_id=r.profile_id AND x.namespace=$2",
    [profileId, namespace],
  );
}
export async function profileUsage(c: PoolClient, profileId: string) {
  // New accounting is transactionally maintained by SQL row deltas, including v1 writes.
  // to_jsonb keeps old fixture schemas/v1-only installations compatible until migration.
  const maintained = (await c.query("SELECT to_jsonb(p) accounting FROM hub_profiles p WHERE id=$1", [profileId])).rows[0]?.accounting;
  if (Number(maintained?.backup_accounting_version) === 1) return {
    canonicalBytes: Number(maintained.backup_v1_canonical_bytes) + Math.max(0, Number(maintained.backup_v2_bytes) - Number(maintained.backup_v2_migration_credit)),
    stagingBytes: Number(maintained.backup_v1_staging_bytes) + Number(maintained.backup_v2_staging_bytes) + Number(maintained.backup_conversion_staging_bytes || 0),
    stagingChunks: Number(maintained.backup_v1_staging_chunks) + Number(maintained.backup_v2_staging_parts || 0),
  };
  const row = (
    await c.query(
      `SELECT
 COALESCE((SELECT sum(bytes) FROM hub_streams WHERE profile_id=$1),0)+COALESCE((SELECT sum(bytes) FROM hub_profile_recoveries WHERE profile_id=$1),0)+COALESCE((SELECT sum(c.bytes) FROM hub_chunks c WHERE c.profile_id=$1 AND EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash)),0)+COALESCE((SELECT GREATEST(0,COALESCE((to_jsonb(p)->>'backup_v2_bytes')::bigint,0)-COALESCE((to_jsonb(p)->>'backup_v2_migration_credit')::bigint,0)) FROM hub_profiles p WHERE p.id=$1),0) canonical,
 COALESCE((SELECT sum(c.bytes) FROM hub_chunks c WHERE c.profile_id=$1 AND NOT EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash)),0)+COALESCE((SELECT (to_jsonb(p)->>'backup_v2_staging_bytes')::bigint FROM hub_profiles p WHERE p.id=$1),0) staged,
 (SELECT count(*) FROM hub_chunks c WHERE c.profile_id=$1 AND NOT EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash)) staged_count`,
      [profileId],
    )
  ).rows[0];
  return {
    canonicalBytes: Number(row.canonical),
    stagingBytes: Number(row.staged),
    stagingChunks: Number(row.staged_count),
  };
}
export async function initializeChunkAccounting(
  c: PoolClient,
  p: any,
  key: string,
) {
  if (Number(p.chunk_accounting_version) !== 1) {
    // A bad ciphertext or manifest aborts this transaction before any collection.
    const sources = (
      await c.query(
        `SELECT 'stream' kind,namespace owner_key,encrypted_payload FROM hub_streams WHERE profile_id=$1 AND encrypted_payload IS NOT NULL UNION ALL SELECT 'commit',idempotency_key,encrypted_payload FROM hub_commits WHERE profile_id=$1 AND encrypted_payload IS NOT NULL UNION ALL SELECT 'recovery',id::text,encrypted_payload FROM hub_profile_recoveries WHERE profile_id=$1`,
        [p.id],
      )
    ).rows;
    for (const source of sources)
      await replaceChunkReferences(
        c,
        p.id,
        source.kind,
        source.owner_key,
        JSON.parse(decrypt(source.encrypted_payload, key)),
      );
    await c.query(
      "UPDATE hub_profiles SET chunk_accounting_version=1 WHERE id=$1",
      [p.id],
    );
    p.chunk_accounting_version = 1;
  }
  const usage = await profileUsage(c, p.id);
  await c.query("UPDATE hub_profiles SET bytes=$2 WHERE id=$1", [
    p.id,
    usage.canonicalBytes,
  ]);
  if (Object.hasOwn(p, "backup_v1_staging_bytes") && Number(p.backup_accounting_version) !== 1) {
    const v1Staging = Math.max(0, usage.stagingBytes - Number(p.backup_v2_staging_bytes || 0));
    await c.query("UPDATE hub_profiles SET backup_v1_staging_bytes=$2 WHERE id=$1", [p.id, v1Staging]);
    p.backup_v1_staging_bytes = v1Staging;
  }
  p.bytes = usage.canonicalBytes;
  return usage;
}
export async function collectExpiredChunks(
  c: PoolClient,
  profileId: string,
  now = new Date(),
  maxChunks = 128,
  maxBytes = 16 * 1024 * 1024,
) {
  const result = await c.query(
    `WITH eligible AS MATERIALIZED (SELECT c.hash,c.bytes,c.created_at FROM hub_chunks c WHERE c.profile_id=$1 AND c.created_at<$2 AND COALESCE((to_jsonb(c)->>'backup_conversion_pins')::int,0)=0 AND NOT EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash) ORDER BY c.created_at,c.hash LIMIT $3 FOR UPDATE OF c SKIP LOCKED), obsolete AS (SELECT hash FROM (SELECT hash,sum(bytes) OVER(ORDER BY created_at,hash) AS total FROM eligible) bounded WHERE total<=$4) DELETE FROM hub_chunks c USING obsolete old WHERE c.profile_id=$1 AND c.hash=old.hash AND NOT EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash) RETURNING c.bytes`,
    [profileId, new Date(now.getTime() - PROFILE_CHUNK_GRACE_MS), Math.max(1, Math.min(256, maxChunks)), Math.max(HUB_LIMITS.chunkBytes, Math.min(32 * MiB, maxBytes))],
  );
  return {
    chunks: result.rowCount ?? 0,
    bytes: result.rows.reduce((n, r) => n + Number(r.bytes), 0),
  };
}
/** Fair, bounded periodic sweep. Each transaction keeps the profile row lock;
 * the absolute deadline destroys only this sweep's client and rolls back work.
 * Backfill authenticates old ciphertext/recovery manifests before collection. */
const sweepCursor = new WeakMap<Pool, string>();
export async function collectExpiredProfileUploads(
  pool: Pool,
  masterKey: string,
  maxProfiles = 50,
  options: { budgetMs?: number } = {},
) {
  const result = { profiles: 0, chunks: 0, bytes: 0, failed: 0 };
  const control = new AbortController();
  let c: PoolClient | undefined, released = false;
  const release = (destroy = false) => { if (c && !released) { released = true; c.release(destroy); } };
  const budgetMs = Math.max(25, Math.min(5000, options.budgetMs ?? 5000));
  const timer = setTimeout(() => { control.abort(); release(true); }, budgetMs);
  const begin = async () => {
    await c!.query("BEGIN");
    await c!.query("SET LOCAL statement_timeout='1500ms'");
    await c!.query("SET LOCAL lock_timeout='500ms'");
  };
  const rollback = async () => { if (c && !released) { try { await c!.query("ROLLBACK"); } catch { release(true); } } };
  try {
    c = await acquireHubClient(pool, control.signal, 1000);
    if (control.signal.aborted) { release(true); return result; }
    await begin();
    const select = (cursor?: string) => c!.query(
      "SELECT c.profile_id FROM hub_chunks c WHERE c.created_at<$1 AND ($2::uuid IS NULL OR c.profile_id>$2::uuid) AND NOT EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash) GROUP BY c.profile_id ORDER BY c.profile_id LIMIT $3",
      [new Date(Date.now() - PROFILE_CHUNK_GRACE_MS), cursor || null, Math.max(1, Math.min(100, maxProfiles))],
    );
    let candidates = (await select(sweepCursor.get(pool))).rows;
    if (!candidates.length && sweepCursor.has(pool)) candidates = (await select()).rows;
    await c.query("COMMIT");
    for (const candidate of candidates) {
      if (control.signal.aborted || 64 * MiB - result.bytes < HUB_LIMITS.chunkBytes) break;
      sweepCursor.set(pool, candidate.profile_id);
      try {
        await begin();
        const p = (await c.query("SELECT * FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED", [candidate.profile_id])).rows[0];
        let collected = { chunks: 0, bytes: 0 };
        if (p) {
          await initializeChunkAccounting(c, p, decrypt(p.encrypted_key, masterKey));
          collected = await collectExpiredChunks(c, p.id, new Date(), 128, Math.min(16 * MiB, 64 * MiB - result.bytes));
          if (Object.hasOwn(p, "backup_v1_staging_bytes") && Number(p.backup_accounting_version) !== 1 && collected.bytes) await c.query("UPDATE hub_profiles SET backup_v1_staging_bytes=GREATEST(0,backup_v1_staging_bytes-$2) WHERE id=$1", [p.id, collected.bytes]);
        }
        await c.query("COMMIT");
        if (p) { result.profiles++; result.chunks += collected.chunks; result.bytes += collected.bytes; }
      } catch {
        await rollback(); result.failed++;
        if (released || control.signal.aborted) break;
      }
    }
  } catch { await rollback(); result.failed++; }
  finally { clearTimeout(timer); release(control.signal.aborted); }
  return result;
}
export async function finishProfileAccounting(
  c: PoolClient,
  p: any,
  policy: ProfilePolicy,
  beforeBytes: number,
  beforeStagingBytes = 0,
  beforeStagingChunks = 0,
) {
  const usage = await profileUsage(c, p.id);
  if (
    usage.canonicalBytes > policy.profileBytes &&
    usage.canonicalBytes > beforeBytes
  )
    throw new AppError(
      "HUB_QUOTA",
      "Account backup quota exceeded. Your local saves are retained.",
      413,
    );
  if (
    (usage.stagingBytes > profileWireLimits(policy).stagingBytes &&
      usage.stagingBytes > beforeStagingBytes) ||
    (usage.stagingChunks > 4096 && usage.stagingChunks > beforeStagingChunks)
  )
    throw new AppError(
      "HUB_QUOTA",
      "Pending chunk upload allowance exceeded. Retry after staged uploads expire; local saves remain intact.",
      413,
    );
  await c.query("UPDATE hub_profiles SET bytes=$2 WHERE id=$1", [
    p.id,
    usage.canonicalBytes,
  ]);
  if (Object.hasOwn(p, "backup_v1_staging_bytes") && Number(p.backup_accounting_version) !== 1) {
    const v1Staging = Math.max(0, usage.stagingBytes - Number(p.backup_v2_staging_bytes || 0));
    await c.query("UPDATE hub_profiles SET backup_v1_staging_bytes=$2 WHERE id=$1", [p.id, v1Staging]);
    p.backup_v1_staging_bytes = v1Staging;
  }
  p.bytes = usage.canonicalBytes;
  return usage;
}
export async function registerHubProfilePolicyRoutes(
  app: FastifyInstance,
  o: HubRouteOptions & { encryptionKey: string; performance?: HubPerformance; maintenancePool?: Pool; maintenanceDisabled?: boolean },
) {
  let sweeping: Promise<unknown> | undefined;
  const timer = o.maintenanceDisabled ? undefined : setInterval(() => {
    if (sweeping) return;
    const started = performance.now();
    sweeping = collectExpiredProfileUploads(o.maintenancePool ?? o.pool, o.encryptionKey)
      .then((r) => {
        o.performance?.observe("profile.gc", performance.now() - started, r.failed ? "error" : "ok");
        if (r.failed)
          app.log.error(
            { profiles: r.failed },
            "Profile chunk collection held for invalid stored state",
          );
      })
      .catch(() => app.log.error("Profile chunk collection unavailable"))
      .finally(() => {
        sweeping = undefined;
      });
  }, 60_000);
  timer?.unref();
  app.addHook("onClose", async () => {
    if(timer)clearInterval(timer);
    await sweeping;
  });
  const policyRow = (r: any) => ({
    profileBytes: Number(r.profile_bytes),
    localBytes: Number(r.local_bytes),
    idbBytes: Number(r.idb_bytes),
  });
  app.get("/api/admin/hub/profile-policy", async (req) => {
    await o.requireAdmin(req);
    return {
      defaults: policyRow(
        (
          await o.pool.query(
            "SELECT * FROM hub_profile_policy_defaults WHERE singleton",
          )
        ).rows[0],
      ),
      ranges: bounds,
      chunkGraceMs: PROFILE_CHUNK_GRACE_MS,
    };
  });
  app.put("/api/admin/hub/profile-policy", async (req) => {
    const u = await o.requireAdmin(req);
    o.csrf(req, u);
    const p = validateProfilePolicy(req.body);
    const c = await o.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "UPDATE hub_profile_policy_defaults SET profile_bytes=$1,local_bytes=$2,idb_bytes=$3,updated_by=$4,updated_at=now() WHERE singleton",
        [p.profileBytes, p.localBytes, p.idbBytes, u.id],
      );
      await audit(c, u.id, "hub.profile_policy.defaults", null, p);
      await c.query("COMMIT");
      return { defaults: p };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  });
  app.get("/api/admin/hub/profile-policy/account", async (req) => {
    await o.requireAdmin(req);
    const email = (req.query as any)?.email;
    if (typeof email !== "string" || email.length > 254)
      throw new AppError("VALIDATION_ERROR", "Enter an account email.");
    const user = (
      await o.pool.query(
        "SELECT id,email FROM users WHERE normalized_email=$1",
        [email.trim().toLowerCase()],
      )
    ).rows[0];
    if (!user)
      throw new AppError("VALIDATION_ERROR", "Account not found.", 404);
    const override = (
      await o.pool.query(
        "SELECT profile_bytes,local_bytes,idb_bytes FROM hub_profile_policy_overrides WHERE user_id=$1",
        [user.id],
      )
    ).rows[0];
    const c = await o.pool.connect();
    let usage = { canonicalBytes: 0, stagingBytes: 0, stagingChunks: 0 };
    try {
      await c.query("BEGIN");
      const profile = (
        await c.query(
          "SELECT * FROM hub_profiles WHERE user_id=$1 FOR UPDATE",
          [user.id],
        )
      ).rows[0];
      if (profile) {
        await initializeChunkAccounting(
          c,
          profile,
          decrypt(profile.encrypted_key, o.encryptionKey),
        );
        await collectExpiredChunks(c, profile.id);
        usage = await profileUsage(c, profile.id);
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    return {
      user,
      policy: await resolveProfilePolicy(o.pool, user.id),
      override: override
        ? Object.fromEntries(
            Object.entries(columns).map(([k, col]) => [
              k,
              override[col] === null ? null : Number(override[col]),
            ]),
          )
        : null,
      bytes: usage.canonicalBytes,
      stagingBytes: usage.stagingBytes,
    };
  });
  app.put<{ Params: { id: string } }>(
    "/api/admin/hub/profile-policy/accounts/:id",
    async (req) => {
      const u = await o.requireAdmin(req);
      o.csrf(req, u);
      const id = req.params.id;
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          id,
        )
      )
        throw new AppError("VALIDATION_ERROR", "Invalid account.");
      const p = validateProfilePolicy(req.body, true);
      const c = await o.pool.connect();
      try {
        await c.query("BEGIN");
        if (!(await c.query("SELECT 1 FROM users WHERE id=$1", [id])).rowCount)
          throw new AppError("VALIDATION_ERROR", "Account not found.", 404);
        await c.query(
          "INSERT INTO hub_profile_policy_overrides(user_id,profile_bytes,local_bytes,idb_bytes,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET profile_bytes=excluded.profile_bytes,local_bytes=excluded.local_bytes,idb_bytes=excluded.idb_bytes,updated_by=excluded.updated_by,updated_at=now()",
          [id, p.profileBytes, p.localBytes, p.idbBytes, u.id],
        );
        await audit(c, u.id, "hub.profile_policy.account", id, p);
        await c.query("COMMIT");
        return { ok: true, policy: await resolveProfilePolicy(o.pool, id) };
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/hub/profile-policy/accounts/:id/collect",
    async (req) => {
      const u = await o.requireAdmin(req);
      o.csrf(req, u);
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          req.params.id,
        )
      )
        throw new AppError("VALIDATION_ERROR", "Invalid account.");
      const c = await o.pool.connect();
      try {
        await c.query("BEGIN");
        const p = (
          await c.query(
            "SELECT * FROM hub_profiles WHERE user_id=$1 FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (!p)
          throw new AppError(
            "VALIDATION_ERROR",
            "Profile not initialized.",
            404,
          );
        await initializeChunkAccounting(
          c,
          p,
          decrypt(p.encrypted_key, o.encryptionKey),
        );
        const collected = await collectExpiredChunks(c, p.id);
        await audit(
          c,
          u.id,
          "hub.profile_chunks.collect",
          req.params.id,
          collected,
        );
        await c.query("COMMIT");
        return { ...collected, ...(await profileUsage(c, p.id)) };
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  );
}
async function audit(
  c: PoolClient,
  actor: string,
  action: string,
  target: string | null,
  data: unknown,
) {
  await c.query(
    "INSERT INTO audit_events(admin_id,action,target_type,target_id,after) VALUES($1,$2,'profile_policy',$3,$4)",
    [actor, action, target, JSON.stringify(data)],
  );
}
