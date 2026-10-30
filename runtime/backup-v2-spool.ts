import {
  BACKUP_V2_LIMITS,
  backupDeferred,
  canonicalBackupJSON,
  type BackupManifest,
  type BackupPublishReceipt,
  type BackupNamespaceVersion,
  type BackupPartEnvelope,
} from "./backup-v2-contracts.ts";
import { measureBackupNativeKey } from "./backup-v2-keys.ts";
import type { LocalDirtyControl } from "./local-dirty-v2.ts";
import type { BackupDiscoveryCursor } from "./backup-v2-discovery.ts";
import type { BackupNativeSourceDescriptor } from "./backup-v2-indexeddb-source.ts";
export type PreparedBackup = {
  cancellation?: {
    code: "BACKUP_CATALOG_FULL";
    rejectedNamespaceVersionIds: string[];
  };
  manifest: BackupManifest;
  coverages: Array<{
    sourceId: string;
    namespaceVersionId: string;
    cut: number;
    trackingEpoch: number;
    localIncarnation?: string;
    hintVersion?: number;
    baselineEpoch?: number;
  }>;
};
export type BackupLocalHead = {
  registered: boolean;
  sequence: number;
  checkpointId: string | null;
  adoptedThrough: number;
  adoptionPending?: {
    adoptedThrough: number;
    checkpointId: string;
    manifestDigest: string;
  };
  cancellationAdoptionPending?: {
    checkpointId: string;
    manifestDigest: string;
    sequence: number;
    parentCheckpointId: string | null;
  };
  seedFallback?: { checkpointId: string; baselinesInitialized?: boolean };
  namespaceHeads: Record<string, string>;
  namespaceIncarnations?: Record<string, string>;
  lastReceipt?: BackupPublishReceipt;
};
export type SpoolRecord = { id: string; bytes: Uint8Array };
export type BackupCaptureJob = {
  invalidated?: boolean;
  format: 1;
  sourceId: string;
  versionId: string;
  parentVersionId: string | null;
  baseline: boolean;
  initial: LocalDirtyControl;
  phase: "schema" | "scan" | "catchup" | "seal" | "parts" | "done";
  scanKind: "baseline" | "changes";
  scanAfter: number;
  scanTarget: number;
  cursor?: unknown;
  target: number;
  pass: number;
  final?: LocalDirtyControl;
  partsAfter?: string;
  parts: Array<{ ordinal: number; sha256: string; bytes: number }>;
  partPage?: BackupPartEnvelope;
  partPageBytes?: number;
  result?: {
    version: BackupNamespaceVersion;
    trackingEpoch: number;
    localIncarnation: string;
  };
  updatedAt: number;
};
export type BackupFairEntry = {
  sourceId: string;
  descriptor?: BackupNativeSourceDescriptor;
  scope?: string;
  dirtySinceTurn: number | null;
  priority: number;
  tier?: number;
  hintVersion: number;
  lastServedTurn: number;
  nextEligibleAt: number;
  observedGeneration?: number;
  reason?: string;
  jobCursorId?: string;
  baselineEpoch?: number;
  acknowledgedBaselineEpoch?: number;
};
export type BackupSpool = {
  head(): Promise<BackupLocalHead>;
  saveHead(h: BackupLocalHead): Promise<void>;
  pending(): Promise<PreparedBackup | null>;
  prepare(p: PreparedBackup): Promise<void>;
  abandonPrepared?(
    id: string,
    digest: string,
    notBefore: number,
  ): Promise<void>;
  usage?(): Promise<{
    recordBytes: number;
    partBytes: number;
    jobBytes: number;
    jobs: number;
    partialJobs: number;
  }>;
  finish(
    r: BackupPublishReceipt,
    h: Record<string, string>,
    i?: Record<string, string>,
  ): Promise<void>;
  putRecord(v: string, id: string, b: Uint8Array): Promise<void>;
  records(v: string, after?: string): AsyncIterable<SpoolRecord>;
  discardNamespace(v: string): Promise<void>;
  putPart(h: string, b: Uint8Array, v?: string): Promise<void>;
  part(h: string): Promise<Uint8Array>;
  clearUnprepared(): Promise<void>;
  dispose(): void;
  workSources?(
    limit: number,
    now?: number,
  ): Promise<Array<{ sourceId: string; complete: boolean }>>;
  captureJob?(sourceId: string): Promise<BackupCaptureJob | null>;
  commitCapture?(
    job: BackupCaptureJob,
    records?: SpoolRecord[],
    parts?: Array<{ sha256: string; bytes: Uint8Array }>,
  ): Promise<void>;
  dropCapture?(sourceId: string): Promise<void>;
  requireBaselines?(identity: string): Promise<void>;
  requestDiscovery?(): Promise<void>;
  beginDiscovery?(): Promise<BackupDiscoveryCursor>;
  discoveryCursor?(): Promise<BackupDiscoveryCursor | undefined>;
  saveDiscoveryCursor?(cursor: BackupDiscoveryCursor): Promise<void>;
  touchSources?(
    descriptors: BackupNativeSourceDescriptor[],
    cursor?: BackupDiscoveryCursor,
  ): Promise<void>;
  fairSources?(limit: number, now: number): Promise<BackupFairEntry[]>;
  fairState?(ids: string[]): Promise<BackupFairEntry[]>;
  hintSources?(ids: string[]): Promise<void>;
  hintScope?(scope?: string): Promise<void>;
  probeAll?(): Promise<void>;
  hasQueuedSources?(): Promise<boolean>;
  markServed?(
    id: string,
    patch?: Partial<BackupFairEntry> & { expectedHintVersion?: number },
  ): Promise<void>;
  cycle?(): Promise<number>;
  clearPressureSource?(sourceId: string): Promise<void>;
  pressureSource?(): Promise<string | undefined>;
  claimPressureSource?(sourceId: string): Promise<string>;
  evictPartial?(exceptSourceId: string, deferUntil?: number): Promise<boolean>;
};
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (t: IDBTransaction) => {
  const completion = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || Error("BACKUP_SPOOL_ABORTED"));
    t.onerror = () => {};
  });
  void completion.catch(() => {});
  return completion;
};
const emptyHead = (): BackupLocalHead => ({
  registered: false,
  sequence: 0,
  checkpointId: null,
  adoptedThrough: 0,
  namespaceHeads: {},
  namespaceIncarnations: {},
});
const sourceScope = (d: BackupNativeSourceDescriptor) =>
  JSON.stringify([d.kind, d.namespace.origin ?? ""]);
