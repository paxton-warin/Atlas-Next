import {
  profileIDBPrefix,
  checkedProfile,
  appendProfileJournal,
} from "./profile-journal.ts";
import {
  resolveProfileIDBDatabase,
  deleteProfileIDBDatabase,
  listProfileIDBDatabases,
} from "./profile-idb-catalog.ts";
import {
  assertProfileWrite,
  assertProfileWriteCached,
} from "./profile-permissions.ts";
import {
  withQuotaLifecycle,
  reserveQuotaDatabase,
  removeQuotaDatabase,
  reconcileQuotaSources,
  reconcileQuotaSource,
  reserveQuotaCommit,
  finishQuotaCommit,
  type QuotaIntent,
} from "./profile-idb-quota.ts";
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
    if (item instanceof Blob || brand === '[object Blob]' || brand === '[object File]') {
      const size = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        "size",
      )!.get!.call(item);
      const mime = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        "type",
      )!.get!.call(item);
      add(size + 256 + 2 * mime.length);
      if (typeof File !== "undefined" && (item instanceof File || brand === '[object File]')) {
        const name = Object.getOwnPropertyDescriptor(
          File.prototype,
          "name",
        )!.get!.call(item);
        add(32 + 2 * name.length);
      }
      return;
    }
    if (item instanceof ArrayBuffer || brand === '[object ArrayBuffer]') {
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
        (item instanceof DataView || brand === '[object DataView]')
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
    if (item instanceof Date || brand === '[object Date]') {
      Date.prototype.getTime.call(item); // reject forged Date.prototype objects
      add(16);
      return;
    }
    if (item instanceof RegExp || brand === '[object RegExp]') {
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
    if (item instanceof Map || brand === '[object Map]') {
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
    if (item instanceof Set || brand === '[object Set]') {
      if (
        Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!.call(
          item,
        ) > maxNodes
      )
        throw quotaError("IndexedDB set exceeds its allowance");
      Set.prototype.forEach.call(item, (v: any) => walk(v, depth + 1));
      return;
    }
    if (item instanceof Error || brand === '[object Error]') {
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
      !(brand === '[object Object]' && Object.getPrototypeOf(prototype) === null)
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
export function bindSandboxIndexedDB(binding: {
  port: MessagePort;
  documentId: string;
  website: string;
  frontendOrigin: string;
  factory: IDBFactory;
  profileId?: string | null;
  profileContextId?: string;
  timeoutMs?: number;
  limits?: Partial<SandboxIDBLimits>;
}) {
  const { port, documentId, factory } = binding,
    prefix = identity(
      binding.website,
      binding.frontendOrigin,
      binding.profileId,
    );
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
  const assertWrite = () =>
    assertProfileWrite(
      factory,
      binding.profileId,
      new URL(binding.website).origin,
      binding.profileContextId,
    );
  const assertWriteCached = () =>
    assertProfileWriteCached(
      factory,
      binding.profileId,
      new URL(binding.website).origin,
      binding.profileContextId,
    );
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
      const auditBudget = Math.max(limits.quotaBytes, state.baseUsage);
      let total = 128,
        records = 0,
        indexEntries = 0;
      const stores = Array.from(tx.db.objectStoreNames).filter(
          (name) => name !== KEEP,
        ),
        work: Any[] = [];
      try {
        if (stores.length > limits.maxStores)
          throw quotaError("Object store allowance exhausted");
        for (const name of stores) {
          const store = tx.objectStore(name);
          total +=
            128 +
            2 * name.length +
            boundedIDBValueBytes(store.keyPath, auditBudget);
          if (store.indexNames.length > limits.maxIndexes)
            throw quotaError("Index allowance exhausted");
          work.push({ source: store, record: true });
          for (const indexName of Array.from(store.indexNames)) {
            const index = store.index(indexName);
            total +=
              128 +
              2 * indexName.length +
              boundedIDBValueBytes(index.keyPath, auditBudget);
            work.push({ source: index, record: false });
          }
        }
      } catch (error) {
        abortQuota(error);
        return;
      }
      const nextSource = () => {
        if (state.finished) return;
        if (!work.length) {
          if (total > auditBudget) {
            abortQuota(
              quotaError(
                "Website database exceeds its current or retained allowance",
              ),
            );
            return;
          }
          let ready = false,
            reservationError: unknown;
          void reserveQuotaCommit(
            factory,
            prefix,
            { name: logicalNames.get(tx.db)!, physical: tx.db.name },
            state.baseUsage,
            total,
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
          // Native requests keep this source TX alive while a DIFFERENT native
          // metadata TX durably reserves its growth. Never auto-commit early.
          const hold = () => {
            if (state.finished) return;
            if (reservationError) {
              abortQuota(reservationError);
              return;
            }
            if (ready) {
              const ledger = tx
                .objectStore(KEEP)
                .put(
                  {
                    bytes: total,
                    sliceBytes: limits.quotaBytes,
                    records,
                    indexEntries,
                  },
                  "usage",
                );
              ledger.onsuccess = () => {
                state.checkingQuota = false;
                state.quotaValid = true;
                pump();
              };
              ledger.onerror = () => abortQuota(ledger.error);
              return;
            }
            const keep = tx.objectStore(KEEP).get(0);
            keep.onsuccess = hold;
            keep.onerror = () => abortQuota(keep.error);
          };
          hold();
          return;
        }
        const item = work.shift(),
          cursor = item.record
            ? item.source.openCursor()
            : item.source.openKeyCursor();
        cursor.onerror = () => abortQuota(cursor.error);
        cursor.onsuccess = () => {
          if (Date.now() - state.started > limits.maxTransactionMs) {
            abortQuota(
              new DOMException("Quota validation timed out", "TimeoutError"),
            );
            return;
          }
          const value = cursor.result;
          if (!value) {
            nextSource();
            return;
          }
          try {
            if (item.record) {
              if (++records > limits.maxRecords)
                throw quotaError("Record allowance exhausted");
              total +=
                64 +
                boundedIDBValueBytes(value.primaryKey, auditBudget - total) +
                boundedIDBValueBytes(
                  value.value,
                  auditBudget - total,
                  limits.maxValueNodes,
                  limits.maxValueDepth,
                );
            } else {
              if (++indexEntries > limits.maxIndexEntries)
                throw quotaError("Index entry allowance exhausted");
              total +=
                32 +
                boundedIDBValueBytes(value.key, auditBudget - total) +
                boundedIDBValueBytes(value.primaryKey, auditBudget - total);
            }
            if (total > auditBudget)
              throw quotaError(
                "Website database exceeds its current or retained allowance",
              );
            value.continue();
          } catch (error) {
            abortQuota(error);
          }
        };
      };
      nextSource();
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
            const changes = state.profileChanges.filter((change: Any) => change !== undefined);
            appendProfileJournal(tx.objectStore(KEEP), {
              profileId: checkedProfile(binding.profileId)!,
              kind: "idb",
              origin: new URL(binding.website).origin,
              name:
                logicalNames.get(tx.db) ??
                decodeURIComponent(tx.db.name.slice(prefix.length)),
              payload: {
                transactionId: state.id,
                version: tx.db.version,
                changes,
              },
              bytes: boundedIDBValueBytes(changes, 8 * 1024 * 1024),
            });
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
          try { tx.abort(); } catch { /* native abort owns final status */ }
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
      const mutationIndex = binding.profileId &&
        ["put", "add", "delete", "clear", "update"].includes(message.action)
        ? state.profileChanges.push(undefined) - 1
        : -1;
      state.inflight++;
      request!.onsuccess = () => {
        state.inflight--;
        if (mutationIndex >= 0)
          state.profileChanges[mutationIndex] =
            profileMutation || {
              type: message.type,
              action: message.action,
              store: message.store,
              args: message.args,
              key: request!.result,
            };
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
            : binding.profileId
              ? deleteProfileIDBDatabase(
                  factory,
                  binding.profileId,
                  new URL(binding.website).origin,
                  String(m.name),
                  (oldVersion, newVersion) =>
                    send({
                      type: "blocked",
                      request: m.request,
                      oldVersion,
                      newVersion,
                    }),
                )
              : reservedOperation(
                  String(m.name),
                  true,
                  () =>
                    new Promise<void>((resolve, reject) => {
                      const request = factory.deleteDatabase(
                        prefix + encodeURIComponent(m.name),
                      );
                      request.onsuccess = () => resolve();
                      request.onerror = () => reject(request.error);
                      request.onblocked = (event) =>
                        send({
                          type: "blocked",
                          request: m.request,
                          oldVersion: event.oldVersion,
                          newVersion: event.newVersion,
                        });
                    }),
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
          m.mode === "readonly"
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

// A prepared document can also initialize inherited website windows. Give each
// installed Factory its own target-realm clone while retaining the one private
// transport and request sequence. Result identity is fixed at delivery, not at
// getters; a later window installation cannot change an earlier request's realm.
type IDBResultClone = (value: Any) => Any;
const realmFactories = new WeakMap<object, (win: Window & typeof globalThis) => Any>();

/** Website-facing asynchronous IDB facade with its own realm prototypes. */
export function createSandboxIndexedDB(port: MessagePort, documentId: string, transport: {
  data?: (this: MessageEvent) => any;
  post?: MessagePort["postMessage"];
  add?: EventTarget["addEventListener"];
  remove?: EventTarget["removeEventListener"];
  start?: MessagePort["start"];
  close?: MessagePort["close"];
} = {}) {
  const applyPrivate = Reflect.apply,
    privateData = transport.data ?? Object.getOwnPropertyDescriptor(
      MessageEvent.prototype,
      "data",
    )!.get!,
    privatePost = transport.post ?? MessagePort.prototype.postMessage,
    privateAdd = transport.add ?? EventTarget.prototype.addEventListener,
    privateRemove = transport.remove ?? EventTarget.prototype.removeEventListener,
    privateStart = transport.start ?? MessagePort.prototype.start,
    privateClose = transport.close ?? MessagePort.prototype.close,
    PrivateChannel = MessageChannel,
    channelPort1 = Object.getOwnPropertyDescriptor(
      MessageChannel.prototype,
      "port1",
    )?.get,
    channelPort2 = Object.getOwnPropertyDescriptor(
      MessageChannel.prototype,
      "port2",
    )?.get;
  let sequence = 0,
    serial = 0,
    live = true;
  let recordsSupported =
    typeof (globalThis.IDBObjectStore?.prototype as Any)?.getAllRecords ===
    "function";
  const requestBrands = new WeakSet<object>(),
    databaseBrands = new WeakSet<object>(),
    factoryBrands = new WeakSet<object>(),
    sourceBrands = new WeakSet<object>(),
    cursorBrands = new WeakSet<object>();
  const recordData = new WeakMap<object, Any>();
  const resultClones = new WeakMap<object, IDBResultClone>();
  const unchangedResult: IDBResultClone = value => value;
  const token = {},
    requests = new Map<number, Any>(),
    connections = new Map<string, Any>(),
    transactions = new Map<string, Any>();
  const send = (message: Any) => {
    boundedIDBValueBytes(message);
    if (!live)
      throw new DOMException(
        "Document storage capability closed",
        "InvalidStateError",
      );
    applyPrivate(privatePost, port, [
      {
        protocol: PROTOCOL,
        documentId,
        sequence: sequence + 1,
        ...message,
      },
    ]);
    sequence++;
  };
  const fault = (name: string, message = name): never => {
    throw new DOMException(message, name);
  };
  const string = (value: Any) => {
    if (typeof value === "symbol")
      throw new TypeError("Symbol is not a DOMString");
    const result = String(value);
    if (result.length > SANDBOX_IDB_LIMITS.maxNameLength)
      throw quotaError("IndexedDB name exceeds its allowance");
    return result;
  };
  const required = (args: IArguments, count: number) => {
    if (args.length < count) throw new TypeError("Missing required argument");
  };
  const integer = (value: Any, max = 0xffffffff) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || Math.trunc(number) > max)
      throw new TypeError("Integer is out of range");
    return Math.trunc(number);
  };
  const key = (value: Any) => {
    boundedIDBValueBytes(value);
    const normalized = structuredClone(value);
    compareSandboxKeys(normalized, normalized);
    return normalized;
  };
  const query = (value: Any, optional = false) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      return key(value);
    }
    if (value instanceof IDBKeyRange)
      return {
        __atlasKeyRange: 1,
        lower: value.lower,
        upper: value.upper,
        lowerOpen: value.lowerOpen,
        upperOpen: value.upperOpen,
      };
    return key(value);
  };
  const dictionary = (value: Any) => {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" && typeof value !== "function")
      throw new TypeError("Invalid dictionary argument");
    return value;
  };
  const keyPath = (value: Any): Any => {
    if (Array.isArray(value))
      return value.map((entry) => keyPath(string(entry)));
    const result = string(value);
    if (
      result !== "" &&
      !result
        .split(".")
        .every((part) =>
          /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(part),
        )
    )
      fault("SyntaxError", "Invalid key path");
    return result;
  };
  const extract = (value: Any, path: Any): Any =>
    Array.isArray(path)
      ? path.map((part) => extract(value, part))
      : path === ""
        ? value
        : String(path)
            .split(".")
            .reduce(
              (object, part) => (object == null ? undefined : object[part]),
              value,
            );
  const readonly = (target: Any, name: string, value: Any) =>
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  class Events extends EventTarget {
    [key: string]: Any;
    private listeners = new WeakMap<object, Map<string, EventListener>>();
    constructor() {
      super();
      for (const type of [
        "success",
        "error",
        "abort",
        "complete",
        "upgradeneeded",
        "blocked",
        "versionchange",
        "close",
      ]) {
        let handler: Any = null,
          registered = false;
        Object.defineProperty(this, "on" + type, {
          enumerable: true,
          configurable: true,
          get: () => handler,
          set: (value) => {
            handler = typeof value === "function" ? value : null;
            if (handler && !registered) {
              registered = true;
              this.addEventListener(type, (event) => {
                if (handler && handler.call(this, event) === false)
                  event.preventDefault();
              });
            }
          },
        });
      }
    }
    addEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (!callback) return;
      let map = this.listeners.get(callback as object);
      if (!map) {
        map = new Map();
        this.listeners.set(callback as object, map);
      }
      const capture =
          typeof options === "boolean" ? options : !!options?.capture,
        id = type + ":" + capture;
      let wrapped = map.get(id);
      if (!wrapped) {
        wrapped = (event) => {
          try {
            if (typeof callback === "function") callback.call(this, event);
            else callback.handleEvent(event);
          } catch (error) {
            (event as Any).handlerError = error;
            queueMicrotask(() => globalThis.reportError?.(error));
          }
        };
        map.set(id, wrapped);
      }
      super.addEventListener(type, wrapped, options);
    }
    removeEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (!callback) return;
      const capture =
        typeof options === "boolean" ? options : !!options?.capture;
      const wrapped = this.listeners
        .get(callback as object)
        ?.get(type + ":" + capture);
      if (wrapped) super.removeEventListener(type, wrapped, options);
    }
    private dispatchNative(event: Event) {
      return super.dispatchEvent(event);
    }
    fire(type: string, detail: Any = {}, chain: Events[] = [this]) {
      const event = new Event(type, {
        cancelable: type === "error",
        bubbles: type === "error" || type === "abort",
      });
      let current: Events | null = null,
        stopped = false;
      Object.assign(event, detail);
      Object.defineProperties(event, {
        target: { get: () => this },
        currentTarget: { get: () => current },
        eventPhase: { get: () => (current === this ? 2 : current ? 3 : 0) },
        composedPath: { value: () => (current ? chain : []) },
      });
      const stop = event.stopPropagation.bind(event);
      Object.defineProperty(event, "stopPropagation", {
        value: () => {
          stopped = true;
          stop();
        },
      });
      const immediate = event.stopImmediatePropagation.bind(event);
      Object.defineProperty(event, "stopImmediatePropagation", {
        value: () => {
          stopped = true;
          immediate();
        },
      });
      for (const target of chain) {
        current = target;
        target.dispatchNative(event);
        if (stopped) break;
      }
      current = null;
      return event as Event & { handlerError?: Any };
    }
  }
  class Request extends Events {
    _state = "pending";
    _result: Any;
    _error: DOMException | null = null;
    _source: Any;
    _transaction: Any;
    id: number;
    constructor(secret: object, source: Any = null, transaction: Any = null,
      cloneResult: IDBResultClone = resultClones.get(transaction) || resultClones.get(source) || unchangedResult) {
      super();
      if (secret !== token) throw new TypeError("Illegal constructor");
      requestBrands.add(this);
      resultClones.set(this, cloneResult);
      this._source = source;
      this._transaction = transaction;
      this.id = ++serial;
      requests.set(this.id, this);
    }
    get readyState() {
      if (!requestBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._state;
    }
    get result() {
      if (!requestBrands.has(this)) throw new TypeError("Illegal invocation");
      if (this._state === "pending")
        fault("InvalidStateError", "Request is pending");
      return this._result;
    }
    get error() {
      if (!requestBrands.has(this)) throw new TypeError("Illegal invocation");
      if (this._state === "pending")
        fault("InvalidStateError", "Request is pending");
      return this._error;
    }
    get source() {
      if (!requestBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._source;
    }
    get transaction() {
      if (!requestBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._transaction;
    }
  }
  class OpenRequest extends Request {}
  const fence = (tx: Any) => {
    if (tx.fencePending) return;
    tx.fencePending = true;
    const channel = new PrivateChannel(),
      first = channelPort1
        ? applyPrivate(channelPort1, channel, [])
        : channel.port1,
      second = channelPort2
        ? applyPrivate(channelPort2, channel, [])
        : channel.port2;
    const completeFence = () => {
      applyPrivate(privateRemove, first, ["message", completeFence]);
      applyPrivate(privateClose, first, []);
      applyPrivate(privateClose, second, []);
      tx.fencePending = false;
      if (tx.finished) return;
      tx.active = false;
      send({ type: "fence", transaction: tx.id });
    };
    applyPrivate(privateAdd, first, ["message", completeFence]);
    applyPrivate(privateStart, first, []);
    applyPrivate(privatePost, second, [0]);
  };
  class Transaction extends Events {
    id: string;
    db: Any;
    mode: string;
    error: DOMException | null = null;
    active = true;
    finished = false;
    committing = false;
    fencePending = false;
    stores: string[];
    done: Promise<void>;
    resolve!: () => void;
    reject!: (error: Any) => void;
    cache = new Map<string, Any>();
    durability: string;
    constructor(
      secret: object,
      db: Any,
      id: string,
      stores: string[],
      mode: string,
      durability = "default",
    ) {
      super();
      if (secret !== token) throw new TypeError("Illegal constructor");
      this.db = db;
      resultClones.set(this, resultClones.get(db) || unchangedResult);
      readonly(this, "db", db);
      this.id = id;
      this.stores = stores;
      this.mode = mode;
      this.durability = durability;
      readonly(this, "mode", mode);
      readonly(this, "durability", durability);
      this.done = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
      this.done.catch(() => {});
      transactions.set(id, this);
      fence(this);
    }
    get objectStoreNames() {
      return names(this.stores);
    }
    objectStore(name: string) {
      required(arguments, 1);
      name = string(name);
      if (this.finished) fault("InvalidStateError", "Transaction finished");
      if (!this.stores.includes(name))
        fault("NotFoundError", "Object store not found");
      let store = this.cache.get(name);
      if (!store) {
        store = new Store(token, this, this.db.schema[name]);
        this.cache.set(name, store);
      }
      return store;
    }
    check(write = false) {
      if (!this.active || this.finished || this.committing)
        fault("TransactionInactiveError", "Transaction is inactive");
      if (write && this.mode === "readonly")
        fault("ReadOnlyError", "Read-only transaction");
    }
    abort() {
      if (this.finished || this.committing)
        fault("InvalidStateError", "Transaction finished");
      this.committing = true;
      send({ type: "abort", transaction: this.id });
    }
    commit() {
      if (this.finished || this.committing || !this.active)
        fault("InvalidStateError", "Transaction is inactive");
      this.committing = true;
      send({ type: "commit", transaction: this.id });
    }
  }
  class Source {
    tx: Any;
    record: Any;
    indexRecord: Any;
    constructor(secret: object, tx: Any, record: Any, index?: Any) {
      if (secret !== token) throw new TypeError("Illegal constructor");
      this.tx = tx;
      sourceBrands.add(this);
      resultClones.set(this, resultClones.get(tx) || unchangedResult);
      this.record = record;
      this.indexRecord = index;
    }
    get name() {
      if (!sourceBrands.has(this)) throw new TypeError("Illegal invocation");
      return this.indexRecord?.name ?? this.record.name;
    }
    set name(value: string) {
      value = string(value);
      this.schemaCheck();
      const map = this.indexRecord ? this.record.indexes : this.tx.db.schema,
        current = this.name;
      if (value === current) return;
      if (Object.hasOwn(map, value))
        fault("ConstraintError", "Name already exists");
      send({
        type: "schema",
        transaction: this.tx.id,
        action: this.indexRecord ? "renameIndex" : "renameStore",
        store: this.record.name,
        index: this.indexRecord?.name,
        name: value,
      });
      delete map[current];
      map[value] = this.indexRecord || this.record;
      if (this.indexRecord) this.indexRecord.name = value;
      else {
        this.record.name = value;
        this.tx.stores = this.tx.stores.map((name: string) =>
          name === current ? value : name,
        );
        this.tx.cache.delete(current);
        this.tx.cache.set(value, this);
      }
    }
    get keyPath() {
      if (!sourceBrands.has(this)) throw new TypeError("Illegal invocation");
      return this.indexRecord?.keyPath ?? this.record.keyPath;
    }
    check(write = false) {
      if (!sourceBrands.has(this)) throw new TypeError("Illegal invocation");
      if (this.record.deleted || this.indexRecord?.deleted)
        fault("InvalidStateError", "Source was deleted");
      this.tx.check(write);
    }
    schemaCheck() {
      if (this.tx.mode !== "versionchange")
        fault("InvalidStateError", "Upgrade transaction required");
      this.check(true);
    }
    request(action: string, args: Any[]) {
      this.check(["put", "add", "delete", "clear"].includes(action));
      const request = new Request(token, this, this.tx);
      try {
        send({
          type: "operation",
          transaction: this.tx.id,
          request: request.id,
          store: this.record.name,
          index: this.indexRecord?.name,
          action,
          args,
        });
      } catch (error) {
        requests.delete(request.id);
        throw error;
      }
      return request;
    }
    get(value: Any) {
      required(arguments, 1);
      return this.request("get", [query(value)]);
    }
    getKey(value: Any) {
      required(arguments, 1);
      return this.request("getKey", [query(value)]);
    }
    count(value?: Any) {
      return this.request("count", value == null ? [] : [query(value)]);
    }
    all(action: string, value: Any, count: Any, length: number) {
      const options =
        length === 1 &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date) && Object.prototype.toString.call(value) !== '[object Date]' &&
        !(value instanceof ArrayBuffer) && Object.prototype.toString.call(value) !== '[object ArrayBuffer]' &&
        !ArrayBuffer.isView(value) &&
        !(value instanceof IDBKeyRange);
      if (options || action === "getAllRecords") {
        if (!recordsSupported)
          fault(
            "NotSupportedError",
            "Modern IndexedDB query options are not supported by this browser",
          );
        const parsed = dictionary(value),
          direction = string(parsed.direction ?? "next");
        if (!["next", "nextunique", "prev", "prevunique"].includes(direction))
          throw new TypeError("Invalid cursor direction");
        return this.request(action, [
          {
            query: query(parsed.query, true),
            count:
              parsed.count === undefined ? undefined : integer(parsed.count),
            direction,
          },
        ]);
      }
      const args = [query(value, true)];
      if (count !== undefined) args.push(integer(count));
      return this.request(action, args);
    }
    getAll(value?: Any, count?: number) {
      return this.all("getAll", value, count, arguments.length);
    }
    getAllKeys(value?: Any, count?: number) {
      return this.all("getAllKeys", value, count, arguments.length);
    }
    getAllRecords(options?: Any) {
      return this.all("getAllRecords", options, undefined, arguments.length);
    }
    openCursor(value?: Any, direction = "next") {
      direction = string(direction);
      if (!["next", "nextunique", "prev", "prevunique"].includes(direction))
        throw new TypeError("Invalid cursor direction");
      return this.request("openCursor", [query(value, true), direction]);
    }
    openKeyCursor(value?: Any, direction = "next") {
      direction = string(direction);
      if (!["next", "nextunique", "prev", "prevunique"].includes(direction))
        throw new TypeError("Invalid cursor direction");
      return this.request("openKeyCursor", [query(value, true), direction]);
    }
  }
  class Store extends Source {
    get transaction() {
      return this.tx;
    }
    get autoIncrement() {
      return this.record.autoIncrement;
    }
    get indexNames() {
      return names(Object.keys(this.record.indexes));
    }
    save(action: string, value: Any, provided: Any) {
      this.check(true);
      boundedIDBValueBytes(value);
      const cloned = structuredClone(value),
        inline = this.record.keyPath !== null,
        actual = inline ? extract(cloned, this.record.keyPath) : provided;
      if (inline && provided !== undefined)
        fault("DataError", "Inline keys do not accept a separate key");
      if (actual !== undefined) key(actual);
      else if (!this.autoIncrement) fault("DataError", "Key is required");
      else if (inline && (typeof cloned !== "object" || cloned === null))
        fault("DataError", "Generated key requires an object");
      const args = [cloned];
      if (provided !== undefined) args.push(key(provided));
      return this.request(action, args);
    }
    put(value: Any, provided?: Any) {
      required(arguments, 1);
      return this.save("put", value, provided);
    }
    add(value: Any, provided?: Any) {
      required(arguments, 1);
      return this.save("add", value, provided);
    }
    delete(value: Any) {
      required(arguments, 1);
      return this.request("delete", [query(value)]);
    }
    clear() {
      return this.request("clear", []);
    }
    index(name: string) {
      required(arguments, 1);
      name = string(name);
      if (this.record.deleted) fault("InvalidStateError", "Source deleted");
      if (!Object.hasOwn(this.record.indexes, name))
        fault("NotFoundError", "Index not found");
      return new Index(
        token,
        this.tx,
        this.record,
        this.record.indexes[name],
        this,
      );
    }
    createIndex(name: string, path: Any, options: Any = {}) {
      required(arguments, 2);
      name = string(name);
      path = keyPath(path);
      options = dictionary(options);
      const multiEntry = !!options.multiEntry,
        unique = !!options.unique;
      this.schemaCheck();
      if (Object.hasOwn(this.record.indexes, name))
        fault("ConstraintError", "Index exists");
      if (multiEntry && Array.isArray(path))
        fault("InvalidAccessError", "Compound multiEntry index");
      const record = { name, keyPath: path, multiEntry, unique };
      this.record.indexes[name] = record;
      send({
        type: "schema",
        transaction: this.tx.id,
        action: "createIndex",
        store: this.record.name,
        index: name,
        keyPath: path,
        options: { multiEntry, unique },
      });
      return new Index(token, this.tx, this.record, record, this);
    }
    deleteIndex(name: string) {
      required(arguments, 1);
      name = string(name);
      this.schemaCheck();
      if (!Object.hasOwn(this.record.indexes, name))
        fault("NotFoundError", "Index not found");
      this.record.indexes[name].deleted = true;
      delete this.record.indexes[name];
      send({
        type: "schema",
        transaction: this.tx.id,
        action: "deleteIndex",
        store: this.record.name,
        index: name,
      });
    }
  }
  class Index extends Source {
    objectStore: Any;
    constructor(secret: object, tx: Any, record: Any, index: Any, store: Any) {
      super(secret, tx, record, index);
      this.objectStore = store;
      readonly(this, "objectStore", store);
    }
    get multiEntry() {
      return this.indexRecord.multiEntry;
    }
    get unique() {
      return this.indexRecord.unique;
    }
  }
  class Database extends Events {
    id: string;
    _name: string;
    _version: number;
    schema: Any;
    upgrade: Any;
    closed = false;
    constructor(secret: object, m: Any, cloneResult: IDBResultClone = unchangedResult) {
      super();
      if (secret !== token) throw new TypeError("Illegal constructor");
      databaseBrands.add(this);
      resultClones.set(this, cloneResult);
      this.id = m.connection;
      this._name = m.name;
      this._version = m.version;
      this.schema = cloneResult(copySchema(m.schema));
      connections.set(this.id, this);
    }
    get name() {
      if (!databaseBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._name;
    }
    get version() {
      if (!databaseBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._version;
    }
    get objectStoreNames() {
      if (!databaseBrands.has(this)) throw new TypeError("Illegal invocation");
      return names(Object.keys(this.schema));
    }
    transaction(
      stores: string | string[],
      mode = "readonly",
      options: Any = {},
    ) {
      required(arguments, 1);
      if (this.closed) fault("InvalidStateError", "Database is closed");
      if (this.upgrade && !this.upgrade.finished)
        fault("InvalidStateError", "Upgrade in progress");
      const list =
        typeof stores === "object" &&
        stores !== null &&
        Symbol.iterator in stores
          ? Array.from(stores, string)
          : [string(stores)];
      mode = string(mode);
      if (!["readonly", "readwrite"].includes(mode))
        throw new TypeError("Invalid transaction mode");
      options = dictionary(options);
      const durability = string(options?.durability ?? "default");
      if (!["default", "strict", "relaxed"].includes(durability))
        throw new TypeError("Invalid durability");
      if (!list.length) fault("InvalidAccessError", "No object stores");
      for (const name of list)
        if (!Object.hasOwn(this.schema, name))
          fault("NotFoundError", "Object store not found");
      const tx = new Transaction(
        token,
        this,
        "tx:" + ++serial,
        [...new Set(list)].sort(),
        mode,
        durability,
      );
      send({
        type: "begin",
        connection: this.id,
        transaction: tx.id,
        stores: tx.stores,
        mode,
        options: { durability },
      });
      return tx;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      send({ type: "close", connection: this.id });
    }
    createObjectStore(name: string, options: Any = {}) {
      required(arguments, 1);
      name = string(name);
      options = dictionary(options);
      const path = options.keyPath == null ? null : keyPath(options.keyPath),
        autoIncrement = !!options.autoIncrement,
        tx = this.upgrade;
      if (!tx || tx.finished)
        fault("InvalidStateError", "Upgrade transaction required");
      tx.check();
      if (name === KEEP || Object.hasOwn(this.schema, name))
        fault("ConstraintError", "Object store exists");
      if (autoIncrement && (Array.isArray(path) || path === ""))
        fault(
          "InvalidAccessError",
          "Generated key requires a nonempty string key path",
        );
      const record = {
        name,
        keyPath: path,
        autoIncrement,
        indexes: Object.create(null),
      };
      this.schema[name] = record;
      tx.stores.push(name);
      send({
        type: "schema",
        transaction: tx.id,
        action: "createStore",
        store: name,
        options: { keyPath: path, autoIncrement },
      });
      return tx.objectStore(name);
    }
    deleteObjectStore(name: string) {
      required(arguments, 1);
      name = string(name);
      const tx = this.upgrade;
      if (!tx || tx.finished)
        fault("InvalidStateError", "Upgrade transaction required");
      tx.check();
      if (!Object.hasOwn(this.schema, name))
        fault("NotFoundError", "Object store missing");
      this.schema[name].deleted = true;
      delete this.schema[name];
      tx.stores = tx.stores.filter((value: string) => value !== name);
      send({
        type: "schema",
        transaction: tx.id,
        action: "deleteStore",
        store: name,
      });
    }
  }
  class Cursor {
    _key: Any;
    _primaryKey: Any;
    _value: Any;
    _direction: string;
    source: Any;
    request: Any;
    id: string;
    pending = false;
    positioned = true;
    keyOnly: boolean;
    constructor(secret: object, m: Any, request: Any) {
      if (secret !== token) throw new TypeError("Illegal constructor");
      cursorBrands.add(this);
      this._direction = m.direction;
      this.id = m.cursor;
      this.keyOnly = m.keyOnly;
      this.source = request.source;
      this.request = request;
      readonly(this, "source", request.source);
      readonly(this, "request", request);
      this.updatePosition(m);
    }
    updatePosition(m: Any) {
      this._key = m.key;
      this._primaryKey = m.primaryKey;
      this._value = m.value;
      this.pending = false;
      this.positioned = true;
    }
    get key() {
      if (!cursorBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._key;
    }
    get primaryKey() {
      if (!cursorBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._primaryKey;
    }
    get direction() {
      if (!cursorBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._direction;
    }
    movement(action: string, args: Any[]) {
      this.request.transaction.check();
      if (this.pending || !this.positioned)
        fault("InvalidStateError", "Cursor is not positioned");
      this.pending = true;
      this.request._state = "pending";
      send({
        type: "cursor",
        transaction: this.request.transaction.id,
        cursor: this.id,
        action,
        args,
      });
    }
    continue(value?: Any) {
      if (value !== undefined) {
        key(value);
        const order = compareSandboxKeys(value, this.key);
        if (this.direction.startsWith("next") ? order <= 0 : order >= 0)
          fault("DataError", "Cursor key must advance");
      }
      this.movement("continue", value === undefined ? [] : [value]);
    }
    advance(count: number) {
      required(arguments, 1);
      count = integer(count);
      if (count === 0) throw new TypeError("Count must be positive");
      this.movement("advance", [count]);
    }
    continuePrimaryKey(value: Any, primaryKey: Any) {
      required(arguments, 2);
      if (
        !(this.source instanceof Index) ||
        !["next", "prev"].includes(this.direction)
      )
        fault("InvalidAccessError", "Index cursor required");
      key(value);
      key(primaryKey);
      const order =
        compareSandboxKeys(value, this.key) ||
        compareSandboxKeys(primaryKey, this.primaryKey);
      if (this.direction === "next" ? order <= 0 : order >= 0)
        fault("DataError", "Cursor key must advance");
      this.movement("continuePrimaryKey", [value, primaryKey]);
    }
    update(value: Any) {
      required(arguments, 1);
      this.request.transaction.check(true);
      if (this.pending || !this.positioned || this.keyOnly)
        fault("InvalidStateError", "Cursor has no value");
      boundedIDBValueBytes(value);
      const cloned = structuredClone(value),
        store =
          this.source instanceof Index ? this.source.objectStore : this.source;
      if (
        store.keyPath !== null &&
        compareSandboxKeys(extract(cloned, store.keyPath), this.primaryKey) !==
          0
      )
        fault("DataError", "Cursor update cannot change the primary key");
      return this.mutate("update", [cloned]);
    }
    delete() {
      this.request.transaction.check(true);
      if (this.pending || !this.positioned)
        fault("InvalidStateError", "Cursor has no value");
      return this.mutate("delete", []);
    }
    mutate(action: string, args: Any[]) {
      const request = new Request(token, this, this.request.transaction);
      try {
        send({
          type: "cursor",
          transaction: this.request.transaction.id,
          request: request.id,
          cursor: this.id,
          action,
          args,
        });
      } catch (error) {
        requests.delete(request.id);
        throw error;
      }
      return request;
    }
  }
  class RecordValue {
    constructor(secret: object, value: Any) {
      if (secret !== token) throw new TypeError("Illegal constructor");
      recordData.set(this, value);
    }
    get key() {
      if (!recordData.has(this)) throw new TypeError("Illegal invocation");
      return recordData.get(this).key;
    }
    get primaryKey() {
      if (!recordData.has(this)) throw new TypeError("Illegal invocation");
      return recordData.get(this).primaryKey;
    }
    get value() {
      if (!recordData.has(this)) throw new TypeError("Illegal invocation");
      return recordData.get(this).value;
    }
  }
  class ValueCursor extends Cursor {
    get value() {
      if (!cursorBrands.has(this)) throw new TypeError("Illegal invocation");
      return this._value;
    }
  }
  function closeFacade(error: DOMException) {
    if (!live) return;
    live = false;
    applyPrivate(privateRemove, port, ["message", receive]);
    for (const db of connections.values()) db.closed = true;
    for (const request of requests.values()) {
      if (request._state === "pending" || request instanceof OpenRequest) {
        request._state = "done";
        request._error = error;
        request.fire("error");
      }
    }
    requests.clear();
    for (const tx of transactions.values()) {
      tx.error = error;
      tx.finished = true;
      tx.active = false;
      tx.reject(error);
      tx.fire("abort");
    }
    transactions.clear();
    connections.clear();
    applyPrivate(privateClose, port, []);
  }
  const receive = (event: MessageEvent) => {
    const m = applyPrivate(privateData, event, []);
    if (m?.protocol !== PROTOCOL || m.documentId !== documentId) return;
    if (m.features?.records === false) {
      recordsSupported = false;
      delete (Source.prototype as Any).getAllRecords;
    }
    if (m.type === "closed") {
      closeFacade(exception(m.error));
      return;
    }
    if (m.type === "complete" || m.type === "abort") {
      const tx = transactions.get(m.transaction);
      if (!tx) return;
      tx.finished = true;
      tx.active = false;
      transactions.delete(tx.id);
      if (m.type === "complete") {
        tx.fire("complete");
        tx.resolve();
      } else {
        tx.error = exception(m.error);
        if (tx.mode === "versionchange") {
          tx.db.schema = (resultClones.get(tx.db) || unchangedResult)(copySchema(tx.beforeSchema));
          tx.db._version = tx.oldVersion;
          tx.db.closed = true;
        }
        tx.fire("abort", {}, [tx, tx.db]);
        tx.reject(tx.error);
      }
      return;
    }
    if (m.type === "versionchange") {
      connections.get(m.connection)?.fire("versionchange", {
        oldVersion: m.oldVersion,
        newVersion: m.newVersion,
      });
      return;
    }
    if (m.type === "close") {
      connections.get(m.connection)?.fire("close");
      return;
    }
    const request = requests.get(m.request);
    if (!request) return;
    if (m.type === "blocked") {
      request.fire("blocked", {
        oldVersion: m.oldVersion,
        newVersion: m.newVersion,
      });
      return;
    }
    if (m.type === "upgrade") {
      const db = new Database(token, m, resultClones.get(request)),
        tx = new Transaction(
          token,
          db,
          m.transaction,
          Object.keys(m.schema),
          "versionchange",
        );
      tx.beforeSchema = structuredClone(m.schema);
      tx.oldVersion = m.oldVersion;
      db.upgrade = tx;
      request._result = db;
      request._transaction = tx;
      request._state = "done";
      const delivered = request.fire("upgradeneeded", {
        oldVersion: m.oldVersion,
        newVersion: m.newVersion,
      });
      if (delivered.handlerError && !tx.committing) tx.abort();
      return;
    }
    if (m.type === "opened") {
      const db = connections.get(m.connection) || new Database(token, m, resultClones.get(request));
      db.schema = (resultClones.get(db) || unchangedResult)(copySchema(m.schema));
      Object.defineProperty(db, "storageAllowance", {
        value: m.limits,
        configurable: true,
      });
      db.upgrade = null;
      request._transaction = null;
      request._result = db;
      request._state = "done";
      request.fire("success");
      requests.delete(request.id);
      return;
    }
    if (m.type !== "result") return;
    const oldCursor =
      request._result instanceof Cursor ? request._result : null;
    request._state = "done";
    const cloneResult = resultClones.get(request) || unchangedResult;
    request._error = m.error ? cloneResult(exception(m.error)) : null;
    const value = cloneResult(m.value);
    if (value?.__atlasCursor) {
      if (oldCursor && oldCursor.id === value.cursor) {
        oldCursor.updatePosition(value);
        request._result = oldCursor;
      } else
        request._result = value.keyOnly
          ? new Cursor(token, value, request)
          : new ValueCursor(token, value, request);
    } else {
      if (oldCursor) oldCursor.positioned = false;
      request._result = m.records
        ? value.map((record: Any) => new RecordValue(token, record))
        : value;
    }
    const tx = m.transaction ? transactions.get(m.transaction) : null;
    if (!m.transaction && request._transaction?.mode === "versionchange")
      request._transaction = null;
    if (tx) {
      tx.active = true;
      fence(tx);
    }
    const delivered = request._error
      ? request.fire("error", {}, tx ? [request, tx, tx.db] : [request])
      : request.fire("success");
    if (tx)
      send({
        type: "ack",
        transaction: tx.id,
        request: request.id,
        eventId: m.eventId,
        failed: !!request._error,
        prevented: delivered.defaultPrevented,
        handlerError: !!delivered.handlerError,
      });
    if (!(request._result instanceof Cursor)) requests.delete(request.id);
  };
  applyPrivate(privateAdd, port, ["message", receive]);
  applyPrivate(privateStart, port, []);
  class Factory {
    constructor(secret: object, cloneResult: IDBResultClone = unchangedResult) {
      if (secret !== token) throw new TypeError("Illegal constructor");
      factoryBrands.add(this);
      resultClones.set(this, cloneResult);
    }
    open(name: string, version?: number) {
      if (!factoryBrands.has(this)) throw new TypeError("Illegal invocation");
      required(arguments, 1);
      name = string(name);
      if (version !== undefined) {
        version = integer(version, 2 ** 64 - 1);
        if (version === 0) throw new TypeError("Invalid database version");
      }
      const request = new OpenRequest(token, null, null, resultClones.get(this));
      send({ type: "open", request: request.id, name, version });
      return request;
    }
    deleteDatabase(name: string) {
      if (!factoryBrands.has(this)) throw new TypeError("Illegal invocation");
      required(arguments, 1);
      const request = new OpenRequest(token, null, null, resultClones.get(this));
      send({ type: "deleteDatabase", request: request.id, name: string(name) });
      return request;
    }
    databases() {
      if (!factoryBrands.has(this)) throw new TypeError("Illegal invocation");
      return new Promise<Any>((resolve, reject) => {
        const request = new Request(token, null, null, resultClones.get(this));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        send({ type: "databases", request: request.id });
      });
    }
    cmp(first: IDBValidKey, second: IDBValidKey) {
      if (!factoryBrands.has(this)) throw new TypeError("Illegal invocation");
      required(arguments, 2);
      return compareSandboxKeys(first, second);
    }
    dispose() {
      closeFacade(new DOMException("Document capability closed", "AbortError"));
    }
  }
  const constructors = {
    IDBFactory: Factory,
    IDBRequest: Request,
    IDBOpenDBRequest: OpenRequest,
    IDBDatabase: Database,
    IDBTransaction: Transaction,
    IDBObjectStore: Store,
    IDBIndex: Index,
    IDBCursor: Cursor,
    IDBCursorWithValue: ValueCursor,
    IDBRecord: RecordValue,
  };
  if (!recordsSupported) delete (Source.prototype as Any).getAllRecords;
  for (const [name, constructor] of Object.entries(constructors)) {
    Object.defineProperty(constructor, "name", { value: name });
    Object.defineProperty(constructor.prototype, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
  }
  const facade = new Factory(token);
  Object.defineProperty(facade, "constructors", { value: constructors });
  const installed = new WeakMap<object, Factory>();
  const creatorDocument = typeof document === "undefined" ? undefined : document;
  realmFactories.set(facade, win => {
    // Facades constructed in their website/worker realm already receive native
    // MessagePort clones there. Retain their established object identity.
    if (win === globalThis && (!creatorDocument || win.document === creatorDocument)) return facade;
    // WindowProxy identity survives navigation, but its Document/realm does not.
    const owner = win.document || win;
    let factory = installed.get(owner);
    if (!factory) {
      // Capture the target intrinsic before its website can replace globals.
      // Native structuredClone preserves supported structured values, cycles,
      // aliases and shared view buffers while adopting that window's realm.
      const clone = win.structuredClone;
      factory = new Factory(token, value => applyPrivate(clone, win, [value]));
      installed.set(owner, factory);
    }
    return factory;
  });
  return facade as Factory & { constructors: typeof constructors };
}
export function installSandboxIndexedDB(
  win: Window & typeof globalThis,
  facade: ReturnType<typeof createSandboxIndexedDB>,
) {
  Object.defineProperty(win, "indexedDB", {
    configurable: true,
    value: realmFactories.get(facade)?.(win) || facade,
  });
  for (const [name, constructor] of Object.entries(facade.constructors))
    Object.defineProperty(win, name, {
      configurable: true,
      writable: true,
      value: constructor,
    });
}

// IDBFactory.cmp is pure; opaque documents cannot access window.indexedDB.
export function compareSandboxKeys(
  first: IDBValidKey,
  second: IDBValidKey,
): number {
  const category = (key: any, seen = new Set<any>()): number => {
    if (typeof key === "number" && !Number.isNaN(key)) return 1;
    if ((key instanceof Date || Object.prototype.toString.call(key) === '[object Date]') && !Number.isNaN(Date.prototype.getTime.call(key))) return 2;
    if (typeof key === "string") return 3;
    if (key instanceof ArrayBuffer || Object.prototype.toString.call(key) === '[object ArrayBuffer]' || ArrayBuffer.isView(key)) return 4;
    if (Array.isArray(key) && !seen.has(key)) {
      seen.add(key);
      for (const entry of key) category(entry, seen);
      seen.delete(key);
      return 5;
    }
    throw new DOMException("Invalid IndexedDB key", "DataError");
  };
  const left = category(first),
    right = category(second);
  if (left !== right) return left < right ? -1 : 1;
  if (left === 1 || left === 3)
    return first < second ? -1 : first > second ? 1 : 0;
  if (left === 2) {
    const a = (first as Date).getTime(),
      b = (second as Date).getTime();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const bytes = (key: any) =>
    (key instanceof ArrayBuffer || Object.prototype.toString.call(key) === '[object ArrayBuffer]')
      ? new Uint8Array(key)
      : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  const a: any = left === 4 ? bytes(first) : first,
    b: any = left === 4 ? bytes(second) : second;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const result =
      left === 4
        ? a[index] < b[index]
          ? -1
          : a[index] > b[index]
            ? 1
            : 0
        : compareSandboxKeys(a[index], b[index]);
    if (result) return result;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
