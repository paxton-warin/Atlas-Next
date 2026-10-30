import { appendLocalDirty } from "./local-dirty-v2.ts";
import type { StorageChange, StorageSnapshot } from "./sandbox-vault.ts";
export const LOCAL_STORAGE_VALUE_STORE = "values-v2";
export const LOCAL_STORAGE_RECEIPT_STORE = "receipts-v2";
export type LocalStorageNamespace = {
  origin: string;
  sessionId: string;
  kind: "local" | "session";
};
export const localStorageV2Key = (n: LocalStorageNamespace): IDBValidKey =>
  n.kind === "local" ? n.origin : ["session", n.sessionId, n.origin];
export const localStorageV2Prefix = (
  n: LocalStorageNamespace,
): IDBValidKey[] =>
  n.kind === "local" ? ["local", n.origin] : ["session", n.sessionId, n.origin];
export function localStorageV2Range(n: LocalStorageNamespace) {
  const prefix = localStorageV2Prefix(n),
    upper = [...prefix];
  upper[upper.length - 1] = String(upper.at(-1)) + "\0";
  return IDBKeyRange.bound(prefix, upper, false, true);
}
export function createLocalStorageV2Stores(db: IDBDatabase) {
  if (!db.objectStoreNames.contains("origins")) db.createObjectStore("origins");
  if (!db.objectStoreNames.contains(LOCAL_STORAGE_VALUE_STORE))
    db.createObjectStore(LOCAL_STORAGE_VALUE_STORE);
  if (!db.objectStoreNames.contains(LOCAL_STORAGE_RECEIPT_STORE))
    db.createObjectStore(LOCAL_STORAGE_RECEIPT_STORE);
}
export function readLocalStorageV2Snapshot(
  db: IDBDatabase,
  n: LocalStorageNamespace,
): Promise<StorageSnapshot> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["origins", LOCAL_STORAGE_VALUE_STORE]),
      meta = tx.objectStore("origins").get(localStorageV2Key(n)),
      cursor = tx
        .objectStore(LOCAL_STORAGE_VALUE_STORE)
        .openCursor(localStorageV2Range(n)),
      entries: [string, string][] = [];
    cursor.onsuccess = () => {
      if (cursor.result) {
        entries.push([
          String((cursor.result.key as IDBValidKey[]).at(-1)),
          cursor.result.value,
        ]);
        cursor.result.continue();
      }
    };
    tx.oncomplete = () =>
      resolve({ revision: meta.result?.revision || 0, entries });
    tx.onabort = () =>
      reject(
        tx.error ||
          new DOMException("Local storage read aborted", "AbortError"),
      );
  });
}
export type LocalStorageV2Delta = {
  revision: number;
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
  changed: boolean;
};
/** A mutation, bounded result identity and dirty marker commit together. No
 * native value is copied into a backup/replication journal. */
export function commitLocalStorageV2(options: {
  db: IDBDatabase;
  namespace: LocalStorageNamespace;
  documentId: string;
  sequence: number;
  change: StorageChange;
  quotaBytes: number;
  assertCurrent(): void;
  attach?(tx: IDBTransaction): void;
}): Promise<LocalStorageV2Delta> {
  const {
    db,
    namespace: n,
    documentId,
    sequence,
    change,
    quotaBytes,
    assertCurrent,
  } = options;
  return new Promise((resolve, reject) => {
    let failure: unknown, result: LocalStorageV2Delta;
    const tx = db.transaction(
        ["origins", LOCAL_STORAGE_VALUE_STORE, LOCAL_STORAGE_RECEIPT_STORE],
        "readwrite",
      ),
      meta = tx.objectStore("origins"),
      values = tx.objectStore(LOCAL_STORAGE_VALUE_STORE),
      receipts = tx.objectStore(LOCAL_STORAGE_RECEIPT_STORE),
      priorReceipt = receipts.get([documentId, sequence]);
    options.attach?.(tx);
    priorReceipt.onsuccess = () => {
      try {
        assertCurrent();
        if (priorReceipt.result) {
          result = {
            revision: priorReceipt.result.revision,
            key: null,
            oldValue: null,
            newValue: null,
            changed: false,
          };
          return;
        }
        const prior = meta.get(localStorageV2Key(n)),
          key = change.op === "clear" ? null : change.key,
          valueKey: IDBValidKey = [...localStorageV2Prefix(n), key || ""],
          old = key === null ? undefined : values.get(valueKey);
        const apply = () => {
          try {
            assertCurrent();
            const previous = prior.result || {
                revision: 0,
                bytes: 0,
                count: 0,
              },
              oldValue = old?.result ?? null,
              newValue = change.op === "set" ? change.value : null,
              changed =
                change.op === "clear"
                  ? previous.count > 0
                  : oldValue !== newValue;
            let bytes = previous.bytes,
              count = previous.count || 0;
            if (change.op === "clear") {
              bytes = 0;
              count = 0;
            } else {
              if (oldValue !== null) {
                bytes -= 2 * (change.key.length + oldValue.length);
                count--;
              }
              if (newValue !== null) {
                bytes += 2 * (change.key.length + newValue.length);
                count++;
              }
            }
            if (!Number.isSafeInteger(bytes) || bytes < 0)
              throw new DOMException(
                "Invalid local storage usage ledger",
                "InvalidStateError",
              );
            if (bytes > Math.max(quotaBytes, previous.bytes))
              throw new DOMException(
                "Website local storage allowance exhausted",
                "QuotaExceededError",
              );
            const revision = previous.revision + (changed ? 1 : 0);
            result = { revision, key, oldValue, newValue, changed };
            if (changed) {
              if (change.op === "clear") values.delete(localStorageV2Range(n));
              else if (newValue === null) values.delete(valueKey);
              else values.put(newValue, valueKey);
              meta.put(
                { revision, bytes, count, format: 2 },
                localStorageV2Key(n),
              );
              if (n.kind === "local")
                appendLocalDirty(meta, {
                  namespace: JSON.stringify(["local", n.origin, ""]),
                  operation:
                    change.op === "clear"
                      ? "clear"
                      : change.op === "remove"
                        ? "delete"
                        : "upsert",
                  key: key === null ? undefined : key,
                  estimatedNativeBytes:
                    newValue === null ? 0 : 2 * (key!.length + newValue.length),
                  shapeEligible: true,
                });
            }
            // Receipts are bounded identities/metadata, never another copy of a
            // potentially multi-megabyte website value or StorageEvent payload.
            receipts.put({ revision, accepted: true, createdAt: Date.now() }, [
              documentId,
              sequence,
            ]);
            if (sequence > 8)
              receipts.delete(
                IDBKeyRange.bound([documentId], [documentId, sequence - 8]),
              );
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
        if (old) old.onsuccess = apply;
        else prior.onsuccess = apply;
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result!);
    tx.onabort = () =>
      reject(
        failure ||
          tx.error ||
          new DOMException("Local storage mutation aborted", "AbortError"),
      );
    tx.onerror = () => {};
  });
}
