/** Atlas-owned preferences use a bounded local mirror. UI native writes finish
 * first; this mirror and its cloud backup are never storage prerequisites. */
import { appendLocalDirty } from "./local-dirty-v2.ts";
import { profileDatabaseName } from "./profile-journal.ts";
export const ATLAS_BACKUP_NAMESPACE = JSON.stringify(["atlas", "", ""]);
export const atlasBackupDatabase = (replicaId: string) =>
  profileDatabaseName("atlas.backup.preferences.v2", replicaId);
const validPreferenceKey = (key: unknown): key is string =>
  typeof key === "string" && /^atlas\.[A-Za-z0-9_.-]{1,256}$/.test(key);
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function openPreferences(factory: IDBFactory, replicaId: string) {
  const r = factory.open(atlasBackupDatabase(replicaId), 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("meta");
    r.result.createObjectStore("preferences");
  };
  return request(r);
}
export type BackupPreferenceCursor = {
  phase: "values" | "deferred";
  after?: string;
};
/** Keys only, so canonical window storage can reconcile deletions after restart
 * without exporting mirrored values or walking an unbounded native result. */
export async function readBackupPreferenceKeys(
  factory: IDBFactory,
  replicaId: string,
  cursor?: BackupPreferenceCursor,
) {
  if (
    cursor &&
    (!["values", "deferred"].includes(cursor.phase) ||
      (cursor.after !== undefined && !validPreferenceKey(cursor.after)))
  )
    throw Error("BACKUP_PREFERENCES_CURSOR_INVALID");
  const db = await openPreferences(factory, replicaId);
  try {
    const t = db.transaction(["preferences", "meta"]),
      done = new Promise<void>((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onabort = () =>
          reject(t.error || Error("BACKUP_PREFERENCES_ABORTED"));
      });
    void done.catch(() => {});
    const keys: string[] = [];
    let nextCursor: BackupPreferenceCursor | undefined;
    if (!cursor || cursor.phase === "values") {
      const rows = await request(
        t
          .objectStore("preferences")
          .getAllKeys(
            cursor?.after
              ? IDBKeyRange.lowerBound(cursor.after, true)
              : undefined,
            65,
          ),
      );
      for (const key of rows.slice(0, 64)) {
        if (!validPreferenceKey(key))
          throw Error("BACKUP_PREFERENCE_KEY_INVALID");
        keys.push(key);
      }
      if (rows.length > 64)
        nextCursor = { phase: "values", after: keys.at(-1)! };
    }
    if (!nextCursor) {
      const remaining = 64 - keys.length;
      if (!remaining) nextCursor = { phase: "deferred" };
      else {
        const after = cursor?.phase === "deferred" ? cursor.after : undefined;
        const rows = await request(
          t
            .objectStore("meta")
            .getAllKeys(
              IDBKeyRange.bound(
                after ? ["atlas-deferred", after] : ["atlas-deferred"],
                ["atlas-deferred", []],
                !!after,
              ),
              remaining + 1,
            ),
        );
        for (const key of rows.slice(0, remaining)) {
          if (
            !Array.isArray(key) ||
            key.length !== 2 ||
            !validPreferenceKey(key[1])
          )
            throw Error("BACKUP_PREFERENCE_KEY_INVALID");
          keys.push(key[1]);
        }
        if (rows.length > remaining)
          nextCursor = { phase: "deferred", after: keys.at(-1)! };
      }
    }
    await done;
    return { keys, ...(nextCursor ? { nextCursor } : {}) };
  } finally {
    db.close();
  }
}
export async function writeBackupPreferences(
  factory: IDBFactory,
  replicaId: string,
  values: Record<string, string | null>,
  deferred: Array<{ key: string; estimatedNativeBytes: number }> = [],
) {
  const keys = Object.keys(values);
  if (keys.length + deferred.length > 64)
    throw Error("BACKUP_PREFERENCES_BATCH_INVALID");
  const db = await openPreferences(factory, replicaId);
  let changed = false;
  try {
    await new Promise<void>((res, rej) => {
      const t = db.transaction(["meta", "preferences"], "readwrite"),
        meta = t.objectStore("meta"),
        store = t.objectStore("preferences");
      t.oncomplete = () => res();
      t.onabort = () => rej(t.error || Error("BACKUP_PREFERENCES_ABORTED"));
      const process = async () => {
        for (const key of keys) {
          const value = values[key];
          if (
            !/^atlas\.[A-Za-z0-9_.-]{1,256}$/.test(key) ||
            (typeof value !== "string" && value !== null) ||
            (value !== null && value.length * 2 > 256 * 1024)
          ) {
            t.abort();
            return;
          }
          const previous = await request(store.get(key)),
            priorDeferred = await request(meta.get(["atlas-deferred", key]));
          if (
            (value === null ? previous === undefined : previous === value) &&
            priorDeferred === undefined
          )
            continue;
          changed = true;
          meta.delete(["atlas-deferred", key]);
          value === null ? store.delete(key) : store.put(value, key);
          appendLocalDirty(meta, {
            namespace: ATLAS_BACKUP_NAMESPACE,
            key,
            operation: value === null ? "delete" : "upsert",
            estimatedNativeBytes:
              value === null ? 0 : 64 + 2 * (key.length + value.length),
            shapeEligible: true,
          });
        }
        for (const item of deferred) {
          if (
            !/^atlas\.[A-Za-z0-9_.-]{1,256}$/.test(item.key) ||
            !Number.isSafeInteger(item.estimatedNativeBytes) ||
            item.estimatedNativeBytes < 0
          ) {
            t.abort();
            return;
          }
          const prior = await request(meta.get(["atlas-deferred", item.key]));
          if (prior?.estimatedNativeBytes === item.estimatedNativeBytes)
            continue;
          changed = true;
          meta.put({ estimatedNativeBytes: item.estimatedNativeBytes }, [
            "atlas-deferred",
            item.key,
          ]);
          appendLocalDirty(meta, {
            namespace: ATLAS_BACKUP_NAMESPACE,
            key: item.key,
            operation: "upsert",
            estimatedNativeBytes: item.estimatedNativeBytes,
            shapeEligible: false,
          });
        }
      };
      void process().catch((error) => {
        try {
          t.abort();
        } catch {}
        rej(error);
      });
    });
  } finally {
    db.close();
  }
  return changed;
}
