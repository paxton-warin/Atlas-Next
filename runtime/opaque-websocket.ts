/** Opaque website WebSocket capability. Document identity and logical Origin are
 * fixed by its trusted port; relay tickets/cookies never enter the website.
 * A trusted transport must report actual negotiated protocol, not first offer.
 */
export const OPAQUE_WEBSOCKET_PROTOCOL = "atlas-websocket-v1";
export type OpaqueSocketEvents = {
  open(protocol: string, extensions: string): void;
  message(data: string | ArrayBuffer): void;
  close(code: number, reason: string, wasClean: boolean): void;
  error(): void;
};
export type OpaqueTrustedSocket = {
  send(data: string | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
};
export type OpaqueSocketContext = Readonly<{
  documentId: string;
  documentURL: string;
  origin: string;
  signal: AbortSignal;
}>;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PROTOCOLS = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every(
    (p) => typeof p === "string" && p.length <= 256 && TOKEN.test(p),
  ) &&
  new Set(value).size === value.length;
const keys = (v: any, allowed: string[]) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k));
const size = (value: string | ArrayBuffer) =>
  typeof value === "string"
    ? new TextEncoder().encode(value).length
    : value.byteLength;
const validClose = (code: unknown, reason: unknown) =>
  (code === undefined ||
    code === 1000 ||
    (Number.isInteger(code) &&
      (code as number) >= 3000 &&
      (code as number) <= 4999)) &&
  typeof reason === "string" &&
  reason.length <= 123 &&
  new TextEncoder().encode(reason).length <= 123;
