/** Opaque-document synchronous cookie descriptor. All authority is in the
 * independently running trusted worker; no optimistic mirror or cookie parser.
 * Every accessor uses the explicit encrypted result rendezvous (not offline
 * native equivalence). Native XHR primitives are captured before website hooks. */
import {
  COOKIE_RESULT_PROTOCOL,
  openCookieResult,
  type CookieOperation,
} from "./sandbox-cookie-result.ts";
export async function createSandboxDocumentCookie(options: {
  documentId: string;
  endpoint: string;
  port: MessagePort;
  window?: Window & typeof globalThis;
  readyTimeoutMs?: number;
}) {
  const owner = options.window ?? window,
    { documentId, port } = options;
  const apply = Reflect.apply,
    dataGetter = Object.getOwnPropertyDescriptor(
      owner.MessageEvent.prototype,
      "data",
    )!.get!,
    postMessage = owner.MessagePort.prototype.postMessage,
    add = owner.EventTarget.prototype.addEventListener,
    remove = owner.EventTarget.prototype.removeEventListener,
    start = owner.MessagePort.prototype.start,
    close = owner.MessagePort.prototype.close,
    fill = owner.Uint8Array.prototype.fill;
  const endpoint = new URL(options.endpoint, owner.location.href);
  if (
    !/^[A-Za-z0-9_-]{16,96}$/.test(documentId) ||
    endpoint.origin !== owner.location.origin ||
    !/^\/browse\/cookies\/result\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new TypeError("Invalid cookie result endpoint");
  const XHR = owner.XMLHttpRequest,
    open = XHR.prototype.open,
    send = XHR.prototype.send,
    header = XHR.prototype.setRequestHeader;
  const responseText = Object.getOwnPropertyDescriptor(
      XHR.prototype,
      "responseText",
    )!.get!,
    status = Object.getOwnPropertyDescriptor(XHR.prototype, "status")!.get!;
  const post = (value: unknown) => apply(postMessage, port, [value]),
    parse = JSON.parse.bind(JSON),
    stringify = JSON.stringify.bind(JSON);
  let live = true,
    sequence = 0,
    key: Uint8Array | undefined,
    version = 0,
    documentURL = "",
    websiteOrigin = "";
  let receive: EventListener | undefined,
    messageError: EventListener | undefined;
  const dispose = () => {
    if (!live) return;
    live = false;
    try {
      post({ protocol: COOKIE_RESULT_PROTOCOL, documentId, type: "dispose" });
    } catch {}
    if (key) apply(fill, key, [0]);
    if (receive) apply(remove, port, ["message", receive]);
    if (messageError) apply(remove, port, ["messageerror", messageError]);
    apply(close, port, []);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = owner.setTimeout(() => {
      dispose();
      reject(new DOMException("Cookie binding timed out", "TimeoutError"));
    }, options.readyTimeoutMs ?? 10000);
    receive = (event) => {
      const data = apply(dataGetter, event, []);
      if (
        !live ||
        data?.protocol !== COOKIE_RESULT_PROTOCOL ||
        data?.documentId !== documentId
      )
        return;
      if (
        !key &&
        data.type === "ready" &&
        data.key instanceof owner.Uint8Array &&
        data.key.length === 32
      ) {
        const initial = new URL(data.documentURL);
        if (
          !/^https?:$/.test(initial.protocol) ||
          initial.username ||
          initial.password ||
          initial.origin === endpoint.origin
        ) {
          dispose();
          owner.clearTimeout(timer);
          reject(
            new DOMException("Invalid cookie website binding", "SecurityError"),
          );
          return;
        }
        initial.hash = "";
        documentURL = initial.href;
        websiteOrigin = initial.origin;
        key = data.key;
        owner.clearTimeout(timer);
        resolve();
      } else if (data.type === "revoked") {
        owner.clearTimeout(timer);
        dispose();
        reject(
          new DOMException("Cookie document revoked", "InvalidStateError"),
        );
      }
    };
    messageError = () => {
      owner.clearTimeout(timer);
      dispose();
      reject(new DOMException("Cookie binding failed", "InvalidStateError"));
    };
    apply(add, port, ["message", receive]);
    apply(add, port, ["messageerror", messageError]);
    apply(start, port, []);
  });
  function access(operation: CookieOperation, line?: string) {
    if (!live || !key)
      throw new DOMException("Cookie document disposed", "InvalidStateError");
    if (!Number.isSafeInteger(++sequence)) {
      dispose();
      throw new DOMException("Cookie sequence exhausted", "InvalidStateError");
    }
    const expected = { documentId, sequence, operation };
    post({
      protocol: COOKIE_RESULT_PROTOCOL,
      documentId,
      sequence,
      type: operation,
      url: documentURL,
      ...(operation === "set" ? { line } : {}),
    });
    try {
      const xhr = new XHR();
      apply(open, xhr, ["POST", endpoint.href, false]);
      apply(header, xhr, ["Content-Type", "text/plain;charset=UTF-8"]);
      apply(send, xhr, [stringify({ sequence })]);
      if (apply(status, xhr, []) !== 200)
        throw new DOMException(
          "Cookie result unavailable; a completed write may already be durable",
          "NetworkError",
        );
      const envelope = parse(apply(responseText, xhr, []));
      if (!envelope?.ok || typeof envelope.packet !== "string")
        throw new DOMException("Cookie result unavailable", "NetworkError");
      const result = openCookieResult(key, envelope.packet, expected);
      if (result.viewVersion < version)
        throw new DOMException("Stale cookie result", "SecurityError");
      version = result.viewVersion;
      if (result.error)
        throw new DOMException("Cookie operation failed", result.error);
      return result.view;
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return Object.freeze({
    get: () => access("get"),
    setURL(value: string) {
      const url = new URL(value);
      if (url.origin !== websiteOrigin || url.username || url.password)
        throw new DOMException(
          "Cookie website origin is immutable",
          "SecurityError",
        );
      url.hash = "";
      documentURL = url.href;
    },
    set(value: unknown) {
      if (typeof value === "symbol")
        throw new TypeError("Cookie value cannot be a Symbol");
      access("set", String(value));
    },
    install() {
      Object.defineProperty(owner.Document.prototype, "cookie", {
        configurable: true,
        enumerable: true,
        get() {
          if (this !== owner.document)
            throw new TypeError("Illegal invocation");
          return access("get");
        },
        set(value) {
          if (this !== owner.document)
            throw new TypeError("Illegal invocation");
          if (typeof value === "symbol")
            throw new TypeError("Cookie value cannot be a Symbol");
          access("set", String(value));
        },
      });
      Reflect.deleteProperty(owner, "cookieStore");
    },
    dispose,
  });
}
