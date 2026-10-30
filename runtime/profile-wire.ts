/** Pure wire preparation for the trusted local worker. No network, account
 * credentials, App storage, or externally supplied execution capabilities. */
import { HUB_LIMITS, encodePortableValue, decodePortableValue, type PortableGraph } from "./hub-contracts.ts";

// Exact legacy wire choice: changing this threshold changes persisted receipts.
export const PROFILE_WIRE_INLINE_BYTES = 500000;
export const PROFILE_WIRE_MAX_PLANS = 2;
export type ProfileWirePlan = { handle: string; bytes: number; hashes: string[]; sha256: string };
export type PreparedProfileWire = PortableGraph | ProfileWirePlan;
export type ProfileWireChunk = { hash: string; body: Blob };

function quota(message: string) { return Object.assign(Error(message), { name: "QuotaExceededError" }); }
async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (value) => value.toString(16).padStart(2, "0")).join("");
}
function base64(bytes: Uint8Array) {
  let text = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
function checkedHash(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw Error("Invalid profile integrity hash.");
  return value;
}
function decodeGraphBytes(value: ArrayBuffer) {
  if (value.byteLength > HUB_LIMITS.streamBytes) throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
  return decodePortableValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as PortableGraph);
}

/** Reusable by recovery packing, but call only in the trusted worker. The
 * serialized representation is exactly the existing codec's JSON UTF-8. */
export async function buildProfileWire(value: unknown): Promise<{ graph: PortableGraph; serialized: Uint8Array }> {
  const graph = await encodePortableValue(value);
  const serialized = new TextEncoder().encode(JSON.stringify(graph));
  if (serialized.byteLength > HUB_LIMITS.streamBytes) throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
  return { graph, serialized };
}

export function createProfileWirePlanner() {
  const plans = new Map<string, { bytes: Uint8Array; hashes: string[]; sha256: string }>();
  let work = Promise.resolve(), queued = 0, retainedBytes = 0, disposed = false;
  const live = () => { if (disposed) throw Error("PROFILE_WIRE_DISPOSED"); };
  const handleKey = (handle: unknown) => {
    if (typeof handle !== "string" || handle.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(handle)) throw Error("PROFILE_WIRE_HANDLE_INVALID");
    return handle;
  };
  function expensive<T>(run: () => Promise<T> | T): Promise<T> {
    // Serialize CPU/codec work only, never a cloud transfer or a retained wire
    // handle. Independent websites may share this worker without false quota
    // failures when two encodes/decodes overlap at an async Blob/crypto step.
    try { live(); } catch (error) { return Promise.reject(error); }
    if (queued >= 32) return Promise.reject(Object.assign(quota("Profile wire worker backpressure"), { code: "PROFILE_LOCAL_BACKPRESSURE" }));
    queued++;
    const next = work.then(() => { live(); return run(); });
    work = next.then(() => {}, () => {});
    return next.finally(() => { queued--; });
  }
  return {
    prepare(value: unknown): Promise<PreparedProfileWire> {
      return expensive(async () => {
        const { graph, serialized } = await buildProfileWire(value);
        live();
        if (serialized.byteLength < PROFILE_WIRE_INLINE_BYTES) return graph;
        if (plans.size >= PROFILE_WIRE_MAX_PLANS) throw Object.assign(quota("Profile wire plan limit reached"), { code: "PROFILE_LOCAL_BACKPRESSURE" });
        // Bound both count and retained bytes; another large save must finish
        // and release its bytes before this worker can retain more than128MiB.
        if (retainedBytes + serialized.byteLength > HUB_LIMITS.streamBytes) throw Object.assign(quota("Profile wire retained-byte limit reached"), { code: "PROFILE_LOCAL_BACKPRESSURE" });
        const hashes: string[] = [];
        for (let offset = 0; offset < serialized.byteLength; offset += HUB_LIMITS.chunkBytes)
          hashes.push(await sha256(serialized.subarray(offset, offset + HUB_LIMITS.chunkBytes)));
        const hash = await sha256(serialized);
        live();
        const handle = crypto.randomUUID();
        plans.set(handle, { bytes: serialized, hashes, sha256: hash });
        retainedBytes += serialized.byteLength;
        return { handle, bytes: serialized.byteLength, hashes: [...hashes], sha256: hash };
      });
    },
    chunk(handle: string, index: number): ProfileWireChunk {
      live();
      const plan = plans.get(handleKey(handle));
      if (!plan) throw Error("PROFILE_WIRE_HANDLE_UNKNOWN");
      if (!Number.isSafeInteger(index) || index < 0 || index >= plan.hashes.length) throw Error("PROFILE_WIRE_CHUNK_INVALID");
      const start = index * HUB_LIMITS.chunkBytes;
      const hash = plan.hashes[index];
      const data = base64(plan.bytes.subarray(start, Math.min(start + HUB_LIMITS.chunkBytes, plan.bytes.byteLength)));
      // Blob structured-clones without copying a multi-megabyte base64 string
      // through the shell. JSON serialization/UTF-8 conversion stays here too.
      return { hash, body: new Blob([JSON.stringify({ hash, data })], { type: "application/json" }) };
    },
    release(handle: string) {
      live();
      const key = handleKey(handle), plan = plans.get(key);
      if (plan) { retainedBytes -= plan.bytes.byteLength; plans.delete(key); }
    },
    encode(value: unknown): Promise<PortableGraph> { return expensive(() => encodePortableValue(value)); },
    decodeChunk(data: string, expectedSHA: string): Promise<ArrayBuffer> {
      return expensive(async () => {
        checkedHash(expectedSHA);
        if (typeof data !== "string" || data.length > Math.ceil((HUB_LIMITS.chunkBytes * 4) / 3) + 4) throw Error("Invalid profile chunk size.");
        const raw = atob(data);
        if (raw.length > HUB_LIMITS.chunkBytes || btoa(raw) !== data) throw Error("Invalid profile chunk encoding.");
        const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        if (await sha256(bytes) !== expectedSHA) throw Error("Profile chunk integrity mismatch.");
        live();
        return bytes.buffer;
      });
    },
    decodeBytes(value: ArrayBuffer, expectedSHA: string): Promise<unknown> {
      return expensive(async () => {
        checkedHash(expectedSHA);
        if (!(value instanceof ArrayBuffer)) throw Error("PROFILE_LOCAL_ARGUMENTS_INVALID");
        if (value.byteLength > HUB_LIMITS.streamBytes) throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
        if (await sha256(new Uint8Array(value)) !== expectedSHA) throw Error("Profile integrity mismatch.");
        live();
        return decodeGraphBytes(value);
      });
    },
    decode(value: PortableGraph | ArrayBuffer): Promise<unknown> {
      return expensive(() => {
        if (value instanceof ArrayBuffer) return decodeGraphBytes(value);
        return decodePortableValue(value);
      });
    },
    dispose() { disposed = true; plans.clear(); retainedBytes = 0; },
  };
}
