/** Periodic immutable cloud backups. These routes never grant native-write authority. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  BACKUP_V2,
  backupManifestIdentity,
  canonicalBackupJson,
  hubNamespace,
  type BackupCheckpointV2,
  type BackupNamespaceVersionV2,
  type BackupPublishReceiptV2,
} from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import {backupCatalogReady,requireBackupCatalogReady} from "./hubBackupsV2Readiness.js";
import {stageReplacementProof,applyAtomicReplacementCredit} from "./hubBackupsV2Replacement.js";
import {acquireRestorePin,renewRestorePins,releaseRestorePin,collectExpiredRestorePins,restoreReaderId} from "./hubBackupsV2RestorePins.js";
import { cancelBackupStatement } from "./hubBackupsV2Cancellation.js";
import {
  prepareBackupCatalog,
  catalogSummary,
  catalogCursor,
  readCatalogCursor,
} from "./hubBackupsV2Catalog.js";
import {
  registerBackupAdmission,
  unregisterBackupAdmission,
  recordBackupDbTiming,
  type BackupOperation,
} from "./hubBackupsV2Admission.js";
import { runBackupAccountingSlice } from "./hubBackupsV2Accounting.js";
import { decrypt } from "./security.js";
import { acquireHubClient } from "./hubDatabaseWork.js";
import { resolveProfilePolicy, profileWireLimits } from "./hubProfilePolicy.js";
import type { HubIdentity, HubSession } from "./hubIdentity.js";
import {
  validateBackupParts,
  type IndexedBackupRecord,
} from "./hubBackupsV2Validation.js";
export const BACKUP_V2_DATABASE_LIMITS = Object.freeze({
  acquireMs: 1000,
  statementMs: 2000,
  lockMs: 250,
  transactionMs: 4000,
});
const PREFIX = "/api/hub/branch/profile/backups/v2";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const invalid = (message = "Invalid periodic backup request.") =>
  new AppError("BACKUP_INVALID", message);
const conflict = (
  message = "This backup publisher changed. Local website storage remains available.",
) => new AppError("BACKUP_CONFLICT", message, 409);
const missing = () =>
  new AppError("BACKUP_NOT_FOUND", "The requested backup is unavailable.", 404);
const busy = () =>
  new AppError(
    "BACKUP_BUSY",
    "Backup work is deferred. Local saves remain available.",
    503,
  );
const uuid = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    throw invalid("A backup UUID is required.");
  return v.toLowerCase();
};
const hash = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw invalid("A SHA-256 identity is required.");
  return v;
};
const integer = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw invalid("A nonnegative safe integer is required.");
  return Number(v);
};
const object = (v: unknown): any => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v;
};
function namespaceKey(value: unknown) {
  try {
    return hubNamespace(object(value)).key;
  } catch {
    throw invalid("Invalid logical namespace.");
  }
}
function encryptionKey(secret: string) {
  const decoded = Buffer.from(secret, "base64");
  return decoded.length === 32
    ? decoded
    : createHmac("sha256", "atlas-link-dispenser").update(secret).digest();
}
export function encryptBackupPartV2(bytes: Buffer, secret: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function decryptPart(bytes: Buffer, secret: string) {
  const c = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    bytes.subarray(0, 12),
  );
  c.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([c.update(bytes.subarray(28)), c.final()]);
}
function onlyKeys(value: any, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalid("Unknown backup manifest field.");
}
function manifest(value: unknown): BackupCheckpointV2 {
  const m = object(value);
  onlyKeys(m, [
    "format",
    "checkpointId",
    "replicaId",
    "incarnation",
    "sequence",
    "parentCheckpointId",
    "manifestDigest",
    "adoptedThrough",
    "namespaces",
  ]);
  uuid(m.checkpointId);
  uuid(m.replicaId);
  uuid(m.incarnation);
  if (m.parentCheckpointId !== null) uuid(m.parentCheckpointId);
  if (
    m.format !== "atlas-checkpoint-v2" ||
    integer(m.sequence) < 1 ||
    !Array.isArray(m.namespaces) ||
    m.namespaces.length > BACKUP_V2.maxNamespaces
  )
    throw invalid();
  integer(m.adoptedThrough);
  hash(m.manifestDigest);
  const seen = new Set<string>(),
    ids = new Set<string>();
  let bytes = 0,
    parts = 0;
  for (const n of m.namespaces) {
    object(n);
    onlyKeys(n, [
      "namespace",
      "namespaceVersionId",
      "parentNamespaceVersionId",
      "localCut",
      "schemaEpoch",
      "kind",
      "rootDigest",
      "parts",
      "coverage",
    ]);
    onlyKeys(object(n.namespace), ["kind", "origin", "name"]);
    const key = namespaceKey(n.namespace);
    uuid(n.namespaceVersionId);
    if (n.parentNamespaceVersionId !== null) uuid(n.parentNamespaceVersionId);
    if (
      seen.has(key) ||
      ids.has(n.namespaceVersionId) ||
      !["baseline", "delta", "deleted"].includes(n.kind) ||
      n.coverage !== "complete-at-cut" ||
      !Array.isArray(n.parts)
    )
      throw invalid("Duplicate or malformed namespace version.");
    seen.add(key);
    ids.add(n.namespaceVersionId);
    integer(n.localCut);
    if (
      (typeof n.schemaEpoch !== "string" || n.schemaEpoch.length > 128) &&
      (typeof n.schemaEpoch !== "number" ||
        !Number.isSafeInteger(n.schemaEpoch) ||
        n.schemaEpoch < 0)
    )
      throw invalid("Invalid schema epoch.");
    hash(n.rootDigest);
    const partIds = new Set<string>();
    n.parts.forEach((p: any, i: number) => {
      object(p);
      onlyKeys(p, ["ordinal", "sha256", "bytes"]);
      if (
        integer(p.ordinal) !== i ||
        integer(p.bytes) < 1 ||
        p.bytes > BACKUP_V2.partBytes ||
        partIds.has(hash(p.sha256))
      )
        throw invalid("Invalid bounded part.");
      partIds.add(p.sha256);
      bytes += p.bytes;
      parts++;
    });
    if (n.rootDigest !== digest(canonicalBackupJson(n.parts)))
      throw invalid("Namespace part-root digest does not match.");
    if (
      (n.kind === "deleted" && n.parts.length) ||
      (n.kind !== "delta" && n.parentNamespaceVersionId !== null)
    )
      throw invalid("Invalid namespace ancestry.");
  }
  if (
    parts > BACKUP_V2.maxParts ||
    bytes > BACKUP_V2.cycleBytes ||
    Buffer.byteLength(canonicalBackupJson(m)) > BACKUP_V2.manifestBytes ||
    digest(backupManifestIdentity(m)) !== m.manifestDigest
  )
    throw invalid("Backup identity or bounded manifest does not match.");
  return m as BackupCheckpointV2;
}
/** Cancellation releases only this work's connection. An uncertain COMMIT is retried by immutable identity. */
export async function withBackupTransaction<T>(
  pool: Pool,
  signal: AbortSignal,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const control = new AbortController();
  const stop = () => control.abort(busy());
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let client: PoolClient | undefined,
    released = false;
  const release = (destroy = false) => {
    if (client && !released) {
      released = true;
      client.release(destroy);
    }
  };
  let cancellation: Promise<boolean> | undefined,
    cancellationDeadline: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (client && !released && !cancellation) {
      cancellation = cancelBackupStatement(client).catch(() => false);
      cancellationDeadline = setTimeout(() => release(true), 2100);
    }
  };
  const timer = setTimeout(stop, BACKUP_V2_DATABASE_LIMITS.transactionMs);
  control.signal.addEventListener("abort", cancel, { once: true });
  try {
    const acquisitionStarted = performance.now();
    try {
      client = await acquireHubClient(
        pool,
        control.signal,
        BACKUP_V2_DATABASE_LIMITS.acquireMs,
      );
    } finally {
      recordBackupDbTiming("acquire", performance.now() - acquisitionStarted);
    }
    if (control.signal.aborted) throw busy();
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='250ms'; SET LOCAL idle_in_transaction_session_timeout='4000ms'",
    );
    const guarded = new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return (...args: any[]) =>
            control.signal.aborted
              ? Promise.reject(busy())
              : (target.query as any)(...args);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let rejectAbort: ((error: unknown) => void) | undefined;
    const interrupted = () => rejectAbort?.(busy());
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      control.signal.addEventListener("abort", interrupted, { once: true });
      if (control.signal.aborted) interrupted();
    });
    let result: T;
    try {
      result = await Promise.race([work(guarded), aborted]);
    } finally {
      control.signal.removeEventListener("abort", interrupted);
    }

    if (control.signal.aborted) throw busy();
    await client.query("COMMIT");
    if (control.signal.aborted) throw busy();
    return result;
  } catch (error) {
    if (!released && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        release(true);
      }
    }
    if (
      control.signal.aborted ||
      ["57014", "55P03", "57P01", "25P03"].includes((error as any)?.code)
    )
      throw busy();
    if (["23505", "23503"].includes((error as any)?.code)) throw conflict();
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(cancellationDeadline);
    signal.removeEventListener("abort", stop);
    control.signal.removeEventListener("abort", cancel);
    release(control.signal.aborted);
  }
}
export const resolvedCTE = `WITH RECURSIVE chain AS (
 SELECT namespace_version_id,parent_version_id,materialized_ready,0 d FROM hub_backup_namespace_versions WHERE profile_id=$1 AND namespace_version_id=$2
 UNION ALL SELECT n.namespace_version_id,n.parent_version_id,n.materialized_ready,c.d+1 FROM hub_backup_namespace_versions n JOIN chain c ON n.namespace_version_id=c.parent_version_id AND n.profile_id=$1 WHERE c.d<16 AND NOT c.materialized_ready
), entries AS (
 SELECT r.*,c.d FROM chain c JOIN hub_backup_record_index r ON r.namespace_version_id=c.namespace_version_id AND r.profile_id=$1 WHERE NOT c.materialized_ready
 UNION ALL SELECT r.*,c.d FROM chain c JOIN hub_backup_materialized_records r ON r.namespace_version_id=c.namespace_version_id AND r.profile_id=$1 WHERE c.materialized_ready
), latest AS (SELECT DISTINCT ON(record_id) * FROM entries ORDER BY record_id,d), epochs AS (SELECT store_name,max(store_epoch) epoch FROM latest GROUP BY store_name), resolved AS (SELECT l.* FROM latest l JOIN epochs e USING(store_name) WHERE l.operation='schema' OR (l.store_epoch=e.epoch AND l.operation='put'))`;
function wireRecord(r: any) {
  return {
    recordId: r.record_id,
    store: r.store_name,
    storeEpoch: Number(r.store_epoch),
    operation: r.operation,
    sha256: r.sha256,
    totalBytes: Number(r.total_bytes),
    fragments: r.fragments,
  };
}
async function profile(
  c: PoolClient,
  session: HubSession,
  master: string,
  lock = false,
) {
  const p = (
    await c.query(
      "SELECT * FROM hub_profiles WHERE id=$1 AND user_id=$2" +
        (lock ? " FOR NO KEY UPDATE" : ""),
      [session.profileId, session.userId],
    )
  ).rows[0];
  if (!p)
    throw new AppError(
      "HUB_SESSION_EXPIRED",
      "This cloud profile is no longer available.",
      401,
    );
  return { ...p, key: decrypt(p.encrypted_key, master) };
}
function requireBackupAccounting(p: any) {
  if (Number(p.backup_accounting_version) !== 1)
    throw new AppError(
      "BACKUP_BUSY",
      "Cloud backup accounting is being upgraded in bounded background work. Local website storage remains available.",
      503,
    );
}
async function replica(
  c: PoolClient,
  session: HubSession,
  id: string,
  lock = false,
  allowDeleted = false,
) {
  const r = (
    await c.query(
      "SELECT r.* FROM hub_backup_replicas r JOIN hub_branches b ON b.id=$3 WHERE r.profile_id=$1 AND r.replica_id=$2 AND r.origin=b.origin" +
        (lock ? " FOR UPDATE OF r" : ""),
      [session.profileId, id, session.branchId],
    )
  ).rows[0];
  if (!r) throw missing();
  if (r.deleted_at && !allowDeleted)
    throw new AppError(
      "BACKUP_REPLICA_DELETED",
      "This backup publisher was removed. Local data is preserved.",
      409,
    );
  return r;
}
async function checkpoint(
  c: PoolClient,
  session: HubSession,
  id: string,
  lock = false,
) {
  const p = (
    await c.query(
      "SELECT * FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [session.profileId, id],
    )
  ).rows[0];
  if (!p) throw missing();
  return p;
}
async function checkpointAccessible(c:PoolClient,profileId:string,id:string,readerId:string|null=null){return !!(await c.query("SELECT 1 FROM hub_backup_checkpoints cp JOIN hub_backup_replicas owner USING(profile_id,replica_id) WHERE cp.profile_id=$1 AND cp.checkpoint_id=$2 AND (owner.deleted_at IS NULL OR EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=cp.profile_id AND seed.seed_checkpoint_id=cp.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=cp.profile_id AND pin.checkpoint_id=cp.checkpoint_id AND pin.reader_id=$3 AND pin.expires_at>now()))",[profileId,id,readerId])).rowCount;}
async function cancelledStage(c:PoolClient,s:HubSession,id:string){const receipt=(await c.query('SELECT * FROM hub_backup_cancellations WHERE profile_id=$1 AND checkpoint_id=$2',[s.profileId,id])).rows[0];if(!receipt)return undefined;await replica(c,s,receipt.replica_id,false,true);return {checkpointId:id,manifestDigest:receipt.manifest_digest,status:"expired",cancelled:true,missingParts:[]};}
function cancellationAdoptionResult(r:any){return {replicaId:r.replica_id,checkpointId:r.last_cancel_checkpoint_id,manifestDigest:r.last_cancel_manifest_digest,adopted:true,headSequence:Number(r.last_cancel_sequence),headCheckpointId:r.last_cancel_parent_checkpoint_id,adoptedThrough:Number(r.last_cancel_sequence)};}
async function receiptState(c: PoolClient, session: HubSession, p: any) {
  if (p.status === "complete" || p.status === "retired")
    return {
      checkpointId: p.checkpoint_id,
      status: p.status,
      receipt: p.receipt,
      missingParts: [],
    };
  const parts = (
    await c.query(
      "SELECT r.hash FROM hub_backup_checkpoint_parts r LEFT JOIN hub_backup_parts b ON b.profile_id=r.profile_id AND b.hash=r.hash WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND b.hash IS NULL ORDER BY r.hash",
      [session.profileId, p.checkpoint_id],
    )
  ).rows;
  return {
    checkpointId: p.checkpoint_id,
    status: p.status,
    missingParts: parts.map((p) => p.hash),
    expiresAt: p.expires_at.toISOString(),
  };
}
async function retire(c: PoolClient, profileId: string, checkpointId: string) {
  if((await c.query('SELECT 1 FROM hub_backup_restore_pins WHERE profile_id=$1 AND checkpoint_id=$2 AND expires_at>now() LIMIT 1',[profileId,checkpointId])).rowCount)return 0;
  if (
    (
      await c.query(
        "SELECT 1 FROM hub_backup_replicas WHERE profile_id=$1 AND seed_checkpoint_id=$2 AND head_checkpoint_id IS NULL AND deleted_at IS NULL LIMIT 1",
        [profileId, checkpointId],
      )
    ).rowCount
  )
    return 0;
  if (
    (
      await c.query(
        "SELECT 1 FROM hub_backup_catalog_pins pin JOIN hub_backup_checkpoints owner ON owner.profile_id=pin.profile_id AND owner.checkpoint_id=pin.owner_checkpoint_id WHERE pin.profile_id=$1 AND pin.parent_checkpoint_id=$2 AND owner.status='prepared' AND owner.expires_at>now() LIMIT 1",
        [profileId, checkpointId],
      )
    ).rowCount
  )
    return 0;
  const current = (
    await c.query(
      "SELECT catalog_version FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2",
      [profileId, checkpointId],
    )
  ).rows[0];
  if (Number(current?.catalog_version) === 1) {
    await c.query(
      "UPDATE hub_backup_checkpoints SET status='retired' WHERE profile_id=$1 AND checkpoint_id=$2 AND status='complete'",
      [profileId, checkpointId],
    );
    await revokeObsoleteBackupCredits(c, profileId);
    await queueBackupPrune(c, profileId);
    return 0;
  }
  const before = Number(
    (await c.query("SELECT bytes FROM hub_profiles WHERE id=$1", [profileId]))
      .rows[0].bytes,
  );
  const rows = (
    await c.query(
      "UPDATE hub_backup_parts p SET published_refs=published_refs-1,ever_published=true,gc_eligible_at=CASE WHEN published_refs=1 THEN now() ELSE gc_eligible_at END FROM hub_backup_checkpoint_parts r WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND p.profile_id=r.profile_id AND p.hash=r.hash AND p.published_refs>0 RETURNING p.bytes,p.published_refs",
      [profileId, checkpointId],
    )
  ).rows;
  const unreferenced = rows.filter((r) => Number(r.published_refs) === 0),
    released = unreferenced.reduce((n, r) => n + Number(r.bytes), 0);
  await c.query(
    "UPDATE hub_backup_checkpoints SET status='retired' WHERE profile_id=$1 AND checkpoint_id=$2 AND status='complete'",
    [profileId, checkpointId],
  );
  const revoked = Number(
    (
      await c.query(
        `WITH obsolete AS MATERIALIZED (
 SELECT a.v1_namespace,a.v1_revision,a.credit_bytes FROM hub_backup_migration_aliases a JOIN hub_backup_namespace_versions v USING(profile_id,namespace_version_id) JOIN hub_backup_checkpoints owner ON owner.profile_id=v.profile_id AND owner.checkpoint_id=v.checkpoint_id
 WHERE a.profile_id=$1 AND a.credit_bytes>0 AND owner.status IN ('complete','retired') AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_checkpoints p USING(profile_id,checkpoint_id) WHERE x.profile_id=a.profile_id AND x.namespace_version_id=a.namespace_version_id AND p.status='complete') FOR UPDATE OF a
 ), cleared AS (UPDATE hub_backup_migration_aliases a SET credit_bytes=0 FROM obsolete o WHERE a.profile_id=$1 AND a.v1_namespace=o.v1_namespace AND a.v1_revision=o.v1_revision RETURNING a.v1_revision)
 SELECT COALESCE(sum(credit_bytes),0) bytes FROM obsolete`,
        [profileId],
      )
    ).rows[0].bytes,
  );
  if (released || revoked)
    await c.query(
      "UPDATE hub_profiles SET backup_v2_bytes=backup_v2_bytes-$2,backup_v2_staging_bytes=backup_v2_staging_bytes+$2,backup_v2_staging_parts=backup_v2_staging_parts+$3,backup_v2_migration_credit=backup_v2_migration_credit-$4,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes-$2-backup_v2_migration_credit+$4) WHERE id=$1",
      [profileId, released, unreferenced.length, revoked],
    );
  const after = Number(
    (await c.query("SELECT bytes FROM hub_profiles WHERE id=$1", [profileId]))
      .rows[0].bytes,
  );
  return before - after;
}
async function pruneHistory(
  c: PoolClient,
  profileId: string,
  pressureBytes = 0,
  replacingReplica: string | null = null,
  replacementCheckpoint: string | null = null,
) {
  const rows = (
    await c.query(
      `WITH ranked AS (
 SELECT x.checkpoint_id,x.replica_id,x.publication_ordinal,x.sequence,r.adopted_through,r.head_checkpoint_id,r.deleted_at,
 row_number() OVER(PARTITION BY x.replica_id,x.history_day ORDER BY x.publication_ordinal DESC) day_rank,
 dense_rank() OVER(PARTITION BY x.replica_id ORDER BY x.history_day DESC) day_number
 FROM hub_backup_checkpoints x JOIN hub_backup_replicas r USING(profile_id,replica_id)
 WHERE x.profile_id=$1 AND x.status='complete') SELECT * FROM ranked
 WHERE checkpoint_id IS DISTINCT FROM head_checkpoint_id OR deleted_at IS NOT NULL OR replica_id=$2::uuid ORDER BY publication_ordinal DESC LIMIT 512`,
      [profileId, replacingReplica],
    )
  ).rows;
  const eligible: any[] = [];
  let shortened = false,
    freed = 0;
  // The current day consumes no historical-day slot. Each replica's head stays protected.
  for (const row of rows) {
    if (row.deleted_at) {
      freed += await retire(c, profileId, row.checkpoint_id);
      shortened = true;
      continue;
    }
    if (Number(row.sequence) > Number(row.adopted_through)) continue;
    if (
      Number(row.day_rank) > 1 ||
      Number(row.day_number) > BACKUP_V2.dailyPoints + 1
    ) {
      freed += await retire(c, profileId, row.checkpoint_id);
      shortened = true;
    } else eligible.push(row);
  }
  for (const row of eligible.reverse()) {
    if (freed >= pressureBytes) break;
    const shared = replacementCheckpoint
      ? Number(
          (
            await c.query(
              "SELECT COALESCE(sum(p.bytes),0) bytes FROM hub_backup_checkpoint_parts old JOIN hub_backup_parts p USING(profile_id,hash) WHERE old.profile_id=$1 AND old.checkpoint_id=$2 AND p.published_refs=1 AND EXISTS(SELECT 1 FROM hub_backup_checkpoint_parts fresh WHERE fresh.profile_id=$1 AND fresh.checkpoint_id=$3 AND fresh.hash=old.hash)",
              [profileId, row.checkpoint_id, replacementCheckpoint],
            )
          ).rows[0].bytes,
        )
      : 0;
    freed += (await retire(c, profileId, row.checkpoint_id)) - shared;
    shortened = true;
  }
  return shortened;
}
/** Bounded metadata only. A missing v2 namespace must not hide an older cloud save. */
async function legacyNamespaceHints(c: PoolClient, profileId: string) {
  const rows = (
    await c.query(
      "SELECT namespace,revision,snapshot_revision FROM hub_streams WHERE profile_id=$1 ORDER BY namespace LIMIT 513",
      [profileId],
    )
  ).rows;
  const result: any[] = [];
  let bytes = 0,
    truncated = rows.length > 512;
  for (const row of rows.slice(0, 512)) {
    let tuple: any;
    try {
      tuple = JSON.parse(row.namespace);
    } catch {
      truncated = true;
      continue;
    }
    if (
      !Array.isArray(tuple) ||
      !["local", "cookies", "idb", "atlas"].includes(tuple[0])
    ) {
      truncated = true;
      continue;
    }
    const namespace =
      tuple[0] === "atlas"
        ? { kind: "atlas" }
        : {
            kind: tuple[0],
            origin: tuple[0] === "cookies" ? "https://" + tuple[1] : tuple[1],
            ...(tuple[0] === "idb" ? { name: tuple[2] } : {}),
          };
    try {
      hubNamespace(namespace as any);
    } catch {
      truncated = true;
      continue;
    }
    const item = {
      namespace,
      key: row.namespace,
      revision: Number(row.revision),
      snapshotRevision: Number(row.snapshot_revision),
    };
    const length = Buffer.byteLength(JSON.stringify(item));
    if (bytes + length > 128 * 1024) {
      truncated = true;
      break;
    }
    bytes += length;
    result.push(item);
  }
  return {
    legacyNamespaces: result.map((item) => item.namespace),
    legacyNamespacesTruncated: truncated,
  };
}
export function registerHubBackupsV2Routes(
  app: FastifyInstance,
  o: {
    pool: Pool;
    identity: HubIdentity;
    encryptionKey: string;
    maintenance?: boolean;
    maintenancePool?: Pool;
    publicationDisabled?: boolean;
  },
) {
  const { pool, identity } = o;
  const admission = registerBackupAdmission();
  app.addHook("onClose", async () => unregisterBackupAdmission(admission));
  // A nested encapsulation prevents this bounded binary parser affecting v1 JSON routes.
  app.register(async (scoped) => {
    scoped.setErrorHandler((error: any, _request, reply) => {
      if (error.statusCode === 413)
        return reply.code(413).send({
          error: {
            code: "BACKUP_INVALID",
            message:
              "The bounded backup request is too large. Local data is retained.",
          },
        });
      throw error;
    });
    scoped.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: BACKUP_V2.partBytes },
      (_r, body, done) => done(null, body),
    );
    function route(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      action: (
        r: FastifyRequest,
        reply: FastifyReply,
        session: HubSession,
        signal: AbortSignal,
      ) => Promise<any>,
      bodyLimit = BACKUP_V2.manifestBytes,
    ) {
      scoped.route({
        method,
        url: PREFIX + path,
        bodyLimit,
        handler: async (r, reply) => {
          const control = new AbortController();
          const abort = () => control.abort(busy());
          const close = () => {
            if (!reply.raw.writableEnded) abort();
          };
          r.raw.once("aborted", abort);
          reply.raw.once("close", close);
          try {
            const s = await identity.authenticate(r);
            if (
              o.publicationDisabled &&
              ((method === "POST" && path.endsWith("/checkpoints")) ||
                method === "PUT" ||
                path.endsWith("/publish"))
            )
              throw new AppError(
                "BACKUP_BUSY",
                "Cloud backup publication is paused. Local saves and completed backup restore remain available.",
                503,
              );
            reply.header("cache-control", "no-store");
            const operation: BackupOperation | undefined =
              method === "PUT"
                ? "upload"
                : method === "POST" && path.endsWith("/checkpoints")
                  ? "prepare"
                  : method === "POST" && path.endsWith("/publish")
                    ? "publish"
                    : method === "GET" && path.startsWith("/parts/")
                      ? "restore"
                      : undefined;
            try {
              return operation
                ? await admission.run(operation, control.signal, () =>
                    action(r, reply, s, control.signal),
                  )
                : await action(r, reply, s, control.signal);
            } catch (error) {
              if ((error as any)?.status === 429)
                reply.header("retry-after", "2");
              throw error;
            }
          } finally {
            r.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", close);
          }
        },
      });
    }
    const tx = <T>(
      s: HubSession,
      signal: AbortSignal,
      fn: (c: PoolClient) => Promise<T>,
    ) =>
      withBackupTransaction(pool, signal, async (c) => {
        await profile(c, s, o.encryptionKey);
        return fn(c);
      });
    route("GET", "/capabilities", async (_r, _reply, s, signal) =>
      tx(s, signal, async (c) => ({
        version: 2,
        pagedCatalogV1: true,
        restoreReaderPinsV1: true,
        cancellationAdoptionV1: true,
        limits: BACKUP_V2,
        allowance: profileWireLimits(await resolveProfilePolicy(c, s.userId)),
        localWritesIndependent: true,
        publicationEnabled: !o.publicationDisabled&&await backupCatalogReady(c,pool),
        legacyConversion: "retired",
        ...(await legacyNamespaceHints(c, s.profileId)),
        automaticOverwrite: false,
      })),
    );
    route("POST", "/replicas", async(req,_reply,s,signal)=>{
      const b=object(req.body),id=uuid(b.replicaId),incarnation=uuid(b.incarnation);if(typeof b.label!=="string"||!b.label.trim()||b.label.length>80)throw invalid("Choose a short device/link label.");if(b.seedCheckpointId!=null)uuid(b.seedCheckpointId);
      return tx(s,signal,async(c)=>{
        await profile(c,s,o.encryptionKey,true);
        let r=(await c.query('SELECT r.* FROM hub_backup_replicas r JOIN hub_branches b ON b.id=$3 WHERE r.profile_id=$1 AND r.replica_id=$2 AND r.origin=b.origin',[s.profileId,id,s.branchId])).rows[0];
        const usableSeed=async(seedId:string)=>{const seed=(await c.query('SELECT * FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2',[s.profileId,seedId])).rows[0];return !!seed&&seed.status==='complete'&&await checkpointAccessible(c,s.profileId,seedId);};
        if(r){
          if(r.deleted_at)throw new AppError('BACKUP_REPLICA_DELETED','This backup publisher was removed. Local data is retained.',409);
          if(r.incarnation!==incarnation)throw conflict('A replica identity cannot be rebound to different local data.');
          if((b.seedCheckpointId||null)!==r.seed_checkpoint_id){
            if(!b.seedCheckpointId&&r.seed_checkpoint_id&&!r.head_checkpoint_id&&!(await usableSeed(r.seed_checkpoint_id))&&!(await c.query("SELECT 1 FROM hub_backup_checkpoints WHERE profile_id=$1 AND replica_id=$2 AND status='prepared' LIMIT 1",[s.profileId,id])).rowCount){await c.query('UPDATE hub_backup_replicas SET seed_checkpoint_id=NULL WHERE profile_id=$1 AND replica_id=$2',[s.profileId,id]);r.seed_checkpoint_id=null;}
            else throw conflict('A replica identity cannot be rebound to different local data.');
          }
        }else{
          if(b.seedCheckpointId&&!(await usableSeed(b.seedCheckpointId)))throw new AppError('BACKUP_SEED_GONE','The selected seed is no longer available. Existing local data can continue with a fresh bounded baseline.',404);
          const origin=(await c.query('SELECT origin FROM hub_branches WHERE id=$1',[s.branchId])).rows[0]?.origin;if(!origin)throw missing();
          await c.query('INSERT INTO hub_backup_replicas(profile_id,replica_id,incarnation,branch_id,origin,label,seed_checkpoint_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.profileId,id,incarnation,s.branchId,origin,b.label.trim(),b.seedCheckpointId||null]);r=await replica(c,s,id);
        }
        return {replicaId:id,incarnation,headCheckpointId:r.head_checkpoint_id,headSequence:Number(r.head_sequence),adoptedThrough:Number(r.adopted_through)};
      });
    });
    route(
      "POST",
      "/replicas/:id/checkpoints",
      async (req, _reply, s, signal) => {
        const m = manifest(req.body);
        if (uuid((req.params as any).id) !== m.replicaId) throw invalid();
        return tx(s, signal, async (c) => {
          await requireBackupCatalogReady(c,pool);
          requireBackupAccounting(await profile(c, s, o.encryptionKey, true));
          const r = await replica(c, s, m.replicaId, true),
            existing = (
              await c.query(
                "SELECT * FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2",
                [s.profileId, m.checkpointId],
              )
            ).rows[0];
          const cancelled=await cancelledStage(c,s,m.checkpointId);
          if(cancelled){if(cancelled.manifestDigest!==m.manifestDigest)throw conflict("Cancelled identities are immutable.");return cancelled;}
          if (existing) {
            if (
              existing.manifest_digest !== m.manifestDigest ||
              existing.replica_id !== m.replicaId
            )
              throw conflict("Prepared backup identities are immutable.");
            return receiptState(c, s, existing);
          }
          if (Number(r.head_sequence) - m.adoptedThrough >= 16)
            throw new AppError(
              "BACKUP_BUSY",
              "Adopt the existing completed backup before preparing more versions. Local storage continues normally.",
              503,
            );
          if (
            r.incarnation !== m.incarnation ||
            Number(r.head_sequence) + 1 !== m.sequence ||
            r.head_checkpoint_id !== m.parentCheckpointId ||
            m.adoptedThrough > Number(r.head_sequence) ||
            m.adoptedThrough < Number(r.adopted_through)
          )
            throw conflict();
          await c.query(
            "UPDATE hub_backup_replicas SET adopted_through=$3,adopted_checkpoint_id=(SELECT checkpoint_id FROM hub_backup_checkpoints WHERE profile_id=$1 AND replica_id=$2 AND sequence=$3 AND receipt IS NOT NULL LIMIT 1),adopted_manifest_digest=(SELECT manifest_digest FROM hub_backup_checkpoints WHERE profile_id=$1 AND replica_id=$2 AND sequence=$3 AND receipt IS NOT NULL LIMIT 1),updated_at=now() WHERE profile_id=$1 AND replica_id=$2",
            [s.profileId, m.replicaId, m.adoptedThrough],
          );
          if (
            (
              await c.query(
                "SELECT 1 FROM hub_backup_checkpoints WHERE profile_id=$1 AND replica_id=$2 AND status='prepared'",
                [s.profileId, m.replicaId],
              )
            ).rowCount
          )
            throw conflict(
              "Resume or cancel the unresolved backup before preparing another.",
            );
          await c.query(
            "INSERT INTO hub_backup_checkpoints(profile_id,checkpoint_id,replica_id,sequence,parent_checkpoint_id,manifest_digest,manifest,catalog_version,catalog_cursor) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)",
            [
              s.profileId,
              m.checkpointId,
              m.replicaId,
              m.sequence,
              m.parentCheckpointId,
              m.manifestDigest,
              m,
              { phase: "root" },
            ],
          );
          const base = m.parentCheckpointId || r.seed_checkpoint_id;
          if (base)
            await c.query(
              "INSERT INTO hub_backup_catalog_pins(profile_id,owner_checkpoint_id,parent_checkpoint_id) VALUES($1,$2,$3)",
              [s.profileId, m.checkpointId, base],
            );
          for (const n of m.namespaces) {
            const key = namespaceKey(n.namespace),
              previous = (
                await c.query(
                  "SELECT v.* FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_namespace_versions v USING(profile_id,namespace_version_id) WHERE x.profile_id=$1 AND x.checkpoint_id=$2 AND x.namespace=$3",
                  [s.profileId, base, key],
                )
              ).rows[0];
            let depth = 0;
            if (n.kind === "delta") {
              if (
                !previous ||
                previous.namespace_version_id !== n.parentNamespaceVersionId ||
                previous.schema_epoch !== String(n.schemaEpoch) ||
                Number(previous.local_cut) > n.localCut
              )
                throw conflict(
                  "A delta must extend the exact completed namespace.",
                );
              depth = previous.materialized_ready
                ? 1
                : Number(previous.depth) + 1;
              if (depth >= BACKUP_V2.maximumChain)
                throw new AppError(
                  "BACKUP_BUSY",
                  "This namespace needs a background rollup before another backup. Local data is retained.",
                  503,
                );
            }
            await c.query(
              "INSERT INTO hub_backup_namespace_versions(profile_id,namespace_version_id,checkpoint_id,namespace,parent_version_id,kind,local_cut,schema_epoch,root_digest,manifest,depth,delta_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
              [
                s.profileId,
                n.namespaceVersionId,
                m.checkpointId,
                key,
                n.parentNamespaceVersionId,
                n.kind,
                n.localCut,
                String(n.schemaEpoch),
                n.rootDigest,
                n,
                depth,
                n.kind === "delta"
                  ? (previous.materialized_ready
                      ? 0
                      : Number(previous.delta_bytes || 0)) +
                    n.parts.reduce((sum, part) => sum + part.bytes, 0)
                  : 0,
              ],
            );
            await c.query(
              "INSERT INTO hub_backup_checkpoint_namespaces VALUES($1,$2,$3,$4) ON CONFLICT(profile_id,checkpoint_id,namespace) DO UPDATE SET namespace_version_id=excluded.namespace_version_id",
              [s.profileId, m.checkpointId, key, n.namespaceVersionId],
            );
            for (const p of n.parts)
              await c.query(
                "INSERT INTO hub_backup_checkpoint_parts VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                [s.profileId, m.checkpointId, p.sha256, p.bytes],
              );
          }
          return receiptState(c, s, await checkpoint(c, s, m.checkpointId));
        });
      },
    );
    route("GET", "/staging/:id", async(req,_reply,s,signal)=>tx(s,signal,async(c)=>{const id=uuid((req.params as any).id),cancelled=await cancelledStage(c,s,id);if(cancelled)return cancelled;const cp=await checkpoint(c,s,id);await replica(c,s,cp.replica_id);return receiptState(c,s,cp);}));
    route(
      "PUT",
      "/staging/:id/parts/:hash",
      async (req, _reply, s, signal) => {
        const id = uuid((req.params as any).id),
          sha = hash((req.params as any).hash),
          bytes = req.body;
        if (
          !Buffer.isBuffer(bytes) ||
          bytes.length < 1 ||
          bytes.length > BACKUP_V2.partBytes ||
          digest(bytes) !== sha
        )
          throw invalid("Binary backup part integrity mismatch.");
        // Encryption before acquiring the account quota lock; no request streaming holds SQL locks.
        const key = await tx(
            s,
            signal,
            async (c) => (await profile(c, s, o.encryptionKey)).key,
          ),
          cipher = encryptBackupPartV2(bytes, key);
        return withBackupTransaction(pool, signal, async (c) => {
          const p = await profile(c, s, o.encryptionKey, true);
          requireBackupAccounting(p);
          const cp = await checkpoint(c, s, id);
          await replica(c, s, cp.replica_id);
          if (cp.status !== "prepared" || cp.expires_at < new Date())
            throw conflict(
              "This prepared backup expired; local data was not changed.",
            );
          const expected = (
            await c.query(
              "SELECT bytes FROM hub_backup_checkpoint_parts WHERE profile_id=$1 AND checkpoint_id=$2 AND hash=$3",
              [s.profileId, id, sha],
            )
          ).rows[0];
          if (!expected || Number(expected.bytes) !== bytes.length)
            throw invalid(
              "This part is not declared by the immutable manifest.",
            );
          const present = (
            await c.query(
              "SELECT bytes FROM hub_backup_parts WHERE profile_id=$1 AND hash=$2",
              [s.profileId, sha],
            )
          ).rows[0];
          if (present) {
            if (Number(present.bytes) !== bytes.length) throw conflict();
            return { staged: true, sha256: sha, bytes: bytes.length };
          }
          const allowance = profileWireLimits(
            await resolveProfilePolicy(c, s.userId),
          );
          if (
            Number(p.backup_v2_staging_bytes) +
              Number(p.backup_v1_staging_bytes || 0) +
              Number(p.backup_conversion_staging_bytes || 0) +
              bytes.length >
              allowance.stagingBytes ||
            Number(p.backup_v2_staging_parts) +
              Number(p.backup_v1_staging_chunks || 0) >=
              4096
          )
            throw new AppError(
              "BACKUP_QUOTA_EXCEEDED",
              "Cloud backup staging is full. Local website storage continues normally.",
              413,
            );
          await c.query(
            "INSERT INTO hub_backup_parts(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,$4)",
            [s.profileId, sha, cipher, bytes.length],
          );
          await c.query(
            "UPDATE hub_profiles SET backup_v2_staging_bytes=backup_v2_staging_bytes+$2,backup_v2_staging_parts=backup_v2_staging_parts+1 WHERE id=$1",
            [s.profileId, bytes.length],
          );
          return { staged: true, sha256: sha, bytes: bytes.length };
        });
      },
      BACKUP_V2.partBytes,
    );
    route("POST", "/staging/:id/publish", async (req, _reply, s, signal) =>
      publishPreparedBackupV2(o, s, uuid((req.params as any).id), signal),
    );
    const expanded = async (
      c: PoolClient,
      s: HubSession,
      cp: any,
      paged = false,
    ) => {
      const catalog = await catalogSummary(c, s.profileId, cp);
      if (paged) {
        const { namespaces: _changed, ...header } = cp.manifest;
        return {
          checkpoint: {
            ...header,
            publicationOrdinal: String(cp.publication_ordinal),
            completedAt: cp.completed_at.toISOString(),
          },
          catalog,
          receipt: cp.receipt,
        };
      }
      if (catalog.namespaceCount > BACKUP_V2.maxNamespaces)
        throw new AppError(
          "BACKUP_UPGRADE_REQUIRED",
          "This completed backup requires paged-catalog restore support. Local data is retained.",
          426,
        );
      const ns = (
        await c.query(
          "SELECT v.manifest FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_namespace_versions v USING(profile_id,namespace_version_id) WHERE x.profile_id=$1 AND x.checkpoint_id=$2 ORDER BY x.namespace",
          [s.profileId, cp.checkpoint_id],
        )
      ).rows.map((r) => r.manifest);
      return {
        checkpoint: {
          ...cp.manifest,
          namespaces: ns,
          publicationOrdinal: String(cp.publication_ordinal),
          completedAt: cp.completed_at.toISOString(),
        },
        receipt: cp.receipt,
        ...(await legacyNamespaceHints(c, s.profileId)),
      };
    };
    route("GET", "/checkpoints/latest", async (req, _reply, s, signal) =>
      tx(s, signal, async (c) => {
        const cp = (
          await c.query(
            "SELECT c.* FROM hub_backup_checkpoints c JOIN hub_backup_replicas r USING(profile_id,replica_id) WHERE c.profile_id=$1 AND c.status='complete' AND (r.deleted_at IS NULL OR EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=c.profile_id AND seed.seed_checkpoint_id=c.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL)) ORDER BY c.publication_ordinal DESC LIMIT 1",
            [s.profileId],
          )
        ).rows[0];
        return cp
          ? expanded(c, s, cp, (req.query as any).catalog === "paged")
          : {
              checkpoint: null,
              ...(await legacyNamespaceHints(c, s.profileId)),
            };
      }),
    );
    route("GET", "/checkpoints", async (req, _reply, s, signal) =>
      tx(s, signal, async (c) => {
        const cursor = (req.query as any).cursor;
        if (cursor != null && !/^\d{1,20}$/.test(cursor))
          throw invalid("Invalid chooser cursor.");
        const rows = (
          await c.query(
            "SELECT c.checkpoint_id,c.replica_id,c.sequence,c.publication_ordinal,c.completed_at,r.label,r.origin,c.manifest_digest FROM hub_backup_checkpoints c JOIN hub_backup_replicas r USING(profile_id,replica_id) WHERE c.profile_id=$1 AND c.status='complete' AND (r.deleted_at IS NULL OR EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=c.profile_id AND seed.seed_checkpoint_id=c.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL)) AND ($2::bigint IS NULL OR c.publication_ordinal<$2) ORDER BY c.publication_ordinal DESC LIMIT 21",
            [s.profileId, cursor || null],
          )
        ).rows;
        return {
          checkpoints: rows.slice(0, 20).map((r) => ({
            checkpointId: r.checkpoint_id,
            replicaId: r.replica_id,
            sequence: Number(r.sequence),
            publicationOrdinal: String(r.publication_ordinal),
            completedAt: r.completed_at.toISOString(),
            label: r.label,
            origin: r.origin,
            manifestDigest: r.manifest_digest,
          })),
          nextCursor:
            rows.length > 20 ? String(rows[19].publication_ordinal) : null,
        };
      }),
    );
    route("GET", "/checkpoints/:id", async (req, reply, s, signal) => {
      const result=await tx(s,signal,async(c)=>{const id=uuid((req.params as any).id),pin=await acquireRestorePin(c,s,id,(req.query as any).restoreId===undefined?undefined:uuid((req.query as any).restoreId)),cp=await checkpoint(c,s,id);return {...await expanded(c,s,cp,(req.query as any).catalog==="paged"),restoreReaderPin:{version:1,ttlMs:120000,renewAfterMs:30000,leaseId:pin.leaseId}};});
      reply.header("x-atlas-restore-reader","v1");return result;
    });
    route("POST","/checkpoints/:id/restore-renew",async(req,_reply,s,signal)=>tx(s,signal,async(c)=>{const id=uuid((req.params as any).id);const result=await renewRestorePins(c,s,{checkpointId:id,leaseId:uuid(object(req.body).leaseId)});if(!result.active)throw conflict("This restore lease was replaced or expired.");return {checkpointId:id,renewed:true,ttlMs:120000,leaseId:uuid(object(req.body).leaseId)};}));
    route("POST","/checkpoints/:id/restore-release",async(req,_reply,s,signal)=>tx(s,signal,async(c)=>{const result=await releaseRestorePin(c,s,uuid((req.params as any).id),uuid(object(req.body).leaseId));await queueBackupPrune(c,s.profileId);return result;}));
    route(
      "GET",
      "/checkpoints/:id/namespaces",
      async (req, _reply, s, signal) =>
        tx(s, signal, async (c) => {
          const cp = await checkpoint(c, s, uuid((req.params as any).id));
          if (
            cp.status !== "complete" ||
            !(await checkpointAccessible(c, s.profileId, cp.checkpoint_id,restoreReaderId(s)))
          )
            throw missing();
          await renewRestorePins(c,s,{checkpointId:cp.checkpoint_id});
          const catalog = await catalogSummary(c, s.profileId, cp),
            offset = readCatalogCursor(
              o.encryptionKey,
              (req.query as any).cursor,
              cp.checkpoint_id,
              catalog.rootDigest,
            );
          const rows = (
            await c.query(
              'SELECT v.manifest FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_namespace_versions v USING(profile_id,namespace_version_id) WHERE x.profile_id=$1 AND x.checkpoint_id=$2 ORDER BY x.namespace COLLATE "C" OFFSET $3 LIMIT 33',
              [s.profileId, cp.checkpoint_id, offset],
            )
          ).rows;
          const namespaces: any[] = [];
          let bytes = 512;
          for (const row of rows.slice(0, BACKUP_V2.catalogPageItems)) {
            const length = Buffer.byteLength(JSON.stringify(row.manifest));
            if (bytes + length > BACKUP_V2.catalogPageBytes) break;
            bytes += length;
            namespaces.push(row.manifest);
          }
          if (rows.length && !namespaces.length)
            throw invalid(
              "A namespace metadata entry exceeds the catalog page byte budget.",
            );
          return {
            checkpointId: cp.checkpoint_id,
            rootDigest: catalog.rootDigest,
            namespaces,
            nextCursor:
              offset + namespaces.length < catalog.namespaceCount
                ? catalogCursor(
                    o.encryptionKey,
                    cp.checkpoint_id,
                    catalog.rootDigest,
                    offset + namespaces.length,
                  )
                : null,
          };
        }),
    );
    route(
      "GET",
      "/namespace-versions/:id/records",
      async (req, _reply, s, signal) =>
        tx(s, signal, async (c) => {
          const id = uuid((req.params as any).id),
            cursor = (req.query as any).cursor || "";
          if (cursor && !/^[a-f0-9]{64}$/.test(cursor))
            throw invalid("Invalid restore cursor.");
          const n = (
            await c.query(
              "SELECT v.* FROM hub_backup_namespace_versions v WHERE v.profile_id=$1 AND v.namespace_version_id=$2 AND EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_checkpoints p USING(profile_id,checkpoint_id) JOIN hub_backup_replicas replica USING(profile_id,replica_id) WHERE x.profile_id=v.profile_id AND x.namespace_version_id=v.namespace_version_id AND p.status='complete' AND (replica.deleted_at IS NULL OR EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=p.profile_id AND seed.seed_checkpoint_id=p.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=p.profile_id AND pin.checkpoint_id=p.checkpoint_id AND pin.reader_id=$3 AND pin.expires_at>now())))",
              [s.profileId, id,restoreReaderId(s)],
            )
          ).rows[0];
          if (!n) throw missing();
          await renewRestorePins(c,s,{namespaceVersionId:id});
          const rows = (
            await c.query(
              n.materialized_ready
                ? "SELECT * FROM hub_backup_materialized_records WHERE profile_id=$1 AND namespace_version_id=$2 AND record_id>$3 ORDER BY record_id LIMIT 65"
                : resolvedCTE +
                    " SELECT * FROM resolved WHERE record_id>$3 ORDER BY record_id LIMIT 65",
              [s.profileId, id, cursor],
            )
          ).rows;
          const records: any[] = [];
          let bytes = 0;
          for (const row of rows.slice(0, 64)) {
            const r = wireRecord(row),
              length = Buffer.byteLength(JSON.stringify(r));
            if (bytes + length > BACKUP_V2.partBytes - 4096) break;
            bytes += length;
            records.push(r);
          }
          return {
            namespaceVersion: n.manifest,
            records,
            nextCursor:
              rows.length > records.length
                ? records[records.length - 1]?.recordId || null
                : null,
          };
        }),
    );
    route("GET", "/parts/:hash", async (req, reply, s, signal) => {
      const bytes = await tx(s, signal, async (c) => {
        const sha = hash((req.params as any).hash),
          p = await profile(c, s, o.encryptionKey),
          part = (
            await c.query(
              "SELECT b.encrypted_payload FROM hub_backup_parts b WHERE b.profile_id=$1 AND b.hash=$2 AND b.published_refs>0 AND EXISTS(SELECT 1 FROM hub_backup_checkpoint_parts part JOIN hub_backup_checkpoints cp USING(profile_id,checkpoint_id) JOIN hub_backup_replicas replica USING(profile_id,replica_id) WHERE part.profile_id=b.profile_id AND part.hash=b.hash AND cp.status='complete' AND (replica.deleted_at IS NULL OR EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=cp.profile_id AND seed.seed_checkpoint_id=cp.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=cp.profile_id AND pin.checkpoint_id=cp.checkpoint_id AND pin.reader_id=$3 AND pin.expires_at>now())))",
              [s.profileId, sha,restoreReaderId(s)],
            )
          ).rows[0];
        if (!part) throw missing();
        const raw = decryptPart(part.encrypted_payload, p.key);
        if (digest(raw) !== sha)
          throw invalid("Stored backup part integrity failed.");
        await renewRestorePins(c,s,{partHash:sha});
        return raw;
      });
      return reply.type("application/octet-stream").send(bytes);
    });
    route("POST", "/replicas/:id/adopt", async (req, _reply, s, signal) =>
      tx(s, signal, async (c) => {
        const id = uuid((req.params as any).id),
          through = integer(object(req.body).adoptedThrough);
        await profile(c, s, o.encryptionKey, true);
        const r = await replica(c, s, id, true),
          body = object(req.body);
        if (
          body.incarnation !== undefined &&
          uuid(body.incarnation) !== r.incarnation
        )
          throw conflict("This local replica incarnation was replaced.");
        if (
          body.checkpointId !== undefined ||
          body.manifestDigest !== undefined
        ) {
          if (
            through === Number(r.adopted_through) &&
            uuid(body.checkpointId) === r.adopted_checkpoint_id &&
            hash(body.manifestDigest) === r.adopted_manifest_digest
          )
            return { replicaId: id, adoptedThrough: through };
          const receipt = await checkpoint(c, s, uuid(body.checkpointId));
          if (
            receipt.replica_id !== id ||
            Number(receipt.sequence) !== through ||
            receipt.manifest_digest !== hash(body.manifestDigest) ||
            !receipt.receipt
          )
            throw conflict(
              "The adopted receipt does not match this publisher.",
            );
        }
        if (
          through > Number(r.head_sequence) ||
          through < Number(r.adopted_through)
        )
          throw conflict();
        await c.query(
          "UPDATE hub_backup_replicas SET adopted_through=$3,adopted_checkpoint_id=(SELECT checkpoint_id FROM hub_backup_checkpoints WHERE profile_id=$1 AND replica_id=$2 AND sequence=$3 AND receipt IS NOT NULL LIMIT 1),adopted_manifest_digest=(SELECT manifest_digest FROM hub_backup_checkpoints WHERE profile_id=$1 AND replica_id=$2 AND sequence=$3 AND receipt IS NOT NULL LIMIT 1),updated_at=now() WHERE profile_id=$1 AND replica_id=$2",
          [s.profileId, id, through],
        );
        await queueBackupPrune(c, s.profileId);
        return { replicaId: id, adoptedThrough: through };
      }),
    );
    route("DELETE", "/replicas/:id", async (req, _reply, s, signal) =>
      tx(s, signal, async (c) => {
        const id = uuid((req.params as any).id);
        await profile(c, s, o.encryptionKey, true);
        const owned = await replica(c, s, id, true, true);
        if (owned.deleted_at)
          return { replicaId: id, deleted: true, localDataPreserved: true };
        await c.query(
          "UPDATE hub_backup_replicas SET deleted_at=now(),updated_at=now() WHERE profile_id=$1 AND replica_id=$2",
          [s.profileId, id],
        );
        await c.query(
          "UPDATE hub_backup_checkpoints SET status='expired' WHERE profile_id=$1 AND replica_id=$2 AND status='prepared'",
          [s.profileId, id],
        );
        await queueBackupPrune(c, s.profileId);
        return { replicaId: id, deleted: true, localDataPreserved: true };
      }),
    );
    route("DELETE", "/staging/:id", async(req,_reply,s,signal)=>tx(s,signal,async(c)=>{
      await profile(c,s,o.encryptionKey,true);const id=uuid((req.params as any).id),old=await cancelledStage(c,s,id);if(old)return {checkpointId:id,manifestDigest:old.manifestDigest,cancelled:true};
      const cp=await checkpoint(c,s,id,true);await replica(c,s,cp.replica_id,true);
      if(cp.receipt||!["prepared","expired"].includes(cp.status))throw conflict("A completed backup cannot be cancelled.");
      if(Number((await c.query('SELECT count(*) count FROM hub_backup_cancellations WHERE profile_id=$1 AND replica_id=$2',[s.profileId,cp.replica_id])).rows[0].count)>=16)throw new AppError("BACKUP_BUSY","Adopt previous cancellation receipts before cancelling more preparations.",503);
      await c.query('INSERT INTO hub_backup_cancellations(profile_id,checkpoint_id,replica_id,manifest_digest,sequence,parent_checkpoint_id) VALUES($1,$2,$3,$4,$5,$6)',[s.profileId,id,cp.replica_id,cp.manifest_digest,cp.sequence,cp.parent_checkpoint_id]);
      await c.query("UPDATE hub_backup_checkpoints SET status='expired' WHERE profile_id=$1 AND checkpoint_id=$2",[s.profileId,id]);await c.query('UPDATE hub_backup_parts p SET gc_eligible_at=now() FROM hub_backup_checkpoint_parts r WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND NOT r.ref_held AND p.profile_id=r.profile_id AND p.hash=r.hash AND p.published_refs=0',[s.profileId,id]);
      await queueBackupPrune(c,s.profileId);return {checkpointId:id,manifestDigest:cp.manifest_digest,cancelled:true};
    }));
    route("POST","/replicas/:id/cancellations/adopt",async(req,_reply,s,signal)=>tx(s,signal,async(c)=>{
      await profile(c,s,o.encryptionKey,true);const id=uuid((req.params as any).id),body=object(req.body),cancelledId=uuid(body.checkpointId),cancelledDigest=hash(body.manifestDigest),r=await replica(c,s,id,true,true);
      if(r.last_cancel_checkpoint_id===cancelledId&&r.last_cancel_manifest_digest===cancelledDigest)return cancellationAdoptionResult(r);
      const receipt=(await c.query('SELECT * FROM hub_backup_cancellations WHERE profile_id=$1 AND checkpoint_id=$2 AND replica_id=$3',[s.profileId,cancelledId,id])).rows[0];
      if(!receipt)throw missing();if(receipt.manifest_digest!==cancelledDigest||Number(receipt.sequence)!==Number(r.head_sequence)+1||receipt.parent_checkpoint_id!==r.head_checkpoint_id)throw conflict("This cancelled preparation no longer matches the publication sequence.");
      const next=(await c.query('UPDATE hub_backup_replicas SET head_sequence=$3,adopted_through=$3,last_cancel_checkpoint_id=$4,last_cancel_manifest_digest=$5,last_cancel_sequence=$3,last_cancel_parent_checkpoint_id=head_checkpoint_id,updated_at=now() WHERE profile_id=$1 AND replica_id=$2 RETURNING *',[s.profileId,id,receipt.sequence,cancelledId,cancelledDigest])).rows[0];
      await c.query('DELETE FROM hub_backup_cancellations WHERE profile_id=$1 AND replica_id=$2 AND sequence<=$3',[s.profileId,id,receipt.sequence]);return cancellationAdoptionResult(next);
    }));

  });
  if (o.maintenance !== false) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void runBackupMaintenanceSlice(o.maintenancePool ?? pool)
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    }, 1000);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }
}
/** Bounded resumable rollup stores only immutable record references, never native values. */
const maintenanceTurns = new WeakMap<Pool, number>();
export async function runBackupMaintenanceSlice(
  pool: Pool,
  options: { legacyAccountingOnly?: boolean } = {},
) {
  const turn = (maintenanceTurns.get(pool) || 0) + 1;
  maintenanceTurns.set(pool, turn % 3);
  if (turn % 3 === 0) {
    const accounting = await runBackupAccountingSlice(pool, {
      legacyOnly: options.legacyAccountingOnly,
    });
    if (accounting.worked && !accounting.deferred) return accounting;
  }
  const result = await withBackupTransaction(
    pool,
    new AbortController().signal,
    async (c) => {
      const job = (
        await c.query(
          "SELECT * FROM hub_backup_jobs WHERE kind='rollup' AND COALESCE(cursor->>'format','')<>'bounded-rollup-v2' AND (status='pending' OR (status='running' AND lease_expires_at<now())) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
      ).rows[0];
      if (!job) return collectBackupGarbageSlice(c, pool);
      await c.query(
        "UPDATE hub_backup_jobs SET status='running',attempts=attempts+1,lease_expires_at=now()+interval '10 seconds',updated_at=now() WHERE id=$1",
        [job.id],
      );
      const cursor = job.cursor?.recordId || "",
        rows = (
          await c.query(
            resolvedCTE +
              " SELECT * FROM resolved WHERE record_id>$3 ORDER BY record_id LIMIT 65",
            [job.profile_id, job.namespace_version_id, cursor],
          )
        ).rows;
      if (rows.length)
        await c.query(
          `INSERT INTO hub_backup_materialized_records(profile_id,namespace_version_id,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments) SELECT $1,$2,x.record_id,x.store_name,x.store_epoch,x.operation,x.sha256,x.total_bytes,x.fragments FROM jsonb_to_recordset($3::jsonb) x(record_id text,store_name text,store_epoch bigint,operation text,sha256 text,total_bytes integer,fragments jsonb) ON CONFLICT DO NOTHING`,
          [
            job.profile_id,
            job.namespace_version_id,
            JSON.stringify(rows.slice(0, 64)),
          ],
        );
      const done = rows.length <= 64;
      if (done)
        await c.query(
          "UPDATE hub_backup_namespace_versions SET materialized_ready=true,parent_version_id=NULL,depth=0,delta_bytes=0 WHERE profile_id=$1 AND namespace_version_id=$2",
          [job.profile_id, job.namespace_version_id],
        );
      await c.query(
        "UPDATE hub_backup_jobs SET status=$2,cursor=$3,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
        [
          job.id,
          done ? "complete" : "pending",
          done ? null : { recordId: rows[63].record_id },
        ],
      );
      return { worked: true, complete: done };
    },
  );
  if (!result.worked && turn % 3 !== 0)
    return runBackupAccountingSlice(pool, {
      legacyOnly: options.legacyAccountingOnly,
    });
  return result;
}

/** One profile /64 parts per slice. A fresh prepared reference always wins over collection. */
const backupGarbageCursors = new WeakMap<Pool, string>();
export async function collectBackupGarbageSlice(
  c: PoolClient,
  pool: Pool,
  options: { profileId?: string } = {},
) {
  const select = (cursor?: string) =>
    c.query(
      `SELECT p.id FROM hub_profiles p WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::uuid IS NULL OR p.id=$2) AND (
 EXISTS(SELECT 1 FROM hub_backup_parts b WHERE b.profile_id=p.id AND b.published_refs=0 AND (b.ever_published OR b.gc_eligible_at<=now() OR b.created_at<now()-interval '24 hours')) OR
 EXISTS(SELECT 1 FROM hub_backup_checkpoints x WHERE x.profile_id=p.id AND ((x.status='prepared' AND x.expires_at<now()) OR x.status IN ('expired','retired'))) OR EXISTS(SELECT 1 FROM hub_backup_jobs j WHERE j.profile_id=p.id AND j.kind='prune' AND j.status='pending') OR EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=p.id AND pin.expires_at<=now()))
 ORDER BY p.id LIMIT 1 FOR NO KEY UPDATE OF p SKIP LOCKED`,
      [cursor || null, options.profileId || null],
    );
  let candidate = (await select(backupGarbageCursors.get(pool))).rows[0];
  if (!candidate && backupGarbageCursors.has(pool))
    candidate = (await select()).rows[0];
  if (!candidate) return { worked: false };
  const id = candidate.id;
  backupGarbageCursors.set(pool, id);
  let metadataWork = false;
  const expiredReaders=await collectExpiredRestorePins(c,id);if(expiredReaders){metadataWork=true;await queueBackupPrune(c,id);}
  const expired = await c.query(
    `UPDATE hub_backup_checkpoints SET status='expired' WHERE profile_id=$1 AND checkpoint_id IN
 (SELECT checkpoint_id FROM hub_backup_checkpoints WHERE profile_id=$1 AND status='prepared' AND expires_at<now() ORDER BY expires_at LIMIT 32)`,
    [id],
  );
  metadataWork = metadataWork||!!expired.rowCount;
  if (await releaseCatalogReferences(c, id))
    return { worked: true, collectedParts: 0, collectedBytes: 0 };
  if (await processBackupPrune(c, id))
    return { worked: true, collectedParts: 0, collectedBytes: 0 };
  const removed = (
    await c.query(
      `WITH candidates AS MATERIALIZED (SELECT b.hash,b.bytes,b.created_at FROM hub_backup_parts b WHERE b.profile_id=$1 AND b.published_refs=0 AND (b.ever_published OR b.gc_eligible_at<=now() OR b.created_at<now()-interval '24 hours') AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins pin JOIN hub_backup_checkpoint_parts held ON held.profile_id=pin.profile_id AND held.checkpoint_id=pin.checkpoint_id WHERE pin.profile_id=b.profile_id AND held.hash=b.hash AND pin.expires_at>now()) AND NOT EXISTS
 (SELECT 1 FROM hub_backup_checkpoint_parts r JOIN hub_backup_checkpoints x USING(profile_id,checkpoint_id) WHERE r.profile_id=b.profile_id AND r.hash=b.hash AND x.status='prepared' AND x.expires_at>now()) AND NOT EXISTS(SELECT 1 FROM hub_backup_replicas seed JOIN hub_backup_checkpoint_parts pinned ON pinned.profile_id=seed.profile_id AND pinned.checkpoint_id=seed.seed_checkpoint_id WHERE seed.profile_id=b.profile_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL AND pinned.hash=b.hash)
 ORDER BY b.created_at,b.hash LIMIT 64 FOR UPDATE OF b SKIP LOCKED), bounded AS
 (SELECT hash FROM (SELECT hash,sum(bytes) OVER(ORDER BY created_at,hash) total FROM candidates) x WHERE total<=8388608)
 DELETE FROM hub_backup_parts b USING bounded x WHERE b.profile_id=$1 AND b.hash=x.hash AND b.published_refs=0 RETURNING b.bytes`,
      [id],
    )
  ).rows;
  const bytes = removed.reduce((n, r) => n + Number(r.bytes), 0);
  if (bytes)
    await c.query(
      "UPDATE hub_profiles SET backup_v2_staging_bytes=backup_v2_staging_bytes-$2,backup_v2_staging_parts=backup_v2_staging_parts-$3 WHERE id=$1",
      [id, bytes, removed.length],
    );
  // Receipt pruning requires a durable adoption watermark. Legacy receipts are not touched.
  const obsolete = (
    await c.query(
      `SELECT x.checkpoint_id FROM hub_backup_checkpoints x JOIN hub_backup_replicas r USING(profile_id,replica_id)
 WHERE x.profile_id=$1 AND (x.status='expired' OR (x.status='retired' AND (x.sequence<=r.adopted_through OR r.deleted_at IS NOT NULL)))
 AND (x.catalog_version=0 OR x.catalog_released) AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=x.profile_id AND pin.checkpoint_id=x.checkpoint_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_pins pin WHERE pin.profile_id=x.profile_id AND pin.parent_checkpoint_id=x.checkpoint_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins reader WHERE reader.profile_id=x.profile_id AND reader.checkpoint_id=x.checkpoint_id AND reader.expires_at>now()) AND (x.checkpoint_id IS DISTINCT FROM r.head_checkpoint_id OR r.deleted_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=$1 AND seed.seed_checkpoint_id=x.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL)
 ORDER BY x.publication_ordinal NULLS FIRST,x.created_at LIMIT 32`,
      [id],
    )
  ).rows.map((r) => r.checkpoint_id);
  if (obsolete.length) {
    await c.query(
      "DELETE FROM hub_backup_migration_aliases a USING hub_backup_namespace_versions v WHERE a.profile_id=$1 AND v.profile_id=a.profile_id AND v.namespace_version_id=a.namespace_version_id AND a.credit_bytes=0 AND NOT a.source_valid AND v.checkpoint_id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_checkpoints p USING(profile_id,checkpoint_id) WHERE x.profile_id=a.profile_id AND x.namespace_version_id=a.namespace_version_id AND p.status='complete')",
      [id, obsolete],
    );
    await c.query(
      "DELETE FROM hub_backup_checkpoint_namespaces WHERE profile_id=$1 AND checkpoint_id=ANY($2::uuid[])",
      [id, obsolete],
    );
    const rootsRemoved = await c.query(
      "DELETE FROM hub_backup_catalog_root_pages WHERE profile_id=$1 AND checkpoint_id=ANY($2::uuid[])",
      [id, obsolete],
    );
    const pagesRemoved = await c.query(
      "DELETE FROM hub_backup_catalog_pages p WHERE p.profile_id=$1 AND p.page_id IN(SELECT page_id FROM hub_backup_catalog_pages page WHERE page.profile_id=$1 AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_root_pages root WHERE root.profile_id=page.profile_id AND root.page_id=page.page_id) ORDER BY page.created_at LIMIT 2)",
      [id],
    );
    metadataWork =
      metadataWork || !!rootsRemoved.rowCount || !!pagesRemoved.rowCount;
    // Parent pointers from unresolved deltas preserve their immutable sources. Rollup detaches only its materialized physical ancestry.
    const namespacesRemoved = await c.query(
      `DELETE FROM hub_backup_namespace_versions n WHERE n.profile_id=$1 AND n.checkpoint_id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM hub_backup_namespace_versions child WHERE child.profile_id=n.profile_id AND child.parent_version_id=n.namespace_version_id)
    AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs live WHERE live.profile_id=n.profile_id AND live.namespace_version_id=n.namespace_version_id)
    AND NOT EXISTS(SELECT 1 FROM hub_backup_migration_aliases a WHERE a.profile_id=n.profile_id AND a.namespace_version_id=n.namespace_version_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_entries e WHERE e.profile_id=n.profile_id AND e.namespace_version_id=n.namespace_version_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_rollup_sources pin WHERE pin.profile_id=n.profile_id AND pin.namespace_version_id=n.namespace_version_id)`,
      [id, obsolete],
    );
    const checkpointsRemoved = await c.query(
      `DELETE FROM hub_backup_checkpoints x WHERE x.profile_id=$1 AND x.checkpoint_id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM hub_backup_namespace_versions n WHERE n.profile_id=x.profile_id AND n.checkpoint_id=x.checkpoint_id)`,
      [id, obsolete],
    );
    metadataWork =
      metadataWork ||
      !!namespacesRemoved.rowCount ||
      !!checkpointsRemoved.rowCount;
  }
  return {
    worked: metadataWork || removed.length > 0,
    collectedParts: removed.length,
    collectedBytes: bytes,
  };
}

/** Shared publication path for authenticated clients and pinned conversion jobs. */
export async function publishPreparedBackupV2(
  o: { pool: Pool; encryptionKey: string },
  s: HubSession,
  id: string,
  signal: AbortSignal,
  migration?: {
    namespace: string;
    revision: number;
    sourceDigest: string;
    creditBytes: number;
  },
) {
  const { pool } = o;
  const tx = <T>(
    session: HubSession,
    signal: AbortSignal,
    fn: (c: PoolClient) => Promise<T>,
  ) =>
    withBackupTransaction(pool, signal, async (c) => {
      await profile(c, session, o.encryptionKey);
      return fn(c);
    });

  const prepared = await tx(s, signal, async (c) => {
    const p = await checkpoint(c, s, id);
    await replica(c, s, p.replica_id);
    const key = (await profile(c, s, o.encryptionKey)).key;
    return { cp: p, key };
  });
  if (prepared.cp.receipt) return prepared.cp.receipt;
  if (prepared.cp.status !== "prepared" || prepared.cp.expires_at < new Date())
    throw conflict("This backup preparation is no longer publishable.");
  const m = manifest(prepared.cp.manifest),
    indexes = new Map<string, IndexedBackupRecord[]>();
  // Read/decrypt/validate bounded parts without an account transaction or publication lock.
  for (const n of m.namespaces) {
    if (
      n.kind === "deleted" ||
      (!n.parts.length && n.namespace.kind !== "idb")
    ) {
      indexes.set(n.namespaceVersionId, []);
      continue;
    }
    const ps = await tx(s, signal, async (c) => {
      const rows = (
        await c.query(
          "SELECT hash,encrypted_payload,bytes FROM hub_backup_parts WHERE profile_id=$1 AND hash=ANY($2::text[])",
          [s.profileId, n.parts.map((p) => p.sha256)],
        )
      ).rows;
      const byHash = new Map(rows.map((p) => [p.hash, p]));
      return n.parts.map((p) => {
        const row = byHash.get(p.sha256);
        if (!row || Number(row.bytes) !== p.bytes)
          throw new AppError(
            "BACKUP_INCOMPLETE",
            "Upload all declared backup parts before publication.",
            409,
          );
        return {
          sha256: p.sha256,
          bytes: decryptPart(row.encrypted_payload, prepared.key),
        };
      });
    });
    indexes.set(
      n.namespaceVersionId,
      await validateBackupParts(
        n.namespaceVersionId,
        ps,
        signal,
        n.namespace,
        n.localCut,
      ),
    );
  }
  if (Number(prepared.cp.catalog_version) === 1)
    return publishPreparedCatalogV1(o, s, id, signal, m, indexes);
  return withBackupTransaction(pool, signal, async (c) => {
    let p = await profile(c, s, o.encryptionKey, true);
    requireBackupAccounting(p);
    const r = await replica(c, s, m.replicaId, true),
      cp = await checkpoint(c, s, id, true);
    if (cp.receipt) return cp.receipt;
    if (
      cp.status !== "prepared" ||
      cp.manifest_digest !== m.manifestDigest ||
      r.incarnation !== m.incarnation ||
      Number(r.head_sequence) + 1 !== m.sequence ||
      r.head_checkpoint_id !== m.parentCheckpointId
    )
      throw conflict();
    for (const n of m.namespaces) {
      const records = indexes.get(n.namespaceVersionId)!;
      if (records.length)
        await c.query(
          `INSERT INTO hub_backup_record_index(profile_id,namespace_version_id,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments)
           SELECT $1,$2,x.record_id,x.store_name,x.store_epoch,x.operation,x.sha256,x.total_bytes,x.fragments FROM jsonb_to_recordset($3::jsonb) x(record_id text,store_name text,store_epoch bigint,operation text,sha256 text,total_bytes integer,fragments jsonb)`,
          [
            s.profileId,
            n.namespaceVersionId,
            JSON.stringify(
              records.map((r) => ({
                record_id: r.recordId,
                store_name: r.store,
                store_epoch: r.storeEpoch,
                operation: r.operation,
                sha256: r.sha256,
                total_bytes: r.totalBytes,
                fragments: r.fragments,
              })),
            ),
          ],
        );
    }
    // Freeze every reachable part reference. A checkpoint can be restored without its parent's checkpoint row.
    const namespaces = (
      await c.query(
        "SELECT namespace_version_id FROM hub_backup_catalog_namespace_refs WHERE profile_id=$1 AND checkpoint_id=$2",
        [s.profileId, id],
      )
    ).rows;
    for (const n of namespaces) {
      const missingResolved = (
        await c.query(
          resolvedCTE +
            ` SELECT 1 FROM resolved r CROSS JOIN LATERAL jsonb_array_elements(r.fragments) f LEFT JOIN hub_backup_parts p ON p.profile_id=$1 AND p.hash=f->>'sha256' WHERE p.hash IS NULL LIMIT 1`,
          [s.profileId, n.namespace_version_id],
        )
      ).rowCount;
      if (missingResolved)
        throw new AppError(
          "BACKUP_INCOMPLETE",
          "An inherited immutable backup part is missing. No checkpoint was published.",
          409,
        );
    }
    await c.query(
      "DELETE FROM hub_backup_checkpoint_parts WHERE profile_id=$1 AND checkpoint_id=$2 AND NOT(hash=ANY($3::text[]))",
      [
        s.profileId,
        id,
        m.namespaces.flatMap((n) => n.parts.map((part) => part.sha256)),
      ],
    );
    for (const n of namespaces)
      await c.query(
        resolvedCTE +
          ` INSERT INTO hub_backup_checkpoint_parts SELECT $1,$3,f->>'sha256',p.bytes FROM resolved r CROSS JOIN LATERAL jsonb_array_elements(r.fragments) f JOIN hub_backup_parts p ON p.profile_id=$1 AND p.hash=f->>'sha256' ON CONFLICT DO NOTHING`,
        [s.profileId, n.namespace_version_id, id],
      );
    const incomplete = (
      await c.query(
        "SELECT 1 FROM hub_backup_checkpoint_parts r LEFT JOIN hub_backup_parts p ON p.profile_id=r.profile_id AND p.hash=r.hash WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND p.hash IS NULL LIMIT 1",
        [s.profileId, id],
      )
    ).rowCount;
    if (incomplete)
      throw new AppError(
        "BACKUP_INCOMPLETE",
        "A declared backup part is missing.",
        409,
      );
    let added = Number(
      (
        await c.query(
          "SELECT COALESCE(sum(p.bytes),0) bytes FROM hub_backup_checkpoint_parts r JOIN hub_backup_parts p USING(profile_id,hash) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND p.published_refs=0",
          [s.profileId, id],
        )
      ).rows[0].bytes,
    );
    const stamp = (
      await c.query(
        "SELECT nextval('hub_backup_publication_order')::text ordinal,clock_timestamp() completed",
      )
    ).rows[0];
    await c.query(
      "UPDATE hub_backup_checkpoints SET status='complete',publication_ordinal=$3,completed_at=$4,history_day=($4::timestamptz AT TIME ZONE 'UTC')::date WHERE profile_id=$1 AND checkpoint_id=$2",
      [s.profileId, id, stamp.ordinal, stamp.completed],
    );
    if (migration) {
      const source = (
        await c.query(
          "SELECT revision,snapshot_revision,encrypted_payload FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
          [s.profileId, migration.namespace],
        )
      ).rows[0];
      if (
        !source ||
        Number(source.revision) !== migration.revision ||
        Number(source.snapshot_revision) !== migration.revision ||
        digest(source.encrypted_payload) !== migration.sourceDigest
      )
        throw conflict(
          "The pinned legacy checkpoint changed; its original data is preserved.",
        );
      const credit = Math.min(integer(migration.creditBytes), added);
      await c.query(
        "INSERT INTO hub_backup_migration_aliases(profile_id,v1_namespace,v1_revision,namespace_version_id,credit_bytes,equivalent_bytes) VALUES($1,$2,$3,$4,0,$5)",
        [
          s.profileId,
          migration.namespace,
          migration.revision,
          m.namespaces[0].namespaceVersionId,
          credit,
        ],
      );
    }
    const reactivated = Number(
      (
        await c.query(
          `WITH eligible AS MATERIALIZED (
 SELECT a.v1_namespace,a.v1_revision,a.equivalent_bytes-a.credit_bytes delta FROM hub_backup_migration_aliases a JOIN hub_streams source ON source.profile_id=a.profile_id AND source.namespace=a.v1_namespace
 WHERE a.profile_id=$1 AND a.source_valid AND a.credit_bytes<a.equivalent_bytes AND source.revision=a.v1_revision AND source.snapshot_revision=a.v1_revision AND EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_checkpoints p USING(profile_id,checkpoint_id) WHERE x.profile_id=a.profile_id AND x.namespace_version_id=a.namespace_version_id AND p.status='complete') FOR UPDATE OF a
 ), changed AS (UPDATE hub_backup_migration_aliases a SET credit_bytes=a.equivalent_bytes FROM eligible e WHERE a.profile_id=$1 AND a.v1_namespace=e.v1_namespace AND a.v1_revision=e.v1_revision RETURNING a.v1_revision)
 SELECT COALESCE(sum(delta),0) bytes FROM eligible`,
          [s.profileId],
        )
      ).rows[0].bytes,
    );
    if (reactivated)
      await c.query(
        "UPDATE hub_profiles SET backup_v2_migration_credit=backup_v2_migration_credit+$2,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes-backup_v2_migration_credit-$2) WHERE id=$1",
        [s.profileId, reactivated],
      );
    const allowance = await resolveProfilePolicy(c, s.userId);
    let shortened = await pruneHistory(c, s.profileId);
    p = await profile(c, s, o.encryptionKey);
    if (
      Number(p.backup_v1_canonical_bytes) +
        Math.max(
          0,
          Number(p.backup_v2_bytes) +
            added -
            Number(p.backup_v2_migration_credit),
        ) >
      allowance.profileBytes
    )
      shortened =
        (await pruneHistory(
          c,
          s.profileId,
          Number(p.backup_v1_canonical_bytes) +
            Math.max(
              0,
              Number(p.backup_v2_bytes) +
                added -
                Number(p.backup_v2_migration_credit),
            ) -
            allowance.profileBytes,
          m.replicaId,
          id,
        )) || shortened;
    // Retention can release a part this new checkpoint also needs; recalculate exact transitions.
    added = Number(
      (
        await c.query(
          "SELECT COALESCE(sum(p.bytes),0) bytes FROM hub_backup_checkpoint_parts r JOIN hub_backup_parts p USING(profile_id,hash) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND p.published_refs=0",
          [s.profileId, id],
        )
      ).rows[0].bytes,
    );
    p = await profile(c, s, o.encryptionKey);
    if (
      Number(p.backup_v1_canonical_bytes) +
        Math.max(
          0,
          Number(p.backup_v2_bytes) +
            added -
            Number(p.backup_v2_migration_credit),
        ) >
      allowance.profileBytes
    )
      throw new AppError(
        "BACKUP_QUOTA_EXCEEDED",
        "Protected cloud backups fill this account allowance. Local saves remain available.",
        413,
      );
    await c.query(
      "UPDATE hub_backup_parts p SET published_refs=published_refs+1,ever_published=true FROM hub_backup_checkpoint_parts r WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND p.profile_id=r.profile_id AND p.hash=r.hash",
      [s.profileId, id],
    );
    await c.query(
      "UPDATE hub_profiles SET backup_v2_bytes=backup_v2_bytes+$2,backup_v2_staging_bytes=backup_v2_staging_bytes-$2,backup_v2_staging_parts=backup_v2_staging_parts-(SELECT count(*) FROM hub_backup_checkpoint_parts r JOIN hub_backup_parts p USING(profile_id,hash) WHERE r.profile_id=$1 AND r.checkpoint_id=$3 AND p.published_refs=1),bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes+$2-backup_v2_migration_credit) WHERE id=$1",
      [s.profileId, added, id],
    );
    const receipt: BackupPublishReceiptV2 = {
      acknowledged: true,
      checkpointId: id,
      replicaId: m.replicaId,
      sequence: m.sequence,
      manifestDigest: m.manifestDigest,
      publicationOrdinal: stamp.ordinal,
      completedAt: stamp.completed.toISOString(),
      coverage: m.namespaces.map((n) => ({
        namespaceVersionId: n.namespaceVersionId,
        localCut: n.localCut,
      })),
      historyShortened: shortened,
    };
    await c.query(
      "UPDATE hub_backup_checkpoints SET status='complete',publication_ordinal=$3,completed_at=$4,history_day=($4::timestamptz AT TIME ZONE 'UTC')::date,receipt=$5 WHERE profile_id=$1 AND checkpoint_id=$2",
      [s.profileId, id, stamp.ordinal, stamp.completed, receipt],
    );
    await c.query(
      "UPDATE hub_backup_replicas SET head_checkpoint_id=$3,head_sequence=$4,updated_at=now() WHERE profile_id=$1 AND replica_id=$2",
      [s.profileId, m.replicaId, id, m.sequence],
    );
    for (const n of m.namespaces)
      await c.query(
        "INSERT INTO hub_backup_jobs(profile_id,kind,namespace_version_id) SELECT $1,'rollup',$2 FROM hub_backup_namespace_versions v WHERE v.profile_id=$1 AND v.namespace_version_id=$2 AND (v.depth>=8 OR v.delta_bytes>=1048576) AND NOT EXISTS(SELECT 1 FROM hub_backup_jobs j WHERE j.profile_id=$1 AND j.namespace_version_id=$2 AND j.kind='rollup' AND j.status IN ('pending','running'))",
        [s.profileId, n.namespaceVersionId],
      );
    return receipt;
  });
}

async function revokeObsoleteBackupCredits(c: PoolClient, profileId: string) {
  const revoked = Number(
    (
      await c.query(
        `WITH obsolete AS MATERIALIZED(SELECT a.v1_namespace,a.v1_revision,a.credit_bytes FROM hub_backup_migration_aliases a WHERE a.profile_id=$1 AND a.credit_bytes>0 AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_namespace_refs x JOIN hub_backup_checkpoints p USING(profile_id,checkpoint_id) WHERE x.profile_id=a.profile_id AND x.namespace_version_id=a.namespace_version_id AND p.status='complete') FOR UPDATE OF a), cleared AS(UPDATE hub_backup_migration_aliases a SET credit_bytes=0 FROM obsolete o WHERE a.profile_id=$1 AND a.v1_namespace=o.v1_namespace AND a.v1_revision=o.v1_revision RETURNING a.v1_revision) SELECT COALESCE(sum(credit_bytes),0) bytes FROM obsolete`,
        [profileId],
      )
    ).rows[0].bytes,
  );
  if (revoked)
    await c.query(
      "UPDATE hub_profiles SET backup_v2_migration_credit=backup_v2_migration_credit-$2,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes-backup_v2_migration_credit+$2) WHERE id=$1",
      [profileId, revoked],
    );
}
async function queueBackupPrune(c: PoolClient, profileId: string) {
  await c.query(
    "INSERT INTO hub_backup_jobs(profile_id,kind,cursor) SELECT $1,'prune','{\"retention\":true}' WHERE NOT EXISTS(SELECT 1 FROM hub_backup_jobs WHERE profile_id=$1 AND kind='prune' AND status IN ('pending','running'))",
    [profileId],
  );
}
/** New catalog publication mutates <=32 new part refs and a constant-size root/head.
 * All namespace index, inherited refs, codecs and COW leaf work has committed before this lock. */
async function publishPreparedCatalogV1(
  o: { pool: Pool; encryptionKey: string },
  s: HubSession,
  id: string,
  signal: AbortSignal,
  m: BackupCheckpointV2,
  indexes: Map<string, IndexedBackupRecord[]>,
) {
  const tx = <T>(work: (c: PoolClient) => Promise<T>) =>
    withBackupTransaction(o.pool, signal, work);
  for (const n of m.namespaces) {
    const records = indexes.get(n.namespaceVersionId)!;
    for (let at = 0; at < records.length; at += 64)
      await tx(async (c) => {
        const cp = await checkpoint(c, s, id, true);
        if (cp.receipt) return;
        if (cp.status !== "prepared") throw conflict();
        await c.query(
          `INSERT INTO hub_backup_record_index(profile_id,namespace_version_id,record_id,store_name,store_epoch,operation,sha256,total_bytes,fragments) SELECT $1,$2,x.record_id,x.store_name,x.store_epoch,x.operation,x.sha256,x.total_bytes,x.fragments FROM jsonb_to_recordset($3::jsonb) x(record_id text,store_name text,store_epoch bigint,operation text,sha256 text,total_bytes integer,fragments jsonb) ON CONFLICT DO NOTHING`,
          [
            s.profileId,
            n.namespaceVersionId,
            JSON.stringify(
              records.slice(at, at + 64).map((r) => ({
                record_id: r.recordId,
                store_name: r.store,
                store_epoch: r.storeEpoch,
                operation: r.operation,
                sha256: r.sha256,
                total_bytes: r.totalBytes,
                fragments: r.fragments,
              })),
            ),
          ],
        );
      });
  }
  await prepareBackupCatalog(tx, s.profileId, id, resolvedCTE, signal);
  await tx(c=>stageReplacementProof(c,s.profileId,id));
  let acquiredAt = 0;
  const result = await tx(async (c) => {
    const lockStarted = performance.now();
    let p: any;
    try {
      p = await profile(c, s, o.encryptionKey, true);
    } finally {
      recordBackupDbTiming("accountLockWait", performance.now() - lockStarted);
    }
    acquiredAt = performance.now();
    requireBackupAccounting(p);
    const r = await replica(c, s, m.replicaId, true),
      cp = await checkpoint(c, s, id, true);
    if (cp.receipt) return cp.receipt;
    if (
      !cp.catalog_ready ||
      cp.status !== "prepared" ||
      cp.manifest_digest !== m.manifestDigest ||
      r.incarnation !== m.incarnation ||
      Number(r.head_sequence) + 1 !== m.sequence ||
      r.head_checkpoint_id !== m.parentCheckpointId
    )
      throw conflict();
    const pending = (
      await c.query(
        "SELECT r.hash,p.bytes,p.published_refs FROM hub_backup_checkpoint_parts r LEFT JOIN hub_backup_parts p USING(profile_id,hash) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND NOT r.ref_held ORDER BY r.hash LIMIT 33",
        [s.profileId, id],
      )
    ).rows;
    if (pending.length > 32 || pending.some((p) => p.bytes == null))
      throw new AppError(
        "BACKUP_INCOMPLETE",
        "The bounded prepared reference set is incomplete.",
        409,
      );
    const fresh = pending.filter((x) => Number(x.published_refs) === 0),
      added = fresh.reduce((n, x) => n + Number(x.bytes), 0);
    const allowance = await resolveProfilePolicy(c, s.userId);
    let shortened=false;
    const required=Number(p.backup_v1_canonical_bytes)+Math.max(0,Number(p.backup_v2_bytes)+added-Number(p.backup_v2_migration_credit))-allowance.profileBytes;
    const eligible = required>0 ? (
        await c.query(
          "SELECT 1 FROM hub_backup_checkpoints x JOIN hub_backup_replicas r USING(profile_id,replica_id) WHERE x.profile_id=$1 AND x.status='complete' AND x.checkpoint_id IS DISTINCT FROM r.head_checkpoint_id AND x.sequence<=r.adopted_through AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_pins pin WHERE pin.profile_id=x.profile_id AND pin.parent_checkpoint_id=x.checkpoint_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins reader WHERE reader.profile_id=x.profile_id AND reader.checkpoint_id=x.checkpoint_id AND reader.expires_at>now()) AND NOT EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=x.profile_id AND seed.seed_checkpoint_id=x.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL) LIMIT 1",
          [s.profileId],
        )
      ).rowCount : 0;
    if(required>0&&!eligible){const credited=await applyAtomicReplacementCredit(c,{profileId:s.profileId,replicaId:m.replicaId,candidate:cp,headId:r.head_checkpoint_id,adoptedThrough:Number(r.adopted_through),requiredBytes:required,migrationCredit:Number(p.backup_v2_migration_credit)});if(credited){shortened=true;p=await profile(c,s,o.encryptionKey);}}
    if (
      Number(p.backup_v1_canonical_bytes) +
        Math.max(
          0,
          Number(p.backup_v2_bytes) +
            added -
            Number(p.backup_v2_migration_credit),
        ) >
      allowance.profileBytes
    ) {
      if (eligible) {
        await queueBackupPrune(c, s.profileId);
        await c.query(
          "UPDATE hub_backup_jobs SET cursor=COALESCE(cursor,'{}'::jsonb)||jsonb_build_object('extraBytes',GREATEST(COALESCE((cursor->>'extraBytes')::bigint,0),$2::bigint),'allowanceBytes',$3::bigint) WHERE profile_id=$1 AND kind='prune' AND status='pending'",
          [s.profileId, added, allowance.profileBytes],
        );
        return { deferredForRetention: true };
      }
      throw new AppError(
        "BACKUP_QUOTA_EXCEEDED",
        "Protected cloud backups fill the account allowance. Local saves continue.",
        413,
      );
    }
    if (pending.length) {
      await c.query(
        "UPDATE hub_backup_parts SET published_refs=published_refs+1,ever_published=true WHERE profile_id=$1 AND hash=ANY($2::text[])",
        [s.profileId, pending.map((p) => p.hash)],
      );
      await c.query(
        "UPDATE hub_backup_checkpoint_parts SET ref_held=true WHERE profile_id=$1 AND checkpoint_id=$2 AND hash=ANY($3::text[])",
        [s.profileId, id, pending.map((p) => p.hash)],
      );
    }
    if (added)
      await c.query(
        "UPDATE hub_profiles SET backup_v2_bytes=backup_v2_bytes+$2,backup_v2_staging_bytes=backup_v2_staging_bytes-$2,backup_v2_staging_parts=backup_v2_staging_parts-$3,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes+$2-backup_v2_migration_credit) WHERE id=$1",
        [s.profileId, added, fresh.length],
      );
    const stamp = (
      await c.query(
        "SELECT nextval('hub_backup_publication_order')::text ordinal,clock_timestamp() completed",
      )
    ).rows[0];
    const receipt: BackupPublishReceiptV2 = {
      acknowledged: true,
      checkpointId: id,
      replicaId: m.replicaId,
      sequence: m.sequence,
      manifestDigest: m.manifestDigest,
      publicationOrdinal: stamp.ordinal,
      completedAt: stamp.completed.toISOString(),
      coverage: m.namespaces.map((n) => ({
        namespaceVersionId: n.namespaceVersionId,
        localCut: n.localCut,
      })),
      historyShortened: shortened,
    };
    await c.query(
      "UPDATE hub_backup_checkpoints SET status='complete',publication_ordinal=$3,completed_at=$4,history_day=($4::timestamptz AT TIME ZONE 'UTC')::date,receipt=$5 WHERE profile_id=$1 AND checkpoint_id=$2",
      [s.profileId, id, stamp.ordinal, stamp.completed, receipt],
    );
    await c.query(
      "UPDATE hub_backup_replicas SET head_checkpoint_id=$3,head_sequence=$4,updated_at=now() WHERE profile_id=$1 AND replica_id=$2",
      [s.profileId, m.replicaId, id, m.sequence],
    );
    await c.query(
      "DELETE FROM hub_backup_catalog_pins WHERE profile_id=$1 AND owner_checkpoint_id=$2",
      [s.profileId, id],
    );
    await c.query(
      "INSERT INTO hub_backup_jobs(profile_id,kind,namespace_version_id) SELECT v.profile_id,'rollup',v.namespace_version_id FROM hub_backup_namespace_versions v WHERE v.profile_id=$1 AND v.namespace_version_id=ANY($2::uuid[]) AND (v.depth>=8 OR v.delta_bytes>=1048576) AND NOT EXISTS(SELECT 1 FROM hub_backup_jobs j WHERE j.profile_id=v.profile_id AND j.namespace_version_id=v.namespace_version_id AND j.kind='rollup' AND j.status IN ('pending','running'))",
      [s.profileId, m.namespaces.map((n) => n.namespaceVersionId)],
    );
    await queueBackupPrune(c, s.profileId);
    return receipt;
  }).finally(() => {
    if (acquiredAt)
      recordBackupDbTiming(
        "accountLockThroughCommit",
        performance.now() - acquiredAt,
      );
  });
  if ("deferredForRetention" in result)
    throw new AppError(
      "BACKUP_BUSY",
      "Old eligible backup history is being released in bounded background work. Local saves continue.",
      503,
    );
  return result;
}

/** Release <=64 prepared/retired references per independently committed GC slice. */
async function releaseCatalogReferences(c: PoolClient, profileId: string) {
  const cp = (
    await c.query(
      "SELECT checkpoint_id FROM hub_backup_checkpoints WHERE profile_id=$1 AND catalog_version=1 AND status IN ('retired','expired') AND NOT catalog_released AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=hub_backup_checkpoints.profile_id AND pin.checkpoint_id=hub_backup_checkpoints.checkpoint_id AND pin.expires_at>now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      [profileId],
    )
  ).rows[0];
  if (!cp) return false;
  const held = (
    await c.query(
      "SELECT hash FROM hub_backup_checkpoint_parts WHERE profile_id=$1 AND checkpoint_id=$2 AND ref_held ORDER BY hash LIMIT 64",
      [profileId, cp.checkpoint_id],
    )
  ).rows.map((x) => x.hash);
  if (held.length) {
    const rows = (
      await c.query(
        "UPDATE hub_backup_parts SET published_refs=published_refs-1,ever_published=true,gc_eligible_at=CASE WHEN published_refs=1 THEN now() ELSE gc_eligible_at END WHERE profile_id=$1 AND hash=ANY($2::text[]) AND published_refs>0 RETURNING bytes,published_refs",
        [profileId, held],
      )
    ).rows;
    await c.query(
      "UPDATE hub_backup_checkpoint_parts SET ref_held=false WHERE profile_id=$1 AND checkpoint_id=$2 AND hash=ANY($3::text[])",
      [profileId, cp.checkpoint_id, held],
    );
    const zero = rows.filter((r) => Number(r.published_refs) === 0),
      released = zero.reduce((n, r) => n + Number(r.bytes), 0);
    if (released)
      await c.query(
        "UPDATE hub_profiles SET backup_v2_bytes=backup_v2_bytes-$2,backup_v2_staging_bytes=backup_v2_staging_bytes+$2,backup_v2_staging_parts=backup_v2_staging_parts+$3,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes-$2-backup_v2_migration_credit) WHERE id=$1",
        [profileId, released, zero.length],
      );
  }
  if (
    !(
      await c.query(
        "SELECT 1 FROM hub_backup_checkpoint_parts WHERE profile_id=$1 AND checkpoint_id=$2 AND ref_held LIMIT 1",
        [profileId, cp.checkpoint_id],
      )
    ).rowCount
  ) {
    await c.query(
      "UPDATE hub_backup_checkpoints SET catalog_released=true WHERE profile_id=$1 AND checkpoint_id=$2",
      [profileId, cp.checkpoint_id],
    );
    await c.query(
      "DELETE FROM hub_backup_catalog_pins WHERE profile_id=$1 AND owner_checkpoint_id=$2",
      [profileId, cp.checkpoint_id],
    );
  }
  return true;
}

async function processBackupPrune(c: PoolClient, profileId: string) {
  const job = (
    await c.query(
      "SELECT * FROM hub_backup_jobs WHERE profile_id=$1 AND kind='prune' AND status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      [profileId],
    )
  ).rows[0];
  if (!job) return false;
  const normal = (
    await c.query(
      `WITH ranked AS(SELECT x.checkpoint_id,x.replica_id,x.sequence,x.history_day,x.publication_ordinal,r.head_checkpoint_id,r.adopted_through,r.deleted_at,row_number() OVER(PARTITION BY x.replica_id,x.history_day ORDER BY x.publication_ordinal DESC) day_rank,dense_rank() OVER(PARTITION BY x.replica_id ORDER BY x.history_day DESC) day_number FROM hub_backup_checkpoints x JOIN hub_backup_replicas r USING(profile_id,replica_id) WHERE x.profile_id=$1 AND x.status='complete') SELECT x.checkpoint_id FROM ranked x WHERE (x.deleted_at IS NOT NULL OR (x.checkpoint_id IS DISTINCT FROM x.head_checkpoint_id AND x.sequence<=x.adopted_through AND (x.day_rank>1 OR x.day_number>8))) AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_pins pin WHERE pin.profile_id=$1 AND pin.parent_checkpoint_id=x.checkpoint_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins reader WHERE reader.profile_id=$1 AND reader.checkpoint_id=x.checkpoint_id AND reader.expires_at>now()) AND NOT EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=$1 AND seed.seed_checkpoint_id=x.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL) ORDER BY x.publication_ordinal LIMIT 1`,
      [profileId],
    )
  ).rows[0];
  if (normal) {
    await retire(c, profileId, normal.checkpoint_id);
    return true;
  }
  if (job.cursor?.extraBytes) {
    const p = (
      await c.query("SELECT * FROM hub_profiles WHERE id=$1", [profileId])
    ).rows[0];
    const charge =
      Number(p.backup_v1_canonical_bytes) +
      Math.max(
        0,
        Number(p.backup_v2_bytes) +
          Number(job.cursor.extraBytes) -
          Number(p.backup_v2_migration_credit),
      );
    if (charge > Number(job.cursor.allowanceBytes)) {
      const victim = (
        await c.query(
          "SELECT x.checkpoint_id FROM hub_backup_checkpoints x JOIN hub_backup_replicas r USING(profile_id,replica_id) WHERE x.profile_id=$1 AND x.status='complete' AND x.checkpoint_id IS DISTINCT FROM r.head_checkpoint_id AND x.sequence<=r.adopted_through AND NOT EXISTS(SELECT 1 FROM hub_backup_catalog_pins pin WHERE pin.profile_id=x.profile_id AND pin.parent_checkpoint_id=x.checkpoint_id) AND NOT EXISTS(SELECT 1 FROM hub_backup_restore_pins reader WHERE reader.profile_id=x.profile_id AND reader.checkpoint_id=x.checkpoint_id AND reader.expires_at>now()) AND NOT EXISTS(SELECT 1 FROM hub_backup_replicas seed WHERE seed.profile_id=x.profile_id AND seed.seed_checkpoint_id=x.checkpoint_id AND seed.head_checkpoint_id IS NULL AND seed.deleted_at IS NULL) ORDER BY x.publication_ordinal LIMIT 1",
          [profileId],
        )
      ).rows[0];
      if (victim) {
        await retire(c, profileId, victim.checkpoint_id);
        return true;
      }
      if (
        (
          await c.query(
            "SELECT 1 FROM hub_backup_checkpoints WHERE profile_id=$1 AND catalog_version=1 AND status IN ('retired','expired') AND NOT catalog_released LIMIT 1",
            [profileId],
          )
        ).rowCount
      )
        return true;
    }
  }
  await c.query(
    "UPDATE hub_backup_jobs SET status='complete',updated_at=now() WHERE id=$1",
    [job.id],
  );
  await c.query("DELETE FROM hub_backup_jobs job WHERE job.profile_id=$1 AND job.id IN(SELECT j.id FROM hub_backup_jobs j WHERE j.profile_id=$1 AND j.id<>$2 AND j.status='complete' AND j.kind IN ('rollup','prune','reconcile') AND NOT EXISTS(SELECT 1 FROM hub_backup_rollup_sources pin WHERE pin.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM hub_backup_rollup_epochs e WHERE e.job_id=j.id) ORDER BY j.created_at,j.id LIMIT 32)",[profileId,job.id]);
  return true;
}