const versionRange = (id: string) => IDBKeyRange.bound([id], [id, []]);
/** Spool-only state. No operation here opens native website stores. Page values
 * and their continuation cursor commit together. Prepared identities are pinned. */
export function createIndexedDBBackupSpool(
  factory: IDBFactory,
  replicaId: string,
): BackupSpool {
  if (!/^[a-f0-9-]{36}$/i.test(replicaId))
    throw TypeError("Invalid backup replica");
  let stopped = false;
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open("atlas.backup.spool.v2:" + replicaId, 6);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const n of ["meta", "records", "parts"])
        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n);
      if (!db.objectStoreNames.contains("jobs")) {
        const s = db.createObjectStore("jobs", { keyPath: "sourceId" });
        s.createIndex("version", "versionId", { unique: true });
        s.createIndex("age", "updatedAt");
        s.createIndex("phase", "phase");
      } else if (
        !r.transaction!.objectStore("jobs").indexNames.contains("phase")
      )
        r.transaction!.objectStore("jobs").createIndex("phase", "phase");
      const fresh = !db.objectStoreNames.contains("schedule"),
        s = fresh
          ? db.createObjectStore("schedule", { keyPath: "sourceId" })
          : r.transaction!.objectStore("schedule");
      if (!s.indexNames.contains("scope")) s.createIndex("scope", "scope");
      if (
        s.indexNames.contains("order") &&
        s.index("order").keyPath[0] !== "priority"
      )
        s.deleteIndex("order");
      if (!s.indexNames.contains("order"))
        s.createIndex("order", ["priority", "lastServedTurn", "sourceId"]);
      if (!s.indexNames.contains("fair"))
        s.createIndex("fair", [
          "priority",
          "tier",
          "lastServedTurn",
          "sourceId",
        ]);
      if (!fresh) {
        const q = s.openCursor();
        q.onsuccess = () => {
          const c = q.result;
          if (!c) return;
          const value = c.value;
          q.result!.update({
            ...value,
            priority: value.priority ?? 0,
            hintVersion: value.hintVersion ?? 0,
            tier:
              value.tier ??
              (value.priority === 1
                ? 2
                : value.observedGeneration !== undefined
                  ? 0
                  : 1),
            ...(value.descriptor
              ? { scope: sourceScope(value.descriptor) }
              : {}),
          });
          c.continue();
        };
      }
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error("BACKUP_SPOOL_BLOCKED"));
  });
  async function tx(stores: string[], mode: IDBTransactionMode = "readonly") {
    if (stopped) throw Error("BACKUP_SPOOL_DISPOSED");
    return (await database).transaction(stores, mode);
  }
  async function get<T>(
    store: string,
    key: IDBValidKey,
  ): Promise<T | undefined> {
    const t = await tx([store]),
      end = done(t),
      v = await request(t.objectStore(store).get(key));
    await end;
    return v;
  }
  async function put(store: string, key: IDBValidKey, value: unknown) {
    const t = await tx([store], "readwrite"),
      end = done(t);
    t.objectStore(store).put(value, key);
    await end;
  }
  function pinned(p: PreparedBackup | undefined, id: string) {
    return !!p?.manifest.namespaces.some((n) => n.namespaceVersionId === id);
  }
  async function discard(versionId: string) {
    const t = await tx(["meta", "records", "parts", "jobs"], "readwrite"),
      end = done(t),
      meta = t.objectStore("meta"),
      p = (await request(meta.get("prepared"))) as PreparedBackup | undefined;
    if (pinned(p, versionId)) {
      t.abort();
      await end.catch(() => {});
      throw backupDeferred(
        "BACKUP_PREPARED_PINNED",
        "A prepared checkpoint must resolve before its parts can be removed.",
      );
    }
    const ledger = (await request(meta.get(["versionBytes", versionId]))) as
      | { records: number; parts: number; job?: number }
      | undefined;
    const hashes = ((await request(meta.get(["namespaceParts", versionId]))) ||
      []) as string[];
    let recordsRemoved = ledger?.records ?? 0,
      partsRemoved = ledger?.parts ?? 0;
    if (!ledger) {
      await new Promise<void>((res, rej) => {
        const r = t.objectStore("records").openCursor(versionRange(versionId));
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c) {
            res();
            return;
          }
          recordsRemoved += (c.value as Uint8Array).byteLength;
          c.continue();
        };
      });
      for (const h of hashes) {
        const b = (await request(t.objectStore("parts").get(h))) as
          | Uint8Array
          | undefined;
        partsRemoved += b?.byteLength ?? 0;
      }
    }
    t.objectStore("records").delete(versionRange(versionId));
    for (const h of hashes) t.objectStore("parts").delete(h);
    meta.put(
      Math.max(
        0,
        Number((await request(meta.get("recordBytes"))) || 0) - recordsRemoved,
      ),
      "recordBytes",
    );
    meta.put(
      Math.max(
        0,
        Number((await request(meta.get("partBytes"))) || 0) - partsRemoved,
      ),
      "partBytes",
    );
    meta.put(
      Math.max(
        0,
        Number((await request(meta.get("jobBytes"))) || 0) - (ledger?.job ?? 0),
      ),
      "jobBytes",
    );
    meta.delete(["versionBytes", versionId]);
    const invalidated = ((await request(meta.get("invalidatedVersions"))) ||
      []) as string[];
    if (invalidated.includes(versionId))
      meta.put(
        invalidated.filter((id) => id !== versionId),
        "invalidatedVersions",
      );
    meta.delete(["namespaceParts", versionId]);
    const job = (await request(
      t.objectStore("jobs").index("version").get(versionId),
    )) as BackupCaptureJob | undefined;
    if (job) {
      t.objectStore("jobs").delete(job.sourceId);
      if ((await request(meta.get("pressureSource"))) === job.sourceId)
        meta.delete("pressureSource");
    }
    await end;
  }
  async function commit(
    job: BackupCaptureJob,
    rows: SpoolRecord[] = [],
    newParts: Array<{ sha256: string; bytes: Uint8Array }> = [],
  ) {
    const t = await tx(["meta", "records", "parts", "jobs"], "readwrite"),
      end = done(t),
      meta = t.objectStore("meta"),
      records = t.objectStore("records"),
      parts = t.objectStore("parts");
    const p = (await request(meta.get("prepared"))) as
      | PreparedBackup
      | undefined;
    if (pinned(p, job.versionId)) {
      t.abort();
      await end.catch(() => {});
      throw backupDeferred(
        "BACKUP_PREPARED_PINNED",
        "A prepared checkpoint is immutable.",
      );
    }
    const old = (await request(t.objectStore("jobs").get(job.sourceId))) as
      | BackupCaptureJob
      | undefined;
    if (
      !old &&
      Number(await request(t.objectStore("jobs").count())) -
        Number(
          await request(t.objectStore("jobs").index("phase").count("done")),
        ) >=
        8
    ) {
      t.abort();
      await end.catch(() => {});
      throw backupDeferred(
        "BACKUP_SPOOL_PRESSURE",
        "Other unpublished captures need bounded spool space.",
      );
    }
    if (old && old.versionId !== job.versionId) {
      t.abort();
      await end.catch(() => {});
      throw Error("BACKUP_CAPTURE_JOB_CHANGED");
    }
    const ledger = ((await request(
      meta.get(["versionBytes", job.versionId]),
    )) || { records: 0, parts: 0 }) as {
      records: number;
      parts: number;
      job?: number;
    };
    let rb = Number((await request(meta.get("recordBytes"))) || 0),
      pb = Number((await request(meta.get("partBytes"))) || 0),
      jb = Number((await request(meta.get("jobBytes"))) || 0);
    const hashes = new Set<string>(
      (await request(meta.get(["namespaceParts", job.versionId]))) || [],
    );
    for (const row of rows) {
      if (row.bytes.byteLength > BACKUP_V2_LIMITS.encodedRecordBytes) {
        t.abort();
        await end.catch(() => {});
        throw backupDeferred(
          "BACKUP_RECORD_TOO_LARGE",
          "This record exceeds the automatic backup limit.",
        );
      }
      const key = [job.versionId, row.id],
        prior = (await request(records.get(key))) as Uint8Array | undefined,
        delta = row.bytes.byteLength - (prior?.byteLength || 0);
      rb += delta;
      ledger.records += delta;
      records.put(row.bytes, key);
    }
    for (const part of newParts) {
      if (part.bytes.byteLength > BACKUP_V2_LIMITS.partBytes) {
        t.abort();
        await end.catch(() => {});
        throw Error("BACKUP_PART_INVALID");
      }
      const prior = (await request(parts.get(part.sha256))) as
          | Uint8Array
          | undefined,
        delta = part.bytes.byteLength - (prior?.byteLength || 0);
      pb += delta;
      ledger.parts += delta;
      parts.put(part.bytes, part.sha256);
      hashes.add(part.sha256);
    }
    const cursorKey =
      job.cursor && typeof job.cursor === "object" && "key" in job.cursor
        ? (job.cursor as { key?: IDBValidKey }).key
        : undefined;
    const jobBytes =
      new TextEncoder().encode(JSON.stringify({ ...job, partPage: undefined }))
        .byteLength +
      (job.partPage
        ? (job.partPageBytes ??
          new TextEncoder().encode(JSON.stringify(job.partPage)).byteLength)
        : 0) +
      (cursorKey === undefined ? 0 : measureBackupNativeKey(cursorKey));
    jb += jobBytes - (ledger.job ?? 0);
    ledger.job = jobBytes;
    if (
      rb + pb + jb > 16 * 1024 * 1024 ||
      ledger.records > BACKUP_V2_LIMITS.cycleBytes ||
      ledger.parts > BACKUP_V2_LIMITS.cycleBytes
    ) {
      t.abort();
      await end.catch(() => {});
      throw backupDeferred(
        ledger.records > BACKUP_V2_LIMITS.cycleBytes ||
          ledger.parts > BACKUP_V2_LIMITS.cycleBytes
          ? "BACKUP_NAMESPACE_BUDGET"
          : "BACKUP_SPOOL_PRESSURE",
        "Unpublished backup work reached its bounded preparation limit; native saves continue.",
      );
    }
    meta.put(rb, "recordBytes");
    meta.put(pb, "partBytes");
    meta.put(jb, "jobBytes");
    meta.put(ledger, ["versionBytes", job.versionId]);
    meta.put([...hashes], ["namespaceParts", job.versionId]);
    t.objectStore("jobs").put(job);
    await end;
  }
  const spool: BackupSpool = {
    head: async () =>
      (await get<BackupLocalHead>("meta", "head")) || emptyHead(),
    saveHead: (h) => put("meta", "head", h),
    pending: async () =>
      (await get<PreparedBackup>("meta", "prepared")) || null,
    async prepare(value) {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        s = t.objectStore("meta"),
        old = (await request(s.get("prepared"))) as PreparedBackup | undefined;
      if (
        old &&
        (old.manifest.manifestDigest !== value.manifest.manifestDigest ||
          canonicalBackupJSON(old.manifest) !==
            canonicalBackupJSON(value.manifest))
      ) {
        t.abort();
        await end.catch(() => {});
        throw Error("BACKUP_PREPARED_IDENTITY_CHANGED");
      }
      s.put(value, "prepared");
      await end;
    },
    async abandonPrepared(id, digest, notBefore) {
      const t = await tx(["meta", "schedule", "jobs"], "readwrite"),
        end = done(t),
        meta = t.objectStore("meta"),
        p = (await request(meta.get("prepared"))) as PreparedBackup | undefined;
      if (!p) {
        await end;
        return;
      }
      if (
        p.manifest.checkpointId !== id ||
        p.manifest.manifestDigest !== digest ||
        p.cancellation?.code !== "BACKUP_CATALOG_FULL"
      ) {
        t.abort();
        await end.catch(() => {});
        throw Error("BACKUP_CANCELLATION_IDENTITY_MISMATCH");
      }
      const rejected = new Set(p.cancellation.rejectedNamespaceVersionIds),
        schedule = t.objectStore("schedule");
      const invalidated = new Set<string>(
        (await request(meta.get("invalidatedVersions"))) || [],
      );
      for (const coverage of p.coverages) {
        const job = (await request(
          t.objectStore("jobs").get(coverage.sourceId),
        )) as BackupCaptureJob | undefined;
        if (job?.versionId === coverage.namespaceVersionId)
          t.objectStore("jobs").put({ ...job, invalidated: true });
        invalidated.add(coverage.namespaceVersionId);
      }
      meta.put([...invalidated], "invalidatedVersions");
      for (const c of p.coverages)
        if (rejected.has(c.namespaceVersionId)) {
          const old = (await request(schedule.get(c.sourceId))) as
            | BackupFairEntry
            | undefined;
          schedule.put({
            priority: 0,
            hintVersion: 0,
            lastServedTurn: 0,
            ...old,
            sourceId: c.sourceId,
            nextEligibleAt: notBefore,
            reason: "BACKUP_CATALOG_FULL",
          });
        }
      const head = ((await request(meta.get("head"))) ??
        emptyHead()) as BackupLocalHead;
      meta.put(
        {
          ...head,
          cancellationAdoptionPending: {
            checkpointId: id,
            manifestDigest: digest,
            sequence: p.manifest.sequence,
            parentCheckpointId: p.manifest.parentCheckpointId,
          },
        },
        "head",
      );
      meta.delete("prepared");
      await end;
    },
    async usage() {
      const t = await tx(["meta", "jobs"]),
        end = done(t),
        meta = t.objectStore("meta");
      const [rb, pb, jb, jobs, completed] = await Promise.all([
        request(meta.get("recordBytes")),
        request(meta.get("partBytes")),
        request(meta.get("jobBytes")),
        request(t.objectStore("jobs").count()),
        request(t.objectStore("jobs").index("phase").count("done")),
      ]);
      await end;
      return {
        recordBytes: Number(rb || 0),
        partBytes: Number(pb || 0),
        jobBytes: Number(jb || 0),
        jobs,
        partialJobs: jobs - completed,
      };
    },
    async finish(receipt, namespaceHeads, namespaceIncarnations = {}) {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        s = t.objectStore("meta"),
        p = (await request(s.get("prepared"))) as PreparedBackup | undefined;
      if (
        !p ||
        p.manifest.checkpointId !== receipt.checkpointId ||
        p.manifest.manifestDigest !== receipt.manifestDigest ||
        p.manifest.sequence !== receipt.sequence
      ) {
        t.abort();
        await end.catch(() => {});
        throw Error("BACKUP_LOCAL_RECEIPT_MISMATCH");
      }
      const previous = ((await request(s.get("head"))) ??
        emptyHead()) as BackupLocalHead;
      s.put(
        {
          ...previous,
          registered: true,
          sequence: receipt.sequence,
          checkpointId: receipt.checkpointId,
          adoptedThrough: receipt.sequence,
          namespaceHeads,
          namespaceIncarnations,
          adoptionPending: {
            adoptedThrough: receipt.sequence,
            checkpointId: receipt.checkpointId,
            manifestDigest: receipt.manifestDigest,
          },
          lastReceipt: receipt,
        } satisfies BackupLocalHead,
        "head",
      );
      s.delete("prepared");
      await end;
      for (const ns of p.manifest.namespaces)
        await discard(ns.namespaceVersionId);
    },
    async putRecord(versionId, id, bytes) {
      const existing = await get<BackupCaptureJob>(
        "jobs",
        "legacy:" + versionId,
      );
      const initial = {} as LocalDirtyControl;
      const job =
        existing ||
        ({
          format: 1,
          sourceId: "legacy:" + versionId,
          versionId,
          parentVersionId: null,
          baseline: true,
          initial,
          phase: "scan",
          scanKind: "baseline",
          scanAfter: 0,
          scanTarget: 0,
          target: 0,
          pass: 0,
          parts: [],
          updatedAt: Date.now(),
        } as BackupCaptureJob);
      await commit(job, [{ id, bytes }]);
    },
    async *records(versionId, after) {
      let cursor: IDBValidKey | undefined = after
        ? [versionId, after]
        : undefined;
      for (;;) {
        const t = await tx(["records"]),
          end = done(t),
          range = cursor
            ? IDBKeyRange.bound(cursor, [versionId, []], true, false)
            : versionRange(versionId);
        const rows = await new Promise<Array<{
          key: IDBValidKey;
          value: Uint8Array;
        }>>((res, rej) => {
          const page: Array<{ key: IDBValidKey; value: Uint8Array }> = [];
          let bytes = 0;
          const r = t.objectStore("records").openCursor(range);
          r.onerror = () => rej(r.error);
          r.onsuccess = () => {
            const current = r.result;
            if (!current) { res(page); return; }
            const value = current.value as Uint8Array;
            page.push({ key: current.primaryKey, value });
            bytes += value.byteLength;
            // Captured records are already eligibility-bounded. A single
            // existing record may exceed this page target (at most1MiB); stop
            // before reading another, rather than prefetching a large batch.
            if (page.length >= 32 || bytes >= 256 * 1024) res(page);
            else current.continue();
          };
        });
        await end;
        if (!rows.length) return;
        cursor = rows.at(-1)!.key;
        for (const row of rows)
          yield { id: String((row.key as IDBValidKey[])[1]), bytes: row.value };
      }
    },
    discardNamespace: discard,
    async putPart(hash, bytes, versionId) {
      if (!versionId) throw Error("BACKUP_PART_NAMESPACE_REQUIRED");
      const t = await tx(["jobs"]),
        end = done(t),
        job = (await request(
          t.objectStore("jobs").index("version").get(versionId),
        )) as BackupCaptureJob | undefined;
      await end;
      if (!job) throw Error("BACKUP_CAPTURE_JOB_MISSING");
      await commit(job, [], [{ sha256: hash, bytes }]);
    },
    async part(hash) {
      const bytes = await get<Uint8Array>("parts", hash);
      if (!bytes) throw Error("BACKUP_PREPARED_PART_MISSING");
      return bytes;
    },
    async clearUnprepared() {
      if (await get("meta", "prepared")) return;
      if (
        (await get<BackupLocalHead>("meta", "head"))
          ?.cancellationAdoptionPending
      )
        return;
      for (const id of (await get<string[]>("meta", "invalidatedVersions")) ||
        [])
        await discard(id);
      const t = await tx(["jobs", "records", "parts", "meta"], "readwrite"),
        end = done(t);
      if ((await request(t.objectStore("jobs").count())) === 0) {
        t.objectStore("records").clear();
        t.objectStore("parts").clear();
        const s = t.objectStore("meta");
        s.put(0, "recordBytes");
        s.put(0, "partBytes");
        s.put(0, "jobBytes");
        s.delete(IDBKeyRange.bound(["namespaceParts"], ["namespaceParts", []]));
        s.delete(IDBKeyRange.bound(["versionBytes"], ["versionBytes", []]));
      }
      await end;
    },
    async workSources(limit, now = Date.now()) {
      const rows: Array<{ sourceId: string; complete: boolean }> = [];
      for (const phase of [
        "done",
        "parts",
        "seal",
        "catchup",
        "scan",
        "schema",
      ]) {
        let after: IDBValidKey | undefined;
        for (;;) {
          if (rows.length >= limit) return rows;
          const t = await tx(["jobs", "schedule"]),
            end = done(t),
            keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
              const found: IDBValidKey[] = [];
              let jumped = false;
              const r = t
                .objectStore("jobs")
                .index("phase")
                .openKeyCursor(IDBKeyRange.only(phase));
              r.onerror = () => reject(r.error);
              r.onsuccess = () => {
                const c = r.result;
                if (!c || found.length >= 64) {
                  resolve(found);
                  return;
                }
                if (
                  after !== undefined &&
                  factory.cmp(c.primaryKey, after) <= 0
                ) {
                  if (!jumped && factory.cmp(c.primaryKey, after) < 0) {
                    jumped = true;
                    c.continuePrimaryKey(phase, after);
                    return;
                  }
                  c.continue();
                  return;
                }
                found.push(c.primaryKey);
                c.continue();
              };
            });
          const entries = await Promise.all(
            keys.map((key) => request(t.objectStore("schedule").get(key))),
          );
          await end;
          for (let i = 0; i < keys.length; i++)
            if (!entries[i] || entries[i].nextEligibleAt <= now) {
              rows.push({
                sourceId: String(keys[i]),
                complete: phase === "done",
              });
              if (rows.length >= limit) return rows;
            }
          if (keys.length < 64) break;
          after = keys.at(-1);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      return rows;
    },
    captureJob: async (sourceId) =>
      (await get<BackupCaptureJob>("jobs", sourceId)) || null,
    commitCapture: commit,
    async dropCapture(sourceId) {
      const job = await get<BackupCaptureJob>("jobs", sourceId);
      if (job) await discard(job.versionId);
    },
    async requireBaselines(identity) {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        meta = t.objectStore("meta");
      let epoch = await request(meta.get(["baselineReset", identity]));
      if (!epoch) {
        epoch = Number((await request(meta.get("baselineEpoch"))) || 0) + 1;
        meta.put(epoch, ["baselineReset", identity]);
        meta.put(epoch, "baselineEpoch");
      }
      await end;
      let after: IDBValidKey | undefined;
      for (;;) {
        const t = await tx(["schedule"], "readwrite"),
          end = done(t),
          store = t.objectStore("schedule"),
          rows = (await request(
            store.getAll(
              after ? IDBKeyRange.lowerBound(after, true) : undefined,
              64,
            ),
          )) as BackupFairEntry[];
        for (const row of rows) {
          after = row.sourceId;
          if ((row.baselineEpoch ?? 0) < Number(epoch))
            store.put({
              ...row,
              baselineEpoch: Number(epoch),
              priority: 0,
              tier: 0,
              nextEligibleAt: 0,
              reason: undefined,
            });
        }
        await end;
        if (rows.length < 64) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    requestDiscovery: () => put("meta", "discoveryRequested", true),
    async beginDiscovery() {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        meta = t.objectStore("meta"),
        old = (await request(meta.get("discoveryCursor"))) as
          | BackupDiscoveryCursor
          | undefined,
        requested = await request(meta.get("discoveryRequested"));
      let cursor = old;
      if (!cursor || (cursor.phase === "done" && requested)) {
        cursor = { phase: "local" };
        meta.put(cursor, "discoveryCursor");
        meta.put(false, "discoveryRequested");
      }
      await end;
      return cursor;
    },
    discoveryCursor: () =>
      get<BackupDiscoveryCursor>("meta", "discoveryCursor"),
    saveDiscoveryCursor: (cursor) => put("meta", "discoveryCursor", cursor),
    async touchSources(descriptors, cursor) {
      const t = await tx(["schedule", "meta"], "readwrite"),
        end = done(t),
        s = t.objectStore("schedule"),
        meta = t.objectStore("meta"),
        turn = Number((await request(meta.get("fairTurn"))) || 0),
        baselineEpoch = Number((await request(meta.get("baselineEpoch"))) || 0);
      for (const descriptor of descriptors) {
        const old = (await request(s.get(descriptor.id))) as
          | BackupFairEntry
          | undefined;
        s.put(
          old
            ? {
                ...old,
                descriptor,
                scope: sourceScope(descriptor),
                ...((old.baselineEpoch ?? 0) < baselineEpoch
                  ? { baselineEpoch, priority: 0, nextEligibleAt: 0 }
                  : {}),
              }
            : {
                sourceId: descriptor.id,
                descriptor,
                scope: sourceScope(descriptor),
                dirtySinceTurn: turn,
                priority: 0,
                tier: baselineEpoch ? 0 : 1,
                hintVersion: 0,
                baselineEpoch,
                acknowledgedBaselineEpoch: 0,
                lastServedTurn: 0,
                nextEligibleAt: 0,
              },
        );
      }
      if (cursor) meta.put(cursor, "discoveryCursor");
      await end;
    },
    async fairSources(limit, now) {
      const read = async (tier: number) => {
        const result: BackupFairEntry[] = [];
        let after: IDBValidKey | undefined;
        for (;;) {
          const t = await tx(["schedule"]),
            end = done(t),
            rows = (await request(
              t
                .objectStore("schedule")
                .index("fair")
                .getAll(
                  after
                    ? IDBKeyRange.bound(after, [0, tier, []], true, false)
                    : IDBKeyRange.bound([0, tier], [0, tier, []]),
                  64,
                ),
            )) as BackupFairEntry[];
          await end;
          for (const row of rows) {
            after = [0, tier, row.lastServedTurn, row.sourceId];
            if (row.nextEligibleAt <= now && row.descriptor) result.push(row);
            if (result.length >= limit) return result;
          }
          if (rows.length < 64) return result;
          await new Promise((r) => setTimeout(r, 0));
        }
      };
      const known = await read(0),
        unknown = await read(1),
        share = Math.ceil(limit / 2);
      return [
        ...known.slice(0, share),
        ...unknown.slice(0, limit - share),
        ...known.slice(share),
        ...unknown.slice(limit - share),
      ].slice(0, limit);
    },
    async fairState(ids) {
      const rows: BackupFairEntry[] = [];
      for (let i = 0; i < ids.length; i += 64) {
        const t = await tx(["schedule"]),
          end = done(t);
        const page = await Promise.all(
          ids
            .slice(i, i + 64)
            .map((id) => request(t.objectStore("schedule").get(id))),
        );
        await end;
        for (const row of page) if (row) rows.push(row);
        if (i + 64 < ids.length) await new Promise((r) => setTimeout(r, 0));
      }
      return rows;
    },
    async markServed(id, patch = {}) {
      const t = await tx(["schedule", "meta"], "readwrite"),
        end = done(t),
        s = t.objectStore("schedule"),
        old = (await request(s.get(id))) as BackupFairEntry | undefined,
        meta = t.objectStore("meta"),
        turn = Number((await request(meta.get("fairTurn"))) || 0) + 1;
      meta.put(turn, "fairTurn");
      const expected = (
        patch as Partial<BackupFairEntry> & { expectedHintVersion?: number }
      ).expectedHintVersion;
      const safe = { ...patch } as Partial<BackupFairEntry> & {
        expectedHintVersion?: number;
      };
      delete safe.expectedHintVersion;
      if (expected !== undefined && expected !== (old?.hintVersion ?? 0)) {
        delete safe.priority;
        delete safe.tier;
        delete safe.dirtySinceTurn;
        safe.nextEligibleAt = 0;
      }
      if (
        safe.priority === 1 &&
        (old?.baselineEpoch ?? 0) >
          (safe.acknowledgedBaselineEpoch ??
            old?.acknowledgedBaselineEpoch ??
            0)
      ) {
        safe.priority = 0;
        safe.tier = 0;
        delete safe.dirtySinceTurn;
      }
      if (safe.priority === 1) safe.tier = 2;
      else if (safe.priority === 0 && safe.observedGeneration !== undefined)
        safe.tier = 0;
      s.put({
        priority: 0,
        tier: 1,
        hintVersion: 0,
        ...old,
        sourceId: id,
        dirtySinceTurn: old?.dirtySinceTurn ?? turn,
        lastServedTurn: turn,
        nextEligibleAt: 0,
        ...safe,
      });
      await end;
    },
    async probeAll() {
      let after: IDBValidKey | undefined;
      for (;;) {
        const t = await tx(["schedule"], "readwrite"),
          end = done(t),
          store = t.objectStore("schedule"),
          rows = (await request(
            store.getAll(
              after ? IDBKeyRange.lowerBound(after, true) : undefined,
              64,
            ),
          )) as BackupFairEntry[];
        for (const row of rows) {
          after = row.sourceId;
          store.put({
            ...row,
            priority: 0,
            tier: row.priority === 0 && row.tier === 0 ? 0 : 1,
            nextEligibleAt: [
              "BACKUP_CATALOG_FULL",
              "BACKUP_SPOOL_EVICTED",
            ].includes(row.reason ?? "")
              ? row.nextEligibleAt
              : 0,
          });
        }
        await end;
        if (rows.length < 64) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    async hintSources(ids) {
      const t = await tx(["schedule", "meta"], "readwrite"),
        end = done(t),
        s = t.objectStore("schedule"),
        turn = Number(
          (await request(t.objectStore("meta").get("fairTurn"))) || 0,
        );
      for (const id of new Set(ids)) {
        const old = (await request(s.get(id))) as BackupFairEntry | undefined;
        s.put({
          ...old,
          sourceId: id,
          priority: 0,
          tier: 0,
          hintVersion: (old?.hintVersion ?? 0) + 1,
          dirtySinceTurn: old?.dirtySinceTurn ?? turn,
          lastServedTurn: old?.lastServedTurn ?? 0,
          nextEligibleAt: [
            "BACKUP_CATALOG_FULL",
            "BACKUP_SPOOL_EVICTED",
          ].includes(old?.reason ?? "")
            ? (old?.nextEligibleAt ?? 0)
            : 0,
        });
      }
      await end;
    },
    async hintScope(scope) {
      let after: IDBValidKey | undefined;
      for (;;) {
        const t = await tx(["schedule"]),
          end = done(t),
          s = t.objectStore("schedule"),
          range =
            scope === undefined
              ? after
                ? IDBKeyRange.lowerBound(after, true)
                : undefined
              : IDBKeyRange.only(scope),
          keys =
            scope === undefined
              ? await request(s.getAllKeys(range, 64))
              : await new Promise<IDBValidKey[]>((resolve, reject) => {
                  const values: IDBValidKey[] = [];
                  const r = s.index("scope").openKeyCursor(range);
                  let jumped = false;
                  r.onerror = () => reject(r.error);
                  r.onsuccess = () => {
                    const c = r.result;
                    if (!c || values.length >= 64) {
                      resolve(values);
                      return;
                    }
                    if (
                      after !== undefined &&
                      factory.cmp(c.primaryKey, after) <= 0
                    ) {
                      if (!jumped && factory.cmp(c.primaryKey, after) < 0) {
                        jumped = true;
                        c.continuePrimaryKey(scope!, after);
                        return;
                      }
                      c.continue();
                      return;
                    }
                    values.push(c.primaryKey);
                    c.continue();
                  };
                });
        await end;
        const page =
          scope === undefined
            ? keys
            : keys
                .filter(
                  (key) => after === undefined || factory.cmp(key, after) > 0,
                )
                .slice(0, 64);
        if (!page.length) return;
        await spool.hintSources!(page.map(String));
        after = page.at(-1);
        if (page.length < 64) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    async hasQueuedSources() {
      if (await get("meta", "discoveryRequested")) return true;
      const cursor = await get<BackupDiscoveryCursor>(
        "meta",
        "discoveryCursor",
      );
      if (cursor && cursor.phase !== "done") return true;
      const t = await tx(["schedule"]),
        end = done(t),
        n = await request(
          t
            .objectStore("schedule")
            .index("order")
            .count(IDBKeyRange.bound([0], [0, []])),
        );
      await end;
      return n > 0;
    },
    async cycle() {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        s = t.objectStore("meta"),
        n = Number((await request(s.get("cycle"))) || 0) + 1;
      s.put(n, "cycle");
      await end;
      return n;
    },
    async clearPressureSource(sourceId) {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        meta = t.objectStore("meta");
      if ((await request(meta.get("pressureSource"))) === sourceId)
        meta.delete("pressureSource");
      await end;
    },
    pressureSource: () => get<string>("meta", "pressureSource"),
    async claimPressureSource(sourceId) {
      const t = await tx(["meta"], "readwrite"),
        end = done(t),
        meta = t.objectStore("meta"),
        current = await request(meta.get("pressureSource"));
      if (!current) meta.put(sourceId, "pressureSource");
      await end;
      return current || sourceId;
    },
    async evictPartial(except, deferUntil = 0) {
      const t = await tx(["jobs", "meta"]),
        end = done(t),
        p = (await request(t.objectStore("meta").get("prepared"))) as
          | PreparedBackup
          | undefined;
      let found: BackupCaptureJob | undefined;
      await new Promise<void>((res, rej) => {
        const r = t.objectStore("jobs").index("age").openCursor();
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c) {
            res();
            return;
          }
          const j = c.value as BackupCaptureJob;
          if (
            j.sourceId !== except &&
            !pinned(p, j.versionId) &&
            j.phase !== "done"
          ) {
            found = j;
            res();
            return;
          }
          c.continue();
        };
      });
      await end;
      if (!found) return false;
      await discard(found.versionId);
      if (deferUntil)
        await spool.markServed!(found.sourceId, {
          nextEligibleAt: deferUntil,
          reason: "BACKUP_SPOOL_EVICTED",
        });
      return true;
    },
    dispose() {
      stopped = true;
      void database.then((d) => d.close()).catch(() => {});
    },
  };
  return spool;
}
