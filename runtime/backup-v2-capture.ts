import { encodePortableValue, type PortableGraph } from "./hub-contracts.ts";
import { encodeBackupKey, type BackupKey } from "./backup-v2-keys.ts";
import {
  BACKUP_V2_LIMITS,
  backupDeferred,
  backupSHA256,
  canonicalBackupJSON,
  type BackupNamespace,
  type BackupNamespaceVersion,
  type BackupPartEnvelope,
} from "./backup-v2-contracts.ts";
import type { LocalDirtyControl } from "./local-dirty-v2.ts";
import type { BackupSpool } from "./backup-v2-spool.ts";
export type BackupSourceRecord = {
  operation: "put" | "delete" | "clear-store" | "schema";
  store: string;
  key?: IDBValidKey;
  value?: unknown;
  generation: number;
  storeEpoch?: number;
  estimatedNativeBytes?: number;
  shapeEligible?: boolean;
};
export type BackupSourcePage = {
  records: BackupSourceRecord[];
  cursor?: unknown;
  done: boolean;
};
export type BackupSource = {
  id: string;
  namespace: BackupNamespace;
  readControl(): Promise<LocalDirtyControl>;
  schema(): Promise<unknown>;
  scanBaseline(
    cursor: unknown,
    limits: { maxRecords: number; maxBytes: number; deadlineMs: number },
  ): Promise<BackupSourcePage>;
  scanChanges(
    after: number,
    target: number,
    cursor: unknown,
    limits: { maxRecords: number; maxBytes: number; deadlineMs: number },
  ): Promise<BackupSourcePage>;
  seal(
    expected: Pick<
      LocalDirtyControl,
      "generation" | "schemaEpoch" | "trackingEpoch"
    >,
  ): Promise<false | { schema: unknown }>;
  acknowledge(cut: number, trackingEpoch: number): Promise<void>;
  maintain?(): Promise<void>;
};
export type BackupEncodedRecord = {
  operation: BackupSourceRecord["operation"];
  store: string;
  key?: BackupKey;
  value?: PortableGraph;
  generation: number;
  storeEpoch?: number;
};
/** Check native shape and size BEFORE portable graph/Blob.arrayBuffer creation.
 * This is conservative eligibility, not a persistent storage quota. */
