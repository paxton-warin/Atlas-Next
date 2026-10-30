/** Parent-side control only: record values/codecs/capture never enter this
 * realm. Restart reloads an exact durable preparation from the separate spool. */
import type { BackupNativeSourceDescriptor } from "../../runtime/backup-v2-indexeddb-source.ts";
import type {
  StagedBackupRestore,
  BackupRestoreProgress,
} from "../../runtime/backup-v2-restore.ts";
import type { BackupV2Status } from "./backup-v2-service.ts";
const PROTOCOL = "atlas-backup-actor-v2";
export type BackupDirtyHint = {
  kind?: "local" | "cookies" | "idb" | "atlas";
  origin?: string;
  logicalOrigin?: string;
};
export type BackupV2ActorOptions = {
  replicaId: string;
  incarnation: string;
  profileId?: string;
  label: string;
  seedCheckpointId?: string;
  prefix?: string;
  headers: Record<string, string>;
  sources?: BackupNativeSourceDescriptor[];
  worker?: () => Worker;
  timeoutMs?: number;
  restartClock?: {
    setTimeout(work: () => void, delay: number): unknown;
    clearTimeout(id: unknown): void;
  };
  onRestoreProgress?: (
    namespace: string,
    records: number,
    progress?: BackupRestoreProgress,
  ) => void;
  onStatus?: (status: BackupV2Status) => void;
};
export function createBackupV2Actor(options: BackupV2ActorOptions) {
  let worker: Worker | undefined,
    stopped = false,
    nextId = 0,
    initialized: Promise<void> | undefined,
    restartTimer: unknown,
    restartDelay = 60000;
  const restartClock = options.restartClock ?? {
    setTimeout: (work: () => void, delay: number) => setTimeout(work, delay),
    clearTimeout: (id: unknown) =>
      clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      operation: string;
      reset(): void;
    }
  >();
  let status: BackupV2Status = {
    state: "idle",
    message: "Saved on this browser",
    deferred: [],
  };
  function rejectAll(error: unknown) {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  }
  function crash(automatic = true) {
    worker?.terminate();
    worker = undefined;
    initialized = undefined;
    rejectAll(
      Object.assign(Error("Backup worker restarted; local saves continue."), {
        name: "AbortError",
      }),
    );
    status = {
      ...status,
      state: "offline",
      message: "Saved locally · backup worker stopped",
    };
    options.onStatus?.(status);
    if (automatic && !stopped && restartTimer === undefined) {
      restartTimer = restartClock.setTimeout(() => {
        restartTimer = undefined;
        void initialize().catch(() => {});
      }, restartDelay);
      restartDelay = Math.min(15 * 60000, restartDelay * 2);
    }
  }
  function spawn() {
    if (stopped) throw Error("BACKUP_ACTOR_STOPPED");
    if (worker) return worker;
    const w = (worker =
      options.worker?.() ??
      new Worker(
        new URL("../../runtime/backup-v2-worker.ts", import.meta.url),
        { type: "module", name: "atlas-periodic-backup-v2" },
      ));
    w.addEventListener("error", () => crash());
    w.addEventListener("messageerror", () => crash());
    w.addEventListener("message", ({ data }) => {
      if (data?.protocol !== PROTOCOL) return;
      if (
        data.event === "restore-progress" ||
        data.event === "transfer-activity"
      ) {
        for (const p of pending.values())
          if (
            data.event === "restore-progress"
              ? p.operation === "restore"
              : ["restore", "latest", "list", "flush", "initialize"].includes(
                  p.operation,
                )
          )
            p.reset();
        if (data.event === "restore-progress")
          options.onRestoreProgress?.(
            data.namespace,
            data.records,
            data.progress,
          );
        return;
      }
      if (data.event === "status") {
        status = data.status;
        options.onStatus?.(status);
        return;
      }
      const p = pending.get(data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(data.id);
      if (data.ok) p.resolve(data.value);
      else
        p.reject(
          Object.assign(
            Error(data.error?.message || "Backup worker failed"),
            data.error,
          ),
        );
    });
    return w;
  }
  function rpc(operation: string, data: Record<string, unknown> = {}) {
    const w = spawn(),
      id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      const item = {
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        operation,
        reset() {
          clearTimeout(item.timer);
          item.timer = setTimeout(() => {
            pending.delete(id);
            reject(
              Object.assign(
                Error("Backup worker timed out; local saves continue."),
                { name: "TimeoutError" },
              ),
            );
            crash();
          }, options.timeoutMs ?? 45000);
        },
      };
      item.reset();
      pending.set(id, item);
      w.postMessage({ protocol: PROTOCOL, id, operation, ...data });
    });
  }
  function initialize() {
    return (initialized ??= Promise.resolve()
      .then(() =>
        rpc("initialize", {
          options: {
            replicaId: options.replicaId,
            incarnation: options.incarnation,
            profileId: options.profileId,
            label: options.label,
            seedCheckpointId: options.seedCheckpointId,
            prefix: options.prefix,
            headers: options.headers,
            sources: options.sources,
          },
        }),
      )
      .then(() => {
        restartDelay = 60000;
      })
      .catch((error) => {
        initialized = undefined;
        crash();
        throw error;
      }));
  }
  return {
    initialize,
    dirty(hint?: BackupDirtyHint | BackupDirtyHint[]) {
      if (stopped) return;
      void initialize()
        .then(() =>
          worker?.postMessage({ protocol: PROTOCOL, operation: "dirty", hint }),
        )
        .catch(() => {});
    },
    foreground() {
      worker?.postMessage({ protocol: PROTOCOL, operation: "foreground" });
    },
    async flush() {
      await initialize();
      return rpc("flush");
    },
    async retry() {
      await initialize();
      return rpc("flush");
    },
    async latest() {
      await initialize();
      return rpc("latest");
    },
    async list(cursor?: string) {
      await initialize();
      return rpc("list", { cursor });
    },
    async sources(sources: BackupNativeSourceDescriptor[]) {
      options.sources = sources;
      await initialize();
      return rpc("sources", { sources });
    },
    async preferences(
      changes: Record<string, string | null>,
      deferredKeys: string[] = [],
    ) {
      const values: Record<string, string | null> = {},
        deferred: Array<{ key: string; estimatedNativeBytes: number }> =
          deferredKeys.map((key) => ({
            key,
            estimatedNativeBytes: 256 * 1024 + 1,
          }));
      for (const [key, value] of Object.entries(changes)) {
        if (value !== null && typeof value !== "string")
          throw Error("BACKUP_PREFERENCE_INVALID");
        const size = value === null ? 0 : 64 + 2 * (key.length + value.length);
        if (size > 256 * 1024)
          deferred.push({ key, estimatedNativeBytes: size });
        else values[key] = value;
      }
      await initialize();
      return rpc("preferences", { values, deferred });
    },
    async preferenceKeys(cursor?: { phase: "values" | "deferred"; after?: string }): Promise<{
      keys: string[]; nextCursor?: { phase: "values" | "deferred"; after?: string };
    }> {
      await initialize();
      return rpc("preference-keys", { cursor });
    },
    async headers(headers: Record<string, string>) {
      options.headers = headers;
      await initialize();
      return rpc("headers", { headers });
    },
    async restore(
      checkpointId: string,
      stagingReplicaId?: string,
    ): Promise<StagedBackupRestore> {
      await initialize();
      return rpc("restore", { checkpointId, stagingReplicaId });
    },
    status: () => ({
      ...status,
      deferred: status.deferred.map((d) => ({ ...d })),
    }),
    /** A deliberate backup-only restart; native actors/ports remain untouched. */
    async restart() {
      restartClock.clearTimeout(restartTimer);
      restartTimer = undefined;
      crash(false);
      await initialize();
      worker?.postMessage({ protocol: PROTOCOL, operation: "dirty" });
    },
    stop() {
      stopped = true;
      restartClock.clearTimeout(restartTimer);
      restartTimer = undefined;
      worker?.terminate();
      worker = undefined;
      rejectAll(Error("BACKUP_ACTOR_STOPPED"));
    },
  };
}
