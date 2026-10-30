import { createLocalCookieOwnerV2 } from "./sandbox-local-owners-v2.ts";
import type { LocalActorAuthority } from "./local-authority.ts";
import { createCookieViewClock } from "./cookie-view-cache.ts";
/** Trusted frontend coordinator for durable website cookies. Owner credentials
 * never cross a document port. The server sees encrypted filtered-view results,
 * not cookie plaintext or the private result keys; network authority stays here.
 */
import { registrationFailure } from "./registration-error.ts";
export async function createSandboxCookieOwner(options: {
  workerURL: string | URL;
  localAuthority?: LocalActorAuthority;
  nativeV2?: boolean;
  profileId?: string | null;
  cacheViews?: boolean;
  profileContextId?: string;
  browserSessionId: string;
  forbiddenOrigins?: string[];
  /** Existing validated browsing-session credentials, supplied by trusted code
   * only. The server must authenticate this registration against the live lease. */
  registrationHeaders: () => HeadersInit | Promise<HeadersInit>;
  window?: Window & typeof globalThis;
  timeoutMs?: number;
}) {
  if (options.localAuthority) return createLocalCookieOwnerV2({...options,localAuthority:options.localAuthority});
  const owner = options.window ?? window;
  const viewClock = options.cacheViews ? createCookieViewClock(owner, options.profileId) : undefined;
  const frontend = owner.location.origin;
  const asset = new URL(String(options.workerURL), frontend);
  if (
    asset.origin !== frontend ||
    !/^https?:$/.test(asset.protocol) ||
    asset.username ||
    asset.password
  )
    throw new TypeError("Cookie worker must be a trusted frontend asset.");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError("Invalid cookies owner timeout.");
  const registration = await owner.fetch("/api/browse/cookies/owners", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...Object.fromEntries(new Headers(await options.registrationHeaders())),
      "content-type": "application/json",
      ...(viewClock ? { "x-atlas-cookie-view": "1" } : {}),
    },
    body: "{}",
    signal: owner.AbortSignal.timeout(timeoutMs),
  });
  if (!registration.ok) throw await registrationFailure(registration, "cookies_owner_registration_failed");
  viewClock?.authorize?.(registration.headers.get("x-atlas-cookie-view-epoch"));
  const grant = await registration.json();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(grant.capability) ||
    grant.websocket !== "/browse/cookies/owner/" + grant.capability
  )
    throw new Error("invalid_cookies_owner_grant");
  const headers = {
    authorization: "Bearer " + grant.capability,
    "content-type": "application/json",
  };
  let worker: Worker;
  try {
    worker = new owner.Worker(asset, {
      type: "module",
      name: "atlas-website-cookies",
    });
  } catch (error) {
    void owner
      .fetch("/api/browse/cookies/owners", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { authorization: headers.authorization },
      })
      .catch(() => {});
    throw error;
  }
  const networkPending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      detach: () => void;
      sent: boolean;
      bytes: number;
      send: () => void;
      deadline: number;
      expire: () => void;
    }
  >();
  // Website startup legitimately fans out into many resource requests. Bound
  // the in-flight worker load, not normal bursts at the first 32 operations.
  // Queued operations retain FIFO order, cancellation and their original
  // deadline. No write is retried or acknowledged before its worker result.
  const networkQueue: string[] = [];
  let networkActive = 0, networkBytes = 0, pumpingNetwork = false;
  function takeNetwork(id: string) {
    const item = networkPending.get(id);
    if (!item) return;
    networkPending.delete(id);
    networkBytes -= item.bytes;
    if (item.sent) networkActive--;
    else {
      const queued = networkQueue.indexOf(id);
      if (queued !== -1) networkQueue.splice(queued, 1);
    }
    clearTimeout(item.timer);
    item.detach();
    return item;
  }
  function pumpNetwork() {
    if (!live || pumpingNetwork) return;
    pumpingNetwork = true;
    try {
      while (networkActive < 16 && networkQueue.length) {
        const id = networkQueue.shift()!;
        const item = networkPending.get(id);
        if (!item) continue;
        if (Date.now() >= item.deadline) { item.expire(); continue; }
        item.sent = true;
        networkActive++;
        item.send();
      }
    } finally { pumpingNetwork = false; }
  }
  let live = true,
    readyResolve!: () => void,
    readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const bindings = new Map<
    string,
    { port: MessagePort; dispose: () => void }
  >();
  const cleanupDocument = (documentId: string) => {
    worker.postMessage({ type: "unbind-document", documentId });
    void owner
      .fetch("/api/browse/cookies/documents/" + documentId, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { authorization: headers.authorization },
      })
      .catch(() => {});
  };
  function dispose() {
    if (!live) return;
    live = false;
    // A server revocation/worker failure must retire even a warm local view.
    // Other owners keep their durable data; their next read revalidates it.
    try { viewClock?.invalidate(); } catch { /* The facade's next protocol read still fails explicitly. */ }
    clearTimeout(startTimer);
    readyReject(new Error("cookies_owner_disposed"));
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("cookies_owner_disposed"));
    }
    pending.clear();
    for (const value of networkPending.values()) {
      clearTimeout(value.timer);
      value.detach();
      value.reject(new Error("cookies_owner_disposed"));
    }
    networkPending.clear();
    networkQueue.length = 0;
    networkActive = networkBytes = 0;
    for (const value of bindings.values()) value.port.close();
    bindings.clear();
    worker.terminate();
    void owner
      .fetch("/api/browse/cookies/owners", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { authorization: headers.authorization },
      })
      .catch(() => {});
  }
  worker.onmessage = ({ data }) => {
    if (!live || !data) return;
    if (
      data.type === "profile-native-change" &&
      options.profileId &&
      data.profileId === options.profileId
    ) {
      owner.dispatchEvent(
        new owner.CustomEvent("atlas:profile-native-change", {
          detail: {
            profileId: options.profileId,
            origin: data.origin,
            kind: "cookies",
          },
        }),
      );
      return;
    }
    if (data.type === "network-result") {
      const item = takeNetwork(data.id);
      if (!item) return;
      if (data.error)
        item.reject(
          new DOMException("Cookie network operation failed", data.error),
        );
      else item.resolve(data.result);
      pumpNetwork();
    } else if (data.type === "unavailable") {
      dispose();
    } else if (data.type === "ready") {
      clearTimeout(startTimer);
      readyResolve();
    } else if (data.type === "document-bound" || data.type === "error") {
      const binding = pending.get(data.documentId);
      if (binding) {
        clearTimeout(binding.timer);
        pending.delete(data.documentId);
        if (data.type === "document-bound") binding.resolve();
        else binding.reject(new Error("cookies_document_binding_failed"));
      } else if (data.type === "error" && !data.documentId) {
        readyReject(new Error("cookies_worker_failed"));
        dispose();
      }
    }
  };
  worker.onerror = () => {
    readyReject(new Error("cookies_worker_failed"));
    dispose();
  };
  const startTimer = setTimeout(() => {
    readyReject(new Error("cookies_worker_timeout"));
    dispose();
  }, timeoutMs);
  const socket = new URL(grant.websocket, frontend);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  worker.postMessage({
    type: "initialize",
    socketURL: socket.href,
    browserSessionId: options.browserSessionId,
    profileId: options.profileId,
    profileContextId: options.profileContextId,
    forbiddenOrigins: options.forbiddenOrigins,
  });
  await ready;
  function network(
    type: string,
    context: import("./sandbox-cookies.ts").CookieRequestContext,
    lines?: string[],
  ) {
    if (!live) return Promise.reject(new Error("cookies_owner_disposed"));
    const { signal: _signal, ...fixed } = context;
    const capturedLines = lines?.slice();
    const bytes = 1024 + Object.entries(fixed).reduce((sum, [key, value]) =>
      sum + 2 * (key.length + (typeof value === "string" ? value.length : 16)), 0)
      + (capturedLines?.reduce((sum, line) => sum + 2 * line.length, 0) ?? 0);
    if (networkPending.size >= 512 || networkBytes + bytes > 2 * 1024 * 1024)
      return Promise.reject(
        new DOMException("Cookie request queue allowance exceeded", "QuotaExceededError"),
      );
    if (context.signal?.aborted) return Promise.reject(context.signal.reason);
    const id = owner.crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const detach = () =>
        context.signal?.removeEventListener("abort", cancelled);
      const cancel = (reason: unknown) => {
        const item = takeNetwork(id);
        if (!item) return;
        if (item.sent) {
          try { worker.postMessage({ type: "cancel-network", id }); }
          catch { /* Cancellation still rejects; no uncertain write is replayed. */ }
        }
        reject(reason);
        pumpNetwork();
      };
      const cancelled = () =>
        cancel(
          context.signal?.reason ??
            new DOMException("Cookie request aborted", "AbortError"),
        );
      const expire = () => cancel(
            new DOMException(
              "Cookie network operation timed out; commit may be durable",
              "TimeoutError",
            ),
      );
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(expire, timeoutMs);
      networkPending.set(id, { resolve, reject, timer, detach, sent: false, bytes,
        deadline, expire,
        send: () => {
          try {
            worker.postMessage({ type, id, context: fixed,
              ...(capturedLines ? { lines: capturedLines } : {}) });
          } catch (error) { cancel(error); }
        },
      });
      networkBytes += bytes;
      context.signal?.addEventListener("abort", cancelled, { once: true });
      networkQueue.push(id);
      pumpNetwork();
    });
  }

  return {
    get live() { return live; },
    getRequestHeader: (
      context: import("./sandbox-cookies.ts").CookieRequestContext,
    ) => network("request-header", context) as Promise<string>,
    storeResponseCookies: (
      lines: string[],
      context: import("./sandbox-cookies.ts").CookieRequestContext,
    ) => {
      viewClock?.invalidate();
      return network("response-cookies", context, lines).finally(() => viewClock?.invalidate());
    },
    async bind({
      documentId,
      website,
      topLevelURL = website,
      siteForCookiesURL = topLevelURL,
    }: {
      documentId: string;
      website: string;
      topLevelURL?: string;
      siteForCookiesURL?: string | null;
    }) {
      if (!live) throw new Error("cookies_owner_disposed");
      if (
        !/^[A-Za-z0-9_-]{16,96}$/.test(documentId) ||
        bindings.has(documentId) ||
        pending.has(documentId)
      )
        throw new TypeError("Invalid document cookies binding");
      const site = new URL(website);
      if (
        !/^https?:$/.test(site.protocol) ||
        site.username ||
        site.password ||
        site.hostname === new URL(frontend).hostname
      )
        throw new TypeError("Invalid website cookies origin");
      const response = await owner.fetch("/api/browse/cookies/documents", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ documentId }),
        signal: owner.AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw await registrationFailure(response, "cookies_document_registration_failed");
      const document = await response.json();
      if (
        document.documentId !== documentId ||
        !/^\/browse\/cookies\/result\/[A-Za-z0-9_-]{43}$/.test(document.result)
      )
        throw new Error("invalid_cookies_document_grant");
      if (!live) {
        cleanupDocument(documentId);
        throw new Error("cookies_owner_disposed");
      }
      const channel = new MessageChannel();
      try {
        const bound = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(documentId);
            reject(new Error("cookies_document_binding_timeout"));
          }, timeoutMs);
          pending.set(documentId, { resolve, reject, timer });
        });
        worker.postMessage(
          {
            type: "bind-document",
            context: {
              documentId,
              documentURL: site.href,
              topLevelURL,
              siteForCookiesURL,
            },
          },
          [channel.port1],
        );
        await bound;
        const binding = {
          port: channel.port2,
          endpoint: new URL(document.result, frontend).href,
          dispose() {
            if (!bindings.delete(documentId)) return;
            channel.port2.close();
            if (live) cleanupDocument(documentId);
          },
        };
        bindings.set(documentId, binding);
        return binding;
      } catch (error) {
        channel.port2.close();
        cleanupDocument(documentId);
        throw error;
      }
    },
    dispose,
  };
}
