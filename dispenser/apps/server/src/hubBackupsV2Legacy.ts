/** Conservative v1 conversion: completed pinned snapshots only; no live journal replay. */
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  canonicalBackupJson,
  backupManifestIdentity,
  hubNamespace,
  type BackupCheckpointV2,
} from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import { decrypt } from "./security.js";
import type { HubIdentity, HubSession } from "./hubIdentity.js";
import {
  withBackupTransaction,
  publishPreparedBackupV2,
  encryptBackupPartV2,
} from "./hubBackupsV2.js";
export const LEGACY_CONVERSION_LIMITS = Object.freeze({
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  processBytes: 1024 * 1024 * 1024,
  deadlineMs: 30000,
  cpu: 1,
  jobs: 1,
});
const digest = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const prefix = "/api/hub/branch/profile/backups/v2";
const id = (v: unknown) => {
  if (typeof v !== "string" || !/^[a-f0-9-]{36}$/i.test(v))
    throw new AppError("BACKUP_INVALID", "Invalid conversion job identity.");
  return v;
};
function runChild(
  input: unknown,
  signal?: AbortSignal,
  absoluteDeadline = Date.now() + LEGACY_CONVERSION_LIMITS.deadlineMs,
): Promise<any> {
  const adjacent = fileURLToPath(
      new URL("./hubBackupsV2LegacyChild.js", import.meta.url),
    ),
    compiled = fileURLToPath(
      new URL("../dist/hubBackupsV2LegacyChild.js", import.meta.url),
    ),
    entry = existsSync(adjacent) ? adjacent : compiled;
  if (!existsSync(entry))
    return Promise.reject(Error("LEGACY_CONVERTER_BUILD_REQUIRED"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=768", entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ATLAS_BACKUP_CONVERTER_CHILD: "1",
        ATLAS_BACKUP_CONVERTER_DEADLINE: String(absoluteDeadline),
      },
    });
    const output: Buffer[] = [];
    let bytes = 0,
      finished = false,
      maxRSSBytes = 0;
    const fail = (code: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(memory);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      reject(Error(code));
    };
    const abort = () => fail("LEGACY_TIME_BUDGET_DEFERRED");
    const observed = (rss: number) => {
      if (Number.isFinite(rss)) maxRSSBytes = Math.max(maxRSSBytes, rss);
      if (rss > LEGACY_CONVERSION_LIMITS.processBytes)
        fail("LEGACY_MEMORY_BUDGET_DEFERRED");
    };
    const sample = () => {
      if (!child.pid) return;
      if (process.platform === "linux") {
        void readFile("/proc/" + child.pid + "/status", "utf8")
          .then((value) => {
            const match = /VmRSS:\s*(\d+)\s*kB/.exec(value);
            if (match) observed(Number(match[1]) * 1024);
          })
          .catch(() => {});
        return;
      }
      execFile(
        "ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { timeout: 1000, maxBuffer: 1024 },
        (error, stdout) => {
          if (!error) observed(Number(stdout.trim()) * 1024);
        },
      );
    };
    const memory = setInterval(sample, 250),
      timer = setTimeout(
        () => fail("LEGACY_TIME_BUDGET_DEFERRED"),
        LEGACY_CONVERSION_LIMITS.deadlineMs,
      );
    sample();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 12 * 1024 * 1024) {
        fail("LEGACY_ENCODED_BUDGET_DEFERRED");
        return;
      }
      output.push(chunk);
    });
    // Private subprocess stderr is deliberately not forwarded into application logs.
    child.stderr.on("data", () => {});
    child.on("error", () => fail("LEGACY_PROCESS_DEFERRED"));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(memory);
      signal?.removeEventListener("abort", abort);
      try {
        if (code !== 0) throw Error("LEGACY_PROCESS_DEFERRED");
        const result = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (!result?.ok)
          throw Error(result?.code || "LEGACY_CONVERSION_DEFERRED");
        resolve({ ...result, maxRSSBytes });
      } catch (error) {
        reject(error);
      }
    });
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 12 * 1024 * 1024) {
      fail("LEGACY_SOURCE_OVERSIZED");
      return;
    }
    child.stdin.end(body);
  });
}
export function registerHubLegacyConversionRoutes(
  app: FastifyInstance,
  o: {
    pool: Pool;
    identity: HubIdentity;
    encryptionKey: string;
    startWorker?: boolean;
    publicationDisabled?: boolean;
  },
) {
  app.post(
    prefix + "/legacy-conversions",
    { bodyLimit: 4096 },
    async (request) => {
      if (o.publicationDisabled)
        throw new AppError(
          "BACKUP_BUSY",
          "Legacy conversion is paused; existing local data and completed cloud backups remain available.",
          503,
        );
      const session = await o.identity.authenticate(request);
      let namespace = (request.body as any)?.namespace;
      let key: string;
      try {
        const logical = hubNamespace(namespace);
        key = logical.key;
        if (namespace.kind === "cookies")
          namespace = {
            kind: "cookies",
            origin: "https://" + logical.siteGroup,
          };
      } catch {
        throw new AppError(
          "BACKUP_INVALID",
          "Choose a valid legacy namespace.",
        );
      }
      return withBackupTransaction(
        o.pool,
        new AbortController().signal,
        async (c) => {
          const profile = (
            await c.query(
              "SELECT * FROM hub_profiles WHERE id=$1 AND user_id=$2 FOR NO KEY UPDATE",
              [session.profileId, session.userId],
            )
          ).rows[0];
          if (!profile)
            throw new AppError(
              "HUB_SESSION_EXPIRED",
              "The cloud profile changed.",
              401,
            );
          const source = (
            await c.query(
              "SELECT revision,snapshot_revision,restore_bytes,octet_length(encrypted_payload) cipher_bytes FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
              [session.profileId, key],
            )
          ).rows[0];
          const jobId = randomUUID(),
            reason =
              Number(profile.backup_accounting_version) !== 1
                ? "LEGACY_ACCOUNTING_PENDING"
                : !source
                  ? "LEGACY_SOURCE_MISSING"
                  : Number(source.revision) !== Number(source.snapshot_revision)
                    ? "LEGACY_LIVE_JOURNAL_DEFERRED"
                    : !Number.isSafeInteger(Number(source.restore_bytes)) ||
                        Number(source.restore_bytes) >
                          LEGACY_CONVERSION_LIMITS.inputBytes ||
                        Number(source.cipher_bytes) > 8 * 1024 * 1024
                      ? "LEGACY_SOURCE_OVERSIZED"
                      : null;
          if (reason) {
            await c.query(
              "INSERT INTO hub_backup_jobs(id,profile_id,kind,status,source,error_code) VALUES($1,$2,'legacy-conversion','deferred',$3,$4)",
              [jobId, session.profileId, { namespace, key }, reason],
            );
            return { jobId, status: "deferred", reason };
          }
          const row = (
            await c.query(
              "SELECT encrypted_payload,bytes FROM hub_streams WHERE profile_id=$1 AND namespace=$2 AND revision=$3 AND snapshot_revision=$3",
              [session.profileId, key, source.revision],
            )
          ).rows[0];
          if (!row?.encrypted_payload)
            throw new AppError(
              "BACKUP_CONFLICT",
              "The legacy checkpoint changed. Its original data is preserved.",
              409,
            );
          const sourceDigest = digest(row.encrypted_payload),
            existing = (
              await c.query(
                "SELECT id,status,error_code,result,source FROM hub_backup_jobs WHERE profile_id=$1 AND kind='legacy-conversion' AND source->>'namespaceKey'=$2 AND source->>'sourceDigest'=$3 ORDER BY created_at DESC LIMIT 1",
                [session.profileId, key, sourceDigest],
              )
            ).rows[0];
          if (
            existing &&
            !(
              existing.status === "deferred" &&
              (request.body as any)?.retry === true
            )
          )
            return {
              jobId: existing.id,
              status: existing.status,
              reason: existing.error_code,
              completedCheckpointId: existing.result?.checkpointId,
            };
          const other = (
            await c.query(
              "SELECT id FROM hub_backup_jobs WHERE profile_id=$1 AND kind='legacy-conversion' AND status IN ('pending','running') LIMIT 1",
              [session.profileId],
            )
          ).rows[0];
          if (other)
            throw new AppError(
              "BACKUP_BUSY",
              "Another bounded legacy conversion is in progress. This namespace remains available through legacy storage.",
              503,
            );
          const reservedBytes = Number(source.cipher_bytes);
          if (
            Number(profile.backup_v1_staging_bytes) +
              Number(profile.backup_v2_staging_bytes) +
              Number(profile.backup_conversion_staging_bytes) +
              reservedBytes >
            128 * 1024 * 1024
          )
            throw new AppError(
              "BACKUP_QUOTA_EXCEEDED",
              "Legacy conversion is deferred by cloud staging allowance. Original data is preserved.",
              413,
            );
          await c.query(
            "UPDATE hub_profiles SET backup_conversion_staging_bytes=backup_conversion_staging_bytes+$2 WHERE id=$1",
            [session.profileId, reservedBytes],
          );
          const snapshot = {
            reservedBytes,
            namespace,
            namespaceKey: key,
            revision: Number(source.revision),
            encryptedPayload: row.encrypted_payload,
            sourceDigest,
            sourceBytes: Number(row.bytes),
            authorization: session,
            checkpointId: randomUUID(),
            replicaId: randomUUID(),
            incarnation: randomUUID(),
            versionId: randomUUID(),
          };
          if (existing) {
            const resume = {
              ...snapshot,
              ...existing.source,
              encryptedPayload: row.encrypted_payload,
              reservedBytes,
              authorization: session,
            };
            await c.query(
              "UPDATE hub_backup_jobs SET status='pending',source=$2,error_code=NULL,owner_token=NULL,lease_expires_at=NULL WHERE id=$1",
              [existing.id, resume],
            );
            return { jobId: existing.id, status: "pending" };
          }
          await c.query(
            "INSERT INTO hub_backup_jobs(id,profile_id,kind,source) VALUES($1,$2,'legacy-conversion',$3)",
            [jobId, session.profileId, snapshot],
          );
          return { jobId, status: "pending" };
        },
      );
    },
  );
  app.get(prefix + "/legacy-conversions/:id", async (request) => {
    const session = await o.identity.authenticate(request),
      jobId = id((request.params as any).id);
    return withBackupTransaction(
      o.pool,
      new AbortController().signal,
      async (c) => {
        const job = (
          await c.query(
            "SELECT id,status,error_code,result FROM hub_backup_jobs WHERE profile_id=$1 AND id=$2 AND kind='legacy-conversion'",
            [session.profileId, jobId],
          )
        ).rows[0];
        if (!job)
          throw new AppError(
            "BACKUP_NOT_FOUND",
            "Conversion job unavailable.",
            404,
          );
        return {
          jobId: job.id,
          status: job.status,
          reason: job.error_code,
          completedCheckpointId: job.result?.checkpointId,
          limits: LEGACY_CONVERSION_LIMITS,
        };
      },
    );
  });
  // Legacy conversion producers are retired; stored jobs and original bytes remain readable.
}
async function finishConversionJob(
  pool: Pool,
  job: any,
  token: string,
  status: "complete" | "deferred",
  result: any,
  reason: string | null,
) {
  return withBackupTransaction(
    pool,
    new AbortController().signal,
    async (c) => {
      const p = (
        await c.query(
          "SELECT id FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE",
          [job.profile_id],
        )
      ).rows[0];
      if (!p) return;
      const owned = (
        await c.query(
          "SELECT source FROM hub_backup_jobs WHERE id=$1 AND owner_token=$2 AND status='running' FOR UPDATE",
          [job.id, token],
        )
      ).rows[0];
      if (!owned) return;
      const reserved = Number(owned.source?.reservedBytes || 0);
      if (reserved)
        await c.query(
          "UPDATE hub_profiles SET backup_conversion_staging_bytes=backup_conversion_staging_bytes-$2 WHERE id=$1",
          [job.profile_id, reserved],
        );
      await c.query(
        "UPDATE hub_backup_jobs SET status=$3,result=$4,error_code=$5,lease_expires_at=NULL,source=(source-'encryptedPayload')||'{\"reservedBytes\":0}'::jsonb WHERE id=$1 AND owner_token=$2",
        [job.id, token, status, result, reason],
      );
      await c.query(
        "DELETE FROM hub_backup_legacy_chunk_pins WHERE job_id=$1",
        [job.id],
      );
    },
  );
}
export async function runLegacyConversionJob(pool: Pool, master: string) {
  const control = new AbortController(),
    signal = control.signal,
    token = randomUUID();
  const job = await withBackupTransaction(pool, signal, async (c) => {
    if (
      !(
        await c.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('atlas-backup-legacy-converter')) acquired",
        )
      ).rows[0].acquired
    )
      return null;
    await c.query(
      "UPDATE hub_backup_jobs SET status='pending',owner_token=NULL WHERE kind='legacy-conversion' AND status='running' AND lease_expires_at<now()",
    );
    if (
      (
        await c.query(
          "SELECT 1 FROM hub_backup_jobs WHERE kind='legacy-conversion' AND status='running' LIMIT 1",
        )
      ).rowCount
    )
      return null;
    const candidate = (
      await c.query(
        "SELECT * FROM hub_backup_jobs WHERE kind='legacy-conversion' AND status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!candidate) return null;
    await c.query(
      "UPDATE hub_backup_jobs SET status='running',owner_token=$2,attempts=attempts+1,lease_expires_at=now()+interval '45 seconds' WHERE id=$1",
      [candidate.id, token],
    );
    return candidate;
  });
  if (!job) return { worked: false };
  const absoluteDeadline = Date.now() + LEGACY_CONVERSION_LIMITS.deadlineMs,
    jobDeadline = setTimeout(
      () => control.abort(),
      LEGACY_CONVERSION_LIMITS.deadlineMs,
    );
  const source = job.source,
    session: HubSession = source.authorization;
  try {
    const profile = await withBackupTransaction(pool, signal, async (c) => {
      const p = (
        await c.query(
          "SELECT p.encrypted_key,p.backup_accounting_version FROM hub_profiles p JOIN hub_branch_sessions s ON s.profile_id=p.id AND s.user_id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND s.id=$3 AND s.revoked_at IS NULL AND s.expires_at>now()",
          [job.profile_id, session.userId, session.sessionId],
        )
      ).rows[0];
      if (!p) throw Error("LEGACY_AUTHORIZATION_CHANGED");
      if (Number(p.backup_accounting_version) !== 1)
        throw Error("LEGACY_ACCOUNTING_PENDING");
      return p;
    });
    const priorReceipt = (
      await pool.query(
        "SELECT receipt FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2 AND receipt IS NOT NULL",
        [job.profile_id, source.checkpointId],
      )
    ).rows[0]?.receipt;
    if (priorReceipt) {
      await finishConversionJob(
        pool,
        job,
        token,
        "complete",
        {
          checkpointId: priorReceipt.checkpointId,
          sourceRevision: source.revision,
        },
        null,
      );
      return {
        worked: true,
        complete: true,
        checkpointId: priorReceipt.checkpointId,
      };
    }
    const key = decrypt(profile.encrypted_key, master),
      inspection = await runChild(
        {
          mode: "inspect",
          encryptedPayload: source.encryptedPayload,
          key,
        },
        signal,
        absoluteDeadline,
      ),
      manifest = inspection.manifest;
    let chunks: any[] = [],
      creditBytes = source.sourceBytes;
    if (manifest) {
      if (
        manifest.codec !== "atlas-chunks-v1" ||
        !Array.isArray(manifest.hashes) ||
        manifest.hashes.length > 64 ||
        manifest.hashes.some(
          (h: any) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h),
        ) ||
        !Number.isSafeInteger(manifest.bytes) ||
        manifest.bytes > LEGACY_CONVERSION_LIMITS.inputBytes
      )
        throw Error("LEGACY_SOURCE_OVERSIZED");
      chunks = await withBackupTransaction(pool, signal, async (c) => {
        await c.query(
          "SELECT id FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE",
          [job.profile_id],
        );
        const current = (
          await c.query(
            "SELECT revision,snapshot_revision,encrypted_payload FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
            [job.profile_id, source.namespaceKey],
          )
        ).rows[0];
        if (
          !current ||
          Number(current.revision) !== source.revision ||
          Number(current.snapshot_revision) !== source.revision ||
          digest(current.encrypted_payload) !== source.sourceDigest
        )
          throw Error("LEGACY_SOURCE_CHANGED");
        const metadata = (
          await c.query(
            "SELECT hash,bytes,backup_reference_count,octet_length(encrypted_payload) cipher_bytes FROM hub_chunks WHERE profile_id=$1 AND hash=ANY($2::text[])",
            [job.profile_id, manifest.hashes],
          )
        ).rows;
        if (
          metadata.length !== new Set(manifest.hashes).size ||
          metadata.reduce((n, r) => n + Number(r.bytes), 0) >
            LEGACY_CONVERSION_LIMITS.inputBytes ||
          metadata.reduce((n, r) => n + Number(r.cipher_bytes), 0) >
            8 * 1024 * 1024
        )
          throw Error("LEGACY_CHUNK_SOURCE_DEFERRED");
        if (metadata.some((row) => Number(row.backup_reference_count) !== 1))
          throw Error("LEGACY_SHARED_CHUNK_DEFERRED");
        for (const row of metadata)
          await c.query(
            "INSERT INTO hub_backup_legacy_chunk_pins VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [job.profile_id, job.id, row.hash],
          );
        creditBytes += metadata
          .filter((r) => Number(r.backup_reference_count) === 1)
          .reduce((n, r) => n + Number(r.bytes), 0);
        return (
          await c.query(
            "SELECT hash,encrypted_payload FROM hub_chunks WHERE profile_id=$1 AND hash=ANY($2::text[])",
            [job.profile_id, manifest.hashes],
          )
        ).rows.map((r) => ({
          hash: r.hash,
          encryptedPayload: r.encrypted_payload,
        }));
      });
    }
    const converted = await runChild(
      { ...source, key, chunks },
      signal,
      absoluteDeadline,
    );
    const parts = converted.parts.map((p: any) => ({
      sha256: p.sha256,
      bytes: p.bytes,
      raw: Buffer.from(p.data, "base64"),
    }));
    if (
      !Array.isArray(converted.parts) ||
      parts.length > 32 ||
      parts.reduce((n: number, p: any) => n + p.bytes, 0) > 8 * 1024 * 1024 ||
      parts.some(
        (p: any) => p.raw.length !== p.bytes || digest(p.raw) !== p.sha256,
      )
    )
      throw Error("LEGACY_CONVERTER_OUTPUT_INVALID");
    const n = {
      namespace: source.namespace,
      namespaceVersionId: source.versionId,
      parentNamespaceVersionId: null,
      localCut: source.revision,
      schemaEpoch: 1,
      kind: "baseline" as const,
      rootDigest: "",
      parts: parts.map((p: any, ordinal: number) => ({
        ordinal,
        sha256: p.sha256,
        bytes: p.bytes,
      })),
      coverage: "complete-at-cut" as const,
    };
    n.rootDigest = digest(canonicalBackupJson(n.parts));
    const m: BackupCheckpointV2 = {
      format: "atlas-checkpoint-v2",
      checkpointId: source.checkpointId,
      replicaId: source.replicaId,
      incarnation: source.incarnation,
      sequence: 1,
      parentCheckpointId: null,
      manifestDigest: "",
      adoptedThrough: 0,
      namespaces: [n],
    };
    m.manifestDigest = digest(backupManifestIdentity(m));
    await withBackupTransaction(pool, signal, async (c) => {
      const p = (
        await c.query(
          "SELECT * FROM hub_profiles WHERE id=$1 AND user_id=$2 FOR NO KEY UPDATE",
          [job.profile_id, session.userId],
        )
      ).rows[0];
      if (!p) throw Error("LEGACY_PROFILE_CHANGED");
      const claim = (
        await c.query(
          "SELECT status,owner_token FROM hub_backup_jobs WHERE id=$1 FOR UPDATE",
          [job.id],
        )
      ).rows[0];
      if (claim?.status !== "running" || claim.owner_token !== token)
        throw Error("LEGACY_JOB_REPLACED");
      const sourceRow = (
        await c.query(
          "SELECT revision,snapshot_revision,encrypted_payload FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
          [job.profile_id, source.namespaceKey],
        )
      ).rows[0];
      if (
        !sourceRow ||
        Number(sourceRow.revision) !== source.revision ||
        Number(sourceRow.snapshot_revision) !== source.revision ||
        digest(sourceRow.encrypted_payload) !== source.sourceDigest
      )
        throw Error("LEGACY_SOURCE_CHANGED");
      const already = (
        await c.query(
          "SELECT 1 FROM hub_backup_checkpoint_namespaces x JOIN hub_backup_checkpoints p USING(profile_id,checkpoint_id) WHERE x.profile_id=$1 AND x.namespace=$2 AND p.status='complete' AND p.checkpoint_id<>$3 LIMIT 1",
          [job.profile_id, source.namespaceKey, source.checkpointId],
        )
      ).rowCount;
      if (already) throw Error("LEGACY_NEWER_BACKUP_EXISTS");
      const origin = (
        await c.query(
          "SELECT origin FROM hub_branches WHERE id=$1 AND enabled",
          [session.branchId],
        )
      ).rows[0]?.origin;
      if (!origin) throw Error("LEGACY_BRANCH_CHANGED");
      await c.query(
        "INSERT INTO hub_backup_replicas(profile_id,replica_id,incarnation,branch_id,origin,label) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          job.profile_id,
          source.replicaId,
          source.incarnation,
          session.branchId,
          origin,
          "Converted legacy save",
        ],
      );
      await c.query(
        "INSERT INTO hub_backup_checkpoints(profile_id,checkpoint_id,replica_id,sequence,manifest_digest,manifest) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT DO NOTHING",
        [
          job.profile_id,
          source.checkpointId,
          source.replicaId,
          m.manifestDigest,
          m,
        ],
      );
      await c.query(
        "INSERT INTO hub_backup_namespace_versions(profile_id,namespace_version_id,checkpoint_id,namespace,kind,local_cut,schema_epoch,root_digest,manifest) VALUES($1,$2,$3,$4,'baseline',$5,'1',$6,$7) ON CONFLICT DO NOTHING",
        [
          job.profile_id,
          source.versionId,
          source.checkpointId,
          source.namespaceKey,
          source.revision,
          n.rootDigest,
          n,
        ],
      );
      await c.query(
        "INSERT INTO hub_backup_checkpoint_namespaces VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [
          job.profile_id,
          source.checkpointId,
          source.namespaceKey,
          source.versionId,
        ],
      );
      let staged = 0,
        count = 0;
      for (const part of parts) {
        await c.query(
          "INSERT INTO hub_backup_checkpoint_parts VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [job.profile_id, source.checkpointId, part.sha256, part.bytes],
        );
        const inserted = await c.query(
          "INSERT INTO hub_backup_parts(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [
            job.profile_id,
            part.sha256,
            encryptBackupPartV2(part.raw, key),
            part.bytes,
          ],
        );
        if (inserted.rowCount) {
          staged += part.bytes;
          count++;
        }
      }
      if (
        Number(p.backup_v2_staging_bytes) +
          Number(p.backup_v1_staging_bytes) +
          Number(p.backup_conversion_staging_bytes || 0) +
          staged >
          128 * 1024 * 1024 ||
        Number(p.backup_v2_staging_parts) +
          Number(p.backup_v1_staging_chunks) +
          count >
          4096
      )
        throw Error("LEGACY_STAGING_QUOTA_DEFERRED");
      await c.query(
        "UPDATE hub_profiles SET backup_v2_staging_bytes=backup_v2_staging_bytes+$2,backup_v2_staging_parts=backup_v2_staging_parts+$3 WHERE id=$1",
        [job.profile_id, staged, count],
      );
    });
    const receipt = await publishPreparedBackupV2(
      { pool, encryptionKey: master },
      session,
      source.checkpointId,
      signal,
      {
        namespace: source.namespaceKey,
        revision: source.revision,
        sourceDigest: source.sourceDigest,
        creditBytes,
      },
    );
    await finishConversionJob(
      pool,
      job,
      token,
      "complete",
      {
        checkpointId: receipt.checkpointId,
        maxRSSBytes: converted.maxRSSBytes,
        sourceRevision: source.revision,
      },
      null,
    );
    return { worked: true, complete: true, checkpointId: receipt.checkpointId };
  } catch (error) {
    const raw = (error as any)?.code || (error as Error)?.message,
      reason =
        typeof raw === "string" && /^(LEGACY|BACKUP)_[A-Z_]+$/.test(raw)
          ? raw
          : "LEGACY_CONVERSION_DEFERRED";
    if (
      [
        "BACKUP_BUSY",
        "HUB_DATABASE_BUSY",
        "ECONNRESET",
        "08006",
        "57P01",
      ].includes(raw) &&
      Number(job.attempts) < 3
    ) {
      await withBackupTransaction(pool, signal, async (c) => {
        await c.query(
          "UPDATE hub_backup_jobs SET status='pending',error_code=$3,lease_expires_at=NULL WHERE id=$1 AND owner_token=$2 AND status='running'",
          [job.id, token, reason],
        );
      }).catch(() => {});
      return { worked: true, complete: false, reason, retry: true };
    }
    await finishConversionJob(pool, job, token, "deferred", null, reason).catch(
      () => {},
    );
    return { worked: true, complete: false, reason };
  } finally {
    clearTimeout(jobDeadline);
  }
}
