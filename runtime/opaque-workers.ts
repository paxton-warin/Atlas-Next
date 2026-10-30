/** Dedicated workers for opaque documents. Only broker-readable source enters
 * this graph. No native frontend fetch, relay credential or full cookie jar is
 * granted to a worker. This component does not qualify no-CORS resources,
 * shared/nested workers, cyclic ESM or arbitrary synchronous importScripts. */
import { init, parse } from "es-module-lexer/minimal/js";
import {
  createOpaqueNetworkClient,
  createPinnedOpaqueRewriter,
} from "./opaque-runtime-adapter.ts";
import {
  createSandboxIndexedDB,
  installSandboxIndexedDB,
} from "./sandbox-idb.ts";
import { createOpaqueXMLHttpRequest } from "./opaque-xhr.ts";
import {
  createOriginalDocumentPolicy,
  type OriginalDocumentPolicy,
} from "./original-document-policy.ts";
import type { OpaqueWorkerSource } from "./opaque-worker-grants.ts";
import {
  assertDocumentOrigin,
  documentContentPolicies,
  type DocumentOrigin,
} from "./document-origin.ts";

type Network = ReturnType<typeof createOpaqueNetworkClient>;
type Rewriter = ReturnType<typeof createPinnedOpaqueRewriter>;
type WorkerKind = "classic" | "module";
const fail = (message: string, name = "NotSupportedError") =>
  new DOMException(message, name);
