/** V2-only native actor backend. No cloud permit, Hub contract, writer lease,
 * history replay or backup codec exists in this module's dependency graph. */
import { auditLocalIDBChanges } from "./local-idb-accounting.ts";
import { appendLocalDirty } from "./local-dirty-v2.ts";
import {
  assertLocalBindingAuthority,
  checkedLocalBindingAuthority,
  type LocalActorAuthority,
  type LocalBindingAuthority,
} from "./local-authority.ts";
import { profileIDBPrefix, checkedProfile } from "./local-storage-names.ts";
import {
  resolveProfileIDBDatabase,
  listProfileIDBDatabases,
  deleteLocalIDBDatabase,
} from "./local-idb-catalog.ts";
import {
  withQuotaLifecycle,
  reserveQuotaDatabase,
  removeQuotaDatabase,
  reconcileQuotaSources,
  reconcileQuotaSource,
  reserveQuotaCommit,
  finishQuotaCommit,
  type QuotaIntent,
} from "./local-idb-quota.ts";
/** Real native IndexedDB transactions behind an origin-bound MessagePort.
 * Website code never receives a native database or a frontend namespace.
 * Request commands are run only in active native request callbacks. The native
 * keepalive stops only after the client task fence and all request events ack.
 */
const PROTOCOL = "atlas-idb-v1";
const PREFIX = "atlas.browsing.idb.v2:";
const KEEP = "__atlas_idb_keepalive_v2__";
const TIMEOUT = 30000;
type Any = any;
export const SANDBOX_IDB_LIMITS = Object.freeze({
  quotaBytes: 64 * 1024 * 1024,
  maxDatabases: 64,
  maxConnections: 16,
  maxTransactions: 16,
  maxPendingRequests: 128,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxQueueBytes: 8 * 1024 * 1024,
  maxStores: 32,
  maxIndexes: 16,
  maxRecords: 20000,
  maxIndexEntries: 100000,
  maxValueNodes: 40000,
  maxValueDepth: 64,
  maxNameLength: 256,
  maxTransactionMs: 60000,
});
export type SandboxIDBLimits = {
  [K in keyof typeof SANDBOX_IDB_LIMITS]: number;
};
const quotaError = (message: string) =>
  new DOMException(message, "QuotaExceededError");
/** Conservative logical byte accounting, not native browser disk-size claims.
 * Bound the walk before cloning; accessors are deliberately rejected so a getter
 * cannot manufacture an unbounded second value during structuredClone. */
export function boundedIDBValueBytes(
  value: any,
  limit: number = SANDBOX_IDB_LIMITS.maxPayloadBytes,
  maxNodes: number = SANDBOX_IDB_LIMITS.maxValueNodes,
  maxDepth: number = SANDBOX_IDB_LIMITS.maxValueDepth,
  automaticShape?: { eligible: boolean },
): number {
  let bytes = 0,
    nodes = 0;
  const seen = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (!Number.isSafeInteger(bytes) || bytes > limit)
      throw quotaError("IndexedDB payload exceeds its byte allowance");
  };
  const walk = (item: any, depth: number) => {
    if (++nodes > maxNodes || depth > maxDepth)
      throw quotaError("IndexedDB value structure exceeds its allowance");
    if (item === null || item === undefined) {
      add(8);
      return;
    }
    const type = typeof item;
    if (type === "string") {
      add(16 + 2 * item.length);
      return;
    }
    if (type === "number" || type === "boolean") {
      add(8);
      return;
    }
    if (type === "bigint") {
      if (item >= 1n << 4096n || item <= -(1n << 4096n))
        throw quotaError("IndexedDB BigInt exceeds its allowance");
      add(16 + item.toString(16).length);
      return;
    }
    if (type === "function" || type === "symbol")
      throw new DOMException("Value cannot be cloned", "DataCloneError");
    if (seen.has(item)) {
      add(8);
      return;
    }
    seen.add(item);
    add(32);
    // A normal Scramjet document has another JS realm. Use native brand
    // accessors after the tag check; parent instanceof would reject its valid
    // Blob/Date/Map/etc. before the native structured clone can normalize it.
    const brand = Object.prototype.toString.call(item);
    if (
      item instanceof Blob ||
      brand === "[object Blob]" ||
      brand === "[object File]"
    ) {
      const size = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        "size",
      )!.get!.call(item);
      const mime = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        "type",
      )!.get!.call(item);
      add(size + 256 + 2 * mime.length);
      if (
        typeof File !== "undefined" &&
        (item instanceof File || brand === "[object File]")
      ) {
        const name = Object.getOwnPropertyDescriptor(
          File.prototype,
          "name",
        )!.get!.call(item);
        add(32 + 2 * name.length);
      }
      return;
    }
    if (item instanceof ArrayBuffer || brand === "[object ArrayBuffer]") {
      add(
        Object.getOwnPropertyDescriptor(
          ArrayBuffer.prototype,
          "byteLength",
        )!.get!.call(item),
      );
      return;
    }
    if (ArrayBuffer.isView(item)) {
      const prototype =
        item instanceof DataView || brand === "[object DataView]"
          ? DataView.prototype
          : Object.getPrototypeOf(Uint8Array.prototype);
      // Structured clone stores the WHOLE backing buffer, not only the view.
      // Count that backing object once even when several views share it.
      const buffer = Object.getOwnPropertyDescriptor(
        prototype,
        "buffer",
      )!.get!.call(item);
      add(16);
      walk(buffer, depth + 1);
      return;
    }
    if (item instanceof Date || brand === "[object Date]") {
      Date.prototype.getTime.call(item); // reject forged Date.prototype objects
      add(16);
      return;
    }
    if (item instanceof RegExp || brand === "[object RegExp]") {
      add(
        32 +
          2 *
            Object.getOwnPropertyDescriptor(
              RegExp.prototype,
              "source",
            )!.get!.call(item).length,
      );
      return;
    }
    if (item instanceof Map || brand === "[object Map]") {
      if (
        Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!.call(
          item,
        ) > maxNodes
      )
        throw quotaError("IndexedDB map exceeds its allowance");
      Map.prototype.forEach.call(item, (v: any, k: any) => {
        walk(k, depth + 1);
        walk(v, depth + 1);
      });
      return;
    }
    if (item instanceof Set || brand === "[object Set]") {
      if (
        Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!.call(
          item,
        ) > maxNodes
      )
        throw quotaError("IndexedDB set exceeds its allowance");
      Set.prototype.forEach.call(item, (v: any) => walk(v, depth + 1));
      return;
    }
    if (item instanceof Error || brand === "[object Error]") {
      // Genuine Errors serialize hidden fields; forged Error.prototype objects
      // may instead clone as ordinary objects, so also charge every own field.
      for (const name of ["name", "message", "stack", "cause"]) {
        let prototype = item;
        while (prototype) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
          if (descriptor) {
            if (!("value" in descriptor))
              throw new DOMException("Accessor-backed error", "DataCloneError");
            walk(descriptor.value, depth + 1);
            break;
          }
          prototype = Object.getPrototypeOf(prototype);
        }
      }
      for (const name in item) {
        if (!Object.hasOwn(item, name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
        if (!("value" in descriptor))
          throw new DOMException("Accessor-backed error", "DataCloneError");
        add(16 + 2 * name.length);
        walk(descriptor.value, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(item);
    // Unsupported platform objects can carry hidden cloneable data (ImageData,
    // CryptoKey, VideoFrame, etc.). Never estimate them as empty plain objects.
    if (
      !Array.isArray(item) &&
      prototype !== null &&
      prototype !== Object.prototype &&
      !(
        brand === "[object Object]" && Object.getPrototypeOf(prototype) === null
      )
    )
      throw new DOMException(
        "Unsupported storage value type",
        "DataCloneError",
      );
    if (Array.isArray(item)) {
      if (item.length > maxNodes)
        throw quotaError("IndexedDB array exceeds its allowance");
      // Holes still carry array length/allocation cost in structured clone.
      add(8 * item.length);
    }
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor))
        throw new DOMException(
          "Accessor-backed storage values are not accepted",
          "DataCloneError",
        );
      add(16 + 2 * key.length);
      walk(descriptor.value, depth + 1);
    }
  };
  walk(value, 0);
  if (automaticShape)
    automaticShape.eligible = nodes <= 4096 && bytes <= 256 * 1024;
  return bytes;
}

