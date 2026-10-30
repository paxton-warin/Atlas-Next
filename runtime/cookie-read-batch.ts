/** Reuse only an acknowledged cookie view within the current synchronous job.
 * A microtask clears it before async continuations; writes in any facade owned
 * by this window invalidate every sibling view synchronously. Never persist a
 * speculative value or change worker/network cookie authority. */
const clocks = new WeakMap<object, { epoch: number }>();
export function createCookieReadBatch(owner: object, schedule: (f: () => void) => void) {
  let clock = clocks.get(owner);
  if (!clock) { clock = { epoch: 0 }; clocks.set(owner, clock); }
  let saved: { view: string; url: string; expiresAt: number | null; epoch: number } | undefined;
  let queued = false;
  const clear = () => { saved = undefined; };
  return {
    get(url: string, now: number): string | undefined {
      if (!saved || saved.epoch !== clock!.epoch || saved.url !== url ||
          (saved.expiresAt !== null && saved.expiresAt <= now)) return undefined;
      return saved.view;
    },
    remember(view: string, url: string, expiresAt: number | null) {
      saved = { view, url, expiresAt, epoch: clock!.epoch };
      if (!queued) { queued = true; schedule(() => { queued = false; clear(); }); }
    },
    invalidate() { clock!.epoch++; clear(); },
    clear,
  };
}
