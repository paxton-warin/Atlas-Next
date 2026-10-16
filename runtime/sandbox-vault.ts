/** Browser-local, node-independent storage for the sandbox runtime prototype.
 * No legacy node storage is read. A successful write resolves only on commit.
 * This is a broker API, NOT a synchronous localStorage replacement.
 */
export const SANDBOX_DATABASE = "atlas.browsing.v2";
export type StorageChange =
  | { op: "set"; key: string; value: string }
  | { op: "remove"; key: string }
  | { op: "clear" };
export type StorageSnapshot = { revision: number; entries: [string, string][] };

export function logicalStorageOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new TypeError("Invalid logical website origin.");
  return url.origin;
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error || new DOMException("Write aborted", "AbortError"),
      );
    transaction.onerror = () => {};
  });
}

export class SandboxVault {
  private database: Promise<IDBDatabase>;
  private limit: number;
  constructor(factory: IDBFactory, limit = 5 * 1024 * 1024) {
    this.limit = limit;
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(SANDBOX_DATABASE, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("origins");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new DOMException(
            "Close an older browsing storage connection",
            "InvalidStateError",
          ),
        );
    });
  }

  async snapshot(origin: string): Promise<StorageSnapshot> {
    origin = logicalStorageOrigin(origin);
    const db = await this.database;
    const transaction = db.transaction("origins", "readonly");
    const done = complete(transaction);
    const request = transaction.objectStore("origins").get(origin);
    await done;
    return request.result || { revision: 0, entries: [] };
  }

  async write(origin: string, change: StorageChange): Promise<StorageSnapshot> {
    origin = logicalStorageOrigin(origin);
    if (
      !change ||
      !["set", "remove", "clear"].includes(change.op) ||
      (change.op !== "clear" && typeof change.key !== "string") ||
      (change.op === "set" && typeof change.value !== "string")
    )
      throw new TypeError("Invalid storage operation.");
    const db = await this.database;
    // One native read/write transaction serializes competing tabs atomically.
    const transaction = db.transaction("origins", "readwrite");
    const done = complete(transaction);
    const store = transaction.objectStore("origins");
    const request = store.get(origin);
    let next!: StorageSnapshot;
    let failure: Error | undefined;
    request.onsuccess = () => {
      try {
        const previous: StorageSnapshot = request.result || {
          revision: 0,
          entries: [],
        };
        const entries = new Map(previous.entries);
        if (change.op === "clear") entries.clear();
        else if (change.op === "remove") entries.delete(change.key);
        else entries.set(change.key, change.value);
        let bytes = 0;
        for (const [key, value] of entries)
          bytes += 2 * (key.length + value.length);
        if (bytes > this.limit)
          throw new DOMException(
            "Website storage quota exceeded",
            "QuotaExceededError",
          );
        next = { revision: previous.revision + 1, entries: [...entries] };
        store.put(next, origin);
      } catch (error) {
        failure = error as Error;
        transaction.abort();
      }
    };
    try {
      await done;
    } catch (error) {
      throw failure || error;
    }
    return next;
  }

  async close() {
    (await this.database).close();
  }
}
