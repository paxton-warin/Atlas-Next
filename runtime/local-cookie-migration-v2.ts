/** A single bounded cut of the complete legacy cookie profile precedes ANY
 * local-v2 site. Cookie authority is profile/site-wide, not document-origin
 * wide: a third-party request and its sign-in popup must use the same jar. */
import { profileDatabaseName } from "./local-storage-names.ts";
import {
  openProfileCatalog,
  catalogDone,
  catalogRequest,
} from "./local-idb-catalog.ts";
import { appendLocalDirty } from "./local-dirty-v2.ts";
import { parse as parseDomain } from "tldts";
const BASE = "atlas.browsing.cookies.v2",
  MAX_BYTES = 256 * 1024,
  MAX_KEYS = 4096;
export const LOCAL_COOKIE_PROFILE_MARKER: IDBValidKey = [
  "local-cookie-profile-v2",
];
export type LocalCookieMigrationResult = {
  state: "ready" | "deferred";
  reason?: string;
  cookieCount?: number;
  cookieBytes?: number;
  sourceRevision?: number;
};
type Cut = { keys: string[]; bytes: number; revision: number };
async function existing(factory: IDBFactory, name: string) {
  if (!(await factory.databases()).some((d) => d.name === name)) return null;
  const r = factory.open(name);
  r.onupgradeneeded = () => r.transaction!.abort();
  return catalogRequest(r);
}
async function inspect(
  factory: IDBFactory,
  id: string,
): Promise<Cut | LocalCookieMigrationResult> {
  const db = await existing(factory, profileDatabaseName(BASE, id));
  if (!db) return { keys: [], bytes: 0, revision: 0 };
  try {
    const t = db.transaction(["cookies", "meta"]),
      end = catalogDone(t),
      meta = t.objectStore("meta"),
      store = t.objectStore("cookies"),
      revision = meta.get("revision"),
      certificate = meta.get("local-cookie-migration-size-v2"),
      count = store.count();
    let failed: string | undefined,
      keys: string[] = [],
      size = 0;
    count.onsuccess = () => {
      const n = count.result,
        c = certificate.result,
        v = revision.result || 0;
      if (!n) return;
      if (
        n > MAX_KEYS ||
        !c ||
        c.format !== 2 ||
        c.scope !== "complete-stored-jar" ||
        c.revision !== v ||
        !Number.isSafeInteger(c.bytes) ||
        c.bytes < 0 ||
        c.bytes > MAX_BYTES ||
        !Number.isSafeInteger(c.count) ||
        c.count < n
      ) {
        failed = "legacy_cookie_profile_size_unverified_or_oversized";
        return;
      }
      const cursor = store.openKeyCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (
          typeof row.primaryKey !== "string" ||
          row.primaryKey.length > MAX_BYTES ||
          keys.length >= MAX_KEYS
        ) {
          failed = "legacy_cookie_profile_key_budget";
          return;
        }
        const key = row.primaryKey,
          cert = meta.get(["local-cookie-size-v2", key]);
        cert.onsuccess = () => {
          const value = cert.result;
          if (
            !value ||
            !Number.isSafeInteger(value.bytes) ||
            value.bytes < 0 ||
            value.bytes > MAX_BYTES
          ) {
            failed = "legacy_cookie_profile_record_unverified";
            return;
          }
          size += value.bytes;
          if (size > MAX_BYTES) {
            failed = "legacy_cookie_profile_size_unverified_or_oversized";
            return;
          }
          keys.push(key);
          row.continue();
        };
      };
    };
    await end;
    if (failed) return { state: "deferred", reason: failed };
    return {
      keys,
      bytes: certificate.result?.bytes || 0,
      revision: revision.result || 0,
    };
  } finally {
    db.close();
  }
}
function validCookie(row: any, key: string) {
  if (
    !row ||
    row.id !== key ||
    ["name", "value", "domain", "path", "site"].some(
      (k) => typeof row[k] !== "string",
    ) ||
    ["hostOnly", "secure", "httpOnly"].some(
      (k) => typeof row[k] !== "boolean",
    ) ||
    !["strict", "lax", "none", "default"].includes(row.sameSite) ||
    !(row.partition === null || typeof row.partition === "string") ||
    !(row.sessionId === null || typeof row.sessionId === "string") ||
    !(row.expires === null || Number.isFinite(row.expires)) ||
    !Number.isFinite(row.created) ||
    !Number.isFinite(row.accessed) ||
    row.id !==
      JSON.stringify([
        row.partition,
        row.domain,
        row.hostOnly,
        row.path,
        row.name,
      ]) ||
    row.site !==
      (parseDomain(row.domain, { allowPrivateDomains: true }).domain ||
        row.domain)
  )
    return false;
  return true;
}
async function create(factory: IDBFactory, id: string) {
  const r = factory.open(profileDatabaseName(BASE, id), 1);
  r.onupgradeneeded = () => {
    const s = r.result.createObjectStore("cookies", { keyPath: "id" });
    s.createIndex("site", "site");
    s.createIndex("domain", "domain");
    s.createIndex("expires", "expires");
    r.result.createObjectStore("meta");
  };
  return catalogRequest(r);
}
const flights = new WeakMap<
  IDBFactory,
  Map<string, Promise<LocalCookieMigrationResult>>
