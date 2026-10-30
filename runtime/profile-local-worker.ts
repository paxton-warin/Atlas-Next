/** Trusted profile-local transactions must not run on the website's agent.
 * A synchronous document.cookie/localStorage rendezvous blocks that agent: an
 * outstanding App IDB request would otherwise deadlock the independent worker.
 * This worker receives no credentials, fetch capability, or website ports. */
import { checkedProfile, profileDatabaseName, profileIDBPrefix, PROFILE_IDB_KEEP, PROFILE_OUTBOX_PREFIX } from "./profile-journal.ts";
import { profileCatalogName } from "./profile-idb-catalog.ts";
import { nativeProfileQueue, preserveProfileRecovery, changeNamespace, type QueuedProfileChange } from "./profile-sync.ts";
import { setProfilePermit, resumeProfilePermit, revokeProfilePermit } from "./profile-permissions.ts";
import { exportProfileSnapshots, readProfileStreamHead, restoreProfileStream } from "./profile-store.ts";
import { hubNamespace, hubSiteGroup } from "./hub-contracts.ts";
import { compactProfileStream } from "./profile-compaction.ts";
import { createProfileWirePlanner } from "./profile-wire.ts";
import { createProfileHydration } from "./profile-hydration.ts";
import { prepareProfileRecovery, finishProfileRecovery } from "./profile-recovery.ts";

