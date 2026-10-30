/** Durable optimistic capture. A slice checkpoints only spool records+cursor;
 * source writes never participate in, or wait for, this transaction. */
import { encodePortableValue } from "./hub-contracts.ts";
import { encodeBackupKey } from "./backup-v2-keys.ts";
import {
  BACKUP_V2_LIMITS,
  backupDeferred,
  backupSHA256,
  canonicalBackupJSON,
  type BackupPartEnvelope,
} from "./backup-v2-contracts.ts";
import type {
  BackupSource,
  BackupSourceRecord,
  CaptureOptions,
} from "./backup-v2-capture.ts";
import type {
  BackupSpool,
  BackupCaptureJob,
  SpoolRecord,
} from "./backup-v2-spool.ts";
import {
  preflightBackupRecord,
  reserveBackupCodecWork,
  consumeBackupCodecWork,
} from "./backup-v2-capture.ts";
const yieldTurn = () => new Promise<void>((r) => setTimeout(r, 0));
function proof(a: BackupCaptureJob["initial"], b: BackupCaptureJob["initial"]) {
  return (
    a.incarnation === b.incarnation &&
    a.schemaEpoch === b.schemaEpoch &&
    a.trackingEpoch === b.trackingEpoch &&
    a.deleted === b.deleted &&
    canonicalBackupJSON(a.storeEpochs) === canonicalBackupJSON(b.storeEpochs)
  );
}
export async function resumeBackupNamespace(
  source: BackupSource,
  spool: BackupSpool,
  parentVersionId: string | null,
  options: CaptureOptions,
) {
  const now = options.now ?? (() => performance.now()),
    start = now(),
    deadline = Math.min(
      options.deadlineAt ?? Infinity,
      start + BACKUP_V2_LIMITS.prepareMs,
    ),
    visitDeadline = Math.min(
      deadline,
      start + (options.visitMs ?? BACKUP_V2_LIMITS.prepareMs),
    ),
    visitBytes = options.visitBytes ?? Infinity,
    yieldWork = options.yield ?? yieldTurn;
  let workedBytes = 0,
    lastYield = now();
  const check = () => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (now() > deadline)
      throw backupDeferred(
        "BACKUP_CAPTURE_BUSY",
        "This site is queued for another bounded backup attempt.",
      );
  };
  const pause = () => {
    check();
    if (now() >= visitDeadline || workedBytes >= visitBytes)
      throw backupDeferred(
        "BACKUP_VISIT_YIELDED",
        "This site is queued for another bounded backup slice.",
      );
  };
  let job = await spool.captureJob!(source.id);
  if (job) {
    const current = await source.readControl();
    const sealed = job.phase === "parts" || job.phase === "done";
    if (
      job.invalidated ||
      job.versionId === parentVersionId ||
      job.parentVersionId !== parentVersionId ||
      job.initial.incarnation !== current.incarnation ||
      (!sealed && !proof(job.initial, current))
    ) {
      await spool.dropCapture!(source.id);
      job = null;
    }
  }
  if (!job) {
    const initial = await source.readControl();
    if (initial.generation <= initial.acknowledgedGeneration && parentVersionId)
      throw backupDeferred("BACKUP_NOT_DIRTY", "No changes need backup.");
    job = {
      format: 1,
      sourceId: source.id,
      versionId: crypto.randomUUID(),
      parentVersionId,
      baseline: !parentVersionId || initial.baselineRequired,
      initial,
      phase: "schema",
      scanKind:
        !parentVersionId || initial.baselineRequired ? "baseline" : "changes",
      scanAfter: initial.acknowledgedGeneration,
      scanTarget: initial.generation,
      target: initial.generation,
      pass: 0,
      parts: [],
      updatedAt: Date.now(),
    };
    await spool.commitCapture!(job);
  }
  async function encode(record: BackupSourceRecord): Promise<SpoolRecord> {
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
        record.key === undefined ? undefined : encodeBackupKey(record.key),
      encoded = {
        operation: record.operation,
        store: record.store,
        ...(key === undefined ? {} : { key }),
        ...(record.operation === "put" || record.operation === "schema"
          ? { value: await encodePortableValue(record.value) }
          : {}),
        generation: record.generation,
        ...(record.storeEpoch === undefined
          ? {}
          : { storeEpoch: record.storeEpoch }),
      },
      bytes = new TextEncoder().encode(JSON.stringify(encoded));
    consumeBackupCodecWork(options.workBudget, bytes.byteLength);
    if (bytes.byteLength > BACKUP_V2_LIMITS.encodedRecordBytes)
      throw backupDeferred(
        "BACKUP_RECORD_TOO_LARGE",
        "This record exceeds the automatic encoded backup limit.",
      );
    const id = await backupSHA256(
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
    workedBytes += bytes.byteLength;
    if (now() - lastYield >= 4) {
      await yieldWork();
      lastYield = now();
    }
    return { id, bytes };
  }
  async function commit(
    records: SpoolRecord[] = [],
    parts: Array<{ sha256: string; bytes: Uint8Array }> = [],
  ) {
    job!.updatedAt = Date.now();
    await spool.commitCapture!(job!, records, parts);
  }
  try {
    for (;;) {
      check();
      if (job.phase === "schema") {
        const rows: SpoolRecord[] = [];
        if (!job.initial.deleted) {
          const schema = await source.schema();
          preflightBackupRecord(schema);
          rows.push(
            await encode({
              operation: "schema",
              store: "",
              value: schema,
              generation: job.initial.generation,
            }),
          );
        }
        job.phase = job.initial.deleted ? "catchup" : "scan";
        await commit(rows);
        pause();
        continue;
      }
      if (job.phase === "scan") {
        const limits = { maxRecords: 64, maxBytes: 64 * 1024, deadlineMs: 4 },
          page =
            job.scanKind === "baseline"
              ? await source.scanBaseline(job.cursor, limits)
              : await source.scanChanges(
                  job.scanAfter,
                  job.scanTarget,
                  job.cursor,
                  limits,
                );
        if (
          !page ||
          !Array.isArray(page.records) ||
          page.records.length > 64 ||
          (!page.done && page.cursor === undefined)
        )
          throw Error("BACKUP_CAPTURE_PAGE_INVALID");
        const rows: SpoolRecord[] = [];
        for (const row of page.records) rows.push(await encode(row));
        job.cursor = page.cursor;
        if (page.done) {
          job.cursor = undefined;
          job.phase = "catchup";
        }
        await commit(rows);
        await yieldWork();
        lastYield = now();
        pause();
        continue;
      }
      if (job.phase === "catchup") {
        const current = await source.readControl();
        if (!proof(job.initial, current)) {
          await spool.dropCapture!(source.id);
          throw backupDeferred(
            "BACKUP_CAPTURE_CHANGED",
            "The site schema or tracking changed; its unpublished capture will restart.",
          );
        }
        if (current.generation < job.target)
          throw Error("BACKUP_GENERATION_REGRESSED");
        job.final = current;
        if (current.generation > job.target) {
          if (job.pass >= BACKUP_V2_LIMITS.catchupPasses) {
            await spool.dropCapture!(source.id);
            throw backupDeferred(
              "BACKUP_CAPTURE_BUSY",
              "This website changed continuously; its data remains local.",
            );
          }
          job.pass++;
          job.scanKind = "changes";
          job.scanAfter = job.target;
          job.scanTarget = current.generation;
          job.target = current.generation;
          job.cursor = undefined;
          job.phase = "scan";
        } else job.phase = "seal";
        await commit();
        pause();
        continue;
      }
      if (job.phase === "seal") {
        const current = job.final!,
          cut = await source.seal({
            generation: job.target,
            schemaEpoch: current.schemaEpoch,
            trackingEpoch: current.trackingEpoch,
          });
        if (!cut) {
          job.phase = "catchup";
          job.pass++;
          if (job.pass > BACKUP_V2_LIMITS.catchupPasses) {
            await spool.dropCapture!(source.id);
            throw backupDeferred(
              "BACKUP_CAPTURE_BUSY",
              "This website stayed busy; its data remains local.",
            );
          }
          await commit();
          pause();
          continue;
        }
        const rows: SpoolRecord[] = [];
        if (!job.initial.deleted) {
          preflightBackupRecord(cut.schema);
          rows.push(
            await encode({
              operation: "schema",
              store: "",
              value: cut.schema,
              generation: job.target,
            }),
          );
        }
        job.phase = "parts";
        job.partPage = {
          format: "atlas-record-page-v2",
          namespaceVersionId: job.versionId,
          records: [],
        };
        await commit(rows);
        pause();
        continue;
      }
      if (job.phase === "parts") {
        let pendingParts: Array<{ sha256: string; bytes: Uint8Array }> = [];
        let page: BackupPartEnvelope = job.partPage ?? {
          format: "atlas-record-page-v2",
          namespaceVersionId: job.versionId,
          records: [],
        };
        let pageBytes =
          job.partPageBytes ??
          new TextEncoder().encode(JSON.stringify(page)).byteLength;
        let batchRecords = 0,
          batchBytes = 0,
          batchStarted = now();
        const checkpoint = async () => {
          if (!batchRecords) return;
          job!.partPage = page;
          job!.partPageBytes = pageBytes;
          // The complete-record cursor, partial page, finished parts and usage
          // counters commit together. A lost response resumes this exact cut.
          await commit([], pendingParts);
          pendingParts = [];
          batchRecords = 0;
          batchBytes = 0;
          batchStarted = now();
        };
        const flush = async () => {
          if (!page.records.length) return;
          if (job!.parts.length >= 32)
            throw backupDeferred(
              "BACKUP_NAMESPACE_BUDGET",
              "This namespace exceeds the automatic part budget.",
            );
          reserveBackupCodecWork(options.workBudget, pageBytes);
          const bytes = new TextEncoder().encode(JSON.stringify(page));
          consumeBackupCodecWork(options.workBudget, bytes.byteLength);
          const sha256 = await backupSHA256(bytes);
          job!.parts.push({
            ordinal: job!.parts.length,
            sha256,
            bytes: bytes.byteLength,
          });
          page = {
            format: "atlas-record-page-v2",
            namespaceVersionId: job!.versionId,
            records: [],
          };
          job!.partPage = page;
          pageBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
          job!.partPageBytes = pageBytes;
          workedBytes += bytes.byteLength;
          pendingParts.push({ sha256, bytes });
        };
        let exhausted = true;
        let recordInProgress = false;
        try {
          for await (const record of spool.records(
            job.versionId,
            job.partsAfter,
          )) {
            check();
            if (
              batchRecords &&
              batchBytes + record.bytes.byteLength > 64 * 1024
            ) {
              await checkpoint();
              pause();
            }
            recordInProgress = true;
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
              const itemBytes = new TextEncoder().encode(
                JSON.stringify(item),
              ).byteLength;
              if (
                page.records.length >= 256 ||
                pageBytes + itemBytes + (page.records.length ? 1 : 0) >
                  BACKUP_V2_LIMITS.partBytes
              )
                await flush();
              pageBytes += itemBytes + (page.records.length ? 1 : 0);
              page.records.push(item);
            }
            job.partsAfter = record.id;
            recordInProgress = false;
            batchRecords++;
            batchBytes += record.bytes.byteLength;
            const visitEnded =
              now() >= visitDeadline || workedBytes >= visitBytes;
            // A single eligible record can exceed64KiB and span several parts.
            // It is isolated and committed whole: never persist half a record
            // with an unchanged partsAfter cursor and duplicate it on restart.
            if (
              batchRecords >= 32 ||
              batchBytes >= 64 * 1024 ||
              now() - batchStarted >= 100 ||
              pendingParts.length ||
              visitEnded ||
              options.signal?.aborted
            )
              await checkpoint();
            if (options.signal?.aborted) throw options.signal.reason;
            if (visitEnded) {
              exhausted = false;
              break;
            }
            if (now() - lastYield >= 4) {
              await yieldWork();
              lastYield = now();
            }
          }
        } catch (error) {
          // Cooperative pause/cancellation may arrive after an IO/yield. A
          // terminated worker instead simply redoes the bounded pending batch.
          if (
            !recordInProgress &&
            batchRecords &&
            (options.signal?.aborted ||
              (error as { code?: string })?.code === "BACKUP_CAPTURE_BUSY")
          )
            await checkpoint();
          throw error;
        }
        if (!exhausted) {
          pause();
          continue;
        }
        await flush();
        job.partPage = undefined;
        job.partPageBytes = undefined;
        const final = job.final ?? job.initial;
        job.result = {
          version: {
            namespaceVersionId: job.versionId,
            parentNamespaceVersionId: job.baseline ? null : job.parentVersionId,
            namespace: source.namespace,
            localCut: job.target,
            schemaEpoch: final.schemaEpoch,
            kind: job.initial.deleted
              ? "deleted"
              : job.baseline
                ? "baseline"
                : "delta",
            rootDigest: await backupSHA256(canonicalBackupJSON(job.parts)),
            parts: job.parts,
            coverage: "complete-at-cut",
          },
          trackingEpoch: final.trackingEpoch,
          localIncarnation: final.incarnation,
        };
        job.phase = "done";
        await commit([], pendingParts);
      }
      if (job.phase === "done") return job.result!;
    }
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (
      [
        "BACKUP_NAMESPACE_BUDGET",
        "BACKUP_RECORD_TOO_LARGE",
        "BACKUP_RECORD_UNSIZED",
        "BACKUP_RECORD_SHAPE",
        "BACKUP_RECORD_UNSUPPORTED",
        "BACKUP_RECORD_ACCESSOR",
      ].includes(code || "")
    )
      await spool.dropCapture!(source.id);
    throw error;
  }
}