const errorValue = (error: Any) => ({
  name: String(error?.name || "UnknownError").slice(0, 80),
  message: String(error?.message || "IndexedDB operation failed").slice(
    0,
    1024,
  ),
});
const exception = (error: Any) =>
  new DOMException(error?.message || "", error?.name || "UnknownError");
const names = (values: string[]) =>
  Object.assign([...values].sort(), {
    contains(value: string) {
      return values.includes(value);
    },
    item(index: number) {
      return [...values].sort()[index] ?? null;
    },
  });
function identity(
  website: string,
  frontendOrigin: string,
  profileId?: string | null,
) {
  const url = new URL(website),
    frontend = new URL(frontendOrigin);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname === frontend.hostname
  )
    throw new TypeError("Invalid website storage capability");
  return profileIDBPrefix(url.origin, profileId);
}
function copySchema(input: Any) {
  const result = Object.create(null);
  for (const [name, value] of Object.entries(input) as [string, Any][])
    result[name] = {
      ...value,
      indexes: Object.assign(Object.create(null), value.indexes),
    };
  return result;
}
function schema(db: IDBDatabase, tx?: IDBTransaction) {
  const output: Any = Object.create(null);
  const transaction =
    tx || db.transaction(Array.from(db.objectStoreNames), "readonly");
  for (const name of Array.from(db.objectStoreNames)) {
    if (name === KEEP) continue;
    const store = transaction.objectStore(name),
      indexes: Any = Object.create(null);
    for (const name of Array.from(store.indexNames)) {
      const index = store.index(name);
      indexes[name] = {
        name,
        keyPath: index.keyPath,
        multiEntry: index.multiEntry,
        unique: index.unique,
      };
    }
    output[name] = {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes,
    };
  }
  return output;
}
function unpack(value: Any): Any {
  if (value && typeof value === "object" && value.__atlasKeyRange === 1) {
    if (value.lower === undefined)
      return IDBKeyRange.upperBound(value.upper, value.upperOpen);
    if (value.upper === undefined)
      return IDBKeyRange.lowerBound(value.lower, value.lowerOpen);
    return IDBKeyRange.bound(
      value.lower,
      value.upper,
      value.lowerOpen,
      value.upperOpen,
    );
  }
  return value;
}
export function bindLocalSandboxIndexedDB(binding: {
  port: MessagePort;
  documentId: string;
  website: string;
  frontendOrigin: string;
  factory: IDBFactory;
  profileId?: string | null;
  profileContextId?: string;
  timeoutMs?: number;
  limits?: Partial<SandboxIDBLimits>;
  localAuthority: LocalBindingAuthority;
  localAuthorityCurrent?: () => LocalActorAuthority | null;
  onLocalMutation?: () => void;
}) {
  const { port, documentId, factory } = binding,
    prefix = identity(
      binding.website,
      binding.frontendOrigin,
      binding.profileId,
    );
  const local = binding.localAuthority;
  if (!local)
    throw new DOMException("Local authorization is required", "SecurityError");
  if (local) {
    checkedLocalBindingAuthority(
      local,
      binding.localAuthorityCurrent ? binding.localAuthorityCurrent()! : local,
      documentId,
      binding.website,
    );
    if (binding.profileId !== local.replicaId)
      throw new DOMException(
        "Local physical namespace mismatch",
        "SecurityError",
      );
  }
  const assertLocal = () => {
    if (local)
      assertLocalBindingAuthority(
        local,
        binding.localAuthorityCurrent ? binding.localAuthorityCurrent() : local,
      );
  };
  const limits = { ...SANDBOX_IDB_LIMITS, ...binding.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError("Invalid IndexedDB resource limit");
  const features = {
    records:
      typeof (globalThis.IDBObjectStore?.prototype as Any)?.getAllRecords ===
      "function",
  };
  // This is one origin allowance, not maxDatabases equally sized slices.
  const sliceBytes = limits.quotaBytes; // compatibility field: maximum single DB budget
  if (sliceBytes < 256) throw new TypeError("IndexedDB quota is too small");
  const metadataName = prefix + "#quota";
  const logicalNames = new WeakMap<IDBDatabase, string>();
  const assertWrite = () => Promise.resolve().then(assertLocal);
  const assertWriteCached = assertLocal;
  let reconciled = false;
  const reservedOperation = <T>(
    name: string,
    remove: boolean,
    action: (physical: string) => Promise<T>,
  ): Promise<T> =>
    withQuotaLifecycle(prefix, async () => {
      if (!live) throw new DOMException("Document closed", "AbortError");
      if (!reconciled) {
        const sources = (
          await listProfileIDBDatabases(factory, binding.profileId ?? null)
        )
          .filter(
            (d) =>
              d.origin === new URL(binding.website).origin &&
              d.physical &&
              !d.deleted &&
              !d.deleting,
          )
          .map((d) => ({ name: d.name, physical: d.physical! }));
        await reconcileQuotaSources(factory, prefix, sources);
        reconciled = true;
      }
      const physical = await resolveProfileIDBDatabase(
        factory,
        binding.profileId,
        new URL(binding.website).origin,
        name,
        remove,
      );
      if (!remove)
        await reserveQuotaDatabase(
          factory,
          prefix,
          name,
          physical,
          limits.maxDatabases,
        );
      const result = await action(physical);
      if (remove) await removeQuotaDatabase(factory, prefix, name);
      return result;
    });

  // Pre-resource prototype databases are not silently trusted or erased. Only
  // databases committed through this quota ledger may produce result arrays.
  const verifyLedger = (db: IDBDatabase) =>
    new Promise<void>((resolve, reject) => {
      if (!db.objectStoreNames.contains(KEEP)) {
        reject(quotaError("Database has no bounded storage ledger"));
        return;
      }
      const tx = db.transaction(KEEP, "readonly"),
        request = tx.objectStore(KEEP).get("usage");
      let failure: Any;
      request.onsuccess = () => {
        const usage = request.result;
        if (
          !usage ||
          !Number.isSafeInteger(usage.bytes) ||
          usage.bytes < 0 ||
          usage.records > limits.maxRecords ||
          usage.indexEntries > limits.maxIndexEntries
        )
          failure = quotaError(
            "Database storage ledger is absent or exceeds policy",
          );
      };
      tx.oncomplete = () => {
        if (failure) {
          reject(failure);
          return;
        }
        void reconcileQuotaSource(factory, prefix, {
          name: logicalNames.get(db)!,
          physical: db.name,
        }).then(resolve, reject);
      };
      tx.onabort = () =>
        reject(
          tx.error || new DOMException("Ledger audit aborted", "AbortError"),
        );
    });

  const connections = new Map<string, IDBDatabase>(),
    transactions = new Map<string, Any>(),
    cursors = new Map<string, IDBCursor>();
  let live = true,
    next = 1,
    serial = 0,
    eventSerial = 0,
    pendingOpens = 0,
    pendingControls = 0,
    queuedBytes = 0,
    retainedResultBytes = 0,
    invalidMessages = 0,
    lastRequest = 0;
  const openTimers = new Set<ReturnType<typeof setTimeout>>();
  function dispose(notify = true) {
    if (!live) return;
    if (notify)
      try {
        port.postMessage({
          protocol: PROTOCOL,
          documentId,
          type: "closed",
          error: errorValue(
            new DOMException("Document capability disposed", "AbortError"),
          ),
        });
      } catch {}
    live = false;
    port.removeEventListener("message", receive);
    port.removeEventListener("messageerror", messageError);
    for (const timer of openTimers) clearTimeout(timer);
    openTimers.clear();
    pendingOpens = pendingControls = 0;
    for (const state of transactions.values())
      try {
        state.tx.abort();
      } catch {}
    for (const db of connections.values()) db.close();
    transactions.clear();
    connections.clear();
    cursors.clear();
    queuedBytes = retainedResultBytes = 0;
    port.close();
  }
  function terminate(error: Any) {
    if (!live) return;
    try {
      port.postMessage({
        protocol: PROTOCOL,
        documentId,
        type: "closed",
        error: errorValue(error),
      });
    } catch {}
    dispose(false);
  }
  const messageError = () =>
    terminate(
      new DOMException("IndexedDB capability message failed", "DataCloneError"),
    );
  const outstanding = () =>
    [...transactions.values()].reduce(
      (sum, state) =>
        sum + state.queue.length + state.inflight + state.waiting.size,
      0,
    ) +
    pendingOpens +
    pendingControls;

  const send = (message: Any) => {
    if (!live) return;
    try {
      const responseBytes = boundedIDBValueBytes(
        message,
        limits.maxResponseBytes,
        limits.maxValueNodes,
        limits.maxValueDepth,
      );
      if (message.type === "result" && message.eventId) {
        const state = transactions.get(message.transaction);
        if (state) {
          if (retainedResultBytes + responseBytes > limits.maxQueueBytes)
            throw quotaError(
              "Document unacknowledged result allowance exhausted",
            );
          retainedResultBytes += responseBytes;
          state.resultBytes.set(message.eventId, responseBytes);
        }
      }
      port.postMessage({ protocol: PROTOCOL, documentId, ...message });
    } catch (error) {
      terminate(error);
    }
  };
  const fail = (request: number, error: Any) =>
    send({ type: "result", request, error: errorValue(error) });
  const connect = (db: IDBDatabase, id: string) => {
    connections.set(id, db);
    db.onversionchange = (event) =>
      send({
        type: "versionchange",
        connection: id,
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
      });
    db.onclose = () => {
      connections.delete(id);
      send({ type: "close", connection: id });
    };
  };
  const attach = (
    tx: IDBTransaction,
    id: string,
    connection: string,
    upgrade = false,
  ) => {
    const state: Any = {
      tx,
      id,
      connection,
      upgrade,
      queue: [],
      waiting: new Set(),
      inflight: 0,
      failures: new Map(),
      fenced: false,
      commit: false,
      last: Date.now(),
      finished: false,
      started: Date.now(),
      checkingQuota: false,
      profileChanges: [] as Any[],
      profileJournaled: false,
      quotaValid: false,
      baseUsage: 0,
      baseRecords: 0,
      baseIndexEntries: 0,
      quotaIntent: undefined as QuotaIntent | undefined,
      commandBytes: 0,
      resultBytes: new Map(),
    };
    transactions.set(id, state);
    tx.oncomplete = () => {
      state.finished = true;
      if (state.quotaIntent)
        void finishQuotaCommit(factory, prefix, state.quotaIntent, true).catch(
          () => {},
        );
      for (const bytes of state.resultBytes.values())
        retainedResultBytes = Math.max(0, retainedResultBytes - bytes);
      state.resultBytes.clear();
      for (const [key, cursor] of cursors)
        if (cursor.request.transaction === tx) cursors.delete(key);
      transactions.delete(id);
      if (
        binding.profileId &&
        tx.mode !== "readonly" &&
        typeof window !== "undefined"
      )
        window.dispatchEvent(
          new CustomEvent("atlas:profile-native-change", {
            detail: {
              profileId: binding.profileId,
              origin: new URL(binding.website).origin,
              kind: "idb",
            },
          }),
        );
      if (local && tx.mode !== "readonly") binding.onLocalMutation?.();
      send({ type: "complete", transaction: id });
    };
    tx.onabort = () => {
      state.finished = true;
      if (state.quotaIntent)
        void finishQuotaCommit(factory, prefix, state.quotaIntent, false).catch(
          () => {},
        );
      for (const bytes of state.resultBytes.values())
        retainedResultBytes = Math.max(0, retainedResultBytes - bytes);
      state.resultBytes.clear();
      for (const [key, cursor] of cursors)
        if (cursor.request.transaction === tx) cursors.delete(key);
      transactions.delete(id);
      send({
        type: "abort",
        transaction: id,
        error: errorValue(
          state.abortError ||
            tx.error ||
            new DOMException("Transaction aborted", "AbortError"),
        ),
      });
    };
    tx.onerror = (event) => event.preventDefault();
    const abortQuota = (error: Any) => {
      state.abortError = error;
      try {
        tx.abort();
      } catch {}
    };
    const checkQuota = () => {
      state.checkingQuota = true;
      if (local) {
        auditLocalIDBChanges({
          tx,
          keep: tx.objectStore(KEEP),
          changes: state.profileChanges.filter(
            (change: Any) => change !== undefined,
          ),
          base: {
            bytes: state.baseUsage,
            records: state.baseRecords,
            indexEntries: state.baseIndexEntries,
          },
          limits,
          factory,
          measure: boundedIDBValueBytes,
          unpack,
          onRecord: (store, key, value) => {
            if (
              !state.profileChanges.some(
                (c: Any) =>
                  c?.type === "schema" &&
                  c.action === "renameStore" &&
                  c.name === store,
              )
            )
              return;
            const shape = { eligible: true },
              bytes =
                boundedIDBValueBytes(
                  value,
                  limits.maxPayloadBytes,
                  limits.maxValueNodes,
                  limits.maxValueDepth,
                  shape,
                ) +
                boundedIDBValueBytes(key, limits.maxPayloadBytes) +
                64;
            appendLocalDirty(tx.objectStore(KEEP), {
              namespace: JSON.stringify([
                "idb",
                local.logicalOrigin,
                logicalNames.get(tx.db) || "",
              ]),
              store,
              key,
              operation: "upsert",
              estimatedNativeBytes: bytes,
              shapeEligible: shape.eligible && bytes <= 256 * 1024,
            });
          },
          onDelete: (store, key) =>
            appendLocalDirty(tx.objectStore(KEEP), {
              namespace: JSON.stringify([
                "idb",
                local.logicalOrigin,
                logicalNames.get(tx.db) || "",
              ]),
              store,
              key,
              operation: "delete",
            }),
          fail: abortQuota,
          done: (usage) => {
            let ready = false,
              reservationError: unknown;
            void reserveQuotaCommit(
              factory,
              prefix,
              { name: logicalNames.get(tx.db)!, physical: tx.db.name },
              state.baseUsage,
              usage.bytes,
              limits.quotaBytes,
            ).then(
              (intent) => {
                if (state.finished) {
                  void finishQuotaCommit(factory, prefix, intent, false).catch(
                    () => {},
                  );
                  return;
                }
                state.quotaIntent = intent;
                ready = true;
              },
              (error) => {
                reservationError = error;
              },
            );
            const hold = () => {
              if (state.finished) return;
              if (reservationError) {
                abortQuota(reservationError);
                return;
              }
              const publishing = ready;
              const request = publishing
                ? tx
                    .objectStore(KEEP)
                    .put(
                      {
                        ...usage,
                        localAccountingVersion: 2,
                        sliceBytes: limits.quotaBytes,
                      },
                      "usage",
                    )
                : tx.objectStore(KEEP).get(0);
              request.onerror = () => abortQuota(request.error);
              request.onsuccess = () => {
                if (!publishing) hold();
                else {
                  state.checkingQuota = false;
                  state.quotaValid = true;
                  pump();
                }
              };
            };
            hold();
          },
        });
        return;
      }
    };
    const pump = () => {
      if (state.finished) return;
      if (
        Date.now() - state.last > (binding.timeoutMs || TIMEOUT) ||
        Date.now() - state.started > limits.maxTransactionMs
      ) {
        tx.abort();
        return;
      }
      const batch = state.queue.splice(0);
      for (const message of batch) {
        queuedBytes = Math.max(0, queuedBytes - message.bytes);
        execute(state, message);
      }
      if (state.finished) return;
      if (
        (state.fenced || state.commit) &&
        !state.waiting.size &&
        !state.inflight &&
        !state.queue.length
      ) {
        if (tx.mode !== "readonly" && !state.quotaValid) {
          if (!state.checkingQuota) checkQuota();
          return;
        }
        if (
          binding.profileId &&
          tx.mode !== "readonly" &&
          !state.profileJournaled
        ) {
          state.profileJournaled = true;
          try {
            assertWriteCached();
            // Failed requests whose errors were prevented leave empty reserved
            // slots. Only successful native mutations belong in the outbox.
            const changes = state.profileChanges.filter(
              (change: Any) => change !== undefined,
            );
            if (local) {
              const namespace = JSON.stringify([
                "idb",
                local.logicalOrigin,
                logicalNames.get(tx.db) || "",
              ]);
              for (const change of changes) {
                const schemaChange = change.type === "schema";
                const query =
                  change.action === "delete"
                    ? unpack(change.args?.[0])
                    : undefined;
                if (
                  schemaChange &&
                  ["deleteStore", "renameStore"].includes(change.action)
                )
                  appendLocalDirty(tx.objectStore(KEEP), {
                    namespace,
                    store: change.store,
                    operation: "clear",
                  });
                appendLocalDirty(tx.objectStore(KEEP), {
                  namespace,
                  store: change.store,
                  operation:
                    schemaChange || query instanceof IDBKeyRange
                      ? "schema"
                      : change.action === "clear"
                        ? "clear"
                        : change.action === "delete"
                          ? "delete"
                          : "upsert",
                  key:
                    schemaChange ||
                    query instanceof IDBKeyRange ||
                    change.action === "clear"
                      ? undefined
                      : change.action === "delete"
                        ? query
                        : change.key,
                  estimatedNativeBytes: change.estimatedNativeBytes,
                  shapeEligible: change.shapeEligible !== false,
                });
              }
            }
          } catch (error) {
            abortQuota(error);
            return;
          }
          return; // Native auto-commit waits for the queued atomic outbox writes.
        }
        if (!upgrade && typeof tx.commit === "function") tx.commit();
        return;
      }
      try {
        const keep = tx.objectStore(KEEP).get(0);
        keep.onsuccess = pump;
        keep.onerror = () => {
          // Aborting a transaction also aborts its outstanding keepalive
          // request. Its error event must not abort the finished TX again.
          try {
            tx.abort();
          } catch {
            /* native abort owns final status */
          }
        };
      } catch {
        /* native completion/abort owns final status */
      }
    };
    const initial = tx.objectStore(KEEP).get("usage");
    initial.onsuccess = () => {
      const bytes = initial.result?.bytes ?? 0;
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        abortQuota(quotaError("Invalid native usage ledger"));
        return;
      }
      state.baseUsage = bytes;
      state.baseRecords = initial.result?.records ?? 0;
      state.baseIndexEntries = initial.result?.indexEntries ?? 0;
      if (local && bytes && initial.result?.localAccountingVersion !== 2) {
        abortQuota(
          new DOMException(
            "Local database requires an explicit accounting migration",
            "InvalidStateError",
          ),
        );
        return;
      }
      pump();
    };
    initial.onerror = () => abortQuota(initial.error);
    return state;
  };
  const execute = (state: Any, message: Any) => {
    const { tx } = state;
    if (
      message.type === "schema" ||
      ["put", "add", "delete", "clear", "update"].includes(message.action)
    )
      state.quotaValid = false;
    try {
      if (
        message.type === "schema" ||
        ["put", "add", "delete", "clear", "update"].includes(message.action)
      )
        assertWriteCached();
      if (message.type === "schema") {
        const db = tx.db;
        if (
          message.action === "createStore" &&
          db.objectStoreNames.length - 1 >= limits.maxStores
        )
          throw quotaError("Object store allowance exhausted");
        if (
          message.action === "createIndex" &&
          tx.objectStore(message.store).indexNames.length >= limits.maxIndexes
        )
          throw quotaError("Index allowance exhausted");
        if (message.action === "createStore")
          db.createObjectStore(message.store, message.options);
        else if (message.action === "deleteStore")
          db.deleteObjectStore(message.store);
        else if (message.action === "createIndex")
          tx.objectStore(message.store).createIndex(
            message.index,
            message.keyPath,
            message.options,
          );
        else if (message.action === "deleteIndex")
          tx.objectStore(message.store).deleteIndex(message.index);
        else if (message.action === "renameStore")
          tx.objectStore(message.store).name = message.name;
        else if (message.action === "renameIndex")
          tx.objectStore(message.store).index(message.index).name =
            message.name;
        else throw new TypeError("Unknown schema operation");
        if (binding.profileId)
          state.profileChanges.push({
            type: "schema",
            action: message.action,
            store: message.store,
            index: message.index,
            name: message.name,
            options: message.options,
            keyPath: message.keyPath,
          });
        return;
      }
      let request: IDBRequest;
      let profileMutation: Any | undefined;
      if (message.type === "cursor") {
        const cursor = cursors.get(message.cursor);
        if (!cursor || cursor.request.transaction !== tx)
          throw new DOMException(
            "Cursor no longer exists",
            "InvalidStateError",
          );
        if (message.action === "continue") {
          state.inflight++;
          cursor.continue(...message.args.map(unpack));
          return;
        }
        if (message.action === "advance") {
          state.inflight++;
          cursor.advance(message.args[0]);
          return;
        }
        if (message.action === "continuePrimaryKey") {
          state.inflight++;
          (cursor as IDBCursorWithValue).continuePrimaryKey(
            message.args[0],
            message.args[1],
          );
          return;
        }
        if (
          binding.profileId &&
          ["update", "delete"].includes(message.action)
        ) {
          const source = cursor.source as IDBObjectStore | IDBIndex;
          profileMutation = {
            type: "operation",
            action: message.action === "update" ? "put" : "delete",
            store:
              "objectStore" in source ? source.objectStore.name : source.name,
            args:
              message.action === "update"
                ? [message.args[0], cursor.primaryKey]
                : [cursor.primaryKey],
            key: cursor.primaryKey,
          };
        }
        if (message.action === "update")
          request = (cursor as IDBCursorWithValue).update(message.args[0]);
        else if (message.action === "delete") request = cursor.delete();
        else throw new TypeError("Unknown cursor operation");
      } else {
        let source: Any = tx.objectStore(message.store);
        if (message.index) source = source.index(message.index);
        const methods = [
          "get",
          "getKey",
          "getAll",
          "getAllKeys",
          "getAllRecords",
          "count",
          "put",
          "add",
          "delete",
          "clear",
          "openCursor",
          "openKeyCursor",
        ];
        if (!methods.includes(message.action))
          throw new TypeError("Unknown IndexedDB operation");
        const args = [...message.args];
        if (
          [
            "get",
            "getKey",
            "getAll",
            "getAllKeys",
            "getAllRecords",
            "count",
            "delete",
            "openCursor",
            "openKeyCursor",
          ].includes(message.action) &&
          args.length
        ) {
          if (
            ["getAll", "getAllKeys", "getAllRecords"].includes(
              message.action,
            ) &&
            args[0] &&
            typeof args[0] === "object" &&
            !Array.isArray(args[0]) &&
            !(args[0] instanceof Date) &&
            !(args[0] instanceof ArrayBuffer) &&
            !ArrayBuffer.isView(args[0]) &&
            args[0].__atlasKeyRange !== 1
          )
            args[0] = { ...args[0], query: unpack(args[0].query) };
          else args[0] = unpack(args[0]);
        }
        if (
          (message.action === "getAllRecords" ||
            (["getAll", "getAllKeys"].includes(message.action) &&
              args[0] &&
              typeof args[0] === "object" &&
              Object.hasOwn(args[0], "direction"))) &&
          !features.records
        )
          throw new DOMException(
            "Modern IndexedDB queries are not supported by this browser",
            "NotSupportedError",
          );
        request = source[message.action](...args);
      }
      // Schema operations execute synchronously, while mutation success arrives
      // later. Reserve the mutation's position now so upgrades with renames,
      // deletes or re-created names replay in the same order as native IDB.
      const mutationIndex =
        binding.profileId &&
        ["put", "add", "delete", "clear", "update"].includes(message.action)
          ? state.profileChanges.push(undefined) - 1
          : -1;
      state.inflight++;
      request!.onsuccess = () => {
        state.inflight--;
        if (mutationIndex >= 0)
          state.profileChanges[mutationIndex] = profileMutation || {
            type: message.type,
            action: message.action,
            store: message.store,
            args: message.args,
            key: request!.result,
          };
        if (local && mutationIndex >= 0) {
          const change = state.profileChanges[mutationIndex];
          const automaticShape = { eligible: true };
          change.estimatedNativeBytes = ["put", "add", "update"].includes(
            message.action,
          )
            ? boundedIDBValueBytes(
                message.args[0],
                limits.maxPayloadBytes,
                limits.maxValueNodes,
                limits.maxValueDepth,
                automaticShape,
              ) +
              boundedIDBValueBytes(change.key, limits.maxPayloadBytes) +
              64
            : 0;
          change.shapeEligible =
            automaticShape.eligible &&
            change.estimatedNativeBytes <= 256 * 1024;
          // Native values remain in their source store, not in a mutation journal.
          change.args = change.action === "delete" ? [change.args?.[0]] : [];
        }
        const eventId = ++eventSerial;
        state.waiting.add(eventId);
        state.fenced = false;
        let value = request!.result;
        if (message.action === "getAllRecords")
          value = value.map((record: Any) => ({
            key: record.key,
            primaryKey: record.primaryKey,
            value: record.value,
          }));
        if (
          value &&
          typeof value === "object" &&
          typeof value.continue === "function"
        ) {
          const cursor = "cursor:" + message.request;
          cursors.set(cursor, value);
          value = {
            __atlasCursor: 1,
            cursor,
            key: value.key,
            primaryKey: value.primaryKey,
            value: "value" in value ? value.value : undefined,
            direction: value.direction,
            keyOnly: !("value" in value),
          };
        } else cursors.delete("cursor:" + message.request);
        send({
          type: "result",
          request: message.request,
          transaction: state.id,
          eventId,
          records: message.action === "getAllRecords",
          value,
        });
      };
      request!.onerror = (event) => {
        state.inflight--;
        event.preventDefault();
        event.stopPropagation();
        const eventId = ++eventSerial;
        state.waiting.add(eventId);
        state.failures.set(eventId, request!.error);
        state.fenced = false;
        send({
          type: "result",
          request: message.request,
          transaction: state.id,
          eventId,
          error: errorValue(request!.error),
        });
      };
    } catch (error) {
      if (message.request) {
        const eventId = ++eventSerial;
        state.waiting.add(eventId);
        state.failures.set(eventId, error);
        send({
          type: "result",
          request: message.request,
          transaction: state.id,
          eventId,
          error: errorValue(error),
        });
      } else {
        state.abortError = error;
        try {
          tx.abort();
        } catch {}
      }
    }
  };
  const handle = async (event: MessageEvent) => {
    const m = event.data;
    if (
      !live ||
      !m ||
      m.protocol !== PROTOCOL ||
      m.documentId !== documentId ||
      m.sequence !== next ||
      typeof m.type !== "string" ||
      !Number.isSafeInteger(next) ||
      "origin" in m ||
      "namespace" in m
    ) {
      send({
        type: "protocol-error",
        error: errorValue(
          new DOMException("Invalid document capability", "SecurityError"),
        ),
      });
      if (++invalidMessages >= 4)
        terminate(
          new DOMException(
            "Invalid IndexedDB capability traffic",
            "SecurityError",
          ),
        );
      return;
    }
    next++;
    try {
      if (
        m.type === "deleteDatabase" ||
        (m.type === "begin" && m.mode !== "readonly")
      )
        await assertWrite();
      assertLocal();
      boundedIDBValueBytes(
        m,
        limits.maxPayloadBytes,
        limits.maxValueNodes,
        limits.maxValueDepth,
      );
      if (
        ["open", "deleteDatabase", "databases", "operation"].includes(m.type) ||
        (m.type === "cursor" && ["update", "delete"].includes(m.action))
      ) {
        if (!Number.isSafeInteger(m.request) || m.request <= lastRequest)
          throw new DOMException("Invalid request identity", "SecurityError");
        lastRequest = m.request;
      }
      if (
        [
          "open",
          "deleteDatabase",
          "databases",
          "begin",
          "operation",
          "schema",
          "cursor",
        ].includes(m.type) &&
        outstanding() >= limits.maxPendingRequests
      ) {
        terminate(quotaError("Document pending request allowance exhausted"));
        return;
      }

      if (m.type === "open") {
        if (
          typeof m.name !== "string" ||
          m.name === KEEP ||
          m.name.length > limits.maxNameLength
        )
          throw quotaError("Invalid or oversized database name");
        if (connections.size + pendingOpens >= limits.maxConnections) {
          terminate(quotaError("Document connection allowance exhausted"));
          return;
        }
        pendingOpens++;
        const connection = "db:" + ++serial,
          name = m.name;
        let finished = false;
        const timer = setTimeout(
          () =>
            terminate(
              new DOMException("Database open timed out", "TimeoutError"),
            ),
          binding.timeoutMs || TIMEOUT,
        );
        openTimers.add(timer);
        // Opening an existing database is allowed for readers. A creation or
        // upgrade still requires the cached write fence below.
        try {
          await assertWrite();
        } catch {}
        const finish = () => {
          if (finished) return;
          finished = true;
          pendingOpens = Math.max(0, pendingOpens - 1);
          clearTimeout(timer);
          openTimers.delete(timer);
        };
        void reservedOperation(
          name,
          false,
          (physical) =>
            new Promise<IDBDatabase>((resolve, reject) => {
              if (!live) {
                reject(new DOMException("Document closed", "AbortError"));
                return;
              }
              let upgradeState: Any;
              const request =
                m.version === undefined
                  ? factory.open(physical)
                  : factory.open(physical, m.version);
              request.onupgradeneeded = (event) => {
                // Native transaction liveness now owns the upgrade deadline.
                clearTimeout(timer);
                openTimers.delete(timer);
                if (!live || transactions.size >= limits.maxTransactions) {
                  try {
                    request.transaction!.abort();
                  } catch {}
                  if (live)
                    terminate(
                      quotaError("Document transaction allowance exhausted"),
                    );
                  return;
                }
                const db = request.result;
                logicalNames.set(db, name);
                try {
                  assertWriteCached();
                } catch (error) {
                  request.transaction!.abort();
                  return;
                }
                connect(db, connection);
                if (!db.objectStoreNames.contains(KEEP))
                  db.createObjectStore(KEEP);
                const id = "upgrade:" + m.request;
                upgradeState = attach(
                  request.transaction!,
                  id,
                  connection,
                  true,
                );
                send({
                  type: "upgrade",
                  request: m.request,
                  connection,
                  transaction: id,
                  name,
                  version: db.version,
                  schema: schema(db, request.transaction!),
                  oldVersion: event.oldVersion,
                  newVersion: event.newVersion,
                  features,
                });
              };
              request.onsuccess = () => {
                logicalNames.set(request.result, name);
                if (!live) {
                  request.result.close();
                  reject(new DOMException("Document closed", "AbortError"));
                } else
                  void verifyLedger(request.result).then(
                    () => resolve(request.result),
                    (error) => {
                      request.result.close();
                      reject(error);
                    },
                  );
              };
              request.onerror = () =>
                reject(upgradeState?.abortError || request.error);
              request.onblocked = (event) =>
                send({
                  type: "blocked",
                  request: m.request,
                  oldVersion: event.oldVersion,
                  newVersion: event.newVersion,
                });
            }),
        ).then(
          (db) => {
            finish();
            if (!live) {
              db.close();
              return;
            }
            connect(db, connection);
            send({
              type: "opened",
              request: m.request,
              connection,
              name,
              version: db.version,
              schema: schema(db),
              features,
              limits: {
                quotaBytes: limits.quotaBytes,
                sliceBytes,
                maxDatabases: limits.maxDatabases,
              },
            });
          },
          (error) => {
            finish();
            connections.get(connection)?.close();
            connections.delete(connection);
            fail(m.request, error);
          },
        );
        return;
      }
      if (m.type === "deleteDatabase" || m.type === "databases") {
        if (
          m.type === "deleteDatabase" &&
          (typeof m.name !== "string" ||
            m.name === KEEP ||
            m.name.length > limits.maxNameLength)
        )
          throw quotaError("Invalid or oversized database name");
        pendingControls++;
        let finished = false;
        const timer = setTimeout(
          () =>
            terminate(
              new DOMException("Database lifecycle timed out", "TimeoutError"),
            ),
          binding.timeoutMs || TIMEOUT,
        );
        openTimers.add(timer);
        const finish = () => {
          if (finished) return;
          finished = true;
          pendingControls = Math.max(0, pendingControls - 1);
          clearTimeout(timer);
          openTimers.delete(timer);
        };
        const result =
          m.type === "databases"
            ? binding.profileId
              ? listProfileIDBDatabases(factory, binding.profileId).then(
                  async (dbs) => {
                    const native = await factory.databases();
                    return dbs
                      .filter((d) => d.physical && !d.deleted && !d.deleting)
                      .map((d) => ({
                        name: d.name,
                        version:
                          native.find((n) => n.name === d.physical)?.version ||
                          1,
                      }));
                  },
                )
              : factory.databases().then((dbs) =>
                  dbs
                    .filter(
                      (db) =>
                        db.name?.startsWith(prefix) && db.name !== metadataName,
                    )
                    .map((db) => ({
                      name: decodeURIComponent(db.name!.slice(prefix.length)),
                      version: db.version,
                    })),
                )
            : reservedOperation(String(m.name), true, () =>
                deleteLocalIDBDatabase(
                  factory,
                  local.replicaId,
                  local.logicalOrigin,
                  String(m.name),
                  (oldVersion, newVersion) =>
                    send({
                      type: "blocked",
                      request: m.request,
                      oldVersion,
                      newVersion,
                    }),
                ),
              );
        void result.then(
          (value) => {
            finish();
            if (
              m.type === "deleteDatabase" &&
              binding.profileId &&
              typeof window !== "undefined"
            )
              window.dispatchEvent(
                new CustomEvent("atlas:profile-native-change", {
                  detail: {
                    profileId: binding.profileId,
                    origin: new URL(binding.website).origin,
                    kind: "idb",
                  },
                }),
              );
            send({ type: "result", request: m.request, value });
          },
          (error) => {
            finish();
            fail(m.request, error);
          },
        );
        return;
      }
      if (m.type === "close") {
        connections.get(m.connection)?.close();
        connections.delete(m.connection);
        return;
      }
      if (m.type === "begin") {
        const db = connections.get(m.connection);
        if (!db)
          throw new DOMException("Database is closed", "InvalidStateError");
        if (
          !Array.isArray(m.stores) ||
          !m.stores.length ||
          m.stores.includes(KEEP) ||
          !["readonly", "readwrite"].includes(m.mode)
        )
          throw new TypeError("Invalid transaction");
        if (
          transactions.size >= limits.maxTransactions ||
          typeof m.transaction !== "string" ||
          !/^tx:[0-9]+$/.test(m.transaction) ||
          transactions.has(m.transaction)
        ) {
          terminate(quotaError("Document transaction allowance exhausted"));
          return;
        }
        const tx = db.transaction(
          m.mode === "readonly" || local
            ? [...m.stores, KEEP]
            : Array.from(db.objectStoreNames),
          m.mode,
          m.options,
        );
        attach(tx, m.transaction, m.connection);
        return;
      }
      const state = transactions.get(m.transaction);
      if (!state)
        throw new DOMException(
          "Transaction is inactive",
          "TransactionInactiveError",
        );
      state.last = Date.now();
      if (
        m.type === "operation" ||
        m.type === "schema" ||
        m.type === "cursor"
      ) {
        if (m.store === KEEP)
          throw new DOMException("Private object store", "SecurityError");
        if (!Array.isArray(m.args) && m.type !== "schema")
          throw new TypeError("Invalid operation arguments");
        for (const name of [m.store, m.index, m.name])
          if (
            name !== undefined &&
            (typeof name !== "string" || name.length > limits.maxNameLength)
          )
            throw quotaError("Invalid or oversized schema name");
        const bytes = boundedIDBValueBytes(
          m,
          limits.maxPayloadBytes,
          limits.maxValueNodes,
          limits.maxValueDepth,
        );
        if (
          queuedBytes + bytes > limits.maxQueueBytes ||
          state.commandBytes + bytes > limits.maxQueueBytes
        ) {
          terminate(quotaError("Document request queue allowance exhausted"));
          return;
        }
        state.fenced = false;
        state.quotaValid = false;
        queuedBytes += bytes;
        state.commandBytes += bytes;
        state.queue.push({ ...m, bytes });
        return;
      }
      if (m.type === "ack") {
        retainedResultBytes = Math.max(
          0,
          retainedResultBytes - (state.resultBytes.get(m.eventId) || 0),
        );
        state.resultBytes.delete(m.eventId);
        state.waiting.delete(m.eventId);
        if (m.handlerError || (m.failed && !m.prevented)) {
          state.abortError = state.failures.get(m.eventId);
          state.tx.abort();
        }
        state.failures.delete(m.eventId);
        return;
      }
      if (m.type === "fence") {
        state.fenced = true;
        return;
      }
      if (m.type === "commit") {
        state.commit = true;
        return;
      }
      if (m.type === "abort") {
        state.tx.abort();
        return;
      }
      throw new TypeError("Unknown IndexedDB capability operation");
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "QuotaExceededError"
      ) {
        terminate(error);
        return;
      }
      const state = transactions.get(m.transaction);
      if (state) {
        state.abortError = error;
        try {
          state.tx.abort();
        } catch {}
        if (m.request) fail(m.request, error);
        // Only the real native transaction event acknowledges abort/commit.
      } else if (m.request) fail(m.request, error);
      else if (m.transaction)
        send({
          type: "abort",
          transaction: m.transaction,
          error: errorValue(error),
        });
      else send({ type: "protocol-error", error: errorValue(error) });
    }
  };
  let receiveTail = Promise.resolve();
  const receive = (event: MessageEvent) => {
    receiveTail = receiveTail
      .then(() => handle(event))
      .catch((error) => terminate(error));
  };
  port.addEventListener("message", receive);
  port.addEventListener("messageerror", messageError);
  port.start();
  return {
    async flush() {
      await receiveTail;
      while (transactions.size || pendingOpens || pendingControls)
        await new Promise((resolve) => setTimeout(resolve, 5));
    },
    dispose,
    get stats() {
      return {
        live,
        connections: connections.size,
        transactions: transactions.size,
        pendingRequests: outstanding(),
        queuedBytes,
        pendingOpens,
        pendingControls,
      };
    },
    limits: Object.freeze({ ...limits, sliceBytes }),
  };
}
