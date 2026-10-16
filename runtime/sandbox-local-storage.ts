/** Synchronous Storage facades for an opaque website, hydrated before scripts.
 * Mutations travel directly to the trusted browser storage worker. The only
 * network data is a monotonically increasing commit marker. A mutator returns
 * only after the worker has committed native browser IndexedDB; an unavailable
 * owner/endpoint throws instead of claiming an uncommitted save succeeded.
 */
import type { StorageChange, StorageSnapshot } from "./sandbox-vault.ts";

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
  readyTimeoutMs?: number;
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
};
const implementations = new WeakMap<object, StorageImplementation>();
const bridgedPrototypes = new WeakSet<object>();
function bridgeStoragePrototype(owner: Window & typeof globalThis) {
  const prototype = owner.Storage.prototype;
  if (bridgedPrototypes.has(prototype)) return;
  // Borrowed Storage.prototype methods must accept our registered facades and
  // keep native brand checks for every other receiver. This patch is local to
  // the opaque document; it never touches the trusted frontend/worker realm.
  if (owner.origin !== "null") return;
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
  bridgeStoragePrototype(owner);
  const NativeXHR = owner.XMLHttpRequest;
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
    { revision: number; entries: Map<string, string> }
  > = {
    local: { revision: 0, entries: new Map() },
    session: { revision: 0, entries: new Map() },
  };
  let live = true,
    available = true,
    initialized = false,
    sequence = 0;
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
  function mutate(kind: Kind, change: StorageChange) {
    if (!live || !available || !initialized)
      throw new DOMException(
        "Website storage owner is unavailable",
        "InvalidStateError",
      );
    if (sequence >= Number.MAX_SAFE_INTEGER)
      throw new DOMException("Storage sequence exhausted", "InvalidStateError");
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
    const xhr = new NativeXHR();
    let response: any;
    try {
      apply(open, xhr, ["POST", endpoint.href, false]);
      apply(header, xhr, ["Content-Type", "text/plain;charset=UTF-8"]);
      // withCredentials remains false: the opaque document sends no Atlas
      // session cookie or authorization header to this reserved endpoint.
      apply(send, xhr, [JSON.stringify({ sequence: number })]);
      response = JSON.parse(apply(nativeResponse, xhr, []));
    } catch (error) {
      throw error instanceof DOMException
        ? error
        : new DOMException(
            "Storage commit acknowledgement failed",
            "NetworkError",
          );
    }
    if (
      apply(nativeStatus, xhr, []) !== 200 ||
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
    if (change.op === "set") state.entries.set(change.key, change.value);
    else if (change.op === "remove") state.entries.delete(change.key);
    else state.entries.clear();
    state.revision = response.revision;
  }
  function makeFacade(kind: Kind): Storage {
    const prototype = owner.Storage.prototype;
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
        return [...entries().keys()][+(index as any) >>> 0] ?? null;
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
        });
      },
      removeItem(this: Storage, key: unknown) {
        check(this);
        if (arguments.length < 1)
          throw new TypeError("Storage.removeItem requires one argument");
        mutate(kind, { op: "remove", key: domString(key) });
      },
      clear(this: Storage) {
        check(this);
        mutate(kind, { op: "clear" });
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
        mutate(kind, { op: "set", key, value: domString(value) });
        return true;
      },
      deleteProperty(_target, key) {
        if (typeof key !== "string" || Reflect.has(target, key))
          return Reflect.deleteProperty(target, key);
        mutate(kind, { op: "remove", key });
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
        mutate(kind, { op: "set", key, value: domString(descriptor.value) });
        return true;
      },
      preventExtensions() {
        return false;
      },
    });
    implementations.set(facade, { methods, length: () => entries().size });
    return facade;
  }
  facades.local = makeFacade("local");
  facades.session = makeFacade("session");
  function applySnapshot(kind: Kind, snapshot: StorageSnapshot) {
    if (snapshot.revision < states[kind].revision) return false;
    states[kind] = {
      revision: snapshot.revision,
      entries: new Map(snapshot.entries),
    };
    return true;
  }
  function receive(event: MessageEvent) {
    const message = apply(data, event, []);
    if (!live || !message || message.documentId !== options.documentId) return;
    if (
      !initialized &&
      ownKeys(message, ["type", "documentId", "snapshots"]) &&
      message.type === "ready" &&
      ownKeys(message.snapshots, ["local", "session"]) &&
      validSnapshot(message.snapshots.local) &&
      validSnapshot(message.snapshots.session)
    ) {
      applySnapshot("local", message.snapshots.local);
      applySnapshot("session", message.snapshots.session);
      initialized = true;
      owner.clearTimeout(timer);
      resolveReady();
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
      const storageEvent = new owner.StorageEvent("storage", {
        key: value.change.key,
        oldValue: value.change.oldValue,
        newValue: value.change.newValue,
        url: value.change.url,
      });
      Object.defineProperty(storageEvent, "storageArea", {
        value: facades[value.kind],
      });
      owner.dispatchEvent(storageEvent);
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
      owner.clearTimeout(timer);
      apply(remove, port, ["message", receive]);
      apply(close, port, []);
      implementations.delete(facades.local);
      implementations.delete(facades.session);
    },
  };
}
