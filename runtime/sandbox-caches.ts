/** Trusted CacheStorage owner. Native IDB serializes each origin's complete
 * mutation atomically; a success reply is sent only after transaction commit.
 * No HTTP, cookies, frontend storage handles or node identity cross this port. */
import {
  SANDBOX_CACHE_DATABASE,
  SANDBOX_CACHE_LIMITS,
  SANDBOX_CACHE_PROTOCOL,
  cacheFailure,
  cacheMatches,
  cacheStateBytes,
  checkedCacheQuery,
  checkedCacheRequest,
  checkedCacheResponse,
  emptyCacheState,
  type CacheEntryData,
  type CacheState,
} from "./sandbox-cache-protocol.ts";

export function bindSandboxCaches(options: {
  port: MessagePort;
  documentId: string;
  website: string;
  frontendOrigin?: string;
  factory: IDBFactory;
  maxBytes?: number;
  timeoutMs?: number;
}) {
  const site = new URL(options.website),
    front = options.frontendOrigin ? new URL(options.frontendOrigin) : null;
  if (
    !["http:", "https:"].includes(site.protocol) ||
    site.username ||
    site.password ||
    (front && site.hostname === front.hostname) ||
    typeof options.documentId !== "string" ||
    !options.documentId ||
    options.documentId.length > 256
  )
    throw new TypeError("Invalid CacheStorage identity");
  const origin = site.origin,
    { port, documentId, factory } = options,
    maxBytes = options.maxBytes ?? SANDBOX_CACHE_LIMITS.maxBytes,
    timeoutMs = options.timeoutMs ?? 30000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256 ||
    maxBytes > SANDBOX_CACHE_LIMITS.maxBytes ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw new TypeError("Invalid CacheStorage limit");
  const post = port.postMessage.bind(port),
    listen = port.addEventListener.bind(port),
    unlisten = port.removeEventListener.bind(port),
    close = port.close.bind(port),
    start = port.start.bind(port);
  const handles = new Map<number, number>(),
    recordHandles = new Map<number, number>(),
    transactions = new Set<IDBTransaction>();
  let live = true,
    lastSequence = 0,
    pending = 0,
    nextHandle = 1,
    dbPromise: Promise<IDBDatabase> | undefined;
  const database = () =>
    (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(SANDBOX_CACHE_DATABASE, 1);
      let settled = false;
      open.onupgradeneeded = () => open.result.createObjectStore("origins");
      open.onerror = () => {
        settled = true;
        reject(open.error ?? cacheFailure("UnknownError"));
      };
      open.onblocked = () => {
        settled = true;
        reject(cacheFailure("InvalidStateError", "Cache database blocked"));
      };
      open.onsuccess = () => {
        const db = open.result;
        if (settled || !live) {
          db.close();
          reject(cacheFailure("AbortError"));
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          dispose();
        };
        resolve(db);
      };
    }));
  const validName = (name: any) => {
    if (
      typeof name !== "string" ||
      name.length > SANDBOX_CACHE_LIMITS.maxNameLength
    )
      throw cacheFailure("TypeError", "Invalid cache name");
    return name;
  };
  const operation = (
    m: any,
  ): { write: boolean; run: (state: CacheState) => any; handle?: boolean } => {
    switch (m.op) {
      case "open": {
        const name = validName(m.name);
        return {
          write: true,
          handle: true,
          run(state) {
            const found = state.names.find((x) => x.name === name);
            if (found) return found.id;
            const id = state.nextId++;
            if (!Number.isSafeInteger(state.nextId))
              throw cacheFailure("QuotaExceededError");
            state.names.push({ name, id });
            state.caches.push({ id, entries: [] });
            return id;
          },
        };
      }
      case "has": {
        const name = validName(m.name);
        return {
          write: false,
          run: (state) => state.names.some((x) => x.name === name),
        };
      }
      case "storage-keys":
        return { write: false, run: (state) => state.names.map((x) => x.name) };
      case "storage-delete": {
        const name = validName(m.name);
        return {
          write: true,
          run(state) {
            const i = state.names.findIndex((x) => x.name === name);
            if (i < 0) return false;
            // Native held Cache handles remain live after name deletion. Records
            // stay bounded and charged, rather than silently invalidating them.
            state.names.splice(i, 1);
            return true;
          },
        };
      }
      case "storage-match": {
        const request = checkedCacheRequest(m.request),
          query = checkedCacheQuery(m.query);
        return {
          write: false,
          run(state) {
            for (const name of state.names) {
              if (
                query.cacheName !== undefined &&
                query.cacheName !== name.name
              )
                continue;
              const item = state.caches
                .find((x) => x.id === name.id)
                ?.entries.find((x) => cacheMatches(x, request, query));
              if (item) return item.response;
            }
            return undefined;
          },
        };
      }
      case "match":
      case "match-all":
      case "keys":
      case "delete":
      case "put-batch":
        break;
      default:
        throw cacheFailure("TypeError", "Unknown cache operation");
    }
    if (!Number.isSafeInteger(m.cacheId) || !handles.has(m.cacheId))
      throw cacheFailure("InvalidStateError", "Unknown cache handle");
    const id = handles.get(m.cacheId)!;
    const request =
        m.request === undefined ? undefined : checkedCacheRequest(m.request),
      query = m.op === "put-batch" ? undefined : checkedCacheQuery(m.query);
    if ((m.op === "match" || m.op === "delete") && !request)
      throw cacheFailure("TypeError", "Missing cache request");
    let entries: CacheEntryData[] | undefined;
    if (m.op === "put-batch") {
      if (
        !Array.isArray(m.entries) ||
        m.entries.length < 1 ||
        m.entries.length > SANDBOX_CACHE_LIMITS.maxBatch
      )
        throw cacheFailure("TypeError", "Invalid cache batch");
      const batch: CacheEntryData[] = m.entries.map((e: any) => ({
        request: checkedCacheRequest(e?.request),
        response: checkedCacheResponse(e?.response),
      }));
      entries = batch;
      const opts = {
        ignoreMethod: false,
        ignoreSearch: false,
        ignoreVary: false,
      };
      for (let i = 0; i < batch.length; i++) {
        if (batch[i].request.method !== "GET")
          throw cacheFailure("TypeError", "Cache put requires GET");
        if (
          batch.slice(0, i).some((e) => cacheMatches(e, batch[i].request, opts))
        )
          throw cacheFailure(
            "InvalidStateError",
            "Duplicate matching batch entries",
          );
      }
    }
    return {
      write: m.op === "put-batch" || m.op === "delete",
      run(state) {
        const cache = state.caches.find((x) => x.id === id);
        if (!cache)
          throw cacheFailure("InvalidStateError", "Cache record is missing");
        const matches = (entry: CacheEntryData) =>
          !request || cacheMatches(entry, request, query!);
        if (m.op === "match") return cache.entries.find(matches)?.response;
        if (m.op === "match-all")
          return cache.entries.filter(matches).map((x) => x.response);
        if (m.op === "keys")
          return cache.entries.filter(matches).map((x) => x.request);
        if (m.op === "delete") {
          const before = cache.entries.length;
          cache.entries = cache.entries.filter((x) => !matches(x));
          return before !== cache.entries.length;
        }
        for (const entry of entries!) {
          cache.entries = cache.entries.filter(
            (x) =>
              !cacheMatches(x, entry.request, {
                ignoreMethod: false,
                ignoreSearch: false,
                ignoreVary: false,
              }),
          );
          cache.entries.push(entry);
        }
        return undefined;
      },
    };
  };
  async function transact(op: ReturnType<typeof operation>) {
    const db = await database();
    if (!live) throw cacheFailure("AbortError");
    const value = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction("origins", op.write ? "readwrite" : "readonly"),
        store = tx.objectStore("origins");
      transactions.add(tx);
      let result: any, failure: any;
      const timer = setTimeout(() => {
        failure = cacheFailure("TimeoutError");
        try {
          tx.abort();
        } catch {}
      }, timeoutMs);
      tx.oncomplete = () => {
        clearTimeout(timer);
        transactions.delete(tx);
        resolve(result);
      };
      tx.onabort = () => {
        clearTimeout(timer);
        transactions.delete(tx);
        reject(failure ?? tx.error ?? cacheFailure("AbortError"));
      };
      tx.onerror = () => {};
      const get = store.get(origin);
      get.onsuccess = () => {
        try {
          const state: CacheState = get.result ?? emptyCacheState();
          if (state.version !== 1)
            throw cacheFailure("InvalidStateError", "Unknown cache schema");
          result = op.run(state);
          if (op.write) {
            if (cacheStateBytes(state) > maxBytes)
              throw cacheFailure(
                "QuotaExceededError",
                "Logical cache quota exceeded",
              );
            store.put(state, origin);
          }
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
    if (op.handle) {
      const existing = recordHandles.get(value);
      if (existing !== undefined) return existing;
      const handle = nextHandle++;
      handles.set(handle, value);
      recordHandles.set(value, handle);
      return handle;
    }
    return value;
  }
  const errorNames = new Set([
    "TypeError",
    "AbortError",
    "InvalidStateError",
    "InvalidAccessError",
    "NotSupportedError",
    "QuotaExceededError",
    "UnknownError",
    "TimeoutError",
    "DataCloneError",
  ]);
  function reply(sequence: number, ok: boolean, value?: any, error?: any) {
    if (!live) return;
    try {
      post({
        protocol: SANDBOX_CACHE_PROTOCOL,
        documentId,
        type: "response",
        sequence,
        ok,
        ...(ok
          ? { value }
          : {
              error: errorNames.has(error?.name) ? error.name : "UnknownError",
            }),
      });
    } catch {
      dispose();
    }
  }
  const receive = (event: MessageEvent) => {
    const m = event.data;
    if (
      !live ||
      !m ||
      m.protocol !== SANDBOX_CACHE_PROTOCOL ||
      m.documentId !== documentId ||
      m.type !== "request" ||
      !Number.isSafeInteger(m.sequence) ||
      m.sequence <= lastSequence
    )
      return;
    lastSequence = m.sequence;
    if (pending >= SANDBOX_CACHE_LIMITS.maxPending) {
      reply(m.sequence, false, undefined, cacheFailure("QuotaExceededError"));
      return;
    }
    let op: ReturnType<typeof operation>;
    try {
      op = operation(m);
    } catch (error) {
      reply(m.sequence, false, undefined, error);
      return;
    }
    pending++;
    void transact(op)
      .then(
        (value) => reply(m.sequence, true, value),
        (error) => reply(m.sequence, false, undefined, error),
      )
      .finally(() => pending--);
  };
  function dispose() {
    if (!live) return;
    live = false;
    unlisten("message", receive);
    unlisten("messageerror", dispose);
    for (const tx of transactions)
      try {
        tx.abort();
      } catch {}
    handles.clear();
    recordHandles.clear();
    void dbPromise?.then(
      (db) => db.close(),
      () => {},
    );
    close();
  }
  listen("message", receive);
  listen("messageerror", dispose);
  start();
  return { dispose };
}
