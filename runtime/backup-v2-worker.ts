/** Restartable backup actor. It receives descriptors, never native website
 * MessagePorts. Its crash cannot close or revoke the separate local actor. */
import {
  createIndexedDBBackupSource,
  type BackupNativeSourceDescriptor,
} from "./backup-v2-indexeddb-source.ts";
import { writeBackupPreferences, readBackupPreferenceKeys } from "./backup-v2-preferences.ts";
import { prepareBackupV2Restore } from "./backup-v2-restore.ts";
import { readBackupSourceBatch } from "./backup-v2-discovery.ts";
import { createIndexedDBBackupSpool } from "./backup-v2-spool.ts";
import { hubSiteGroup } from "./hub-contracts.ts";
import {
  createBackupV2Service,
  createBackupV2FetchTransport,
} from "../web/src/backup-v2-service.ts";
export const BACKUP_WORKER_V2_PROTOCOL = "atlas-backup-actor-v2";
type Scope = {
  indexedDB: IDBFactory;
  postMessage(value: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
};
export function installBackupV2Worker(scope: Scope) {
  let preferencesTail: Promise<unknown> = Promise.resolve();
  let profileId: string | undefined;
  let replicaId: string | undefined, discovering: Promise<void> | undefined;
  let transport: ReturnType<typeof createBackupV2FetchTransport> | undefined;
  let service: ReturnType<typeof createBackupV2Service> | undefined,
    lastInput = 0;
  let sources: ReturnType<typeof createIndexedDBBackupSource>[] = [];
  let headers: Record<string, string> = {};
  let spool: ReturnType<typeof createIndexedDBBackupSpool> | undefined;
  let configured: BackupNativeSourceDescriptor[] | undefined;
  // A restart verifies metadata once; a lost last hint can never strand a dirty
  // namespace marked clean by an older actor. This is not website value replay.
  let requeueAll = true;
  const hintScopes = new Set<string>(),
    discoveryAborts = new Set<() => void>();
  const validDescriptors = (descriptors: BackupNativeSourceDescriptor[]) => {
    if (!Array.isArray(descriptors) || descriptors.length > 1024)
      throw Error("BACKUP_SOURCE_LIST_INVALID");
    return descriptors;
  };
  function discover() {
    return (discovering ??= (async () => {
      if (!replicaId || !spool) return;
      if (configured) {
        await spool.beginDiscovery!();
        if (!configured.length)
          await spool.saveDiscoveryCursor!({ phase: "done" });
        for (let i = 0; i < configured.length; i += 64)
          await spool.touchSources!(
            configured.slice(i, i + 64),
            i + 64 >= configured.length ? { phase: "done" } : undefined,
          );
      } else {
        let cursor = await spool.beginDiscovery!();
        const started = performance.now();
        for (
          let pages = 0;
          pages < 8 &&
          performance.now() - started < 250 &&
          cursor.phase !== "done";
          pages++
        ) {
          try {
            const batch = await readBackupSourceBatch(
              scope.indexedDB,
              replicaId,
              cursor,
              {
                foreground: () => Date.now() - lastInput < 500,
                onTransaction: (abort) => {
                  discoveryAborts.add(abort);
                  return () => discoveryAborts.delete(abort);
                },
              },
            );
            await spool.touchSources!(batch.sources, batch.next);
            cursor = batch.next;
          } catch (error) {
            if (!(error as { backupDeferred?: boolean })?.backupDeferred)
              throw error;
            break;
          }
        }
      }
      if (requeueAll) {
        requeueAll = false;
        await spool.probeAll!();
      }
      for (const scopeKey of [...hintScopes]) {
        hintScopes.delete(scopeKey);
        await spool.hintScope!(scopeKey);
      }
    })().finally(() => {
      discovering = undefined;
    }));
  }
  async function selectedSources() {
    await discover();
    const pending = await spool!.pending(),
      pinnedIds = pending?.coverages.map((c) => c.sourceId) ?? [];
    const work = await spool!.workSources!(128, Date.now()),
      pinned = await spool!.fairState!(
        [...new Set([...pinnedIds, ...work.map((j) => j.sourceId)])].slice(
          0,
          128,
        ),
      ),
      fair = await spool!.fairSources!(128, Date.now());
    const descriptors = new Map(
      [...pinned, ...fair].flatMap((entry) =>
        entry.descriptor ? [[entry.sourceId, entry.descriptor] as const] : [],
      ),
    );
    for (const source of sources) source.dispose();
    sources = [...descriptors.values()].slice(0, 128).map((d) =>
      createIndexedDBBackupSource(scope.indexedDB, d, {
        foreground: () => Date.now() - lastInput < 500,
      }),
    );
    return sources;
  }
  function dirtyHint(hint: unknown, nested = false) {
    if (!nested) void spool?.requestDiscovery?.().catch(() => {});
    if (Array.isArray(hint)) {
      if (hint.length > 64) {
        requeueAll = true;
        return;
      }
      for (const item of hint) dirtyHint(item, true);
      return;
    }
    const h = hint as {
      kind?: unknown;
      origin?: unknown;
      logicalOrigin?: unknown;
    };
    try {
      const kind =
          h?.kind ?? (typeof h?.logicalOrigin === "string" ? "idb" : undefined),
        origin = h?.origin ?? h?.logicalOrigin;
      if (kind === "atlas") hintScopes.add(JSON.stringify(["atlas", ""]));
      else if (
        ["local", "cookies", "idb"].includes(String(kind)) &&
        typeof origin === "string" &&
        origin.length <= 2048
      ) {
        const logical = new URL(origin);
        if (
          !["http:", "https:"].includes(logical.protocol) ||
          logical.origin !== origin
        )
          throw Error();
        hintScopes.add(
          JSON.stringify([
            kind,
            kind === "cookies" ? "https://" + hubSiteGroup(origin) : origin,
          ]),
        );
      } else requeueAll = true;
    } catch {
      requeueAll = true;
    }
    if (hintScopes.size > 64) {
      hintScopes.clear();
      requeueAll = true;
    }
  }
  scope.addEventListener("message", ({ data }) => {
    if (data?.protocol !== BACKUP_WORKER_V2_PROTOCOL) return;
    if (data.operation === "foreground") {
      lastInput = Date.now();
      for (const s of sources) s.interrupt();
      for (const abort of discoveryAborts) abort();
      return;
    }
    if (data.operation === "dirty") {
      dirtyHint(data.hint);
      service?.dirty();
      return;
    }
    const reply = (value: unknown) =>
      scope.postMessage({
        protocol: BACKUP_WORKER_V2_PROTOCOL,
        id: data.id,
        ok: true,
        value,
      });
    void (async () => {
      switch (data.operation) {
        case "initialize": {
          if (service) throw Error("BACKUP_ACTOR_ALREADY_INITIALIZED");
          const o = data.options;
          if (!o) throw Error("BACKUP_ACTOR_ARGUMENTS_INVALID");
          profileId = o.profileId;
          headers = {
            ...(o.headers || {}),
            ...(profileId ? { "x-atlas-profile-id": profileId } : {}),
          };
          replicaId = o.replicaId;
          spool = createIndexedDBBackupSpool(scope.indexedDB, o.replicaId);
          await spool.requestDiscovery!();
          if (o.sources) configured = validDescriptors(o.sources);
          transport = createBackupV2FetchTransport({
            prefix: o.prefix,
            headers: () => headers,
            onActivity: () => {
              scope.postMessage({
                protocol: BACKUP_WORKER_V2_PROTOCOL,
                event: "transfer-activity",
              });
            },
          });
          service = createBackupV2Service({
            replicaId: o.replicaId,
            coordinationKey: profileId ?? o.replicaId,
            incarnation: o.incarnation,
            label: o.label,
            seedCheckpointId: o.seedCheckpointId,
            source: selectedSources,
            origin: typeof location !== "undefined" ? location.origin : "",
            spool,
            transport,
            isInputQuiet: () => Date.now() - lastInput >= 500,
          });
          service.subscribe((status) =>
            scope.postMessage({
              protocol: BACKUP_WORKER_V2_PROTOCOL,
              event: "status",
              status,
            }),
          );
          return service.initialize();
        }
        case "preferences":
          if (!replicaId) throw Error("BACKUP_ACTOR_NOT_READY");
          preferencesTail = preferencesTail
            .catch(() => {})
            .then(() =>
              writeBackupPreferences(
                scope.indexedDB,
                replicaId!,
                data.values,
                data.deferred,
              ),
            );
          if (await preferencesTail) {
            dirtyHint({ kind: "atlas" });
            service?.dirty();
          }
          return;
        case "preference-keys":
          if (!replicaId) throw Error("BACKUP_ACTOR_NOT_READY");
          await preferencesTail.catch(() => {});
          return readBackupPreferenceKeys(scope.indexedDB, replicaId, data.cursor);
        case "sources":
          configured = validDescriptors(data.sources);
          requeueAll = true;
          service?.dirty();
          return;
        case "headers":
          headers = {
            ...(data.headers || {}),
            ...(profileId ? { "x-atlas-profile-id": profileId } : {}),
          };
          return;
        case "flush":
          if (!service) throw Error("BACKUP_ACTOR_NOT_READY");
          return service.flush();
        case "latest":
          return service?.latest();
        case "list":
          return service?.list(data.cursor);
        case "restore": {
          if (!transport || !replicaId) throw Error("BACKUP_ACTOR_NOT_READY");
          return navigator.locks.request(
            "atlas-backup-v2:" + (profileId ?? replicaId),
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw Error("BACKUP_ACTOR_BUSY");
              return prepareBackupV2Restore({
                factory: scope.indexedDB,
                transport: transport!,
                checkpointId: data.checkpointId,
                stagingReplicaId: data.stagingReplicaId,
                profileId,
                onProgress: (namespace, records, progress) =>
                  scope.postMessage({
                    protocol: BACKUP_WORKER_V2_PROTOCOL,
                    event: "restore-progress",
                    progress,
                    namespace,
                    records,
                  }),
              });
            },
          );
        }
        case "status":
          return service?.status();
        case "stop":
          service?.stop();
          service = undefined;
          for (const s of sources) s.dispose();
          sources = [];
          headers = {};
          return;
        default:
          throw Error("BACKUP_ACTOR_OPERATION_INVALID");
      }
    })().then(reply, (error) =>
      scope.postMessage({
        protocol: BACKUP_WORKER_V2_PROTOCOL,
        id: data.id,
        ok: false,
        error: {
          name: error?.name || "Error",
          message: error?.message || "Backup actor failed",
          code: error?.code,
          status: error?.status,
        },
      }),
    );
  });
}
if (
  typeof document === "undefined" &&
  typeof self !== "undefined" &&
  "postMessage" in self
)
  installBackupV2Worker(self as unknown as Scope);
