/** Bounded worker-resident cloud restoration. The shell transports encoded
 * values/chunks only; native snapshots never bounce worker -> UI -> worker. */
import { HUB_LIMITS, hubNamespace, type HubNamespace } from "./hub-contracts.ts";
import type { CloudHead } from "./profile-sync.ts";
import type { createProfileWirePlanner, PreparedProfileWire } from "./profile-wire.ts";

type Journal = { revision: number; mode?: string; payload: unknown };
export type ProfileHydrationSpec = {
  namespace: HubNamespace;
  revision: number;
  snapshotRevision: number;
  journal: Array<{ revision: number; mode?: string }>;
  head: CloudHead;
  operation: "restore" | "compact";
};
type Wire = Pick<ReturnType<typeof createProfileWirePlanner>, "decode" | "decodeChunk" | "decodeBytes" | "prepare">;
type Callbacks = {
  restore(namespace: HubNamespace, snapshot: unknown, journal: Journal[], head: CloudHead): Promise<void>;
  compact(namespace: HubNamespace, stream: { revision: number; snapshotRevision: number; snapshot: unknown; journal: Journal[] }): Promise<unknown>;
};
type Chunked = { codec: "atlas-chunks-v1"; bytes: number; hashes: string[]; sha256: string };
type Session = ProfileHydrationSpec & {
  handle: string;
  snapshot: unknown;
  values: Journal[];
  next: number;
  bytes: number;
  busy: boolean;
  loading?: { manifest: Chunked; bytes: Uint8Array<ArrayBuffer>; offset: number; next: number };
};
export function createProfileHydration(wire: Wire, callbacks: Callbacks) {
  // Independent sites can remain hydrated while their chunks are in flight.
  // The TOTAL retained byte budget is unchanged, not multiplied by site count.
  const sessions = new Map<string, Session>();
  const waiters: Array<{ spec: ProfileHydrationSpec; resolve(handle: string): void; reject(error: unknown): void }> = [];
  const MAX_SESSIONS = 4;
  let retainedBytes = 0, disposed = false;
  const quota = () => Object.assign(Error("Profile restoration allowance exceeded; local saves are retained."), { name: "QuotaExceededError" });
  const get = (handle: unknown) => {
    const session = typeof handle === "string" ? sessions.get(handle) : undefined;
    if (!session) throw Error("PROFILE_HYDRATION_UNKNOWN");
    return session;
  };
  const active = (s: Session) => { if (sessions.get(s.handle) !== s) throw Error("PROFILE_HYDRATION_CLOSED"); };
  async function run<T>(handle: string, work: (s: Session) => Promise<T> | T): Promise<T> {
    const s = get(handle);
    if (s.busy) throw Object.assign(Error("Profile restoration is busy."), { name: "QuotaExceededError" });
    s.busy = true;
    try { return await work(s); } finally { s.busy = false; }
  }
  function charge(s: Session, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || s.bytes + bytes > HUB_LIMITS.streamBytes ||
        retainedBytes + bytes > HUB_LIMITS.streamBytes) throw quota();
    s.bytes += bytes; retainedBytes += bytes;
  }
  function append(s: Session, value: unknown) {
    active(s);
    if (s.next === 0) s.snapshot = value;
    else s.values.push({ ...s.journal[s.next - 1], payload: value });
    s.next++;
  }
  function validate(spec: ProfileHydrationSpec) {
    hubNamespace(spec?.namespace);
    if (!["restore", "compact"].includes(spec.operation) || !Number.isSafeInteger(spec.revision) ||
        !Number.isSafeInteger(spec.snapshotRevision) || spec.snapshotRevision < 0 || spec.revision < spec.snapshotRevision ||
        !spec.head || spec.head.revision !== spec.revision || !Number.isSafeInteger(spec.head.epoch) || spec.head.epoch < 0 ||
        !Array.isArray(spec.journal) || spec.journal.length > 100000 || spec.journal.length !== spec.revision - spec.snapshotRevision ||
        spec.journal.some((e, i) => !e || e.revision !== spec.snapshotRevision + i + 1 ||
          (e.mode !== undefined && e.mode !== "journal" && e.mode !== "snapshot")))
      throw Error("PROFILE_HYDRATION_SPEC_INVALID");
  }
  function begin(spec: ProfileHydrationSpec): string | Promise<string> {
    if (disposed) throw Error("PROFILE_HYDRATION_CLOSED");
    validate(spec);
    const key = hubNamespace(spec.namespace).key;
    if ([...sessions.values()].some(s => hubNamespace(s.namespace).key === key))
      throw Object.assign(Error("A profile restoration is already active for this website stream."), { name: "QuotaExceededError" });
    if (sessions.size >= MAX_SESSIONS) {
      // Reserve half of the 32 RPC slots for active holders' value/finish/
      // abort messages. A full admission queue must never prevent its owners
      // from releasing the very slots those callers are waiting to acquire.
      if (waiters.length >= 16) throw Object.assign(Error("Profile restoration admission is busy. Retry this website."), { name: "AbortError", code: "PROFILE_LOCAL_BACKPRESSURE" });
      // The worker transport already awaits the returned promise. Admission is
      // bounded and FIFO; a fifth cold tab does not receive a spurious failure.
      return new Promise((resolve, reject) => waiters.push({ spec, resolve, reject }));
    }
    const handle = crypto.randomUUID();
    sessions.set(handle, { ...spec, namespace: { ...spec.namespace }, head: { ...spec.head }, journal: spec.journal.map(e => ({ ...e })),
      handle, snapshot: null, values: [], next: 0, bytes: 0, busy: false });
    return handle;
  }
  function release(s: Session) {
    if (sessions.get(s.handle) !== s) return;
    sessions.delete(s.handle); retainedBytes -= s.bytes;
    s.snapshot = null; s.values = []; s.loading = undefined;
    while (!disposed && sessions.size < MAX_SESSIONS && waiters.length) {
      const next = waiters.shift()!;
      try { next.resolve(begin(next.spec) as string); } catch (error) { next.reject(error); }
    }
  }
  return {
    begin,
    value(handle: string, index: number, encoded: unknown): Promise<void> {
      return run(handle, async s => {
        if (index !== s.next || s.loading || index > s.journal.length) throw Error("PROFILE_HYDRATION_ORDER_INVALID");
        const value = encoded as Partial<Chunked> | null;
        if (value?.codec === "atlas-chunks-v1") {
          if (!Number.isSafeInteger(value.bytes) || value.bytes! <= 0 || value.bytes! > HUB_LIMITS.streamBytes ||
              !Array.isArray(value.hashes) || value.hashes.length !== Math.ceil(value.bytes! / HUB_LIMITS.chunkBytes) ||
              value.hashes.length > 64 || value.hashes.some(h => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) ||
              typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))
            throw Error("PROFILE_HYDRATION_CHUNKS_INVALID");
          charge(s, value.bytes!);
          s.loading = { manifest: { codec: "atlas-chunks-v1", bytes: value.bytes!, hashes: [...value.hashes], sha256: value.sha256 },
            bytes: new Uint8Array(value.bytes!), offset: 0, next: 0 };
          return;
        }
        if (encoded !== null) charge(s, new TextEncoder().encode(JSON.stringify(encoded)).byteLength);
        const decoded = encoded === null ? null : await wire.decode(encoded as Parameters<Wire["decode"]>[0]);
        append(s, decoded);
      });
    },
    chunk(handle: string, index: number, data: string): Promise<void> {
      return run(handle, async s => {
        const part = s.loading;
        if (!part || index !== part.next || index >= part.manifest.hashes.length) throw Error("PROFILE_HYDRATION_ORDER_INVALID");
        const bytes = new Uint8Array(await wire.decodeChunk(data, part.manifest.hashes[index]));
        active(s);
        const expected = Math.min(HUB_LIMITS.chunkBytes, part.bytes.byteLength - part.offset);
        if (bytes.byteLength !== expected) throw Error("PROFILE_HYDRATION_CHUNK_SIZE_INVALID");
        part.bytes.set(bytes, part.offset); part.offset += bytes.byteLength; part.next++;
        if (part.next === part.manifest.hashes.length) {
          const decoded = await wire.decodeBytes(part.bytes.buffer, part.manifest.sha256);
          active(s); s.loading = undefined; append(s, decoded);
        }
      });
    },
    finish(handle: string): Promise<PreparedProfileWire | void> {
      return run(handle, async s => {
        if (s.loading || s.next !== s.journal.length + 1) throw Error("PROFILE_HYDRATION_INCOMPLETE");
        try {
          if (s.operation === "restore") {
            await callbacks.restore(s.namespace, s.snapshot, s.values, s.head);
            return;
          }
          const payload = await callbacks.compact(s.namespace, { revision: s.revision, snapshotRevision: s.snapshotRevision,
            snapshot: s.snapshot, journal: s.values });
          active(s); s.snapshot = null; s.values = [];
          return await wire.prepare(payload);
        } finally { release(s); }
      });
    },
    abort(handle: string) { release(get(handle)); },
    dispose() {
      disposed = true;
      for (const waiter of waiters.splice(0)) waiter.reject(Error("PROFILE_HYDRATION_CLOSED"));
      for (const session of sessions.values()) release(session);
    },
  };
}
