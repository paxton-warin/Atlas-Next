import {
  SANDBOX_RELAY_PROTOCOL as protocol,
  sandboxRelayURL,
  type SandboxRelayAssignment,
  type SandboxRelayRawResponse,
  SANDBOX_RELAY_SOCKET_LIMITS as socketLimits,
  validRelaySocketRequest,
} from "./sandbox-relay-protocol.ts";
import type {
  SandboxNetworkRequest,
  SandboxNetworkContext,
  SandboxNetworkResponse,
} from "./sandbox-network.ts";

import type {
  OpaqueSocketEvents,
  OpaqueTrustedSocket,
} from "./opaque-websocket.ts";
type Owner = Window & typeof globalThis;
type Pending = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  detach(): void;
};
const fail = (code: string) => Object.assign(new Error(code), { code });

/** Real assigned-node HTTP transport. Every worker has independent pinned
 * libcurl/Wisp state. Website bytes never use frontend HTTP; credentials never
 * leave trusted workers. No native-fetch fallback exists. Inactive until the
 * combined runtime's remaining compatibility/isolation gates are qualified. */
export async function createSandboxRelay(options: {
  assignment: SandboxRelayAssignment;
  workerURL: string | URL;
  window?: Owner;
  timeoutMs?: number;
}) {
  const owner = options.window ?? window;
  const asset = new URL(String(options.workerURL), owner.location.origin);
  if (
    asset.origin !== owner.location.origin ||
    !/^https?:$/.test(asset.protocol) ||
    asset.username ||
    asset.password ||
    asset.hash
  )
    throw new TypeError("Relay worker must be a trusted frontend asset.");
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError("Invalid relay timeout.");
  let live = true,
    epoch = 0;
  type SocketState = {
    id: number;
    events: OpaqueSocketEvents;
    signal: AbortSignal;
    detach(): void;
    timer: ReturnType<typeof setTimeout>;
    closed: boolean;
    onHandshake?: (headers: [string, string][]) => void | Promise<void>;
    incoming: number;
  };
  type Peer = {
    sockets: Map<number, SocketState>;
    connectWebSocket(
      url: string,
      protocols: string[],
      headers: [string, string][],
      events: OpaqueSocketEvents,
      signal: AbortSignal,
      onHandshake?: (headers: [string, string][]) => void | Promise<void>,
    ): OpaqueTrustedSocket;
    assignment: SandboxRelayAssignment;
    request(
      request: SandboxNetworkRequest,
      signal: AbortSignal,
    ): Promise<SandboxRelayRawResponse>;
    dispose(): void;
    retired: boolean;
    pending: Map<number, Pending>;
  };
  const peers = new Set<Peer>();
  const offeredGenerations = new Map<string, number>();
  const assignmentKey = (a: SandboxRelayAssignment) =>
    a.sessionHash + "|" + new URL(a.origin).origin;
  offeredGenerations.set(
    assignmentKey(options.assignment),
    options.assignment.generation,
  );
  const open = async (assignment: SandboxRelayAssignment) => {
    sandboxRelayURL(assignment, owner.location.protocol === "https:");
    const frozen = Object.freeze({
      origin: assignment.origin,
      ticket: assignment.ticket,
      generation: assignment.generation,
      sessionHash: assignment.sessionHash,
    });
    const worker = new owner.Worker(asset, {
      type: "module",
      name: "atlas-assigned-relay",
    });
    let alive = true,
      next = 0;
    const pending = new Map<number, Pending>();
    const cancellations = new Map<number, ReturnType<typeof setTimeout>>();
    const sockets = new Map<number, SocketState>();
    let socketQueuedBytes = 0;
    const socketCommand = (type: string, values: object) => {
      if (!alive || !live) return;
      worker.postMessage({ protocol, id: ++next, type, ...values });
    };
    const closeSocket = (
      state: SocketState,
      code = 1006,
      reason = "",
      wasClean = false,
    ) => {
      if (state.closed || !sockets.delete(state.id)) return;
      state.closed = true;
      clearTimeout(state.timer);
      state.detach();
      try {
        state.events.close(code, reason, wasClean);
      } catch {}
      if (peer.retired && !pending.size && !sockets.size) peer.dispose();
    };
    const failSocket = (state: SocketState) => {
      if (state.closed) return;
      try {
        state.events.error();
      } catch {}
      socketCommand("ws-close", { socket: state.id });
      closeSocket(state);
    };
    const peer: Peer = {
      sockets,
      connectWebSocket(url, protocols, headers, events, signal, onHandshake) {
        if (!alive || !live || signal.aborted)
          throw fail("relay_websocket_unavailable");
        if (
          sockets.size >= socketLimits.sockets ||
          !validRelaySocketRequest(url, protocols, headers)
        )
          throw fail("relay_websocket_request_denied");
        const id = ++next;
        const abort = () => {
          socketCommand("ws-close", { socket: id });
          closeSocket(state);
        };
        const state: SocketState = {
          id,
          events,
          signal,
          detach: () => signal.removeEventListener("abort", abort),
          closed: false,
          onHandshake,
          incoming: 0,
          timer: setTimeout(() => failSocket(state), timeoutMs + 500),
        };
        sockets.set(id, state);
        signal.addEventListener("abort", abort, { once: true });
        try {
          worker.postMessage({
            protocol,
            id,
            type: "ws-open",
            url,
            protocols: [...protocols],
            headers: headers.map((pair) => [...pair]),
            timeoutMs,
          });
        } catch {
          failSocket(state);
        }
        return {
          async send(data) {
            if (
              state.closed ||
              signal.aborted ||
              !(typeof data === "string" || data instanceof owner.ArrayBuffer)
            )
              throw fail("relay_websocket_closed");
            const bytes =
              typeof data === "string"
                ? data.length > socketLimits.messageBytes
                  ? socketLimits.messageBytes + 1
                  : new owner.TextEncoder().encode(data).length
                : data.byteLength;
            if (
              bytes > socketLimits.messageBytes ||
              socketQueuedBytes + bytes > socketLimits.queuedBytes
            )
              throw fail("relay_websocket_backpressure");
            socketQueuedBytes += bytes;
            try {
              await call(
                "ws-send",
                {
                  socket: id,
                  data: typeof data === "string" ? data : data.slice(0),
                },
                signal,
              );
            } finally {
              socketQueuedBytes -= bytes;
            }
          },
          close(code, reason) {
            if (state.closed) return;
            socketCommand("ws-close", { socket: id, code, reason });
            clearTimeout(state.timer);
            state.timer = setTimeout(() => {
              if (!state.closed) peer.dispose();
            }, 1000);
          },
        };
      },
      assignment: frozen,
      retired: false,
      pending,
      request: (request, signal) => call("request", { request }, signal),
      dispose() {
        if (!alive) return;
        alive = false;
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.detach();
          item.reject(fail("relay_disposed"));
        }
        pending.clear();
        for (const state of [...sockets.values()]) closeSocket(state);
        for (const timer of cancellations.values()) clearTimeout(timer);
        cancellations.clear();
        worker.terminate();
        peers.delete(peer);
      },
    };
    peers.add(peer);
    const finish = (id: number, error?: Error, response?: unknown) => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      item.detach();
      error ? item.reject(error) : item.resolve(response);
      if (peer.retired && !pending.size && !sockets.size) peer.dispose();
    };
    function call(type: string, value: object, signal?: AbortSignal) {
      if (!alive || !live) return Promise.reject(fail("relay_disposed"));
      if (signal?.aborted) return Promise.reject(fail("relay_request_aborted"));
      if (pending.size >= 16)
        return Promise.reject(fail("relay_request_limit"));
      const id = ++next;
      return new Promise<any>((resolve, reject) => {
        const abort = () => {
          cancellations.set(
            id,
            setTimeout(() => peer.dispose(), 1000),
          );
          worker.postMessage({
            protocol,
            id: ++next,
            type: "cancel",
            target: id,
          });
          finish(id, fail("relay_request_aborted"));
        };
        const timer = setTimeout(() => {
          finish(id, fail("relay_timeout"));
          // A broken worker cannot leave unbounded orphan requests behind.
          peer.dispose();
        }, timeoutMs + 500);
        pending.set(id, {
          resolve,
          reject,
          timer,
          detach: () => signal?.removeEventListener("abort", abort),
        });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          worker.postMessage({ protocol, id, type, timeoutMs, ...value });
        } catch {
          finish(id, fail("relay_message_failed"));
        }
      });
    }
    worker.onmessage = ({ data }) => {
      if (!alive || data?.protocol !== protocol) return;
      if (
        typeof data.type === "string" &&
        [
          "ws-open",
          "ws-message",
          "ws-close",
          "ws-error",
          "ws-headers",
        ].includes(data.type)
      ) {
        const state = sockets.get(data.id);
        if (!state || state.closed) return;
        try {
          if (data.type === "ws-open") {
            if (
              typeof data.selectedProtocol !== "string" ||
              data.selectedProtocol.length > 256 ||
              typeof data.extensions !== "string" ||
              data.extensions.length > 4096
            )
              throw Error();
            clearTimeout(state.timer);
            state.events.open(data.selectedProtocol, data.extensions);
          } else if (data.type === "ws-message") {
            if (
              !Number.isSafeInteger(data.message) ||
              data.message !== state.incoming + 1 ||
              !(
                typeof data.data === "string" ||
                data.data instanceof owner.ArrayBuffer
              )
            )
              throw Error();
            const bytes =
              typeof data.data === "string"
                ? data.data.length > socketLimits.messageBytes
                  ? socketLimits.messageBytes + 1
                  : new owner.TextEncoder().encode(data.data).length
                : data.data.byteLength;
            if (bytes > socketLimits.messageBytes) throw Error();
            state.incoming = data.message;
            state.events.message(data.data);
            socketCommand("ws-received", {
              socket: state.id,
              message: data.message,
            });
          } else if (data.type === "ws-close") {
            if (
              !Number.isInteger(data.code) ||
              data.code < 1000 ||
              data.code > 4999 ||
              typeof data.reason !== "string" ||
              data.reason.length > 123 ||
              new owner.TextEncoder().encode(data.reason).length > 123 ||
              typeof data.wasClean !== "boolean"
            )
              throw Error();
            closeSocket(state, data.code, data.reason, data.wasClean);
          } else if (data.type === "ws-error") failSocket(state);
          else {
            if (
              !Array.isArray(data.headers) ||
              data.headers.length > 512 ||
              data.headers.some(
                (p: any) =>
                  !Array.isArray(p) ||
                  p.length !== 2 ||
                  p.some((v: any) => typeof v !== "string" || v.length > 65536),
              ) ||
              data.headers.reduce(
                (n: number, p: [string, string]) =>
                  n + p[0].length + p[1].length,
                0,
              ) > 65536
            )
              throw Error();
            void Promise.resolve()
              .then(() => state.onHandshake?.(data.headers))
              .then(() => {
                if (
                  alive &&
                  live &&
                  !state.closed &&
                  !state.signal.aborted &&
                  sockets.get(state.id) === state
                )
                  socketCommand("ws-headers-committed", { socket: state.id });
              })
              .catch(() => failSocket(state));
          }
        } catch {
          failSocket(state);
        }
        return;
      }
      if (data.type === "settled") {
        clearTimeout(cancellations.get(data.id));
        cancellations.delete(data.id);
        return;
      }
      if (!pending.has(data.id)) return;
      if (data.type === "error")
        finish(
          data.id,
          fail(/^[a-z_]{1,80}$/.test(data.code) ? data.code : "relay_failed"),
        );
      else if (data.type === "ready" || data.type === "ws-sent")
        finish(data.id);
      else if (data.type === "response")
        finish(data.id, undefined, data.response);
      else finish(data.id, fail("invalid_relay_message"));
    };
    worker.onerror = () => peer.dispose();
    worker.onmessageerror = () => peer.dispose();
    try {
      await call("initialize", { assignment: frozen });
      return peer;
    } catch (error) {
      peer.dispose();
      throw error;
    }
  };
  let current: Peer;
  try {
    current = await open(options.assignment);
  } catch (error) {
    for (const peer of [...peers]) peer.dispose();
    live = false;
    throw error;
  }
  return {
    async request(request: SandboxNetworkRequest, signal: AbortSignal) {
      if (!live) throw fail("relay_disposed");
      return current.request(request, signal);
    },
    connectWebSocket(
      url: string,
      protocols: string[],
      headers: [string, string][],
      events: OpaqueSocketEvents,
      signal: AbortSignal,
      onHandshake?: (headers: [string, string][]) => void | Promise<void>,
    ) {
      if (!live) throw fail("relay_disposed");
      return current.connectWebSocket(
        url,
        protocols,
        headers,
        events,
        signal,
        onHandshake,
      );
    },
    /** A failed replacement leaves prior requests and assignment in place.
     * Explicit node changes only; credential renewals cannot silently move it. */
    async replace(
      assignment: SandboxRelayAssignment,
      { allowNodeChange = false } = {},
    ) {
      if (!live) throw fail("relay_disposed");
      sandboxRelayURL(assignment, owner.location.protocol === "https:");
      const identityChanged =
        new URL(assignment.origin).origin !==
          new URL(current.assignment.origin).origin ||
        assignment.sessionHash !== current.assignment.sessionHash;
      const key = assignmentKey(assignment),
        highest = offeredGenerations.get(key) || 0;
      if (
        (!allowNodeChange && identityChanged) ||
        assignment.generation < highest
      )
        throw fail("relay_assignment_conflict");
      if (
        peers.size >= 4 ||
        (!offeredGenerations.has(key) && offeredGenerations.size >= 256)
      )
        throw fail("relay_replacement_limit");
      // Compare against pending candidates too, not only the currently active
      // worker. A late generation2 cannot supersede already-offered generation3.
      offeredGenerations.set(key, assignment.generation);
      const operation = ++epoch;
      const replacement = await open(assignment);
      if (!live || operation !== epoch) {
        replacement.dispose();
        throw fail("relay_replacement_stale");
      }
      const previous = current;
      current = replacement;
      previous.retired = true;
      if (!previous.pending.size && !previous.sockets.size) previous.dispose();
    },
    get assignment() {
      return current.assignment;
    },
    get pending() {
      return [...peers].reduce((sum, peer) => sum + peer.pending.size, 0);
    },
    get webSockets() {
      return [...peers].reduce((sum, peer) => sum + peer.sockets.size, 0);
    },
    dispose() {
      if (!live) return;
      live = false;
      ++epoch;
      for (const peer of [...peers]) peer.dispose();
    },
  };
}

