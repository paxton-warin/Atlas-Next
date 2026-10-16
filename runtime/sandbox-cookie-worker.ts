/** Trusted frontend dedicated cookie worker. Its owner channel has the jar's
 * network authority; each document gets only a fixed-context get/set port and
 * its private filtered-result key. Never install this in website code. */
import {
  SandboxCookieJar,
  type CookieDocumentContext,
  type CookieRequestContext,
} from "./sandbox-cookies.ts";
import {
  COOKIE_RESULT_PROTOCOL,
  newCookieResultKey,
  sealCookieResult,
  MAX_COOKIE_PACKET_CHARS,
} from "./sandbox-cookie-result.ts";
/** Bound the browser's outbound WS queue as well as server receipt memory. */
export function sendBoundedCookieResult(
  socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "send">,
  result: { documentId: string; sequence: number; packet: string },
) {
  const wire = JSON.stringify({ type: "result", ...result });
  // All fields are bounded ASCII. UTF-8 byte length equals string length.
  if (
    socket.readyState !== 1 ||
    !Number.isFinite(socket.bufferedAmount) ||
    socket.bufferedAmount < 0 ||
    wire.length > MAX_COOKIE_PACKET_CHARS + 512 ||
    socket.bufferedAmount + wire.length > 12 * 1024 * 1024
  )
    throw new DOMException(
      "Cookie result transport backpressure",
      "QuotaExceededError",
    );
  socket.send(wire);
}
/** A document may update its same-origin SPA path, never its website authority. */
export function cookieDocumentURL(value: unknown, initial: string) {
  if (typeof value !== "string" || value.length > 16384)
    throw new DOMException("Invalid cookie document URL", "SecurityError");
  const url = new URL(value),
    bound = new URL(initial);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.origin !== bound.origin ||
    url.username ||
    url.password
  )
    throw new DOMException(
      "Cookie website origin is immutable",
      "SecurityError",
    );
  url.hash = "";
  return url.href;
}
type Scope = {
  location: { origin: string };
  indexedDB: IDBFactory;
  postMessage(value: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
};
export function installSandboxCookieWorker(scope: Scope) {
  type Binding = {
    context: CookieDocumentContext;
    url: string;
    document: ReturnType<SandboxCookieJar["document"]>;
    port: MessagePort;
    key: Uint8Array;
    next: number;
    version: number;
    pending: number;
    live: boolean;
    tail: Promise<void>;
  };
  const bindings = new Map<string, Binding>();
  const controls = new Map<string, AbortController>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let jar: SandboxCookieJar | undefined,
    socket: WebSocket | undefined,
    live = true,
    ready = false,
    controlPending = 0;
  const send = (value: unknown) => {
    if (live) scope.postMessage(value);
  };
  function revoke(id: string) {
    const b = bindings.get(id);
    if (!b) return;
    bindings.delete(id);
    b.live = false;
    b.document.dispose();
    b.key.fill(0);
    b.port.postMessage({
      protocol: COOKIE_RESULT_PROTOCOL,
      documentId: id,
      type: "revoked",
    });
    b.port.close();
  }
  function dispose() {
    if (!live) return;
    for (const id of bindings.keys()) revoke(id);
    send({ type: "unavailable" });
    live = false;
    ready = false;
    clearInterval(heartbeat);
    for (const controller of controls.values()) controller.abort();
    controls.clear();
    jar?.close();
    socket?.close();
  }
  const errorName = (error: any) =>
    ["AbortError", "QuotaExceededError", "InvalidStateError"].includes(
      error?.name,
    )
      ? error.name
      : "UnknownError";
  scope.addEventListener("message", async ({ data, ports }) => {
    if (!live || !data) return;
    try {
      if (data.type === "initialize") {
        if (jar) throw Error();
        const url = new URL(data.socketURL),
          frontend = new URL(scope.location.origin);
        if (
          url.protocol !== (frontend.protocol === "https:" ? "wss:" : "ws:") ||
          url.host !== frontend.host ||
          !/^\/browse\/cookies\/owner\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw Error();
        jar = new SandboxCookieJar({
          factory: scope.indexedDB,
          browserSessionId: data.browserSessionId,
          forbiddenOrigins: [frontend.origin, ...(data.forbiddenOrigins ?? [])],
        });
        socket = new WebSocket(url);
        socket.onmessage = ({ data: raw }) => {
          let message;
          try {
            message = JSON.parse(raw);
          } catch {
            return dispose();
          }
          if (message.type === "ready") {
            if (ready) return;
            ready = true;
            heartbeat = setInterval(() => {
              if (socket?.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: "ping" }));
            }, 30000);
            send({ type: "ready" });
          } else if (message.type === "revoke" || message.type === "cancel")
            revoke(message.documentId);
          // wait/pong are informational, never authorize an operation.
        };
        socket.onclose = () => {
          send({ type: "unavailable" });
          dispose();
        };
        socket.onerror = () => {
          send({ type: "unavailable" });
          dispose();
        };
      } else if (data.type === "bind-document") {
        if (
          !ready ||
          !jar ||
          ports.length !== 1 ||
          bindings.size >= 32 ||
          bindings.has(data.context?.documentId)
        )
          throw Error();
        const context = Object.freeze({
          ...data.context,
        }) as CookieDocumentContext;
        const document = jar.document(context),
          port = ports[0],
          key = newCookieResultKey();
        const b: Binding = {
          context,
          url: cookieDocumentURL(context.documentURL, context.documentURL),
          document,
          port,
          key,
          next: 1,
          version: 0,
          pending: 0,
          live: true,
          tail: Promise.resolve(),
        };
        bindings.set(context.documentId, b);
        port.onmessage = ({ data: op }) => {
          if (
            op?.protocol === COOKIE_RESULT_PROTOCOL &&
            op.documentId === context.documentId &&
            op.type === "dispose" &&
            Object.keys(op).every((k) =>
              ["protocol", "documentId", "type"].includes(k),
            )
          )
            return revoke(context.documentId);
          if (
            !b.live ||
            !op ||
            Object.keys(op).some(
              (k) =>
                ![
                  "protocol",
                  "documentId",
                  "sequence",
                  "type",
                  "line",
                  "url",
                ].includes(k),
            ) ||
            op.protocol !== COOKIE_RESULT_PROTOCOL ||
            op.documentId !== context.documentId ||
            op.sequence !== b.next ||
            !Number.isSafeInteger(b.next) ||
            !["get", "set"].includes(op.type) ||
            (op.type === "set"
              ? typeof op.line !== "string" || op.line.length > 16384
              : op.line !== undefined) ||
            b.pending >= 8
          )
            return revoke(context.documentId);
          let currentURL: string;
          try {
            currentURL = cookieDocumentURL(op.url, context.documentURL);
          } catch {
            return revoke(context.documentId);
          }
          b.next++;
          b.pending++;
          b.tail = b.tail
            .then(async () => {
              if (!b.live) return;
              if (b.url !== currentURL) {
                b.document.dispose();
                b.document = jar!.document({
                  ...context,
                  documentURL: currentURL,
                });
                b.url = currentURL;
              }
              let view = "",
                expiresAt: number | null = null,
                error: string | undefined;
              try {
                const result =
                  op.type === "set"
                    ? await b.document.set(op.line)
                    : await b.document.snapshot();
                view = "view" in result ? result.view : result.value;
                expiresAt = result.expiresAt;
              } catch (failure) {
                error = errorName(failure);
              }
              if (!b.live || socket?.readyState !== WebSocket.OPEN) return;
              const packet = sealCookieResult(key, {
                documentId: context.documentId,
                sequence: op.sequence,
                operation: op.type,
                view,
                viewVersion: ++b.version,
                expiresAt,
                ...(error ? { error } : {}),
              });
              sendBoundedCookieResult(socket, {
                documentId: context.documentId,
                sequence: op.sequence,
                packet,
              });
            })
            .catch(() => revoke(context.documentId))
            .finally(() => {
              b.pending--;
            });
        };
        port.onmessageerror = () => revoke(context.documentId);
        port.start();
        port.postMessage({
          protocol: COOKIE_RESULT_PROTOCOL,
          documentId: context.documentId,
          type: "ready",
          key: key.slice(),
          documentURL: context.documentURL,
        });
        send({ type: "document-bound", documentId: context.documentId });
      } else if (data.type === "unbind-document") revoke(data.documentId);
      else if (data.type === "dispose") dispose();
      else if (data.type === "cancel-network")
        controls
          .get(data.id)
          ?.abort(new DOMException("Cookie request aborted", "AbortError"));
      else if (
        data.type === "request-header" ||
        data.type === "response-cookies"
      ) {
        if (
          !jar ||
          !ready ||
          controlPending >= 32 ||
          typeof data.id !== "string" ||
          data.id.length > 128 ||
          controls.has(data.id)
        )
          throw Error();
        controlPending++;
        const abort = new AbortController();
        controls.set(data.id, abort);
        const fixed = {
          ...data.context,
          signal: abort.signal,
        } as CookieRequestContext;
        try {
          const result =
            data.type === "request-header"
              ? await jar.getRequestHeader(fixed)
              : await jar.storeResponseCookies(data.lines, fixed);
          send({ type: "network-result", id: data.id, result });
        } catch (error) {
          send({
            type: "network-result",
            id: data.id,
            error: errorName(error),
          });
        } finally {
          controls.delete(data.id);
          controlPending--;
        }
      }
    } catch (error) {
      send({
        type: "error",
        documentId: data.context?.documentId,
        error: errorName(error),
      });
      if (data.type === "initialize") dispose();
    }
  });
  return { dispose };
}
if (
  typeof globalThis.document === "undefined" &&
  typeof globalThis.postMessage === "function" &&
  typeof globalThis.indexedDB !== "undefined"
)
  installSandboxCookieWorker(globalThis as unknown as Scope);
