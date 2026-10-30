import {
  checkedLocalActorAuthority,
  type LocalActorAuthority,
} from "./local-authority.ts";
import { getProfileLimits } from "./profile-limits.ts";
import type { CookieRequestContext } from "./sandbox-cookies.ts";
type Host = Window & typeof globalThis;
type Options = {
  nativeV2?: boolean;
  workerURL: string | URL;
  localAuthority: LocalActorAuthority;
  window?: Host;
  timeoutMs?: number;
  forbiddenOrigins?: string[];
};
/** Pure browser-local owner lifecycle. No registration, remote capability,
 * transport generation, heartbeat or backup service belongs to this actor. */
async function createOwner(kind: "storage" | "cookies", options: Options) {
  const host = options.window ?? window,
    authority = checkedLocalActorAuthority(options.localAuthority);
  const url = new URL(String(options.workerURL), host.location.href);
  if (url.origin !== host.location.origin || !/^https?:$/.test(url.protocol))
    throw new TypeError("Invalid local actor asset");
  const worker = options.nativeV2
    ? kind === "storage"
      ? new Worker(new URL("./storage-native-worker-v2.ts", import.meta.url), {
          type: "module",
          name: "atlas-local-storage-v2",
        })
      : new Worker(new URL("./cookie-native-worker-v2.ts", import.meta.url), {
          type: "module",
          name: "atlas-local-cookies-v2",
        })
    : new host.Worker(url, { type: "module", name: `atlas-local-${kind}-v2` });
  const timeout = options.timeoutMs ?? 10000;
  let live = true;
  const pending = new Map<
    string,
    { resolve(value?: any): void; reject(error: Error): void; timer: number }
  >();
  const bindings = new Map<string, { dispose(): void }>();
  const networkQueue: string[] = [];
  const networkItems = new Map<
    string,
    { bytes: number; sent: boolean; send(): void }
  >();
  let networkActive = 0,
    networkBytes = 0;
  function pumpNetwork() {
    while (live && networkActive < 16 && networkQueue.length) {
      const id = networkQueue.shift()!,
        item = networkItems.get(id);
      if (!item || !pending.has(id)) continue;
      item.sent = true;
      networkActive++;
      item.send();
    }
  }
  function finishNetwork(id: string) {
    const item = networkItems.get(id);
    if (!item) return;
    networkItems.delete(id);
    networkBytes -= item.bytes;
    if (item.sent) networkActive--;
    else {
      const at = networkQueue.indexOf(id);
      if (at >= 0) networkQueue.splice(at, 1);
    }
    pumpNetwork();
  }
  const revoke = (event: Event) => {
    if (
      (event as CustomEvent).detail?.generation ===
      authority.localAuthGeneration
    )
      dispose();
  };
  host.addEventListener("atlas:profile-local-revoke", revoke);
  function dispose() {
    if (!live) return;
    live = false;
    host.removeEventListener("atlas:profile-local-revoke", revoke);
    try {
      worker.postMessage({
        type: "revoke-local",
        expectedAuthGeneration: authority.localAuthGeneration,
      });
    } catch {}
    worker.terminate();
    for (const entry of pending.values()) {
      host.clearTimeout(entry.timer);
      entry.reject(
        new DOMException("Local actor stopped", "InvalidStateError"),
      );
    }
    pending.clear();
    networkItems.clear();
    networkQueue.length = 0;
    networkBytes = networkActive = 0;
    for (const entry of bindings.values()) entry.dispose();
    bindings.clear();
  }
  function wait(id: string) {
    if (!live || pending.size >= 512)
      return Promise.reject(
        new DOMException("Local actor unavailable", "InvalidStateError"),
      );
    return new Promise<any>((resolve, reject) => {
      const timer = host.setTimeout(() => {
        pending.delete(id);
        finishNetwork(id);
        reject(
          new DOMException(
            "Local actor operation timed out; local state is retained",
            "TimeoutError",
          ),
        );
      }, timeout);
      pending.set(id, { resolve, reject, timer });
    });
  }
  const ready = wait("@ready");
  worker.onmessage = ({ data }) => {
    if (!live || !data) return;
    if (data.type === "profile-native-change") {
      host.dispatchEvent(
        new host.CustomEvent("atlas:profile-native-change", {
          detail: {
            ...data,
            profileId: authority.profileId,
            replicaId: authority.replicaId,
          },
        }),
      );
      return;
    }
    const id = data.type === "ready" ? "@ready" : (data.id ?? data.documentId);
    const entry = pending.get(id);
    if (!entry) return;
    if (["ready", "document-bound", "network-result"].includes(data.type)) {
      pending.delete(id);
      host.clearTimeout(entry.timer);
      finishNetwork(id);
      if (data.error)
        entry.reject(
          new DOMException("Local cookie operation failed", data.error),
        );
      else entry.resolve(data.result);
    } else if (data.type === "error") {
      pending.delete(id);
      host.clearTimeout(entry.timer);
      finishNetwork(id);
      entry.reject(
        new DOMException(
          "Local storage initialization failed; original data is retained",
          "InvalidStateError",
        ),
      );
    }
  };
  worker.onerror = () => dispose();
  worker.onmessageerror = () => dispose();
  worker.postMessage({
    type: "initialize",
    profileId: authority.replicaId,
    localAuthority: authority,
    browserSessionId: authority.browserSessionId,
    localReceipts: true,
    forbiddenOrigins: options.forbiddenOrigins,
  });
  try {
    await ready;
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    get live() {
      return live;
    },
    dispose,
    async bind(input: {
      documentId: string;
      website: string;
      sessionId?: string;
      topLevelURL?: string;
      siteForCookiesURL?: string | null;
    }) {
      const { documentId } = input,
        website = new URL(input.website);
      if (
        !live ||
        !/^[A-Za-z0-9_-]{16,96}$/.test(documentId) ||
        bindings.has(documentId) ||
        !/^https?:$/.test(website.protocol) ||
        website.origin === host.location.origin ||
        website.username ||
        website.password
      )
        throw new TypeError("Invalid local document binding");
      const channel = new host.MessageChannel(),
        bound = wait(documentId);
      worker.postMessage(
        kind === "storage"
          ? {
              type: "bind-document",
              documentId,
              website: website.href,
              sessionId: input.sessionId,
              quotaBytes: getProfileLimits(authority.profileId).localBytes,
              localAuthority: {
                ...authority,
                documentId,
                logicalOrigin: website.origin,
              },
            }
          : {
              type: "bind-document",
              context: {
                documentId,
                documentURL: website.href,
                topLevelURL: input.topLevelURL ?? website.href,
                siteForCookiesURL:
                  input.siteForCookiesURL === undefined
                    ? (input.topLevelURL ?? website.href)
                    : input.siteForCookiesURL,
              },
              localAuthority: {
                ...authority,
                documentId,
                logicalOrigin: website.origin,
              },
            },
        [channel.port1],
      );
      try {
        await bound;
      } catch (error) {
        channel.port2.close();
        throw error;
      }
      const binding = {
        port: channel.port2,
        localOnly: true as const,
        // Kept only for compatibility with the existing facade endpoint shape.
        // localOnly facades never request these inert paths.
        endpoint: `${host.location.origin}/browse/${kind === "storage" ? "storage/commit" : "cookies/result"}/${"L".repeat(43)}`,
        dispose() {
          if (!bindings.delete(documentId)) return;
          channel.port2.close();
          if (live) worker.postMessage({ type: "unbind-document", documentId });
        },
      };
      bindings.set(documentId, binding);
      return binding;
    },
    async network(
      type: string,
      context: CookieRequestContext,
      lines?: string[],
    ) {
      if (context.signal?.aborted) throw context.signal.reason;
      const { signal, ...fixed } = context;
      const bytes =
        1024 +
        Object.entries(fixed).reduce(
          (n, [key, value]) =>
            n +
            2 * (key.length + (typeof value === "string" ? value.length : 16)),
          0,
        ) +
        (lines?.reduce((n, line) => n + 2 * line.length, 0) ?? 0);
      if (networkItems.size >= 512 || networkBytes + bytes > 2 * 1024 * 1024)
        throw new DOMException(
          "Local cookie request queue is full",
          "QuotaExceededError",
        );
      const id = host.crypto.randomUUID(),
        result = wait(id);
      const abort = () => {
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        host.clearTimeout(item.timer);
        const sent = networkItems.get(id)?.sent;
        finishNetwork(id);
        if (sent) worker.postMessage({ type: "cancel-network", id });
        item.reject(
          context.signal?.reason ?? new DOMException("Aborted", "AbortError"),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      networkBytes += bytes;
      networkItems.set(id, {
        bytes,
        sent: false,
        send: () =>
          worker.postMessage({
            type,
            id,
            context: fixed,
            ...(lines ? { lines } : {}),
          }),
      });
      networkQueue.push(id);
      pumpNetwork();
      try {
        return await result;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
export async function createLocalStorageOwnerV2(options: Options) {
  const actor = await createOwner("storage", options);
  return {
    get live() {
      return actor.live;
    },
    bind: actor.bind,
    dispose: actor.dispose,
  };
}
export async function createLocalCookieOwnerV2(options: Options) {
  const actor = await createOwner("cookies", options);
  return {
    get live() {
      return actor.live;
    },
    bind: actor.bind,
    dispose: actor.dispose,
    getRequestHeader: (context: CookieRequestContext) =>
      actor.network("request-header", context) as Promise<string>,
    storeResponseCookies: (lines: string[], context: CookieRequestContext) =>
      actor.network("response-cookies", context, lines) as Promise<void>,
  };
}
