/** Trusted frontend coordinator for durable website storage. Owner credentials
 * never cross a document port. The server sees only document commit markers;
 * values travel directly between the opaque document and this browser worker.
 */
export async function createSandboxStorageOwner(options: {
  workerURL: string | URL;
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
    throw new TypeError("Storage worker must be a trusted frontend asset.");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError("Invalid storage owner timeout.");
  const registration = await owner.fetch("/api/browse/storage/owners", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...Object.fromEntries(new Headers(await options.registrationHeaders())),
      "content-type": "application/json",
    },
    body: "{}",
    signal: owner.AbortSignal.timeout(timeoutMs),
  });
  if (!registration.ok) throw new Error("storage_owner_registration_failed");
  const grant = await registration.json();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(grant.capability) ||
    grant.websocket !== "/browse/storage/owner/" + grant.capability
  )
    throw new Error("invalid_storage_owner_grant");
  const headers = {
    authorization: "Bearer " + grant.capability,
    "content-type": "application/json",
  };
  let worker: Worker;
  try {
    worker = new owner.Worker(asset, {
      type: "module",
      name: "atlas-website-storage",
    });
  } catch (error) {
    void owner
      .fetch("/api/browse/storage/owners", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { authorization: headers.authorization },
      })
      .catch(() => {});
    throw error;
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
      .fetch("/api/browse/storage/documents/" + documentId, {
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
    readyReject(new Error("storage_owner_disposed"));
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("storage_owner_disposed"));
    }
    pending.clear();
    for (const value of bindings.values()) value.port.close();
    bindings.clear();
    worker.terminate();
    void owner
      .fetch("/api/browse/storage/owners", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { authorization: headers.authorization },
      })
      .catch(() => {});
  }
  worker.onmessage = ({ data }) => {
    if (!live || !data) return;
    if (data.type === "unavailable") {
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
        else binding.reject(new Error("storage_document_binding_failed"));
      } else if (data.type === "error" && !data.documentId) {
        readyReject(new Error("storage_worker_failed"));
        dispose();
      }
    }
  };
  worker.onerror = () => {
    readyReject(new Error("storage_worker_failed"));
    dispose();
  };
  const startTimer = setTimeout(() => {
    readyReject(new Error("storage_worker_timeout"));
    dispose();
  }, timeoutMs);
  const socket = new URL(grant.websocket, frontend);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  worker.postMessage({ type: "initialize", socketURL: socket.href });
  await ready;
  return {
    async bind({
      documentId,
      website,
      sessionId,
    }: {
      documentId: string;
      website: string;
      sessionId: string;
    }) {
      if (!live) throw new Error("storage_owner_disposed");
      if (
        !/^[A-Za-z0-9_-]{16,96}$/.test(documentId) ||
        bindings.has(documentId) ||
        pending.has(documentId)
      )
        throw new TypeError("Invalid document storage binding");
      const site = new URL(website);
      if (
        !/^https?:$/.test(site.protocol) ||
        site.username ||
        site.password ||
        site.hostname === new URL(frontend).hostname
      )
        throw new TypeError("Invalid website storage origin");
      const response = await owner.fetch("/api/browse/storage/documents", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ documentId }),
        signal: owner.AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error("storage_document_registration_failed");
      const document = await response.json();
      if (
        document.documentId !== documentId ||
        !/^\/browse\/storage\/commit\/[A-Za-z0-9_-]{43}$/.test(document.commit)
      )
        throw new Error("invalid_storage_document_grant");
      if (!live) {
        cleanupDocument(documentId);
        throw new Error("storage_owner_disposed");
      }
      const channel = new MessageChannel();
      try {
        const bound = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(documentId);
            reject(new Error("storage_document_binding_timeout"));
          }, timeoutMs);
          pending.set(documentId, { resolve, reject, timer });
        });
        worker.postMessage(
          { type: "bind-document", documentId, website: site.href, sessionId },
          [channel.port1],
        );
        await bound;
        const binding = {
          port: channel.port2,
          endpoint: new URL(document.commit, frontend).href,
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
