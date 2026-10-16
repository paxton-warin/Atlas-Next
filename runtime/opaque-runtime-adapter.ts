/**
 * Document-local half of the opaque runtime's network boundary. This module
 * never receives a relay ticket, an Atlas session, a cookie jar, or a parent DOM.
 * The trusted peer owns logical-origin/CORS/cookie decisions. It must not treat
 * a child-supplied destination as authority to return cross-origin bodies.
 *
 * This is the buffered fetch path, NOT a native resource gateway. Native script,
 * CSS, ESM graphs, workers, media and synchronous XHR remain qualification gates.
 */
export const OPAQUE_NETWORK_PROTOCOL = "atlas-network-v2";
import { resourceResponseBudget } from "./resource-response-budget.ts";
export const PINNED_OPAQUE_CORE_VERSION = "2.0.67-alpha.2";
export type OpaqueNetworkRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body?: ArrayBuffer;
  credentials: "omit" | "same-origin" | "include";
  mode: "cors" | "no-cors" | "same-origin";
  destination?: string;
  policyNonce?: string;
  policyIntegrity?: string;
  isModule?: boolean;
  forcePreflight?: boolean;
  redirect?: "follow" | "error" | "manual";
};
export type OpaqueNetworkResponse = {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
  type?: "basic" | "cors" | "opaque" | "opaqueredirect";
  redirected?: boolean;
};
export class OpaqueNetworkError extends TypeError {
  code: string;
  constructor(code: string, message = "Website network request failed.") {
    super(message);
    this.name = "OpaqueNetworkError";
    this.code = code;
  }
}

type Pending = {
  responseLimit: number;
  resolve: (value: OpaqueNetworkResponse) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
};
const abortError = (signal?: AbortSignal) =>
  signal?.reason ??
  new DOMException("The operation was aborted.", "AbortError");
const validHeaders = (headers: unknown): headers is [string, string][] =>
  Array.isArray(headers) &&
  headers.length <= 512 &&
  headers.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      pair.every((value) => typeof value === "string" && value.length <= 65536),
  );
function websiteURL(value: string, base: string) {
  const url = new URL(value, base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new TypeError(
      "Website requests require an HTTP(S) URL without credentials.",
    );
  // Fragments are document state, never part of an HTTP request.
  url.hash = "";
  return url;
}

/** Private filtered-response authority shared only by clients in this realm.
 * A prototype clone call must not turn an opaque/CORS response into a default
 * synthetic response when a website bypasses its instance clone method. */
type CacheResponseMetadata = Readonly<{ type: ResponseType; url: string; redirected: boolean }>;
const responseAuthorities = new WeakMap<object, {
  retain(): void;
  release(): void;
  remember(response: Response, metadata: CacheResponseMetadata): void;
  describe(response: Response): CacheResponseMetadata | undefined;
}>();
function retainResponseAuthority(NativeResponse: typeof Response) {
  const prototype = NativeResponse.prototype;
  let authority = responseAuthorities.get(prototype);
  if (!authority) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "clone");
    if (!descriptor || typeof descriptor.value !== "function")
      throw new TypeError("Native Response clone required");
    const nativeClone = descriptor.value, apply = Reflect.apply,
      define = Object.defineProperty, defineAll = Object.defineProperties,
      ownDescriptor = Object.getOwnPropertyDescriptor, freeze = Object.freeze,
      map = new WeakMap<Response, CacheResponseMetadata>(),
      get = WeakMap.prototype.get, set = WeakMap.prototype.set;
    let references = 0;
    function remember(response: Response, input: CacheResponseMetadata) {
      const metadata = freeze({type: input.type, url: input.url, redirected: input.redirected});
      apply(set, map, [response, metadata]);
      defineAll(response, {
        type: {value: metadata.type}, url: {value: metadata.url},
        redirected: {value: metadata.redirected},
        clone: {value: () => apply(clone, response, [])},
      });
    }
    function clone(this: Response) {
      // Native clone performs the brand/locked/disturbed-body checks first.
      const result = apply(nativeClone, this, []) as Response, metadata = apply(get, map, [this]);
      if (metadata) remember(result, metadata);
      return result;
    }
    authority = {
      retain() {
        if (references++ === 0) define(prototype, "clone", {...descriptor, value: clone});
      },
      release() {
        if (--references === 0 && ownDescriptor(prototype, "clone")?.value === clone)
          define(prototype, "clone", descriptor);
      },
      remember,
      describe(response) { return apply(get, map, [response]); },
    };
    responseAuthorities.set(prototype, authority);
  }
  authority.retain();
  return authority;
}

