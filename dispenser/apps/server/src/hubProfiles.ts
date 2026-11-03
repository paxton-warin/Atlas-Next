/** Encrypted account profile authority. Remote acknowledgement follows COMMIT.
 * Local browser transactions are a separate durability tier; offline writers
 * must never replay across a newer fencing epoch without explicit resolution. */
import { createHash } from "node:crypto";
import { registerLegacyProfileWriteRetirement } from "./hubLegacyProfileRetirement.js";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  HUB_LIMITS,
  hubNamespace,
  decodePortableValue,
  encodePortableValue,
  type HubNamespace,
} from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import {
  publishProfileWritersChanged,
  registerProfileWriterEventRoute,
} from "./hubProfileEvents.js";
import {
  initializeStreamBudgets,
  streamRestoreBytes,
} from "./hubStreamBudget.js";
import { decrypt, encrypt } from "./security.js";
import {
  resolveProfilePolicy,
  PROFILE_CHUNK_GRACE_MS,
  profileWireLimits,
  initializeChunkAccounting,
  finishProfileAccounting,
  replaceChunkReferences,
  clearCommitChunkReferences,
} from "./hubProfilePolicy.js";
import {
  hubObject,
  hubToken,
  hubUUID,
  type HubIdentity,
  type HubSession,
} from "./hubIdentity.js";
const digest = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const invalid = (message = "Invalid profile request.") =>
  new AppError("HUB_INVALID", message);