const unsupported = (code: string, message: string) => {
  const error = fail(message);
  Object.defineProperty(error, "code", { value: code });
  return error;
};
export function assertWorkerCompilationCompatibility(
  parent: OriginalDocumentPolicy,
  worker: OriginalDocumentPolicy,
) {
  for (const kind of ["javascript", "wasm"] as const) {
    let parentAllows = true,
      workerAllows = true;
    try {
      parent.checkEval(kind);
    } catch {
      parentAllows = false;
    }
    try {
      worker.checkEval(kind);
    } catch {
      workerAllows = false;
    }
    if (parentAllows && !workerAllows)
      throw unsupported(
        "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
        "Worker response compilation is stricter than its inherited native policy.",
      );
  }
  if (parent.trustedTypes.csp || worker.trustedTypes.csp)
    throw unsupported(
      "WORKER_TRUSTED_TYPES_UNSUPPORTED",
      "Inherited worker Trusted Types needs a separately policy-qualified bootstrap.",
    );
}
const isURL = (value: string) =>
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\.\.?\/)/.test(value);
function logical(value: string, base: string) {
  const url = new URL(value, base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw fail(
      "Worker resources require HTTP(S) logical URLs.",
      "SecurityError",
    );
  url.hash = "";
  return url.href;
}

export function createOpaqueWorkerGraph(options: {
  documentURL: string;
  network: Network;
  rewriter: Rewriter;
  maxResources?: number;
  maxBytes?: number;
  originalPolicy?: OriginalDocumentPolicy;
  entrySource?: OpaqueWorkerSource;
  createScriptURL?: (source: string) => string;
  revokeScriptURL?: (url: string) => void;
}) {
  const origin = new URL(options.documentURL).origin;
  const raw = new Map<string, Promise<{ source: string; url: string }>>();
  const modules = new Map<string, Promise<string>>();
  const maxResources = options.maxResources ?? 128;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxResources) ||
    maxResources < 1 ||
    maxResources > 512 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 32 * 1024 * 1024
  )
    throw new TypeError("Invalid worker graph limits.");
  const cancellation = new AbortController();
  let bytes = 0,
    emittedBytes = 0,
    live = true;
  const urls = new Set<string>();
  const dataURL = (source: string) => {
    if (options.createScriptURL) {
      const url = options.createScriptURL(source);
      urls.add(url);
      return url;
    }
    const encoded =
      "data:text/javascript;charset=utf-8," + encodeURIComponent(source);
    emittedBytes += encoded.length;
    if (encoded.length > maxBytes * 4 || emittedBytes > maxBytes * 4)
      throw fail("Worker graph expansion limit reached.", "QuotaExceededError");
    return encoded;
  };
  async function source(url: string, credentials: RequestCredentials) {
    if (!live) throw fail("Worker graph is disposed.", "AbortError");
    const key = JSON.stringify([url, credentials]);
    if (!raw.has(key)) {
      if (raw.size >= maxResources)
        throw fail("Worker resource limit reached.", "QuotaExceededError");
      const pending = (async () => {
        if (options.entrySource?.url === url) {
          bytes += new TextEncoder().encode(
            options.entrySource.source,
          ).byteLength;
          if (bytes > maxBytes)
            throw fail(
              "Worker graph byte limit reached.",
              "QuotaExceededError",
            );
          return { source: options.entrySource.source, url };
        }
        options.originalPolicy?.checkURL({ url, kind: "script" });
        const init = {
          mode: new URL(url).origin === origin ? "same-origin" : "cors",
          credentials,
          signal: cancellation.signal,
        } as RequestInit;
        const response = options.network.fetchResource
          ? await options.network.fetchResource(url, init, {
              destination: "script",
              isModule: true,
            })
          : await options.network.fetch(url, init);
        if (!response.ok || !["basic", "cors"].includes(response.type))
          throw new TypeError("Worker resource is not CORS-readable.");
        if (
          !/^(?:text|application)\/(?:java|ecma)script(?:\s*;|$)/i.test(
            response.headers.get("content-type") || "",
          )
        )
          throw new TypeError(
            "Worker resource has a non-JavaScript MIME type.",
          );
        const body = await response.arrayBuffer();
        bytes += body.byteLength;
        if (bytes > maxBytes)
          throw fail("Worker graph byte limit reached.", "QuotaExceededError");
        if (!live) throw fail("Worker graph is disposed.", "AbortError");
        const finalURL = logical(response.url || url, url);
        options.originalPolicy?.checkURL({
          url: finalURL,
          kind: "script",
          redirectCount: response.redirected ? 1 : 0,
        });
        return { source: new TextDecoder().decode(body), url: finalURL };
      })();
      raw.set(key, pending);
    }
    return raw.get(key)!;
  }
  async function moduleURL(
    url: string,
    credentials: RequestCredentials,
    ancestry: Set<string>,
  ): Promise<string> {
    if (ancestry.has(url))
      throw fail("Cyclic worker modules need a separate qualified loader.");
    const cache = JSON.stringify([url, credentials]);
    if (modules.has(cache)) return modules.get(cache)!;
    const pending = (async () => {
      await init();
      const loaded = await source(url, credentials),
        original = loaded.source,
        base = loaded.url;
      const [imports] = parse(original, base),
        dependencies: string[] = [];
      for (const item of imports)
        if (item.d === -1) {
          if (item.a !== -1 || !item.n || !isURL(item.n))
            throw fail(
              "Worker module attributes and bare specifiers are not qualified.",
            );
          dependencies.push(logical(item.n, base));
        }
      const descendants = new Set(ancestry).add(url),
        prepared: string[] = [];
      for (const dependency of dependencies)
        prepared.push(await moduleURL(dependency, credentials, descendants));
      let rewritten = options.rewriter.javascript(original, base, true);
      const [rewrittenImports] = parse(rewritten, base),
        edits: { start: number; end: number; text: string }[] = [];
      let index = 0;
      for (const item of rewrittenImports)
        if (item.d === -1) {
          if (index >= prepared.length)
            throw new TypeError("RuntimeKit changed the worker static graph.");
          edits.push({
            start: item.s - 1,
            end: item.e + 1,
            text: JSON.stringify(prepared[index++]),
          });
        }
      if (index !== prepared.length)
        throw new TypeError("RuntimeKit removed a worker dependency.");
      for (const edit of edits.sort((a, b) => b.start - a.start))
        rewritten =
          rewritten.slice(0, edit.start) +
          edit.text +
          rewritten.slice(edit.end);
      return dataURL(rewritten);
    })();
    modules.set(cache, pending);
    return pending;
  }
  return {
    async prepare(
      script: string,
      type: WorkerKind,
      credentials: RequestCredentials = "same-origin",
      classicImports: readonly string[] = [],
    ) {
      const url = logical(script, options.documentURL);
      if (new URL(url).origin !== origin)
        throw fail(
          "Worker entry must be logical same-origin.",
          "SecurityError",
        );
      if (type === "module")
        return {
          url,
          entry: await moduleURL(url, credentials, new Set()),
          imports: [] as [string, string][],
        };
      const imports: [string, string][] = [];
      if (classicImports.length > maxResources)
        throw fail("Worker import list limit reached.", "QuotaExceededError");
      for (const value of classicImports) {
        const dependency = logical(value, url);
        imports.push([
          dependency,
          dataURL(
            await (async () => {
              const loaded = await source(dependency, "same-origin");
              return options.rewriter.javascript(
                loaded.source,
                loaded.url,
                false,
              );
            })(),
          ),
        ]);
      }
      return {
        url,
        entry: await (async () => {
          const loaded = await source(url, "same-origin");
          return options.rewriter.javascript(loaded.source, loaded.url, false);
        })(),
        imports,
      };
    },
    importModule(
      base: string,
      specifier: string,
      credentials: RequestCredentials = "same-origin",
    ) {
      if (!isURL(specifier))
        return Promise.reject(fail("Worker import maps are not supported."));
      return moduleURL(logical(specifier, base), credentials, new Set());
    },
    dispose() {
      live = false;
      cancellation.abort();
      raw.clear();
      modules.clear();
      for (const url of urls) options.revokeScriptURL?.(url);
      urls.clear();
    },
    executableURL: dataURL,
    get resourceCount() {
      return raw.size;
    },
  };
}