export function createOpaqueNetworkClient(options: {
  port: MessagePort;
  documentId: string;
  documentURL: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxPending?: number;
  /** Optional fail-fast/lower queue bound; default is1024, never higher. */
  maxQueued?: number;
  /** Undo ONLY this document's rewriting prefix. The trusted peer still checks it. */
  restoreURL?: (url: string) => string;
  natives?: {
    Request: typeof Request;
    Response: typeof Response;
    Headers: typeof Headers;
  };
}) {
  const { port, documentId } = options;
  const documentURL = websiteURL(options.documentURL, options.documentURL).href;
  if (!documentId || documentId.length > 256)
    throw new TypeError("Invalid document binding.");
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const maxPending = options.maxPending ?? 32;
  const maxQueued = options.maxQueued ?? 1024;
  const requestBytesLimit = 4 * 1024 * 1024;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 256 ||
    !Number.isSafeInteger(maxQueued) ||
    maxQueued < 0 ||
    maxQueued > 1024
  )
    throw new TypeError("Invalid network boundary limits.");
  // Capture before the real RuntimeKitClient installs website hooks.
  const NativeRequest = options.natives?.Request ?? Request;
  const NativeResponse = options.natives?.Response ?? Response;
  const NativeHeaders = options.natives?.Headers ?? Headers;
  const responseAuthority = retainResponseAuthority(NativeResponse);
  const post = port.postMessage.bind(port);
  const apply = Reflect.apply;
  const dataGetter = Object.getOwnPropertyDescriptor(
    MessageEvent.prototype,
    "data",
  )!.get!;
  const listen = port.addEventListener.bind(port),
    remove = port.removeEventListener.bind(port),
    start = port.start.bind(port),
    close = port.close.bind(port);
  type Admission = Pending & {
    request: OpaqueNetworkRequest;
    size: number;
    id?: number;
    queued: boolean;
    done: boolean;
    deadline: number;
  };
  const pending = new Map<number, Admission>(),
    posted = new Map<number, { size: number; timer?: ReturnType<typeof setTimeout> }>(),
    waiting: Admission[] = [];
  const stringify = JSON.stringify,
    bufferSlice = ArrayBuffer.prototype.slice,
    now = Date.now.bind(Date),
    setTimer = setTimeout.bind(globalThis),
    clearTimer = clearTimeout.bind(globalThis);
  let live = true,
    sequence = 0,
    postedBytes = 0,
    queuedBytes = 0;
  const next = () => {
    if (!Number.isSafeInteger(++sequence))
      throw new OpaqueNetworkError("sequence_exhausted");
    return sequence;
  };
  const cancel = (targetSequence: number) => {
    if (!live) return;
    try {
      post({
        protocol: OPAQUE_NETWORK_PROTOCOL,
        documentId,
        sequence: next(),
        type: "cancel",
        targetSequence,
      });
    } catch {
      dispose(new OpaqueNetworkError("network_port_closed"));
    }
  };
  const releasePosted = (id: number) => {
    const slot = posted.get(id);
    if (!slot) return;
    posted.delete(id);
    postedBytes -= slot.size;
    if (slot.timer !== undefined) clearTimer(slot.timer);
  };
  const finish = (
    id: number,
    error?: unknown,
    response?: OpaqueNetworkResponse,
    retire = true,
  ) => {
    const item = pending.get(id);
    if (retire) releasePosted(id);
    if (item) {
      pending.delete(id);
      item.done = true;
      clearTimer(item.timer);
      item.detach();
      if (error !== undefined) item.reject(error);
      else item.resolve(response!);
    }
    if (retire) drain();
  };
  const dispose = (
    reason: unknown = new OpaqueNetworkError("document_disposed"),
  ) => {
    if (!live) return;
    live = false;
    remove("message", receive);
    remove("messageerror", messageError);
    responseAuthority.release();
    for (const item of waiting) {
      item.done = true;
      clearTimer(item.timer);
      item.detach();
      item.reject(reason);
    }
    waiting.length = 0;
    queuedBytes = 0;
    for (const id of pending.keys()) finish(id, reason);
    for (const id of posted.keys()) releasePosted(id);
    close();
  };
  function stop(item: Admission, reason: unknown) {
    if (item.done) return;
    if (item.queued) {
      const index = waiting.indexOf(item);
      if (index !== -1) waiting.splice(index, 1);
      queuedBytes -= item.size;
      item.done = true;
      clearTimer(item.timer);
      item.detach();
      item.reject(reason);
      drain();
      return;
    }
    // Reject the caller immediately, but do not lend the still-posted peer slot
    // to another request until its original response/error settles. A cancel
    // acknowledgement alone does not prove an abort-ignoring transport ended.
    const id = item.id!;
    finish(id, reason, undefined, false);
    cancel(id);
    const slot = posted.get(id);
    if (slot)
      slot.timer = setTimer(
        () => dispose(new OpaqueNetworkError("network_timeout")),
        Math.min(timeoutMs, 15000),
      );
  }
  function drain() {
    while (live && waiting.length && posted.size < maxPending) {
      const item = waiting[0];
      if (postedBytes + item.size > requestBytesLimit) return;
      waiting.shift();
      queuedBytes -= item.size;
      item.queued = false;
      if (item.done) continue;
      if (now() >= item.deadline) {
        item.done = true;
        clearTimer(item.timer);
        item.detach();
        item.reject(new OpaqueNetworkError("network_timeout"));
        continue;
      }
      let id: number;
      try {
        id = next();
        item.id = id;
        pending.set(id, item);
        posted.set(id, { size: item.size });
        postedBytes += item.size;
        const body = item.request.body;
        post(
          { protocol: OPAQUE_NETWORK_PROTOCOL, documentId,
            sequence: id, type: "fetch", request: item.request },
          body ? [body] : [],
        );
      } catch (error) {
        // A failed post may have consumed a sequence without reaching the peer;
        // retire this channel rather than emit a later protocol gap.
        if (item.id !== undefined) finish(item.id, error, undefined, false);
        else {
          item.done = true; clearTimer(item.timer); item.detach(); item.reject(error);
        }
        dispose(new OpaqueNetworkError("network_port_closed"));
      }
    }
  }
  const messageError = () =>
    dispose(new OpaqueNetworkError("message_deserialization_failed"));
  const receive = (event: MessageEvent) => {
    const message = apply(dataGetter, event, []);
    if (
      !live ||
      !message ||
      message.protocol !== OPAQUE_NETWORK_PROTOCOL ||
      message.documentId !== documentId ||
      !posted.has(message.sequence) ||
      !["response", "error"].includes(message.type)
    )
      return;
    if (!pending.has(message.sequence)) {
      releasePosted(message.sequence);
      drain();
      return;
    }
    if (message.type === "error" && typeof message.code === "string") {
      finish(
        message.sequence,
        new OpaqueNetworkError(
          message.code.slice(0, 128),
          typeof message.message === "string"
            ? message.message.slice(0, 1024)
            : undefined,
        ),
      );
      return;
    }
    const value = message.response as OpaqueNetworkResponse;
    let valid =
      message.type === "response" &&
      !!value &&
      (value.type === undefined ||
        ["basic", "cors", "opaque", "opaqueredirect"].includes(value.type)) &&
      typeof value.url === "string" &&
      typeof value.statusText === "string" &&
      value.statusText.length <= 1024 &&
      validHeaders(value.headers) &&
      value.body instanceof ArrayBuffer &&
      value.body.byteLength <= pending.get(message.sequence)!.responseLimit &&
      (value.redirected === undefined || typeof value.redirected === "boolean");
    if (valid && (value.type === "opaque" || value.type === "opaqueredirect"))
      valid =
        value.status === 0 &&
        (value.type === "opaque"
          ? value.url === ""
          : (() => {
              try {
                return websiteURL(value.url, documentURL).href === value.url;
              } catch {
                return false;
              }
            })()) &&
        value.headers.length === 0 &&
        value.body.byteLength === 0;
    else if (valid) {
      valid =
        Number.isInteger(value.status) &&
        value.status >= 200 &&
        value.status <= 599;
      try {
        websiteURL(value.url, documentURL);
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      finish(
        message.sequence,
        new OpaqueNetworkError("invalid_network_response"),
      );
      return;
    }
    finish(message.sequence, undefined, value);
  };
  listen("message", receive);
  listen("messageerror", messageError);
  start();

  async function request(request: OpaqueNetworkRequest, signal?: AbortSignal) {
    if (!live) throw new OpaqueNetworkError("document_disposed");
    if (signal?.aborted) throw abortError(signal);
    const deadline = now() + timeoutMs;
    const url = websiteURL(request.url, documentURL).href;
    if (
      !validHeaders(request.headers) ||
      !["omit", "same-origin", "include"].includes(request.credentials) ||
      !["cors", "no-cors", "same-origin"].includes(request.mode) ||
      (request.forcePreflight !== undefined && typeof request.forcePreflight !== "boolean") ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method) ||
      (request.body !== undefined &&
        (!(request.body instanceof ArrayBuffer) || request.body.byteLength > maxBodyBytes))
    ) throw new TypeError("Invalid website network request.");
    // Identical cost to the trusted broker: both queued and posted allowances
    // are bounded. An individual request that cannot fit must never wait forever.
    const size = (request.body?.byteLength ?? 0) + stringify([url, request.headers]).length * 2;
    if (size > requestBytesLimit) throw new OpaqueNetworkError("network_backpressure");
    const immediate = !waiting.length && posted.size < maxPending && postedBytes + size <= requestBytesLimit;
    if (!immediate && waiting.length >= maxQueued)
      throw new OpaqueNetworkError("concurrency_limit");
    if (!immediate && queuedBytes + size > requestBytesLimit)
      throw new OpaqueNetworkError("network_backpressure");
    // Snapshot at invocation, not admission: later mutation of caller-owned
    // ArrayBuffers/header arrays must not change a queued HTTP request.
    const headers: [string, string][] = [];
    for (const pair of request.headers) headers.push([pair[0], pair[1]]);
    const payload = { ...request, url, headers,
      body: request.body ? apply(bufferSlice, request.body, [0]) : undefined };
    return await new Promise<OpaqueNetworkResponse>((resolve, reject) => {
      let item: Admission;
      const abort = () => stop(item, abortError(signal));
      const timer = setTimer(() => stop(item, new OpaqueNetworkError("network_timeout")), Math.max(0, deadline - now()));
      item = {
        request: payload, size, deadline, queued: true, done: false,
        responseLimit: options.maxBodyBytes ?? resourceResponseBudget(request.destination),
        resolve, reject, timer,
        detach: () => signal?.removeEventListener("abort", abort),
      };
      signal?.addEventListener("abort", abort, { once: true });
      waiting.push(item);
      queuedBytes += size;
      drain();
    });
  }

  function response(value: OpaqueNetworkResponse, head = false): Response {
    if (value.type === "opaque" || value.type === "opaqueredirect") {
      // No protected bytes are retained in the opaque document. Cache.put of
      // these filtered responses is explicitly unsupported, not fake success.
      const result = NativeResponse.error();
      responseAuthority.remember(result, {type:value.type,url:value.url,redirected:false});
      return result;
    }
    const headers = new NativeHeaders(
      value.headers.filter(
        ([name]) => !["set-cookie", "set-cookie2"].includes(name.toLowerCase()),
      ),
    );
    const noBody = head || [204, 205, 304].includes(value.status);
    const result = new NativeResponse(noBody ? null : value.body, {
      status: value.status,
      statusText: value.statusText,
      headers,
    });
    responseAuthority.remember(result, {
      type:value.type ?? "basic",url:value.url,redirected:value.redirected ?? false,
    });
    return result;
  }

  async function fetchWebsite(
    input: RequestInfo | URL,
    init?: RequestInit,
    resource?: {
      destination: "script" | "style" | "image" | "font" | "media";
      nonce?: string;
      integrity?: string;
      isModule?: boolean;
    },
  ): Promise<Response> {
    const inputURL =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const logical = options.restoreURL?.(inputURL) ?? inputURL;
    const url = websiteURL(logical, documentURL);
    const source = input instanceof NativeRequest ? input : undefined;
    const native = source
      ? new NativeRequest(new NativeRequest(url, source), init)
      : new NativeRequest(url, init);
    if (!["cors", "no-cors", "same-origin"].includes(native.mode))
      throw new TypeError("Unsupported website fetch mode.");
    const body = ["GET", "HEAD"].includes(native.method)
      ? undefined
      : await native.arrayBuffer();
    if (body && body.byteLength > maxBodyBytes)
      throw new OpaqueNetworkError("body_limit");
    const result = await request(
      {
        url: native.url,
        method: native.method,
        headers: Array.from(native.headers.entries()),
        body,
        credentials: native.credentials,
        mode: native.mode as OpaqueNetworkRequest["mode"],
        redirect: native.redirect,
        ...(resource
          ? {
              destination: resource.destination,
              policyNonce: resource.nonce,
              policyIntegrity: resource.integrity,
              isModule: resource.isModule,
            }
          : {}),
      },
      native.signal,
    );
    return response(result, native.method === "HEAD");
  }
  return {
    request,
    describeCacheResponse: responseAuthority.describe,
    rememberCacheResponse: responseAuthority.remember,
    // Website fetch/XHR never receive the resource loader's extra arguments.
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWebsite(input, init),
    fetchResource: (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      metadata: NonNullable<Parameters<typeof fetchWebsite>[2]>,
    ) => fetchWebsite(input, init, metadata),
    dispose,
    get pending() {
      return pending.size;
    },
    get queued() { return waiting.length; },
    get posted() { return posted.size; },
  };
}