type CookieContext = {
  requestURL: string;
  documentURL: string;
  topLevelURL: string;
  method: string;
  credentials: "omit" | "same-origin" | "include";
  signal?: AbortSignal;
  preflight?: boolean;
  topLevelNavigation?: boolean;
  siteForCookiesURL?: string | null;
};
type TrustedCookies = {
  getRequestHeader(context: CookieContext): Promise<string>;
  storeResponseCookies(
    lines: string[],
    context: CookieContext,
  ): Promise<unknown>;
};
/** This closure is constructed ONLY by the trusted document controller. The
 * caller's claimed URL/origin cannot replace its logical website identity. */
export function createSandboxRelayFetch(options: {
  documentId: string;
  documentURL: string;
  topLevelURL: string;
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  relay: Pick<
    Awaited<ReturnType<typeof createSandboxRelay>>,
    "request" | "assignment"
  >;
  cookies: TrustedCookies;
}) {
  const logical = new URL(options.documentURL),
    top = new URL(options.topLevelURL);
  const forbidden = new Set(
    [options.frontendOrigin, ...(options.forbiddenOrigins || [])].map(
      (s) => new URL(s).hostname,
    ),
  );
  if (
    !/^https?:$/.test(logical.protocol) ||
    !/^https?:$/.test(top.protocol) ||
    forbidden.has(logical.hostname)
  )
    throw new TypeError("Invalid bound website.");
  return async (
    request: SandboxNetworkRequest,
    context: SandboxNetworkContext,
  ): Promise<SandboxNetworkResponse> => {
    if (
      context.documentId !== options.documentId ||
      context.documentURL !== logical.href ||
      context.origin !== logical.origin
    )
      throw fail("relay_document_mismatch");
    const url = new URL(request.url);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      forbidden.has(url.hostname) ||
      url.hostname === new URL(options.relay.assignment.origin).hostname ||
      (logical.protocol === "https:" && url.protocol !== "https:")
    )
      throw fail("destination_denied");
    const headers: [string, string][] = [];
    for (const [name, value] of request.headers) {
      if (
        /^(cookie2?|origin|referer|host|proxy-.*|sec-.*|connection|upgrade|transfer-encoding|content-length)$/i.test(
          name,
        )
      )
        throw fail("forbidden_request_header");
      headers.push([name, value]);
    }
    if (
      context.preflight ||
      (context.responseTaint
        ? context.responseTaint === "cors"
        : request.mode === "cors") ||
      !["GET", "HEAD"].includes(request.method)
    )
      headers.push(["origin", context.requestOrigin ?? logical.origin]);
    // Default strict-origin-when-cross-origin; no frontend location/ticket leaks.
    if (context.referrerURL !== null) {
      const referrer = new URL(context.referrerURL ?? logical.href);
      if (
        !/^https?:$/.test(referrer.protocol) ||
        referrer.username ||
        referrer.password ||
        forbidden.has(referrer.hostname) ||
        referrer.hostname === new URL(options.relay.assignment.origin).hostname
      )
        throw fail("invalid_trusted_referrer");
      referrer.hash = "";
      if (!(referrer.protocol === "https:" && url.protocol === "http:"))
        headers.push([
          "referer",
          url.origin === referrer.origin
            ? referrer.href
            : referrer.origin + "/",
        ]);
    }
    const cookieContext: CookieContext = {
      requestURL: url.href,
      documentURL: logical.href,
      topLevelURL: top.href,
      method: request.method,
      credentials: context.preflight ? "omit" : request.credentials,
      signal: context.signal,
      preflight: context.preflight,
      topLevelNavigation: context.topLevelNavigation === true,
      ...(context.topLevelNavigation && context.navigationSourceURL ? { siteForCookiesURL: context.navigationSourceURL } : {}),
    };
    const cookie = await options.cookies.getRequestHeader(cookieContext);
    if (context.signal.aborted) throw fail("relay_request_aborted");
    if (cookie && !context.preflight) headers.push(["cookie", cookie]);
    const response = await options.relay.request(
      { ...request, url: url.href, headers },
      context.signal,
    );
    if (context.signal.aborted) throw fail("relay_request_aborted");
    const setCookies = response.headers
      .filter(([name]) => name.toLowerCase() === "set-cookie")
      .map(([, value]) => value);
    // Raw Set-Cookie headers never cross the opaque document boundary. Native
    // browser persistence completes BEFORE the trusted fetch resolves.
    if (
      !context.preflight &&
      cookieContext.credentials !== "omit" &&
      setCookies.length
    )
      await options.cookies.storeResponseCookies(setCookies, cookieContext);
    if (context.signal.aborted) throw fail("relay_request_aborted");
    return {
      ...response,
      url: url.href,
      headers: response.headers.filter(
        ([name]) => !/^set-cookie2?$/i.test(name),
      ),
    };
  };
}

