/** Incremental accounting for isolated v2 databases. Metadata is committed in
 * the SAME native transaction as website records. No cloud counters or payload
 * outbox are consulted. Only changed records/ranges or schema-affected stores
 * are read; clear and store deletion use maintained totals. */
type Usage = { bytes: number; records: number; indexEntries: number };
type Limits = {
  quotaBytes: number;
  maxRecords: number;
  maxIndexEntries: number;
  maxValueNodes: number;
  maxValueDepth: number;
  maxStores: number;
  maxIndexes: number;
};
type Any = any;
const ZERO = (): Usage => ({ bytes: 0, records: 0, indexEntries: 0 });
const add = (a: Usage, b: Usage, sign = 1) => {
  a.bytes += sign * b.bytes;
  a.records += sign * b.records;
  a.indexEntries += sign * b.indexEntries;
};
const recordKey = (store: string, key: IDBValidKey): IDBValidKey => [
  "local-record-v2",
  store,
  key,
];
const recordRange = (store: string, query?: IDBValidKey | IDBKeyRange) => {
  if (query !== undefined && !(query instanceof IDBKeyRange))
    return IDBKeyRange.only(recordKey(store, query));
  return IDBKeyRange.bound(
    query?.lower === undefined
      ? ["local-record-v2", store]
      : recordKey(store, query.lower),
    query?.upper === undefined
      ? ["local-record-v2", store + "\0"]
      : recordKey(store, query.upper),
    !!query?.lowerOpen,
    query?.upper === undefined || !!query?.upperOpen,
  );
};
function path(value: Any, keyPath: string | string[]) {
  const one = (p: string) => {
    if (p === "") return value;
    let v = value;
    for (const k of p.split(".")) {
      if (v == null) return undefined;
      v = v[k];
    }
    return v;
  };
  return Array.isArray(keyPath)
    ? keyPath.map(one)
    : keyPath === ""
      ? value
      : one(keyPath);
}
export function localIDBRecordUsage(
  store: IDBObjectStore,
  key: IDBValidKey,
  value: unknown,
  measure: (
    value: unknown,
    limit?: number,
    nodes?: number,
    depth?: number,
  ) => number,
  limits: Limits,
  factory: IDBFactory,
): Usage {
  const budget = Math.max(limits.quotaBytes, 1024),
    keyBytes = measure(key, budget),
    result = {
      bytes:
        64 +
        keyBytes +
        measure(value, budget, limits.maxValueNodes, limits.maxValueDepth),
      records: 1,
      indexEntries: 0,
    };
  for (const name of Array.from(store.indexNames)) {
    const index = store.index(name),
      extracted = path(value, index.keyPath),
      candidates =
        index.multiEntry && Array.isArray(extracted) ? extracted : [extracted];
    // Native index keys have a total ordering. Sorting a private list avoids
    // the quadratic scan for large, mostly-distinct multiEntry arrays.
    const valid: IDBValidKey[] = [];
    for (const candidate of candidates) {
      try {
        factory.cmp(candidate, candidate);
      } catch {
        continue;
      }
      valid.push(candidate);
    }
    valid.sort((a, b) => factory.cmp(a, b));
    for (let i = 0; i < valid.length; i++) {
      const candidate = valid[i];
      if (i && factory.cmp(valid[i - 1], candidate) === 0) continue;
      result.indexEntries++;
      result.bytes += 32 + measure(candidate, budget) + keyBytes;
    }
  }
  return result;
}
/** This is callback-based intentionally: every continuation runs in a live
 * native request callback, never an awaited network/backup promise. */