const conflict = (
  message = "Profile changed. Restore its current revision before writing.",
) => new AppError("HUB_CONFLICT", message, 409);
function number(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw invalid("A non-negative revision is required.");
  return Number(v);
}
function namespace(v: unknown) {
  try {
    return hubNamespace(hubObject(v) as HubNamespace);
  } catch {
    throw invalid("Invalid logical website namespace.");
  }
}
export function registerHubProfileRoutes(
  app: FastifyInstance,
  o: { pool: Pool; identity: HubIdentity; encryptionKey: string },
) {
  const { pool, identity } = o;
  registerLegacyProfileWriteRetirement(app);
  registerProfileWriterEventRoute(app, pool, (req) =>
    identity.authenticate(req),
  );
  async function changed(c: PoolClient, profileId: string, row: any) {
    if (!row?.session_id || !row?.context_id) return;
    await publishProfileWritersChanged(c, {
      profileId,
      sessionId: row.session_id,
      contextId: row.context_id,
    });
  }
  async function wakeRequesters(
    c: PoolClient,
    profileId: string,
    siteGroup: string,
  ) {
    const recipients = (
      await c.query(
        "SELECT DISTINCT requester_session AS session_id,requester_context AS context_id FROM hub_writer_handoffs WHERE profile_id=$1 AND site_group=$2 AND status IN ('waiting','ready') AND expires_at>now()",
        [profileId, siteGroup],
      )
    ).rows;
    for (const recipient of recipients) await changed(c, profileId, recipient);
  }
  async function locked<T>(
    session: HubSession,
    run: (c: PoolClient, p: any, key: string) => Promise<T>,
  ) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const p = (
        await c.query(
          "SELECT * FROM hub_profiles WHERE id=$1 AND user_id=$2 FOR NO KEY UPDATE",
          [session.profileId, session.userId],
        )
      ).rows[0];
      if (!p)
        throw new AppError("HUB_SESSION_EXPIRED", "Profile unavailable.", 401);
      const key = decrypt(p.encrypted_key, o.encryptionKey);
      // Account revision and aggregate quota remain serialized. Non-key row
      // updates do not block the independent website writer metadata below.
      p.policy = await resolveProfilePolicy(c, session.userId);
      const before = await initializeChunkAccounting(c, p, key);
      await initializeStreamBudgets(c, p.id, key);
      // Upload garbage collection runs on its reserved maintenance pool, never a foreground profile request.
      const result = await run(c, p, key);
      if (before) await finishProfileAccounting(
        c,
        p,
        p.policy,
        before.canonicalBytes,
        before.stagingBytes,
        before.stagingChunks,
      );
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  /** Writer metadata is site-group scoped, not account-accounting work.
   * KEY SHARE keeps deletion/reset exclusive without blocking non-key quota
   * updates. The advisory lock also covers first acquisition (no writer row),
   * and every existing writer row stays locked through COMMIT. Lock order is
   * profile -> site group -> handoff/writer rows; no network I/O runs here. */
  async function metadataLocked<T>(
    session: HubSession,
    group: string | ((c: PoolClient) => Promise<string>),
    run: (c: PoolClient) => Promise<T>,
  ) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const p = (await c.query(
        "SELECT id FROM hub_profiles WHERE id=$1 AND user_id=$2 FOR KEY SHARE",
        [session.profileId, session.userId],
      )).rows[0];
      if (!p) throw new AppError("HUB_SESSION_EXPIRED", "Profile unavailable.", 401);
      const siteGroup = typeof group === "string" ? group : await group(c);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "atlas-profile-writer:" + JSON.stringify([session.profileId, siteGroup]),
      ]);
      const result = await run(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally { c.release(); }
  }
    // Reads use a consistent MVCC snapshot, not the profile write/accounting
    // transaction. All mutations retain locked(), quota checks and fencing.
    async function readProfile<T>(session: HubSession, run: (c: PoolClient, p: any, key: string) => Promise<T>): Promise<T> {
        const c = await pool.connect();
        let needsMigration = false;
        try {
            await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const p = (await c.query("SELECT p.*,EXISTS(SELECT 1 FROM hub_streams s WHERE s.profile_id=p.id AND s.restore_bytes IS NULL) AS needs_budget FROM hub_profiles p WHERE p.id=$1 AND p.user_id=$2", [session.profileId, session.userId])).rows[0];
            if (!p) throw new AppError("HUB_SESSION_EXPIRED", "Profile unavailable.", 401);
            needsMigration = Number(p.chunk_accounting_version) !== 1 || p.needs_budget;
            if (needsMigration) {
                await c.query("ROLLBACK");
            } else {
                const key = decrypt(p.encrypted_key, o.encryptionKey);
                p.policy = await resolveProfilePolicy(c, session.userId);
                const result = await run(c, p, key);
                await c.query("COMMIT");
                return result;
            }
        } catch (e) {
            await c.query("ROLLBACK");
            throw e;
        } finally {
            c.release();
        }
        // Release the read connection BEFORE migration acquires the write lock.
        return locked(session, run);
    }
  async function writer(
    c: PoolClient,
    s: HubSession,
    group: string,
    epoch: unknown,
    lock: "share" | "update" = "share",
  ) {
    const row = (
      await c.query(
        // Transaction-start now() can predate a long row-lock wait. Expiry
        // must be checked against wall time after accounting admission.
        "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2 AND expires_at>clock_timestamp() FOR " + (lock === "update" ? "UPDATE" : "SHARE"),
        [s.profileId, group],
      )
    ).rows[0];
    if (
      !row ||
      row.session_id !== s.sessionId ||
      row.context_id !== s.contextId ||
      Number(row.epoch) !== number(epoch)
    )
      throw new AppError(
        "HUB_WRITER_LOST",
        "This website is active in another context or its writer lease expired.",
        409,
      );
    return row;
  }
  function wireWriter(row: any) {
    return {
      siteGroup: row.site_group,
      contextId: row.context_id,
      epoch: Number(row.epoch),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
  async function payload(
    c: PoolClient,
    s: HubSession,
    key: string,
    value: unknown,
  ) {
    const data = hubObject(value);
    let graph = data;
    let encoded = JSON.stringify(data);
    if (data.codec === "atlas-chunks-v1") {
      if (
        !Array.isArray(data.hashes) ||
        !data.hashes.length ||
        data.hashes.length > 64 ||
        data.hashes.some(
          (x: unknown) => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x),
        )
      )
        throw invalid("Invalid chunk manifest.");
      const parts: Buffer[] = [];
      let bytes = 0;
      for (const h of data.hashes) {
        const row = (
          await c.query(
            "SELECT encrypted_payload,bytes FROM hub_chunks WHERE profile_id=$1 AND hash=$2",
            [s.profileId, h],
          )
        ).rows[0];
        if (!row)
          throw conflict("Upload every referenced chunk before committing.");
        const b = Buffer.from(decrypt(row.encrypted_payload, key), "base64");
        bytes += b.length;
        if (bytes > HUB_LIMITS.streamBytes || bytes !== bytes)
          throw invalid("Namespace payload exceeds its allowance.");
        parts.push(b);
      }
      const b = Buffer.concat(parts);
      if (data.bytes !== bytes || data.sha256 !== digest(b))
        throw invalid("Chunk manifest integrity mismatch.");
      try {
        graph = JSON.parse(b.toString("utf8"));
      } catch {
        throw invalid("Chunk payload must be a portable graph.");
      }
    }
    let decoded;
    try {
      decoded = decodePortableValue(graph as any);
    } catch {
      throw invalid("Profile contains a non-portable or invalid value.");
    }
    if (Buffer.byteLength(encoded) > 1_000_000)
      throw invalid("Use chunk uploads for large profile values.");
    return {
      encoded,
      bytes: Buffer.byteLength(encoded),
      restoreBytes: streamRestoreBytes(encoded),
      hash: digest(encoded),
      decoded,
    };
  }
  app.get("/api/hub/branch/profile", async (req) => {
    const s = await identity.authenticate(req);
    return readProfile(s, async (c, p) => ({
      protocol: 1,
      profileId: p.id,
      initialized: p.initialized,
      revision: Number(p.revision),
      bytes: Number(p.bytes),
      limits: profileWireLimits(p.policy),
      streams: (
        await c.query(
          'SELECT namespace,revision,snapshot_revision AS "snapshotRevision",updated_at AS "updatedAt" FROM hub_streams WHERE profile_id=$1 ORDER BY namespace',
          [p.id],
        )
      ).rows.map((r) => ({
        ...r,
        namespace: JSON.parse(r.namespace),
        revision: Number(r.revision),
        snapshotRevision: Number(r.snapshotRevision),
      })),
      writers: (
        await c.query(
          "SELECT * FROM hub_writers WHERE profile_id=$1 AND expires_at>now()",
          [p.id],
        )
      ).rows.map(wireWriter),
    }));
  });
  app.post("/api/hub/branch/profile/stream", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body),
      n = namespace(v.namespace);
    return readProfile(s, async (c, _p, key) => {
      const stream = (
        await c.query(
          "SELECT * FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
          [s.profileId, n.key],
        )
      ).rows[0];
      if (v.headOnly !== undefined && typeof v.headOnly !== "boolean")
        throw invalid("Invalid stream metadata request.");
      if (!stream && v.headOnly === true)
        return { revision: 0, snapshotRevision: 0, restoreBytes: 0, snapshotBytes: 0 };
      if (!stream)
        return {
          revision: 0,
          snapshotRevision: 0,
          snapshot: null,
          journal: [],
          hasMore: false,
          nextAfter: 0,
        };
      if (v.headOnly === true)
        return {
          revision: Number(stream.revision),
          snapshotRevision: Number(stream.snapshot_revision),
          restoreBytes: Number(stream.restore_bytes),
          snapshotBytes: stream.encrypted_payload ? streamRestoreBytes(decrypt(stream.encrypted_payload, key)) : 0,
        };
      const pinned =
        v.targetRevision !== undefined || v.snapshotRevision !== undefined;
      if (
        pinned &&
        (v.after === undefined ||
          v.targetRevision === undefined ||
          v.snapshotRevision === undefined)
      )
        throw invalid(
          "Journal pages require the target and checkpoint revisions.",
        );
      const target = pinned
        ? number(v.targetRevision)
        : Number(stream.revision);
      if (
        pinned &&
        number(v.snapshotRevision) !== Number(stream.snapshot_revision)
      )
        throw conflict(
          "The checkpoint changed during restore. Start hydration again.",
        );
      if (
        target > Number(stream.revision) ||
        target < Number(stream.snapshot_revision)
      )
        throw conflict("The requested restore revision is unavailable.");
      const after =
        v.after === undefined
          ? Number(stream.snapshot_revision)
          : number(v.after);
      if (after < Number(stream.snapshot_revision))
        throw conflict("A newer checkpoint requires hydration.");
      if (after > target)
        throw invalid("Journal cursor exceeds its pinned target.");
      const rows = (
        await c.query(
          "SELECT revision,mode,encrypted_payload FROM hub_commits WHERE profile_id=$1 AND namespace=$2 AND revision>$3 AND revision<=$4 AND encrypted_payload IS NOT NULL ORDER BY revision LIMIT 501",
          [s.profileId, n.key, after, target],
        )
      ).rows;
      const page = rows.slice(0, 500),
        hasMore = rows.length > page.length;
      let nextAfter = after;
      for (const row of page) {
        if (Number(row.revision) !== nextAfter + 1)
          throw conflict(
            "The saved journal is incomplete. Restore a verified checkpoint.",
          );
        nextAfter = Number(row.revision);
      }
      if (!hasMore && nextAfter !== target)
        throw conflict(
          "The saved journal is incomplete. Restore a verified checkpoint.",
        );
      return {
        revision: target,
        snapshotRevision: Number(stream.snapshot_revision),
        snapshot:
          v.after === undefined && stream.encrypted_payload
            ? JSON.parse(decrypt(stream.encrypted_payload, key))
            : null,
        journal: page.map((r) => ({
          revision: Number(r.revision),
          mode: r.mode,
          payload: JSON.parse(decrypt(r.encrypted_payload, key)),
        })),
        hasMore,
        nextAfter,
      };
    });
  });
  app.post("/api/hub/branch/profile/writers", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body),
      n = namespace(v.namespace);
    if (v.takeover !== undefined && typeof v.takeover !== "boolean")
      throw invalid();
    if (v.useLatestBackup !== undefined && typeof v.useLatestBackup !== "boolean")
      throw invalid();
    if (v.useLatestBackup === true && !v.handoffId)
      throw invalid("A matching website handoff is required to use its last saved version.");
    return metadataLocked(s, n.siteGroup, async (c) => {
      const row = (
        await c.query(
          "SELECT *,expires_at>clock_timestamp() live FROM hub_writers WHERE profile_id=$1 AND site_group=$2 FOR UPDATE",
          [s.profileId, n.siteGroup],
        )
      ).rows[0];
      const same =
        row?.session_id === s.sessionId && row?.context_id === s.contextId;
      let approved = false;
      if (v.handoffId) {
        const h = (
          await c.query(
            "SELECT *,expires_at>clock_timestamp() live FROM hub_writer_handoffs WHERE id=$1 AND profile_id=$2 AND site_group=$3 AND requester_session=$4 AND requester_context=$5 FOR UPDATE",
            [
              hubUUID(v.handoffId),
              s.profileId,
              n.siteGroup,
              s.sessionId,
              s.contextId,
            ],
          )
        ).rows[0];
        const ownerEpoch = Number(h?.owner_epoch),
          currentEpoch = Number(row?.epoch);
        const exactEpochs = Number.isSafeInteger(ownerEpoch) && ownerEpoch > 0 && ownerEpoch < Number.MAX_SAFE_INTEGER &&
          Number.isSafeInteger(currentEpoch) && currentEpoch > 0;
        // A confirmed last-backup choice may skip the old browser's flush, but
        // only for its exact pending handoff. It never acknowledges an upload
        // or changes the last committed website data. A lost success response
        // may replay only while this same requester still owns the exact epoch
        // produced by consuming this handoff; a later owner always wins.
        if (v.useLatestBackup === true && h?.status === "used") {
          if (!same || !exactEpochs || currentEpoch !== ownerEpoch + 1)
            throw conflict("This handoff was already replaced. Request a new handoff.");
          const replay = (
            await c.query(
              "UPDATE hub_writers SET expires_at=clock_timestamp()+interval '90 seconds' WHERE profile_id=$1 AND site_group=$2 AND session_id=$3 AND context_id=$4 AND epoch=$5 RETURNING *",
              [s.profileId, n.siteGroup, s.sessionId, s.contextId, row.epoch],
            )
          ).rows[0];
          return { writer: wireWriter(replay), takeover: true };
        }
        approved = !!h && h.live &&
          (h.status === "ready" || (v.useLatestBackup === true && h.status === "waiting")) &&
          h.owner_context === row?.context_id &&
          exactEpochs && ownerEpoch === currentEpoch;
        if (!approved)
          throw conflict("The previous browser has not finished saving yet.");
        await c.query(
          "UPDATE hub_writer_handoffs SET status='used' WHERE id=$1",
          [h.id],
        );
      }
      if (row?.live && !same && !approved)
        throw new AppError(
          "HUB_WRITER_BUSY",
          "This website is open in another browser context.",
          409,
        );
      const epoch = row ? Number(row.epoch) + (same && row.live ? 0 : 1) : 1;
      const next = (
        await c.query(
          "INSERT INTO hub_writers(profile_id,site_group,session_id,context_id,epoch,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '90 seconds') ON CONFLICT(profile_id,site_group) DO UPDATE SET session_id=excluded.session_id,context_id=excluded.context_id,epoch=excluded.epoch,expires_at=excluded.expires_at RETURNING *",
          [s.profileId, n.siteGroup, s.sessionId, s.contextId, epoch],
        )
      ).rows[0];
      if (row && !same) await changed(c, s.profileId, row);
      if (!same) await wakeRequesters(c, s.profileId, n.siteGroup);
      return { writer: wireWriter(next), takeover: !!row && !same };
    });
  });
  app.post("/api/hub/branch/profile/writers/takeover", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body),
      n = namespace(v.namespace);
    return metadataLocked(s, n.siteGroup, async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2 AND expires_at>clock_timestamp() FOR UPDATE",
          [s.profileId, n.siteGroup],
        )
      ).rows[0];
      if (
        !row ||
        (row.context_id === s.contextId && row.session_id === s.sessionId)
      )
        return { available: true };
      const prior = (
        await c.query(
          "SELECT id,status FROM hub_writer_handoffs WHERE profile_id=$1 AND site_group=$2 AND owner_epoch=$3 AND requester_session=$4 AND status!='used' AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1",
          [s.profileId, n.siteGroup, row.epoch, s.sessionId],
        )
      ).rows[0];
      if (prior) return { handoffId: prior.id, status: prior.status };
      const h = (
        await c.query(
          "INSERT INTO hub_writer_handoffs(profile_id,site_group,owner_context,owner_epoch,requester_session,requester_context) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            s.profileId,
            n.siteGroup,
            row.context_id,
            row.epoch,
            s.sessionId,
            s.contextId,
          ],
        )
      ).rows[0];
      await changed(c, s.profileId, row);
      return { handoffId: h.id, status: "waiting" };
    });
  });
  app.get("/api/hub/branch/profile/writers/requests", async (req) => {
    const s = await identity.authenticate(req);
    return {
      requests: (
        await pool.query(
          "SELECT h.id,h.site_group AS \"siteGroup\",h.owner_epoch AS epoch FROM hub_writer_handoffs h JOIN hub_writers w ON w.profile_id=h.profile_id AND w.site_group=h.site_group AND w.epoch=h.owner_epoch AND w.context_id=h.owner_context WHERE h.profile_id=$1 AND h.owner_context=$2 AND w.session_id=$3 AND h.status='waiting' AND h.expires_at>clock_timestamp() AND w.expires_at>clock_timestamp()",
          [s.profileId, s.contextId, s.sessionId],
        )
      ).rows.map((r) => ({ ...r, epoch: Number(r.epoch) })),
    };
  });
  app.post<{ Params: { id: string } }>(
    "/api/hub/branch/profile/writers/requests/:id/ack",
    async (req) => {
      const s = await identity.authenticate(req),
        v = hubObject(req.body);
      if (v.flushed !== true)
        throw invalid("Finish saving before handing off this website.");
      return metadataLocked(s, async (c) => {
        // The immutable group lookup takes no handoff row lock. Resolve it
        // before the group lock; then re-read the authorized handoff below.
        const h = (await c.query(
          "SELECT site_group FROM hub_writer_handoffs WHERE id=$1 AND profile_id=$2 AND owner_context=$3",
          [hubUUID(req.params.id), s.profileId, s.contextId],
        )).rows[0];
        if (!h) throw conflict();
        return h.site_group;
      }, async (c) => {
        const h = (
          await c.query(
            "SELECT *,expires_at<=clock_timestamp() AS expired FROM hub_writer_handoffs WHERE id=$1 AND profile_id=$2 AND owner_context=$3 FOR UPDATE",
            [hubUUID(req.params.id), s.profileId, s.contextId],
          )
        ).rows[0];
        if (!h) throw conflict();
        // A successful ACK response can be lost. Repeating that exact owned
        // handoff must not touch the requester's subsequently acquired writer.
        if (h.status === "ready" || h.status === "used")
          return { acknowledged: true };
        if (h.expired)
          throw new AppError(
            "HUB_HANDOFF_EXPIRED",
            "This handoff expired. Your local saves are retained. Continue here to try again.",
            409,
          );
        await writer(c, s, h.site_group, Number(h.owner_epoch), "update");
        await c.query(
          "UPDATE hub_writer_handoffs SET status='ready' WHERE id=$1",
          [h.id],
        );
        // Keep the fence alive until the requester atomically acquires its epoch.
        await c.query(
          "UPDATE hub_writers SET expires_at=clock_timestamp()+interval '2 minutes' WHERE profile_id=$1 AND site_group=$2",
          [s.profileId, h.site_group],
        );
        await publishProfileWritersChanged(c, {
          profileId: s.profileId,
          sessionId: h.requester_session,
          contextId: h.requester_context,
        });
        return { acknowledged: true };
      });
    },
  );
  app.put("/api/hub/branch/profile/writers", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body),
      n = namespace(v.namespace);
    return metadataLocked(s, n.siteGroup, async (c) => {
      // Only the exact authorized owner can renew an expired, unsuperseded
      // epoch after a cloud-only outage. Commit still requires a live lease.
      const row = (
        await c.query(
          "UPDATE hub_writers SET expires_at=clock_timestamp()+interval '90 seconds' WHERE profile_id=$1 AND site_group=$2 AND session_id=$3 AND context_id=$4 AND epoch=$5 RETURNING *",
          [s.profileId, n.siteGroup, s.sessionId, s.contextId, number(v.epoch)],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          "HUB_WRITER_LOST",
          "This website writer was replaced. Your local saves are retained.",
          409,
        );
      return { writer: wireWriter(row) };
    });
  });
  app.delete("/api/hub/branch/profile/writers", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body),
      n = namespace(v.namespace);
    return metadataLocked(s, n.siteGroup, async (c) => {
      await writer(c, s, n.siteGroup, v.epoch, "update");
      await c.query(
        "UPDATE hub_writers SET expires_at=clock_timestamp() WHERE profile_id=$1 AND site_group=$2",
        [s.profileId, n.siteGroup],
      );
      await wakeRequesters(c, s.profileId, n.siteGroup);
      return { ok: true };
    });
  });
  app.get<{ Params: { id: string } }>(
    "/api/hub/branch/profile/receipts/:id",
    async (req) => {
      const session = await identity.authenticate(req),
        id = hubToken(req.params.id, 16, 96);
      const row = (
        await pool.query(
          "SELECT namespace,revision,profile_revision,payload_hash,mode FROM hub_commits WHERE profile_id=$1 AND idempotency_key=$2",
          [session.profileId, id],
        )
      ).rows[0];
      if (!row)
        throw new AppError("HUB_NOT_FOUND", "Commit receipt not found.", 404);
      return {
        namespace: JSON.parse(row.namespace),
        revision: Number(row.revision),
        profileRevision: Number(row.profile_revision),
        payloadHash: row.payload_hash,
        mode: row.mode,
        acknowledged: true,
      };
    },
  );
  app.post("/api/hub/branch/profile/commits", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body),
      n = namespace(v.namespace),
      id = hubToken(v.idempotencyKey, 16, 96),
      base = number(v.baseRevision);
    if (v.mode !== "snapshot" && v.mode !== "journal")
      throw invalid("Commit mode required.");
    return locked(s, async (c, p, key) => {
      // Replayed acknowledgements need only the immutable wire hash: expired
      // unreferenced chunks must not invalidate an already committed receipt.
      const hash = digest(
        JSON.stringify([
          n.key,
          v.mode,
          base,
          digest(JSON.stringify(hubObject(v.payload))),
        ]),
      );
      const prior = (
        await c.query(
          "SELECT * FROM hub_commits WHERE profile_id=$1 AND idempotency_key=$2",
          [s.profileId, id],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash || prior.namespace !== n.key)
          throw conflict("Idempotency key was used for different data.");
        return {
          revision: Number(prior.revision),
          profileRevision: Number(prior.profile_revision),
          acknowledged: true,
          replayed: true,
        };
      }
      const value = await payload(c, s, key, v.payload);
      await writer(c, s, n.siteGroup, v.epoch);
      if (
        (
          await c.query(
            "SELECT 1 FROM hub_imports WHERE profile_id=$1 AND status='reserved' AND expires_at>now()",
            [s.profileId],
          )
        ).rowCount
      )
        throw conflict("Finish or cancel initial import before saving.");
      const old = (
        await c.query(
          "SELECT * FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
          [s.profileId, n.key],
        )
      ).rows[0];
      if (Number(old?.revision || 0) !== base) throw conflict();
      const nextStreamBytes =
        v.mode === "snapshot"
          ? value.bytes
          : Number(old?.bytes || 0) + value.bytes;
      const nextRestoreBytes =
        v.mode === "snapshot"
          ? value.restoreBytes
          : Number(old?.restore_bytes || 0) + value.restoreBytes;
      if (
        nextRestoreBytes > HUB_LIMITS.streamBytes &&
        nextRestoreBytes > Number(old?.restore_bytes || 0)
      )
        throw new AppError(
          "HUB_QUOTA",
          "This website backup reached its restore allowance. Your local saves are retained.",
          413,
        );
      const addedBytes = nextStreamBytes - Number(old?.bytes || 0);
      if (nextStreamBytes > HUB_LIMITS.streamBytes)
        throw new AppError("HUB_QUOTA", "Account backup quota exceeded.", 413);
      const rev = base + 1,
        profileRev = Number(p.revision) + 1,
        encrypted = encrypt(value.encoded, key);
      await c.query(
        "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes,restore_bytes) VALUES($1,$2,$3,$4,$5,$6,$8) ON CONFLICT(profile_id,namespace) DO UPDATE SET revision=excluded.revision,snapshot_revision=CASE WHEN $7 THEN excluded.snapshot_revision ELSE hub_streams.snapshot_revision END,encrypted_payload=CASE WHEN $7 THEN excluded.encrypted_payload ELSE hub_streams.encrypted_payload END,bytes=CASE WHEN $7 THEN excluded.bytes ELSE hub_streams.bytes+excluded.bytes END,restore_bytes=excluded.restore_bytes,updated_at=now()",
        [
          s.profileId,
          n.key,
          rev,
          v.mode === "snapshot" ? rev : 0,
          v.mode === "snapshot" ? encrypted : null,
          value.bytes,
          v.mode === "snapshot",
          nextRestoreBytes,
        ],
      );
      if (v.mode === "snapshot") {
        await clearCommitChunkReferences(c, s.profileId, n.key);
        await replaceChunkReferences(
          c,
          s.profileId,
          "stream",
          n.key,
          v.payload,
        );
        await c.query(
          "UPDATE hub_commits SET encrypted_payload=NULL,bytes=0 WHERE profile_id=$1 AND namespace=$2",
          [s.profileId, n.key],
        );
      }
      await c.query(
        "INSERT INTO hub_commits(profile_id,idempotency_key,namespace,payload_hash,mode,encrypted_payload,bytes,revision,profile_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          s.profileId,
          id,
          n.key,
          hash,
          v.mode,
          v.mode === "journal" ? encrypted : null,
          v.mode === "journal" ? value.bytes : 0,
          rev,
          profileRev,
        ],
      );
      if (v.mode === "journal") await replaceChunkReferences(c, s.profileId, "commit", id, v.payload);
      await c.query(
        "UPDATE hub_profiles SET initialized=true,revision=$2,bytes=bytes+$3 WHERE id=$1",
        [s.profileId, profileRev, addedBytes],
      );
      return {
        revision: rev,
        profileRevision: profileRev,
        acknowledged: true,
        replayed: false,
      };
    });
  });
  app.post(
    "/api/hub/branch/profile/chunks",
    { bodyLimit: 6_000_000 },
    async (req) => {
      const s = await identity.authenticate(req),
        v = hubObject(req.body);
      if (
        typeof v.data !== "string" ||
        v.data.length > Math.ceil((HUB_LIMITS.chunkBytes * 4) / 3) + 4 ||
        v.data.length % 4 !== 0
      )
        throw invalid("Invalid binary chunk.");
      const b = Buffer.from(v.data, "base64");
      // Canonical roundtrip is linear and rejects ignored/incorrect padding.
      // A nested quantified regexp over a4MiB chunk can exhaust V8's stack.
      if (b.toString("base64") !== v.data)
        throw invalid("Invalid binary chunk.");
      if (!b.length || b.length > HUB_LIMITS.chunkBytes || v.hash !== digest(b))
        throw invalid("Chunk integrity mismatch.");
      return locked(s, async (c, p, key) => {
        const exists = (
          await c.query(
            "SELECT 1 FROM hub_chunks WHERE profile_id=$1 AND hash=$2",
            [s.profileId, v.hash],
          )
        ).rowCount;
        if (!exists) {
          await c.query(
            "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,$4)",
            [s.profileId, v.hash, encrypt(v.data, key), b.length],
          );
        }
        return { hash: v.hash, bytes: b.length, acknowledged: true };
      });
    },
  );
  app.get<{ Params: { hash: string } }>(
    "/api/hub/branch/profile/chunks/:hash",
    async (req) => {
      const s = await identity.authenticate(req);
      if (!/^[a-f0-9]{64}$/.test(req.params.hash)) throw invalid();
      return readProfile(s, async (c, _p, key) => {
        const r = (
          await c.query(
            // Reads do not perform collection. Keep the historical not-found
            // result for expired unreferenced staging chunks; live references
            // remain readable regardless of age and periodic GC reclaims bytes.
            "SELECT c.encrypted_payload,c.bytes FROM hub_chunks c WHERE c.profile_id=$1 AND c.hash=$2 AND (c.created_at>=$3 OR EXISTS(SELECT 1 FROM hub_profile_chunk_refs r WHERE r.profile_id=c.profile_id AND r.hash=c.hash))",
            [s.profileId, req.params.hash, new Date(Date.now() - PROFILE_CHUNK_GRACE_MS)],
          )
        ).rows[0];
        if (!r) throw new AppError("HUB_NOT_FOUND", "Chunk not found.", 404);
        return {
          hash: req.params.hash,
          bytes: r.bytes,
          data: decrypt(r.encrypted_payload, key),
        };
      });
    },
  );
  const preferenceKey = (key: unknown): key is string =>
    typeof key === "string" &&
    ([
      "atlas.settings",
      "atlas.shortcuts",
      "atlas.history",
      "atlas.chats",
      "atlas.onboarded",
      "atlas.sidebarCollapsed",
      "atlas.ai.geminiConsent",
      "atlas.tabs",
    ].includes(key) ||
      /^atlas\.windows\.v1\.[a-f0-9-]{36}$/.test(key));
  async function preferences(c: PoolClient, s: HubSession, key: string) {
    const row = (
      await c.query(
        "SELECT * FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
        [s.profileId, hubNamespace({ kind: "atlas" }).key],
      )
    ).rows[0];
    const stored = row?.encrypted_payload
      ? JSON.parse(decrypt(row.encrypted_payload, key))
      : null;
    const data = stored
      ? ((stored.codec === "atlas-chunks-v1"
          ? (await payload(c, s, key, stored)).decoded
          : decodePortableValue(stored)) as any)
      : null;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(data?.values || {}))
      if (preferenceKey(k) && typeof v === "string") values[k] = v;
    return { row, values, revision: Number(row?.revision || 0) };
  }
  app.get("/api/hub/branch/profile/preferences", async (req) => {
    const s = await identity.authenticate(req);
    return readProfile(s, async (c, _p, key) => {
      const current = await preferences(c, s, key);
      return { revision: current.revision, values: current.values };
    });
  });
  app.post(
    "/api/hub/branch/profile/preferences",
    { bodyLimit: 2_000_000 },
    async (req) => {
      const s = await identity.authenticate(req),
        v = hubObject(req.body),
        id = hubToken(v.idempotencyKey, 16, 96);
      return locked(s, async (c, p, key) => {
        const hash = digest(
          JSON.stringify([
            "atlas-preferences-v1",
            digest(JSON.stringify(hubObject(v.payload))),
          ]),
        );
        const prior = (
          await c.query(
            "SELECT namespace,payload_hash,revision FROM hub_commits WHERE profile_id=$1 AND idempotency_key=$2",
            [s.profileId, id],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.namespace !== hubNamespace({ kind: "atlas" }).key ||
            prior.payload_hash !== hash
          )
            throw conflict();
          return {
            acknowledged: true,
            revision: Number(prior.revision),
            replayed: true,
          };
        }
        const input = await payload(c, s, key, v.payload),
          body = input.decoded as any;
        if (
          body?.format !== "atlas-preferences-patch-v1" ||
          !Array.isArray(body.changes) ||
          body.changes.length > 1000
        )
          throw invalid("Invalid preferences patch.");
        const current = await preferences(c, s, key),
          values = { ...current.values },
          seen = new Set<string>();
        for (const change of body.changes) {
          if (
            !preferenceKey(change.key) ||
            seen.has(change.key) ||
            !(change.value === null || typeof change.value === "string") ||
            !(change.base === null || typeof change.base === "string")
          )
            throw invalid("Invalid preferences key or value.");
          seen.add(change.key);
          const old = current.values[change.key] ?? null;
          if (old !== change.base)
            throw conflict(
              "These settings changed in another browser. Your local version is retained.",
            );
          if (change.value === null) delete values[change.key];
          else values[change.key] = change.value;
        }
        const encoded = JSON.stringify(
            await encodePortableValue({
              format: "atlas-user-snapshot-v1",
              values,
            }),
          ),
          next = { encoded, bytes: Buffer.byteLength(encoded) };
        if (next.bytes > HUB_LIMITS.streamBytes)
          throw new AppError(
            "HUB_QUOTA",
            "Atlas settings exceed their backup allowance.",
            413,
          );
        const revision = current.revision + 1,
          namespace = hubNamespace({ kind: "atlas" }).key;
        await c.query(
          "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes,restore_bytes) VALUES($1,$2,$3,$3,$4,$5::int,$5::bigint) ON CONFLICT(profile_id,namespace) DO UPDATE SET revision=excluded.revision,snapshot_revision=excluded.snapshot_revision,encrypted_payload=excluded.encrypted_payload,bytes=excluded.bytes,restore_bytes=excluded.restore_bytes,updated_at=now()",
          [
            s.profileId,
            namespace,
            revision,
            encrypt(next.encoded, key),
            next.bytes,
          ],
        );
        await c.query(
          "INSERT INTO hub_commits(profile_id,namespace,revision,profile_revision,idempotency_key,payload_hash,mode,encrypted_payload,bytes) VALUES($1,$2,$3,$4,$5,$6,'snapshot',NULL,0)",
          [
            s.profileId,
            namespace,
            revision,
            Number(p.revision) + 1,
            id,
            hash,
          ],
        );
        await clearCommitChunkReferences(c, s.profileId, namespace);
        await replaceChunkReferences(
          c,
          s.profileId,
          "stream",
          namespace,
          JSON.parse(next.encoded),
        );

        await c.query(
          "UPDATE hub_commits SET encrypted_payload=NULL,bytes=0 WHERE profile_id=$1 AND namespace=$2 AND revision<$3",
          [s.profileId, namespace, revision],
        );
        await c.query(
          "UPDATE hub_profiles SET initialized=true,revision=revision+1,bytes=bytes+$2 WHERE id=$1",
          [s.profileId, next.bytes - Number(current.row?.bytes || 0)],
        );
        return { acknowledged: true, revision, replayed: false };
      });
    },
  );
  app.get("/api/hub/branch/profile/recoveries", async (req) => {
    const s = await identity.authenticate(req);
    return {
      recoveries: (
        await pool.query(
          'SELECT id,namespace,bytes,created_at AS "createdAt" FROM hub_profile_recoveries WHERE profile_id=$1 ORDER BY created_at DESC LIMIT 100',
          [s.profileId],
        )
      ).rows,
    };
  });
  app.post(
    "/api/hub/branch/profile/recoveries",
    { bodyLimit: 2_000_000 },
    async (req) => {
      const s = await identity.authenticate(req),
        v = hubObject(req.body),
        id = hubUUID(v.id),
        n = namespace(v.namespace);
      return locked(s, async (c, p, key) => {
        const data = await payload(c, s, key, v.payload);
        const existing = (
          await c.query(
            "SELECT payload_hash FROM hub_profile_recoveries WHERE profile_id=$1 AND id=$2",
            [s.profileId, id],
          )
        ).rows[0];
        if (existing) {
          if (existing.payload_hash !== data.hash) throw conflict();
          return { acknowledged: true, id, replayed: true };
        }
        await c.query(
          "INSERT INTO hub_profile_recoveries(id,profile_id,context_id,namespace,encrypted_payload,payload_hash,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            s.profileId,
            s.contextId,
            n.key,
            encrypt(data.encoded, key),
            data.hash,
            data.bytes,
          ],
        );
        await replaceChunkReferences(c, s.profileId, "recovery", id, v.payload);
        await c.query("UPDATE hub_profiles SET bytes=bytes+$2 WHERE id=$1", [
          s.profileId,
          data.bytes,
        ]);
        return { acknowledged: true, id, replayed: false };
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/hub/branch/profile/recoveries/:id",
    async (req) => {
      const s = await identity.authenticate(req);
      return readProfile(s, async (c, _p, key) => {
        const r = (
          await c.query(
            "SELECT namespace,encrypted_payload,created_at FROM hub_profile_recoveries WHERE profile_id=$1 AND id=$2",
            [s.profileId, hubUUID(req.params.id)],
          )
        ).rows[0];
        if (!r) throw new AppError("HUB_NOT_FOUND", "Recovery not found.", 404);
        return {
          namespace: JSON.parse(r.namespace),
          payload: JSON.parse(decrypt(r.encrypted_payload, key)),
          createdAt: r.created_at,
        };
      });
    },
  );
  app.post("/api/hub/branch/profile/imports", async (req) => {
    const s = await identity.authenticate(req),
      v = hubObject(req.body);
    if (v.claimAccepted !== true)
      throw invalid(
        "Existing browser data must be explicitly bound to this account.",
      );
    return locked(s, async (c, p) => {
      if (p.initialized || Number(p.revision) > 0)
        throw conflict("Only an empty cloud profile can import legacy data.");
      await c.query(
        "UPDATE hub_imports SET status='cancelled' WHERE profile_id=$1 AND status='reserved' AND expires_at<=now()",
        [s.profileId],
      );
      const old = (
        await c.query(
          "SELECT * FROM hub_imports WHERE profile_id=$1 AND status='reserved'",
          [s.profileId],
        )
      ).rows[0];
      if (old) {
        if (old.session_id !== s.sessionId || old.context_id !== s.contextId)
          throw conflict("Another context is initializing this profile.");
        return { importId: old.id, expiresAt: old.expires_at };
      }
      const row = (
        await c.query(
          "INSERT INTO hub_imports(profile_id,session_id,context_id,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes') RETURNING id,expires_at",
          [s.profileId, s.sessionId, s.contextId],
        )
      ).rows[0];
      return { importId: row.id, expiresAt: row.expires_at };
    });
  });
  app.post<{ Params: { id: string } }>(
    "/api/hub/branch/profile/imports/:id/commit",
    { bodyLimit: 2_000_000 },
    async (req) => {
      const s = await identity.authenticate(req),
        v = hubObject(req.body),
        id = hubUUID(req.params.id);
      if (
        !Array.isArray(v.entries) ||
        v.entries.length > 256 ||
        typeof v.manifestHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.manifestHash)
      )
        throw invalid("Invalid import manifest.");
      return locked(s, async (c, p, key) => {
        const r = (
          await c.query(
            "SELECT *,expires_at>now() live FROM hub_imports WHERE id=$1 AND profile_id=$2",
            [id, s.profileId],
          )
        ).rows[0];
        if (!r || r.session_id !== s.sessionId || r.context_id !== s.contextId)
          throw conflict("Import reservation unavailable.");
        if (r.status === "committed") {
          if (r.manifest_hash !== v.manifestHash) throw conflict();
          return {
            acknowledged: true,
            replayed: true,
            revision: Number(p.revision),
          };
        }
        if (!r.live || r.status !== "reserved" || p.initialized)
          throw conflict(
            "Initial import expired or profile is no longer empty.",
          );
        const seen = new Set<string>(),
          entries = [];
        let bytes = 0;
        for (const entry of v.entries) {
          const n = namespace(entry.namespace);
          if (seen.has(n.key)) throw invalid("Duplicate import namespace.");
          seen.add(n.key);
          const value = await payload(c, s, key, entry.payload);
          bytes += value.bytes;
          entries.push({ ...n, ...value });
        }
        const calculated = digest(
          JSON.stringify(entries.map((e) => [e.key, e.hash])),
        );
        if (calculated !== v.manifestHash)
          throw invalid("Import manifest integrity mismatch.");
        for (const e of entries) {
          await c.query(
            "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes,restore_bytes) VALUES($1,$2,1,1,$3,$4,$5)",
            [
              s.profileId,
              e.key,
              encrypt(e.encoded, key),
              e.bytes,
              e.restoreBytes,
            ],
          );
          await replaceChunkReferences(
            c,
            s.profileId,
            "stream",
            e.key,
            JSON.parse(e.encoded),
          );
        }
        await c.query(
          "UPDATE hub_profiles SET initialized=true,revision=1,bytes=bytes+$2 WHERE id=$1",
          [s.profileId, bytes],
        );
        await c.query(
          "UPDATE hub_imports SET status='committed',manifest_hash=$2 WHERE id=$1",
          [id, v.manifestHash],
        );
        return { acknowledged: true, replayed: false, revision: 1 };
      });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/hub/branch/profile/imports/:id",
    async (req) => {
      const s = await identity.authenticate(req);
      return locked(s, async (c) => {
        await c.query(
          "UPDATE hub_imports SET status='cancelled' WHERE id=$1 AND profile_id=$2 AND session_id=$3 AND status='reserved'",
          [hubUUID(req.params.id), s.profileId, s.sessionId],
        );
        return { ok: true };
      });
    },
  );
}