/** RuntimeKit's REAL pinned HTML/CSS/WASM-JS rewriting, useful before boot.
 * This does not substitute a reduced renderer for the existing browser engine.
 * The trusted caller supplies bootstrap tags and cookie context; none are read
 * from the parent. Native resources in the result still require a qualified path.
 */
export function createPinnedOpaqueRewriter(options: {
  core: any;
  wasm: Uint8Array;
  wasmModule?: WebAssembly.Module;
  documentURL: string;
  prefix: string;
  injectScripts?: (...args: any[]) => any[];
}) {
  const { core } = options;
  if (
    core?.versionInfo?.version !== PINNED_OPAQUE_CORE_VERSION ||
    ![
      "transformHtml",
      "transformCss",
      "transformJs",
      "setWasm",
      "CookieJar",
    ].every((key) => typeof core[key] === "function")
  )
    throw new TypeError("The pinned RuntimeKit rewriter is required.");
  const url = websiteURL(options.documentURL, options.documentURL);
  const prefix = new URL(options.prefix);
  core.setWasm(options.wasm, options.wasmModule);
  const context = {
    config: {
      ...core.defaultConfig,
      flags: { ...core.defaultConfig.flags, sourcemaps: false },
    },
    prefix,
    cookieJar: new core.CookieJar(),
    hooks: { rewriter: { html: core.Tap.create() } },
    interface: {
      codecEncode: encodeURIComponent,
      codecDecode: decodeURIComponent,
      getInjectScripts: options.injectScripts ?? (() => []),
    },
  };
  const meta = { origin: url, base: url };
  const collect = (source: string, sourceURL: string, module: boolean) => {
    const dependencies = new Set<string>();
    const prefix = module ? "atlas-opaque-module:" : "atlas-opaque-resource:";
    const graphContext = {
      ...context,
      prefix: { href: prefix, pathname: prefix, origin: url.origin },
      interface: {
        ...context.interface,
        codecEncode(value: string) {
          if (/^https?:/.test(value)) dependencies.add(value);
          return encodeURIComponent(value);
        },
      },
    };
    const meta = { origin: url, base: websiteURL(sourceURL, url.href) };
    const output = module
      ? core.transformJs(source, sourceURL, graphContext, meta, true)
      : core.transformCss(source, graphContext, meta);
    return { source: String(output), dependencies: [...dependencies], prefix };
  };
  return {
    context,
    module(source: string, sourceURL = url.href) {
      return collect(source, sourceURL, true);
    },
    stylesheet(source: string, sourceURL = url.href) {
      return collect(source, sourceURL, false);
    },
    restoreURL(value: string) {
      return core.restoreurl(value, context);
    },
    originalCSS(value: string) {
      return core.untransformCss(value, context);
    },
    javascript(
      source: string,
      sourceURL = url.href,
      isModule = false,
      executionContext?: string,
    ): string {
      // The pinned ABI emits meta.base into dynamic-import calls. CLASSIC JS
      // has no static import/meta URL syntax, so that slot may carry a unique
      // execution identifier. The graph resolves it to its separately stored
      // logical base/fetch options. sourceURL remains the real diagnostic URL.
      if (
        executionContext !== undefined &&
        (isModule ||
          !/^atlas-script-context:[a-f0-9]{32}$/.test(executionContext))
      )
        throw new TypeError("Invalid classic script execution context.");
      return String(
        core.transformJs(
          source,
          sourceURL,
          context,
          {
            origin: url,
            base: executionContext
              ? new URL(executionContext)
              : websiteURL(sourceURL, url.href),
          },
          isModule,
        ),
      );
    },
    css(source: string, sourceURL = url.href): string {
      return String(
        core.transformCss(source, context, {
          origin: url,
          base: websiteURL(sourceURL, url.href),
        }),
      );
    },
    html(source: string, documentBaseURL = url.href): string {
      return core.transformHtml(source, context, {origin:url,base:websiteURL(documentBaseURL,url.href)}, {
        loadScripts: !!options.injectScripts,
        inline: false,
        source: url.href,
      });
    },
  };
}

