import {
  SANDBOX_RELAY_PROTOCOL as protocol,
  sandboxRelayURL,
  SANDBOX_RELAY_SOCKET_LIMITS as socketLimits,
  validRelaySocketRequest,
} from "./sandbox-relay-protocol.ts";
import { createPinnedRelayWebSocket } from "./sandbox-relay-websocket.ts";
import {
  resourceResponseBudget,
  AGGREGATE_RELAY_RESPONSE_BYTES,
  RELAY_RESPONSE_CHUNK_LIMIT,
} from "./resource-response-budget.ts";
import type { OpaqueTrustedSocket } from "./opaque-websocket.ts";
declare const __OPAQUE_HTTPENGINE_ASSET__: string;

/** The shipped HttpEngine0.7.4 closes its ReadableStream BEFORE reporting a
 * libcurl error to an already-resolved request promise. Without this narrow
 * instance adapter a truncated HTTP200 body is incorrectly accepted as success.
 * Keep the original bundle unchanged; propagate its real completion status. */
export function propagatePinnedRelayStreamFailures(session: any) {
  const original = session?.stream_response;
  if (typeof original !== "function")
    throw new Error("relay_transport_version_unsupported");
  // A held request can be removed without a native CURLMSG_DONE callback. Only
  // reconcile its JS counters AFTER native removal, and only for the exact
  // callback object still owned by that handle generation. Natural completion
  // (including completion inside native removal) wins and is never decremented twice.
  type RequestOwner = { id: number; callback: unknown; scheduled: boolean };
  const owners = new Map<number, RequestOwner>();
  const remove = session.remove_request_now;
  const scheduleRemove = session.remove_request;
  const tracksRequests =
    typeof remove === "function" &&
    typeof scheduleRemove === "function" &&
    Array.isArray(session.requests_list) &&
    typeof session.request_callbacks === "object";
  if (tracksRequests) {
    session.remove_request_now = function (handle: number) {
      if (!this.requests_list.includes(handle)) return;
      const owner = owners.get(handle);
      const result = remove.call(this, handle);
      if (owner && owners.get(handle) === owner) {
        owners.delete(handle);
        if (this.request_callbacks[owner.id] === owner.callback) {
          delete this.request_callbacks[owner.id];
          if (this.active_requests > 0) this.active_requests--;
        }
      }
      return result;
    };
    session.remove_request = function (handle: number) {
      const owner = owners.get(handle);
      if (!owner) return scheduleRemove.call(this, handle);
      if (owner.scheduled) return;
      owner.scheduled = true;
      // Preserve the pin's deferred cleanup, but bind the timer to this request
      // generation so a reused pointer cannot be freed by an older timer.
      setTimeout(() => {
        if (owners.get(handle) === owner) this.remove_request_now(handle);
      }, 1);
    };
  }
  session.stream_response = function (
    url: string,
    headers: any,
    end: any,
    signal: AbortSignal,
  ) {
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let failure: Error | undefined;
    let terminal = false;
    const detach = () => signal?.removeEventListener("abort", abort);
    const finish = (code: number) => {
      if (terminal) return;
      // The vendor clears its closed-over request handle inside end(). Late
      // native headers MUST be gated before that happens: _http_get_info(null)
      // otherwise corrupts Wasm state after an ordinary navigation cancellation.
      terminal = true;
      detach();
      if (code !== 0) {
        failure = new Error(
          code === -1 ? "relay_request_aborted" : "relay_upstream_failed",
        );
        try {
          output?.error(failure);
        } catch {}
        void reader?.cancel(failure).catch(() => {});
      }
      end(code);
    };
    const abort = () => finish(-1);
    const requestId = this.last_request_id;
    const handle = original.call(
      this,
      url,
      (source: ReadableStream<Uint8Array>) => {
        if (terminal) {
          void source.cancel().catch(() => {});
          return;
        }
        reader = source.getReader();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
            if (failure) controller.error(failure);
          },
          async pull(controller) {
            try {
              const chunk = await reader!.read();
              if (failure) throw failure;
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            } catch (error) {
              try {
                controller.error(error);
              } catch {}
            }
          },
          cancel(reason) {
            return reader!.cancel(reason);
          },
        });
        headers(body);
      },
      finish,
      // Do not install the pinned bundle's ungated abort listener. The instance
      // adapter owns the signal and preserves native cleanup through end(-1).
      undefined,
    );
    if (
      tracksRequests &&
      Number.isInteger(requestId) &&
      this.request_callbacks[requestId]
    )
      owners.set(handle, {
        id: requestId,
        callback: this.request_callbacks[requestId],
        scheduled: false,
      });
    if (!terminal) signal?.addEventListener("abort", abort, { once: true });
    // request_async assigns/starts the returned native handle only AFTER this
    // function returns; synchronous end(-1) here would see a null handle too.
    if (!terminal && signal?.aborted) queueMicrotask(abort);
    return handle;
  };
}

