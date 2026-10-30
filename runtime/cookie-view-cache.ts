/** A document-visible view may survive JS jobs only while a synchronous,
 * same-frontend mutation epoch is unchanged. No website cookie values live in
 * the native epoch marker; cookies and acknowledgements still belong to the existing IDB worker.
 * Unlike an async storage event/BroadcastChannel, a native cookie read observes
 * sibling-window invalidation before a completed mutation becomes visible.
 */
export type CookieViewClock = { current(): string | undefined; invalidate(): void; authorize?(fence: string | null): void; batchKey?(): string | undefined };
export function createCookieViewClock(owner: any, profileId: string | null | undefined): CookieViewClock | undefined {
  if (!profileId || !/^[a-f\d-]{36}$/i.test(profileId)) return;
  let get: () => string | null, set: (value: string) => void,
    remove: () => void, readState: () => { epoch: string | null; fence: string | null; permit: string | null },
    grant: (fence: string | null) => void, nonce: () => string;
  try {
    const apply = Reflect.apply, doc = owner.document;
    const descriptor = Object.getOwnPropertyDescriptor(owner.Document.prototype, 'cookie')!;
    const read = descriptor.get!, write = descriptor.set!;
    if (!read || !write) return;
    const secure = owner.location.protocol === 'https:';
    // Fixed-size, host-only metadata per frontend, not per profile or tab.
    // The server-confirmed fence prevents unaware older clients from mutating
    // behind a cached view; stale permission replies cannot override a fence. It contains no profile or website data. Unlike
    // native localStorage metadata, this emits no storage events into sites.
    const prefix = secure ? '__Host-' : '';
    const name = prefix + 'atlas-cookie-view-epoch-v1';
    const fenceName = prefix + 'atlas-cookie-view-fence-v1', permitName = prefix + 'atlas-cookie-view-permit-v1';
    const pattern = new RegExp('(?:^|;\\s*)' + name + '=([a-f\\d]{32})(?:;|$)', 'i');
    const fencePattern = new RegExp('(?:^|;\\s*)' + fenceName + '=([a-f\\d]{32})(?:;|$)', 'i');
    const permitPattern = new RegExp('(?:^|;\\s*)' + permitName + '=([a-f\\d]{32})(?:;|$)', 'i');
    readState = () => { const line = apply(read, doc, []); return { epoch: pattern.exec(line)?.[1] ?? null, fence: fencePattern.exec(line)?.[1] ?? null, permit: permitPattern.exec(line)?.[1] ?? null }; };
    get = () => readState().epoch;
    const attributes = ';Path=/;SameSite=Strict' + (secure ? ';Secure' : '');
    set = value => { apply(write, doc, [name + '=' + value + attributes + ';Max-Age=2592000']); };
    remove = () => { apply(write, doc, [name + '=' + attributes + ';Max-Age=0']); };
    const uuid = owner.crypto.randomUUID.bind(owner.crypto);
    nonce = () => uuid().replaceAll('-', '');
    grant = fence => {
      if (fence && /^[a-f\d]{32}$/i.test(fence) && readState().fence === fence)
        apply(write, doc, [permitName + '=' + fence + attributes + ';Max-Age=2592000']);
      else apply(write, doc, [permitName + '=' + attributes + ';Max-Age=0']);
    };
    if (!readState().fence) {
      // No cached view is eligible without a server-confirmed fence. Seeding a
      // missing fence also retires any old permission; it cannot authorize one.
      grant(null);
      apply(write, doc, [fenceName + '=' + nonce() + attributes + ';Max-Age=2592000']);
    }
    // Probe before allowing a cross-task view. Browsers that block native
    // cookie metadata keep the original worker/result protocol instead.
    if (!get()) {
      const value = nonce(); set(value);
      if (get() !== value) return;
    }
  } catch { return; }
  let authorized = true;
  return {
    current() {
      if (!authorized) return undefined;
      try { const s = readState(); return s.epoch && s.fence && s.fence === s.permit ? s.fence + ':' + s.epoch : undefined; }
      catch { return undefined; }
    },
    authorize(fence) {
      try { grant(fence); authorized = true; }
      catch { authorized = false; }
    },
    // An unpermitted cross-task view falls back to the existing same-job
    // batch. Fence/epoch changes must still retire that short-lived batch.
    batchKey() {
      try { const s = readState(); return s.fence && s.epoch ? s.fence + ":" + s.epoch : undefined; }
      catch { return undefined; }
    },
    invalidate() {
      try { const value = nonce(); set(value); if (get() === value) return; }
      catch { /* A rejected metadata write may still expire the existing marker. */ }
      // Missing epoch means no reader may reuse a view. Never continue a write
      // with a silently unchanged epoch when invalidation itself failed.
      try { remove(); if (get() === null) return; } catch {}
      throw new DOMException('Cookie view invalidation is unavailable; existing saves are retained.', 'InvalidStateError');
    },
  };
}

export function createCookieViewCache(clock: CookieViewClock) {
  let saved: { view: string; url: string; expiresAt: number | null; epoch: string } | undefined;
  return {
    get(url: string, now: number, epoch: string | undefined) {
      if (!saved || !epoch || saved.epoch !== epoch || saved.url !== url ||
          (saved.expiresAt !== null && saved.expiresAt <= now)) {
        saved = undefined; return undefined;
      }
      return saved.view;
    },
    remember(view: string, url: string, expiresAt: number | null, before: string | undefined) {
      // A cookie write in another agent can finish during synchronous HTTP.
      // Do not stamp an older worker view with that newer epoch.
      if (before && before === clock.current()) saved = { view, url, expiresAt, epoch: before };
      else saved = undefined;
    },
    clear() { saved = undefined; },
  };
}