export const OPAQUE_RUNTIME_HELD_GATES = Object.freeze([
  "document-local RuntimeKitClient boot without native service-worker or parent DOM",
  "native script/style/image/font resource routing with opaque response semantics",
  "static and dynamic ESM dependency graphs and import maps",
  "classic/module/shared workers and nested document boot",
  "synchronous storage durability and logical-origin cookie consistency",
  "XHR, streaming fetch/media, navigation and virtual history",
]);

/** Initial self-boot entry for the EXPERIMENTAL copied fork only. The marker is
 * intentionally absent from the shipped pin: passing the stock bundle fails
 * before touching website state. Storage objects and IDB installation must be
 * bound to this document by the trusted owner before any website script runs.
 *
 * Unqualified native resource paths are denied, not routed around the broker.
 * This entry is not a production-activation flag and does not clear held gates.
 */
/** Capture before the core hook. A foreign opaque child has no readable native
 * Document: return only that native null, rather than probing its WindowProxy.
 * A visible child still delegates the installed core trap/hookSubcontext deny;
 * this guard never hands out an unrewritten Document or native constructors. */
export function captureOpaqueContentDocumentParity(
  global: Window & typeof globalThis,
) {
  const apply = global.Reflect.apply,
    descriptor = global.Object.getOwnPropertyDescriptor,
    define = global.Object.defineProperty;
  const captured: {
    prototype: object;
    getter: NonNullable<PropertyDescriptor["get"]>;
  }[] = [];
  for (const name of [
    "HTMLIFrameElement",
    "HTMLFrameElement",
    "HTMLObjectElement",
    "HTMLEmbedElement",
  ] as const) {
    const prototype = global[name]?.prototype;
    if (!prototype) continue;
    const native = descriptor(prototype, "contentDocument");
    if (native?.get) captured.push({ prototype, getter: native.get });
  }
  let installed = false;
  return () => {
    if (installed) return captured.length;
    const hooks = captured.map(({ prototype, getter }) => {
      const trapped = descriptor(prototype, "contentDocument");
      if (!trapped?.get || trapped.get === getter)
        throw new TypeError("Opaque contentDocument core hook was not installed.");
      return { prototype, getter, trapped, trappedGetter: trapped.get };
    });
    for (const { prototype, getter, trapped, trappedGetter } of hooks)
      define(prototype, "contentDocument", {
        ...trapped,
        get: function () {
          // Native brand checks run first. The receiver's constructor/name and
          // any website-mutable Object/Reflect methods are not consulted here.
          const document = apply(getter, this, []);
          return document === null ? null : apply(trappedGetter, this, []);
        },
      });
    installed = true;
    return captured.length;
  };
}

