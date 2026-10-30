/** Trusted per-logical-origin IDB quota accounting.
 * Native source transactions and this metadata database cannot commit atomically.
 * A strict-durability intent therefore charges max(before,after) BEFORE a source
 * transaction may commit. Interrupted acknowledgements can only overcharge;
 * a source-ledger/CAS reconciliation releases that conservative reservation.
 * No website receives this database, its keys, or a choice of physical source. */
import { PROFILE_IDB_KEEP } from "./profile-journal.ts";
export type QuotaSource = { name: string; physical: string };
type Intent = {
  token: string;
  before: number;
  after: number;
  kind: "write" | "replace";
};
type Row = {
  version: 2;
  physical: string;
  bytes: number;
  generation: string;
  intent?: Intent;
};
export type QuotaIntent = {
  name: string;
  physical: string;
  token: string;
  before: number;
  after: number;
};
const error = (s: string) => new DOMException(s, "QuotaExceededError");
const checkedBytes = (n: unknown) => {
  if (!Number.isSafeInteger(n) || Number(n) < 0)
    throw error("Invalid native quota ledger");
  return Number(n);
};
const charge = (r: any) =>
  r?.version === 2 ? checkedBytes(r.bytes) : r ? checkedBytes(r.sliceBytes) : 0;
const signature = (r: unknown) => JSON.stringify(r ?? null);
function open(factory: IDBFactory, prefix: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(prefix + "#quota", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("databases");
    r.onerror = () => reject(r.error);
    r.onblocked = () =>
      reject(new DOMException("Quota database blocked", "InvalidStateError"));
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
async function change<T>(
  factory: IDBFactory,
  prefix: string,
  fn: (s: IDBObjectStore, finish: (value: T) => void) => void,
): Promise<T> {
  const db = await open(factory, prefix);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("databases", "readwrite", {
        durability: "strict",
      });
      let result: T, failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ||
            (tx as any).__atlasQuotaError ||
            tx.error ||
            new DOMException("Quota transaction aborted", "AbortError"),
        );
      tx.onerror = () => {};
      try {
        fn(tx.objectStore("databases"), (v) => {
          result = v;
        });
      } catch (e) {
        failure = e;
        tx.abort();
      }
    });
  } finally {
    db.close();
  }
}
async function row(
  factory: IDBFactory,
  prefix: string,
  name: string,
): Promise<any> {
  const db = await open(factory, prefix);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("databases"),
        r = tx.objectStore("databases").get(name);
      let value: any;
      r.onsuccess = () => {
        value = r.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
/** A separate origin lifecycle lock replaces keeping a quota transaction live
 * across native open/upgrade/delete. Quota intents never wait on this lock, so a
 * native upgrade can request its reservation without self-deadlocking. */
export function withQuotaLifecycle<T>(
  prefix: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!globalThis.navigator?.locks)
    throw new DOMException(
      "Native database lifecycle locking is unavailable",
      "NotSupportedError",
    );
  return navigator.locks.request(
    "atlas-idb-lifecycle:" + prefix,
    { mode: "exclusive" },
    action,
  );
}
export async function reserveQuotaDatabase(
  factory: IDBFactory,
  prefix: string,
  name: string,
  physical: string,
  maxDatabases: number,
): Promise<void> {
  return change<void>(factory, prefix, (s, finish) => {
    const r = s.get(name);
    r.onsuccess = () => {
      if (r.result) {
        charge(r.result);
        finish();
        return;
      }
      const count = s.count();
      count.onsuccess = () => {
        if (count.result >= maxDatabases) {
          s.transaction.abort();
          return;
        }
        s.add(
          {
            version: 2,
            physical,
            bytes: 0,
            generation: crypto.randomUUID(),
          } satisfies Row,
          name,
        );
        finish();
      };
    };
  }).catch((e) => {
    if (e?.name === "AbortError")
      throw error("Website database allowance exhausted");
    throw e;
  });
}
export async function removeQuotaDatabase(
  factory: IDBFactory,
  prefix: string,
  name: string,
): Promise<void> {
  return change<void>(factory, prefix, (s, finish) => {
    s.delete(name);
    finish();
  });
}
export async function readQuotaUsage(
  factory: IDBFactory,
  physical: string,
): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(physical);
    r.onupgradeneeded = () => r.transaction!.abort();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    if (!db.objectStoreNames.contains(PROFILE_IDB_KEEP))
      throw error("Database has no bounded storage ledger");
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(PROFILE_IDB_KEEP),
        r = tx.objectStore(PROFILE_IDB_KEEP).get("usage");
      let bytes = 0,
        failure: unknown;
      r.onsuccess = () => {
        try {
          if (!r.result) throw error("Database storage ledger is absent");
          bytes = checkedBytes(r.result.bytes);
        } catch (e) {
          failure = e;
        }
      };
      tx.oncomplete = () => (failure ? reject(failure) : resolve(bytes));
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
/** Compare the metadata version captured BEFORE the native read. A concurrent
 * writer must first change that metadata (durable intent); retry instead of
 * overwriting its charge with an older source snapshot. */
export async function reconcileQuotaSource(
  factory: IDBFactory,
  prefix: string,
  source: QuotaSource,
): Promise<void> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const prior = await row(factory, prefix, source.name),
      bytes = await readQuotaUsage(factory, source.physical);
    const okay = await change<boolean>(factory, prefix, (s, finish) => {
      const r = s.get(source.name);
      r.onsuccess = () => {
        if (signature(r.result) !== signature(prior)) {
          finish(false);
          return;
        }
        s.put(
          {
            version: 2,
            physical: source.physical,
            bytes,
            generation: crypto.randomUUID(),
          } satisfies Row,
          source.name,
        );
        finish(true);
      };
    });
    if (okay) return;
  }
  throw new DOMException(
    "Concurrent quota reconciliation did not settle",
    "InvalidStateError",
  );
}
/** Call under lifecycle lock before the first document starts native writers.
 * All active catalog aliases are counted; staging and retired generations are
 * deliberately not independent logical databases. Orphan empty reservations are
 * conservatively retained until their lifecycle is explicitly retried/deleted. */
