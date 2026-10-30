/** Trusted portable native-store adapter. Callers quiesce website writers before
 * export/restore. Each stream replacement commits completely before publication;
 * IDB publication uses an atomic catalog pointer, never delete-then-overwrite. */
import {
  hubNamespace,
  hubSiteGroup,
  type HubNamespace,
} from "./hub-contracts.ts";
import {
  profileDatabaseName,
  profileIDBPrefix,
  PROFILE_IDB_KEEP,
  PROFILE_OUTBOX_PREFIX,
  appendProfileJournal,
} from "./profile-journal.ts";
import {
  activateProfileIDBDatabase,
  catalogDone as complete,
  catalogRequest as request,
  listProfileIDBDatabases,
  scheduleProfileDeleteRecovery,
  openProfileCatalog,
  deleteProfileIDBDatabase,
} from "./profile-idb-catalog.ts";
import {
  assertProfileWrite,
  assertProfileWriteCached,
} from "./profile-permissions.ts";
import { parse as parseDomain } from "tldts";
import { boundedIDBValueBytes, SANDBOX_IDB_LIMITS } from "./sandbox-idb.ts";
import {
  withQuotaLifecycle,
  reconcileQuotaSources,
  readQuotaUsage,
  reserveQuotaReplacement,
  finishQuotaCommit,
  removeQuotaDatabase,
  reconcileQuotaSource,
} from "./profile-idb-quota.ts";
export type LocalProfileSnapshot = {
  format: "atlas-local-snapshot-v1";
  revision: number;
  entries: Array<[string, string]>;
};
export type ProfileIndex = {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
};
export type ProfileStore = {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: ProfileIndex[];
  records: Array<{ key: IDBValidKey; value: unknown }>;
  generator: { next: number } | { exhausted: true } | null;
};
export type IDBProfileSnapshot = {
  format: "atlas-idb-snapshot-v1";
  version: number;
  stores: ProfileStore[];
  deleted?: boolean;
};
export type CookieProfileSnapshot = {
  format: "atlas-cookie-snapshot-v1";
  revision: number;
  cookies: Array<Record<string, any>>;
};
export type ProfileSnapshot = {
  namespace: HubNamespace;
  payload: LocalProfileSnapshot | IDBProfileSnapshot | CookieProfileSnapshot;
};
export type LegacyHostStorage = {
  host: string;
  entries: Array<[string, string]>;
  candidateOrigins: string[];
};
export type LegacyCookieStore = ProfileSnapshot & {
  database: "__runtimekit_controller" | "__scramjet_controller";
};
type Journal = { revision: number; mode?: string; payload: any };
const clone = <T>(v: T): T => structuredClone(v);
const exactOrigin = (v: unknown) => {
  if (typeof v !== "string") throw Error("PROFILE_ORIGIN_INVALID");
  const u = new URL(v);
  if (
    !/^https?:$/.test(u.protocol) ||
    u.origin !== v ||
    u.username ||
    u.password
  )
    throw Error("PROFILE_ORIGIN_INVALID");
  return v;
};
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name);
    r.onupgradeneeded = () => {
      r.transaction?.abort();
      reject(Error("PROFILE_DATABASE_MISSING"));
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error("PROFILE_DATABASE_BLOCKED"));
    r.onsuccess = () => resolve(r.result);
  });
}
function openCommon(
  factory: IDBFactory,
  name: string,
  kind: "local" | "cookies",
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      if (kind === "local") r.result.createObjectStore("origins");
      else {
        r.result.createObjectStore("cookies", { keyPath: "id" });
        r.result.createObjectStore("meta");
      }
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error("PROFILE_DATABASE_BLOCKED"));
    r.onsuccess = () => resolve(r.result);
  });
}
async function generatorHeads(db: IDBDatabase, stores: ProfileStore[]) {
  const autos = stores.filter((s) => s.autoIncrement);
  if (!autos.length) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
        autos.map((s) => s.name),
        "readwrite",
      ),
      heads = new Map<string, number | null>();
    let expected = false,
      error: unknown;
    let left = autos.length;
    const next = () => {
      if (--left) return;
      expected = true;
      tx.abort();
    };
    for (const s of autos) {
      let r: IDBRequest;
      try {
        r = tx.objectStore(s.name).add(s.keyPath === null ? null : {});
      } catch (e) {
        error = e;
        tx.abort();
        break;
      }
      r.onsuccess = () => {
        heads.set(s.name, Number(r.result));
        next();
      };
      r.onerror = (e) => {
        if (r.error?.name === "ConstraintError") {
          e.preventDefault();
          e.stopPropagation();
          heads.set(s.name, null);
          next();
        } else {
          error = r.error;
          tx.abort();
        }
      };
    }
    tx.onabort = () => {
      if (!expected) {
        reject(error || tx.error);
        return;
      }
      for (const s of autos) {
        const value = heads.get(s.name);
        s.generator = value === null ? { exhausted: true } : { next: value! };
      }
      resolve();
    };
    tx.oncomplete = () => reject(Error("PROFILE_GENERATOR_PROBE_COMMITTED"));
  });
}
async function exportIDB(
  factory: IDBFactory,
  physical: string,
): Promise<IDBProfileSnapshot> {
  const db = await openExisting(factory, physical);
  try {
    const names = [...db.objectStoreNames].filter(
        (n) => n !== PROFILE_IDB_KEEP,
      ),
      stores: ProfileStore[] = [];
    if (names.length) {
      const tx = db.transaction(names, "readonly"),
        done = complete(tx);
      for (const name of names) {
        const s = tx.objectStore(name),
          indexes = [...s.indexNames].map((n) => {
            const i = s.index(n);
            return {
              name: n,
              keyPath: i.keyPath,
              unique: i.unique,
              multiEntry: i.multiEntry,
            };
          }),
          keys = request(s.getAllKeys()),
          values = request(s.getAll());
        const target: ProfileStore = {
          name,
          keyPath: s.keyPath,
          autoIncrement: s.autoIncrement,
          indexes,
          records: [],
          generator: null,
        };
        stores.push(target);
        void Promise.all([keys, values]).then(([k, v]) => {
          target.records = k.map((key, i) => ({ key, value: v[i] }));
        });
      }
      await done;
    }
    await generatorHeads(db, stores);
    return { format: "atlas-idb-snapshot-v1", version: db.version, stores };
  } finally {
    db.close();
  }
}
export async function exportProfileSnapshots(
  factory: IDBFactory,
  profileId: string | null,
  legacy?: { originHints?: Iterable<string>; hostStorage?: LegacyHostStorage[]; cookieStores?: LegacyCookieStore[] },
  siteGroup?: string,
): Promise<ProfileSnapshot[]> {
  if (siteGroup !== undefined && (!profileId || hubSiteGroup("https://" + siteGroup) !== siteGroup))
    throw Error("PROFILE_EXPORT_GROUP_INVALID");
  const selected = (origin: string) => siteGroup === undefined || hubSiteGroup(origin) === siteGroup;
  // Do not wait behind another site's blocked native deletion during a scoped
  // export. Selected unfinished intents stay explicit below, never fake data.
  if (profileId) scheduleProfileDeleteRecovery(factory, profileId,
    (await listProfileIDBDatabases(factory, profileId)).filter(r => selected(r.origin)));
  const result: ProfileSnapshot[] = [],
    all = await factory.databases(),
    localName = profileDatabaseName("atlas.browsing.v2", profileId),
    cookieName = profileDatabaseName("atlas.browsing.cookies.v2", profileId);
  if (all.some((d) => d.name === localName)) {
    const db = await openExisting(factory, localName);
    try {
      const tx = db.transaction("origins"),
        done = complete(tx),
        s = tx.objectStore("origins"),
        keys = await request(s.getAllKeys()),
        values = await Promise.all(keys.map(key => {
          if (typeof key !== "string") return undefined;
          if (siteGroup !== undefined) {
            try { if (!selected(exactOrigin(key))) return undefined; }
            catch (error) { if (key.startsWith("http")) throw error; return undefined; }
          }
          return request(s.get(key));
        }));
      await done;
      for (let i = 0; i < keys.length; i++)
        if (typeof keys[i] === "string") {
          try {
            const origin = exactOrigin(keys[i]),
              v = values[i];
            if (!selected(origin)) continue;
            if (
              !Array.isArray(v?.entries) ||
              v.entries.some(
                (e: any) =>
                  !Array.isArray(e) ||
                  e.length !== 2 ||
                  e.some((x: any) => typeof x !== "string"),
              )
            )
              throw Error("PROFILE_LOCAL_CORRUPT");
            result.push({
              namespace: { kind: "local", origin },
              payload: {
                format: "atlas-local-snapshot-v1",
                revision: v.revision || 0,
                entries: clone(v.entries),
              },
            });
          } catch (e) {
            if (String(keys[i]).startsWith("http")) throw e;
          }
        }
    } finally {
      db.close();
    }
  }
  if (all.some((d) => d.name === cookieName)) {
    const db = await openExisting(factory, cookieName);
    try {
      const tx = db.transaction(["cookies", "meta"]),
        done = complete(tx),
        cookies = request(tx.objectStore("cookies").getAll()),
        revision = request(tx.objectStore("meta").get("revision")),
        [rows, rev] = await Promise.all([cookies, revision]);
      await done;
      const groups = new Map<string, Array<Record<string, any>>>();
      for (const cookie of rows) {
        if (cookie.expires !== null && cookie.expires <= Date.now()) continue;
        const group = hubSiteGroup("https://" + cookie.domain),
          g = groups.get(group) || [];
        if (siteGroup !== undefined && siteGroup !== group) continue;
        g.push(clone(cookie));
        groups.set(group, g);
      }
      for (const [group, cookies] of groups)
        result.push({
          namespace: { kind: "cookies", origin: "https://" + group },
          payload: {
            format: "atlas-cookie-snapshot-v1",
            revision: rev || 0,
            cookies,
          },
        });
    } finally {
      db.close();
    }
  }
  for (const db of await listProfileIDBDatabases(factory, profileId)) {
    if (!selected(db.origin)) continue;
    if (db.deleting) throw Error("PROFILE_DELETE_RECOVERY_REQUIRED");
    const namespace: HubNamespace = {
      kind: "idb",
      origin: db.origin,
      name: db.name,
    };
    result.push({
      namespace,
      payload: db.deleted
        ? {
            format: "atlas-idb-snapshot-v1",
            version: 0,
            stores: [],
            deleted: true,
          }
        : await exportIDB(factory, db.physical!),
    });
  }
  if (profileId === null) await exportLegacyNative(factory, all, result, legacy);
  return result;
}
/** The normal pinned Scramjet controller used HOST@key for localStorage but
 * ORIGIN@database for IDB. A host does not tell us HTTP versus HTTPS. Resolve it
 * only using recorded exact origins; preserve the raw representation separately
 * even when a match exists, so merged legacy adapters cannot hide a second save.
 */