/** Each assignment has its own worker realm. The pinned HttpEngine's relay URL
 * is GLOBAL to a realm; rotating it in a shared window would redirect new
 * sockets belonging to older sessions. Do not share this worker across nodes. */
export function installSandboxRelayWorker(
  scope: any,
  load?: () => Promise<any>,
) {
  const controllers = new Map<number, AbortController>();
  let bufferedResponseBytes = 0;
  type SocketState = {
    id: number;
    controller: AbortController;
    socket?: OpaqueTrustedSocket;
    timer: ReturnType<typeof setTimeout>;
    open: boolean;
    closing?: boolean;
    incoming: Map<number, number>;
    incomingBytes: number;
    next: number;
    handshake?: { resolve(): void; reject(reason: Error): void };
  };
  const sockets = new Map<number, SocketState>();
  let incomingBytes = 0;
  function finishSocket(
    state: SocketState,
    code = 1006,
    reason = "",
    wasClean = false,
  ) {
    if (!sockets.delete(state.id)) return;
    clearTimeout(state.timer);
    state.handshake?.reject(new Error("relay_websocket_closed"));
    state.handshake = undefined;
    incomingBytes -= state.incomingBytes;
    state.incoming.clear();
    state.incomingBytes = 0;
    state.controller.abort();
    try {
      state.socket?.close();
    } catch {}
    send({ id: state.id, type: "ws-close", code, reason, wasClean });
  }
  function socketError(state: SocketState) {
    if (!sockets.has(state.id)) return;
    send({ id: state.id, type: "ws-error" });
    finishSocket(state);
  }
  function socketCommand(value: any) {
    if (typeof value.type !== "string" || !value.type.startsWith("ws-"))
      return false;
    if (value.type === "ws-open") {
      if (
        !client?.ready ||
        sockets.has(value.id) ||
        sockets.size >= socketLimits.sockets ||
        !Number.isInteger(value.timeoutMs) ||
        value.timeoutMs < 1 ||
        value.timeoutMs > 120000 ||
        !validRelaySocketRequest(value.url, value.protocols, value.headers)
      ) {
        send({ id: value.id, type: "ws-error" });
        send({
          id: value.id,
          type: "ws-close",
          code: 1006,
          reason: "",
          wasClean: false,
        });
        return true;
      }
      const state: SocketState = {
        id: value.id,
        controller: new AbortController(),
        timer: setTimeout(() => socketError(state), value.timeoutMs || 15000),
        open: false,
        incoming: new Map(),
        incomingBytes: 0,
        next: 0,
      };
      sockets.set(state.id, state);
      try {
        state.socket = createPinnedRelayWebSocket({
          client,
          url: value.url,
          protocols: value.protocols,
          headers: value.headers,
          signal: state.controller.signal,
          events: {
            open: (selectedProtocol, extensions) => {
              if (!sockets.has(state.id)) return;
              clearTimeout(state.timer);
              state.open = true;
              send({
                id: state.id,
                type: "ws-open",
                selectedProtocol,
                extensions,
              });
            },
            message: (data) => {
              if (!sockets.has(state.id) || !state.open) return;
              const bytes =
                typeof data === "string"
                  ? data.length > socketLimits.messageBytes
                    ? socketLimits.messageBytes + 1
                    : new TextEncoder().encode(data).length
                  : data.byteLength;
              if (
                bytes > socketLimits.messageBytes ||
                incomingBytes + bytes > socketLimits.queuedBytes ||
                state.incoming.size >= socketLimits.incomingMessages
              )
                return socketError(state);
              const message = ++state.next;
              state.incoming.set(message, bytes);
              state.incomingBytes += bytes;
              incomingBytes += bytes;
              send(
                { id: state.id, type: "ws-message", message, data },
                typeof data === "string" ? [] : [data],
              );
            },
            close: (code, reason, wasClean) =>
              finishSocket(state, code, reason, wasClean),
            error: () => socketError(state),
          },
          onHandshake: (headers) =>
            new Promise<void>((resolve, reject) => {
              if (!sockets.has(state.id))
                return reject(new Error("relay_websocket_closed"));
              state.handshake = { resolve, reject };
              send({ id: state.id, type: "ws-headers", headers });
            }),
        });
      } catch {
        socketError(state);
      }
      return true;
    }
    const state = sockets.get(value.socket);
    if (value.type === "ws-send") {
      try {
        if (
          !state?.open ||
          state.closing ||
          !(typeof value.data === "string" || value.data instanceof ArrayBuffer)
        )
          throw Error();
        const bytes =
          typeof value.data === "string"
            ? value.data.length > socketLimits.messageBytes
              ? socketLimits.messageBytes + 1
              : new TextEncoder().encode(value.data).length
            : value.data.byteLength;
        if (bytes > socketLimits.messageBytes) throw Error();
        state.socket!.send(value.data);
        send({ id: value.id, type: "ws-sent" });
      } catch {
        send({
          id: value.id,
          type: "error",
          code: "relay_websocket_send_failed",
        });
        if (state) socketError(state);
      } finally {
        send({ id: value.id, type: "settled" });
      }
    } else if (value.type === "ws-close") {
      if (state && !state.closing) {
        state.closing = true;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => finishSocket(state), 800);
        try {
          state.socket?.close(value.code, value.reason);
        } catch {
          socketError(state);
        }
      }
    } else if (value.type === "ws-received") {
      if (state) {
        const bytes = state.incoming.get(value.message);
        if (bytes === undefined) socketError(state);
        else {
          state.incoming.delete(value.message);
          state.incomingBytes -= bytes;
          incomingBytes -= bytes;
        }
      }
    } else if (value.type === "ws-headers-committed") {
      if (state?.handshake) {
        const pending = state.handshake;
        state.handshake = undefined;
        pending.resolve();
      }
    } else if (state) socketError(state);
    return true;
  }
  let client: any,
    initialized = false,
    disposed = false;
  const send = (value: object, transfer: Transferable[] = []) => {
    if (!disposed) scope.postMessage({ protocol, ...value }, transfer);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    for (const state of [...sockets.values()]) finishSocket(state);
    // Terminating the worker is the owner's final cleanup; close libcurl too.
    try {
      client?.session?.close();
    } catch {}
  };
  async function probe(relay: string, signal: AbortSignal) {
    if (signal.aborted || disposed) throw new Error("relay_probe_aborted");
    await new Promise<void>((resolve, reject) => {
      const socket = new scope.WebSocket(relay);
      socket.binaryType = "arraybuffer";
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        socket.onopen =
          socket.onerror =
          socket.onclose =
          socket.onmessage =
            null;
        try {
          socket.close();
        } catch {}
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error("relay_probe_aborted"));
      signal.addEventListener("abort", abort, { once: true });
      socket.onerror = () => finish(new Error("relay_unavailable"));
      socket.onclose = () => finish(new Error("relay_unavailable"));
      // Wisp v1 server's initial CONTINUE packet authenticates a live upgrade;
      // merely initializing the libcurl Wasm does NOT establish a relay socket.
      socket.onmessage = (event: MessageEvent) => {
        const bytes =
          event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
        if (
          !bytes ||
          bytes.length !== 9 ||
          bytes[0] !== 3 ||
          new DataView(bytes.buffer).getUint32(1, true) !== 0
        )
          return finish(new Error("relay_protocol_mismatch"));
        finish();
      };
    });
  }
  scope.addEventListener("message", async (event: MessageEvent) => {
    const value = event.data;
    if (
      disposed ||
      value?.protocol !== protocol ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1
    )
      return;
    if (socketCommand(value)) return;
    if (value.type === "cancel") {
      controllers.get(value.target)?.abort();
      return;
    }
    if (value.type === "dispose") {
      dispose();
      return;
    }
    if (controllers.has(value.id) || controllers.size >= 16) {
      send({ id: value.id, type: "error", code: "relay_request_limit" });
      return;
    }
    const controller = new AbortController();
    controllers.set(value.id, controller);
    let rawResponse: any;
    let retainedResponseBytes = 0;
    const timeout = setTimeout(
      () => controller.abort(),
      value.timeoutMs || 15000,
    );
    try {
      if (value.type === "initialize") {
        if (initialized) throw new Error("relay_already_initialized");
        initialized = true;
        const relay = sandboxRelayURL(
          value.assignment,
          scope.location.protocol === "https:",
        );
        const globals = load
          ? await load()
          : await (async () => {
              // Fixed trusted asset, not a document-chosen script URL. The unchanged
              // shipped UMD bundle supports a dedicated Worker global.
              await import(
                /* @vite-ignore */ new URL(
                  typeof __OPAQUE_HTTPENGINE_ASSET__ === "string"
                    ? __OPAQUE_HTTPENGINE_ASSET__
                    : "/clients/httpengine-client.js",
                  scope.location.origin,
                ).href
              );
              return scope.HttpEngineTransport;
            })();
        if (controller.signal.aborted || disposed)
          throw new Error("relay_request_aborted");
        client = new globals.HttpEngineClient({ relay });
        await client.init();
        if (controller.signal.aborted || disposed)
          throw new Error("relay_request_aborted");
        propagatePinnedRelayStreamFailures(client.session);
        await probe(relay, controller.signal);
        if (controller.signal.aborted) throw new Error("relay_request_aborted");
        send({ id: value.id, type: "ready" });
      } else if (value.type === "request") {
        if (!client?.ready) throw new Error("relay_not_ready");
        const r = value.request;
        const responseLimit = resourceResponseBudget(r.destination);
        const response = (rawResponse = await client.request(
          new URL(r.url),
          r.method,
          r.body ?? null,
          r.headers,
          controller.signal,
        ));
        if (controller.signal.aborted) throw new Error("relay_request_aborted");
        if (
          !Number.isInteger(response.status) ||
          response.status < 200 ||
          response.status > 599 ||
          typeof response.statusText !== "string" ||
          response.statusText.length > 256 ||
          !Array.isArray(response.headers) ||
          response.headers.length > 512 ||
          response.headers.some(
            (p: any) =>
              !Array.isArray(p) ||
              p.length !== 2 ||
              p.some((s: any) => typeof s !== "string" || s.length > 65536),
          )
        )
          throw new Error("invalid_relay_response");
        const headerBytes = response.headers.reduce(
          (sum: number, pair: [string, string]) =>
            sum + pair[0].length + pair[1].length,
          0,
        );
        if (headerBytes > 65536) {
          if (response.body instanceof ReadableStream)
            void response.body.cancel().catch(() => {});
          controller.abort();
          throw new Error("relay_response_header_limit");
        }
        let total = 0;
        let chunkCount = 0;
        const chunks: Uint8Array[] = [];
        if (response.body instanceof ReadableStream) {
          const reader = response.body.getReader();
          const abort = () => {
            void reader.cancel().catch(() => {});
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          try {
            while (true) {
              const { done, value: bytes } = await reader.read();
              if (controller.signal.aborted)
                throw new Error("relay_request_aborted");
              if (done) break;
              if (!(bytes instanceof Uint8Array))
                throw new Error("invalid_relay_response");
              if (++chunkCount > RELAY_RESPONSE_CHUNK_LIMIT) {
                void reader.cancel().catch(() => {});
                controller.abort();
                throw new Error("relay_response_chunk_limit");
              }
              total += bytes.byteLength;
              if (
                total > responseLimit ||
                bufferedResponseBytes + bytes.byteLength >
                  AGGREGATE_RELAY_RESPONSE_BYTES
              ) {
                void reader.cancel().catch(() => {});
                controller.abort();
                throw new Error("relay_response_limit");
              }
              bufferedResponseBytes += bytes.byteLength;
              retainedResponseBytes += bytes.byteLength;
              // The transport may reuse a view or return a small slice of a
              // much larger buffer. Retain only an exact-sized snapshot.
              if (bytes.byteLength) chunks.push(new Uint8Array(bytes));
            }
          } finally {
            controller.signal.removeEventListener("abort", abort);
            reader.releaseLock();
          }
        } else if (response.body != null) {
          if (
            !(response.body instanceof ArrayBuffer) ||
            response.body.byteLength > responseLimit ||
            bufferedResponseBytes + response.body.byteLength >
              AGGREGATE_RELAY_RESPONSE_BYTES
          )
            throw new Error("relay_response_limit");
          bufferedResponseBytes += response.body.byteLength;
          retainedResponseBytes += response.body.byteLength;
          chunks.push(new Uint8Array(response.body));
          total = response.body.byteLength;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (controller.signal.aborted) throw new Error("relay_request_aborted");
        send(
          {
            id: value.id,
            type: "response",
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              body: bytes.buffer,
            },
          },
          [bytes.buffer],
        );
      } else throw new Error("invalid_relay_operation");
    } catch (error: any) {
      // Do not forward transport error text/URLs containing bearer credentials.
      const code = /^relay_[a-z_]+$|^invalid_relay_[a-z_]+$/.test(
        error?.message,
      )
        ? error.message
        : controller.signal.aborted
          ? "relay_request_aborted"
          : "relay_transport_failed";
      controller.abort();
      if (rawResponse?.body instanceof ReadableStream)
        void rawResponse.body.cancel().catch(() => {});
      send({ id: value.id, type: "error", code });
    } finally {
      bufferedResponseBytes -= retainedResponseBytes;
      clearTimeout(timeout);
      controllers.delete(value.id);
      send({ id: value.id, type: "settled" });
    }
  });
  return { dispose };
}
if (
  typeof document === "undefined" &&
  typeof self !== "undefined" &&
  typeof (self as any).postMessage === "function" &&
  typeof (self as any).registration === "undefined"
)
  installSandboxRelayWorker(self);
