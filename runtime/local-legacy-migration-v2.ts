import { prepareLegacyCookiesToV2 } from "./local-cookie-migration-v2.ts";
export {
  prepareLegacyCookiesToV2,
  LOCAL_COOKIE_PROFILE_MARKER,
} from "./local-cookie-migration-v2.ts";
import { parse as parseDomain } from "tldts";
import { profileDatabaseName, profileIDBPrefix } from "./profile-journal.ts";
import {
  openProfileCatalog,
  catalogDone,
  catalogRequest,
} from "./profile-idb-catalog.ts";
import {
  createLocalStorageV2Stores,
  LOCAL_STORAGE_VALUE_STORE,
} from "./local-storage-v2.ts";
import { appendLocalDirty } from "./local-dirty-v2.ts";
export type LegacySiteInspection = {
  state: "empty" | "eligible" | "deferred";
  reason?: string;
  origin: string;
  localRevision?: number;
  cookieRevision?: number;
  localBytes?: number;
  cookieBytes?: number;
  cookieKeys?: string[];
};
const LOCAL_BASE = "atlas.browsing.v2",
  COOKIE_BASE = "atlas.browsing.cookies.v2",
  MAX_BYTES = 256 * 1024,
  MAX_KEYS = 4096;
const request = <T>(r: IDBRequest<T>) => catalogRequest(r);
async function existing(factory: IDBFactory, name: string) {
  if (!(await factory.databases()).some((d) => d.name === name)) return null;
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function site(host: string) {
  return parseDomain(host, { allowPrivateDomains: true }).domain || host;
}
/** Inspect keys and size certificates BEFORE cloning legacy native values.
 * An uncertified legacy row is deliberately deferred, not read then discarded.
 * Original databases and prepared v1 requests are never modified here. */
export async function inspectLegacySite(
  factory: IDBFactory,
  legacyProfileId: string,
  rawOrigin: string,
  options: { skipCookies?: boolean } = {},
): Promise<LegacySiteInspection> {
  const origin = new URL(rawOrigin).origin,
    result: LegacySiteInspection = { state: "empty", origin };
  if (
    (await factory.databases()).some(
      (d) =>
        d.name?.startsWith(profileIDBPrefix(origin, legacyProfileId)) &&
        !d.name.endsWith(":#quota"),
    )
  )
    return {
      ...result,
      state: "deferred",
      reason:
        "legacy_indexeddb_requires_validated_record_and_generator_migration",
    };
  const local = await existing(
    factory,
    profileDatabaseName(LOCAL_BASE, legacyProfileId),
  );
  if (local)
    try {
      const tx = local.transaction("origins"),
        done = catalogDone(tx),
        store = tx.objectStore("origins"),
        key = request(store.getKey(origin)),
        cert = request(store.get(["local-migration-size-v2", origin]));
      const [present, size] = await Promise.all([key, cert]);
      await done;
      if (present !== undefined) {
        if (
          !size ||
          size.format !== 2 ||
          !Number.isSafeInteger(size.bytes) ||
          size.bytes < 0 ||
          !Number.isSafeInteger(size.count) ||
          size.count < 0 ||
          size.bytes > MAX_BYTES ||
          size.count > MAX_KEYS
        )
          return {
            ...result,
            state: "deferred",
            reason: "legacy_local_storage_size_unverified_or_oversized",
          };
        result.state = "eligible";
        result.localRevision = size.revision;
        result.localBytes = size.bytes;
      }
    } finally {
      local.close();
    }
  const cookies = options.skipCookies
    ? null
    : await existing(
        factory,
        profileDatabaseName(COOKIE_BASE, legacyProfileId),
      );
  if (cookies)
    try {
      const tx = cookies.transaction(["cookies", "meta"]),
        done = catalogDone(tx),
        meta = tx.objectStore("meta"),
        revision = request(meta.get("revision")),
        matching: string[] = [],
        wanted = site(new URL(origin).hostname);
      let bytes = 0,
        invalid = false;
      await new Promise<void>((resolve, reject) => {
        const cursor = tx.objectStore("cookies").openKeyCursor();
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) {
            resolve();
            return;
          }
          try {
            if (
              typeof row.primaryKey !== "string" ||
              row.primaryKey.length > MAX_BYTES
            ) {
              invalid = true;
              resolve();
              return;
            }
            const identity = JSON.parse(row.primaryKey);
            if (!Array.isArray(identity) || typeof identity[1] !== "string") {
              invalid = true;
              resolve();
              return;
            }
            if (site(identity[1]) === wanted) {
              matching.push(row.primaryKey);
              const certificate = meta.get([
                "local-cookie-size-v2",
                row.primaryKey,
              ]);
              certificate.onsuccess = () => {
                const c = certificate.result;
                if (
                  !c ||
                  !Number.isSafeInteger(c.bytes) ||
                  c.bytes < 0 ||
                  c.bytes > MAX_BYTES
                )
                  invalid = true;
                else bytes += c.bytes;
                if (matching.length > 180 || bytes > MAX_BYTES) invalid = true;
                if (invalid) resolve();
                else row.continue();
              };
              certificate.onerror = () => reject(certificate.error);
            } else row.continue();
          } catch {
            invalid = true;
            resolve();
          }
        };
      });
      const version = await revision;
      await done;
      if (invalid)
        return {
          ...result,
          state: "deferred",
          reason: "legacy_cookie_size_unverified_or_oversized",
        };
      if (matching.length) {
        result.state = "eligible";
        result.cookieKeys = matching;
        result.cookieRevision = version || 0;
        result.cookieBytes = bytes;
      }
    } finally {
      cookies.close();
    }
  return result;
}
async function create(
  factory: IDBFactory,
  name: string,
  kind: "local" | "cookies",
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      if (kind === "local") createLocalStorageV2Stores(r.result);
      else {
        const s = r.result.createObjectStore("cookies", { keyPath: "id" });
        s.createIndex("site", "site");
        s.createIndex("domain", "domain");
        s.createIndex("expires", "expires");
        r.result.createObjectStore("meta");
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/** Eligible snapshots fit a bounded cut. Old/new stores never share mutable
 * rows. Native IDB remains deferred until schema/generator coverage is proven.
 * Publication is a separate catalog marker; partial staging is never ready. */
export async function copyLegacySiteToV2(
  factory: IDBFactory,
  legacyProfileId: string,
  replicaId: string,
  rawOrigin: string,
): Promise<LegacySiteInspection> {
  if (legacyProfileId === replicaId)
    throw new TypeError(
      "Migration requires physically isolated replica identity",
    );
  const cookies = await prepareLegacyCookiesToV2(
    factory,
    legacyProfileId,
    replicaId,
  );
  if (cookies.state === "deferred")
    return {
      state: "deferred",
      origin: new URL(rawOrigin).origin,
      reason: cookies.reason,
    };
  const inspected = await inspectLegacySite(
    factory,
    legacyProfileId,
    rawOrigin,
    { skipCookies: true },
  );
  if (inspected.state === "deferred") return inspected;
  const { origin } = inspected,
    catalog = await openProfileCatalog(factory, replicaId);
  const marker = ["local-site-v2", origin];
  try {
    let tx = catalog.transaction("meta", "readwrite"),
      done = catalogDone(tx),
      s = tx.objectStore("meta"),
      prior = s.get(marker),
      alreadyReady = false,
      interrupted = false;
    prior.onsuccess = () => {
      if (prior.result?.state === "ready") {
        alreadyReady = true;
        return;
      }
      if (prior.result?.state === "preparing") {
        interrupted = true;
        return;
      }
      s.put(
        {
          state: "preparing",
          legacyProfileId,
          origin,
          localRevision: inspected.localRevision,
          cookieRevision: inspected.cookieRevision,
        },
        marker,
      );
    };
    await done;
    if (alreadyReady) return inspected;
    if (interrupted)
      return {
        ...inspected,
        state: "deferred",
        reason: "interrupted_migration_staging_preserved_for_recovery",
      };
    if (inspected.localRevision !== undefined) {
      const source = (await existing(
        factory,
        profileDatabaseName(LOCAL_BASE, legacyProfileId),
      ))!;
      let value: any;
      try {
        tx = source.transaction("origins");
        done = catalogDone(tx);
        const row = request(tx.objectStore("origins").get(origin)),
          cert = request(
            tx.objectStore("origins").get(["local-migration-size-v2", origin]),
          );
        const [v, c] = await Promise.all([row, cert]);
        await done;
        if (
          !v ||
          v.revision !== inspected.localRevision ||
          c?.revision !== v.revision ||
          !Array.isArray(v.entries)
        )
          return {
            ...inspected,
            state: "deferred",
            reason: "legacy_local_storage_changed_during_cut",
          };
        value = v;
      } finally {
        source.close();
      }
      const target = await create(
        factory,
        profileDatabaseName(LOCAL_BASE, replicaId),
        "local",
      );
      try {
        tx = target.transaction("origins");
        done = catalogDone(tx);
        const prior = await request(tx.objectStore("origins").get(origin));
        await done;
        if (prior?.revision)
          return {
            ...inspected,
            state: "deferred",
            reason: "destination_local_state_already_exists",
          };
        for (let i = 0; i < value.entries.length; i += 64) {
          tx = target.transaction(
            ["origins", LOCAL_STORAGE_VALUE_STORE],
            "readwrite",
          );
          done = catalogDone(tx);
          for (const [key, item] of value.entries.slice(i, i + 64)) {
            if (typeof key !== "string" || typeof item !== "string")
              throw Error("LEGACY_LOCAL_STORAGE_INVALID");
            tx.objectStore(LOCAL_STORAGE_VALUE_STORE).put(item, [
              "local",
              origin,
              key,
            ]);
            appendLocalDirty(tx.objectStore("origins"), {
              namespace: JSON.stringify(["local", origin, ""]),
              key,
              operation: "upsert",
              estimatedNativeBytes: 2 * (key.length + item.length),
              shapeEligible: true,
            });
          }
          await done;
        }
        tx = target.transaction("origins", "readwrite");
        done = catalogDone(tx);
        tx.objectStore("origins").put(
          {
            format: 2,
            revision: value.revision,
            bytes: value.entries.reduce(
              (n: number, [k, v]: string[]) => n + 2 * (k.length + v.length),
              0,
            ),
            count: value.entries.length,
          },
          origin,
        );
        await done;
      } finally {
        target.close();
      }
    }
    tx = catalog.transaction("meta", "readwrite");
    done = catalogDone(tx);
    tx.objectStore("meta").put(
      {
        state: "ready",
        legacyProfileId,
        origin,
        localRevision: inspected.localRevision,
        cookieRevision: inspected.cookieRevision,
        legacyForkPreserved: true,
      },
      marker,
    );
    await done;
    return inspected;
  } finally {
    catalog.close();
  }
}