/** Real copied RuntimeKit worker selfboot. Its environment is a native opaque
 * DedicatedWorkerGlobalScope, not a Window with synthetic history/document. */
export function bootOpaqueDedicatedWorker(options: {
  global: any;
  documentOrigin?: DocumentOrigin;
  core: any;
  wasm: Uint8Array;
  wasmModule?: WebAssembly.Module;
  documentId: string;
  documentURL: string;
  prefix: string;
  type: WorkerKind;
  credentials: RequestCredentials;
  networkPort: MessagePort;
  indexedDBPort: MessagePort;
  classicImports?: [string, string][];
  source?: OpaqueWorkerSource;
  parentContentPolicies?: readonly string[];
}) {
  const { global, core } = options;
  const documentOrigin = assertDocumentOrigin(global, options.documentOrigin);
  if (
    !global.DedicatedWorkerGlobalScope ||
    core?.RuntimeKitClient?.opaqueAdapterVersion !== 1
  )
    throw fail(
      "Worker selfboot requires the reviewed copied runtime and an opaque dedicated worker.",
      "SecurityError",
    );
  const nativeImport = (url: string) => import(/* @vite-ignore */ url);
  const nativeImportScripts = global.importScripts.bind(global);
  const NativeBlob = global.Blob,
    nativeCreate = global.URL.createObjectURL.bind(global.URL),
    nativeRevoke = global.URL.revokeObjectURL.bind(global.URL);
  const nativeRequest = global.Request;
  const apply = Reflect.apply,
    nativePortClose = global.MessagePort.prototype.close;
  const define = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value,
    });
  const deny = () => {
    throw fail("This worker capability is not qualified.");
  };
  const parentPolicy = options.parentContentPolicies
      ? createOriginalDocumentPolicy({
          documentURL: options.documentURL,
          contentPolicies: documentContentPolicies(documentOrigin, options.parentContentPolicies),
        })
      : undefined,
    workerPolicy = options.source
      ? createOriginalDocumentPolicy({
          documentURL: options.documentURL,
          contentPolicies: documentContentPolicies(documentOrigin, options.source.contentPolicies),
        })
      : undefined;
  if (parentPolicy && workerPolicy)
    assertWorkerCompilationCompatibility(parentPolicy, workerPolicy);
  const rewriter = createPinnedOpaqueRewriter(options);
  rewriter.context.config.flags.debugTrampolines = false;
  const network = createOpaqueNetworkClient({
    port: options.networkPort,
    documentId: options.documentId,
    documentURL: options.documentURL,
    restoreURL: (value) =>
      value.startsWith(rewriter.context.prefix.href) ||
      value.startsWith(rewriter.context.prefix.pathname)
        ? rewriter.restoreURL(value)
        : value,
  });
  const graph = createOpaqueWorkerGraph({
    documentURL: options.documentURL,
    network,
    rewriter,
    originalPolicy: workerPolicy,
    entrySource: options.source,
    ...(options.source
      ? {
          createScriptURL: (source: string) =>
            nativeCreate(
              new NativeBlob([source], { type: "application/javascript" }),
            ),
          revokeScriptURL: nativeRevoke,
        }
      : {}),
  });
  const idb = createSandboxIndexedDB(options.indexedDBPort, options.documentId);
  const xhr = createOpaqueXMLHttpRequest({
    window: global,
    documentURL: () => options.documentURL,
    fetch: network.fetch,
    request: network.request,
  });
  const imports = new Map(options.classicImports || []);
  const overrides = {
    ...(parentPolicy &&
    (() => {
      try {
        parentPolicy.checkEval("javascript");
        return false;
      } catch {
        return true;
      }
    })()
      ? {
          "./shared/function.ts": {
            default() {
              for (const ctor of [
                global.Function,
                async function () {}.constructor,
                function* () {}.constructor,
                async function* () {}.constructor,
              ])
                Object.defineProperty(ctor.prototype, "constructor", {
                  configurable: true,
                  writable: true,
                  value: deny,
                });
              define(global, "Function", deny);
            },
          },
        }
      : {}),
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
                new URL(String(args[0]), options.documentURL),
                args[1],
              ]);
            },
          }),
        );
      },
    },
    "./shared/requests/xmlhttprequest.ts": {
      default() {
        define(global, "XMLHttpRequest", xhr.XMLHttpRequest);
      },
    },
    "./shared/indexeddb.ts": {
      default() {
        installSandboxIndexedDB(global, idb);
      },
    },
    "./shared/worker.ts": {
      default() {
        for (const name of ["Worker", "SharedWorker"])
          define(
            global,
            name,
            class {
              constructor() {
                deny();
              }
            },
          );
      },
    },
    "./worker/importScripts.ts": {
      default() {
        define(global, "importScripts", (...values: unknown[]) => {
          if (options.type !== "classic")
            throw new TypeError("Module workers do not support importScripts.");
          const urls = values.map((value) => {
            const url = logical(
              String(value).startsWith(rewriter.context.prefix.href) ||
                String(value).startsWith(rewriter.context.prefix.pathname)
                ? rewriter.restoreURL(String(value))
                : String(value),
              options.documentURL,
            );
            const prepared = imports.get(url);
            if (!prepared)
              throw fail(
                "Unprepared synchronous worker import is not qualified.",
              );
            return prepared;
          });
          return nativeImportScripts(...urls);
        });
      },
    },
    "./shared/import.ts": {
      default() {
        define(
          global,
          core.defaultConfig.globals.importfn,
          async (base: string, specifier: string) =>
            nativeImport(
              await graph.importModule(base, specifier, options.credentials),
            ),
        );
        define(
          global,
          core.defaultConfig.globals.metafn,
          (meta: any, base: string) => {
            meta.url = base;
            meta.resolve = (value: string) => logical(value, base);
            return meta;
          },
        );
      },
    },
    // User messages use native structured clone in both directions. Capability
    // ports are already captured before these hooks and never use page events.
    "./shared/postmessage.ts": {
      default() {
        // The rewriter emits this helper even when native worker messaging needs
        // no virtual envelope. Keep native structured clone/transfer semantics.
        Object.defineProperty(
          global,
          core.defaultConfig.globals.wrappostmessagefn,
          {
            configurable: false,
            writable: false,
            value: (target: any) => {
              if (!target || typeof target.postMessage !== "function")
                return target;
              const post = target.postMessage;
              return {
                postMessage: (...args: any[]) => apply(post, target, args),
              };
            },
          },
        );
      },
    },
    "./shared/event.ts": { default() {} },
    "./shared/blob.ts": { default() {} },
  };
  const client = new core.RuntimeKitClient(global, {
    context: rewriter.context,
    transport: { ready: true, async init() {}, request: deny, connect: deny },
    sendSetCookie: async () => deny(),
    shouldBlockMessageEvent: () => false,
    hookSubcontext: deny,
    initHeaders: [],
    history: [],
    opaqueDocument: {
      url: () => options.documentURL,
      navigate: deny,
      moduleOverrides: overrides,
    },
  });
  client.hook();
  for (const name of ["Worker", "SharedWorker"]) {
    client.box.ctors[name] = [global[name]];
    Reflect.deleteProperty(client.natives.store, name);
  }
  return {
    client,
    network,
    graph,
    dispose() {
      graph.dispose();
      xhr.dispose();
      network.dispose();
      apply(nativePortClose, options.indexedDBPort, []);
    },
  };
}

