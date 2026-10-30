/** Synchronous Storage facades for an opaque website, hydrated before scripts.
 * Mutations travel directly to the trusted browser storage worker. The only
 * network data is a monotonically increasing commit marker. A mutator returns
 * only after the worker has committed native browser IndexedDB; an unavailable
 * owner/endpoint throws instead of claiming an uncommitted save succeeded.
 */
import type { StorageChange, StorageSnapshot } from "./sandbox-vault.ts";
import { assertDocumentOrigin, type DocumentOrigin } from "./document-origin.ts";
import { createStorageLocalReceiptReader } from "./storage-local-receipt.ts";

type Kind = "local" | "session";
type SnapshotMessage = {
  type: "snapshot";
  documentId: string;
  kind: Kind;
  snapshot: StorageSnapshot;
  change?: {
    sourceDocumentId: string;
    url: string;
    key: string | null;
    oldValue: string | null;
    newValue: string | null;
  };
};
type Options = {
  documentId: string;
  /** Exact same-frontend reserved /browse/storage/commit/<cap> endpoint. */
  endpoint: string;
  port: MessagePort;
  window?: Window & typeof globalThis;
  documentOrigin?: DocumentOrigin;
  readyTimeoutMs?: number;
  /** Opt-in for the normal profile's authenticated browser-local ACK transport. */
  localReceipts?: boolean;
  /** V2: no server acknowledgement fallback and no online-state prerequisite. */
  localOnly?: boolean;
};
const ownKeys = (
  value: unknown,
  keys: string[],
): value is Record<string, any> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
function validSnapshot(value: unknown): value is StorageSnapshot {
  return (
    ownKeys(value, ["revision", "entries"]) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((part) => typeof part === "string"),
    )
  );
}
const domString = (value: unknown): string => "" + (value as any);
type StorageImplementation = {
  methods: Record<string, Function>;
  length(): number;
  clone(prototype: object): Storage;
  attach(target: Window & typeof globalThis, view: Storage): () => void;
};
const implementations = new WeakMap<object, StorageImplementation>();
const bridgedPrototypes = new WeakSet<object>();
function bridgeStoragePrototype(owner: Window & typeof globalThis, mode?: DocumentOrigin, prepared = false) {
  // A same-origin facade is enabled only by the trusted child bootstrap. An
  // omitted mode still leaves ordinary frontend realms entirely unmodified.
  if (!prepared) {
    if (owner.origin !== "null" && mode !== "same-origin") return;
    assertDocumentOrigin(owner, mode);
  }
  const prototype = owner.Storage.prototype;
  if (bridgedPrototypes.has(prototype)) return;
  // Borrowed Storage.prototype methods must accept our registered facades and
  // keep native brand checks for every other receiver. This patch is local to
  // the initialized child document; it never patches another realm.
  for (const name of ["key", "getItem", "setItem", "removeItem", "clear"]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    const native = descriptor.value;
    const method = function (this: object, ...args: unknown[]) {
      const implementation = implementations.get(this);
      return Reflect.apply(implementation?.methods[name] || native, this, args);
    };
    Object.defineProperties(method, {
      name: { value: name },
      length: { value: native.length },
    });
    Object.defineProperty(prototype, name, { ...descriptor, value: method });
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "length")!;
  const native = descriptor.get!;
  Object.defineProperty(prototype, "length", {
    ...descriptor,
    get: function (this: object) {
      const implementation = implementations.get(this);
      return implementation
        ? implementation.length()
        : Reflect.apply(native, this, []);
    },
  });
  bridgedPrototypes.add(prototype);
}

/** Attach an already hydrated profile view to a normal engine child. The
 * transport keeps its captured host natives; only this child's Storage realm
 * receives the borrowed-method bridge. No async work occurs in init.post. */
export function rebindSandboxStorageFacades(
  facades: { localStorage: Storage; sessionStorage: Storage },
  target: Window & typeof globalThis,
) {
  if (!implementations.has(facades.localStorage) || !implementations.has(facades.sessionStorage))
    throw new TypeError("Prepared storage facades required");
  bridgeStoragePrototype(target, undefined, true);
  const disposers: (() => void)[] = [];
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const view = implementations.get(facades[name])!.clone(target.Storage.prototype);
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: view,
    });
    disposers.push(implementations.get(facades[name])!.attach(target, view));
  }
  const dispose = () => { for (const stop of disposers.splice(0)) stop(); };
  return { dispose };
}

