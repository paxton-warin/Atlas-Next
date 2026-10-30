/** Payload-free native dirty generations. No cloud permissions, network or
 * replication payload allowance participates in the source transaction. */
export const LOCAL_DIRTY_V2_PREFIX = "atlas-local-dirty-v2";
export const LOCAL_DIRTY_V2_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxKeys: 8192,
});
export type LocalDirtyOperation =
  | "upsert"
  | "delete"
  | "clear"
  | "schema"
  | "database-delete";
export type LocalDirtyInput = {
  namespace: string;
  store?: string;
  key?: IDBValidKey;
  operation: LocalDirtyOperation;
  estimatedNativeBytes?: number;
  shapeEligible?: boolean;
};
export type LocalDirtyControl = {
  format: 2;
  namespace: string;
  incarnation: string;
  generation: number;
  acknowledgedGeneration: number;
  schemaEpoch: number;
  trackingEpoch: number;
  baselineRequired: boolean;
  deleted: boolean;
  dirtyCount: number;
  dirtyBytes: number;
  storeEpochs: Record<string, number>;
};
export type LocalDirtyMarker = {
  namespace: string;
  store: string;
  key: IDBValidKey;
  generation: number;
  operation: "upsert" | "delete";
  storeEpoch: number;
  estimatedNativeBytes: number | null;
  shapeEligible: boolean;
  bytes: number;
};
export type LocalDirtySize = {
  storeEpoch: number;
  estimatedNativeBytes: number;
  shapeEligible: boolean;
};
export const localDirtyControlKey = (namespace: string): IDBValidKey => [
  LOCAL_DIRTY_V2_PREFIX,
  "control",
  namespace,
];
export const localDirtyMarkerPrefix = (
  namespace: string,
  epoch: number,
): IDBValidKey[] => [LOCAL_DIRTY_V2_PREFIX, "dirty", namespace, epoch];
export const localDirtyGenerationPrefix = (
  namespace: string,
  epoch: number,
): IDBValidKey[] => [LOCAL_DIRTY_V2_PREFIX, "generation", namespace, epoch];
export const localDirtySizeKey = (
  namespace: string,
  store: string,
  epoch: number,
  key: IDBValidKey,
): IDBValidKey => [LOCAL_DIRTY_V2_PREFIX, "size", namespace, store, epoch, key];
export function emptyLocalDirtyControl(namespace: string): LocalDirtyControl {
  return {
    format: 2,
    namespace,
    incarnation: crypto.randomUUID(),
    generation: 0,
    acknowledgedGeneration: 0,
    schemaEpoch: 1,
    trackingEpoch: 1,
    baselineRequired: false,
    deleted: false,
    dirtyCount: 0,
    dirtyBytes: 0,
    storeEpochs: Object.create(null),
  };
}
export function checkedLocalDirtyControl(
  value: unknown,
  namespace: string,
): LocalDirtyControl {
  if (value === undefined) return emptyLocalDirtyControl(namespace);
  const v = value as LocalDirtyControl;
  if (
    !v ||
    typeof v.incarnation !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(v.incarnation) ||
    v.format !== 2 ||
    v.namespace !== namespace ||
    !v.storeEpochs ||
    typeof v.storeEpochs !== "object" ||
    ![
      v.generation,
      v.acknowledgedGeneration,
      v.schemaEpoch,
      v.trackingEpoch,
      v.dirtyCount,
      v.dirtyBytes,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    v.acknowledgedGeneration > v.generation ||
    typeof v.baselineRequired !== "boolean" ||
    typeof v.deleted !== "boolean" ||
    Object.values(v.storeEpochs).some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw Error("LOCAL_DIRTY_METADATA_INVALID");
  return { ...v, storeEpochs: Object.assign(Object.create(null), v.storeEpochs) };
}
const states = new WeakMap<
  IDBTransaction,
  Map<
    string,
    {
      control?: LocalDirtyControl;
      loading: boolean;
      pending: LocalDirtyInput[];
      processing: boolean;
      generation: number;
      receipt: { generation: number };
      limits: { maxBytes: number; maxKeys: number };
    }
  >
>();
function markerBytes(input: LocalDirtyInput) {
  // A conservative bounded metadata charge; it never traverses native values.
  let bytes = 192 + input.namespace.length * 2 + (input.store?.length || 0) * 2,
    nodes = 0;
  const visit = (key: IDBValidKey): void => {
    if (++nodes > 1024) {
      bytes = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (typeof key === "string") bytes += key.length * 2;
    else if (typeof key === "number" || key instanceof Date) bytes += 16;
    else if (Array.isArray(key)) for (const item of key) visit(item);
    else if (key instanceof ArrayBuffer) bytes += key.byteLength;
    else if (ArrayBuffer.isView(key)) bytes += key.byteLength;
  };
  if (input.key !== undefined) visit(input.key);
  return bytes;
}
/** Must be called in the data mutation's existing native readwrite transaction.
 * Generation is allocated ONCE per namespace per native transaction. Returned
 * receipt is updated by IDB callbacks before transaction completion.
 * Metadata capacity changes representation instead of aborting user writes.
 */
export function appendLocalDirty(
  store: IDBObjectStore,
  input: LocalDirtyInput,
  limits: { maxBytes?: number; maxKeys?: number } = {},
): { generation: number } {
  if (
    typeof input.namespace !== "string" ||
    !input.namespace ||
    input.namespace.length > 2048 ||
    !["upsert", "delete", "clear", "schema", "database-delete"].includes(
      input.operation,
    ) ||
    (["upsert", "delete"].includes(input.operation) &&
      input.key === undefined) ||
    (input.estimatedNativeBytes !== undefined &&
      (!Number.isSafeInteger(input.estimatedNativeBytes) ||
        input.estimatedNativeBytes < 0))
  )
    throw new TypeError("Invalid local dirty marker");
  let map = states.get(store.transaction);
  if (!map) {
    map = new Map();
    states.set(store.transaction, map);
  }
  const stateKey = store.name + "\0" + input.namespace;
  let state = map.get(stateKey);
  if (!state) {
    const maxBytes = limits.maxBytes ?? LOCAL_DIRTY_V2_LIMITS.maxBytes,
      maxKeys = limits.maxKeys ?? LOCAL_DIRTY_V2_LIMITS.maxKeys;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      !Number.isSafeInteger(maxKeys) ||
      maxKeys < 0
    )
      throw new TypeError("Invalid local dirty limits");
    state = {
      loading: true,
      pending: [],
      processing: false,
      generation: 0,
      receipt: { generation: 0 },
      limits: { maxBytes, maxKeys },
    };
    map.set(stateKey, state);
    const request = store.get(localDirtyControlKey(input.namespace));
    request.onsuccess = () => {
      try {
        state!.control = checkedLocalDirtyControl(
          request.result,
          input.namespace,
        );
        if (state!.control.generation >= Number.MAX_SAFE_INTEGER)
          throw Error("LOCAL_GENERATION_EXHAUSTED");
        state!.generation = ++state!.control.generation;
        state!.receipt.generation = state!.generation;
        state!.loading = false;
        if (state!.control.baselineRequired)
          scheduleAfterCommit(store, input.namespace);
        pump();
      } catch {
        store.transaction.abort();
      }
    };
  }
  state.pending.push({ ...input });
  function baseline() {
    const c = state!.control!;
    c.baselineRequired = true;
    c.trackingEpoch++;
    c.dirtyCount = 0;
    c.dirtyBytes = 0;
    scheduleAfterCommit(store, input.namespace);
  }
  function persist() {
    store.put(state!.control!, localDirtyControlKey(input.namespace));
  }
  function pump(): void {
    if (state!.loading || state!.processing) return;
    const item = state!.pending.shift();
    if (!item) {
      persist();
      return;
    }
    const c = state!.control!,
      logicalStore = item.store || "";
    if (item.operation === "schema") {
      c.schemaEpoch++;
      baseline();
      persist();
      pump();
      return;
    }
    if (item.operation === "clear") {
      c.storeEpochs[logicalStore] = (c.storeEpochs[logicalStore] || 1) + 1;
      baseline();
      persist();
      pump();
      return;
    }
    if (item.operation === "database-delete") {
      c.deleted = true;
      baseline();
      persist();
      pump();
      return;
    }
    c.deleted = false;
    const epoch = c.storeEpochs[logicalStore] || 1;
    c.storeEpochs[logicalStore] = epoch;
    const sizeKey = localDirtySizeKey(
      item.namespace,
      logicalStore,
      epoch,
      item.key!,
    );
    if (item.operation === "delete") store.delete(sizeKey);
    else if (item.estimatedNativeBytes !== undefined)
      store.put(
        {
          storeEpoch: epoch,
          estimatedNativeBytes: item.estimatedNativeBytes,
          shapeEligible: item.shapeEligible !== false,
        } satisfies LocalDirtySize,
        sizeKey,
      );
    else store.delete(sizeKey);
    const bytes = markerBytes(item);
    // Fall back before issuing an unbounded metadata-key allocation.
    if (bytes > state!.limits.maxBytes) {
      baseline();
      persist();
      pump();
      return;
    }
    const key: IDBValidKey = [
      ...localDirtyMarkerPrefix(item.namespace, c.trackingEpoch),
      epoch,
      logicalStore,
      item.key!,
    ];
    state!.processing = true;
    const prior = store.get(key);
    prior.onsuccess = () => {
      state!.processing = false;
      const old = prior.result as LocalDirtyMarker | undefined;
      const nextBytes = c.dirtyBytes - (old?.bytes || 0) + bytes;
      const nextCount = c.dirtyCount + (old ? 0 : 1);
      if (
        nextBytes > state!.limits.maxBytes ||
        nextCount > state!.limits.maxKeys
      ) {
        baseline();
        persist();
        pump();
        return;
      }
      if (old)
        store.delete([
          ...localDirtyGenerationPrefix(item.namespace, c.trackingEpoch),
          old.generation,
          old.storeEpoch,
          old.store,
          old.key,
        ]);
      const marker: LocalDirtyMarker = {
        namespace: item.namespace,
        store: logicalStore,
        key: item.key!,
        generation: state!.generation,
        operation: item.operation as "upsert" | "delete",
        storeEpoch: epoch,
        estimatedNativeBytes: item.estimatedNativeBytes ?? null,
        shapeEligible: item.shapeEligible !== false,
        bytes,
      };
      store.put(marker, key);
      store.put(marker, [
        ...localDirtyGenerationPrefix(item.namespace, c.trackingEpoch),
        marker.generation,
        epoch,
        logicalStore,
        item.key!,
      ]);
      c.dirtyBytes = nextBytes;
      c.dirtyCount = nextCount;
      persist();
      pump();
    };
  }
  pump();
  return state.receipt;
}
export async function readLocalDirtyControl(
  store: IDBObjectStore,
  namespace: string,
): Promise<LocalDirtyControl> {
  const request = store.get(localDirtyControlKey(namespace));
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      try {
        resolve(checkedLocalDirtyControl(request.result, namespace));
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
}
/** Constant-size adoption: source transactions never wait behind an unbounded
 * marker-deletion cursor. Physical cleanup is a separate bounded operation. */
export function acknowledgeLocalDirty(
  store: IDBObjectStore,
  namespace: string,
  cut: number,
  expectedTrackingEpoch: number,
): void {
  const request = store.get(localDirtyControlKey(namespace));
  request.onsuccess = () => {
    const c = checkedLocalDirtyControl(request.result, namespace);
    if (!Number.isSafeInteger(cut) || cut < 0 || cut > c.generation) {
      store.transaction.abort();
      return;
    }
    c.acknowledgedGeneration = Math.max(c.acknowledgedGeneration, cut);
    if (c.trackingEpoch === expectedTrackingEpoch && cut === c.generation)
      c.baselineRequired = false;
    store.put(c, localDirtyControlKey(namespace));
  };
}
/** At most maxRows old/ACKed marker rows per native transaction. Payloads and
 * native records are never visited; new dirty generations are not removed. */
export type LocalDirtyGCResult = {
  visited: number;
  removed: number;
  complete: boolean;
};
export function collectLocalDirtyGarbage(
  store: IDBObjectStore,
  namespace: string,
  maxRows = 64,
): LocalDirtyGCResult {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 64)
    throw new TypeError("Invalid dirty GC budget");
  const result: LocalDirtyGCResult = {
    visited: 0,
    removed: 0,
    complete: false,
  };
  let idbNamespace = false;
  try {
    idbNamespace = JSON.parse(namespace)[0] === "idb";
  } catch {}
  const request = store.get(localDirtyControlKey(namespace)),
    gcKey: IDBValidKey = [LOCAL_DIRTY_V2_PREFIX, "gc", namespace];
  request.onsuccess = () => {
    const c = checkedLocalDirtyControl(request.result, namespace),
      saved = store.get(gcKey);
    saved.onsuccess = () => {
      const goal = JSON.stringify([
        c.trackingEpoch,
        c.schemaEpoch,
        c.acknowledgedGeneration,
        c.storeEpochs,
        c.deleted,
      ]);
      type Progress = {
        goal?: string;
        dirtyAfter?: IDBValidKey;
        sizeAfter?: IDBValidKey;
        dirtyDone?: boolean;
        sizeDone?: boolean;
        rescan?: boolean;
      };
      const old = (saved.result || {}) as Progress,
        progress: Progress =
          old.goal === goal
            ? old
            : {
                ...old,
                goal,
                rescan: !!old.goal,
                dirtyDone: false,
                sizeDone: false,
              };
      function save() {
        result.complete = !!progress.dirtyDone && !!progress.sizeDone;
        if (result.complete && progress.rescan) {
          progress.dirtyDone = false;
          progress.sizeDone = false;
          delete progress.dirtyAfter;
          delete progress.sizeAfter;
          progress.rescan = false;
          result.complete = false;
        }
        if (result.complete && idbNamespace)
          for (const name of Object.keys(c.storeEpochs))
            if (!store.transaction.db.objectStoreNames.contains(name))
              delete c.storeEpochs[name];
        store.put(c, localDirtyControlKey(namespace));
        store.put(progress, gcKey);
      }
      function sizes() {
        if (progress.sizeDone) {
          save();
          return;
        }
        const prefix: IDBValidKey[] = [
            LOCAL_DIRTY_V2_PREFIX,
            "size",
            namespace,
          ],
          lower = progress.sizeAfter || prefix;
        const cursor = store.openKeyCursor(
          IDBKeyRange.bound(
            lower,
            [...prefix, []],
            !!progress.sizeAfter,
            false,
          ),
        );
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) {
            delete progress.sizeAfter;
            progress.sizeDone = true;
            save();
            return;
          }
          const key = row.primaryKey as IDBValidKey[],
            name = String(key[3]),
            epoch = Number(key[4]);
          if (result.visited >= maxRows) {
            save();
            return;
          }
          result.visited++;
          progress.sizeAfter = row.primaryKey;
          if (
            c.deleted ||
            epoch < (c.storeEpochs[name] || 1) ||
            (idbNamespace &&
              !store.transaction.db.objectStoreNames.contains(name))
          ) {
            store.delete(row.primaryKey);
            result.removed++;
          }
          row.continue();
        };
      }
      if (progress.dirtyDone) {
        sizes();
        return;
      }
      const prefix: IDBValidKey[] = [LOCAL_DIRTY_V2_PREFIX, "dirty", namespace],
        lower = progress.dirtyAfter || prefix;
      const cursor = store.openCursor(
        IDBKeyRange.bound(lower, [...prefix, []], !!progress.dirtyAfter, false),
      );
      let dirtyVisited = 0;
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {
          delete progress.dirtyAfter;
          progress.dirtyDone = true;
          sizes();
          return;
        }
        if (dirtyVisited >= Math.max(1, Math.floor(maxRows / 2))) {
          sizes();
          return;
        }
        dirtyVisited++;
        result.visited++;
        progress.dirtyAfter = row.primaryKey;
        const key = row.primaryKey as IDBValidKey[],
          epoch = Number(key[3]),
          marker = row.value as LocalDirtyMarker;
        if (
          epoch < c.trackingEpoch ||
          marker.generation <= c.acknowledgedGeneration
        ) {
          row.delete();
          result.removed++;
          store.delete([
            ...localDirtyGenerationPrefix(namespace, epoch),
            marker.generation,
            marker.storeEpoch,
            marker.store,
            marker.key,
          ]);
          if (epoch === c.trackingEpoch) {
            c.dirtyCount = Math.max(0, c.dirtyCount - 1);
            c.dirtyBytes = Math.max(0, c.dirtyBytes - marker.bytes);
          }
        }
        row.continue();
      };
    };
  };
  return result;
}
/** Obsolete local metadata must not depend on an active cloud publisher. Each
 * maintenance transaction starts AFTER the source commit, visits <=64 metadata
 * rows, has a 4ms deadline and yields before continuing. It never reads website
 * values or touches a cloud lease, quota, acknowledgement or data row. */
