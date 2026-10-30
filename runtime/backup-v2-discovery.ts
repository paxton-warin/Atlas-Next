/** Bounded native metadata discovery. Each batch has a durable continuation;
 * no website values, factory.databases(), or full-source execution arrays. */
import {
  profileDatabaseName,
  profileIDBPrefix,
  PROFILE_IDB_KEEP,
} from "./profile-journal.ts";
import { profileCatalogName } from "./profile-idb-catalog.ts";
import {
  atlasBackupDatabase,
  ATLAS_BACKUP_NAMESPACE,
} from "./backup-v2-preferences.ts";
import { LOCAL_DIRTY_V2_PREFIX } from "./local-dirty-v2.ts";
import { backupDeferred } from "./backup-v2-contracts.ts";
import type { BackupNativeSourceDescriptor } from "./backup-v2-indexeddb-source.ts";
export type BackupDiscoveryCursor = {
  phase: "local" | "cookies" | "atlas" | "idb" | "done";
  after?: IDBValidKey;
};
export type BackupDiscoveryOptions = {
  foreground?: () => boolean;
  onTransaction?: (abort: () => void) => () => void;
};
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
async function existing(factory: IDBFactory, name: string) {
  return new Promise<IDBDatabase | null>((res, rej) => {
    let missing = false;
    const r = factory.open(name);
    r.onupgradeneeded = () => {
      missing = true;
      r.transaction!.abort();
    };
    r.onerror = () => (missing ? res(null) : rej(r.error));
    r.onblocked = () =>
      rej(
        backupDeferred(
          "BACKUP_SOURCE_BUSY",
          "Backup discovery yielded to a changing local schema.",
        ),
      );
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      res(r.result);
    };
  });
}
async function metadata<T>(
  db: IDBDatabase,
  store: string,
  work: (t: IDBTransaction) => Promise<T>,
  options: BackupDiscoveryOptions,
) {
  if (options.foreground?.())
    throw backupDeferred(
      "BACKUP_FOREGROUND_BUSY",
      "Backup discovery yielded to website activity.",
    );
  const t = db.transaction(store);
  let failure: unknown;
  const abort = (foreground = false) => {
    failure = backupDeferred(
      foreground ? "BACKUP_FOREGROUND_BUSY" : "BACKUP_DISCOVERY_DEADLINE",
      "Backup discovery will resume from its durable metadata cursor.",
    );
    try {
      t.abort();
    } catch {}
  };
  const timer = setTimeout(() => abort(options.foreground?.() ?? false), 4),
    unregister = options.onTransaction?.(() => abort(true));
  const end = new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = () =>
      rej(
        failure ||
          t.error ||
          backupDeferred(
            "BACKUP_DISCOVERY_INTERRUPTED",
            "Backup discovery was interrupted.",
          ),
      );
    t.onerror = () => {};
  });
  void end.catch(() => {});
  try {
    const value = await Promise.race([
      work(t),
      end.then(() => {
        throw Error("BACKUP_DISCOVERY_PAGE_INCOMPLETE");
      }),
    ]);
    await end;
    return value;
  } catch (error) {
    try {
      t.abort();
    } catch {}
    await end.catch(() => {});
    throw failure || error;
  } finally {
    clearTimeout(timer);
    unregister?.();
  }
}
export async function readBackupSourceBatch(
  factory: IDBFactory,
  replicaId: string,
  cursor: BackupDiscoveryCursor = { phase: "local" },
  options: BackupDiscoveryOptions = {},
  pageSize = 64,
): Promise<{
  sources: BackupNativeSourceDescriptor[];
  next: BackupDiscoveryCursor;
}> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 64)
    throw TypeError("Invalid backup discovery page");
  if (cursor.phase === "done") return { sources: [], next: cursor };
  if (cursor.phase === "atlas") {
    const database = atlasBackupDatabase(replicaId),
      db = await existing(factory, database);
    db?.close();
    return {
      sources: db
        ? [
            {
              id: ATLAS_BACKUP_NAMESPACE,
              namespace: { kind: "atlas" },
              database,
              metadataStore: "meta",
              dirtyNamespace: ATLAS_BACKUP_NAMESPACE,
              kind: "atlas",
              scope: "",
            },
          ]
        : [],
      next: { phase: "idb" },
    };
  }
  const kind = cursor.phase,
    database =
      kind === "idb"
        ? profileCatalogName(replicaId)
        : profileDatabaseName(
            kind === "local"
              ? "atlas.browsing.v2"
              : "atlas.browsing.cookies.v2",
            replicaId,
          ),
    db = await existing(factory, database),
    nextPhase =
      kind === "local" ? "cookies" : kind === "cookies" ? "atlas" : "done";
  if (!db) return { sources: [], next: { phase: nextPhase } };
  try {
    const store = kind === "local" ? "origins" : "meta";
    if (!db.objectStoreNames.contains(store))
      return { sources: [], next: { phase: nextPhase } };
    if (kind !== "idb") {
      const prefix: IDBValidKey[] = [LOCAL_DIRTY_V2_PREFIX, "control"],
        keys = await metadata(
          db,
          store,
          (t) =>
            request(
              t
                .objectStore(store)
                .getAllKeys(
                  cursor.after
                    ? IDBKeyRange.bound(
                        cursor.after,
                        [...prefix, []],
                        true,
                        false,
                      )
                    : IDBKeyRange.bound(prefix, [...prefix, []]),
                  pageSize,
                ),
            ),
          options,
        ),
        sources: BackupNativeSourceDescriptor[] = [];
      for (const key of keys) {
        const dirtyNamespace = String((key as IDBValidKey[])[2]),
          [type, scope] = JSON.parse(dirtyNamespace);
        if (type === kind && typeof scope === "string")
          sources.push({
            id: dirtyNamespace,
            namespace: {
              kind,
              origin: kind === "cookies" ? "https://" + scope : scope,
            },
            database,
            metadataStore: store,
            dirtyNamespace,
            kind,
            scope,
          });
      }
      return {
        sources,
        next:
          keys.length === pageSize
            ? { phase: kind, after: keys.at(-1) }
            : { phase: nextPhase },
      };
    }
    const result = await metadata(
      db,
      store,
      (t) =>
        new Promise<{
          visited: number;
          after?: IDBValidKey;
          sources: BackupNativeSourceDescriptor[];
        }>((res, rej) => {
          let visited = 0,
            after: IDBValidKey | undefined;
          const sources: BackupNativeSourceDescriptor[] = [],
            r = t
              .objectStore(store)
              .openCursor(
                cursor.after
                  ? IDBKeyRange.bound(
                      cursor.after,
                      ["database", []],
                      true,
                      false,
                    )
                  : IDBKeyRange.bound(["database"], ["database", []]),
              );
          r.onerror = () => rej(r.error);
          r.onsuccess = () => {
            const c = r.result;
            if (!c || visited >= pageSize) {
              res({ visited, after, sources });
              return;
            }
            if (options.foreground?.()) {
              t.abort();
              return;
            }
            visited++;
            after = c.primaryKey;
            const v = c.value;
            if (
              v &&
              typeof v.origin === "string" &&
              typeof v.name === "string"
            ) {
              const dirtyNamespace = JSON.stringify(["idb", v.origin, v.name]);
              if (v.deleted)
                sources.push({
                  id: dirtyNamespace,
                  namespace: { kind: "idb", origin: v.origin, name: v.name },
                  database,
                  metadataStore: store,
                  dirtyNamespace,
                  kind: "idb",
                  scope: v.name,
                });
              else if (
                !v.deleting &&
                typeof v.physical === "string" &&
                v.physical.startsWith(profileIDBPrefix(v.origin, replicaId))
              )
                sources.push({
                  id: dirtyNamespace,
                  namespace: { kind: "idb", origin: v.origin, name: v.name },
                  database: v.physical,
                  metadataStore: PROFILE_IDB_KEEP,
                  dirtyNamespace,
                  kind: "idb",
                  scope: v.name,
                });
            }
            c.continue();
          };
        }),
      options,
    );
    return {
      sources: result.sources,
      next:
        result.visited === pageSize
          ? { phase: "idb", after: result.after }
          : { phase: "done" },
    };
  } finally {
    db.close();
  }
}
/** Compatibility iterator for tooling. The production worker commits every
 * batch and its next cursor atomically into the separate backup spool. */
export async function* discoverBackupSourcePages(
  factory: IDBFactory,
  replicaId: string,
  pageSize = 64,
  options: BackupDiscoveryOptions = {},
): AsyncGenerator<BackupNativeSourceDescriptor[]> {
  let cursor: BackupDiscoveryCursor = { phase: "local" };
  while (cursor.phase !== "done") {
    const batch = await readBackupSourceBatch(
      factory,
      replicaId,
      cursor,
      options,
      pageSize,
    );
    cursor = batch.next;
    if (batch.sources.length) yield batch.sources;
    await new Promise((r) => setTimeout(r, 0));
  }
}
export async function discoverBackupSources(
  factory: IDBFactory,
  replicaId: string,
) {
  const all: BackupNativeSourceDescriptor[] = [];
  for await (const batch of discoverBackupSourcePages(factory, replicaId))
    all.push(...batch);
  return all;
}
