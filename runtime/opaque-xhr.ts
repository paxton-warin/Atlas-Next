/** Document-local asynchronous XMLHttpRequest over the fixed-document network
 * broker. No native URL/credential fallback exists. The current transport is
 * buffered: progress describes received bytes, never invented wire/upload ACKs.
 * Synchronous website XHR remains an explicit qualification gate. */
import type {
  OpaqueNetworkRequest,
  OpaqueNetworkResponse,
} from "./opaque-runtime-adapter.ts";

type Realm = Window & typeof globalThis;
type Options = {
  window?: Realm;
  documentURL: () => string;
  fetch: typeof fetch;
  request?: (
    request: OpaqueNetworkRequest & { forcePreflight?: boolean },
    signal?: AbortSignal,
  ) => Promise<OpaqueNetworkResponse>;
  maxBodyBytes?: number;
  maxPending?: number;
};
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN =
  /^(?:accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|permissions-policy|referer|set-cookie2?|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
export function createOpaqueXMLHttpRequest(options: Options) {
  const realm = options.window ?? window;
  const EventBase = realm.EventTarget,
    EventCtor = realm.Event;
  const Progress = realm.ProgressEvent,
    NativeRequest = realm.Request,
    NativeHeaders = realm.Headers;
  const TextDecoderCtor = realm.TextDecoder,
    TextEncoderCtor = realm.TextEncoder;
  const BlobCtor = realm.Blob,
    BufferCtor = realm.ArrayBuffer;
  const URLCtor = realm.URL,
    AbortCtor = realm.AbortController,
    DOMError = realm.DOMException;
  const parseJSON = realm.JSON.parse.bind(realm.JSON),
    now = realm.Date.now.bind(realm.Date);
  const parser = realm.DOMParser,
    serializer = realm.XMLSerializer;
  const setTimer = realm.setTimeout.bind(realm),
    clearTimer = realm.clearTimeout.bind(realm);
  const maxBytes = options.maxBodyBytes ?? 8 * 1024 * 1024,
    maxPending = options.maxPending ?? 32;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 256
  )
    throw TypeError("Invalid XHR body bound");
  const nativeAdd = EventBase.prototype.addEventListener,
    nativeRemove = EventBase.prototype.removeEventListener;
  const nativeDispatch = EventBase.prototype.dispatchEvent;
  const active = new Set<XMLHttpRequest>();
  let live = true;
  const error = (name: string, message: string) => new DOMError(message, name);
  const string = (value: unknown) => {
    if (typeof value === "symbol") throw TypeError("Symbol is not a string");
    return String(value);
  };
  const bytestring = (value: unknown) => {
    const text = string(value);
    if (/[^\x00-\xff]/.test(text)) throw TypeError("Value is not a ByteString");
    return text;
  };
  class XMLHttpRequestEventTarget extends EventBase {
    #handlers = new Map<string, { value: Function; listener: EventListener }>();
    handler(type: string, value?: unknown, write = false): unknown {
      if (!write) return this.#handlers.get(type)?.value ?? null;
      const previous = this.#handlers.get(type);
      if (previous && typeof value === "function") {
        previous.value = value;
        return;
      }
      if (previous) nativeRemove.call(this, type, previous.listener);
      this.#handlers.delete(type);
      if (typeof value === "function") {
        const listener = (event: Event) =>
          this.#handlers.get(type)?.value.call(this, event);
        this.#handlers.set(type, { value, listener });
        nativeAdd.call(this, type, listener);
      }
    }
  }
  for (const type of [
    "loadstart",
    "progress",
    "abort",
    "error",
    "load",
    "timeout",
    "loadend",
  ])
    Object.defineProperty(XMLHttpRequestEventTarget.prototype, "on" + type, {
      enumerable: true,
      configurable: true,
      get(this: XMLHttpRequestEventTarget) {
        return this.handler(type);
      },
      set(this: XMLHttpRequestEventTarget, value) {
        this.handler(type, value, true);
      },
    });
  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    #state = 0;
    #sent = false;
    #method = "GET";
    #url = "";
    #headers = new NativeHeaders();
    #responseHeaders = new NativeHeaders();
    #timeout = 0;
    #credentials = false;
    #responseType = "";
    #mime = "";
    #status = 0;
    #statusText = "";
    #responseURL = "";
    #chunks: Uint8Array[] = [];
    #length = 0;
    #parsed: unknown = undefined;
    #controller?: AbortController;
    #timer?: number;
    #started = 0;
    #epoch = 0;
    #upload = new XMLHttpRequestUpload();
    #uploadDone = true;
    #uploadBytes = 0;
    constructor() {
      super();
    }
    get readyState() {
      return this.#state;
    }
    get upload() {
      return this.#upload;
    }
    get status() {
      return this.#status;
    }
    get statusText() {
      return this.#statusText;
    }
    get responseURL() {
      return this.#responseURL;
    }
    get withCredentials() {
      return this.#credentials;
    }
    set withCredentials(value: boolean) {
      if (this.#sent || ![0, 1].includes(this.#state))
        throw error("InvalidStateError", "XHR credentials are locked");
      this.#credentials = Boolean(value);
    }
    get timeout() {
      return this.#timeout;
    }
    set timeout(value: number) {
      const numeric = Number(value);
      this.#timeout =
        !Number.isFinite(numeric) || numeric === 0
          ? 0
          : ((Math.trunc(numeric) % 4294967296) + 4294967296) % 4294967296;
      this.#armTimeout();
    }
    get responseType() {
      return this.#responseType as XMLHttpRequestResponseType;
    }
    set responseType(value: XMLHttpRequestResponseType) {
      if (this.#state === 3 || this.#state === 4)
        throw error("InvalidStateError", "XHR response type is locked");
      const text = string(value);
      if (
        ["", "text", "arraybuffer", "blob", "document", "json"].includes(text)
      )
        this.#responseType = text;
    }
    get responseText() {
      if (!["", "text"].includes(this.#responseType))
        throw error("InvalidStateError", "XHR response is not text");
      return this.#state < 3 ? "" : this.#text();
    }
    get responseXML(): Document | null {
      if (!["", "document"].includes(this.#responseType))
        throw error("InvalidStateError", "XHR response is not a document");
      if (this.#state !== 4 || !this.#status) return null;
      const mime = this.#contentType().split(";")[0].trim().toLowerCase();
      if (
        !(
          mime.endsWith("+xml") ||
          mime === "application/xml" ||
          mime === "text/xml" ||
          (mime === "text/html" && this.#responseType === "document")
        )
      )
        return null;
      if (this.#parsed === undefined) {
        const document = new parser().parseFromString(
          this.#text(),
          mime === "text/html" ? "text/html" : "application/xml",
        );
        this.#parsed =
          mime !== "text/html" &&
          document.getElementsByTagName("parsererror").length
            ? null
            : document;
      }
      return this.#parsed as Document | null;
    }
    get response(): unknown {
      if (["", "text"].includes(this.#responseType)) return this.responseText;
      if (this.#state !== 4 || !this.#status) return null;
      if (this.#responseType === "document") return this.responseXML;
      if (this.#parsed === undefined) {
        const bytes = this.#bytes();
        if (this.#responseType === "arraybuffer") this.#parsed = bytes.buffer;
        else if (this.#responseType === "blob")
          this.#parsed = new BlobCtor([bytes], { type: this.#contentType() });
        else {
          try {
            this.#parsed = parseJSON(new TextDecoderCtor().decode(bytes));
          } catch {
            this.#parsed = null;
          }
        }
      }
      return this.#parsed;
    }
    #bytes() {
      const output = new Uint8Array(this.#length);
      let at = 0;
      for (const chunk of this.#chunks) {
        output.set(chunk, at);
        at += chunk.length;
      }
      return output;
    }
    #contentType() {
      return (
        this.#mime || this.#responseHeaders.get("content-type") || "text/xml"
      );
    }
    #text() {
      const charset =
        this.#contentType().match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ||
        "utf-8";
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoderCtor(charset);
      } catch {
        decoder = new TextDecoderCtor();
      }
      return decoder.decode(this.#bytes(), { stream: this.#state !== 4 });
    }
    #emit(
      target: EventTarget,
      type: string,
      loaded = 0,
      total = 0,
      lengthComputable = false,
    ) {
      nativeDispatch.call(
        target,
        new Progress(type, { loaded, total, lengthComputable }),
      );
    }
    #change(state: number) {
      this.#state = state;
      nativeDispatch.call(this, new EventCtor("readystatechange"));
    }
    #resetResponse() {
      this.#status = 0;
      this.#statusText = "";
      this.#responseURL = "";
      this.#responseHeaders = new NativeHeaders();
      this.#chunks = [];
      this.#length = 0;
      this.#parsed = undefined;
    }
    #armTimeout() {
      clearTimer(this.#timer);
      if (this.#sent && this.#timeout) {
        const epoch = this.#epoch;
        this.#timer = setTimer(
          () => {
            if (epoch === this.#epoch && this.#sent) this.#fail("timeout");
          },
          Math.max(0, this.#timeout - (now() - this.#started)),
        );
      }
    }
    #fail(type: "abort" | "timeout" | "error") {
      if (!this.#sent) return;
      const epoch = ++this.#epoch;
      this.#controller?.abort();
      clearTimer(this.#timer);
      this.#sent = false;
      active.delete(this);
      this.#resetResponse();
      this.#change(4);
      if (epoch !== this.#epoch) return;
      if (!this.#uploadDone) {
        this.#uploadDone = true;
        this.#emit(this.#upload, type);
        this.#emit(this.#upload, "loadend");
      }
      if (epoch !== this.#epoch) return;
      this.#emit(this, type);
      if (epoch === this.#epoch) this.#emit(this, "loadend");
    }
    open(
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      if (arguments.length < 2)
        throw TypeError("XHR.open requires method and URL");
      let verb = bytestring(method);
      if (!TOKEN.test(verb)) throw error("SyntaxError", "Invalid HTTP method");
      if (/^(CONNECT|TRACE|TRACK)$/i.test(verb))
        throw error("SecurityError", "Forbidden HTTP method");
      if (/^(DELETE|GET|HEAD|OPTIONS|POST|PUT)$/i.test(verb))
        verb = verb.toUpperCase();
      const address = new URLCtor(string(url), options.documentURL());
      if (
        !/^https?:$/.test(address.protocol) ||
        address.username ||
        address.password ||
        username != null ||
        password != null
      )
        throw error(
          "NotSupportedError",
          "XHR requires a credential-free HTTP(S) URL",
        );
      if (!(arguments.length < 3 ? true : Boolean(async)))
        throw error(
          "NotSupportedError",
          "Synchronous website XHR is not qualified",
        );
      address.hash = "";
      ++this.#epoch;
      this.#controller?.abort();
      clearTimer(this.#timer);
      active.delete(this);
      this.#sent = false;
      this.#method = verb;
      this.#url = address.href;
      this.#headers = new NativeHeaders();
      // overrideMimeType is intentionally retained across open(), per XHR.
      this.#resetResponse();
      if (this.#state !== 1) this.#change(1);
    }
    setRequestHeader(name: string, value: string) {
      if (arguments.length < 2)
        throw TypeError("XHR.setRequestHeader requires name and value");
      if (this.#state !== 1 || this.#sent)
        throw error("InvalidStateError", "XHR headers are locked");
      const key = bytestring(name),
        text = bytestring(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
      if (!TOKEN.test(key) || /[\0\r\n]/.test(text))
        throw error("SyntaxError", "Invalid HTTP header");
      if (
        FORBIDDEN.test(key) ||
        (/^x-http-method(?:-override)?$|^x-method-override$/i.test(key) &&
          text
            .split(",")
            .some((s) => /^(CONNECT|TRACE|TRACK)$/i.test(s.trim())))
      )
        return;
      this.#headers.append(key, text);
    }
    getResponseHeader(name: string) {
      if (!arguments.length)
        throw TypeError("XHR.getResponseHeader requires a name");
      const key = bytestring(name);
      if (this.#state < 2 || !TOKEN.test(key) || /^set-cookie2?$/i.test(key))
        return null;
      return this.#responseHeaders.get(key);
    }
    getAllResponseHeaders() {
      return this.#state < 2
        ? ""
        : [...this.#responseHeaders]
            .filter(([key]) => !/^set-cookie2?$/i.test(key))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join("");
    }
    overrideMimeType(value: string) {
      if (this.#state === 3 || this.#state === 4)
        throw error("InvalidStateError", "XHR MIME type is locked");
      const mime = string(value);
      this.#mime =
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]*)?$/.test(
          mime,
        )
          ? mime
          : "application/octet-stream";
    }
    abort() {
      if (this.#sent) this.#fail("abort");
      if (this.#state === 4) {
        this.#state = 0;
        this.#resetResponse();
      }
    }
    send(body: Document | XMLHttpRequestBodyInit | null = null) {
      if (!live) throw error("InvalidStateError", "XHR document is disposed");
      if (this.#state !== 1 || this.#sent)
        throw error("InvalidStateError", "XHR is not opened or already sent");
      if (active.size >= maxPending)
        throw error("QuotaExceededError", "XHR document concurrency bound");
      let payload: BodyInit | null = ["GET", "HEAD"].includes(this.#method)
        ? null
        : (body as BodyInit);
      const headers = new NativeHeaders(this.#headers);
      if (
        payload &&
        typeof payload === "object" &&
        (payload as any).nodeType === 9
      ) {
        const document = payload as unknown as Document;
        payload = new serializer().serializeToString(document);
        if (!headers.has("content-type"))
          headers.set(
            "content-type",
            document.contentType === "text/html"
              ? "text/html;charset=UTF-8"
              : "application/xml;charset=UTF-8",
          );
      }
      if (
        (payload instanceof BlobCtor && payload.size > maxBytes) ||
        (payload instanceof BufferCtor && payload.byteLength > maxBytes) ||
        (BufferCtor.isView(payload) && payload.byteLength > maxBytes) ||
        (typeof payload === "string" && payload.length > maxBytes)
      )
        throw error(
          "QuotaExceededError",
          "XHR request exceeds document body bound",
        );
      if (payload instanceof realm.FormData) {
        let size = 0;
        for (const [key, value] of payload) {
          size +=
            key.length * 3 +
            (typeof value === "string" ? value.length * 3 : value.size) +
            512;
          if (size > maxBytes)
            throw error(
              "QuotaExceededError",
              "XHR form exceeds document body bound",
            );
        }
      }
      const request = new NativeRequest(this.#url, {
        method: this.#method,
        headers,
        body: payload,
        credentials: this.#credentials ? "include" : "same-origin",
        mode: "cors",
        redirect: "follow",
      });
      const epoch = ++this.#epoch;
      this.#controller = new AbortCtor();
      this.#sent = true;
      this.#started = now();
      // Chromium reports terminal upload errors before response headers even
      // for bodyless requests; successful bodyless requests emit none.
      this.#uploadDone = false;
      this.#uploadBytes =
        typeof payload === "string"
          ? new TextEncoderCtor().encode(payload).length
          : payload instanceof BlobCtor
            ? payload.size
            : payload instanceof BufferCtor || BufferCtor.isView(payload)
              ? payload.byteLength
              : payload instanceof realm.URLSearchParams
                ? new TextEncoderCtor().encode(payload.toString()).length
                : 0;
      active.add(this);
      this.#armTimeout();
      this.#emit(this, "loadstart");
      if (!this.#sent || this.#epoch !== epoch) return;
      if (payload !== null)
        this.#emit(
          this.#upload,
          "loadstart",
          0,
          this.#uploadBytes,
          this.#uploadBytes > 0,
        );
      if (!this.#sent || this.#epoch !== epoch) return;
      void this.#run(epoch, request, payload !== null);
    }
    async #run(epoch: number, request: Request, hasBody: boolean) {
      const current = () => this.#sent && this.#epoch === epoch;
      try {
        const bytes = hasBody ? await request.arrayBuffer() : undefined;
        if (!current()) return;
        if (bytes && bytes.byteLength > maxBytes)
          throw error(
            "QuotaExceededError",
            "XHR request exceeds document body bound",
          );
        this.#uploadBytes = bytes?.byteLength ?? 0;
        const crossOrigin =
          new URLCtor(request.url).origin !==
          new URLCtor(options.documentURL()).origin;
        let result: Response, responseURL: string;
        if (options.request) {
          const raw = await options.request(
            {
              url: request.url,
              method: request.method,
              headers: [...request.headers],
              body: bytes,
              credentials: request.credentials,
              mode: "cors",
              redirect: "follow",
              forcePreflight: crossOrigin,
            },
            this.#controller!.signal,
          );
          if (
            raw.type === "opaque" ||
            raw.type === "opaqueredirect" ||
            raw.status === 0
          )
            throw TypeError("Unreadable XHR response");
          result = new realm.Response(
            [204, 205, 304].includes(raw.status) || request.method === "HEAD"
              ? null
              : raw.body,
            {
              status: raw.status,
              statusText: raw.statusText,
              headers: raw.headers,
            },
          );
          responseURL = raw.url;
        } else {
          if (crossOrigin)
            throw error(
              "NotSupportedError",
              "Cross-origin XHR requires the checked preflight broker",
            );
          result = await options.fetch(request, {
            signal: this.#controller!.signal,
          });
          responseURL = result.url || request.url;
        }
        if (!current()) return;
        if (!hasBody) this.#uploadDone = true;
        if (!this.#uploadDone) {
          this.#uploadDone = true;
          this.#emit(
            this.#upload,
            "progress",
            this.#uploadBytes,
            this.#uploadBytes,
            true,
          );
          this.#emit(
            this.#upload,
            "load",
            this.#uploadBytes,
            this.#uploadBytes,
            true,
          );
          this.#emit(
            this.#upload,
            "loadend",
            this.#uploadBytes,
            this.#uploadBytes,
            true,
          );
        }
        if (!current()) return;
        this.#status = result.status;
        this.#statusText = result.statusText;
        this.#responseURL = responseURL;
        this.#responseHeaders = new NativeHeaders(
          [...result.headers].filter(([key]) => !/^set-cookie2?$/i.test(key)),
        );
        this.#change(2);
        if (!current()) return;
        const expected = this.#responseHeaders.get("content-length"),
          total = expected && /^\d+$/.test(expected) ? Number(expected) : 0;
        if (total > maxBytes)
          throw error(
            "QuotaExceededError",
            "XHR response exceeds document body bound",
          );
        const reader = result.body?.getReader();
        if (reader)
          try {
            while (current()) {
              const { done, value } = await reader.read();
              if (!current()) return;
              if (done) break;
              if (
                !(value instanceof Uint8Array) ||
                this.#length + value.byteLength > maxBytes ||
                this.#chunks.length >= 4096
              )
                throw error(
                  "QuotaExceededError",
                  "XHR response exceeds document body bound",
                );
              this.#chunks.push(value);
              this.#length += value.byteLength;
              this.#change(3);
              if (!current()) return;
              this.#emit(this, "progress", this.#length, total, total > 0);
              if (!current()) return;
            }
          } finally {
            if (!current()) void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        if (!current()) return;
        clearTimer(this.#timer);
        this.#sent = false;
        active.delete(this);
        this.#change(4);
        if (this.#epoch !== epoch) return;
        this.#emit(this, "load", this.#length, total, total > 0);
        if (this.#epoch === epoch)
          this.#emit(this, "loadend", this.#length, total, total > 0);
      } catch {
        if (current()) this.#fail("error");
      }
    }
  }
  Object.defineProperty(XMLHttpRequest.prototype, "onreadystatechange", {
    enumerable: true,
    configurable: true,
    get(this: XMLHttpRequest) {
      return this.handler("readystatechange");
    },
    set(this: XMLHttpRequest, value) {
      this.handler("readystatechange", value, true);
    },
  });
  for (const [key, value] of Object.entries({
    UNSENT: 0,
    OPENED: 1,
    HEADERS_RECEIVED: 2,
    LOADING: 3,
    DONE: 4,
  })) {
    Object.defineProperty(XMLHttpRequest, key, { value, enumerable: true });
    Object.defineProperty(XMLHttpRequest.prototype, key, {
      value,
      enumerable: true,
    });
  }
  for (const [ctor, tag] of [
    [XMLHttpRequestEventTarget, "XMLHttpRequestEventTarget"],
    [XMLHttpRequestUpload, "XMLHttpRequestUpload"],
    [XMLHttpRequest, "XMLHttpRequest"],
  ] as const)
    Object.defineProperty(ctor.prototype, Symbol.toStringTag, {
      value: tag,
      configurable: true,
    });
  return {
    XMLHttpRequest: XMLHttpRequest as unknown as typeof realm.XMLHttpRequest,
    XMLHttpRequestUpload,
    XMLHttpRequestEventTarget,
    install() {
      Object.defineProperty(realm, "XMLHttpRequest", {
        value: XMLHttpRequest,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(realm, "XMLHttpRequestUpload", {
        value: XMLHttpRequestUpload,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(realm, "XMLHttpRequestEventTarget", {
        value: XMLHttpRequestEventTarget,
        configurable: true,
        writable: true,
      });
    },
    dispose() {
      live = false;
      for (const request of [...active]) request.abort();
    },
  };
}