export async function createSandboxStorageFacades(options: Options): Promise<{
  localStorage: Storage;
  sessionStorage: Storage;
  dispose(): void;
}> {
  const owner = options.window || window;
  // A hostile website may replace MessageEvent.data or EventTarget/Port
  // methods after bootstrap. Never invoke its getter/method with a private
  // capability port as currentTarget/receiver, including during cleanup.
  const apply = Reflect.apply,
    data = Object.getOwnPropertyDescriptor(
      owner.MessageEvent.prototype,
      "data",
    )!.get!,
    post = owner.MessagePort.prototype.postMessage,
    add = owner.EventTarget.prototype.addEventListener,
    remove = owner.EventTarget.prototype.removeEventListener,
    start = owner.MessagePort.prototype.start,
    close = owner.MessagePort.prototype.close;
  const endpoint = new URL(options.endpoint, owner.location.href);
  if (
    !/^[A-Za-z0-9_-]{16,96}$/.test(options.documentId) ||
    endpoint.origin !== owner.location.origin ||
    !/^\/browse\/storage\/commit\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new DOMException(
      "Invalid document storage endpoint",
      "SecurityError",
    );
  bridgeStoragePrototype(owner, options.documentOrigin);
  const NativeXHR = owner.XMLHttpRequest;
  const nativeNavigator=owner.navigator;
  const nativeOnline=owner.Navigator&&Object.getOwnPropertyDescriptor(owner.Navigator.prototype,'onLine')?.get;
  // Capture before RuntimeKit rewrites XMLHttpRequest/prototypes. Marker RPCs
  // are host control traffic, not requests to the proxied website.
  const open = NativeXHR.prototype.open;
  const send = NativeXHR.prototype.send;
  const header = NativeXHR.prototype.setRequestHeader;
  const nativeResponse = Object.getOwnPropertyDescriptor(
    NativeXHR.prototype,
    "responseText",
  )!.get!;
  const nativeStatus = Object.getOwnPropertyDescriptor(
    NativeXHR.prototype,
    "status",
  )!.get!;
  const port = options.port;
  const states: Record<
    Kind,
    { revision: number; entries: Map<string, string>; keys: string[] | null }
  > = {
    local: { revision: 0, entries: new Map(), keys: null },
    session: { revision: 0, entries: new Map(), keys: null },
  };
  const keyRevisions: Record<Kind, Map<string, number>> = {local:new Map(),session:new Map()};
  const clearRevisions: Record<Kind,number> = {local:0,session:0};
  let live = true,
    available = true,
    initialized = false,
    sequence = 0;
  let localReceipt: ReturnType<typeof createStorageLocalReceiptReader> = null;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = owner.setTimeout(() => {
    available = false;
    rejectReady(
      new DOMException("Website storage hydration timed out", "TimeoutError"),
    );
  }, options.readyTimeoutMs ?? 10000);
  const facades = {} as Record<Kind, Storage>;
  const sinks: Record<Kind, Map<Window & typeof globalThis, Storage>> = { local: new Map(), session: new Map() };
  const subscriptions = new Set<() => void>();
  function deliver(kind: Kind, change: NonNullable<SnapshotMessage['change']>, source?: Storage) {
    for (const [target, view] of sinks[kind]) {
      if (view === source || !target.StorageEvent || !target.dispatchEvent) continue;
      const event = new target.StorageEvent('storage', { key: change.key, oldValue: change.oldValue, newValue: change.newValue, url: change.url });
      Object.defineProperty(event, 'storageArea', { value: view });
      apply(owner.EventTarget.prototype.dispatchEvent, target, [event]);
    }
    // Legacy bootstrap constructs its facade in the website realm itself.
    // Normal profile construction happens in the parent and must not emit
    // website events into the Atlas application.
    if (!sinks[kind].size && !source && owner.StorageEvent && owner.dispatchEvent) {
      const event = new owner.StorageEvent('storage', { key: change.key, oldValue: change.oldValue, newValue: change.newValue, url: change.url });
      Object.defineProperty(event, 'storageArea', { value: facades[kind] });
      owner.dispatchEvent(event);
    }
  }
  function mutate(kind: Kind, change: StorageChange, source?: Storage) {
    if(!options.localOnly&&nativeOnline&&apply(nativeOnline,nativeNavigator,[])===false)
      throw new DOMException('Website saving is unavailable while this browser is completely offline; your last committed save is retained.','NetworkError');
    if (!live || !available || !initialized)
      throw new DOMException(
        "Website storage owner is unavailable",
        "InvalidStateError",
      );
    if (sequence >= Number.MAX_SAFE_INTEGER)
      throw new DOMException("Storage sequence exhausted", "InvalidStateError");
    const previousSize = states[kind].entries.size;
    const oldValue = change.op === 'clear' ? null : states[kind].entries.get(change.key) ?? null;
    const number = ++sequence;
    apply(post, port, [
      {
        type: "mutate",
        documentId: options.documentId,
        sequence: number,
        kind,
        change,
      },
    ]);
    let response: any;
    let responseStatus = 200;
    try { response = localReceipt?.read(number); }
    catch {
      try { localReceipt?.dispose(); } catch { /* Network fallback remains available. */ }
      localReceipt = null;
    }
    if (response === undefined && options.localOnly) {
      apply(post,port,[{type:'receipt',documentId:options.documentId,sequence:number}]);
      response = localReceipt?.read(number);
    }
    if (response === undefined && options.localOnly)
      throw new DOMException("Local storage acknowledgement unavailable; the write may be durable", "InvalidStateError");
    if (response === undefined) {
      const xhr = new NativeXHR();
      try {
        apply(open, xhr, ["POST", endpoint.href, false]);
        apply(header, xhr, ["Content-Type", "text/plain;charset=UTF-8"]);
        // A local transport miss falls back to the SAME sequence: the mutation
        // was posted once and may already be durably committed in the worker.
        apply(send, xhr, [JSON.stringify({ sequence: number })]);
        responseStatus = apply(nativeStatus, xhr, []);
        response = JSON.parse(apply(nativeResponse, xhr, []));
      } catch (error) {
        throw error instanceof DOMException
          ? error
          : new DOMException(
              "Storage commit acknowledgement failed",
              "NetworkError",
            );
      }
    }
    if (
      responseStatus !== 200 ||
      !response ||
      response.ok !== true ||
      !Number.isSafeInteger(response.revision) ||
      response.revision < 0
    )
      throw new DOMException(
        "Website storage commit failed",
        typeof response?.error?.name === "string"
          ? response.error.name
          : "NetworkError",
      );
    const state = states[kind];
    // Worker-port snapshots cannot dispatch while this main thread blocks in
    // sync XHR. Apply this acknowledged mutation now; the queued authoritative
    // snapshot reconciles other-document changes on the next event-loop turn.
    if (change.op === "set") {
      if (!state.entries.has(change.key)) state.keys = null;
      state.entries.set(change.key, change.value);
    } else if (change.op === "remove") {
      if (state.entries.delete(change.key)) state.keys = null;
    } else if (state.entries.size) {
      state.entries.clear();
      state.keys = null;
    }
    state.revision = Math.max(state.revision, response.revision);
    if (options.localOnly) {
      if (change.op === 'clear') {clearRevisions[kind] = response.revision;keyRevisions[kind].clear();}
      else keyRevisions[kind].set(change.key,response.revision);
    }
    const newValue = change.op === 'set' ? change.value : null;
    // Inherited same-origin documents can share one hydrated transport. Their
    // views still receive ordinary StorageEvents, excluding the writing view.
    if (source && sinks[kind].size && (change.op === 'clear' ? previousSize > 0 : oldValue !== newValue)) {
      const target = [...sinks[kind]].find(([, view]) => view === source)?.[0];
      const event = { sourceDocumentId: options.documentId, url: target?.document?.URL || owner.location.href,
        key: change.op === 'clear' ? null : change.key, oldValue, newValue };
      queueMicrotask(() => { if (live) deliver(kind, event, source); });
    }
  }
  function makeFacade(kind: Kind, prototype: object = owner.Storage.prototype): Storage {
    const target = Object.create(prototype);
    let facade: Storage;
    const entries = () => {
      if (!live || !available || !initialized)
        throw new DOMException(
          "Website storage owner is unavailable",
          "InvalidStateError",
        );
      return states[kind].entries;
    };
    const check = (value: unknown) => {
      if (value !== facade) throw new TypeError("Illegal invocation");
    };
    const methods: Record<string, Function> = {
      key(this: Storage, index: unknown) {
        check(this);
        if (arguments.length < 1)
          throw new TypeError("Storage.key requires one argument");
        const current = entries(), state = states[kind];
        // A key enumeration must not allocate every key again for each index.
        // Membership changes invalidate this shared order, value-only edits do not.
        const keys = state.keys ?? (state.keys = [...current.keys()]);
        return keys[+(index as any) >>> 0] ?? null;
      },
      getItem(this: Storage, key: unknown) {
        check(this);
        if (arguments.length < 1)
          throw new TypeError("Storage.getItem requires one argument");
        return entries().get(domString(key)) ?? null;
      },
      setItem(this: Storage, key: unknown, value: unknown) {
        check(this);
        if (arguments.length < 2)
          throw new TypeError("Storage.setItem requires two arguments");
        mutate(kind, {
          op: "set",
          key: domString(key),
          value: domString(value),
        }, facade);
      },
      removeItem(this: Storage, key: unknown) {
        check(this);
        if (arguments.length < 1)
          throw new TypeError("Storage.removeItem requires one argument");
        mutate(kind, { op: "remove", key: domString(key) }, facade);
      },
      clear(this: Storage) {
        check(this);
        mutate(kind, { op: "clear" }, facade);
      },
    };
    facade = new Proxy(target, {
      get(_target, key) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, facade);
        return typeof key === "string" ? entries().get(key) : undefined;
      },
      set(_target, key, value) {
        // Native Storage named setters only handle names that do not shadow
        // inherited/ordinary properties. A method assignment is an expando;
        // a readonly length assignment fails; __proto__ remains an accessor.
        if (typeof key !== "string" || Reflect.has(target, key))
          return Reflect.set(target, key, value, target);
        mutate(kind, { op: "set", key, value: domString(value) }, facade);
        return true;
      },
      deleteProperty(_target, key) {
        if (typeof key !== "string" || Reflect.has(target, key))
          return Reflect.deleteProperty(target, key);
        mutate(kind, { op: "remove", key }, facade);
        return true;
      },
      ownKeys() {
        return [...new Set([...Reflect.ownKeys(target), ...entries().keys()])];
      },
      has(_target, key) {
        return (
          Reflect.has(target, key) ||
          (typeof key === "string" && entries().has(key))
        );
      },
      getOwnPropertyDescriptor(_target, key) {
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own) return own;
        if (typeof key !== "string") return undefined;
        // Native enumeration hides the readonly length accessor, even if a
        // website stores a key literally named "length".
        if (key === "length" && Reflect.has(target, key)) return undefined;
        const value = entries().get(key);
        return value === undefined
          ? undefined
          : { configurable: true, enumerable: true, writable: true, value };
      },
      defineProperty(_target, key, descriptor) {
        if (typeof key !== "string" || Reflect.has(target, key))
          return Reflect.defineProperty(target, key, descriptor);
        if (!("value" in descriptor) || descriptor.get || descriptor.set)
          return false;
        // Proxy invariants preclude pretending an absent named key is a
        // non-configurable own data property. Reject that reflective shape
        // before committing, rather than committing then throwing TypeError.
        if (descriptor.configurable === false) return false;
        mutate(kind, { op: "set", key, value: domString(descriptor.value) }, facade);
        return true;
      },
      preventExtensions() {
        return false;
      },
    });
    implementations.set(facade, {
      methods,
      length: () => entries().size,
      clone: (prototype) => makeFacade(kind, prototype),
      attach(target, view) {
        sinks[kind].set(target, view);
        const stop = () => { if (sinks[kind].get(target) === view) sinks[kind].delete(target); target.removeEventListener?.('pagehide', pagehide); subscriptions.delete(stop); };
        const pagehide = (event: PageTransitionEvent) => { if (!event.persisted) stop(); };
        subscriptions.add(stop);
        target.addEventListener?.('pagehide', pagehide);
        return stop;
      },
    });
    return facade;
  }
  facades.local = makeFacade("local");
  facades.session = makeFacade("session");
  function applySnapshot(kind: Kind, snapshot: StorageSnapshot) {
    if (snapshot.revision < states[kind].revision) return false;
    states[kind] = {
      revision: snapshot.revision,
      entries: new Map(snapshot.entries),
      keys: null,
    };
    if (options.localOnly) {clearRevisions[kind]=snapshot.revision;keyRevisions[kind].clear();}
    return true;
  }
  function receive(event: MessageEvent) {
    const message = apply(data, event, []);
    if (!live || !message || message.documentId !== options.documentId) return;
    if (
      !initialized &&
      ownKeys(message, ["type", "documentId", "snapshots", ...((options.localReceipts || options.localOnly) ? ["localReceipt"] : [])]) &&
      message.type === "ready" &&
      ownKeys(message.snapshots, ["local", "session"]) &&
      validSnapshot(message.snapshots.local) &&
      validSnapshot(message.snapshots.session)
    ) {
      applySnapshot("local", message.snapshots.local);
      applySnapshot("session", message.snapshots.session);
      if ((options.localReceipts || options.localOnly) && message.localReceipt !== undefined) {
        try {
          localReceipt = createStorageLocalReceiptReader({
            host: owner,
            documentId: options.documentId,
            grant: message.localReceipt,
          });
        } catch { localReceipt = null; }
      }
      if (options.localOnly && localReceipt?.read(0)?.ok !== true) {
        available = false; owner.clearTimeout(timer);
        rejectReady(new DOMException("Browser-local storage receipts are unsupported; original data is retained", "NotSupportedError"));
        return;
      }
      initialized = true;
      owner.clearTimeout(timer);
      resolveReady();
    } else if (initialized && options.localOnly && message.type === 'delta' &&
      ['local','session'].includes(message.kind) && Number.isSafeInteger(message.revision) && message.revision >= 0 &&
      message.delta && (message.delta.key === null || typeof message.delta.key === 'string') &&
      (message.delta.newValue === null || typeof message.delta.newValue === 'string')) {
      const kind = message.kind as Kind, revision = message.revision as number, delta = message.delta;
      const state = states[kind], versions = keyRevisions[kind];
      if (delta.key === null) {
        if (revision > clearRevisions[kind]) {
          for (const key of state.entries.keys()) if ((versions.get(key) ?? 0) <= revision) {state.entries.delete(key);versions.delete(key);state.keys=null;}
          clearRevisions[kind] = revision;
        }
      } else if (revision > clearRevisions[kind] && revision > (versions.get(delta.key) ?? 0)) {
        if (delta.newValue === null) {
          if (state.entries.delete(delta.key)) state.keys = null;
        } else {
          if (!state.entries.has(delta.key)) state.keys = null;
          state.entries.set(delta.key,delta.newValue);
        }
        versions.set(delta.key,revision);
      }
      state.revision = Math.max(state.revision,revision);
      if (message.change && message.change.sourceDocumentId !== options.documentId) deliver(kind,message.change);
    } else if (
      initialized &&
      ownKeys(message, ["type", "documentId", "kind", "snapshot", "change"]) &&
      message.type === "snapshot" &&
      ["local", "session"].includes(message.kind) &&
      validSnapshot(message.snapshot)
    ) {
      const value = message as SnapshotMessage;
      // Revisions protect the current mirror from stale delivery, but older
      // committed changes still have their own queued storage event.
      applySnapshot(value.kind, value.snapshot);
      if (!value.change || value.change.sourceDocumentId === options.documentId)
        return;
      deliver(value.kind, value.change);
    } else if (
      ownKeys(message, ["type", "documentId"]) &&
      message.type === "unavailable"
    ) {
      available = false;
      if (!initialized)
        rejectReady(
          new DOMException(
            "Website storage owner is unavailable",
            "InvalidStateError",
          ),
        );
    }
  }
  apply(add, port, ["message", receive]);
  apply(start, port, []);
  try {
    await ready;
  } catch (error) {
    owner.clearTimeout(timer);
    apply(remove, port, ["message", receive]);
    apply(close, port, []);
    throw error;
  }
  return {
    localStorage: facades.local,
    sessionStorage: facades.session,
    dispose() {
      if (!live) return;
      live = false;
      try { localReceipt?.dispose(); } catch { /* Disposing the facade must still close its ports. */ }
      localReceipt = null;
      owner.clearTimeout(timer);
      apply(remove, port, ["message", receive]);
      apply(close, port, []);
      for (const stop of [...subscriptions]) stop();
      sinks.local.clear(); sinks.session.clear();
      for (const kind of ["local", "session"] as const) {
        states[kind].entries.clear();
        states[kind].keys = null;
        keyRevisions[kind].clear();
      }
      implementations.delete(facades.local);
      implementations.delete(facades.session);
    },
  };
}