export const PROFILE_LOCAL_PROTOCOL = "atlas-profile-local-v1";
type Scope = { indexedDB: IDBFactory; postMessage(value: unknown, transfer?: Transferable[]): void; addEventListener(type: "message", listener: (event: MessageEvent) => void): void };
export function installProfileLocalWorker(scope: Scope) {
  let profileId: string | undefined;
  let queue: ReturnType<typeof nativeProfileQueue> | undefined;
  let pending = 0;
  const wire = createProfileWirePlanner();
  const recovering = new Set<string>();
  const hydration = createProfileHydration(wire, {
    restore: (n, snapshot, journals, head) => restoreProfileStream(scope.indexedDB, profileId!, n, snapshot, journals, head),
    compact: async (n, stream) => compactProfileStream(scope.indexedDB, n, stream),
  });
  // A queued change may address only this immutable profile's recognized source
  // and exact outbox key, never an arbitrary database/store/key from a caller.
  function change(value: QueuedProfileChange) {
    if (!profileId || value?.entry?.profileId !== profileId) throw Error("PROFILE_LOCAL_CHANGE_INVALID");
    const n = changeNamespace(value), id = value.entry.id;
    if (!["local", "cookies", "idb"].includes(n.kind)) throw Error("PROFILE_LOCAL_CHANGE_INVALID");
    if (typeof id !== "string" || !id || id.length > 128) throw Error("PROFILE_LOCAL_CHANGE_INVALID");
    const local = n.kind === "local", cookies = n.kind === "cookies";
    const database = local ? profileDatabaseName("atlas.browsing.v2", profileId) : cookies ? profileDatabaseName("atlas.browsing.cookies.v2", profileId) : undefined;
    const catalog = value.database === profileCatalogName(profileId);
    const physical = n.kind === "idb" && value.database.startsWith(profileIDBPrefix(value.entry.origin, profileId) + encodeURIComponent(n.name || "")) &&
      (value.database === profileIDBPrefix(value.entry.origin, profileId) + encodeURIComponent(n.name || "") || value.database.startsWith(profileIDBPrefix(value.entry.origin, profileId) + encodeURIComponent(n.name || "") + "#:"));
    if ((database ? value.database !== database : !catalog && !physical) ||
        value.store !== (local ? "origins" : cookies || catalog ? "meta" : PROFILE_IDB_KEEP) ||
        value.arrayKeys !== local ||
        (local ? !Array.isArray(value.key) || value.key.length !== 2 || value.key[0] !== "outbox" || value.key[1] !== id : value.key !== PROFILE_OUTBOX_PREFIX + id))
      throw Error("PROFILE_LOCAL_CHANGE_INVALID");
    return value;
  }
  scope.addEventListener("message", ({ data }) => {
    if (!data || data.protocol !== PROFILE_LOCAL_PROTOCOL || !Number.isSafeInteger(data.id) || data.id < 1) return;
    const reply = (value: unknown, transfer: Transferable[] = []) => scope.postMessage({ protocol: PROFILE_LOCAL_PROTOCOL, id: data.id, ...value as object }, transfer);
    if (pending >= 32) { reply({ ok: false, error: { name: "QuotaExceededError", message: "Profile-local worker backpressure" } }); return; }
    pending++;
    void (async () => {
      if (data.operation === "initialize") {
        if (profileId || !checkedProfile(data.args?.[0])) throw Error("PROFILE_LOCAL_INITIALIZATION_INVALID");
        profileId = data.args[0];
        queue = nativeProfileQueue(scope.indexedDB, profileId!);
        return;
      }
      if (!profileId || !queue) throw Error("PROFILE_LOCAL_NOT_INITIALIZED");
      const args = data.args;
      if (!Array.isArray(args)) throw Error("PROFILE_LOCAL_ARGUMENTS_INVALID");
      switch (data.operation) {
        case "hydrate-begin": return hydration.begin(args[0]);
        case "hydrate-value": return hydration.value(args[0], args[1], args[2]);
        case "hydrate-chunk": return hydration.chunk(args[0], args[1], args[2]);
        case "hydrate-finish": return hydration.finish(args[0]);
        case "hydrate-abort": return hydration.abort(args[0]);
        case "prepare-recovery": {
          const group = hubSiteGroup(args[1]);
          if (recovering.has(group)) throw Error("PROFILE_RECOVERY_BUSY");
          recovering.add(group);
          try {
            const prepared = await prepareProfileRecovery(scope.indexedDB, profileId, args[0], args[1], queue);
            return prepared ? { wire: await wire.prepare(prepared.payload), changes: prepared.changes.length } : null;
          } finally { recovering.delete(group); }
        }
        case "finish-recovery": return finishProfileRecovery(scope.indexedDB, profileId, args[0], args[1]);
        case "wire-encode": return wire.prepare(args[0]);
        case "wire-chunk": return wire.chunk(args[0], args[1]);
        case "wire-release": return wire.release(args[0]);
        case "encode": return wire.encode(args[0]);
        case "recovery-file": {
          const value = args[0];
          if (value?.format === "atlas-recovery-packed-v1" && value.archive instanceof Blob)
            return { blob: value.archive, extension: ".atlas-recovery.ndjson" };
          return { blob: new Blob([JSON.stringify(await wire.encode(value), null, 2)], { type: "application/json" }), extension: ".json" };
        }
        case "decode": return wire.decode(args[0]);
        case "decode-bytes":
          if (!(args[0] instanceof ArrayBuffer)) throw Error("PROFILE_LOCAL_ARGUMENTS_INVALID");
          return wire.decode(args[0]);
        case "decode-chunk": return wire.decodeChunk(args[0], args[1]);
        case "decode-wire-bytes": return wire.decodeBytes(args[0], args[1]);
        case "queue-list": return queue.metadata!(args[0]);
        case "queue-wire": return wire.prepare(await queue.payload!(change(args[0])));
        case "queue-namespaces": {
          const namespaces = new Map<string, ReturnType<typeof changeNamespace>>();
          for (const item of await queue.list(args[0])) {
            const namespace = changeNamespace(item);
            namespaces.set(hubNamespace(namespace).key, namespace);
          }
          return [...namespaces.values()];
        }
        case "queue-compaction": return queue.compaction!(change(args[0]));
        case "queue-prepare-compaction": return queue.prepareCompaction!(change(args[0]), args[1]);
        case "queue-finish-compaction": return queue.finishCompaction!(change(args[0]), args[1]);
        case "compact": hubNamespace(args[0]); return compactProfileStream(scope.indexedDB, args[0], args[1]);
        case "queue-head": return queue.head(change(args[0]));
        case "queue-prepared": return queue.prepared!(change(args[0]));
        case "queue-prepare": return queue.prepare!(change(args[0]), args[1]);
        case "queue-acknowledge": return queue.acknowledge(change(args[0]), args[1]);
        case "set-permit":
          if (args[0]?.profileId !== profileId) throw Error("PROFILE_LOCAL_PERMIT_INVALID");
          return setProfilePermit(scope.indexedDB, args[0]);
        case "resume-permit":
          if (args[0]?.profileId !== profileId) throw Error("PROFILE_LOCAL_PERMIT_INVALID");
          return resumeProfilePermit(scope.indexedDB, args[0]);
        case "revoke-permit":
          if (args[0]?.profileId !== profileId) throw Error("PROFILE_LOCAL_PERMIT_INVALID");
          return revokeProfilePermit(scope.indexedDB, args[0]);
        case "read-head": hubNamespace(args[0]); return readProfileStreamHead(scope.indexedDB, profileId, args[0]);
        case "restore": hubNamespace(args[0]); return restoreProfileStream(scope.indexedDB, profileId, args[0], args[1], args[2], args[3]);
        case "export": return exportProfileSnapshots(scope.indexedDB, profileId, undefined, args[0]);
        case "preserve-recovery":
          if (typeof args[0] !== "string" || !args[0] || args[0].length > 128 || !Array.isArray(args[1])) throw Error("PROFILE_LOCAL_RECOVERY_INVALID");
          args[1].forEach(change);
          return preserveProfileRecovery(scope.indexedDB, profileId, args[0], args[1], args[2]);
        default: throw Error("PROFILE_LOCAL_OPERATION_INVALID");
      }
    })().then(value => reply({ ok: true, value }, value instanceof ArrayBuffer ? [value] : []), error => reply({ ok: false, error: {
      name: String(error?.name || "Error").slice(0, 80), message: String(error?.message || "Profile-local operation failed").slice(0, 1024),
      ...(typeof error?.code === "string" ? { code: error.code.slice(0, 128) } : {}),
    } })).finally(() => { pending--; });
  });
}
if (typeof globalThis.document === "undefined" && typeof globalThis.postMessage === "function" && typeof globalThis.indexedDB !== "undefined")
  installProfileLocalWorker(globalThis as unknown as Scope);