export function preflightBackupRecord(
  value: unknown,
  maxBytes = BACKUP_V2_LIMITS.nativeRecordBytes,
): number {
  let bytes = 0,
    nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > BACKUP_V2_LIMITS.recordNodes || depth > 64)
      throw backupDeferred(
        "BACKUP_RECORD_SHAPE",
        "This save exceeds the automatic record complexity budget.",
      );
    if (
      v === null ||
      v === undefined ||
      typeof v === "boolean" ||
      typeof v === "number"
    )
      bytes += 16;
    else if (typeof v === "string") bytes += 32 + v.length * 2;
    else if (typeof v === "bigint") bytes += 32 + v.toString().length * 2;
    else if (typeof v !== "object")
      throw backupDeferred(
        "BACKUP_RECORD_UNSUPPORTED",
        "This value cannot be automatically backed up.",
      );
    else if (seen.has(v)) bytes += 8;
    else {
      seen.add(v);
      bytes += 64;
      if (v instanceof Blob) bytes += v.size;
      else if (v instanceof ArrayBuffer) bytes += v.byteLength;
      else if (ArrayBuffer.isView(v)) {
        visit(v.buffer, depth + 1);
        bytes += 32;
      } else if (v instanceof Date || v instanceof RegExp) bytes += 32;
      else if (v instanceof Map)
        for (const [key, item] of v) {
          visit(key, depth + 1);
          visit(item, depth + 1);
        }
      else if (v instanceof Set) for (const item of v) visit(item, depth + 1);
      else {
        const proto = Object.getPrototypeOf(v);
        if (!Array.isArray(v) && proto !== Object.prototype && proto !== null)
          throw backupDeferred(
            "BACKUP_RECORD_UNSUPPORTED",
            "This value cannot be automatically backed up.",
          );
        for (const key in v)
          if (Object.prototype.hasOwnProperty.call(v, key)) {
            const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
            if (!("value" in descriptor))
              throw backupDeferred(
                "BACKUP_RECORD_ACCESSOR",
                "Accessor values require manual conversion.",
              );
            bytes += 32 + key.length * 2;
            visit(descriptor.value, depth + 1);
            if (bytes > maxBytes)
              throw backupDeferred(
                "BACKUP_RECORD_TOO_LARGE",
                "This save remains local because it exceeds the automatic memory budget.",
              );
          }
      }
    }
    if (bytes > maxBytes)
      throw backupDeferred(
        "BACKUP_RECORD_TOO_LARGE",
        "This save remains local because it exceeds the automatic memory budget.",
      );
  };
  visit(value, 0);
  return bytes;
}
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export type BackupCodecBudget = { used: number; limit: number };
export function reserveBackupCodecWork(
  budget: BackupCodecBudget | undefined,
  maxBytes: number,
) {
  if (budget && budget.used + maxBytes > budget.limit)
    throw backupDeferred(
      "BACKUP_CYCLE_BUDGET",
      "Automatic backup encoding will continue in another bounded cycle.",
    );
}
export function consumeBackupCodecWork(
  budget: BackupCodecBudget | undefined,
  bytes: number,
) {
  if (budget) budget.used += bytes;
}
export type CaptureOptions = {
  workBudget?: BackupCodecBudget;
  now?: () => number;
  yield?: () => Promise<void>;
  signal?: AbortSignal;
  deadlineAt?: number;
  visitMs?: number;
  visitBytes?: number;
};
export async function captureBackupNamespace(
  source: BackupSource,
  spool: BackupSpool,
  parentNamespaceVersionId: string | null,
  options: CaptureOptions = {},
): Promise<{
  version: BackupNamespaceVersion;
  trackingEpoch: number;
  localIncarnation: string;
}> {
  if (spool.captureJob && spool.commitCapture && spool.dropCapture) {
    const { resumeBackupNamespace } = await import("./backup-v2-resume.ts");
    return resumeBackupNamespace(
      source,
      spool,
      parentNamespaceVersionId,
      options,
    );
  }
  const now = options.now ?? (() => performance.now()),
    yieldWork = options.yield ?? yieldTurn;
  const start = now(),
    deadline = Math.min(
      options.deadlineAt ?? Infinity,
      start + BACKUP_V2_LIMITS.prepareMs,
    );
  const versionId = crypto.randomUUID();
  const check = () => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (now() > deadline)
      throw backupDeferred(
        "BACKUP_CAPTURE_BUSY",
        "This website stayed busy; its backup will be attempted later.",
      );
  };
  const initial = await source.readControl();
  const baseline = !parentNamespaceVersionId || initial.baselineRequired;
  if (
    initial.generation <= initial.acknowledgedGeneration &&
    parentNamespaceVersionId
  )
    throw backupDeferred("BACKUP_NOT_DIRTY", "No changes need backup.");
  let lastYield = now();
  async function add(record: BackupSourceRecord) {
    check();
    reserveBackupCodecWork(
      options.workBudget,
      BACKUP_V2_LIMITS.encodedRecordBytes,
    );
    if (record.operation === "put") {
      if (
        record.estimatedNativeBytes === undefined ||
        !Number.isSafeInteger(record.estimatedNativeBytes) ||
        record.estimatedNativeBytes > BACKUP_V2_LIMITS.nativeRecordBytes ||
        record.shapeEligible === false
      )
        throw backupDeferred(
          "BACKUP_RECORD_UNSIZED",
          "This save has no safe automatic size metadata and remains local.",
        );
      preflightBackupRecord(record.value);
    }
    const key =
      record.key === undefined ? undefined : encodeBackupKey(record.key);
    const encoded: BackupEncodedRecord = {
      operation: record.operation,
      store: record.store,
      ...(key ? { key } : {}),
      ...(["put", "schema"].includes(record.operation)
        ? { value: await encodePortableValue(record.value) }
        : {}),
      generation: record.generation,
      ...(record.storeEpoch === undefined
        ? {}
        : { storeEpoch: record.storeEpoch }),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(encoded));
    consumeBackupCodecWork(options.workBudget, bytes.byteLength);
    if (bytes.byteLength > BACKUP_V2_LIMITS.encodedRecordBytes)
      throw backupDeferred(
        "BACKUP_RECORD_TOO_LARGE",
        "This encoded save exceeds the automatic backup budget.",
      );
    const recordId = await backupSHA256(
      canonicalBackupJSON({
        namespace: source.namespace,
        store: record.store,
        key: key || null,
        operationKey:
          record.operation === "schema"
            ? "schema"
            : record.operation === "clear-store"
              ? "clear"
              : "record",
      }),
    );
    await spool.putRecord(versionId, recordId, bytes);
    if (now() - lastYield >= 4) {
      await yieldWork();
      lastYield = now();
    }
  }
  async function scan(
    kind: "baseline" | "changes",
    after: number,
    target: number,
  ) {
    let cursor: unknown;
    for (;;) {
      check();
      const limits = {
        maxRecords: BACKUP_V2_LIMITS.pageRecords,
        maxBytes: BACKUP_V2_LIMITS.pageBytes,
        deadlineMs: 4,
      };
      const page =
        kind === "baseline"
          ? await source.scanBaseline(cursor, limits)
          : await source.scanChanges(after, target, cursor, limits);
      if (
        !page ||
        !Array.isArray(page.records) ||
        page.records.length > limits.maxRecords ||
        (!page.done && page.cursor === undefined)
      )
        throw Error("BACKUP_CAPTURE_PAGE_INVALID");
      for (const record of page.records) await add(record);
      if (page.done) return;
      cursor = page.cursor;
      await yieldWork();
      lastYield = now();
    }
  }
  try {
    if (!initial.deleted) {
      const schema = await source.schema();
      preflightBackupRecord(schema);
      await add({
        operation: "schema",
        store: "",
        value: schema,
        generation: initial.generation,
      });
    }
    if (!initial.deleted)
      await scan(
        baseline ? "baseline" : "changes",
        initial.acknowledgedGeneration,
        initial.generation,
      );
    let target = initial.generation,
      final = initial;
    let sealed = false;
    for (let pass = 0; pass < BACKUP_V2_LIMITS.catchupPasses; pass++) {
      check();
      final = await source.readControl();
      if (
        final.incarnation !== initial.incarnation ||
        final.schemaEpoch !== initial.schemaEpoch ||
        final.trackingEpoch !== initial.trackingEpoch ||
        final.deleted !== initial.deleted
      )
        throw backupDeferred(
          "BACKUP_CAPTURE_CHANGED",
          "The website schema changed; backup is deferred.",
        );
      if (final.generation > target) {
        await scan("changes", target, final.generation);
        target = final.generation;
        continue;
      }
      if (final.generation !== target)
        throw Error("BACKUP_GENERATION_REGRESSED");
      const cut = await source.seal({
        generation: target,
        schemaEpoch: final.schemaEpoch,
        trackingEpoch: final.trackingEpoch,
      });
      if (cut) {
        if (!initial.deleted) {
          preflightBackupRecord(cut.schema);
          await add({
            operation: "schema",
            store: "",
            value: cut.schema,
            generation: target,
          });
        }
        sealed = true;
        break;
      }
    }
    if (!sealed)
      throw backupDeferred(
        "BACKUP_CAPTURE_BUSY",
        "This website stayed busy; backup is deferred without blocking local saves.",
      );
    const parts: Array<{ ordinal: number; sha256: string; bytes: number }> = [];
    let page: BackupPartEnvelope = {
      format: "atlas-record-page-v2",
      namespaceVersionId: versionId,
      records: [],
    };
    async function flushPage() {
      if (!page.records.length) return;
      check();
      if (parts.length >= 32)
        throw backupDeferred(
          "BACKUP_CYCLE_BUDGET",
          "This save exceeds the automatic upload budget.",
        );
      reserveBackupCodecWork(options.workBudget, BACKUP_V2_LIMITS.partBytes);
      const bytes = new TextEncoder().encode(JSON.stringify(page));
      consumeBackupCodecWork(options.workBudget, bytes.byteLength);
      if (bytes.byteLength > BACKUP_V2_LIMITS.partBytes)
        throw Error("BACKUP_PART_BUILD_INVALID");
      const hash = await backupSHA256(bytes);
      await spool.putPart(hash, bytes, versionId);
      parts.push({
        ordinal: parts.length,
        sha256: hash,
        bytes: bytes.byteLength,
      });
      page = {
        format: "atlas-record-page-v2",
        namespaceVersionId: versionId,
        records: [],
      };
    }
    for await (const record of spool.records(versionId)) {
      check();
      const digest = await backupSHA256(record.bytes),
        count = Math.ceil(
          record.bytes.byteLength / BACKUP_V2_LIMITS.fragmentBytes,
        );
      for (let index = 0; index < count; index++) {
        const fragment = record.bytes.subarray(
          index * BACKUP_V2_LIMITS.fragmentBytes,
          (index + 1) * BACKUP_V2_LIMITS.fragmentBytes,
        );
        let raw = "";
        for (let p = 0; p < fragment.byteLength; p += 8192)
          raw += String.fromCharCode(...fragment.subarray(p, p + 8192));
        const item = {
          recordId: record.id,
          index,
          count,
          totalBytes: record.bytes.byteLength,
          sha256: digest,
          data: btoa(raw),
        };
        const candidate = { ...page, records: [...page.records, item] };
        if (
          page.records.length >= 256 ||
          new TextEncoder().encode(JSON.stringify(candidate)).byteLength >
            BACKUP_V2_LIMITS.partBytes
        )
          await flushPage();
        page.records.push(item);
      }
      await yieldWork();
    }
    await flushPage();
    return {
      version: {
        namespaceVersionId: versionId,
        parentNamespaceVersionId: baseline ? null : parentNamespaceVersionId,
        namespace: source.namespace,
        localCut: target,
        schemaEpoch: final.schemaEpoch,
        kind: initial.deleted ? "deleted" : baseline ? "baseline" : "delta",
        rootDigest: await backupSHA256(canonicalBackupJSON(parts)),
        parts,
        coverage: "complete-at-cut",
      },
      trackingEpoch: final.trackingEpoch,
      localIncarnation: final.incarnation,
    };
  } catch (error) {
    await spool.discardNamespace(versionId);
    throw error;
  }
}
