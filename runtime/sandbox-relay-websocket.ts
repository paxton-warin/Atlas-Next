/** Narrow trusted adapter for the shipped HttpEngineClient0.7.4. It recovers
 * actual handshake headers through its existing CurlSession callback, without
 * editing or exporting the pinned vendor bundle or using native website WS.
 * The optional exact-pin copied-engine hook preserves server close metadata.
 * Its copied Wasm export-only seam reports actual close send status/bytecount;
 * original assets retain truthful unclean1006 fallback, never guessed metadata. */
import type {
  OpaqueSocketEvents,
  OpaqueTrustedSocket,
} from "./opaque-websocket.ts";
export function createPinnedRelayWebSocket(options: {
  client: any;
  url: string;
  protocols: string[];
  headers: [string, string][];
  signal: AbortSignal;
  events: OpaqueSocketEvents;
  onHandshake?: (headers: [string, string][]) => void | Promise<void>;
  maxMessageBytes?: number;
  maxQueuedBytes?: number;
}): OpaqueTrustedSocket {
  const { client, url, protocols, headers, signal, events } = options;
  const maxMessage = options.maxMessageBytes ?? 1024 * 1024,
    maxQueued = options.maxQueuedBytes ?? 4 * 1024 * 1024;
  if (
    !client?.ready ||
    typeof client.connect !== "function" ||
    !client.session ||
    signal.aborted ||
    ![maxMessage, maxQueued].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw Error("relay_websocket_not_ready");
  let prototype = Object.getPrototypeOf(client.session);
  while (
    prototype &&
    !Object.prototype.hasOwnProperty.call(prototype, "create_request")
  )
    prototype = Object.getPrototypeOf(prototype);
  const stringifyDescriptor = Object.getOwnPropertyDescriptor(
      JSON,
      "stringify",
    )!,
    nativeStringify = JSON.stringify;
  let optionsAdapted = 0;
  const descriptor =
      prototype && Object.getOwnPropertyDescriptor(prototype, "create_request"),
    original = descriptor?.value;
  if (typeof original !== "function" || !descriptor.configurable)
    throw Error("relay_websocket_version_unsupported");
  let curl: any,
    controls:
      | [
          (data: string | ArrayBuffer) => void,
          (code?: number, reason?: string) => void,
        ]
      | undefined;
  let live = true,
    opened = false,
    ended = false,
    nativeCleanup = false,
    closing = false,
    closeSent = false,
    closeReceived = false,
    transportFailed = false,
    status = 0,
    raw = "",
    headerBytes = 0,
    handshake: [string, string][] = [],
    queuedBytes = 0;
  let closeCode = 1006,
    closeReason = "";
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const queued: (string | ArrayBuffer)[] = [];
  const close = () => {
    if (ended) return;
    ended = true;
    live = false;
    clearTimeout(closeTimer);
    signal.removeEventListener("abort", abort);
    queued.length = 0;
    queuedBytes = 0;
    const connected = !!curl?.connected;
    if (!nativeCleanup) {
      try {
        controls?.[1]();
      } catch {}
    }
    // CurlWebSocket.cleanup() ignores a CONNECTING socket. Close its actual
    // native session even on timeout/revocation before the handshake completes.
    if (!nativeCleanup && !connected && curl?.session_ptr) {
      try {
        prototype.close.call(curl);
      } catch {}
    }
    events.close(
      closeReceived ? closeCode : 1006,
      closeReceived ? closeReason : "",
      closeSent && closeReceived && !transportFailed,
    );
  };
  const failed = () => {
    if (!live) return;
    transportFailed = true;
    events.error();
    close();
  };
  const abort = () => close();
  const onHeaders = (bytes: unknown) => {
    if (!live) return;
    if (!(bytes instanceof Uint8Array) || bytes.length + headerBytes > 65536) {
      failed();
      return;
    }
    headerBytes += bytes.length;
    for (const byte of bytes) {
      if (byte > 127 || byte === 0) {
        failed();
        return;
      }
      raw += String.fromCharCode(byte);
    }
    let at;
    while ((at = raw.indexOf("\r\n")) >= 0) {
      const line = raw.slice(0, at);
      raw = raw.slice(at + 2);
      const start = line.match(/^HTTP\/\S+ (\d{3})(?: |$)/);
      if (start) {
        status = Number(start[1]);
        handshake = [];
      } else if (line) {
        const field = line.match(
          /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*)$/,
        );
        if (!field || handshake.length >= 512) {
          failed();
          return;
        }
        handshake.push([field[1].toLowerCase(), field[2].trim()]);
      }
    }
  };
  const onOpen = () => {
    if (!live) return;
    const selected = handshake.filter(
        ([name]) => name === "sec-websocket-protocol",
      ),
      extensions = handshake.filter(
        ([name]) => name === "sec-websocket-extensions",
      );
    if (
      status !== 101 ||
      selected.length > 1 ||
      extensions.length > 1 ||
      (selected.length
        ? !protocols.includes(selected[0][1])
        : protocols.length > 0) ||
      extensions.some(([, value]) => value !== "")
    ) {
      failed();
      return;
    }
    void Promise.resolve()
      .then(() =>
        options.onHandshake?.(
          handshake.map((pair) => [...pair] as [string, string]),
        ),
      )
      .then(() => {
        if (!live) return;
        opened = true;
        events.open(selected[0]?.[1] ?? "", extensions[0]?.[1] ?? "");
        for (const data of queued.splice(0)) {
          queuedBytes -=
            typeof data === "string"
              ? new TextEncoder().encode(data).length
              : data.byteLength;
          if (live) events.message(data);
        }
      })
      .catch(failed);
  };
  const onMessage = (data: unknown) => {
    if (!live || closing) return;
    let value: string | ArrayBuffer;
    if (typeof data === "string") {
      if (data.length > maxMessage) return failed();
      value = data;
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > maxMessage) return failed();
      value = data.slice(0);
    } else if (ArrayBuffer.isView(data)) {
      if (data.byteLength > maxMessage) return failed();
      value = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).slice().buffer;
    } else return failed();
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).length
        : value.byteLength;
    if (
      bytes > maxMessage ||
      queuedBytes + bytes > maxQueued ||
      (!opened && queued.length >= 64)
    )
      return failed();
    if (opened) events.message(value);
    else {
      queuedBytes += bytes;
      queued.push(value);
    }
  };
  Object.defineProperty(prototype, "create_request", {
    ...descriptor,
    value: function (
      this: any,
      address: string,
      data: any,
      end: any,
      receiveHeaders: any,
    ) {
      if (
        address !== url ||
        this.url !== url ||
        !Array.isArray(this.recv_buffer)
      )
        return original.call(this, address, data, end, receiveHeaders);
      if (curl) throw Error("relay_websocket_reentrant_connect");
      curl = this;
      if (typeof curl.__atlasSendClose === "function") {
        curl.__atlasOnCloseFrame = (bytes: unknown) => {
          if (!live) return;
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.length === 1 ||
            bytes.length > 125
          ) {
            transportFailed = true;
            events.error();
            return;
          }
          if (!bytes.length) closeCode = 1005;
          else {
            const code = new DataView(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength,
            ).getUint16(0);
            if (
              !(
                (code >= 1000 &&
                  code <= 1014 &&
                  ![1004, 1005, 1006].includes(code)) ||
                (code >= 3000 && code <= 4999)
              )
            ) {
              transportFailed = true;
              events.error();
              return;
            }
            try {
              closeReason = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(2),
              );
            } catch {
              transportFailed = true;
              events.error();
              return;
            }
            closeCode = code;
          }
          closeReceived = true;
          if (!closeSent) {
            try {
              const result = curl.__atlasSendClose(bytes);
              closeSent = result?.code === 0 && result.sent === bytes.length;
            } catch {}
          }
        };
      }
      return original.call(
        this,
        address,
        data,
        (code: number) => {
          // A late completion cannot recreate recv_loop after revocation.
          if (!live) return;
          if (code > 0) {
            failed();
            return;
          }
          end(code);
        },
        (bytes: Uint8Array) => {
          onHeaders(bytes);
          receiveHeaders(bytes);
        },
      );
    },
  });
  Object.defineProperty(JSON, "stringify", {
    ...stringifyDescriptor,
    value: function (value: any, replacer: any, space: any) {
      if (
        curl &&
        value &&
        typeof value === "object" &&
        value.headers === curl.options?.headers
      ) {
        optionsAdapted++;
        return nativeStringify.call(
          JSON,
          { ...value, redirect: "manual" },
          replacer,
          space,
        );
      }
      return nativeStringify.call(JSON, value, replacer, space);
    },
  });
  try {
    controls = client.connect(
      new URL(url),
      protocols,
      headers,
      onOpen,
      onMessage,
      () => {
        nativeCleanup = true;
        close();
      },
      () => {
        nativeCleanup = true;
        failed();
      },
    );
  } catch (failure) {
    close();
    throw failure;
  } finally {
    Object.defineProperty(JSON, "stringify", stringifyDescriptor);
    Object.defineProperty(prototype, "create_request", descriptor);
  }
  if (
    !curl ||
    optionsAdapted !== 1 ||
    !Array.isArray(controls) ||
    controls.length !== 2 ||
    controls.some((fn) => typeof fn !== "function")
  ) {
    close();
    throw Error("relay_websocket_version_unsupported");
  }
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) close();
  return {
    send(data) {
      if (!live || !opened || closing) throw Error("relay_websocket_not_open");
      const bytes =
        typeof data === "string"
          ? data.length > maxMessage
            ? maxMessage + 1
            : new TextEncoder().encode(data).length
          : data.byteLength;
      if (bytes > maxMessage) throw Error("relay_websocket_message_limit");
      controls![0](data);
      // This means accepted by the pinned JS transport, NOT a wire-level ACK.
    },
    close(code, reason = "") {
      if (!live || closing) return;
      if (!opened || typeof curl?.__atlasSendClose !== "function")
        return close();
      const text = new TextEncoder().encode(reason);
      if (
        (code !== undefined &&
          !(
            code === 1000 ||
            (Number.isInteger(code) && code >= 3000 && code <= 4999)
          )) ||
        text.length > 123 ||
        (code === undefined && text.length)
      )
        throw TypeError("Invalid WebSocket close");
      const bytes = new Uint8Array(code === undefined ? 0 : text.length + 2);
      if (code !== undefined) {
        new DataView(bytes.buffer).setUint16(0, code);
        bytes.set(text, 2);
      }
      closing = true;
      try {
        const result = curl.__atlasSendClose(bytes);
        closeSent = result?.code === 0 && result.sent === bytes.length;
      } catch {}
      if (!closeSent) return failed();
      closeTimer = setTimeout(close, 750);
    },
  };
}