// A fresh native classic Blob worker starts synchronously. Native user-message
// cloning/transfer runs immediately; its bootstrap buffers delivery until site
// script is installed. A private control port is sent before constructor returns.
export function workerBootstrap(
  trustedBoot?: typeof bootOpaqueDedicatedWorker,
) {
  "use strict";
  const apply = Reflect.apply,
    Message = MessageEvent,
    dataGetter = Object.getOwnPropertyDescriptor(
      Message.prototype,
      "data",
    )!.get!,
    portsGetter = Object.getOwnPropertyDescriptor(
      Message.prototype,
      "ports",
    )!.get!,
    originGetter = Object.getOwnPropertyDescriptor(
      Message.prototype,
      "origin",
    )!.get!,
    portPost = MessagePort.prototype.postMessage,
    portStart = MessagePort.prototype.start,
    portAdd = EventTarget.prototype.addEventListener;
  const data = (event: MessageEvent) => apply(dataGetter, event, []),
    ports = (event: MessageEvent) => apply(portsGetter, event, []);
  const add = self.addEventListener.bind(self),
    remove = self.removeEventListener.bind(self),
    dispatch = self.dispatchEvent.bind(self);
  const nativeEval = self.eval,
    nativeClassicImport = (self as any).importScripts.bind(self),
    nativeClose = self.close.bind(self),
    queue: { data: any; ports: MessagePort[]; origin: string }[] = [];
  let bound = false,
    running = false,
    control: MessagePort,
    queuedBytes = 0;
  const measure = (value: any, seen = new Set<any>(), depth = 0): number => {
    if (depth > 32 || seen.size > 10000)
      throw new DOMException(
        "Worker message structure limit",
        "QuotaExceededError",
      );
    if (typeof value === "string") return 16 + 2 * value.length;
    if (!value || typeof value !== "object") return 16;
    if (seen.has(value)) return 8;
    seen.add(value);
    if (value instanceof ArrayBuffer) return 32 + value.byteLength;
    if (ArrayBuffer.isView(value)) return 32 + value.buffer.byteLength;
    if (value instanceof Blob)
      return (
        32 +
        value.size +
        2 * value.type.length +
        (typeof File !== "undefined" && value instanceof File
          ? 2 * value.name.length + 16
          : 0)
      );
    let size = 32;
    if (value instanceof Map)
      for (const [key, entry] of value)
        size += measure(key, seen, depth + 1) + measure(entry, seen, depth + 1);
    else if (value instanceof Set)
      for (const entry of value) size += measure(entry, seen, depth + 1);
    else
      for (const key of Object.keys(value))
        size += 2 * key.length + measure(value[key], seen, depth + 1);
    return size;
  };
  add("message", function receive(event: MessageEvent) {
    if (
      !bound &&
      data(event)?.type === "atlas-opaque-worker-init" &&
      ports(event).length === 1
    ) {
      event.stopImmediatePropagation();
      bound = true;
      control = ports(event)[0];
      let booted: any;
      const closeWorker = () => {
        booted?.dispose();
        apply(portPost, control, [{ type: "closed" }]);
        nativeClose();
      };
      apply(portAdd, control, [
        "message",
        async (message: MessageEvent) => {
          if (running) {
            if (data(message)?.type === "dispose") closeWorker();
            return;
          }
          if (data(message)?.type !== "boot" || running) return;
          try {
            const config = data(message);
            // This function is also serialized by itself for the data-module
            // bootstrap, so validate without relying on outer module bindings.
            const documentOrigin = config.documentOrigin === undefined ? "opaque" : config.documentOrigin;
            if (documentOrigin !== "opaque" && documentOrigin !== "same-origin")
              throw new TypeError("Invalid trusted worker origin mode");
            const physical = self.location?.origin;
            if (
              documentOrigin === "opaque"
                ? self.origin !== "null"
                : typeof physical !== "string" ||
                  physical === "null" ||
                  self.origin !== physical ||
                  !/^https?:\/\//.test(physical) ||
                  new URL(physical).origin !== physical
            )
              throw new TypeError("Worker origin does not match its trusted composition");
            let entry = trustedBoot;
            if (!entry) {
              nativeEval(config.coreSource);
              const module = await import(
                /* @vite-ignore */ config.runtimeModuleURL
              );
              entry = module.bootOpaqueDedicatedWorker;
            }
            const boot = entry!({
              ...config,
              documentOrigin,
              type: config.kind,
              global: self,
              core: (self as any).$runtimekit,
              networkPort: ports(message)[0],
              indexedDBPort: ports(message)[1],
            });
            booted = boot;
            (self as any).close = closeWorker;
            const prepared = trustedBoot
              ? await boot.graph.prepare(
                  config.source.url,
                  config.kind,
                  config.credentials,
                )
              : config;
            if (config.kind === "module")
              await import(/* @vite-ignore */ prepared.entry);
            else
              nativeClassicImport(
                trustedBoot
                  ? boot.graph.executableURL(prepared.entry)
                  : "data:text/javascript;charset=utf-8," +
                      encodeURIComponent(config.entry),
              );
            running = true;
            remove("message", receive);
            apply(portPost, control, [{ type: "ready" }]);
            for (const saved of queue.splice(0))
              dispatch(
                new Message("message", {
                  data: saved.data,
                  ports: [...saved.ports],
                  origin: saved.origin,
                }),
              );
          } catch (error: any) {
            apply(portPost, control, [
              {
                type: "error",
                name: [
                  "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
                  "WORKER_TRUSTED_TYPES_UNSUPPORTED",
                ].includes(error?.code)
                  ? error.code
                  : error?.name || "Error",
                message: "Opaque worker initialization failed.",
              },
            ]);
            nativeClose();
          }
        },
      ]);
      apply(portStart, control, []);
      return;
    }
    if (!running) {
      event.stopImmediatePropagation();
      try {
        queuedBytes += measure(data(event)) + ports(event).length * 64;
      } catch {
        queuedBytes = Infinity;
      }
      if (
        queue.length >= 64 ||
        queuedBytes > 16 * 1024 * 1024 ||
        ports(event).length > 16
      ) {
        if (control)
          apply(portPost, control, [
            {
              type: "error",
              name: "QuotaExceededError",
              message: "Worker bootstrap message limit reached.",
            },
          ]);
        nativeClose();
      } else
        queue.push({
          data: data(event),
          ports: [...ports(event)],
          origin: apply(originGetter, event, []),
        });
    }
  });
}

