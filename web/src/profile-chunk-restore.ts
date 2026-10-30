import { HUB_LIMITS } from "../../runtime/hub-contracts.ts";

type Manifest = {
  codec: "atlas-chunks-v1";
  bytes: number;
  hashes: string[];
  sha256: string;
};
type Callbacks = {
  read(hash: string, index: number, signal: AbortSignal): Promise<{ data: string }>;
  apply(index: number, data: string): Promise<void>;
  check?(): void;
};
type Options = {
  concurrency?: 1 | 2;
  /** Reservation for retained base64 strings at worst-case UTF-16 size. This
   * bounds the lookahead queue, not browser fetch/JSON parsing internals. */
  maxBufferedBytes?: number;
  signal?: AbortSignal;
};
export const PROFILE_RESTORE_BUFFER_BYTES = 24 * 1024 * 1024;
type Outcome = { ok: true; data: string } | { ok: false; error: unknown };
type Pending = { bytes: number; promise: Promise<Outcome> };

/** Overlap bounded chunk transport only. The caller's trusted local worker
 * remains the sole decoder/hash verifier and applies each chunk in order.
 * Never parallelize native hydration or publish partial snapshots. */
export async function restoreProfileChunks(
  manifest: Manifest,
  callbacks: Callbacks,
  options: Options = {},
): Promise<void> {
  const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!manifest || manifest.codec !== "atlas-chunks-v1" ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > HUB_LIMITS.streamBytes ||
      !Array.isArray(manifest.hashes) || manifest.hashes.length !== Math.ceil(manifest.bytes / HUB_LIMITS.chunkBytes) ||
      manifest.hashes.length > 64 || !manifest.hashes.every(validHash) || !validHash(manifest.sha256))
    throw Error("PROFILE_RESTORE_CHUNKS_INVALID");
  const concurrency = options.concurrency ?? 2;
  const budget = options.maxBufferedBytes ?? PROFILE_RESTORE_BUFFER_BYTES;
  if (![1, 2].includes(concurrency) || !Number.isSafeInteger(budget) || budget < 1 || budget > PROFILE_RESTORE_BUFFER_BYTES)
    throw Error("PROFILE_RESTORE_BUFFER_INVALID");
  const costs = manifest.hashes.map((_, index) => {
    const bytes = Math.min(HUB_LIMITS.chunkBytes, manifest.bytes - index * HUB_LIMITS.chunkBytes);
    return Math.ceil(bytes / 3) * 4 * 2;
  });
  if (costs.some(bytes => bytes > budget)) throw Error("PROFILE_RESTORE_BUFFER_TOO_SMALL");
  const controller = new AbortController();
  const pending = new Map<number, Pending>();
  let next = 0, retained = 0, closed = false;
  const abortError = () => options.signal?.reason ?? new DOMException("Profile restore cancelled", "AbortError");
  const check = () => {
    if (closed || options.signal?.aborted) throw abortError();
    callbacks.check?.();
  };
  const abort = () => controller.abort(abortError());
  options.signal?.addEventListener("abort", abort, { once: true });
  const schedule = () => {
    while (next < manifest.hashes.length && pending.size < concurrency && retained + costs[next] <= budget) {
      check();
      const index = next++, bytes = costs[index];
      retained += bytes;
      // Every speculative rejection becomes a fulfilled outcome immediately.
      // A later failed/aborted apply can discard pending work without emitting
      // an unhandled rejection or retaining a late response in a side cache.
      const promise = Promise.resolve().then(() => {
        check();
        return callbacks.read(manifest.hashes[index], index, controller.signal);
      }).then((value): Outcome => {
        check();
        if (!value || typeof value.data !== "string" || value.data.length * 2 > bytes)
          throw Error("PROFILE_RESTORE_CHUNK_SIZE_INVALID");
        return { ok: true, data: value.data };
      }).catch((error): Outcome => ({ ok: false, error }));
      pending.set(index, { bytes, promise });
    }
  };
  try {
    check();
    for (let index = 0; index < manifest.hashes.length; index++) {
      schedule();
      const task = pending.get(index);
      if (!task) throw Error("PROFILE_RESTORE_BUFFER_STALLED");
      const result = await task.promise;
      check();
      if (!result.ok) throw result.error;
      await callbacks.apply(index, result.data);
      check();
      retained -= task.bytes;
      pending.delete(index);
    }
  } finally {
    closed = true;
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    pending.clear();
  }
}
