/** Trusted frontend coordinator for durable website cookies. Owner credentials
 * never cross a document port. The server sees encrypted filtered-view results,
 * not cookie plaintext or the private result keys; network authority stays here.
 */
export async function createSandboxCookieOwner(options: {
  workerURL: string | URL;
  browserSessionId: string;
  forbiddenOrigins?: string[];
  /** Existing validated browsing-session credentials, supplied by trusted code
   * only. The server must authenticate this registration against the live lease. */
  registrationHeaders: () => HeadersInit | Promise<HeadersInit>;
  window?: Window & typeof globalThis;
  timeoutMs?: number;
}) {
  const owner = options.window ?? window;
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
    },
    body: "{}",
    signal: owner.AbortSignal.timeout(timeoutMs),
  });
  if (!registration.ok) throw new Error("cookies_owner_registration_failed");
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
    }
  >();
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
    if (data.type === "network-result") {
      const item = networkPending.get(data.id);
      if (!item) return;
      networkPending.delete(data.id);
      clearTimeout(item.timer);
      item.detach();
      if (data.error)
        item.reject(
          new DOMException("Cookie network operation failed", data.error),
        );
      else item.resolve(data.result);
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
    forbiddenOrigins: options.forbiddenOrigins,
  });
  await ready;
  function network(
    type: string,
    context: import("./sandbox-cookies.ts").CookieRequestContext,
    lines?: string[],
  ) {
    if (!live) return Promise.reject(new Error("cookies_owner_disposed"));
    if (networkPending.size >= 32)
      return Promise.reject(
        new DOMException("Cookie control backpressure", "QuotaExceededError"),
      );
    if (context.signal?.aborted) return Promise.reject(context.signal.reason);
    const id = owner.crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const detach = () =>
        context.signal?.removeEventListener("abort", cancelled);
      const cancel = (reason: unknown) => {
        if (!networkPending.delete(id)) return;
        clearTimeout(timer);
        detach();
        worker.postMessage({ type: "cancel-network", id });
        reject(reason);
      };
      const cancelled = () =>
        cancel(
          context.signal?.reason ??
            new DOMException("Cookie request aborted", "AbortError"),
        );
      const timer = setTimeout(
        () =>
          cancel(
            new DOMException(
              "Cookie network operation timed out; commit may be durable",
              "TimeoutError",
            ),
          ),
        timeoutMs,
      );
      networkPending.set(id, { resolve, reject, timer, detach });
      context.signal?.addEventListener("abort", cancelled, { once: true });
      const { signal: _signal, ...fixed } = context;
      try {
        worker.postMessage({
          type,
          id,
          context: fixed,
          ...(lines ? { lines } : {}),
        });
      } catch (error) {
        cancel(error);
      }
    });
  }

  return {
    getRequestHeader: (
      context: import("./sandbox-cookies.ts").CookieRequestContext,
    ) => network("request-header", context) as Promise<string>,
    storeResponseCookies: (
      lines: string[],
      context: import("./sandbox-cookies.ts").CookieRequestContext,
    ) => network("response-cookies", context, lines),
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
      if (!response.ok) throw new Error("cookies_document_registration_failed");
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
