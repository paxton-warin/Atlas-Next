/** Bounded native capture. Key-only cursors and transactional size metadata are
 * consulted before requesting any website value. This module runs in the
 * restartable backup actor, never the storage actor or parent UI. */
import { measureBackupNativeKey } from "./backup-v2-keys.ts";
import {
  type BackupSource,
  type BackupSourcePage,
  type BackupSourceRecord,
} from "./backup-v2-capture.ts";
import {
  BACKUP_V2_LIMITS,
  backupDeferred,
  type BackupNamespace,
} from "./backup-v2-contracts.ts";
import {
  acknowledgeLocalDirty,
  collectLocalDirtyGarbage,
  readLocalDirtyControl,
  localDirtyGenerationPrefix,
  localDirtySizeKey,
  type LocalDirtyControl,
  type LocalDirtyMarker,
  type LocalDirtySize,
} from "./local-dirty-v2.ts";
export type BackupNativeSourceDescriptor = {
  id: string;
  namespace: BackupNamespace;
  database: string;
  metadataStore: string;
  /** The serialized native dirty namespace is not the server namespace key. */
  dirtyNamespace: string;
  kind: "local" | "cookies" | "idb" | "atlas";
  /** localStorage origin or cookie schemeful site; IDB uses its logical name. */
  scope: string;
};
type Limits = { maxRecords: number; maxBytes: number; deadlineMs: number };
type Cursor = { store: number; key?: IDBValidKey };
const sourceFailure = (error: unknown) => {
  const e = error as { name?: string };
  return e?.name === "AbortError" &&
    !(error as { backupDeferred?: boolean })?.backupDeferred
    ? backupDeferred(
        "BACKUP_SOURCE_BUSY",
        "Backup yielded to foreground activity or a changing local transaction.",
      )
    : error;
};
const complete = (tx: IDBTransaction) => {
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        sourceFailure(
          tx.error || new DOMException("Backup read interrupted", "AbortError"),
        ),
      );
    tx.onerror = () => {};
  });
  void completion.catch(() => {});
  return completion;
};
const prefixRange = (p: IDBValidKey[]) => IDBKeyRange.bound(p, [...p, []]);
export function createIndexedDBBackupSource(
  factory: IDBFactory,
  d: BackupNativeSourceDescriptor,
  options: {
    foreground?: () => boolean;
    now?: () => number;
  } = {},
): BackupSource & { dispose(): void; interrupt(): void } {
  let stopped = false;
  const active = new Set<IDBTransaction>(),
    now = options.now ?? (() => performance.now());
  let db: Promise<IDBDatabase> | undefined;
  const database = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(d.database);
      let created = false;
      r.onupgradeneeded = () => {
        created = true;
        r.transaction!.abort();
      };
      r.onerror = () =>
        reject(
          created
            ? backupDeferred(
                "BACKUP_SOURCE_MISSING",
                "The local site is not ready for backup.",
              )
            : r.error,
        );
      r.onsuccess = () => {
        const value = r.result;
        if (!value.objectStoreNames.contains(d.metadataStore)) {
          value.close();
          reject(
            backupDeferred(
              "BACKUP_SOURCE_LEGACY",
              "This site remains in legacy storage.",
            ),
          );
          return;
        }
        value.onversionchange = () => value.close();
        resolve(value);
      };
      r.onblocked = () =>
        reject(
          backupDeferred(
            "BACKUP_SOURCE_BUSY",
            "This website is changing its local schema.",
          ),
        );
    }));
  async function transaction(mode: IDBTransactionMode, all = true) {
    if (stopped)
      throw backupDeferred("BACKUP_ACTOR_STOPPED", "Backup actor stopped.");
    if (options.foreground?.())
      throw backupDeferred(
        "BACKUP_FOREGROUND_BUSY",
        "Backup yielded to website activity.",
      );
    const value = await database(),
      t = value.transaction(
        all ? Array.from(value.objectStoreNames) : [d.metadataStore],
        mode,
      );
    active.add(t);
    t.addEventListener("complete", () => active.delete(t));
    t.addEventListener("abort", () => active.delete(t));
    return t;
  }
  function stores(t: IDBTransaction) {
    return d.kind === "local"
      ? ["values-v2"]
      : d.kind === "cookies"
        ? ["cookies"]
        : d.kind === "atlas"
          ? ["preferences"]
          : Array.from(t.db.objectStoreNames).filter(
              (n) => n !== d.metadataStore,
            );
  }
  function schema(t: IDBTransaction) {
    const entries = stores(t).map((name) => {
      const s = t.objectStore(name);
      return {
        name: d.kind === "idb" ? name : "",
        keyPath: s.keyPath,
        autoIncrement: s.autoIncrement,
        generator: null as null | { next: number } | { exhausted: true },
        indexes: Array.from(s.indexNames).map((n) => {
          const i = s.index(n);
          return {
            name: n,
            keyPath: i.keyPath,
            unique: i.unique,
            multiEntry: i.multiEntry,
          };
        }),
      };
    });
    return {
      format: "atlas-local-schema-v2",
      kind: d.kind,
      version: t.db.version,
      stores: entries,
    };
  }
  function eligible(s: LocalDirtySize | undefined) {
    if (
      !s ||
      !Number.isSafeInteger(s.estimatedNativeBytes) ||
      s.estimatedNativeBytes > BACKUP_V2_LIMITS.nativeRecordBytes ||
      s.shapeEligible === false
    )
      throw backupDeferred(
        "BACKUP_RECORD_UNSIZED",
        "This local record is oversized or has no safe pre-read size metadata.",
      );
    return s;
  }
  function physicalKey(store: string, key: IDBValidKey): IDBValidKey {
    return d.kind === "local" ? ["local", d.scope, key] : key;
  }
  async function readControl() {
    const t = await transaction("readonly", false),
      end = complete(t);
    try {
      const c = await readLocalDirtyControl(
        t.objectStore(d.metadataStore),
        d.dirtyNamespace,
      );
      await end;
      return c;
    } catch (error) {
      await end.catch(() => {});
      throw sourceFailure(error);
    }
  }
  async function page(
    kind: "baseline" | "changes",
    after: number,
    target: number,
    cursor: unknown,
    limits: Limits,
  ): Promise<BackupSourcePage> {
    const t = await transaction("readonly"),
      end = complete(t),
      meta = t.objectStore(d.metadataStore),
      started = now();
    let failure: unknown,
      control: LocalDirtyControl,
      done = false,
      bytes = 0,
      visited = 0;
    const rows: BackupSourceRecord[] = [];
    const timeout = setTimeout(
      () => {
        failure = backupDeferred(
          "BACKUP_READ_DEADLINE",
          "Backup yielded after its bounded read transaction deadline.",
        );
        try {
          t.abort();
        } catch {}
      },
      Math.min(4, limits.deadlineMs),
    );
    const position: Cursor = cursor ? { ...(cursor as Cursor) } : { store: 0 };
    const budget = () =>
      rows.length >= Math.min(64, limits.maxRecords) ||
      bytes >= Math.min(BACKUP_V2_LIMITS.pageBytes, limits.maxBytes) ||
      now() - started >= Math.min(2, limits.deadlineMs) ||
      options.foreground?.();
    const fail = (e: unknown) => {
      failure = e;
      try {
        t.abort();
      } catch {}
    };
    const guard = (work: () => void) => {
      try {
        work();
      } catch (e) {
        fail(e);
      }
    };
    const initial = meta.get([
      "atlas-local-dirty-v2",
      "control",
      d.dirtyNamespace,
    ]);
    initial.onsuccess = () =>
      guard(() => {
        // readControl validates malformed ledgers using the same transaction.
        const r = readLocalDirtyControl(meta, d.dirtyNamespace);
        void r.then((c) => {
          control = c;
          guard(() => (kind === "baseline" ? nextStore() : nextChange()));
        }, fail);
      });
    function value(
      logicalStore: string,
      key: IDBValidKey,
      generation: number,
      epoch: number,
      operation: "upsert" | "delete",
      afterValue: () => void,
    ) {
      let keyBytes: number;
      try {
        keyBytes = measureBackupNativeKey(key);
      } catch {
        throw backupDeferred(
          "BACKUP_KEY_TOO_LARGE",
          "This local key remains local because it exceeds the automatic backup memory budget.",
        );
      }
      if (operation === "delete") {
        rows.push({
          operation: "delete",
          store: logicalStore,
          key,
          generation,
          storeEpoch: epoch,
        });
        afterValue();
        return;
      }
      const size = meta.get(
        localDirtySizeKey(d.dirtyNamespace, logicalStore, epoch, key),
      );
      size.onsuccess = () =>
        guard(() => {
          const info = eligible(size.result);
          if (
            info.estimatedNativeBytes + keyBytes >
            BACKUP_V2_LIMITS.nativeRecordBytes
          )
            throw backupDeferred(
              "BACKUP_RECORD_TOO_LARGE",
              "This key/value record exceeds the automatic backup memory budget.",
            );
          const physical =
            d.kind === "idb"
              ? logicalStore
              : d.kind === "local"
                ? "values-v2"
                : d.kind === "atlas"
                  ? "preferences"
                  : "cookies";
          if (
            rows.length &&
            bytes + info.estimatedNativeBytes > limits.maxBytes
          ) {
            done = false;
            return;
          }
          const request = t
            .objectStore(physical)
            .openCursor(IDBKeyRange.only(physicalKey(logicalStore, key)));
          request.onsuccess = () =>
            guard(() => {
              const row = request.result;
              rows.push({
                operation: row ? "put" : "delete",
                store: logicalStore,
                key,
                ...(row ? { value: row.value } : {}),
                generation,
                storeEpoch: epoch,
                estimatedNativeBytes: info.estimatedNativeBytes + keyBytes,
                shapeEligible: info.shapeEligible,
              });
              bytes += info.estimatedNativeBytes + keyBytes;
              afterValue();
            });
        });
    }
    function nextStore() {
      const names = stores(t);
      if (position.store >= names.length) {
        done = true;
        return;
      }
      const name = names[position.store],
        store = t.objectStore(name),
        logical = d.kind === "idb" ? name : "";
      let range: IDBKeyRange | undefined;
      if (d.kind === "local") range = prefixRange(["local", d.scope]);
      const base = d.kind === "cookies" ? store.index("site") : store;
      if (d.kind === "cookies") range = IDBKeyRange.only(d.scope);
      const r = base.openKeyCursor(range);
      let continued = false;
      r.onsuccess = () =>
        guard(() => {
          const item = r.result;
          if (!item) {
            position.store++;
            delete position.key;
            if (budget()) {
              done = position.store >= names.length;
              return;
            }
            nextStore();
            return;
          }
          // Index continuation preserves exact primary-key order for one site.
          if (
            position.key !== undefined &&
            factory.cmp(item.primaryKey, position.key) <= 0
          ) {
            if (!continued && factory.cmp(item.primaryKey, position.key) < 0) {
              continued = true;
              if (d.kind === "cookies")
                item.continuePrimaryKey(d.scope, position.key);
              else item.continue(position.key);
              return;
            }
            item.continue();
            return;
          }
          if (visited++ > 0 && budget()) return;
          const key =
            d.kind === "local"
              ? (item.primaryKey as IDBValidKey[])[2]
              : item.primaryKey;
          const epoch = control.storeEpochs[logical] || 1;
          value(logical, key, control.generation, epoch, "upsert", () => {
            position.key = item.primaryKey;
            if (budget()) return;
            item.continue();
          });
        });
    }
    function nextChange() {
      const prefix = localDirtyGenerationPrefix(
        d.dirtyNamespace,
        control.trackingEpoch,
      );
      const lower = position.key ?? [...prefix, after, []],
        upper = [...prefix, target, []];
      if (factory.cmp(lower, upper) > 0) {
        done = true;
        return;
      }
      const r = meta.openCursor(IDBKeyRange.bound(lower, upper, true, false));
      r.onsuccess = () =>
        guard(() => {
          const item = r.result;
          if (!item) {
            done = true;
            return;
          }
          if (visited++ > 0 && budget()) return;
          const marker = item.value as LocalDirtyMarker;
          value(
            marker.store,
            marker.key,
            marker.generation,
            marker.storeEpoch,
            marker.operation,
            () => {
              position.key = item.key;
              if (budget()) return;
              item.continue();
            },
          );
        });
    }
    try {
      await end;
    } catch (e) {
      throw sourceFailure(failure || e);
    } finally {
      clearTimeout(timeout);
    }
    return { records: rows, done, ...(done ? {} : { cursor: position }) };
  }
  async function seal(
    expected: Pick<
      LocalDirtyControl,
      "generation" | "schemaEpoch" | "trackingEpoch"
    >,
  ) {
    // Probe generators in the SAME short serialized native transaction as the
    // final generation check. Abort the sentinel additions; no user row changes.
    const t = await transaction("readwrite"),
      meta = t.objectStore(d.metadataStore),
      header = schema(t);
    return new Promise<false | { schema: unknown }>((resolve, reject) => {
      let expectedAbort = false,
        result: false | { schema: unknown } = false,
        failure: unknown;
      const timeout = setTimeout(() => {
        failure = backupDeferred(
          "BACKUP_SEAL_DEADLINE",
          "Backup yielded after its bounded generation probe deadline.",
        );
        try {
          t.abort();
        } catch {}
      }, 4);
      const r = meta.get(["atlas-local-dirty-v2", "control", d.dirtyNamespace]);
      r.onsuccess = () => {
        try {
          const c = r.result as LocalDirtyControl;
          if (
            !c ||
            c.generation !== expected.generation ||
            c.schemaEpoch !== expected.schemaEpoch ||
            c.trackingEpoch !== expected.trackingEpoch
          ) {
            expectedAbort = true;
            t.abort();
            return;
          }
          const autos = header.stores.filter((s) => s.autoIncrement);
          let left = autos.length;
          const finish = () => {
            result = { schema: header };
            expectedAbort = true;
            t.abort();
          };
          if (!left) {
            finish();
            return;
          }
          for (const s of autos) {
            const q = t.objectStore(s.name).add(s.keyPath === null ? null : {});
            q.onsuccess = () => {
              s.generator = { next: Number(q.result) };
              if (!--left) finish();
            };
            q.onerror = (e) => {
              if (q.error?.name === "ConstraintError") {
                e.preventDefault();
                e.stopPropagation();
                s.generator = { exhausted: true };
                if (!--left) finish();
              } else {
                failure = q.error;
                t.abort();
              }
            };
          }
        } catch (e) {
          failure = e;
          t.abort();
        }
      };
      t.onabort = () => {
        clearTimeout(timeout);
        expectedAbort
          ? resolve(result)
          : reject(
              failure ||
                t.error ||
                backupDeferred(
                  "BACKUP_SEAL_INTERRUPTED",
                  "Backup yielded to foreground activity.",
                ),
            );
      };
      t.oncomplete = () => {
        clearTimeout(timeout);
        reject(Error("BACKUP_GENERATOR_PROBE_COMMITTED"));
      };
      t.onerror = () => {};
    });
  }
  return {
    id: d.id,
    namespace: d.namespace,
    readControl,
    async schema() {
      const t = await transaction("readonly"),
        end = complete(t),
        s = schema(t);
      let deferred = false;
      if (d.kind === "atlas") {
        const r = t
          .objectStore(d.metadataStore)
          .getKey(
            IDBKeyRange.bound(["atlas-deferred"], ["atlas-deferred", []]),
          );
        r.onsuccess = () => {
          deferred = r.result !== undefined;
        };
      }
      await end;
      if (deferred)
        throw backupDeferred(
          "BACKUP_ATLAS_PREFERENCE_DEFERRED",
          "Some Atlas preferences remain local because they exceed the automatic backup budget.",
        );
      return s;
    },
    scanBaseline: (cursor, limits) => page("baseline", 0, 0, cursor, limits),
    scanChanges: (a, g, cursor, limits) =>
      page("changes", a, g, cursor, limits),
    seal,
    async acknowledge(cut, epoch) {
      const t = await transaction("readwrite", false),
        end = complete(t);
      acknowledgeLocalDirty(
        t.objectStore(d.metadataStore),
        d.dirtyNamespace,
        cut,
        epoch,
      );
      await end;
      // Cleanup is independent and bounded; it never delays acknowledgement.
      if (!stopped) {
        const gc = await transaction("readwrite", false),
          finished = complete(gc);
        collectLocalDirtyGarbage(
          gc.objectStore(d.metadataStore),
          d.dirtyNamespace,
          64,
        );
        await finished;
      }
    },
    async maintain() {
      const t = await transaction("readwrite", false),
        end = complete(t);
      const timer = setTimeout(() => {
        try {
          t.abort();
        } catch {}
      }, 4);
      collectLocalDirtyGarbage(
        t.objectStore(d.metadataStore),
        d.dirtyNamespace,
        64,
      );
      try {
        await end;
      } finally {
        clearTimeout(timer);
      }
    },
    interrupt() {
      for (const t of active)
        try {
          t.abort();
        } catch {}
    },
    dispose() {
      stopped = true;
      for (const t of active)
        try {
          t.abort();
        } catch {}
      void db?.then((d) => d.close()).catch(() => {});
    },
  };
}
