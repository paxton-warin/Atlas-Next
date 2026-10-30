/** Trusted logical-to-physical IDB directory. A fully committed replacement is
 * made visible by one catalog transaction; unfinished staging DBs are inert. */
import {
  checkedProfile,
  profileIDBPrefix,
  PROFILE_IDB_KEEP,
  PROFILE_OUTBOX_PREFIX,
  PROFILE_OUTBOX_BYTES,
  PROFILE_OUTBOX_SEQUENCE,
  PROFILE_OUTBOX_LIMIT,
  appendProfileJournal,
  type ProfileJournalEntry,
} from "./profile-journal.ts";
import { hubSiteGroup } from "./hub-contracts.ts";
import { withProfileGroupLock } from "./profile-locks.ts";
import {
  withQuotaLifecycle,
  removeQuotaDatabase,
} from "./profile-idb-quota.ts";
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
): Promise<string> {
  if (!id) return profileIDBPrefix(origin, id) + encodeURIComponent(name);
  const db = await openProfileCatalog(factory, id);
  try {
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite", { durability: "strict" }),
        store = tx.objectStore("meta"),
        r = store.get(profileDatabaseKey(origin, name));
      let physical = "";
      let error: unknown;
      r.onsuccess = () => {
        try {
          const prior = r.result as ProfileDatabase | undefined;
          if (prior?.deleting)
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
            { origin, name, physical },
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
function deleteNative(
  factory: IDBFactory,
  name: string,
  blocked?: (oldVersion: number, newVersion: number | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = factory.deleteDatabase(name);
    r.onblocked = (e) => blocked?.(e.oldVersion, e.newVersion);
    r.onsuccess = () => resolve();
    r.onerror = () =>
      reject(
        r.error,
      ); /* Native blocked/versionchange semantics deliberately remain pending. */
  });
}
async function copyOutbox(factory: IDBFactory, physical: string | null) {
  if (
    !physical ||
    !(await factory.databases()).some((x) => x.name === physical)
  )
    return {
      entries: [] as ProfileJournalEntry[],
      metadata: [] as Array<[IDBValidKey, unknown]>,
    };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(physical);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    if (!db.objectStoreNames.contains(PROFILE_IDB_KEEP))
      throw Error("PROFILE_IDB_LEDGER_MISSING");
    const tx = db.transaction(PROFILE_IDB_KEEP),
      done = catalogDone(tx),
      store = tx.objectStore(PROFILE_IDB_KEEP),
      [keys, values] = await Promise.all([
        catalogRequest(store.getAllKeys()),
        catalogRequest(store.getAll()),
      ]);
    await done;
    return {
      entries: values.filter(
        (v, i) =>
          typeof keys[i] === "string" &&
          String(keys[i]).startsWith(PROFILE_OUTBOX_PREFIX),
      ) as ProfileJournalEntry[],
      metadata: keys.flatMap((k, i) =>
        typeof k === "string" &&
        (k.startsWith("profile-cloud-head:") ||
          k.startsWith("profile-cloud-prepared:"))
          ? [[k, values[i]] as [IDBValidKey, unknown]]
          : [],
      ),
    };
  } finally {
    db.close();
  }
}
/** A committed intent contains any not-yet-uploaded old transactions before
 * native deletion starts. Recovery completes deletion and publishes its tombstone. */
export async function deleteProfileIDBDatabase(
  factory: IDBFactory,
  id: string,
  origin: string,
  name: string,
  blocked?: (oldVersion: number, newVersion: number | null) => void,
): Promise<void> {
  const run = () =>
    withQuotaLifecycle(profileIDBPrefix(origin, id), () =>
      deleteProfileIDBDatabaseUnlocked(factory, id, origin, name, blocked),
    );
  return withProfileGroupLock(id, hubSiteGroup(origin), run);
}
async function deleteProfileIDBDatabaseUnlocked(
  factory: IDBFactory,
  id: string,
  origin: string,
  name: string,
  blocked?: (oldVersion: number, newVersion: number | null) => void,
): Promise<void> {
  const records = await listProfileIDBDatabases(factory, id),
    prior = records.find((r) => r.origin === origin && r.name === name);
  if (prior?.deleted && !prior.deleting) {
    await removeQuotaDatabase(factory, profileIDBPrefix(origin, id), name);
    return;
  }
  if (prior?.deleting) {
    if (prior.physical) await deleteNative(factory, prior.physical, blocked);
    const db = await openProfileCatalog(factory, id);
    try {
      await finishDelete(db, id, origin, name);
    } finally {
      db.close();
    }
    await removeQuotaDatabase(factory, profileIDBPrefix(origin, id), name);
    return;
  }
  const physical =
      prior?.physical ||
      profileIDBPrefix(origin, id) + encodeURIComponent(name),
    saved = await copyOutbox(factory, physical),
    db = await openProfileCatalog(factory, id);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite", { durability: "strict" }),
        store = tx.objectStore("meta"),
        a = store.get(PROFILE_OUTBOX_BYTES),
        b = store.get(PROFILE_OUTBOX_SEQUENCE);
      b.onsuccess = () => {
        let bytes = Number(a.result || 0),
          seq = Number(b.result || 0);
        for (const e of saved.entries.sort((x, y) => x.sequence - y.sequence)) {
          store.put({ ...e, sequence: ++seq }, PROFILE_OUTBOX_PREFIX + e.id);
          bytes += e.bytes;
        }
        if (bytes > PROFILE_OUTBOX_LIMIT - 128) {
          tx.abort();
          return;
        }
        for (const [k, v] of saved.metadata) {
          if (typeof k === "string" && k.startsWith("profile-cloud-head:")) {
            const current = store.get(k);
            current.onsuccess = () => {
              if (
                !current.result ||
                current.result.revision < (v as { revision: number }).revision
              )
                store.put(v, k);
            };
          } else store.put(v, k);
        }
        store.put(bytes, PROFILE_OUTBOX_BYTES);
        store.put(seq, PROFILE_OUTBOX_SEQUENCE);
        store.put(
          { origin, name, physical, deleting: true },
          profileDatabaseKey(origin, name),
        );
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    await deleteNative(factory, physical, blocked);
    await finishDelete(db, id, origin, name);
    await removeQuotaDatabase(factory, profileIDBPrefix(origin, id), name);
  } finally {
    db.close();
  }
}
function finishDelete(
  db: IDBDatabase,
  id: string,
  origin: string,
  name: string,
) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite", { durability: "strict" }),
      store = tx.objectStore("meta"),
      r = store.get(profileDatabaseKey(origin, name));
    r.onsuccess = () => {
      if (!r.result?.deleting) return;
      appendProfileJournal(store, {
        profileId: id,
        kind: "idb",
        origin,
        name,
        payload: { format: "atlas-idb-delete-v1", deleted: true, version: 0 },
        bytes: 128,
      });
      store.put(
        { origin, name, physical: null, deleted: true },
        profileDatabaseKey(origin, name),
      );
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
// Discovery must never await a native delete: an open website can keep its
// versionchange/blocked phase pending indefinitely. Each interrupted intent is
// retried independently under the same site protocol as live deletes/drains.
const deleteRecoveries = new WeakMap<IDBFactory, Map<string, Promise<void>>>();
function recoveryFor(factory: IDBFactory, id: string, record: ProfileDatabase): Promise<void> {
  let pending = deleteRecoveries.get(factory);
  if (!pending) { pending = new Map(); deleteRecoveries.set(factory, pending); }
  const key = JSON.stringify([id, record.origin, record.name, record.physical]);
  const prior = pending.get(key);
  if (prior) return prior;
  const flight = withProfileGroupLock(id, hubSiteGroup(record.origin), () =>
    withQuotaLifecycle(profileIDBPrefix(record.origin, id), async () => {
      // A queued retry must not delete a newer generation reopened after the
      // original intent completed while it was waiting for this site's lock.
      const current = (await listProfileIDBDatabases(factory, id)).find(r =>
        r.origin === record.origin && r.name === record.name);
      if (!current?.deleting || current.physical !== record.physical) return;
      await deleteProfileIDBDatabaseUnlocked(factory, id, record.origin, record.name);
    }),
  ).finally(() => { if (pending!.get(key) === flight) pending!.delete(key); });
  pending.set(key, flight);
  return flight;
}
/** Schedule, but do not join, native recovery. The committed intent and copied
 * journals remain durable/discoverable until actual deletion publishes its ACK. */
export function scheduleProfileDeleteRecovery(
  factory: IDBFactory,
  id: string,
  records: readonly ProfileDatabase[],
): void {
  for (const record of records)
    if (record.deleting) void recoveryFor(factory, id, record).catch(() => {
      // Retain the intent for the next discovery/retry; never invent a tombstone.
    });
}
export async function recoverProfileDeletes(
  factory: IDBFactory,
  id: string,
  siteGroup?: string,
): Promise<void> {
  const records = await listProfileIDBDatabases(factory, id);
  await Promise.all(records.filter(r => r.deleting &&
    (siteGroup === undefined || hubSiteGroup(r.origin) === siteGroup))
    .map(r => recoveryFor(factory, id, r)));
}
export async function activateProfileIDBDatabase(
  factory: IDBFactory,
  id: string,
  record: ProfileDatabase,
  head?: { revision: number; epoch: number },
): Promise<void> {
  const db = await openProfileCatalog(factory, id);
  try {
    const tx = db.transaction("meta", "readwrite", { durability: "strict" }),
      done = catalogDone(tx),
      store = tx.objectStore("meta");
    store.put(record, profileDatabaseKey(record.origin, record.name));
    if (head) {
      store.put(
        head,
        "profile-cloud-head:" + profileStreamKey(record.origin, record.name),
      );
      store.delete("profile-cloud-compaction:" + profileStreamKey(record.origin, record.name));
    }
    await done;
  } finally {
    db.close();
  }
}