export async function reconcileQuotaSources(
  factory: IDBFactory,
  prefix: string,
  sources: QuotaSource[],
): Promise<void> {
  const names = new Set((await factory.databases()).map((d) => d.name));
  for (const source of sources)
    if (names.has(source.physical))
      await reconcileQuotaSource(factory, prefix, source);
}
export async function reserveQuotaCommit(
  factory: IDBFactory,
  prefix: string,
  source: QuotaSource,
  before: number,
  after: number,
  quotaBytes: number,
  kind: "write" | "replace" = "write",
): Promise<QuotaIntent> {
  checkedBytes(before);
  checkedBytes(after);
  const token = crypto.randomUUID();
  return change<QuotaIntent>(factory, prefix, (s, finish) => {
    const keys = s.getAllKeys(),
      all = s.getAll();
    all.onsuccess = () => {
      try {
        const rows = all.result,
          at = keys.result.findIndex((k) => k === source.name),
          current = rows[at];
        if (!current) throw error("Database has no durable quota reservation");
        if (
          kind === "write" &&
          current.version === 2 &&
          current.physical !== source.physical
        )
          throw new DOMException(
            "Database generation was replaced",
            "InvalidStateError",
          );
        const total = rows.reduce(
            (n, r, i) => n + (i === at ? 0 : charge(r)),
            0,
          ),
          safeBefore =
            kind === "replace" ? Math.max(before, charge(current)) : before,
          bytes = Math.max(safeBefore, after);
        if (!Number.isSafeInteger(total + bytes))
          throw error("Invalid origin quota total");
        if (after > before && total + bytes > quotaBytes)
          throw error("Website origin IndexedDB allowance exceeded");
        s.put(
          {
            version: 2,
            physical: source.physical,
            bytes,
            generation: token,
            intent: { token, before: safeBefore, after, kind },
          } satisfies Row,
          source.name,
        );
        finish({ ...source, token, before: safeBefore, after });
      } catch (e) {
        (s.transaction as any).__atlasQuotaError = e;
        s.transaction.abort();
      }
    };
  }).catch((e) => {
    throw e;
  });
}
export async function finishQuotaCommit(
  factory: IDBFactory,
  prefix: string,
  intent: QuotaIntent,
  committed: boolean,
): Promise<void> {
  return change<void>(factory, prefix, (s, finish) => {
    const r = s.get(intent.name);
    r.onsuccess = () => {
      if (r.result?.intent?.token === intent.token) {
        const value: Row = {
          version: 2,
          physical: intent.physical,
          bytes: committed ? intent.after : intent.before,
          generation: crypto.randomUUID(),
        };
        s.put(value, intent.name);
      }
      finish();
    };
  });
}
/** Authenticated cloud data was already committed elsewhere. Lowering a local
 * policy never destroys or blocks restoration/read access to that data; future
 * source growth is rejected against the current policy. */
export async function reserveQuotaReplacement(
  factory: IDBFactory,
  prefix: string,
  source: QuotaSource,
  before: number,
  after: number,
  maxDatabases: number,
): Promise<QuotaIntent> {
  await reserveQuotaDatabase(
    factory,
    prefix,
    source.name,
    source.physical,
    maxDatabases,
  );
  return reserveQuotaCommit(
    factory,
    prefix,
    source,
    before,
    after,
    Number.MAX_SAFE_INTEGER,
    "replace",
  );
}
