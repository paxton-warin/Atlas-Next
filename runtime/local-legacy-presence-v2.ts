/** Metadata-only startup guard. Merely opening a quota/catalog/cookie database
 * must not turn an empty device into a local-data device and skip cloud restore.
 * Unknown nonempty sources remain protected; this helper never reads values. */
import { checkedProfile } from "./local-storage-names.ts";

export type LegacyLocalPresence = {
  present: boolean;
  uncertain?: boolean;
  reason?: string;
  inspectedDatabases: number;
};
const KEEP = "__atlas_idb_keepalive_v2__",
  MAX_DATABASES = 128,
  MAX_META_KEYS = 64;
const counters = new Set([
  "revision",
  "profile-outbox-bytes",
  "profile-outbox-sequence",
  "local-cookie-migration-size-v2",
  "local-usage-v2",
  "usage",
]);
function bookkeeping(key: IDBValidKey): boolean {
  if (typeof key === "string") return counters.has(key);
  return (
    Array.isArray(key) &&
    [
      "outbox-bytes",
      "outbox-sequence",
      "local-migration-size-v2",
      "local-cookie-size-v2",
    ].includes(String(key[0]))
  );
}
async function existing(factory: IDBFactory, name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name);
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      reject(new Error("LEGACY_DATABASE_OPEN_TIMEOUT"));
    }, 1000);
    r.onupgradeneeded = () => r.transaction!.abort();
    r.onerror = () => {
      failed = true;
      clearTimeout(timer);
      reject(r.error);
    };
    r.onblocked = () => {
      failed = true;
      clearTimeout(timer);
      reject(new Error("LEGACY_DATABASE_OPEN_BLOCKED"));
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      if (failed) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
async function containsKeys(
  db: IDBDatabase,
  names: string[],
  filter = false,
): Promise<{ present: boolean; uncertain?: boolean }> {
  if (!names.length) return { present: false };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names),
      timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {}
      }, 1000);
    let present = false,
      uncertain = false;
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve({ present, uncertain });
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error || new Error("LEGACY_METADATA_READ_ABORTED"));
    };
    tx.onerror = () => {};
    for (const name of names) {
      const store = tx.objectStore(name);
      if (!filter) {
        const r = store.count();
        r.onsuccess = () => {
          if (r.result > 0) present = true;
        };
      } else {
        let seen = 0;
        const r = store.openKeyCursor();
        r.onsuccess = () => {
          const row = r.result;
          if (!row || present) return;
          if (!bookkeeping(row.primaryKey)) {
            present = true;
            return;
          }
          if (++seen >= MAX_META_KEYS) {
            present = true;
            uncertain = true;
            return;
          }
          row.continue();
        };
      }
    }
  });
}
export async function inspectLegacyLocalPresence(
  factory: IDBFactory,
  profileId: string,
): Promise<LegacyLocalPresence> {
  checkedProfile(profileId);
  const suffix = ":profile:" + profileId,
    nativePrefix = "atlas.browsing.idb.v2:profile:" + profileId + ":";
  let inspectedDatabases = 0;
  try {
    const scoped = (await factory.databases())
      .map((d) => d.name)
      .filter(
        (name): name is string =>
          !!name && (name.endsWith(suffix) || name.startsWith(nativePrefix)),
      )
      .filter(
        (name) => !(name.startsWith(nativePrefix) && name.endsWith(":#quota")),
      );
    if (scoped.length > MAX_DATABASES)
      return {
        present: true,
        uncertain: true,
        reason: "legacy_presence_database_budget",
        inspectedDatabases,
      };
    for (const name of scoped) {
      const db = await existing(factory, name);
      inspectedDatabases++;
      try {
        const stores = [...db.objectStoreNames];
        if (name.startsWith(nativePrefix)) {
          // Even an empty native user store has schema/key-generator state.
          if (stores.some((store) => store !== KEEP))
            return {
              present: true,
              reason: "legacy_native_schema",
              inspectedDatabases,
            };
          const state = await containsKeys(db, stores, true);
          if (state.present)
            return {
              ...state,
              reason: "legacy_native_metadata",
              inspectedDatabases,
            };
        } else if (name === "atlas.browsing.cookies.v2" + suffix) {
          const cookies = stores.includes("cookies")
            ? await containsKeys(db, ["cookies"])
            : { present: false };
          if (cookies.present)
            return {
              present: true,
              reason: "legacy_cookie_keys",
              inspectedDatabases,
            };
          const state = await containsKeys(
            db,
            stores.filter((s) => s !== "cookies"),
            true,
          );
          if (state.present)
            return {
              ...state,
              reason: "legacy_cookie_pending_metadata",
              inspectedDatabases,
            };
        } else if (
          name === "atlas.browsing.v2" + suffix ||
          name === "atlas.browsing.profile-catalog.v1" + suffix
        ) {
          const state = await containsKeys(db, stores, true);
          if (state.present)
            return {
              ...state,
              reason: "legacy_origin_catalog_or_pending_keys",
              inspectedDatabases,
            };
        } else {
          const state = await containsKeys(db, stores);
          if (state.present)
            return {
              present: true,
              uncertain: true,
              reason: "legacy_unknown_nonempty_source",
              inspectedDatabases,
            };
        }
      } finally {
        db.close();
      }
    }
    return { present: false, inspectedDatabases };
  } catch {
    return {
      present: true,
      uncertain: true,
      reason: "legacy_presence_inspection_unavailable",
      inspectedDatabases,
    };
  }
}
