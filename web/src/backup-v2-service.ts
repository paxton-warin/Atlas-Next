/** Cloud publication is independent from native bindings. This service owns no
 * website capability and cannot revoke permits, quiesce a frame or clear data. */
import { deterministicBackupDelay } from "../../runtime/backup-v2-schedule.ts";
import { createBackupRestoreReader } from "../../runtime/backup-v2-restore-reader.ts";
import { openBackupNamespaceCatalog } from "../../runtime/backup-v2-catalog.ts";
import {
  BACKUP_V2_LIMITS,
  backupManifestDigest,
  canonicalBackupJSON,
  type BackupManifest,
  type BackupPublishReceipt,
} from "../../runtime/backup-v2-contracts.ts";
import {
  captureBackupNamespace,
  type BackupSource,
} from "../../runtime/backup-v2-capture.ts";
import type {
  BackupSpool,
  PreparedBackup,
} from "../../runtime/backup-v2-spool.ts";
export type BackupV2Status = {
  state:
    | "idle"
    | "pending"
    | "preparing"
    | "uploading"
    | "publishing"
    | "deferred"
    | "offline"
    | "conflict"
    | "error";
  message: string;
  nextAttemptAt?: number;
  lastCompleted?: BackupPublishReceipt;
  lastIssue?: {
    code?: string;
    status?: number;
    name?: string;
    kind: "deferred" | "offline" | "conflict" | "error";
  };
  metrics?: { cycleEncodedBytes: number; sourceVisits: number };
  deferred: Array<{ sourceId: string; code: string; message: string }>;
};
export type BackupV2Transport = {
  subscribeActivity?: (listener: (path: string) => void) => () => void;
  request<T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  upload(
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<unknown>;
  download(path: string, signal?: AbortSignal): Promise<Uint8Array>;
};
export type BackupV2Clock = {
  now(): number;
  setTimeout(work: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};
export type BackupRestoreAdapter = {
  begin(checkpoint: unknown): Promise<void>;
  page(page: unknown): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
};
export type BackupV2Options = {
  replicaId: string;
  coordinationKey?: string;
  incarnation: string;
  label: string;
  seedCheckpointId?: string;
  source(): Promise<BackupSource[]>;
  origin?: string;
  /** Explicit fixture seam; normal production always uses bounded jitter. */
  scheduleJitter?: boolean;
  spool: BackupSpool;
  transport: BackupV2Transport;
  clock?: BackupV2Clock;
  /** A UI hint only; false postpones background work, never local operations. */
  isInputQuiet?: () => boolean;
  online?: () => boolean;
  withLeadership?: (work: () => Promise<void>) => Promise<void>;
};
const defaultClock: BackupV2Clock = {
  now: () => Date.now(),
  setTimeout: (work, ms) => setTimeout(work, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};
function classified(error: unknown) {
  const e = error as {
    code?: string;
    status?: number;
    name?: string;
    message?: string;
    backupDeferred?: boolean;
  };
  if (e?.backupDeferred) return "deferred" as const;
  if (
    [401, 403, 409, 410].includes(e?.status || 0) ||
    /CONFLICT|PARENT|SEQUENCE|REPLICA_DELETED/.test(e?.code || "")
  )
    return "conflict" as const;
  if (e?.status === 413 || /QUOTA|ADMISSION|BACKPRESSURE/.test(e?.code || ""))
    return "deferred" as const;
  if (
    [408, 425, 429, 502, 503, 504].includes(e?.status || 0) ||
    ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(
      e?.name || "",
    )
  )
    return "offline" as const;
  return "error" as const;
}
export function createBackupV2Service(options: BackupV2Options) {
  const clock = options.clock ?? defaultClock,
    listeners = new Set<(status: BackupV2Status) => void>();
  let status: BackupV2Status = {
    state: "idle",
    message: "Saved on this browser",
    deferred: [],
  };
  let publisherStopped = false;
  let live = true,
    dirtyVersion = 0,
    cleanVersion = 0,
    timer: unknown,
    dueAt: number | undefined;
  let flight: Promise<void> | undefined,
    initialized: Promise<void> | undefined,
    abort: AbortController | undefined,
    backoff = 0;
  let quietTimer: unknown, rejectQuiet: ((error: unknown) => void) | undefined;
  let scheduleCycle = 0,
    arming: Promise<void> | undefined;
  const localTurns = new Map<string, number>();
  let localTurn = 0;
  const delay = (retry?: number) =>
    options.scheduleJitter === false
      ? (retry ?? 60000)
      : deterministicBackupDelay(
          options.replicaId,
          options.origin ?? "",
          scheduleCycle,
          retry,
        );
  function armCycle() {
    if (!live || publisherStopped || flight || timer !== undefined || arming)
      return;
    arming = (async () => {
      scheduleCycle = options.spool.cycle
        ? await options.spool.cycle()
        : scheduleCycle + 1;
      if (live && !publisherStopped && !flight && timer === undefined)
        arm(clock.now() + delay());
    })().finally(() => {
      arming = undefined;
    });
  }
  const emit = (next: Partial<BackupV2Status>) => {
    status = { ...status, ...next };
    for (const listener of listeners)
      try {
        listener(status);
      } catch {}
  };
  const cancelTimer = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  function arm(at: number) {
    if (!live) return;
    cancelTimer();
    dueAt = at;
    emit({ nextAttemptAt: at });
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        void flush(false).catch(() => {});
      },
      Math.max(0, at - clock.now()),
    );
  }
  /** LOCAL ONLY: no capability fetch, register, remote head or history replay. */
  function initialize() {
    return (initialized ??= (async () => {
      const head = await options.spool.head(),
        prepared = await options.spool.pending();
      if (!live) return;
      emit({ lastCompleted: head.lastReceipt });
      let dirty =
        !!prepared ||
        !!head.adoptionPending ||
        !!head.cancellationAdoptionPending ||
        !!(await options.spool.hasQueuedSources?.());
      if (!dirty)
        for (const source of await options.source()) {
          try {
            const control = await source.readControl();
            if (control.generation > control.acknowledgedGeneration) {
              dirty = true;
              break;
            }
          } catch (error) {
            if (!(error as { backupDeferred?: boolean })?.backupDeferred)
              throw error;
            // Busy metadata is not failed initialization or an acknowledgement.
            // Retry this small local probe on the paced backup cycle.
            dirty = true;
            break;
          }
        }
      // Discovery may create durable queue entries while probing the first
      // bounded source page. Later persisted dirty sites need a continuation
      // timer even when the first128 probes are already clean.
      dirty ||= !!(await options.spool.hasQueuedSources?.());
      if (dirty) {
        dirtyVersion++;
        emit({
          state: "pending",
          message: "Saved locally · periodic backup will resume",
        });
        armCycle();
      }
    })());
  }
  function dirty() {
    if (!live) return;
    dirtyVersion++;
    if (publisherStopped) return;
    if (!flight && dueAt === undefined) armCycle();
    emit({
      state: "pending",
      message: "Saved locally · periodic backup pending",
    });
  }
  async function register(signal: AbortSignal) {
    let head = await options.spool.head();
    if (head.registered) return head;
    const requestRegistration = () =>
      options.transport.request<{
        replicaId: string;
        incarnation: string;
        headCheckpointId: string | null;
        headSequence: number;
        adoptedThrough: number;
      }>(
        "/replicas",
        "POST",
        {
          replicaId: options.replicaId,
          incarnation: options.incarnation,
          label: options.label,
          ...(options.seedCheckpointId && !head.seedFallback
            ? { seedCheckpointId: options.seedCheckpointId }
            : {}),
        },
        signal,
      );
    const ensureBaselines = async () => {
      if (!head.seedFallback || head.seedFallback.baselinesInitialized) return;
      if (!options.spool.requireBaselines)
        throw Error("BACKUP_BASELINE_RESET_UNAVAILABLE");
      await options.spool.requireBaselines(head.seedFallback.checkpointId);
      head = {
        ...head,
        seedFallback: { ...head.seedFallback, baselinesInitialized: true },
      };
      await options.spool.saveHead(head);
    };
    await ensureBaselines();
    let result;
    try {
      result = await requestRegistration();
    } catch (error) {
      const e = error as { code?: string; status?: number };
      if (
        e.code !== "BACKUP_SEED_GONE" ||
        e.status !== 404 ||
        !options.seedCheckpointId ||
        head.seedFallback
      )
        throw error;
      // Durable intent precedes unseeded registration: a lost response cannot
      // accidentally retry binding the same replica to its retired seed.
      head = {
        ...head,
        seedFallback: { checkpointId: options.seedCheckpointId },
      };
      await options.spool.saveHead(head);
      await ensureBaselines();
      result = await requestRegistration();
    }
    if (
      result.replicaId !== options.replicaId ||
      result.incarnation !== options.incarnation ||
      !Number.isSafeInteger(result.headSequence) ||
      result.headSequence < 0
    )
      throw Error("BACKUP_REPLICA_RESPONSE_INVALID");
    head = {
      ...head,
      registered: true,
      sequence: result.headSequence,
      checkpointId: result.headCheckpointId,
      adoptedThrough: result.adoptedThrough,
    };
    await options.spool.saveHead(head);
    return head;
  }
  async function prepare(
    sources: BackupSource[],
  ): Promise<PreparedBackup | null> {
    const pending = await options.spool.pending();
    if (pending) return pending;
    await options.spool.clearUnprepared();
    const head = await options.spool.head(),
      versions = [],
      coverages: PreparedBackup["coverages"] = [],
      deferred: BackupV2Status["deferred"] = [];
    const started = performance.now(),
      workBudget = { used: 0, limit: BACKUP_V2_LIMITS.cycleBytes };
    emit({
      state: "preparing",
      message: "Saved locally · preparing periodic backup",
      deferred: [],
    });
    const states = options.spool.fairState
      ? await options.spool.fairState(sources.map((s) => s.id))
      : [];
    const turns = new Map(states.map((s) => [s.sourceId, s]));
    // Reserve bounded metadata progress before any32-part publication stop.
    // Explicit/observed dirty scopes must not wait behind1,024 clean probes.
    let probes = 0;
    for (const source of sources) {
      const row = turns.get(source.id);
      if (
        !row ||
        row.priority !== 0 ||
        row.tier !== 1 ||
        probes >= 64 ||
        performance.now() - started >= BACKUP_V2_LIMITS.prepareMs
      )
        continue;
      probes++;
      try {
        const control = await source.readControl(),
          needs =
            control.generation > control.acknowledgedGeneration ||
            (row.baselineEpoch ?? 0) > (row.acknowledgedBaselineEpoch ?? 0);
        await options.spool.markServed?.(source.id, {
          priority: needs ? 0 : 1,
          tier: needs ? 0 : 2,
          observedGeneration: control.generation,
          expectedHintVersion: row.hintVersion,
          ...(!needs ? { dirtySinceTurn: null } : {}),
        });
      } catch (error) {
        if (!(error as { backupDeferred?: boolean })?.backupDeferred)
          throw error;
        deferred.push({
          sourceId: source.id,
          code: (error as { code: string }).code,
          message:
            "This metadata probe will resume after website activity pauses.",
        });
        await options.spool.markServed?.(source.id, {
          nextEligibleAt: clock.now() + 60000,
        });
      }
      const current = (await options.spool.fairState?.([source.id]))?.[0];
      if (current) turns.set(source.id, current);
    }
    const activeWork =
        (await options.spool.workSources?.(128, clock.now())) ?? [],
      completed = new Set(
        activeWork.filter((j) => j.complete).map((j) => j.sourceId),
      ),
      admitted = new Set(activeWork.map((j) => j.sourceId));
    const ordered = [...sources].sort(
      (a, b) =>
        Number(completed.has(b.id)) - Number(completed.has(a.id)) ||
        Number(admitted.has(b.id)) - Number(admitted.has(a.id)) ||
        (turns.get(a.id)?.tier ?? 1) - (turns.get(b.id)?.tier ?? 1) ||
        (turns.get(a.id)?.lastServedTurn ?? localTurns.get(a.id) ?? 0) -
          (turns.get(b.id)?.lastServedTurn ?? localTurns.get(b.id) ?? 0) ||
        a.id.localeCompare(b.id),
    );
    let visits = 0;
    const pendingVisits = [...ordered];
    for (let turn = 0; turn < pendingVisits.length; turn++) {
      const source = pendingVisits[turn];
      if (options.spool.fairState) {
        const row = (await options.spool.fairState([source.id]))[0];
        if (row) turns.set(source.id, row);
      }
      if (!live || abort!.signal.aborted)
        throw abort!.signal.reason || Error("BACKUP_STOPPED");
      const pressureSource = await options.spool.pressureSource?.();
      if (
        pressureSource &&
        pressureSource !== source.id &&
        !completed.has(source.id)
      )
        continue;
      if (
        visits >= 128 ||
        performance.now() - started >= BACKUP_V2_LIMITS.prepareMs ||
        workBudget.used > workBudget.limit - BACKUP_V2_LIMITS.encodedRecordBytes
      )
        break;
      if ((turns.get(source.id)?.nextEligibleAt ?? 0) > clock.now()) continue;
      if (
        versions.length >= 64 ||
        versions.reduce((n, v) => n + v.parts.length, 0) >= 32
      )
        break;
      visits++;
      const visitStarted = performance.now(),
        encodedBefore = workBudget.used;
      let observedGeneration: number | undefined,
        reason: string | undefined,
        isDirty = true;
      try {
        // Metadata maintenance shares this bounded visit, not an unbounded
        // prelude across every source before the preparation clock starts.
        try {
          await source.maintain?.();
        } catch {}
        const control = await source.readControl();
        observedGeneration = control.generation;
        const baselineEpoch = turns.get(source.id)?.baselineEpoch ?? 0,
          forceBaseline =
            baselineEpoch >
            (turns.get(source.id)?.acknowledgedBaselineEpoch ?? 0);
        if (
          !forceBaseline &&
          control.generation <= control.acknowledgedGeneration
        ) {
          isDirty = false;
          const stale = await options.spool.captureJob?.(source.id);
          if (stale && stale.versionId === head.namespaceHeads[source.id])
            await options.spool.dropCapture?.(source.id);
          continue;
        }
        const capture = (visitMs: number, visitBytes: number) =>
          captureBackupNamespace(
            source,
            options.spool,
            (!forceBaseline &&
            head.namespaceIncarnations?.[source.id] === control.incarnation
              ? head.namespaceHeads[source.id]
              : null) || null,
            {
              signal: abort!.signal,
              deadlineAt: started + BACKUP_V2_LIMITS.prepareMs,
              visitMs,
              visitBytes,
              workBudget,
            },
          );
        let captured;
        try {
          captured = await capture(
            Math.max(1, 250 - (performance.now() - visitStarted)),
            512 * 1024,
          );
        } catch (error) {
          const e = error as { code?: string };
          // Admission pressure must not repeatedly evict eight established
          // cursors for a stream of ninth jobs. Only an admitted source may
          // reclaim another unprepared partial to make its bounded progress.
          const admitted =
            e?.code === "BACKUP_SPOOL_PRESSURE" &&
            (await options.spool.captureJob?.(source.id));
          if (admitted) await options.spool.claimPressureSource?.(source.id);
          const timeLeft = 250 - (performance.now() - visitStarted),
            bytesLeft = 512 * 1024 - (workBudget.used - encodedBefore);
          if (
            admitted &&
            timeLeft > 0 &&
            bytesLeft > 0 &&
            (await options.spool.evictPartial?.(source.id, clock.now() + 60000))
          )
            captured = await capture(timeLeft, bytesLeft);
          else throw error;
        }
        if (
          versions.reduce((n, v) => n + v.parts.length, 0) +
            captured.version.parts.length >
          32
        ) {
          reason = "BACKUP_CYCLE_BUDGET";
          deferred.push({
            sourceId: source.id,
            code: reason,
            message:
              "This completed namespace is queued for the next bounded upload cycle.",
          });
          continue;
        }
        versions.push(captured.version);
        coverages.push({
          sourceId: source.id,
          namespaceVersionId: captured.version.namespaceVersionId,
          cut: captured.version.localCut,
          trackingEpoch: captured.trackingEpoch,
          localIncarnation: captured.localIncarnation,
          hintVersion: turns.get(source.id)?.hintVersion,
          baselineEpoch,
        });
      } catch (error) {
        if (!(error as { backupDeferred?: boolean })?.backupDeferred)
          throw error;
        reason = (error as { code: string }).code;
        if (
          ![
            "BACKUP_VISIT_YIELDED",
            "BACKUP_CYCLE_BUDGET",
            "BACKUP_SPOOL_PRESSURE",
          ].includes(reason)
        )
          await options.spool.clearPressureSource?.(source.id);
        if (reason === "BACKUP_VISIT_YIELDED") pendingVisits.push(source);
        if (reason !== "BACKUP_NOT_DIRTY")
          deferred.push({
            sourceId: source.id,
            code: reason,
            message: (error as Error).message,
          });
      } finally {
        localTurns.set(source.id, ++localTurn);
        await options.spool.markServed?.(source.id, {
          observedGeneration,
          reason,
          priority: isDirty ? 0 : 1,
          ...(!isDirty ? { dirtySinceTurn: null } : {}),
          expectedHintVersion: turns.get(source.id)?.hintVersion ?? 0,
          nextEligibleAt:
            reason &&
            reason !== "BACKUP_VISIT_YIELDED" &&
            reason !== "BACKUP_CYCLE_BUDGET"
              ? clock.now() + 60000
              : 0,
        });
      }
    }
    if (await options.spool.hasQueuedSources?.())
      deferred.push({
        sourceId: "@catalog",
        code: "BACKUP_CATALOG_PENDING",
        message:
          "More website metadata or bounded capture work is queued for the next cycle.",
      });
    emit({
      deferred,
      metrics: { cycleEncodedBytes: workBudget.used, sourceVisits: visits },
    });
    if (!versions.length) {
      emit({
        state: deferred.length ? "deferred" : "idle",
        message: deferred.length
          ? "Saved locally · large or busy saves are not yet backed up"
          : "Saved on this browser",
      });
      return null;
    }
    const partial: Omit<BackupManifest, "manifestDigest"> = {
      format: "atlas-checkpoint-v2",
      checkpointId: crypto.randomUUID(),
      replicaId: options.replicaId,
      incarnation: options.incarnation,
      sequence: head.sequence + 1,
      parentCheckpointId: head.checkpointId,
      adoptedThrough: head.adoptedThrough,
      namespaces: versions,
    };
    const prepared = {
      manifest: {
        ...partial,
        manifestDigest: await backupManifestDigest(partial),
      },
      coverages,
    };
    await options.spool.prepare(prepared);
    return prepared;
  }
  function checkedReceipt(
    value: unknown,
    pending: PreparedBackup,
  ): BackupPublishReceipt {
    const r = value as BackupPublishReceipt;
    if (
      !r ||
      r.acknowledged !== true ||
      r.checkpointId !== pending.manifest.checkpointId ||
      r.sequence !== pending.manifest.sequence ||
      r.replicaId !== pending.manifest.replicaId ||
      r.manifestDigest !== pending.manifest.manifestDigest ||
      typeof r.completedAt !== "string" ||
      !Array.isArray(r.coverage)
    )
      throw Error("BACKUP_ACK_INVALID");
    for (const c of pending.coverages)
      if (
        !r.coverage.some(
          (n) =>
            n.namespaceVersionId === c.namespaceVersionId &&
            n.localCut === c.cut,
        )
      )
        throw Error("BACKUP_ACK_COVERAGE_INVALID");
    return r;
  }
  async function cancelRejectedPreparation(
    prepared: PreparedBackup,
  ): Promise<BackupPublishReceipt | null> {
    const intent = prepared.cancellation;
    if (!intent || !options.spool.abandonPrepared)
      throw Error("BACKUP_CANCELLATION_UNAVAILABLE");
    const id = prepared.manifest.checkpointId,
      signal = abort!.signal;
    // A lost publication/cancellation response is always resolved first. A
    // completed receipt wins; it is never treated as a disposable rejection.
    const state = await options.transport.request<{
      checkpointId: string;
      status: string;
      receipt?: BackupPublishReceipt;
    }>("/staging/" + id, "GET", undefined, signal);
    if (state.checkpointId !== id)
      throw Error("BACKUP_CANCELLATION_IDENTITY_MISMATCH");
    if (state.receipt) return checkedReceipt(state.receipt, prepared);
    if (!["prepared", "expired"].includes(state.status))
      throw Error("BACKUP_CANCELLATION_STATE_INVALID");
    const result = await options.transport.request<{
      checkpointId: string;
      manifestDigest: string;
      cancelled: boolean;
    }>("/staging/" + id, "DELETE", undefined, signal);
    if (
      result.checkpointId !== id ||
      result.manifestDigest !== prepared.manifest.manifestDigest ||
      result.cancelled !== true
    )
      throw Error("BACKUP_CANCELLATION_ACK_INVALID");
    await options.spool.abandonPrepared(
      id,
      prepared.manifest.manifestDigest,
      clock.now() + 15 * 60000,
    );
    const rejected = new Set(intent.rejectedNamespaceVersionIds),
      affected = prepared.coverages.filter((c) =>
        rejected.has(c.namespaceVersionId),
      );
    await adoptCancellation(signal);
    emit({
      state: "deferred",
      message:
        "Saved locally · new websites exceed this backup catalog; existing backups can continue",
      deferred: [
        ...status.deferred.filter(
          (d) => !affected.some((c) => c.sourceId === d.sourceId),
        ),
        ...affected.map((c) => ({
          sourceId: c.sourceId,
          code: "BACKUP_CATALOG_FULL",
          message:
            "This new website remains local because the backup catalog is full. Existing website backups continue.",
        })),
      ],
    });
    return null;
  }
  async function catalogueRejection(
    prepared: PreparedBackup,
    error: unknown,
  ): Promise<BackupPublishReceipt | null> {
    const e = error as {
      code?: string;
      status?: number;
      details?: {
        checkpointId?: unknown;
        manifestDigest?: unknown;
        rejectedNamespaceVersionIds?: unknown;
      };
    };
    const d = e.details,
      ids = d?.rejectedNamespaceVersionIds,
      expected = new Set(
        prepared.manifest.namespaces.map((n) => n.namespaceVersionId),
      );
    if (
      e.code !== "BACKUP_CATALOG_FULL" ||
      e.status !== 413 ||
      d?.checkpointId !== prepared.manifest.checkpointId ||
      d?.manifestDigest !== prepared.manifest.manifestDigest ||
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 64 ||
      ids.some((id) => typeof id !== "string" || !expected.has(id)) ||
      new Set(ids).size !== ids.length ||
      !options.spool.abandonPrepared
    )
      throw error;
    const next = {
      ...prepared,
      cancellation: {
        code: "BACKUP_CATALOG_FULL" as const,
        rejectedNamespaceVersionIds: ids as string[],
      },
    };
    // Durable intent changes local continuation metadata, never the prepared
    // manifest identity. A crash can resume cancellation without re-encoding.
    await options.spool.prepare(next);
    return cancelRejectedPreparation(next);
  }
  async function publish(
    prepared: PreparedBackup,
  ): Promise<BackupPublishReceipt | null> {
    if (prepared.cancellation) return cancelRejectedPreparation(prepared);
    try {
      const signal = abort!.signal,
        id = prepared.manifest.checkpointId;
      const response = await options.transport.request<{
        checkpointId: string;
        status: string;
        missingParts: string[];
        receipt?: BackupPublishReceipt;
      }>(
        "/replicas/" + options.replicaId + "/checkpoints",
        "POST",
        prepared.manifest,
        signal,
      );
      if (response.receipt) return checkedReceipt(response.receipt, prepared);
      if (response.checkpointId !== id || !Array.isArray(response.missingParts))
        throw Error("BACKUP_PREPARE_RESPONSE_INVALID");
      const expected = new Set(
        prepared.manifest.namespaces.flatMap((n) =>
          n.parts.map((p) => p.sha256),
        ),
      );
      if (response.missingParts.some((hash) => !expected.has(hash)))
        throw Error("BACKUP_MISSING_PART_RESPONSE_INVALID");
      emit({
        state: "uploading",
        message: "Saved locally · uploading periodic backup",
      });
      for (const hash of response.missingParts) {
        if (!live) throw Error("BACKUP_STOPPED");
        const bytes = await options.spool.part(hash);
        await options.transport.upload(
          "/staging/" + id + "/parts/" + hash,
          bytes,
          signal,
        );
      }
      emit({
        state: "publishing",
        message: "Saved locally · confirming backup",
      });
      const published = await options.transport.request<
        | { receipt?: BackupPublishReceipt; status?: string }
        | BackupPublishReceipt
      >("/staging/" + id + "/publish", "POST", {}, signal);
      if ((published as { status?: string }).status === "validating")
        throw Object.assign(Error("The backup is still validating."), {
          name: "AbortError",
          code: "BACKUP_VALIDATING",
        });
      return checkedReceipt(
        (published as { receipt?: BackupPublishReceipt }).receipt || published,
        prepared,
      );
    } catch (error) {
      return catalogueRejection(prepared, error);
    }
  }
  async function adoptCancellation(signal: AbortSignal) {
    const head = await options.spool.head(),
      pending = head.cancellationAdoptionPending;
    if (!pending) return;
    const r = await options.transport.request<{
      replicaId: string;
      checkpointId: string;
      manifestDigest: string;
      adopted: boolean;
      headSequence: number;
      headCheckpointId: string | null;
      adoptedThrough: number;
    }>(
      "/replicas/" + options.replicaId + "/cancellations/adopt",
      "POST",
      {
        checkpointId: pending.checkpointId,
        manifestDigest: pending.manifestDigest,
      },
      signal,
    );
    if (
      r.replicaId !== options.replicaId ||
      r.checkpointId !== pending.checkpointId ||
      r.manifestDigest !== pending.manifestDigest ||
      r.adopted !== true ||
      r.headSequence !== pending.sequence ||
      r.headCheckpointId !== pending.parentCheckpointId ||
      r.adoptedThrough !== pending.sequence
    )
      throw Error("BACKUP_CANCELLATION_ADOPTION_ACK_INVALID");
    const current = await options.spool.head();
    if (
      current.cancellationAdoptionPending?.checkpointId !==
        pending.checkpointId ||
      current.cancellationAdoptionPending.manifestDigest !==
        pending.manifestDigest
    )
      throw Error("BACKUP_CANCELLATION_IDENTITY_CHANGED");
    delete current.cancellationAdoptionPending;
    if (
      (current.adoptionPending?.adoptedThrough ?? Infinity) <= r.adoptedThrough
    )
      delete current.adoptionPending;
    await options.spool.saveHead({
      ...current,
      sequence: r.headSequence,
      checkpointId: r.headCheckpointId,
      adoptedThrough: r.adoptedThrough,
    });
  }
  async function adopt(signal: AbortSignal) {
    const head = await options.spool.head(),
      pending = head.adoptionPending;
    if (!pending) return;
    const response = await options.transport.request<{
      replicaId: string;
      adoptedThrough: number;
    }>(
      "/replicas/" + options.replicaId + "/adopt",
      "POST",
      { ...pending, incarnation: options.incarnation },
      signal,
    );
    if (
      response.replicaId !== options.replicaId ||
      !Number.isSafeInteger(response.adoptedThrough) ||
      response.adoptedThrough < pending.adoptedThrough
    )
      throw Error("BACKUP_ADOPTION_ACK_INVALID");
    const current = await options.spool.head();
    if (
      current.adoptionPending &&
      current.adoptionPending.adoptedThrough <= response.adoptedThrough
    ) {
      delete current.adoptionPending;
      await options.spool.saveHead(current);
    }
  }
  async function run() {
    await initialize();
    if (!live) return;
    abort = new AbortController();
    const source = await options.source();
    if (options.online && !options.online())
      throw Object.assign(Error("Backup is offline; local saves continue."), {
        name: "NetworkError",
      });
    await register(abort.signal);
    await adoptCancellation(abort.signal);
    await adopt(abort.signal);
    const prepared = await prepare(source);
    if (!prepared) return;
    const receipt = await publish(prepared);
    if (!receipt) return;
    const head = await options.spool.head(),
      nextHeads = { ...head.namespaceHeads },
      nextIncarnations = { ...head.namespaceIncarnations };
    // Adoption is idempotent and native. A crash here retains the exact prepared
    // identity; the next actor resolves the same remote receipt again.
    for (const coverage of prepared.coverages) {
      const current = source.find((s) => s.id === coverage.sourceId);
      if (!current) throw Error("BACKUP_SOURCE_UNAVAILABLE_FOR_ADOPTION");
      const control = await current.readControl();
      const sameIncarnation =
        !coverage.localIncarnation ||
        coverage.localIncarnation === control.incarnation;
      if (sameIncarnation) {
        await current.acknowledge(coverage.cut, coverage.trackingEpoch);
        if (coverage.baselineEpoch)
          await options.spool.markServed?.(coverage.sourceId, {
            acknowledgedBaselineEpoch: coverage.baselineEpoch,
          });
      }
      if (
        (!coverage.localIncarnation ||
          coverage.localIncarnation === control.incarnation) &&
        control.generation === coverage.cut
      )
        await options.spool.markServed?.(coverage.sourceId, {
          priority: 1,
          dirtySinceTurn: null,
          expectedHintVersion: coverage.hintVersion ?? 0,
          ...(coverage.baselineEpoch
            ? { acknowledgedBaselineEpoch: coverage.baselineEpoch }
            : {}),
          nextEligibleAt: 0,
        });
      nextHeads[coverage.sourceId] = coverage.namespaceVersionId;
      if (coverage.localIncarnation)
        nextIncarnations[coverage.sourceId] = coverage.localIncarnation;
    }
    await options.spool.finish(receipt, nextHeads, nextIncarnations);
    if (!(await options.spool.hasQueuedSources?.()))
      status = {
        ...status,
        deferred: status.deferred.filter((d) => d.sourceId !== "@catalog"),
      };
    else if (!status.deferred.some((d) => d.sourceId === "@catalog"))
      status = {
        ...status,
        deferred: [
          ...status.deferred,
          {
            sourceId: "@catalog",
            code: "BACKUP_CATALOG_PENDING",
            message:
              "More local changes remain queued for a later bounded backup.",
          },
        ],
      };
    emit({
      lastCompleted: receipt,
      state: status.deferred.length ? "deferred" : "idle",
      message: status.deferred.length
        ? "Some saves are backed up; large or busy saves remain local"
        : "Saved locally · cloud backup completed",
    });
    await adopt(abort.signal);
  }
  async function waitForInputQuiet() {
    if (!options.isInputQuiet || options.isInputQuiet()) return;
    emit({
      state: "pending",
      message: "Saved locally · waiting for activity to pause",
    });
    const deadline = clock.now() + 5000;
    while (live && !options.isInputQuiet()) {
      if (clock.now() >= deadline)
        throw Object.assign(
          Error("Backup is waiting for website activity to pause."),
          {
            name: "AbortError",
            code: "BACKUP_FOREGROUND_BUSY",
            backupDeferred: true,
          },
        );
      await new Promise<void>((resolve, reject) => {
        rejectQuiet = reject;
        quietTimer = clock.setTimeout(
          () => {
            quietTimer = undefined;
            rejectQuiet = undefined;
            resolve();
          },
          Math.min(100, deadline - clock.now()),
        );
      });
    }
    if (!live)
      throw Object.assign(Error("Backup actor stopped"), {
        name: "AbortError",
      });
  }
  function flush(explicit = true): Promise<void> {
    if (!live) return Promise.reject(Error("BACKUP_STOPPED"));
    if (flight) return flight;
    cancelTimer();
    dueAt = undefined;
    if (!explicit && options.isInputQuiet && !options.isInputQuiet()) {
      arm(clock.now() + BACKUP_V2_LIMITS.quietMs);
      return Promise.resolve();
    }
    const target = dirtyVersion;
    emit({ lastIssue: undefined });
    const coordinate =
      options.withLeadership ??
      (async (work: () => Promise<void>) => {
        if (typeof navigator !== "undefined" && navigator.locks)
          await navigator.locks.request(
            "atlas-backup-v2:" + (options.coordinationKey ?? options.replicaId),
            { ifAvailable: true },
            async (lock) => {
              if (!lock)
                throw Object.assign(
                  Error("Another local backup actor is active."),
                  { backupDeferred: true, code: "BACKUP_LOCAL_ACTOR_BUSY" },
                );
              await work();
            },
          );
        else
          throw Object.assign(
            Error("This browser lacks coordinated backup execution."),
            { backupDeferred: true, code: "BACKUP_COORDINATION_UNAVAILABLE" },
          );
      });
    const current = Promise.resolve()
      .then(async () => {
        // An explicit click is foreground activity too. Queue/coalesce locally
        // until quiet; do not bypass native transaction guards or hold WebLocks.
        if (explicit) await waitForInputQuiet();
        return coordinate(run);
      })
      .then(
        () => {
          emit({ lastIssue: undefined });
          cleanVersion = target;
          backoff = 0;
          publisherStopped = false;
        },
        (error) => {
          if (!live) throw error;
          const kind = classified(error),
            e = error as { code?: unknown; status?: unknown; name?: unknown };
          emit({
            state: kind,
            lastIssue: {
              kind,
              ...(typeof e?.code === "string" &&
              /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)
                ? { code: e.code }
                : {}),
              ...(typeof e?.status === "number" &&
              e.status >= 100 &&
              e.status <= 599
                ? { status: e.status }
                : {}),
              ...(typeof e?.name === "string" && /^[A-Za-z]{1,48}$/.test(e.name)
                ? { name: e.name }
                : {}),
            },
            message:
              "Saved locally · " +
              (kind === "conflict"
                ? "backup version needs review"
                : kind === "deferred"
                  ? "backup deferred"
                  : "backup unavailable"),
            ...(error instanceof Error ? {} : {}),
          });
          // Coarse paced retry only. Never retry every dirty event or every5ms.
          backoff = Math.min(15 * 60000, Math.max(60000, backoff * 2));
          if (kind === "conflict") publisherStopped = true;
          else {
            const retryAfter = (error as { retryAfterMs?: number })
              ?.retryAfterMs;
            arm(
              clock.now() +
                Math.max(
                  delay(backoff),
                  Number.isSafeInteger(retryAfter) &&
                    retryAfter! >= 1000 &&
                    retryAfter! <= 900000
                    ? retryAfter!
                    : 0,
                ),
            );
          }
          throw error;
        },
      )
      .finally(() => {
        if (flight === current) flight = undefined;
        if (
          live &&
          !publisherStopped &&
          timer === undefined &&
          (dirtyVersion > cleanVersion || status.deferred.length > 0)
        )
          armCycle();
      });
    flight = current;
    return current;
  }
  return {
    initialize,
    dirty,
    flush: () => flush(true),
    retry: () => flush(true),
    status: () => ({
      ...status,
      deferred: status.deferred.map((v) => ({ ...v })),
    }),
    subscribe(listener: (s: BackupV2Status) => void) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    latest: () =>
      options.transport.request<{
        checkpoint: unknown;
        receipt: BackupPublishReceipt;
      }>("/checkpoints/latest?catalog=paged"),
    list: (cursor?: string) =>
      options.transport.request(
        "/checkpoints" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      ),
    async restore(checkpointId: string, adapter: BackupRestoreAdapter) {
      const controller = new AbortController(),
        catalog = await openBackupNamespaceCatalog(
          options.transport,
          checkpointId,
          controller.signal,
          undefined,
          { readerLost: (error) => controller.abort(error) },
        ),
        reader =
          catalog.reader ??
          createBackupRestoreReader({
            transport: options.transport,
            checkpointId,
            pin: catalog.readerPin,
            signal: controller.signal,
            lost: (error) => controller.abort(error),
          });
      const check = () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      try {
        await adapter.begin(catalog.checkpoint);
        check();
        for await (const namespace of catalog.namespaces) {
          reader.activity();
          let cursor: string | undefined;
          do {
            check();
            const page = await options.transport.request<{
              nextCursor?: string;
            }>(
              "/namespace-versions/" +
                namespace.namespaceVersionId +
                "/records" +
                (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
              undefined,
              undefined,
              controller.signal,
            );
            reader.activity();
            await adapter.page({
              ...page,
              namespaceVersionId: namespace.namespaceVersionId,
            });
            check();
            cursor = page.nextCursor;
          } while (cursor);
        }
        check();
        await adapter.finish();
        check();
      } catch (error) {
        await adapter.abort();
        throw error;
      } finally {
        reader.close();
      }
    },
    stop() {
      live = false;
      cancelTimer();
      if (quietTimer !== undefined) clock.clearTimeout(quietTimer);
      quietTimer = undefined;
      const pendingQuiet = rejectQuiet;
      rejectQuiet = undefined;
      pendingQuiet?.(
        Object.assign(Error("Backup actor stopped"), { name: "AbortError" }),
      );
      abort?.abort(
        Object.assign(Error("Backup actor stopped"), { name: "AbortError" }),
      );
      listeners.clear();
      options.spool.dispose();
    },
  };
}
/** Kept as a re-export for existing worker and fixture callers. */
export { createBackupV2FetchTransport } from "./backup-v2-fetch.ts";