/** Fixed-document website WebSocket authority. Never expose this closure, its
 * cookie jar, or raw relay owner to an untrusted document. */
export function createSandboxRelayWebSocketConnect(options: {
  documentId: string;
  documentURL: string;
  topLevelURL: string;
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  relay: Pick<
    Awaited<ReturnType<typeof createSandboxRelay>>,
    "connectWebSocket" | "assignment"
  >;
  cookies: TrustedCookies;
}) {
  const document = new URL(options.documentURL),
    top = new URL(options.topLevelURL);
  const forbidden = new Set(
    [options.frontendOrigin, ...(options.forbiddenOrigins || [])].map(
      (s) => new URL(s).hostname,
    ),
  );
  if (
    !/^https?:$/.test(document.protocol) ||
    !/^https?:$/.test(top.protocol) ||
    document.username ||
    document.password ||
    forbidden.has(document.hostname)
  )
    throw TypeError("Invalid fixed WebSocket website");
  return async (
    url: string,
    protocols: string[],
    context: import("./opaque-websocket.ts").OpaqueSocketContext,
    events: OpaqueSocketEvents,
  ) => {
    const target = new URL(url);
    if (
      context.documentId !== options.documentId ||
      context.documentURL !== document.href ||
      context.origin !== document.origin ||
      context.signal.aborted ||
      !/^wss?:$/.test(target.protocol) ||
      target.username ||
      target.password ||
      target.href.includes("#") ||
      forbidden.has(target.hostname) ||
      target.hostname === new URL(options.relay.assignment.origin).hostname ||
      (document.protocol === "https:" && target.protocol !== "wss:")
    )
      throw fail("relay_websocket_destination_denied");
    const request = new URL(target);
    request.protocol = target.protocol === "wss:" ? "https:" : "http:";
    const cookieContext: CookieContext = {
      requestURL: request.href,
      documentURL: document.href,
      topLevelURL: top.href,
      method: "GET",
      credentials: "include",
      signal: context.signal,
    };
    const cookie = await options.cookies.getRequestHeader(cookieContext);
    if (context.signal.aborted) throw fail("relay_request_aborted");
    return options.relay.connectWebSocket(
      target.href,
      protocols,
      [
        ["Origin", document.origin],
        ...(cookie ? [["Cookie", cookie] as [string, string]] : []),
      ],
      events,
      context.signal,
      async (headers) => {
        const values = headers
          .filter(([name]) => name.toLowerCase() === "set-cookie")
          .map(([, value]) => value);
        if (values.length)
          await options.cookies.storeResponseCookies(values, cookieContext);
        if (context.signal.aborted) throw fail("relay_request_aborted");
      },
    );
  };
}
