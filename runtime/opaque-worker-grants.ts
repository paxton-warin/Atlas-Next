/** Worker grants use ONLY the original document control capability. Native
 * MessageEvent data/ports accessors are captured before website hooks. */
const nativeApply = Reflect.apply,
  nativeData = Object.getOwnPropertyDescriptor(
    MessageEvent.prototype,
    "data",
  )!.get!,
  nativePorts = Object.getOwnPropertyDescriptor(
    MessageEvent.prototype,
    "ports",
  )!.get!,
  nativeAdd = EventTarget.prototype.addEventListener,
  nativeRemove = EventTarget.prototype.removeEventListener,
  nativePost = MessagePort.prototype.postMessage,
  nativeStart = MessagePort.prototype.start,
  nativeClose = MessagePort.prototype.close;
const NativePromise = Promise,
  NativeURL = URL,
  NativeDOMException = DOMException,
  create = Object.create,
  freeze = Object.freeze,
  define = Object.defineProperty,
  isArray = Array.isArray,
  every = Array.prototype.every,
  slice = Array.prototype.slice,
  rejectPromise = Promise.reject.bind(Promise);
const workerID = /^worker_[a-f0-9]{48}$/;
export type OpaqueWorkerSource = Readonly<{
  url: string;
  source: string;
  contentPolicies: readonly string[];
}>;
export function createOpaqueWorkerGrants(options: {
  port: MessagePort;
  documentId: string;
  timeoutMs?: number;
}) {
  const { port, documentId } = options,
    pending = new Map<number, any>(),
    active = new Set<string>();
  // Bind collection methods before any website prototype hooks. A forged
  // Map.get/Promise resolver must never observe a transferred capability.
  const get = pending.get.bind(pending),
    set = pending.set.bind(pending),
    remove = pending.delete.bind(pending),
    clear = pending.clear.bind(pending),
    values = pending.values.bind(pending),
    add = active.add.bind(active),
    deleteActive = active.delete.bind(active),
    activeValues = active.values.bind(active),
    pendingSize = Object.getOwnPropertyDescriptor(
      Map.prototype,
      "size",
    )!.get!.bind(pending),
    activeSize = Object.getOwnPropertyDescriptor(
      Set.prototype,
      "size",
    )!.get!.bind(active);
  const closePorts = (ports: MessagePort[]) => {
    for (let i = 0; i < ports.length; i++)
      nativeApply(nativeClose, ports[i], []);
  };
  let live = true,
    sequence = 0;
  const post = (message: object) =>
    nativeApply(nativePost, port, [{ protocol: 2, documentId, ...message }]);
  const release = (id: string) => {
    deleteActive(id);
    if (live) post({ type: "worker-release", workerId: id });
  };
  const receive = (event: MessageEvent) => {
    const data = nativeApply(nativeData, event, []),
      ports = nativeApply(nativePorts, event, []) as MessagePort[];
    if (
      data?.protocol !== 2 ||
      data.documentId !== documentId ||
      data.type !== "worker-grant"
    )
      return;
    const record = get(data.requestId);
    if (!record || data.workerId !== record.workerId) {
      closePorts(ports);
      return;
    }
    remove(data.requestId);
    clearTimeout(record.timer);
    if (!live || data.ok !== true) {
      closePorts(ports);
      release(record.workerId);
      const error = new NativeDOMException(
        "Dedicated worker grant was denied.",
        "NotSupportedError",
      );
      define(error, "code", {
        value:
          typeof data.code === "string" ? data.code : "WORKER_GRANT_DENIED",
      });
      record.reject(error);
      return;
    }
    const source = data.source;
    let valid =
      ports.length === 2 &&
      source &&
      typeof source.url === "string" &&
      typeof source.source === "string" &&
      source.source.length <= 8 * 1024 * 1024 &&
      isArray(source.contentPolicies) &&
      source.contentPolicies.length <= 32 &&
      nativeApply(every, source.contentPolicies, [
        (p: unknown) => typeof p === "string" && p.length <= 65536,
      ]);
    try {
      const final = new NativeURL(source.url);
      valid =
        valid &&
        final.origin === new NativeURL(record.url).origin &&
        /^https?:$/.test(final.protocol) &&
        !final.username &&
        !final.password;
    } catch {
      valid = false;
    }
    if (!valid) {
      closePorts(ports);
      release(record.workerId);
      record.reject(new TypeError("Invalid original worker source grant."));
      return;
    }
    add(record.workerId);
    const result = create(null);
    result.network = ports[0];
    result.indexedDB = ports[1];
    result.source = freeze({
      url: source.url,
      source: source.source,
      contentPolicies: freeze(nativeApply(slice, source.contentPolicies, [])),
    });
    result.dispose = () => release(record.workerId);
    // A plain object would invoke website Object.prototype.then during native
    // Promise resolution and leak both private ports before await continued.
    record.resolve(freeze(result));
  };
  nativeApply(nativeAdd, port, ["message", receive]);
  nativeApply(nativeStart, port, []);
  return {
    bind(binding: {
      documentId: string;
      documentURL: string;
      type: "classic" | "module";
      credentials?: RequestCredentials;
    }): Promise<{
      network: MessagePort;
      indexedDB: MessagePort;
      source: OpaqueWorkerSource;
      dispose(): void;
    }> {
      if (
        !live ||
        !workerID.test(binding.documentId) ||
        pendingSize() + activeSize() >= 16
      )
        return rejectPromise(
          new NativeDOMException(
            "Dedicated worker grant limit.",
            "QuotaExceededError",
          ),
        );
      const requestId = ++sequence;
      return new NativePromise((resolve, reject) => {
        const timer = setTimeout(() => {
          remove(requestId);
          release(binding.documentId);
          reject(
            new NativeDOMException(
              "Dedicated worker grant timed out.",
              "TimeoutError",
            ),
          );
        }, options.timeoutMs ?? 20000);
        set(requestId, {
          workerId: binding.documentId,
          url: binding.documentURL,
          resolve,
          reject,
          timer,
        });
        post({
          type: "worker-create",
          requestId,
          workerId: binding.documentId,
          url: binding.documentURL,
          kind: binding.type,
          credentials: binding.credentials ?? "same-origin",
        });
      });
    },
    dispose() {
      if (!live) return;
      for (const id of activeValues()) release(id);
      for (const record of values()) {
        clearTimeout(record.timer);
        release(record.workerId);
        record.reject(
          new NativeDOMException("Original document disposed.", "AbortError"),
        );
      }
      clear();
      live = false;
      nativeApply(nativeRemove, port, ["message", receive]);
    },
  };
}
