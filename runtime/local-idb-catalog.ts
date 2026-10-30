/** Isolated replica catalog: only native local directory operations. */
import { checkedProfile, profileIDBPrefix } from "./local-storage-names.ts";
import { appendLocalDirty } from "./local-dirty-v2.ts";
export type ProfileDatabase = {
  origin: string;
  name: string;
  physical: string | null;
  deleted?: boolean;
  deleting?: boolean;
};
export const profileCatalogName = (id: string) => {
  checkedProfile(id);
  return "atlas.browsing.profile-catalog.v1:profile:" + id;
};
export const profileDatabaseKey = (
  origin: string,
  name: string,
): IDBValidKey => ["database", origin, name];
export const profileStreamKey = (origin: string, name: string) =>
  JSON.stringify(["idb", origin, name]);
export const catalogRequest = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
export const catalogDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ||
          new DOMException("Profile transaction aborted", "AbortError"),
      );
    tx.onerror = () => {};
  });
export function openProfileCatalog(
  factory: IDBFactory,
  id: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(profileCatalogName(id), 1);
    r.onupgradeneeded = () => r.result.createObjectStore("meta");
    r.onerror = () => reject(r.error);
    r.onblocked = () =>
      reject(
        new DOMException("Profile catalog is blocked", "InvalidStateError"),
      );
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
export async function listProfileIDBDatabases(
  factory: IDBFactory,
  id: string | null,
): Promise<ProfileDatabase[]> {
  checkedProfile(id);
  const all = await factory.databases(),
    result: ProfileDatabase[] = [];
  if (id) {
    const db = await openProfileCatalog(factory, id);
    try {
      const tx = db.transaction("meta"),
        done = catalogDone(tx),
        rows = await catalogRequest(tx.objectStore("meta").getAll());
      await done;
      for (const row of rows)
        if (
          row &&
          typeof row.origin === "string" &&
          typeof row.name === "string" &&
          Object.hasOwn(row, "physical")
        )
          result.push(row);
    } finally {
      db.close();
    }
  }
  const marker = "atlas.browsing.idb.v2:" + (id ? "profile:" + id + ":" : "");
  for (const item of all) {
    const physical = item.name || "";
    if (
      !physical.startsWith(marker) ||
      (!id && physical.startsWith(marker + "profile:"))
    )
      continue;
    const tail = physical.slice(marker.length),
      split = tail.indexOf(":");
    if (split < 0) continue;
    const o = tail.slice(0, split),
      n = tail.slice(split + 1);
    if (
      n === "#quota" ||
      n.includes("#:restore:") ||
      n.includes("#:generation:")
    )
      continue;
    try {
      const origin = decodeURIComponent(o),
        name = decodeURIComponent(n);
      if (new URL(origin).origin !== origin) continue;
      if (!result.some((r) => r.origin === origin && r.name === name))
        result.push({ origin, name, physical });
    } catch {}
  }
  return result;
}
export async function resolveProfileIDBDatabase(
  factory: IDBFactory,
  id: string | null | undefined,
  origin: string,
  name: string,
  allowDeleting = false,
): Promise<string> {
  if (!id) return profileIDBPrefix(origin, id) + encodeURIComponent(name);
  const db = await openProfileCatalog(factory, id);
  try {
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite", { durability: "default" }),
        store = tx.objectStore("meta"),
        r = store.get(profileDatabaseKey(origin, name));
      let physical = "";
      let error: unknown;
      r.onsuccess = () => {
        try {
          const prior = r.result as ProfileDatabase | undefined;
          if (prior?.deleting && !allowDeleting)
            throw new DOMException(
              "Interrupted database deletion requires recovery",
              "InvalidStateError",
            );
          physical =
            prior?.physical ||
            profileIDBPrefix(origin, id) +
              encodeURIComponent(name) +
              (prior?.deleted ? "#:generation:" + crypto.randomUUID() : "");
          store.put(
            {
              origin,
              name,
              physical,
              ...(prior?.deleting ? { deleting: true } : {}),
            },
            profileDatabaseKey(origin, name),
          );
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(physical);
      tx.onabort = () => reject(error || tx.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteLocalIDBDatabase(
  factory: IDBFactory,
  replicaId: string,
  origin: string,
  name: string,
  blocked?: (oldVersion: number, newVersion: number | null) => void,
) {
  const physical = await resolveProfileIDBDatabase(
      factory,
      replicaId,
      origin,
      name,
      true,
    ),
    db = await openProfileCatalog(factory, replicaId);
  try {
    let tx = db.transaction("meta", "readwrite"),
      done = catalogDone(tx);
    tx.objectStore("meta").put(
      { origin, name, physical, deleting: true },
      profileDatabaseKey(origin, name),
    );
    await done;
    await new Promise<void>((resolve, reject) => {
      const r = factory.deleteDatabase(physical);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      r.onblocked = (e) => blocked?.(e.oldVersion, e.newVersion);
    });
    tx = db.transaction("meta", "readwrite");
    done = catalogDone(tx);
    const store = tx.objectStore("meta");
    store.put(
      { origin, name, physical: null, deleted: true },
      profileDatabaseKey(origin, name),
    );
    appendLocalDirty(store, {
      namespace: JSON.stringify(["idb", origin, name]),
      operation: "database-delete",
    });
    await done;
  } finally {
    db.close();
  }
}