const maintenance = new WeakMap<
  IDBDatabase,
  Map<string, { timer: ReturnType<typeof setTimeout> | undefined }>
>();
const scheduledTransactions = new WeakMap<IDBTransaction, Set<string>>();
function scheduleAfterCommit(store: IDBObjectStore, namespace: string) {
  let scheduled = scheduledTransactions.get(store.transaction);
  if (!scheduled) {
    scheduled = new Set();
    scheduledTransactions.set(store.transaction, scheduled);
  }
  const key = store.name + "\0" + namespace;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const db = store.transaction.db,
    name = store.name;
  store.transaction.addEventListener(
    "complete",
    () => {
      let jobs = maintenance.get(db);
      if (!jobs) {
        jobs = new Map();
        maintenance.set(db, jobs);
      }
      if (jobs.has(key)) return;
      const job: { timer: ReturnType<typeof setTimeout> | undefined } = {
        timer: undefined,
      };
      jobs.set(key, job);
      function arm(delay: number) {
        job.timer = setTimeout(run, delay);
      }
      function run() {
        job.timer = undefined;
        let tx: IDBTransaction;
        try {
          tx = db.transaction(name, "readwrite");
        } catch {
          jobs!.delete(key);
          return;
        }
        const result = collectLocalDirtyGarbage(
            tx.objectStore(name),
            namespace,
            8,
          ),
          deadline = setTimeout(() => {
            try {
              tx.abort();
            } catch {}
          }, 4);
        tx.oncomplete = () => {
          clearTimeout(deadline);
          if (!result.complete) arm(16);
          else jobs!.delete(key);
        };
        tx.onabort = () => {
          clearTimeout(deadline);
          arm(500);
        };
        tx.onerror = () => {};
      }
      arm(250);
    },
    { once: true },
  );
}