>();
export function prepareLegacyCookiesToV2(
  factory: IDBFactory,
  legacyProfileId: string,
  replicaId: string,
): Promise<LocalCookieMigrationResult> {
  if (legacyProfileId === replicaId)
    return Promise.reject(
      new TypeError("Cookie migration requires isolated local identity"),
    );
  let entries = flights.get(factory);
  if (!entries) {
    entries = new Map();
    flights.set(factory, entries);
  }
  const key = legacyProfileId + "\0" + replicaId;
  let pending = entries.get(key);
  if (pending) return pending;
  const run = () => copy(factory, legacyProfileId, replicaId);
  pending = (
    globalThis.navigator?.locks
      ? navigator.locks.request("atlas-cookie-migration-v2:" + replicaId, run)
      : run()
  ).finally(() => entries!.delete(key));
  entries.set(key, pending);
  return pending;
}
async function copy(
  factory: IDBFactory,
  legacy: string,
  replica: string,
): Promise<LocalCookieMigrationResult> {
  const catalog = await openProfileCatalog(factory, replica);
  try {
    let t = catalog.transaction("meta"),
      end = catalogDone(t),
      meta = t.objectStore("meta");
    const marker = catalogRequest(meta.get(LOCAL_COOKIE_PROFILE_MARKER)),
      restored = catalogRequest(meta.get("backup-restore-v2")),
      [prior, restore] = await Promise.all([marker, restored]);
    await end;
    if (prior?.state === "ready")
      return {
        state: "ready",
        cookieCount: prior.cookieCount,
        cookieBytes: prior.cookieBytes,
        sourceRevision: prior.sourceRevision,
      };
    if (prior?.state === "preparing")
      return {
        state: "deferred",
        reason: "interrupted_cookie_profile_migration_staging_preserved",
      };
    if (restore?.state === "ready" && restore.profileId === legacy) {
      t = catalog.transaction("meta", "readwrite");
      end = catalogDone(t);
      t.objectStore("meta").put(
        {
          state: "ready",
          authority: "completed-checkpoint",
          checkpointId: restore.checkpointId,
        },
        LOCAL_COOKIE_PROFILE_MARKER,
      );
      await end;
      return {
        state: "ready",
        reason: "completed_checkpoint_cookie_authority",
      };
    }
    const cut = await inspect(factory, legacy);
    if ("state" in cut) return cut;
    const target = await existing(factory, profileDatabaseName(BASE, replica));
    if (target)
      try {
        t = target.transaction("cookies");
        end = catalogDone(t);
        const count = await catalogRequest(t.objectStore("cookies").count());
        await end;
        if (count && cut.keys.length)
          return {
            state: "deferred",
            reason: "destination_cookie_profile_already_contains_data",
          };
      } finally {
        target.close();
      }
    const token = crypto.randomUUID();
    t = catalog.transaction("meta", "readwrite");
    end = catalogDone(t);
    t.objectStore("meta").put(
      {
        state: "preparing",
        legacyProfileId: legacy,
        sourceRevision: cut.revision,
        token,
      },
      LOCAL_COOKIE_PROFILE_MARKER,
    );
    await end;
    const rows: any[] = [],
      source = cut.keys.length
        ? await existing(factory, profileDatabaseName(BASE, legacy))
        : null;
    let bytes = 0;
    if (source)
      try {
        for (let at = 0; at < cut.keys.length; at += 64) {
          t = source.transaction(["cookies", "meta"]);
          end = catalogDone(t);
          const revision = catalogRequest(
              t.objectStore("meta").get("revision"),
            ),
            page = await Promise.all(
              cut.keys
                .slice(at, at + 64)
                .map((key) =>
                  catalogRequest(t.objectStore("cookies").get(key)),
                ),
            );
          const version = await revision;
          await end;
          if ((version || 0) !== cut.revision)
            return {
              state: "deferred",
              reason: "legacy_cookie_profile_changed_during_cut",
            };
          for (let n = 0; n < page.length; n++) {
            const value = page[n];
            if (!validCookie(value, cut.keys[at + n]))
              return {
                state: "deferred",
                reason: "legacy_cookie_profile_record_invalid",
              };
            bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
            if (bytes > MAX_BYTES || bytes > cut.bytes)
              return {
                state: "deferred",
                reason: "legacy_cookie_profile_size_certificate_changed",
              };
            rows.push({
              ...value,
              sessionId:
                value.sessionId === "profile-" + legacy
                  ? "profile-" + replica
                  : value.sessionId,
            });
          }
        }
      } finally {
        source.close();
      }
    if (rows.length) {
      const destination = await create(factory, replica);
      try {
        let total = 0,
          count = 0;
        for (let at = 0; at < rows.length; at += 64) {
          t = destination.transaction(["cookies", "meta"], "readwrite");
          end = catalogDone(t);
          const store = t.objectStore("cookies"),
            metadata = t.objectStore("meta");
          for (const row of rows.slice(at, at + 64)) {
            const size = new TextEncoder().encode(
              JSON.stringify(row),
            ).byteLength;
            store.add(row);
            total += size;
            count++;
            appendLocalDirty(metadata, {
              namespace: JSON.stringify(["cookies", row.site, ""]),
              key: row.id,
              operation: "upsert",
              estimatedNativeBytes: size,
              shapeEligible: true,
            });
          }
          metadata.put({ bytes: total, count }, "local-usage-v2");
          metadata.put(cut.revision, "revision");
          await end;
        }
      } finally {
        destination.close();
      }
    }
    t = catalog.transaction("meta", "readwrite");
    end = catalogDone(t);
    meta = t.objectStore("meta");
    const current = meta.get(LOCAL_COOKIE_PROFILE_MARKER);
    current.onsuccess = () => {
      if (current.result?.token !== token) {
        t.abort();
        return;
      }
      meta.put(
        {
          state: "ready",
          legacyProfileId: legacy,
          sourceRevision: cut.revision,
          cookieCount: cut.keys.length,
          cookieBytes: bytes,
          legacyForkPreserved: true,
        },
        LOCAL_COOKIE_PROFILE_MARKER,
      );
    };
    await end;
    return {
      state: "ready",
      sourceRevision: cut.revision,
      cookieCount: cut.keys.length,
      cookieBytes: bytes,
    };
  } finally {
    catalog.close();
  }
}
