/** Asynchronous CacheStorage facade for one opaque document. Persistence and
 * ownership live in the trusted frontend, never in this physical opaque origin. */
import {
  SANDBOX_CACHE_LIMITS,
  SANDBOX_CACHE_PROTOCOL,
  type CacheEntryData,
  type CacheQueryData,
  type CacheRequestData,
  type CacheResponseData,
} from "./sandbox-cache-protocol.ts";

export type CacheResponseDescription = {
  type: ResponseType;
  url: string;
  redirected: boolean;
};
export function captureOpaqueCacheNatives(global: typeof globalThis) {
  return {
    Request: global.Request,
    Response: global.Response,
    Headers: global.Headers,
    URL: global.URL,
    DOMException: global.DOMException,
    Promise: global.Promise,
    WeakMap: global.WeakMap,
    Map: global.Map,
    Reflect: global.Reflect,
    Object: global.Object,
    MessageEvent: global.MessageEvent,
    MessagePort: global.MessagePort,
    ReadableStream: global.ReadableStream,
    ReadableStreamDefaultReader: global.ReadableStreamDefaultReader,
    Uint8Array: global.Uint8Array,
    ArrayBuffer: global.ArrayBuffer,
    setTimeout: global.setTimeout.bind(global),
    clearTimeout: global.clearTimeout.bind(global),
  };
}
export function createOpaqueCaches(options: {
  port: MessagePort;
  documentId: string;
  documentURL: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  natives?: ReturnType<typeof captureOpaqueCacheNatives>;
  describeResponse?: (
    response: Response,
  ) => CacheResponseDescription | undefined;
  rememberResponse?: (
    response: Response,
    description: CacheResponseDescription,
  ) => void;
  timeoutMs?: number;
}) {
  const n = options.natives ?? captureOpaqueCacheNatives(globalThis),
    {
      Request: NativeRequest,
      Response: NativeResponse,
      Headers: NativeHeaders,
      URL: NativeURL,
      Promise: NativePromise,
    } = n,
    apply = n.Reflect.apply,
    define = n.Object.defineProperty,
    defineAll = n.Object.defineProperties,
    descriptor = n.Object.getOwnPropertyDescriptor,
    create = n.Object.create,
    get = (prototype: object, name: string) =>
      descriptor(prototype, name)!.get!,
    rget = (name: string) => get(NativeResponse.prototype, name),
    qget = (name: string) => get(NativeRequest.prototype, name),
    responseType = rget("type"),
    responseURL = rget("url"),
    responseRedirected = rget("redirected"),
    responseStatus = rget("status"),
    responseStatusText = rget("statusText"),
    responseHeaders = rget("headers"),
    responseBody = rget("body"),
    responseBodyUsed = rget("bodyUsed"),
    nativeClone = NativeResponse.prototype.clone,
    requestURL = qget("url"),
    requestMethod = qget("method"),
    requestHeaders = qget("headers"),
    requestMode = qget("mode"),
    requestCredentials = qget("credentials"),
    requestRedirect = qget("redirect"),
    requestReferrer = qget("referrer"),
    requestReferrerPolicy = qget("referrerPolicy"),
    requestIntegrity = qget("integrity"),
    headerEach = NativeHeaders.prototype.forEach,
    nativeGetReader = n.ReadableStream.prototype.getReader,
    nativeLocked = get(n.ReadableStream.prototype, "locked"),
    nativeRead = n.ReadableStreamDefaultReader.prototype.read,
    nativeCancel = n.ReadableStreamDefaultReader.prototype.cancel,
    nativeRelease = n.ReadableStreamDefaultReader.prototype.releaseLock,
    nativeByteLength = get(n.ArrayBuffer.prototype, "byteLength"),
    typedPrototype = n.Object.getPrototypeOf(n.Uint8Array.prototype),
    typedTag = get(typedPrototype, Symbol.toStringTag as any),
    typedBytes = get(typedPrototype, "byteLength"),
    typedBuffer = get(typedPrototype, "buffer"),
    nativeSet = n.Uint8Array.prototype.set,
    promiseThen = NativePromise.prototype.then,
    promiseAll = NativePromise.all,
    weakGet = n.WeakMap.prototype.get,
    weakSet = n.WeakMap.prototype.set,
    mapGet = n.Map.prototype.get,
    mapSet = n.Map.prototype.set,
    mapDelete = n.Map.prototype.delete,
    mapSize = get(n.Map.prototype, "size"),
    mapForEach = n.Map.prototype.forEach,
    mapClear = n.Map.prototype.clear,
    eventData = get(n.MessageEvent.prototype, "data"),
    portPost = n.MessagePort.prototype.postMessage,
    portListen = n.MessagePort.prototype.addEventListener,
    portUnlisten = n.MessagePort.prototype.removeEventListener,
    portStart = n.MessagePort.prototype.start,
    portClose = n.MessagePort.prototype.close;
  const call = (fn: Function, receiver: any, args: any[] = []) =>
      apply(fn, receiver, args),
    then = (promise: any, yes: any, no?: any) =>
      call(promiseThen, promise, [yes, no]),
    reject = (error: any) =>
      new NativePromise<any>((_resolve, fail) => fail(error)),
    error = (name: string, message = "Cache operation failed") =>
      name === "TypeError"
        ? new TypeError(message)
        : new n.DOMException(message, name),
    wmGet = (map: WeakMap<any, any>, key: any) => call(weakGet, map, [key]),
    wmSet = (map: WeakMap<any, any>, key: any, value: any) =>
      call(weakSet, map, [key, value]);
  const timeoutMs = options.timeoutMs ?? 30000;
  if (
    !options.documentId ||
    options.documentId.length > 256 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw new TypeError("Invalid cache document binding");
  const documentURL = new NativeURL(options.documentURL);
  if (
    !["https:", "http:"].includes(documentURL.protocol) ||
    documentURL.username ||
    documentURL.password
  )
    throw new TypeError("Invalid cache document URL");
  const handles = new n.WeakMap<object, number>(),
    storageBrands = new n.WeakMap<object, boolean>(),
    responseMetadata = new n.WeakMap<Response, CacheResponseDescription>(),
    pending = new n.Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: any) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
  let live = true,
    sequence = 0;
  function rpc(payload: object) {
    if (!live) return reject(error("AbortError", "Cache document disposed"));
    if (call(mapSize, pending) >= SANDBOX_CACHE_LIMITS.maxPending)
      return reject(error("QuotaExceededError", "Cache concurrency limit"));
    const id = ++sequence;
    return new NativePromise<any>((resolve, fail) => {
      const timer = n.setTimeout(() => {
        call(mapDelete, pending, [id]);
        fail(error("TimeoutError"));
      }, timeoutMs);
      call(mapSet, pending, [id, { resolve, reject: fail, timer }]);
      try {
        call(portPost, options.port, [
          {
            protocol: SANDBOX_CACHE_PROTOCOL,
            documentId: options.documentId,
            type: "request",
            sequence: id,
            ...payload,
          },
        ]);
      } catch (e) {
        n.clearTimeout(timer);
        call(mapDelete, pending, [id]);
        fail(e);
      }
    });
  }
  const names = new Set([
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
  const receive = (event: MessageEvent) => {
    const m = call(eventData, event);
    if (
      !live ||
      !m ||
      m.protocol !== SANDBOX_CACHE_PROTOCOL ||
      m.documentId !== options.documentId ||
      m.type !== "response" ||
      !Number.isSafeInteger(m.sequence)
    )
      return;
    const item = call(mapGet, pending, [m.sequence]);
    if (!item) return;
    call(mapDelete, pending, [m.sequence]);
    n.clearTimeout(item.timer);
    if (m.ok === true) item.resolve(m.value);
    else item.reject(error(names.has(m.error) ? m.error : "UnknownError"));
  };
  const headerPairs = (headers: Headers): [string, string][] => {
    const pairs: [string, string][] = [];
    let bytes = 0;
    call(headerEach, headers, [
      (value: string, name: string) => {
        bytes += 2 * (name.length + value.length);
        if (
          pairs.length >= SANDBOX_CACHE_LIMITS.maxHeaders ||
          bytes > SANDBOX_CACHE_LIMITS.maxHeaderBytes
        )
          throw error("QuotaExceededError", "Cache headers exceed allowance");
        pairs[pairs.length] = [name, value];
      },
    ]);
    return pairs;
  };
  const cacheName = (value: any) => {
    const name = String(value);
    if (name.length > SANDBOX_CACHE_LIMITS.maxNameLength)
      throw error("QuotaExceededError", "Cache name exceeds allowance");
    return name;
  };
  function query(value?: MultiCacheQueryOptions): CacheQueryData {
    return {
      ignoreSearch: !!value?.ignoreSearch,
      ignoreMethod: !!value?.ignoreMethod,
      ignoreVary: !!value?.ignoreVary,
      ...(value?.cacheName === undefined
        ? {}
        : { cacheName: cacheName(value.cacheName) }),
    };
  }
  function request(input: RequestInfo | URL): CacheRequestData {
    let source: Request;
    try {
      call(requestURL, input);
      source = input as Request;
    } catch {
      source = new NativeRequest(
        new NativeURL(String(input), documentURL.href),
      );
    }
    const url = call(requestURL, source),
      parsed = new NativeURL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      url.length > SANDBOX_CACHE_LIMITS.maxURLLength
    )
      throw error("TypeError", "Cache requests require HTTP(S) URLs");
    return {
      url,
      method: call(requestMethod, source),
      headers: headerPairs(call(requestHeaders, source)),
      mode: call(requestMode, source),
      credentials: call(requestCredentials, source),
      redirect: call(requestRedirect, source),
      referrer: call(requestReferrer, source),
      referrerPolicy: call(requestReferrerPolicy, source),
      integrity: call(requestIntegrity, source),
    };
  }
  function key(value: CacheRequestData): Request {
    return new NativeRequest(value.url, {
      method: value.method,
      headers: value.headers,
      mode: value.mode === "navigate" ? "same-origin" : value.mode,
      credentials: value.credentials,
      redirect: value.redirect,
      referrer: value.referrer,
      referrerPolicy: value.referrerPolicy,
      integrity: value.integrity,
    });
  }
  function readBody(value: Response): Promise<ArrayBuffer | null> {
    if (call(responseBodyUsed, value))
      return reject(error("TypeError", "Response body is already used"));
    const stream = call(responseBody, value);
    if (stream === null) return new NativePromise((resolve) => resolve(null));
    if (call(nativeLocked, stream))
      return reject(error("TypeError", "Response body is locked"));
    const reader = call(nativeGetReader, stream),
      chunks: Uint8Array[] = [];
    let length = 0;
    // Starting the first native read here (before returning) preserves native
    // Cache.put's synchronous body disturbance, with bounded streaming reads.
    const first = call(nativeRead, reader);
    return (async () => {
      try {
        let result = await first;
        while (!result.done) {
          if (call(typedTag, result.value) !== "Uint8Array")
            throw error(
              "TypeError",
              "Cache response stream must contain bytes",
            );
          const size = call(typedBytes, result.value);
          length += size;
          if (length > SANDBOX_CACHE_LIMITS.maxBodyBytes)
            throw error("QuotaExceededError", "Cache body exceeds allowance");
          const copy = new n.Uint8Array(size);
          call(nativeSet, copy, [result.value]);
          chunks[chunks.length] = copy;
          result = await call(nativeRead, reader);
        }
        const resultBytes = new n.Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          call(nativeSet, resultBytes, [chunk, offset]);
          offset += call(typedBytes, chunk);
        }
        return call(typedBuffer, resultBytes);
      } catch (e) {
        try {
          await call(nativeCancel, reader);
        } catch {}
        throw e;
      } finally {
        try {
          call(nativeRelease, reader);
        } catch {}
      }
    })();
  }
  function responseRecord(value: Response): Promise<CacheResponseData> {
    // These captured native getters enforce Response brands. Public instance
    // properties and poisoned prototype getters are never the authority.
    const status = call(responseStatus, value),
      statusText = call(responseStatusText, value),
      headers = headerPairs(call(responseHeaders, value)),
      metadata = wmGet(responseMetadata, value) ??
        options.describeResponse?.(value) ?? {
          type: call(responseType, value),
          url: call(responseURL, value),
          redirected: call(responseRedirected, value),
        };
    if (metadata.type === "opaque" || metadata.type === "opaqueredirect")
      return reject(
        error(
          "NotSupportedError",
          "Opaque cache payload handles are not supported",
        ),
      );
    if (
      !["default", "basic", "cors", "error"].includes(metadata.type) ||
      status === 206 ||
      headers.some(
        ([name, v]) =>
          name === "vary" && v.split(",").some((x) => x.trim() === "*"),
      )
    )
      return reject(error("TypeError", "Response cannot be stored in Cache"));
    return then(readBody(value), (body: ArrayBuffer | null) => ({
      type: metadata.type,
      url: metadata.url,
      redirected: metadata.redirected,
      status,
      statusText,
      headers,
      body,
    }));
  }
  function response(value: CacheResponseData): Response {
    const result =
        value.type === "error"
          ? NativeResponse.error()
          : new NativeResponse(value.body, {
              status: value.status,
              statusText: value.statusText,
              headers: value.headers,
            }),
      metadata = {
        type: value.type,
        url: value.url,
        redirected: value.redirected,
      };
    const decorate = (target: Response): Response => {
      wmSet(responseMetadata, target, metadata);
      // The network owner is the shared response/clone authority when present;
      // it may install nonconfigurable own descriptors. Never redecorate it.
      if (options.rememberResponse) {
        options.rememberResponse(target, metadata);
        return target;
      }
      defineAll(target, {
        type: { value: metadata.type },
        url: { value: metadata.url },
        redirected: { value: metadata.redirected },
        clone: { value: () => decorate(call(nativeClone, target)) },
      });
      return target;
    };
    return decorate(result);
  }
  function handle(value: object): number {
    const id = wmGet(handles, value);
    if (id === undefined) throw error("TypeError", "Illegal Cache invocation");
    return id;
  }
  function storage(value: object) {
    if (!wmGet(storageBrands, value))
      throw error("TypeError", "Illegal CacheStorage invocation");
  }
  const guarded = (fn: () => Promise<any>) => {
    try {
      return fn();
    } catch (e) {
      return reject(e);
    }
  };
  class OpaqueCache {
    constructor() {
      throw error("TypeError", "Illegal Cache constructor");
    }
    match(
      input: RequestInfo | URL,
      opts?: CacheQueryOptions,
    ): Promise<Response | undefined> {
      return guarded(() =>
        then(
          rpc({
            op: "match",
            cacheId: handle(this),
            request: request(input),
            query: query(opts),
          }),
          (value: any) => (value === undefined ? undefined : response(value)),
        ),
      );
    }
    matchAll(
      input?: RequestInfo | URL,
      opts?: CacheQueryOptions,
    ): Promise<readonly Response[]> {
      return guarded(() =>
        then(
          rpc({
            op: "match-all",
            cacheId: handle(this),
            ...(input === undefined ? {} : { request: request(input) }),
            query: query(opts),
          }),
          (values: CacheResponseData[]) => values.map(response),
        ),
      );
    }
    keys(
      input?: RequestInfo | URL,
      opts?: CacheQueryOptions,
    ): Promise<readonly Request[]> {
      return guarded(() =>
        then(
          rpc({
            op: "keys",
            cacheId: handle(this),
            ...(input === undefined ? {} : { request: request(input) }),
            query: query(opts),
          }),
          (values: CacheRequestData[]) => values.map(key),
        ),
      );
    }
    delete(
      input: RequestInfo | URL,
      opts?: CacheQueryOptions,
    ): Promise<boolean> {
      return guarded(() =>
        rpc({
          op: "delete",
          cacheId: handle(this),
          request: request(input),
          query: query(opts),
        }),
      );
    }
    put(input: RequestInfo | URL, value: Response): Promise<void> {
      return guarded(() => {
        const cacheId = handle(this),
          req = request(input);
        if (req.method !== "GET")
          throw error("TypeError", "Cache put requires GET");
        return then(responseRecord(value), (res: CacheResponseData) =>
          rpc({
            op: "put-batch",
            cacheId,
            entries: [{ request: req, response: res }],
          }),
        );
      });
    }
    add(input: RequestInfo | URL): Promise<void> {
      return call(addAllMethod, this, [[input]]);
    }
    addAll(inputs: Iterable<RequestInfo | URL>): Promise<void> {
      return guarded(() => {
        const cacheId = handle(this),
          requests: CacheRequestData[] = [];
        for (const input of inputs) {
          if (requests.length >= SANDBOX_CACHE_LIMITS.maxBatch)
            throw error("QuotaExceededError", "Cache batch exceeds allowance");
          const req = request(input);
          if (req.method !== "GET")
            throw error("TypeError", "Cache add requires GET");
          requests[requests.length] = req;
        }
        if (!requests.length)
          return new NativePromise((resolve) => resolve(undefined));
        const fetches = requests.map((req) =>
          then(options.fetch(key(req)), (res: Response) => {
            const status = call(responseStatus, res);
            if (status < 200 || status > 299)
              throw error(
                "TypeError",
                "Cache add requires a successful response",
              );
            return then(responseRecord(res), (value: CacheResponseData) => ({
              request: req,
              response: value,
            }));
          }),
        );
        return then(
          call(promiseAll, NativePromise, [fetches]),
          (entries: CacheEntryData[]) =>
            rpc({ op: "put-batch", cacheId, entries }),
        );
      });
    }
  }
  const addAllMethod = OpaqueCache.prototype.addAll;
  class OpaqueCacheStorage {
    constructor() {
      throw error("TypeError", "Illegal CacheStorage constructor");
    }
    open(name: string): Promise<Cache> {
      return guarded(() => {
        storage(this);
        return then(
          rpc({ op: "open", name: cacheName(name) }),
          (id: number) => {
            if (!Number.isSafeInteger(id) || id < 1)
              throw error("UnknownError");
            const result = create(OpaqueCache.prototype);
            wmSet(handles, result, id);
            return result;
          },
        );
      });
    }
    has(name: string): Promise<boolean> {
      return guarded(() => {
        storage(this);
        return rpc({ op: "has", name: cacheName(name) });
      });
    }
    keys(): Promise<string[]> {
      return guarded(() => {
        storage(this);
        return rpc({ op: "storage-keys" });
      });
    }
    delete(name: string): Promise<boolean> {
      return guarded(() => {
        storage(this);
        return rpc({ op: "storage-delete", name: cacheName(name) });
      });
    }
    match(
      input: RequestInfo | URL,
      opts?: MultiCacheQueryOptions,
    ): Promise<Response | undefined> {
      return guarded(() => {
        storage(this);
        return then(
          rpc({
            op: "storage-match",
            request: request(input),
            query: query(opts),
          }),
          (value: any) => (value === undefined ? undefined : response(value)),
        );
      });
    }
  }
  define(OpaqueCache, "name", { value: "Cache" });
  define(OpaqueCacheStorage, "name", { value: "CacheStorage" });
  define(OpaqueCache.prototype, Symbol.toStringTag, {
    value: "Cache",
    configurable: true,
  });
  define(OpaqueCacheStorage.prototype, Symbol.toStringTag, {
    value: "CacheStorage",
    configurable: true,
  });
  const caches = create(OpaqueCacheStorage.prototype) as CacheStorage;
  wmSet(storageBrands, caches, true);
  function dispose() {
    if (!live) return;
    live = false;
    call(portUnlisten, options.port, ["message", receive]);
    call(portUnlisten, options.port, ["messageerror", dispose]);
    call(mapForEach, pending, [
      (item: any) => {
        n.clearTimeout(item.timer);
        item.reject(error("AbortError", "Cache document disposed"));
      },
    ]);
    call(mapClear, pending);
    call(portClose, options.port);
  }
  function install(global: typeof globalThis) {
    defineAll(global, {
      caches: { value: caches, writable: true, configurable: true },
      Cache: { value: OpaqueCache, writable: true, configurable: true },
      CacheStorage: {
        value: OpaqueCacheStorage,
        writable: true,
        configurable: true,
      },
    });
  }
  call(portListen, options.port, ["message", receive]);
  call(portListen, options.port, ["messageerror", dispose]);
  call(portStart, options.port);
  return {
    caches,
    Cache: OpaqueCache as unknown as typeof Cache,
    CacheStorage: OpaqueCacheStorage as unknown as typeof CacheStorage,
    dispose,
    install,
  };
}