function socketURL(value: string, base: string) {
  const url = new URL(value, base);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (
    !/^wss?:$/.test(url.protocol) ||
    url.href.includes("#") ||
    url.username ||
    url.password ||
    url.href.length > 16384
  )
    throw new DOMException("Invalid website WebSocket URL", "SyntaxError");
  return url;
}
export function bindOpaqueWebSockets(options: {
  port: MessagePort;
  documentId: string;
  documentURL: string;
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  maxSockets?: number;
  maxMessageBytes?: number;
  maxQueuedBytes?: number;
  connectTimeoutMs?: number;
  connect(
    url: string,
    protocols: string[],
    context: OpaqueSocketContext,
    events: OpaqueSocketEvents,
  ): Promise<OpaqueTrustedSocket> | OpaqueTrustedSocket;
}) {
  const { port, documentId } = options,
    bound = new URL(options.documentURL);
  const forbidden = new Set(
    [options.frontendOrigin, ...(options.forbiddenOrigins ?? [])].map(
      (s) => new URL(s).hostname,
    ),
  );
  if (
    !documentId ||
    !/^https?:$/.test(bound.protocol) ||
    bound.username ||
    bound.password ||
    forbidden.has(bound.hostname)
  )
    throw TypeError("Invalid WebSocket document binding");
  const maxSockets = options.maxSockets ?? 16,
    maxMessage = options.maxMessageBytes ?? 1024 * 1024,
    maxQueued = options.maxQueuedBytes ?? 4 * 1024 * 1024,
    timeoutMs = options.connectTimeoutMs ?? 10000;
  if (
    ![maxSockets, maxMessage, maxQueued, timeoutMs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    maxSockets > 256 ||
    timeoutMs > 120000
  )
    throw TypeError("Invalid WebSocket bounds");
  type State = {
    id: number;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    transport?: OpaqueTrustedSocket;
    phase: number;
    protocols: string[];
    outgoing: number;
    outgoingMessages: number;
    incoming: Map<number, number>;
    incomingBytes: number;
    message: number;
    tail: Promise<void>;
  };
  const sockets = new Map<number, State>();
  let live = true,
    sequence = 0,
    lastSocket = 0,
    totalQueued = 0;
  const post = port.postMessage.bind(port);
  function send(id: number, value: object, transfer: Transferable[] = []) {
    if (live)
      post(
        {
          protocol: OPAQUE_WEBSOCKET_PROTOCOL,
          documentId,
          socket: id,
          ...value,
        },
        transfer,
      );
  }
  function finish(s: State, code = 1006, reason = "", wasClean = false) {
    if (!sockets.delete(s.id)) return;
    s.phase = 3;
    clearTimeout(s.timer);
    s.controller.abort();
    totalQueued -= s.outgoing + s.incomingBytes;
    s.outgoing = s.incomingBytes = 0;
    s.incoming.clear();
    try {
      s.transport?.close();
    } catch {}
    send(s.id, { type: "close", code, reason, wasClean });
  }
  function failed(s: State) {
    if (!sockets.has(s.id)) return;
    send(s.id, { type: "error" });
    finish(s);
  }
  function dispose() {
    if (!live) return;
    for (const s of [...sockets.values()]) finish(s);
    live = false;
    port.removeEventListener("message", receive);
    port.close();
  }
  const receive = ({ data: value }: MessageEvent) => {
    if (!live) return;
    if (
      !value ||
      value.protocol !== OPAQUE_WEBSOCKET_PROTOCOL ||
      value.documentId !== documentId ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== sequence + 1 ||
      !Number.isSafeInteger(value.socket) ||
      value.socket < 1
    )
      return dispose();
    sequence = value.sequence;
    if (value.type === "open") {
      if (
        !keys(value, [
          "protocol",
          "documentId",
          "sequence",
          "socket",
          "type",
          "url",
          "protocols",
        ]) ||
        typeof value.url !== "string" ||
        !PROTOCOLS(value.protocols) ||
        value.socket <= lastSocket
      )
        return dispose();
      lastSocket = value.socket;
      let url: URL;
      try {
        url = socketURL(value.url, bound.href);
        if (
          forbidden.has(url.hostname) ||
          (bound.protocol === "https:" && url.protocol !== "wss:")
        )
          throw Error();
      } catch {
        send(value.socket, { type: "error" });
        send(value.socket, {
          type: "close",
          code: 1006,
          reason: "",
          wasClean: false,
        });
        return;
      }
      if (sockets.size >= maxSockets) {
        send(value.socket, { type: "error" });
        send(value.socket, {
          type: "close",
          code: 1006,
          reason: "",
          wasClean: false,
        });
        return;
      }
      const s: State = {
        id: value.socket,
        controller: new AbortController(),
        timer: setTimeout(() => failed(s), timeoutMs),
        phase: 0,
        protocols: [...value.protocols],
        outgoing: 0,
        outgoingMessages: 0,
        incoming: new Map(),
        incomingBytes: 0,
        message: 0,
        tail: Promise.resolve(),
      };
      sockets.set(s.id, s);
      const events: OpaqueSocketEvents = {
        open(protocol, extensions) {
          if (!sockets.has(s.id) || s.phase !== 0) return;
          if (
            typeof protocol !== "string" ||
            protocol.length > 256 ||
            (protocol
              ? !s.protocols.includes(protocol)
              : s.protocols.length !== 0) ||
            typeof extensions !== "string" ||
            extensions.length > 4096
          )
            return failed(s);
          s.phase = 1;
          clearTimeout(s.timer);
          send(s.id, { type: "open", selectedProtocol: protocol, extensions });
        },
        message(data) {
          if (
            !sockets.has(s.id) ||
            s.phase !== 1 ||
            !(typeof data === "string" || data instanceof ArrayBuffer)
          )
            return;
          // Check scalar bounds before encoding/copying attacker-sized payloads.
          if (
            (typeof data === "string" && data.length > maxMessage) ||
            (data instanceof ArrayBuffer && data.byteLength > maxMessage)
          )
            return failed(s);
          const bytes = size(data);
          if (
            bytes > maxMessage ||
            totalQueued + bytes > maxQueued ||
            s.incoming.size >= 64
          )
            return failed(s);
          totalQueued += bytes;
          s.incomingBytes += bytes;
          const message = ++s.message;
          s.incoming.set(message, bytes);
          const copy = typeof data === "string" ? data : data.slice(0);
          send(
            s.id,
            { type: "message", message, data: copy },
            typeof copy === "string" ? [] : [copy],
          );
        },
        close(code, reason, wasClean) {
          if (
            !Number.isInteger(code) ||
            code < 1000 ||
            code > 4999 ||
            typeof reason !== "string" ||
            reason.length > 123 ||
            size(reason) > 123 ||
            typeof wasClean !== "boolean"
          )
            return failed(s);
          finish(s, code, reason, wasClean);
        },
        error() {
          failed(s);
        },
      };
      void Promise.resolve()
        .then(() =>
          options.connect(
            url.href,
            s.protocols,
            Object.freeze({
              documentId,
              documentURL: bound.href,
              origin: bound.origin,
              signal: s.controller.signal,
            }),
            events,
          ),
        )
        .then((transport) => {
          if (
            !transport ||
            typeof transport.send !== "function" ||
            typeof transport.close !== "function"
          )
            return failed(s);
          if (!sockets.has(s.id)) {
            try {
              transport.close();
            } catch {}
            return;
          }
          s.transport = transport;
        })
        .catch(() => failed(s));
      return;
    }
    const s = sockets.get(value.socket);
    if (!s) return;
    if (value.type === "received") {
      if (
        !keys(value, [
          "protocol",
          "documentId",
          "sequence",
          "socket",
          "type",
          "message",
        ]) ||
        !s.incoming.has(value.message)
      )
        return dispose();
      const bytes = s.incoming.get(value.message)!;
      s.incoming.delete(value.message);
      s.incomingBytes -= bytes;
      totalQueued -= bytes;
      return;
    }
    if (value.type === "close") {
      if (
        !keys(value, [
          "protocol",
          "documentId",
          "sequence",
          "socket",
          "type",
          "code",
          "reason",
        ]) ||
        !validClose(value.code, value.reason)
      )
        return dispose();
      s.phase = 2;
      clearTimeout(s.timer);
      s.tail = s.tail.then(() => {
        if (sockets.has(s.id)) {
          if (!s.transport) return finish(s);
          try {
            s.transport.close(value.code, value.reason);
          } catch {
            failed(s);
          }
        }
      });
      s.timer = setTimeout(() => finish(s), 1000);
      return;
    }
    if (
      value.type !== "send" ||
      !keys(value, [
        "protocol",
        "documentId",
        "sequence",
        "socket",
        "type",
        "send",
        "data",
      ]) ||
      !Number.isSafeInteger(value.send) ||
      value.send < 1 ||
      !(typeof value.data === "string" || value.data instanceof ArrayBuffer)
    )
      return dispose();
    if (s.phase !== 1) return;
    if (
      (typeof value.data === "string" && value.data.length > maxMessage) ||
      (value.data instanceof ArrayBuffer && value.data.byteLength > maxMessage)
    )
      return failed(s);
    const bytes = size(value.data);
    if (
      bytes > maxMessage ||
      totalQueued + bytes > maxQueued ||
      s.outgoingMessages >= 64
    )
      return failed(s);
    s.outgoing += bytes;
    s.outgoingMessages++;
    totalQueued += bytes;
    s.tail = s.tail
      .then(async () => {
        if (!sockets.has(s.id) || !s.transport) return failed(s);
        try {
          await s.transport.send(value.data);
          if (sockets.has(s.id))
            send(s.id, { type: "sent", send: value.send, bytes });
        } catch {
          failed(s);
        }
      })
      .finally(() => {
        if (sockets.has(s.id)) {
          s.outgoing -= bytes;
          s.outgoingMessages--;
          totalQueued -= bytes;
        }
      });
  };
  port.addEventListener("message", receive);
  port.addEventListener("messageerror", dispose);
  port.start();
  return {
    dispose,
    get sockets() {
      return sockets.size;
    },
    get queuedBytes() {
      return totalQueued;
    },
  };
}

export function createOpaqueWebSocket(options: {
  port: MessagePort;
  documentId: string;
  documentURL: () => string;
  window?: Window & typeof globalThis;
  maxSockets?: number;
  maxMessageBytes?: number;
  maxQueuedBytes?: number;
}) {
  const realm = options.window ?? window,
    { port, documentId } = options;
  const EventBase = realm.EventTarget,
    EventCtor = realm.Event,
    Message = realm.MessageEvent,
    Close = realm.CloseEvent,
    BlobCtor = realm.Blob,
    BufferCtor = realm.ArrayBuffer,
    URLCtor = realm.URL,
    ErrorCtor = realm.DOMException;
  const apply = Reflect.apply,
    nativeData = Object.getOwnPropertyDescriptor(
      Message.prototype,
      "data",
    )!.get!,
    nativePortPost = realm.MessagePort.prototype.postMessage,
    nativePortStart = realm.MessagePort.prototype.start,
    nativePortClose = realm.MessagePort.prototype.close;
  const nativeDispatch = EventBase.prototype.dispatchEvent,
    nativeAdd = EventBase.prototype.addEventListener,
    nativeRemove = EventBase.prototype.removeEventListener;
  const encode = new realm.TextEncoder(),
    maxMessage = options.maxMessageBytes ?? 1024 * 1024,
    maxQueued = options.maxQueuedBytes ?? 4 * 1024 * 1024,
    maxSockets = options.maxSockets ?? 16;
  if (
    !documentId ||
    ![maxMessage, maxQueued, maxSockets].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    maxSockets > 256
  )
    throw TypeError("Invalid WebSocket document bounds");
  const post = (value: unknown, transfer: Transferable[]) =>
      apply(nativePortPost, port, [value, transfer]),
    sockets = new Map<number, WebSocket>();
  let sequence = 0,
    id = 0,
    live = true;
  const send = (
    socket: number,
    value: object,
    transfer: Transferable[] = [],
  ) => {
    if (!live || !Number.isSafeInteger(++sequence))
      throw new ErrorCtor("WebSocket document disposed", "InvalidStateError");
    post(
      {
        protocol: OPAQUE_WEBSOCKET_PROTOCOL,
        documentId,
        sequence,
        socket,
        ...value,
      },
      transfer,
    );
  };
  class WebSocket extends EventBase {
    #id: number;
    #url: string;
    #state = 0;
    #binary = "blob";
    #protocol = "";
    #extensions = "";
    #buffered = 0;
    #next = 0;
    #pending = new Map<number, number>();
    #tail = Promise.resolve();
    #handlers = new Map<string, { value: Function; listener: EventListener }>();
    constructor(url: string | URL, protocols: string | string[] = []) {
      super();
      if (!arguments.length) throw TypeError("WebSocket requires a URL");
      if (!live || sockets.size >= maxSockets)
        throw new ErrorCtor(
          "WebSocket document connection bound",
          "QuotaExceededError",
        );
      if (typeof url === "symbol") throw TypeError("Invalid WebSocket URL");
      const address = socketURL(String(url), options.documentURL());
      const list =
        typeof protocols === "string"
          ? [protocols]
          : Array.from(protocols, (p) => {
              if (typeof p === "symbol") throw TypeError("Invalid protocol");
              return String(p);
            });
      if (!PROTOCOLS(list))
        throw new ErrorCtor(
          "Invalid or duplicate WebSocket protocol",
          "SyntaxError",
        );
      this.#url = address.href;
      this.#id = ++id;
      sockets.set(id, this);
      send(id, { type: "open", url: this.#url, protocols: list });
    }
    get url() {
      return this.#url;
    }
    get readyState() {
      return this.#state;
    }
    get bufferedAmount() {
      return this.#buffered;
    }
    get protocol() {
      return this.#protocol;
    }
    get extensions() {
      return this.#extensions;
    }
    get binaryType() {
      return this.#binary as BinaryType;
    }
    set binaryType(value: BinaryType) {
      if (value === "blob" || value === "arraybuffer") this.#binary = value;
    }
    handler(type: string, value?: unknown, write = false): unknown {
      if (!write) return this.#handlers.get(type)?.value ?? null;
      const old = this.#handlers.get(type);
      if (typeof value === "function") {
        if (old) {
          old.value = value;
          return;
        }
        const listener = (event: Event) =>
          this.#handlers.get(type)?.value.call(this, event);
        this.#handlers.set(type, { value, listener });
        apply(nativeAdd, this, [type, listener]);
      } else if (old) {
        apply(nativeRemove, this, [type, old.listener]);
        this.#handlers.delete(type);
      }
    }
    receive(value: any) {
      if (value.type === "open" && this.#state === 0) {
        if (
          typeof value.selectedProtocol !== "string" ||
          typeof value.extensions !== "string"
        )
          return dispose();
        this.#protocol = value.selectedProtocol;
        this.#extensions = value.extensions;
        this.#state = 1;
        apply(nativeDispatch, this, [new EventCtor("open")]);
      } else if (value.type === "sent") {
        const bytes = this.#pending.get(value.send);
        if (bytes === undefined || bytes !== value.bytes) return dispose();
        this.#pending.delete(value.send);
        this.#buffered -= bytes;
      } else if (value.type === "message" && this.#state === 1) {
        const data = value.data;
        if (
          !Number.isSafeInteger(value.message) ||
          !(typeof data === "string" || data instanceof BufferCtor) ||
          (typeof data === "string"
            ? data.length > maxMessage ||
              encode.encode(data).length > maxMessage
            : data.byteLength > maxMessage)
        )
          return dispose();
        nativeDispatch.call(
          this,
          new Message("message", {
            data:
              typeof data === "string" || this.#binary === "arraybuffer"
                ? data
                : new BlobCtor([data]),
            origin: new URLCtor(this.#url).origin,
          }),
        );
        if (live) send(this.#id, { type: "received", message: value.message });
      } else if (value.type === "error")
        apply(nativeDispatch, this, [new EventCtor("error")]);
      else if (value.type === "close") {
        this.#state = 3;
        sockets.delete(this.#id);
        this.#pending.clear();
        this.#buffered = 0;
        nativeDispatch.call(
          this,
          new Close("close", {
            code: value.code,
            reason: value.reason,
            wasClean: value.wasClean,
          }),
        );
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (!arguments.length) throw TypeError("WebSocket.send requires data");
      if (this.#state === 0)
        throw new ErrorCtor("WebSocket is connecting", "InvalidStateError");
      let input: string | ArrayBuffer | Blob;
      if (data instanceof BlobCtor) input = data;
      else if (data instanceof BufferCtor) input = data;
      else if (BufferCtor.isView(data)) {
        if (data.byteLength > maxMessage)
          throw new ErrorCtor("WebSocket message bound", "QuotaExceededError");
        input = new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        ).slice().buffer;
      } else {
        if (typeof data === "symbol") throw TypeError("Invalid WebSocket data");
        input = String(data);
      }
      const bytes =
        typeof input === "string"
          ? input.length > maxMessage
            ? maxMessage + 1
            : encode.encode(input).length
          : input instanceof BlobCtor
            ? input.size
            : input.byteLength;
      if (this.#state !== 1) {
        this.#buffered += bytes;
        return;
      }
      if (
        bytes > maxMessage ||
        this.#buffered + bytes > maxQueued ||
        this.#pending.size >= 64
      ) {
        this.close();
        throw new ErrorCtor(
          "WebSocket message/queue bound",
          "QuotaExceededError",
        );
      }
      this.#buffered += bytes;
      const n = ++this.#next;
      this.#pending.set(n, bytes);
      // Reserve byte budget before asynchronous Blob conversion; the ordered
      // tail prevents a later text send or close overtaking that Blob.
      const copy = input instanceof BufferCtor ? input.slice(0) : input;
      this.#tail = this.#tail
        .then(async () => {
          const payload =
            copy instanceof BlobCtor ? await copy.arrayBuffer() : copy;
          if (!live || this.#state === 3) return;
          send(
            this.#id,
            { type: "send", send: n, data: payload },
            typeof payload === "string" ? [] : [payload],
          );
        })
        .catch(() => dispose());
    }
    close(code?: number, reason = "") {
      if (typeof reason === "symbol") throw TypeError("Invalid close reason");
      const text = String(reason),
        numeric = code === undefined ? undefined : Number(code);
      if (!validClose(numeric, text)) {
        if (
          numeric !== undefined &&
          numeric !== 1000 &&
          !(Number.isInteger(numeric) && numeric >= 3000 && numeric <= 4999)
        )
          throw new ErrorCtor(
            "Invalid WebSocket close code",
            "InvalidAccessError",
          );
        throw new ErrorCtor(
          "WebSocket close reason exceeds123 bytes",
          "SyntaxError",
        );
      }
      if (this.#state === 2 || this.#state === 3) return;
      this.#state = 2;
      this.#tail = this.#tail
        .then(() => {
          if (live && this.#state !== 3)
            send(this.#id, { type: "close", code: numeric, reason: text });
        })
        .catch(() => dispose());
    }
  }
  for (const type of ["open", "message", "error", "close"])
    Object.defineProperty(WebSocket.prototype, "on" + type, {
      configurable: true,
      enumerable: true,
      get(this: WebSocket) {
        return this.handler(type);
      },
      set(this: WebSocket, value) {
        this.handler(type, value, true);
      },
    });
  for (const [key, value] of Object.entries({
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  })) {
    Object.defineProperty(WebSocket, key, { value, enumerable: true });
    Object.defineProperty(WebSocket.prototype, key, {
      value,
      enumerable: true,
    });
  }
  Object.defineProperty(WebSocket.prototype, Symbol.toStringTag, {
    value: "WebSocket",
    configurable: true,
  });
  const receive = (event: MessageEvent) => {
    const value = apply(nativeData, event, []);
    if (
      live &&
      value?.protocol === OPAQUE_WEBSOCKET_PROTOCOL &&
      value.documentId === documentId &&
      Number.isSafeInteger(value.socket)
    )
      sockets.get(value.socket)?.receive(value);
  };
  function dispose() {
    if (!live) return;
    for (const [socketId, socket] of [...sockets]) {
      try {
        send(socketId, { type: "close", reason: "" });
      } catch {}
      socket.receive({
        type: "close",
        code: 1006,
        reason: "",
        wasClean: false,
      });
    }
    live = false;
    apply(nativeRemove, port, ["message", receive]);
    apply(nativeRemove, port, ["messageerror", dispose]);
    apply(nativePortClose, port, []);
  }
  apply(nativeAdd, port, ["message", receive]);
  apply(nativeAdd, port, ["messageerror", dispose]);
  apply(nativePortStart, port, []);
  return {
    WebSocket: WebSocket as unknown as typeof realm.WebSocket,
    install() {
      Object.defineProperty(realm, "WebSocket", {
        value: WebSocket,
        writable: true,
        configurable: true,
      });
      Reflect.deleteProperty(realm, "WebSocketStream");
    },
    dispose,
    get sockets() {
      return sockets.size;
    },
  };
}