export function createOpaqueWorkerManager(options: {
  global: Window & typeof globalThis;
  documentOrigin?: DocumentOrigin;
  documentURL: string;
  documentBaseURL?: string;
  network: Network;
  rewriter: Rewriter;
  coreSource: string;
  wasm: Uint8Array;
  /** Trusted bootstrap MODULE, compiled into a child-readable data URL. It must
   * export bootOpaqueDedicatedWorker; no website-chosen asset URL is accepted. */
  runtimeModuleURL: string;
  bootstrapSource?: string;
  wasmModule?: WebAssembly.Module;
  parentPolicy?: OriginalDocumentPolicy;
  prefix: string;
  bindWorker(binding: {
    documentId: string;
    documentURL: string;
    type: WorkerKind;
    credentials?: RequestCredentials;
  }): Promise<{
    network: MessagePort;
    indexedDB: MessagePort;
    dispose(): void;
    source?: OpaqueWorkerSource;
  }>;
  classicImports?: readonly string[];
  natives: {
    Worker: typeof Worker;
    Blob: typeof Blob;
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  timeoutMs?: number;
}) {
  const documentOrigin = assertDocumentOrigin(options.global, options.documentOrigin);
  if (
    !options.bootstrapSource &&
      !options.runtimeModuleURL.startsWith("data:text/javascript")
  )
    throw fail(
      "Worker bootstrap requires the opaque child and explicit trusted data module.",
      "SecurityError",
    );
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError("Invalid worker bootstrap timeout.");
  const graph = createOpaqueWorkerGraph(options),
    records = new Set<any>(),
    byWorker = new WeakMap<Worker, any>(),
    parentPolicy = documentOrigin === "same-origin"
      ? createOriginalDocumentPolicy({ documentURL: options.documentURL, contentPolicies: [] })
      : options.parentPolicy;
  const { natives, global } = options;
  const apply = Reflect.apply,
    construct = Reflect.construct,
    dataGetter = Object.getOwnPropertyDescriptor(
      global.MessageEvent.prototype,
      "data",
    )!.get!,
    setAdd = Set.prototype.add,
    setDelete = Set.prototype.delete,
    setEach = Set.prototype.forEach,
    weakSet = WeakMap.prototype.set,
    weakGet = WeakMap.prototype.get,
    setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!,
    channelFirst = Object.getOwnPropertyDescriptor(
      global.MessageChannel.prototype,
      "port1",
    )!.get!,
    channelSecond = Object.getOwnPropertyDescriptor(
      global.MessageChannel.prototype,
      "port2",
    )!.get!,
    iterator = Symbol.iterator;
  const transfer = (items: Transferable[]) => ({
    [iterator]() {
      let i = 0;
      return {
        next() {
          return i < items.length
            ? { value: items[i++], done: false }
            : { done: true };
        },
      };
    },
  });
  const nativePost = natives.Worker.prototype.postMessage;
  const nativeTerminate = natives.Worker.prototype.terminate;
  const nativeListen = global.EventTarget.prototype.addEventListener;
  const nativeRemove = global.EventTarget.prototype.removeEventListener;
  const NativeChannel = global.MessageChannel;
  const nativePortPost = global.MessagePort.prototype.postMessage;
  const nativePortStart = global.MessagePort.prototype.start;
  const nativePortClose = global.MessagePort.prototype.close;
  const handlers = new Map(
    ["onmessage", "onmessageerror", "onerror"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(natives.Worker.prototype, name),
    ]),
  );
  let live = true;
  const report = (worker: Worker, name: string) =>
    worker.dispatchEvent(
      new global.ErrorEvent("error", { message: name, cancelable: true }),
    );
  class OpaqueWorker {
    constructor(value: string | URL, supplied: WorkerOptions = {}) {
      if (options.bootstrapSource && parentPolicy?.trustedTypes.csp)
        throw unsupported(
          "WORKER_TRUSTED_TYPES_UNSUPPORTED",
          "Inherited worker Trusted Types needs a policy-qualified bootstrap.",
        );
      if (!live || apply(setSize, records, []) >= 16)
        throw fail("Worker limit reached.", "QuotaExceededError");
      const type = supplied.type ?? "classic",
        credentials = supplied.credentials ?? "same-origin",
        url = logical(
          String(value),
          options.documentBaseURL ?? options.documentURL,
        );
      if (
        !["classic", "module"].includes(type) ||
        !["omit", "same-origin", "include"].includes(credentials)
      )
        throw new TypeError("Invalid Worker options.");
      if (new URL(url).origin !== new URL(options.documentURL).origin)
        throw fail(
          "Worker entry must be logical same-origin.",
          "SecurityError",
        );
      const blob = natives.createObjectURL(
        new natives.Blob(
          [
            options.bootstrapSource ??
              "(" + workerBootstrap.toString() + ")();",
          ],
          {
            type: "application/javascript",
          },
        ),
      );
      let worker: Worker;
      try {
        worker = construct(
          natives.Worker,
          [blob, { type: "classic", name: supplied.name }],
          new.target,
        );
      } catch (error) {
        natives.revokeObjectURL(blob);
        throw error;
      }
      const control = new NativeChannel(),
        controlPort = apply(channelFirst, control, []),
        childPort = apply(channelSecond, control, []),
        record: any = {
          live: true,
          control: controlPort,
          stop: null,
          blob,
          grant: null,
          timer: null,
          worker: worker,
        };
      apply(setAdd, records, [record]);
      const stop = () => {
        if (!record.live) return;
        record.live = false;
        apply(setDelete, records, [record]);
        clearTimeout(record.timer);
        apply(nativePortClose, controlPort, []);
        record.grant?.dispose();
        natives.revokeObjectURL(blob);
        apply(nativeTerminate, worker, []);
      };
      record.stop = stop;
      apply(weakSet, byWorker, [worker, record]);
      apply(nativeListen, worker, ["error", () => stop()]);
      apply(nativeListen, controlPort, [
        "message",
        (event: MessageEvent) => {
          const value = apply(dataGetter, event, []);
          if (value?.type === "ready") {
            clearTimeout(record.timer);
            natives.revokeObjectURL(blob);
          } else if (value?.type === "closed") {
            stop();
          } else if (value?.type === "error") {
            report(worker, value.name);
            stop();
          }
        },
      ]);
      apply(nativePortStart, controlPort, []);
      apply(nativePost, worker, [
        { type: "atlas-opaque-worker-init" },
        { transfer: transfer([childPort]) },
      ]);
      record.timer = setTimeout(() => {
        report(worker, "TimeoutError");
        stop();
      }, timeoutMs);
      const documentId =
        "worker_" +
        Array.from(global.crypto.getRandomValues(new Uint8Array(24)), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join("");
      void (async () => {
        const prepared = options.bootstrapSource
          ? undefined
          : await graph.prepare(url, type, credentials, options.classicImports);
        if (!record.live) return;
        const grant = await options.bindWorker({
          documentId,
          documentURL: url,
          type,
          credentials,
        });
        record.grant = grant;
        if (!record.live) {
          grant.dispose();
          return;
        }
        const source = grant.source && documentOrigin === "same-origin"
          ? { ...grant.source, contentPolicies: [] }
          : grant.source;
        if (options.bootstrapSource) {
          if (!source || !parentPolicy)
            throw fail("Original worker source policy is required.");
          assertWorkerCompilationCompatibility(
            parentPolicy,
            createOriginalDocumentPolicy({
              documentURL: source.url,
              contentPolicies: source.contentPolicies,
            }),
          );
        }
        apply(nativePortPost, controlPort, [
          {
            type: "boot",
            documentOrigin,
            kind: type,
            documentId,
            documentURL: grant.source?.url ?? url,
            prefix: options.prefix,
            credentials,
            entry: prepared?.entry,
            classicImports: prepared?.imports,
            source,
            parentContentPolicies: parentPolicy?.snapshot,
            wasmModule: options.wasmModule,
            coreSource: options.coreSource,
            wasm: options.wasm.slice(),
            runtimeModuleURL: options.runtimeModuleURL,
          },
          { transfer: transfer([grant.network, grant.indexedDB]) },
        ]);
      })().catch((error) => {
        report(
          worker,
          [
            "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
            "WORKER_TRUSTED_TYPES_UNSUPPORTED",
          ].includes(error?.code)
            ? error.code
            : error?.name || "Error",
        );
        stop();
      });
      return worker;
    }
    addEventListener(type: string, listener: any, options?: any) {
      apply(nativeListen, this, [type, listener, options]);
    }
    removeEventListener(type: string, listener: any, options?: any) {
      apply(nativeRemove, this, [type, listener, options]);
    }
    postMessage(
      message: any,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ) {
      return apply(
        nativePost,
        this,
        transferOrOptions === undefined
          ? [message]
          : [message, transferOrOptions],
      );
    }
    terminate() {
      const record = apply(weakGet, byWorker, [this]);
      if (!record) throw new TypeError("Illegal invocation");
      record.stop();
    }
  }
  Object.setPrototypeOf(OpaqueWorker.prototype, global.EventTarget.prototype);
  for (const [name, descriptor] of handlers)
    if (descriptor)
      Object.defineProperty(OpaqueWorker.prototype, name, descriptor);
  return {
    Worker: OpaqueWorker,
    dispose() {
      live = false;
      apply(setEach, records, [(record: any) => record.stop()]);
      graph.dispose();
    },
    get active() {
      return apply(setSize, records, []);
    },
  };
}