export function auditLocalIDBChanges(options: {
  tx: IDBTransaction;
  keep: IDBObjectStore;
  changes: Any[];
  base: Usage;
  limits: Limits;
  factory: IDBFactory;
  measure(
    value: unknown,
    limit?: number,
    nodes?: number,
    depth?: number,
  ): number;
  unpack(value: Any): Any;
  done(usage: Usage): void;
  fail(error: unknown): void;
  onRecord?(store: string, key: IDBValidKey, value: unknown): void;
  onDelete?(store: string, key: IDBValidKey): void;
}) {
  const { tx, keep, changes, limits, factory, measure, unpack, done, fail } =
    options;
  const total = { ...options.base },
    plans = new Map<
      string,
      { reset: boolean; rebuild: boolean; keys: IDBValidKey[]; ranges: Any[] }
    >();
  const plan = (name: string) => {
    let p = plans.get(name);
    if (!p)
      plans.set(
        name,
        (p = { reset: false, rebuild: false, keys: [], ranges: [] }),
      );
    return p;
  };
  try {
    if (tx.db.objectStoreNames.length - 1 > limits.maxStores)
      throw new DOMException(
        "Object store allowance exhausted",
        "QuotaExceededError",
      );
    for (const change of changes) {
      if (!change || typeof change.store !== "string") continue;
      const p = plan(change.store);
      if (change.type === "schema") {
        p.rebuild = true;
        if (change.action === "renameStore") {
          p.reset = true;
          plan(change.name).rebuild = true;
        }
      } else if (change.action === "clear") p.reset = true;
      else if (change.action === "delete") {
        const query = unpack(change.args?.[0]);
        if (query instanceof IDBKeyRange) p.ranges.push(query);
        else if (query !== undefined) p.keys.push(query);
      } else if (change.key !== undefined) p.keys.push(change.key);
    }
  } catch (error) {
    fail(error);
    return;
  }
  // Initial/schema-only databases still have a base object overhead.
  if (!options.base.bytes) total.bytes = 128;
  const pending = [...plans.entries()];
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      fail(error);
    }
  };
  const nextStore = () =>
    guard(() => {
      const entry = pending.shift();
      if (!entry) {
        if (
          total.bytes > Math.max(limits.quotaBytes, options.base.bytes) ||
          total.records > limits.maxRecords ||
          total.indexEntries > limits.maxIndexEntries
        )
          throw new DOMException(
            "Website database exceeds its local allowance",
            "QuotaExceededError",
          );
        if (total.bytes < 0 || total.records < 0 || total.indexEntries < 0)
          throw new DOMException(
            "Invalid local accounting ledger",
            "InvalidStateError",
          );
        done(total);
        return;
      }
      const [name, p] = entry,
        read = keep.get(["local-store-v2", name]);
      read.onerror = () => fail(read.error);
      read.onsuccess = () =>
        guard(() => {
          const previous: Usage = read.result || ZERO(),
            current = { ...previous };
          const present = tx.db.objectStoreNames.contains(name),
            store = present ? tx.objectStore(name) : null;
          const finish = () => {
            add(total, previous, -1);
            add(total, current);
            if (present) keep.put(current, ["local-store-v2", name]);
            else keep.delete(["local-store-v2", name]);
            nextStore();
          };
          const applyRecord = (key: IDBValidKey, after: () => void) => {
            const old = keep.get(recordKey(name, key));
            old.onerror = () => fail(old.error);
            old.onsuccess = () =>
              guard(() => {
                if (old.result) add(current, old.result, -1);
                if (!store) {
                  keep.delete(recordKey(name, key));
                  after();
                  return;
                }
                const value = store.openCursor(IDBKeyRange.only(key));
                value.onerror = () => fail(value.error);
                value.onsuccess = () =>
                  guard(() => {
                    if (value.result) {
                      const usage = localIDBRecordUsage(
                        store,
                        key,
                        value.result.value,
                        measure,
                        limits,
                        factory,
                      );
                      add(current, usage);
                      keep.put(usage, recordKey(name, key));
                    } else {
                      keep.delete(recordKey(name, key));
                      options.onDelete?.(name, key);
                    }
                    after();
                  });
              });
          };
          const keys: IDBValidKey[] = [];
          let keyOffset = 0, keysPrepared = false;
          const queueKey = (key: IDBValidKey) => {
            keys.push(key);
          };
          for (const key of p.keys) queueKey(key);
          const nextKey = () => {
            // Range cursors and explicit mutations are collected before this
            // point. Sort/compact once rather than moving an array on each
            // descending or interleaved insertion.
            if (!keysPrepared) {
              keysPrepared = true;
              keys.sort((a, b) => factory.cmp(a, b));
              let unique = 0;
              for (const candidate of keys)
                if (!unique || factory.cmp(keys[unique - 1], candidate) !== 0)
                  keys[unique++] = candidate;
              keys.length = unique;
            }
            const key = keys[keyOffset++];
            if (key === undefined) finish();
            else applyRecord(key, nextKey);
          };
          const nextRange = () => {
            const query = p.ranges.shift();
            if (!query) {
              nextKey();
              return;
            }
            const cursor = keep.openKeyCursor(recordRange(name, query));
            cursor.onerror = () => fail(cursor.error);
            cursor.onsuccess = () =>
              guard(() => {
                if (cursor.result) {
                  queueKey((cursor.result.key as Any[])[2]);
                  cursor.result.continue();
                } else nextRange();
              });
          };
          if (p.reset || p.rebuild || !present) {
            keep.delete(recordRange(name));
            current.bytes = current.records = current.indexEntries = 0;
            if (store) {
              if (store.indexNames.length > limits.maxIndexes)
                throw new DOMException(
                  "Index allowance exhausted",
                  "QuotaExceededError",
                );
              current.bytes =
                128 +
                2 * name.length +
                measure(store.keyPath, limits.quotaBytes);
              for (const indexName of Array.from(store.indexNames))
                current.bytes +=
                  128 +
                  2 * indexName.length +
                  measure(store.index(indexName).keyPath, limits.quotaBytes);
            }
            if (p.rebuild && store) {
              const cursor = store.openCursor();
              cursor.onerror = () => fail(cursor.error);
              cursor.onsuccess = () =>
                guard(() => {
                  if (!cursor.result) {
                    finish();
                    return;
                  }
                  const usage = localIDBRecordUsage(
                    store,
                    cursor.result.primaryKey,
                    cursor.result.value,
                    measure,
                    limits,
                    factory,
                  );
                  add(current, usage);
                  keep.put(usage, recordKey(name, cursor.result.primaryKey));
                  options.onRecord?.(
                    name,
                    cursor.result.primaryKey,
                    cursor.result.value,
                  );
                  cursor.result.continue();
                });
            } else nextKey();
          } else nextRange();
        });
    });
  nextStore();
}