export function bootOpaqueRuntimeClient(options: {
  global: Window & typeof globalThis;
  core: any;
  wasm: Uint8Array;
  documentURL: string;
  prefix: string;
  network: ReturnType<typeof createOpaqueNetworkClient>;
  localStorage: Storage;
  sessionStorage: Storage;
  installIndexedDB: (client: any, global: Window & typeof globalThis) => void;
  installCaches?: (client: any, global: Window & typeof globalThis) => void;
  onNavigate: (
    url: string,
    mode: "assign" | "replace" | "reload" | "hash",
  ) => void;
  sendSetCookie: (...args: any[]) => Promise<void>;
  cookies?: {
    get(): string;
    set(value: unknown): void;
    install(): void;
    setURL?(value: string): void;
  };
  installWorkers?: (client: any, global: Window & typeof globalThis) => void;
  installXHR?: (client: any, global: Window & typeof globalThis) => void;
  installWebSocket?: (client: any, global: Window & typeof globalThis) => void;
  importModule?: (base: string, specifier: string) => Promise<unknown>;
  resolveModule?: (base: string, specifier: string) => string;
  trustedTypes?: {
    installEval(
      client: any,
      global: Window & typeof globalThis,
      rewriter: ReturnType<typeof createPinnedOpaqueRewriter>,
    ): void;
  };
}) {
  const { core, global, network } = options;
  if (core?.RuntimeKitClient?.opaqueAdapterVersion !== 1)
    throw new TypeError(
      "Opaque self-boot requires the reviewed experimental fork seam.",
    );
  if (global.origin !== "null")
    throw new TypeError(
      "Opaque self-boot requires a browser-enforced opaque origin.",
    );
  let current = websiteURL(options.documentURL, options.documentURL);
  const nativeRequest = global.Request;
  const nativePush = global.history.pushState.bind(global.history);
  const nativeReplace = global.history.replaceState.bind(global.history);
  const rewriter = createPinnedOpaqueRewriter(options);
  const deny = () => {
    throw new DOMException(
      "This opaque runtime path is not qualified.",
      "NotSupportedError",
    );
  };
  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  const navigate = (
    value: string,
    mode: "assign" | "replace" | "reload" | "hash" = "assign",
  ) => {
    const url = new URL(value, current);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw new TypeError("Unsupported website navigation.");
    options.onNavigate(url.href, mode);
  };
  const overrides = {
    ...(options.installCaches ? {
      "./shared/caches.ts": {
        default(client: any, global: Window & typeof globalThis) {
          options.installCaches!(client, global);
        },
      },
    } : {}),
    ...(options.trustedTypes
      ? {
          "./shared/eval.ts": {
            default(client: any, global: Window & typeof globalThis) {
              options.trustedTypes!.installEval(client, global, rewriter);
            },
          },
        }
      : {}),
    "./shared/import.ts": {
      default() {
        define(
          global,
          core.defaultConfig.globals.importfn,
          options.importModule ??
            (() =>
              Promise.reject(
                new DOMException(
                  "Opaque module graph is not qualified.",
                  "NotSupportedError",
                ),
              )),
        );
        define(
          global,
          core.defaultConfig.globals.metafn,
          (meta: any, base: string) => {
            meta.url = base;
            meta.resolve = (value: string) =>
              options.resolveModule?.(base, value) ?? new URL(value, base).href;
            return meta;
          },
        );
      },
    },
    "./dom/cookie.ts": {
      default() {
        if (options.cookies) options.cookies.install();
        else
          Object.defineProperty(global.Document.prototype, "cookie", {
            configurable: true,
            get: deny,
            set: deny,
          });
        Reflect.deleteProperty(global, "cookieStore");
      },
    },
    "./dom/storage.ts": {
      default() {
        // These facades are already origin-bound. Running the stock host@ prefix
        // wrapper again would corrupt logical website key/name compatibility.
        define(global, "localStorage", options.localStorage);
        define(global, "sessionStorage", options.sessionStorage);
      },
    },
    "./shared/indexeddb.ts": {
      default(client: any) {
        options.installIndexedDB(client, global);
      },
    },
    "./shared/requests/fetch.ts": {
      default() {
        define(global, "fetch", network.fetch);
        define(
          global,
          "Request",
          new Proxy(nativeRequest, {
            construct(target, args) {
              if (args[0] instanceof nativeRequest)
                return Reflect.construct(target, args);
              return Reflect.construct(target, [
                new URL(String(args[0]), current),
                args[1],
              ]);
            },
          }),
        );
      },
    },
    "./dom/history.ts": {
      default() {
        const update = (
          replace: boolean,
          state: unknown,
          title: string,
          value?: string | URL | null,
        ) => {
          const url = value == null ? current : new URL(String(value), current);
          if (url.origin !== current.origin)
            throw new DOMException(
              "History URLs must stay on the logical website origin.",
              "SecurityError",
            );
          // Native cloning/state validation still runs. No frontend URL is passed
          // to the browser's opaque-origin history implementation.
          (replace ? nativeReplace : nativePush)(state, title);
          current = url;
          options.cookies?.setURL?.(url.href);
        };
        define(
          global.history,
          "pushState",
          (state: unknown, title: string, url?: string | URL | null) =>
            update(false, state, title, url),
        );
        define(
          global.history,
          "replaceState",
          (state: unknown, title: string, url?: string | URL | null) =>
            update(true, state, title, url),
        );
        // Traversal needs a document-bound logical history stack, not the outer
        // Atlas tab's history. It remains denied until that path is qualified.
        for (const key of ["back", "forward", "go"])
          define(global.history, key, deny);
      },
    },
    "./shared/requests/xmlhttprequest.ts": {
      default(client: any) {
        define(
          global,
          "XMLHttpRequest",
          class {
            constructor() {
              deny();
            }
          },
        );
        options.installXHR?.(client, global);
      },
    },
    "./shared/requests/websocket.ts": {
      default(client: any) {
        define(
          global,
          "WebSocket",
          class {
            constructor() {
              deny();
            }
          },
        );
        Reflect.deleteProperty(global, "WebSocketStream");
        options.installWebSocket?.(client, global);
      },
    },
    "./shared/worker.ts": {
      default(client: any) {
        for (const key of ["Worker", "SharedWorker"])
          define(
            global,
            key,
            class {
              constructor() {
                deny();
              }
            },
          );
        options.installWorkers?.(client, global);
        if (global.Worklet)
          define(global.Worklet.prototype, "addModule", () =>
            Promise.reject(
              new DOMException(
                "Opaque worklets are not qualified.",
                "NotSupportedError",
              ),
            ),
          );
      },
    },
  };
  const transport = {
    ready: true,
    async init() {},
    async request() {
      return deny();
    },
    connect(
      _url: URL,
      _protocols: string[],
      _headers: object,
      _open: Function,
      _message: Function,
      _close: Function,
      error: Function,
    ) {
      queueMicrotask(() =>
        error("Opaque WebSocket transport is not qualified."),
      );
      return [deny, deny];
    },
  };
  const installContentDocumentParity = captureOpaqueContentDocumentParity(global);
  const client = new core.RuntimeKitClient(global, {
    context: rewriter.context,
    transport,
    sendSetCookie: options.sendSetCookie,
    shouldBlockMessageEvent: () => false,
    hookSubcontext: deny,
    initHeaders: [],
    history: [],
    opaqueDocument: {
      url: () => current.href,
      navigate,
      moduleOverrides: overrides,
    },
  });
  for (const mode of ["assign", "replace", "reload"] as const)
    define(client.locationProxy, mode, (value = current.href) =>
      navigate(value, mode),
    );
  client.hook();
  installContentDocumentParity();
  // Website-visible diagnostics must not retain the unbrokered native worker
  // constructor after installing the opaque facade. Prototype recovery would
  // otherwise bypass logical worker-src while native Blob boot is permitted.
  if(options.installWorkers)
    for(const name of ["Worker","SharedWorker"]){
      client.box.ctors[name] = [(global as any)[name]];
      Reflect.deleteProperty(client.natives.store,name);
    }
  return { client, rewriter, network, dispose: () => network.dispose() };
}
