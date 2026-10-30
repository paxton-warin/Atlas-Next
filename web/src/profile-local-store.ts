import { createCookieViewClock } from "../../runtime/cookie-view-cache.ts";
/** Fixed-operation transport to the trusted local profile worker. Network/CAS,
 * credentials, handoff state, and user-facing acknowledgements stay in App. */
import { checkedProfile } from "../../runtime/profile-journal.ts";
import type { ProfilePermit } from "../../runtime/profile-permissions.ts";
import type { ProfileQueue, QueuedProfileChange, CloudHead } from "../../runtime/profile-sync.ts";
import type { ProfileSnapshot } from "../../runtime/profile-store.ts";
import type { CompactableProfileStream } from "../../runtime/profile-compaction.ts";
import type { HubNamespace } from "../../runtime/hub-contracts.ts";
import type { PortableGraph } from "../../runtime/hub-contracts.ts";
import type { PreparedProfileWire, ProfileWireChunk } from "../../runtime/profile-wire.ts";
import type { ProfileHydrationSpec } from "../../runtime/profile-hydration.ts";

const PROTOCOL = "atlas-profile-local-v1";
type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;
export function createProfileLocalStore(profileId: string, options: {
  createWorker?: () => WorkerLike;
  timeoutMs?: number;
} = {}) {
  if (!checkedProfile(profileId)) throw new TypeError("Invalid profile identity");
  const cookieClock = typeof window !== "undefined" ? createCookieViewClock(window, profileId) : undefined;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError("Invalid profile-local timeout");
  const worker = options.createWorker?.() ?? new Worker(new URL("../../runtime/profile-local-worker.ts", import.meta.url), { type: "module", name: "atlas-profile-local" });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const cookieHydrations = new Set<string>();
  let live = true, serial = 0;
  function dispose(error = Error("PROFILE_LOCAL_DISPOSED")) {
    if (!live) return;
    live = false;
    worker.removeEventListener("message", receive);
    worker.removeEventListener("error", failed);
    worker.removeEventListener("messageerror", failed);
    worker.terminate();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); cookieHydrations.clear();
  }
  const failed = () => dispose(Error("PROFILE_LOCAL_WORKER_FAILED"));
  const receive = ((event: MessageEvent) => {
    const data = event.data;
    if (!live || data?.protocol !== PROTOCOL) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    if (data.ok !== true && (data.ok !== false || !data.error || typeof data.error.message !== "string")) { dispose(Error("PROFILE_LOCAL_RESPONSE_INVALID")); return; }
    pending.delete(data.id); clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.value);
    else entry.reject(Object.assign(Error(data.error.message), { name: data.error.name || "Error", ...(data.error.code ? { code: data.error.code } : {}) }));
  }) as EventListener;
  worker.addEventListener("message", receive);
  worker.addEventListener("error", failed);
  worker.addEventListener("messageerror", failed);
  function request(operation: string, args: unknown[] = [], transfer: Transferable[] = []) {
    if (!live) return Promise.reject(Error("PROFILE_LOCAL_DISPOSED"));
    if (pending.size >= 32) return Promise.reject(Error("PROFILE_LOCAL_BACKPRESSURE"));
    return new Promise<any>((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => dispose(Object.assign(Error("Profile-local operation timed out; committed data is retained."), { name: "TimeoutError" })), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ protocol: PROTOCOL, id, operation, args }, transfer); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const ready = request("initialize", [profileId]);
  // A caller may construct before its first operation; initialization failure
  // remains observable to every operation without an unhandled rejection.
  void ready.catch(() => {});
  const call = async (operation: string, args: unknown[] = [], transfer: Transferable[] = []) => { await ready; return request(operation, args, transfer); };
  const queue: ProfileQueue = {
    compaction: change => call("queue-compaction", [change]),
    prepareCompaction: (change, plan) => call("queue-prepare-compaction", [change, plan]),
    finishCompaction: (change, plan) => call("queue-finish-compaction", [change, plan]),
    list: siteGroup => call("queue-list", siteGroup === undefined ? [] : [siteGroup]), head: change => call("queue-head", [change]),
    prepared: change => call("queue-prepared", [change]), prepare: (change, head) => call("queue-prepare", [change, head]),
    acknowledge: (change, head) => call("queue-acknowledge", [change, head]),
  };
  return {
    queue,
    pendingNamespaces: (siteGroup?: string): Promise<HubNamespace[]> => call("queue-namespaces", siteGroup === undefined ? [] : [siteGroup]),
    prepareRecovery: (id: string, origin: string): Promise<{ wire: PreparedProfileWire; changes: number } | null> => call("prepare-recovery", [id, origin]),
    finishRecovery: (id: string, origin: string): Promise<void> => call("finish-recovery", [id, origin]),
    prepareWire: (value: unknown): Promise<PreparedProfileWire> => call("wire-encode", [value]),
    beginHydration: async (spec: ProfileHydrationSpec): Promise<string> => { if (spec.namespace.kind === "cookies") cookieClock?.invalidate(); const handle = await call("hydrate-begin", [spec]); if (spec.namespace.kind === "cookies") cookieHydrations.add(handle); return handle; },
    hydrateValue: (handle: string, index: number, value: unknown): Promise<void> => call("hydrate-value", [handle, index, value]),
    hydrateChunk: (handle: string, index: number, data: string): Promise<void> => call("hydrate-chunk", [handle, index, data]),
    finishHydration: (handle: string): Promise<PreparedProfileWire | void> => call("hydrate-finish", [handle]).finally(() => { if (cookieHydrations.delete(handle)) cookieClock?.invalidate(); }),
    abortHydration: (handle: string): Promise<void> => call("hydrate-abort", [handle]).finally(() => { if (cookieHydrations.delete(handle)) cookieClock?.invalidate(); }),
    prepareQueueWire: (change: QueuedProfileChange): Promise<PreparedProfileWire> => call("queue-wire", [change]),
    wireChunk: (handle: string, index: number): Promise<ProfileWireChunk> => call("wire-chunk", [handle, index]),
    releaseWire: (handle: string): Promise<void> => call("wire-release", [handle]),
    encodeWire: (value: unknown): Promise<PortableGraph> => call("encode", [value]),
    recoveryFile: (value: unknown): Promise<{ blob: Blob; extension: string }> => call("recovery-file", [value]),
    decodeChunk: (data: string, expectedSHA: string): Promise<ArrayBuffer> => call("decode-chunk", [data, expectedSHA]),
    decodeWireBytes: (data: ArrayBuffer, expectedSHA: string): Promise<unknown> => call("decode-wire-bytes", [data, expectedSHA], [data]),
    decodeWire: (value: PortableGraph | ArrayBuffer): Promise<unknown> => value instanceof ArrayBuffer
      ? call("decode-bytes", [value], [value]) : call("decode", [value]),
    compact: (namespace: HubNamespace, stream: CompactableProfileStream): Promise<unknown> => call("compact", [namespace, stream]),
    setPermit: (permit: ProfilePermit): Promise<void> => call("set-permit", [permit]),
    resumePermit: (permit: ProfilePermit): Promise<boolean> => call("resume-permit", [permit]),
    revokePermit: (permit: Pick<ProfilePermit, "profileId" | "group" | "contextId" | "epoch">): Promise<boolean> => call("revoke-permit", [permit]),
    readHead: (namespace: HubNamespace): Promise<CloudHead | null> => call("read-head", [namespace]),
    restore: (namespace: HubNamespace, snapshot: unknown, journals: Array<{ revision: number; mode?: string; payload: any }>, head: CloudHead): Promise<void> => {
      if (namespace.kind !== "cookies") return call("restore", [namespace, snapshot, journals, head]);
      cookieClock?.invalidate();
      return call("restore", [namespace, snapshot, journals, head]).finally(() => cookieClock?.invalidate());
    },
    exportSnapshots: (group?: string): Promise<ProfileSnapshot[]> => call("export", [group]),
    preserveRecovery: (id: string, changes: QueuedProfileChange[], snapshot: unknown): Promise<void> => call("preserve-recovery", [id, changes, snapshot]),
    dispose: () => dispose(),
  };
}