export async function exportLegacyProfileData(factory: IDBFactory, originHints: Iterable<string> = []) {
  const hostStorage: LegacyHostStorage[] = [];
  const cookieStores: LegacyCookieStore[] = [];
  const snapshots = await exportProfileSnapshots(factory, null, { originHints, hostStorage, cookieStores });
  return { snapshots, hostStorage, cookieStores };
}
export function readLegacyHostStorage(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  originHints: Iterable<string>,
  frontendHost = globalThis.location?.host,
): LegacyHostStorage[] {
  const origins = new Map<string, Set<string>>();
  for (const raw of originHints) {
    try {
      const origin = exactOrigin(raw), host = new URL(origin).host;
      const known = origins.get(host) || new Set<string>();
      known.add(origin); origins.set(host, known);
    } catch { /* Invalid metadata never authorizes an origin guess. */ }
  }
  const values = new Map<string, Array<[string, string]>>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    const at = key.indexOf("@");
    if (at < 1) continue;
    const host = key.slice(0, at);
    if (host === frontendHost || /[\s/\\?#@]/.test(host)) continue;
    // Reject arbitrary frontend identifiers; exact host normalization is the
    // actual pinned vendor format, including explicit non-default ports.
    const recognizedHost = ["http:", "https:"].some(protocol => {
      try { const u = new URL(protocol + "//" + host); return u.host === host && !u.username && !u.password && (u.hostname.includes(".") || u.hostname === "localhost" || u.hostname.startsWith("[")); }
      catch { return false; }
    });
    if (!recognizedHost) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    values.set(host, [...(values.get(host) || []), [key.slice(at + 1), value]]);
  }
  return [...values].map(([host, entries]) => ({ host, entries, candidateOrigins: [...(origins.get(host) || [])].sort() }));
}
/** Only the pinned adapter's exact origin prefixes and explicit cookie record
 * qualify as legacy website data. Native frontend credentials are never read. */
async function exportLegacyNative(
  factory: IDBFactory,
  all: IDBDatabaseInfo[],
  result: ProfileSnapshot[],
  options?: { originHints?: Iterable<string>; hostStorage?: LegacyHostStorage[]; cookieStores?: LegacyCookieStore[] },
) {
  if (typeof localStorage !== "undefined") {
    const legacy = new Map<string, Map<string, string>>();
    const originHints = [...(options?.originHints || [])];
    for (const db of all) {
      const name = db.name || "", at = name.indexOf("@");
      if (at < 0) continue;
      try { originHints.push(exactOrigin(name.slice(0, at))); } catch { /* Not a legacy website IDB namespace. */ }
    }
    const hostStorage = readLegacyHostStorage(localStorage, originHints);
    options?.hostStorage?.push(...hostStorage);
    for (const item of hostStorage) {
      if (item.candidateOrigins.length !== 1) continue; // No scheme guesses.
      legacy.set(item.candidateOrigins[0], new Map(item.entries));
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const at = key.indexOf("@");
      if (at < 0) continue;
      try {
        const origin = exactOrigin(key.slice(0, at)),
          value = localStorage.getItem(key);
        if (value === null) continue;
        const values = legacy.get(origin) || new Map();
        values.set(key.slice(at + 1), value);
        legacy.set(origin, values);
      } catch {}
    }
    for (const [origin, entries] of legacy) {
      const existing = result.find(
        (e) => e.namespace.kind === "local" && e.namespace.origin === origin,
      );
      if (existing) {
        for (const [k, v] of (existing.payload as LocalProfileSnapshot).entries)
          entries.set(k, v);
        (existing.payload as LocalProfileSnapshot).entries = [...entries];
      } else
        result.push({
          namespace: { kind: "local", origin },
          payload: {
            format: "atlas-local-snapshot-v1",
            revision: 0,
            entries: [...entries],
          },
        });
    }
  }
  for (const db of all) {
    const name = db.name || "",
      at = name.indexOf("@");
    if (at < 0) continue;
    try {
      const origin = exactOrigin(name.slice(0, at)),
        logical = name.slice(at + 1);
      if (
        !result.some(
          (e) =>
            e.namespace.kind === "idb" &&
            e.namespace.origin === origin &&
            e.namespace.name === logical,
        )
      )
        result.push({
          namespace: { kind: "idb", origin, name: logical },
          payload: await exportIDB(factory, name),
        });
    } catch (error) {
      if (/^https?:\/\//.test(name)) throw error;
    }
  }
  // The pinned production fork renamed the controller jar (see
  // scripts/runtime-fork.json and its packages/controller/src/index.ts). Read
  // exactly these known website jars, never arbitrary native databases. The
  // current fork wins duplicate IDs over its predecessor, while separately
  // sanitized snapshots preserve BOTH versions for acknowledged recovery.
  for (const database of ["__runtimekit_controller", "__scramjet_controller"] as const) {
    if (!all.some((d) => d.name === database)) continue;
    const db = await openExisting(factory, database), recovered: ProfileSnapshot[] = [];
    try {
      if (db.objectStoreNames.contains("state")) {
        const tx = db.transaction("state"),
          done = complete(tx),
          stored = await request(tx.objectStore("state").get("cookies"));
        await done;
        if (stored && typeof stored.cookies === "string") {
          const parsed = JSON.parse(stored.cookies);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw Error("PROFILE_LEGACY_COOKIE_INVALID");
          for (const old of Object.values(parsed) as any[]) {
            if (
              !old ||
              typeof old.name !== "string" ||
              typeof old.value !== "string" ||
              typeof old.domain !== "string"
            )
              throw Error("PROFILE_LEGACY_COOKIE_INVALID");
            const domain = new URL(
                "https://" + old.domain.replace(/^\./, ""),
              ).hostname.toLowerCase(),
              info = parseDomain(domain, { allowPrivateDomains: true });
            if (
              (!info.isIp && info.publicSuffix === domain) ||
              domain === globalThis.location?.hostname
            )
              continue;
            const expires =
              old.expires == null
                ? null
                : typeof old.expires === "string"
                  ? Date.parse(old.expires)
                  : Number(old.expires);
            if (expires !== null && !Number.isFinite(expires))
              throw Error("PROFILE_LEGACY_COOKIE_INVALID");
            if (expires !== null && expires <= Date.now()) continue;
            const group = hubSiteGroup("https://" + domain),
              path =
                typeof old.path === "string" && old.path.startsWith("/")
                  ? old.path
                  : "/",
              sameSite = String(old.sameSite || "lax").toLowerCase(),
              cookie = {
                id: JSON.stringify([
                  null,
                  domain,
                  old.hostOnly !== false,
                  path,
                  old.name,
                ]),
                name: old.name,
                value: old.value,
                domain,
                hostOnly: old.hostOnly !== false,
                path,
                secure: old.secure === true,
                httpOnly: old.httpOnly === true,
                sameSite: ["strict", "lax", "none"].includes(sameSite)
                  ? sameSite
                  : "default",
                partition: null,
                sessionId: expires === null ? "legacy-profile-import" : null,
                expires,
                created: Number(stored.updatedAt) || Date.now(),
                accessed: Number(stored.updatedAt) || Date.now(),
                site: group,
              };
            let target = recovered.find(
              (e) =>
                e.namespace.kind === "cookies" &&
                hubNamespace(e.namespace).siteGroup === group,
            );
            if (!target) {
              target = {
                namespace: { kind: "cookies", origin: "https://" + group },
                payload: {
                  format: "atlas-cookie-snapshot-v1",
                  revision: 0,
                  cookies: [],
                },
              };
              recovered.push(target);
            }
            const rows = (target.payload as CookieProfileSnapshot).cookies;
            if (!rows.some((c) => c.id === cookie.id)) rows.push(cookie);
          }
        }
      }
    } finally {
      db.close();
    }
    for (const source of recovered) {
      options?.cookieStores?.push({ ...source, database });
      const target = result.find(e => e.namespace.kind === "cookies" && hubNamespace(e.namespace).siteGroup === hubNamespace(source.namespace).siteGroup);
      if (!target) result.push({ namespace: source.namespace, payload: clone(source.payload) });
      else {
        const rows = (target.payload as CookieProfileSnapshot).cookies;
        for (const cookie of (source.payload as CookieProfileSnapshot).cookies)
          if (!rows.some(c => c.id === cookie.id)) rows.push(clone(cookie));
      }
    }
  }
}
function ordered(journals: Journal[], head: { revision: number }) {
  let last = -1;
  for (const j of journals) {
    if (
      !Number.isSafeInteger(j.revision) ||
      j.revision <= last ||
      j.revision > head.revision
    )
      throw Error("PROFILE_JOURNAL_ORDER_INVALID");
    last = j.revision;
  }
  return journals;
}
function pending(rows: any[], namespace: HubNamespace) {
  const key = hubNamespace(namespace).key;
  return rows.some(
    (e) =>
      e?.profileId &&
      e.kind &&
      hubNamespace({
        kind: e.kind,
        origin: e.origin,
        ...(e.kind === "idb" ? { name: e.name || "" } : {}),
      }).key === key,
  );
}
const headKey = (n: HubNamespace) =>
  "profile-cloud-head:" + hubNamespace(n).key;
export async function readProfileStreamHead(
  factory: IDBFactory,
  id: string,
  namespace: HubNamespace,
): Promise<{ revision: number; epoch: number } | null> {
  const key = hubNamespace(namespace).key,
    all = await factory.databases();
  const active = namespace.kind === "idb"
    ? (await listProfileIDBDatabases(factory, id)).find(
        (d) => d.origin === namespace.origin && d.name === (namespace.name || ""),
      )
    : undefined;
  // A recorded cloud head proves an acknowledgement, not that the local
  // database still exists. A stale catalog alias must force cloud hydration,
  // never publish an empty snapshot/deletion or accept the same cached head.
  // Keep explicit deletion tombstones and all catalog/head bytes unchanged.
  if (namespace.kind === "idb" && !active?.deleted &&
      (!active?.physical || !all.some((d) => d.name === active.physical)))
    return null;
  const name =
    namespace.kind === "idb"
      ? profileDatabaseName("atlas.browsing.profile-catalog.v1", id)
      : profileDatabaseName(
          namespace.kind === "local"
            ? "atlas.browsing.v2"
            : "atlas.browsing.cookies.v2",
          id,
        );
  const storeName = namespace.kind === "local" ? "origins" : "meta";
  let value: any = null;
  if (all.some((d) => d.name === name)) {
    const db = await openExisting(factory, name);
    try {
      const tx = db.transaction(storeName),
        done = complete(tx);
      value = await request(
        tx
          .objectStore(storeName)
          .get(
            namespace.kind === "local"
              ? ["cloud-head", key]
              : "profile-cloud-head:" + key,
          ),
      );
      await done;
    } finally {
      db.close();
    }
  }
  if (!value && namespace.kind === "idb") {
    if (active?.physical) {
      let db: IDBDatabase;
      try { db = await openExisting(factory, active.physical); }
      catch (error) {
        // A concurrent completed replacement may retire a previously listed
        // generation. Missing native bytes require hydration, not an empty DB.
        if (error instanceof Error && error.message === "PROFILE_DATABASE_MISSING") return null;
        throw error;
      }
      try {
        if (db.objectStoreNames.contains(PROFILE_IDB_KEEP)) {
          const tx = db.transaction(PROFILE_IDB_KEEP),
            done = complete(tx);
          value = await request(
            tx.objectStore(PROFILE_IDB_KEEP).get("profile-cloud-head:" + key),
          );
          await done;
        }
      } finally {
        db.close();
      }
    }
  }
  if (
    value &&
    (!Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 0)
  )
    throw Error("PROFILE_HEAD_CORRUPT");
  return value || null;
}
function inject(
  value: any,
  keyPath: string | string[] | null,
  key: IDBValidKey,
) {
  if (keyPath === null) return value;
  if (Array.isArray(keyPath)) return value;
  const parts = keyPath.split(".");
  let o = value;
  if (!o || typeof o !== "object") throw Error("PROFILE_INLINE_KEY_INVALID");
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(o, part))
      Object.defineProperty(o, part, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    o = o[part];
    if (!o || typeof o !== "object") throw Error("PROFILE_INLINE_KEY_INVALID");
  }
  Object.defineProperty(o, parts.at(-1)!, {
    value: key,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}
function matches(factory: IDBFactory, key: IDBValidKey, query: any) {
  if (query && typeof query === "object" && query.__atlasKeyRange === 1)
    return (
      (query.lower === undefined ||
        (query.lowerOpen
          ? factory.cmp(key, query.lower) > 0
          : factory.cmp(key, query.lower) >= 0)) &&
      (query.upper === undefined ||
        (query.upperOpen
          ? factory.cmp(key, query.upper) < 0
          : factory.cmp(key, query.upper) <= 0))
    );
  return factory.cmp(key, query) === 0;
}
export function replayProfileIDB(
  factory: IDBFactory,
  snapshot: any,
  journals: Journal[],
): IDBProfileSnapshot {
  let model: IDBProfileSnapshot =
    snapshot == null
      ? {
          format: "atlas-idb-snapshot-v1",
          version: 0,
          stores: [],
          deleted: true,
        }
      : clone(snapshot);
  if (model.format !== "atlas-idb-snapshot-v1" || !Array.isArray(model.stores))
    throw Error("PROFILE_IDB_SNAPSHOT_INVALID");
  for (const { payload: p } of journals) {
    if (p?.format === "atlas-idb-delete-v1" || p?.deleted === true) {
      model = {
        format: "atlas-idb-snapshot-v1",
        version: 0,
        stores: [],
        deleted: true,
      };
      continue;
    }
    if (
      !Array.isArray(p?.changes) ||
      !Number.isSafeInteger(p.version) ||
      p.version < 1
    )
      throw Error("PROFILE_IDB_JOURNAL_INVALID");
    model.deleted = false;
    model.version = p.version;
    for (const c of p.changes) {
      const store = () => {
        const s = model.stores.find((s) => s.name === c.store);
        if (!s) throw Error("PROFILE_IDB_STORE_MISSING");
        return s;
      };
      if (c.type === "schema") {
        if (c.action === "createStore") {
          if (model.stores.some((s) => s.name === c.store))
            throw Error("PROFILE_IDB_DUPLICATE_STORE");
          model.stores.push({
            name: c.store,
            keyPath: c.options?.keyPath ?? null,
            autoIncrement: c.options?.autoIncrement === true,
            indexes: [],
            records: [],
            generator: c.options?.autoIncrement ? { next: 1 } : null,
          });
        } else if (c.action === "deleteStore")
          model.stores = model.stores.filter((s) => s.name !== c.store);
        else if (c.action === "renameStore") store().name = c.name;
        else if (c.action === "createIndex")
          store().indexes.push({
            name: c.index,
            keyPath: c.keyPath,
            unique: c.options?.unique === true,
            multiEntry: c.options?.multiEntry === true,
          });
        else if (c.action === "deleteIndex")
          store().indexes = store().indexes.filter((i) => i.name !== c.index);
        else if (c.action === "renameIndex") {
          const i = store().indexes.find((i) => i.name === c.index);
          if (!i) throw Error("PROFILE_IDB_INDEX_MISSING");
          i.name = c.name;
        } else throw Error("PROFILE_IDB_SCHEMA_INVALID");
      } else {
        const s = store();
        if (c.action === "clear") s.records = [];
        else if (c.action === "delete")
          s.records = s.records.filter(
            (r) => !matches(factory, r.key, c.args?.[0]),
          );
        else if (c.action === "put" || c.action === "add") {
          const key = c.key ?? c.args?.[1];
          factory.cmp(key, key);
          const value = inject(clone(c.args?.[0]), s.keyPath, key),
            index = s.records.findIndex((r) => factory.cmp(r.key, key) === 0);
          if (c.action === "add" && index >= 0)
            throw Error("PROFILE_IDB_DUPLICATE_RECORD");
          if (index < 0) s.records.push({ key, value });
          else s.records[index] = { key, value };
          if (
            s.autoIncrement &&
            typeof key === "number" &&
            key >= 1 &&
            !("exhausted" in (s.generator || {}))
          ) {
            const next = Math.floor(key) + 1;
            if (key >= 9007199254740992) s.generator = { exhausted: true };
            else if (
              next > ((s.generator as { next: number } | null)?.next || 1)
            )
              s.generator = { next };
          }
        } else throw Error("PROFILE_IDB_OPERATION_INVALID");
      }
    }
  }
  return model;
}
async function restoreIDB(
  factory: IDBFactory,
  id: string,
  namespace: HubNamespace,
  snapshot: any,
  journals: Journal[],
  head: { revision: number; epoch: number },
) {
  const origin = exactOrigin(namespace.origin),
    name = namespace.name || "",
    model = replayProfileIDB(factory, snapshot, journals),
    old = (await listProfileIDBDatabases(factory, id)).find(
      (r) => r.origin === origin && r.name === name,
    );
  const directory = await openProfileCatalog(factory, id);
  try {
    const tx = directory.transaction("meta"),
      done = complete(tx),
      rows = await request(tx.objectStore("meta").getAll());
    await done;
    if (pending(rows, namespace)) throw Error("PROFILE_PENDING_LOCAL_WRITES");
  } finally {
    directory.close();
  }
  if (
    old?.physical &&
    (await factory.databases()).some((x) => x.name === old.physical)
  ) {
    const db = await openExisting(factory, old.physical);
    try {
      if (db.objectStoreNames.contains(PROFILE_IDB_KEEP)) {
        const tx = db.transaction(PROFILE_IDB_KEEP),
          done = complete(tx),
          rows = await request(tx.objectStore(PROFILE_IDB_KEEP).getAll());
        await done;
        if (pending(rows, namespace))
          throw Error("PROFILE_PENDING_LOCAL_WRITES");
      }
    } finally {
      db.close();
    }
  }
  if (model.deleted) {
    await activateProfileIDBDatabase(
      factory,
      id,
      { origin, name, physical: null, deleted: true },
      head,
    );
    await removeQuotaDatabase(factory, profileIDBPrefix(origin, id), name);
    if (old?.physical) factory.deleteDatabase(old.physical);
    return;
  }
  if (
    !Number.isSafeInteger(model.version) ||
    model.version < 1 ||
    model.stores.length > SANDBOX_IDB_LIMITS.maxStores
  )
    throw Error("PROFILE_IDB_SCHEMA_INVALID");
  const physical =
      profileIDBPrefix(origin, id) +
      encodeURIComponent(name) +
      "#:restore:" +
      crypto.randomUUID(),
    // Existing committed cloud data remains readable after a policy reduction.
    // Runtime growth uses the current per-origin policy; portable restore has
    // this absolute supported safety ceiling rather than an obsolete8MiB slice.
    sliceBytes = 1024 * 1024 * 1024;
  let failure: unknown;
  await new Promise<void>((resolve, reject) => {
    const r = factory.open(physical, model.version);
    r.onupgradeneeded = () => {
      const db = r.result,
        tx = r.transaction!;
      tx.onerror = (event) => {
        failure ||= (event.target as IDBRequest)?.error;
      };
      try {
        const keep = db.createObjectStore(PROFILE_IDB_KEEP);
        let size = 128,
          records = 0,
          indexEntries = 0;
        for (const s of model.stores) {
          if (
            s.name === PROFILE_IDB_KEEP ||
            s.indexes.length > SANDBOX_IDB_LIMITS.maxIndexes
          )
            throw Error("PROFILE_IDB_SCHEMA_INVALID");
          const store = db.createObjectStore(s.name, {
            keyPath: s.keyPath,
            autoIncrement: s.autoIncrement,
          });
          size +=
            128 +
            2 * s.name.length +
            boundedIDBValueBytes(s.keyPath, sliceBytes);
          for (const i of s.indexes) {
            store.createIndex(i.name, i.keyPath, {
              unique: i.unique,
              multiEntry: i.multiEntry,
            });
            size +=
              128 +
              2 * i.name.length +
              boundedIDBValueBytes(i.keyPath, sliceBytes);
          }
          for (const record of s.records) {
            records++;
            size +=
              64 +
              boundedIDBValueBytes(record.key, sliceBytes) +
              boundedIDBValueBytes(record.value, sliceBytes);
            if (s.keyPath === null) store.add(record.value, record.key);
            else store.add(record.value);
          }
          if (s.autoIncrement && s.generator) {
            const previous =
              "exhausted" in s.generator
                ? 9007199254740992
                : s.generator.next - 1;
            if (previous >= 1) {
              const value =
                  s.keyPath === null ? null : inject({}, s.keyPath, previous),
                sentinel =
                  s.keyPath === null
                    ? store.put(value, previous)
                    : store.put(value);
              sentinel.onsuccess = () => {
                const actual = s.records.find(
                  (x) => factory.cmp(x.key, previous) === 0,
                );
                if (actual) {
                  s.keyPath === null
                    ? store.put(actual.value, actual.key)
                    : store.put(actual.value);
                } else store.delete(previous);
              };
            }
          }
        }
        if (records > SANDBOX_IDB_LIMITS.maxRecords || size > sliceBytes)
          throw new DOMException(
            "Restored IDB exceeds website quota",
            "QuotaExceededError",
          );
        // The barrier runs after the sentinel callbacks have queued their
        // restorations. Audit actual native index entries, not guessed counts.
        const barrier = keep.get(0);
        barrier.onsuccess = () => {
          const jobs: Array<{
            source: IDBObjectStore | IDBIndex;
            record: boolean;
          }> = [];
          for (const s of model.stores) {
            const store = tx.objectStore(s.name);
            jobs.push({ source: store, record: true });
            for (const i of store.indexNames)
              jobs.push({ source: store.index(i), record: false });
          }
          let bytes = 128,
            recordCount = 0,
            indexCount = 0;
          for (const s of model.stores) {
            bytes +=
              128 +
              2 * s.name.length +
              boundedIDBValueBytes(s.keyPath, sliceBytes);
            for (const i of s.indexes)
              bytes +=
                128 +
                2 * i.name.length +
                boundedIDBValueBytes(i.keyPath, sliceBytes);
          }
          const next = () => {
            if (!jobs.length) {
              keep.put(
                {
                  bytes,
                  sliceBytes,
                  records: recordCount,
                  indexEntries: indexCount,
                },
                "usage",
              );
              return;
            }
            const job = jobs.shift()!,
              cursor = job.source.openCursor();
            cursor.onsuccess = () => {
              try {
                const row = cursor.result;
                if (!row) {
                  next();
                  return;
                }
                if (job.record) {
                  recordCount++;
                  bytes +=
                    64 +
                    boundedIDBValueBytes(row.primaryKey, sliceBytes) +
                    boundedIDBValueBytes(
                      (row as IDBCursorWithValue).value,
                      sliceBytes,
                    );
                } else {
                  indexCount++;
                  bytes +=
                    32 +
                    boundedIDBValueBytes(row.key, sliceBytes) +
                    boundedIDBValueBytes(row.primaryKey, sliceBytes);
                }
                if (
                  bytes > sliceBytes ||
                  recordCount > SANDBOX_IDB_LIMITS.maxRecords ||
                  indexCount > SANDBOX_IDB_LIMITS.maxIndexEntries
                )
                  throw new DOMException(
                    "Restored IDB exceeds website quota",
                    "QuotaExceededError",
                  );
                row.continue();
              } catch (e) {
                failure = e;
                tx.abort();
              }
            };
          };
          next();
        };
        keep.put(head, headKey(namespace));
      } catch (e) {
        failure = e;
        tx.abort();
      }
    };
    r.onsuccess = () => {
      r.result.close();
      resolve();
    };
    r.onerror = () => reject(failure || r.error);
    r.onblocked = () => reject(Error("PROFILE_DATABASE_BLOCKED"));
  });
  const prefix = profileIDBPrefix(origin, id),
    sources = (await listProfileIDBDatabases(factory, id))
      .filter(
        (d) => d.origin === origin && d.physical && !d.deleted && !d.deleting,
      )
      .map((d) => ({ name: d.name, physical: d.physical! }));
  await reconcileQuotaSources(factory, prefix, sources);
  const before =
    old?.physical &&
    (await factory.databases()).some((d) => d.name === old.physical)
      ? await readQuotaUsage(factory, old.physical)
      : 0;
  const intent = await reserveQuotaReplacement(
    factory,
    prefix,
    { name, physical },
    before,
    await readQuotaUsage(factory, physical),
    SANDBOX_IDB_LIMITS.maxDatabases,
  ).catch((error) => {
    factory.deleteDatabase(physical);
    throw error;
  });
  try {
    // The replacement intent now fences commits from old physical handles.
    // Drain/read their KEEP ledger AFTER the fence: a write already approved
    // before replacement must settle and be detected before alias publication.
    if (
      old?.physical &&
      (await factory.databases()).some((d) => d.name === old.physical)
    ) {
      const prior = await openExisting(factory, old.physical);
      try {
        const tx = prior.transaction(PROFILE_IDB_KEEP),
          done = complete(tx),
          rows = await request(tx.objectStore(PROFILE_IDB_KEEP).getAll());
        await done;
        if (pending(rows, namespace))
          throw Error("PROFILE_PENDING_LOCAL_WRITES");
      } finally {
        prior.close();
      }
    }
    await activateProfileIDBDatabase(
      factory,
      id,
      { origin, name, physical },
      head,
    );
  } catch (error) {
    // The prior alias remains authoritative. Reconcile actual committed bytes,
    // not a possibly stale before value; an old approved write may have won.
    if (old?.physical)
      await reconcileQuotaSource(factory, prefix, {
        name,
        physical: old.physical,
      });
    else await removeQuotaDatabase(factory, prefix, name);
    factory.deleteDatabase(physical);
    throw error;
  }
  await finishQuotaCommit(factory, prefix, intent, true);
  // Old generations are intentionally not authoritative after the pointer swap.
  // Delete asynchronously: readers holding an old connection cannot block restore.
  if (old?.physical && old.physical !== physical)
    factory.deleteDatabase(old.physical);
}
export async function restoreProfileStream(
  factory: IDBFactory,
  profileId: string,
  namespace: HubNamespace,
  snapshotDecoded: unknown,
  journalsDecoded: Journal[],
  head: { revision: number; epoch: number },
): Promise<void> {
  if (
    !Number.isSafeInteger(head.revision) ||
    head.revision < 0 ||
    !Number.isSafeInteger(head.epoch) ||
    head.epoch < 0
  )
    throw Error("PROFILE_HEAD_INVALID");
  hubNamespace(namespace);
  const journals = ordered(journalsDecoded, head);
  if (namespace.kind === "idb")
    return withQuotaLifecycle(
      profileIDBPrefix(exactOrigin(namespace.origin), profileId),
      () =>
        restoreIDB(
          factory,
          profileId,
          namespace,
          snapshotDecoded,
          journals,
          head,
        ),
    );
  if (namespace.kind === "local") {
    const origin = exactOrigin(namespace.origin);
    let value: LocalProfileSnapshot =
      snapshotDecoded == null
        ? { format: "atlas-local-snapshot-v1", revision: 0, entries: [] }
        : clone(snapshotDecoded as LocalProfileSnapshot);
    if (
      value.format !== "atlas-local-snapshot-v1" ||
      !Array.isArray(value.entries) ||
      value.entries.some(
        (e) =>
          !Array.isArray(e) ||
          e.length !== 2 ||
          e.some((v) => typeof v !== "string"),
      )
    )
      throw Error("PROFILE_LOCAL_SNAPSHOT_INVALID");
    const entries = new Map(value.entries);
    for (const { payload: p } of journals) {
      const c = p?.change;
      if (!c || !["set", "remove", "clear"].includes(c.op))
        throw Error("PROFILE_LOCAL_JOURNAL_INVALID");
      if (c.op === "clear") entries.clear();
      else if (c.op === "remove") entries.delete(c.key);
      else if (typeof c.key === "string" && typeof c.value === "string")
        entries.set(c.key, c.value);
      else throw Error("PROFILE_LOCAL_JOURNAL_INVALID");
      value.revision = p.revision;
    }
    if (
      [...entries].reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0) >
      32 * 1024 * 1024
    )
      throw new DOMException(
        "Local storage quota exceeded",
        "QuotaExceededError",
      );
    const db = await openCommon(
      factory,
      profileDatabaseName("atlas.browsing.v2", profileId),
      "local",
    );
    try {
      const tx = db.transaction("origins", "readwrite", {
          durability: "strict",
        }),
        done = complete(tx),
        store = tx.objectStore("origins"),
        r = store.getAll();
      r.onsuccess = () => {
        if (pending(r.result, namespace)) {
          tx.abort();
          return;
        }
        store.put({ revision: value.revision, entries: [...entries] }, origin);
        store.put(head, ["cloud-head", hubNamespace(namespace).key]);
        store.delete(["cloud-compaction", hubNamespace(namespace).key]);
      };
      await done;
    } finally {
      db.close();
    }
    return;
  }
  if (namespace.kind === "cookies") {
    const group = hubNamespace(namespace).siteGroup;
    let value: CookieProfileSnapshot =
      snapshotDecoded == null
        ? { format: "atlas-cookie-snapshot-v1", revision: 0, cookies: [] }
        : clone(snapshotDecoded as CookieProfileSnapshot);
    if (
      value.format !== "atlas-cookie-snapshot-v1" ||
      !Array.isArray(value.cookies)
    )
      throw Error("PROFILE_COOKIE_SNAPSHOT_INVALID");
    const cookies = new Map(value.cookies.map((c) => [c.id, c]));
    for (const { payload: p } of journals) {
      if (!Array.isArray(p?.changes))
        throw Error("PROFILE_COOKIE_JOURNAL_INVALID");
      for (const c of p.changes) {
        if (c.op === "delete") cookies.delete(c.cookie.id);
        else if (c.op === "set") cookies.set(c.cookie.id, c.cookie);
        else throw Error("PROFILE_COOKIE_JOURNAL_INVALID");
      }
      value.revision = p.revision;
    }
    for (const c of cookies.values()) {
      if (
        typeof c.domain !== "string" ||
        hubSiteGroup("https://" + c.domain) !== group ||
        c.id !==
          JSON.stringify([c.partition, c.domain, c.hostOnly, c.path, c.name])
      )
        throw Error("PROFILE_COOKIE_NAMESPACE_INVALID");
      if (c.expires === null) c.sessionId = "profile-" + profileId;
    }
    const db = await openCommon(
      factory,
      profileDatabaseName("atlas.browsing.cookies.v2", profileId),
      "cookies",
    );
    try {
      const tx = db.transaction(["cookies", "meta"], "readwrite", {
          durability: "strict",
        }),
        done = complete(tx),
        meta = tx.objectStore("meta"),
        priorRevision = meta.get("revision"),
        store = tx.objectStore("cookies"),
        pendingRows = meta.getAll(),
        rows = store.getAll();
      rows.onsuccess = () => {
        if (pending(pendingRows.result, namespace)) {
          tx.abort();
          return;
        }
        for (const c of rows.result)
          if (hubSiteGroup("https://" + c.domain) === group) store.delete(c.id);
        for (const c of cookies.values())
          if (c.expires === null || c.expires > Date.now()) store.put(c);
        meta.put(
          Math.max(Number(priorRevision.result || 0) + 1, value.revision || 0),
          "revision",
        );
        meta.put(head, headKey(namespace));
        meta.delete("profile-cloud-compaction:" + hubNamespace(namespace).key);
      };
      await done;
    } finally {
      db.close();
    }
    return;
  }
  throw Error("PROFILE_STREAM_KIND_UNSUPPORTED");
}

/** Explicit account-profile clear. No Atlas settings, peer profile, legacy
 * store, sessionStorage, credentials, or VPS state is deleted. Every clear is
 * journaled before success so the next frontend receives the same deletion. */
export async function clearProfileWebsiteData(
  factory: IDBFactory,
  id: string,
  contextId: string,
  prepare?: (origin: string) => Promise<void>,
): Promise<void> {
  const snapshots = await exportProfileSnapshots(factory, id),
    origins = [
      ...new Set(
        snapshots
          .map((s) => s.namespace.origin)
          .filter((x): x is string => !!x),
      ),
    ];
  for (const origin of origins) {
    await prepare?.(origin);
    await assertProfileWrite(factory, id, origin, contextId);
  }
  const localName = profileDatabaseName("atlas.browsing.v2", id),
    cookieName = profileDatabaseName("atlas.browsing.cookies.v2", id),
    all = await factory.databases();
  if (all.some((d) => d.name === localName)) {
    const db = await openCommon(factory, localName, "local");
    try {
      const tx = db.transaction("origins", "readwrite", {
          durability: "strict",
        }),
        done = complete(tx),
        store = tx.objectStore("origins");
      for (const e of snapshots.filter((s) => s.namespace.kind === "local")) {
        const origin = e.namespace.origin!,
          revision = (e.payload as LocalProfileSnapshot).revision + 1;
        assertProfileWriteCached(factory, id, origin, contextId);
        store.put({ revision, entries: [] }, origin);
        appendProfileJournal(
          store,
          {
            profileId: id,
            kind: "local",
            origin,
            payload: { change: { op: "clear" }, revision },
            bytes: 64,
          },
          "array",
        );
      }
      await done;
    } finally {
      db.close();
    }
  }
  if (all.some((d) => d.name === cookieName)) {
    const db = await openCommon(factory, cookieName, "cookies");
    try {
      const tx = db.transaction(["cookies", "meta"], "readwrite", {
          durability: "strict",
        }),
        done = complete(tx),
        store = tx.objectStore("cookies"),
        meta = tx.objectStore("meta"),
        rev = meta.get("revision"),
        rows = store.getAll();
      rows.onsuccess = () => {
        try {
          let revision = Number(rev.result || 0);
          const groups = new Map<string, any[]>();
          for (const cookie of rows.result) {
            const origin =
              "https://" + hubSiteGroup("https://" + cookie.domain);
            assertProfileWriteCached(factory, id, origin, contextId);
            const changes = groups.get(origin) || [];
            changes.push({ op: "delete", cookie });
            groups.set(origin, changes);
            store.delete(cookie.id);
          }
          for (const [origin, changes] of groups)
            appendProfileJournal(meta, {
              profileId: id,
              kind: "cookies",
              origin,
              payload: { changes, revision: ++revision },
              bytes: Math.max(64, JSON.stringify(changes).length * 2),
            });
          meta.put(revision, "revision");
        } catch {
          tx.abort();
        }
      };
      await done;
    } finally {
      db.close();
    }
  }
  for (const d of await listProfileIDBDatabases(factory, id))
    if (d.physical && !d.deleted) {
      await assertProfileWrite(factory, id, d.origin, contextId);
      await deleteProfileIDBDatabase(factory, id, d.origin, d.name);
    }
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("atlas:profile-native-change", {
        detail: { profileId: id, kind: "clear" },
      }),
    );
}
