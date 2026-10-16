export type BrowsingLease = {
  session: string;
  sessionHash?: string;
  generation?: number;
  ticket?: string;
  relayTicket?: string;
  relayOrigin?: string;
  runtimeOrigin?: string;
  leaseExpiresAt?: number;
  ticketExpiresAt?: number;
  expiresAt?: number;
  serverTime?: number;
  expiresLocally?: number;
  bootTicket?: string;
};
export type LeaseFailure = Error & {
  status?: number;
  code?: string;
  retryable?: boolean;
  retryAfter?: number;
};
export type LeaseIntent = "restore" | "renew" | "new";
export const SESSION_STORAGE_KEY = "atlas.nodeSession";
export const LEASE_STORAGE_KEY = "atlas.nodeLease.v2";
export const SAME_ORIGIN_SESSION_STORAGE_KEY =
  "atlas.nodeSession.sameOrigin.v1";
export const SAME_ORIGIN_LEASE_STORAGE_KEY = "atlas.nodeLease.sameOrigin.v1";
export const RELAY_RECOVERY_STORAGE_KEY = "atlas.relayRecovery.v1";
export const RELAY_RECOVERY_REVISION = "20261016-relay-capacity";

/** Discard credentials issued before the relay-capacity repair, not the owner
 * capability that pins the selected node. Website data and Atlas state are not
 * part of this cache. Run inside the startup lock, before authoritative restore,
 * so another window's newly restored credentials are never cleared afterward. */
export function clearStaleRelayCredentials(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
) {
  try {
    if (storage.getItem(RELAY_RECOVERY_STORAGE_KEY) === RELAY_RECOVERY_REVISION)
      return false;
    storage.removeItem(LEASE_STORAGE_KEY);
    storage.removeItem(SAME_ORIGIN_LEASE_STORAGE_KEY);
    storage.setItem(RELAY_RECOVERY_STORAGE_KEY, RELAY_RECOVERY_REVISION);
    return true;
  } catch {
    // Denied/full browser storage must not prevent an online server restore.
    return false;
  }
}

/** A newly activated runtime must not replay assignments from another protocol.
 * Only connection metadata gets a new namespace; website and Atlas state stay
 * untouched. Subsequent same-origin loads reuse the same saved node pin. */
export function browsingLeaseStorageKeys(config?: {
  runtimeProtocols?: { sameOrigin?: { activated?: boolean } };
}) {
  return config?.runtimeProtocols?.sameOrigin?.activated === true
    ? {
        session: SAME_ORIGIN_SESSION_STORAGE_KEY,
        lease: SAME_ORIGIN_LEASE_STORAGE_KEY,
      }
    : { session: SESSION_STORAGE_KEY, lease: LEASE_STORAGE_KEY };
}
export const TERMINAL_LEASE_CODES = new Set([
  "SESSION_REVOKED",
  "INVALID_SESSION",
  "SESSION_GENERATION_MISMATCH",
]);
export function normalizeBrowsingLease<T extends BrowsingLease>(
  lease: T,
  previous?: BrowsingLease,
): T {
  const same =
    previous?.session === lease.session &&
    previous?.generation === lease.generation;
  const expiry = lease.ticketExpiresAt ?? lease.expiresAt;
  return {
    ...lease,
    bootTicket: same ? (previous.bootTicket ?? previous.ticket) : lease.ticket,
    expiresLocally:
      Number.isFinite(expiry) && Number.isFinite(lease.serverTime)
        ? Date.now() + expiry! - lease.serverTime!
        : undefined,
  };
}
function savedSession(saved: unknown) {
  return typeof saved === "string" && saved.length <= 100 ? saved : "";
}
// Restore is a distinct server operation: only the server can prove an idle
// expiry. A generic 409/network failure must never discard a valid node pin.
export async function restoreBrowsingLease<T extends { session: string }>(
  saved: unknown,
  allocate: (session: string, intent?: LeaseIntent) => Promise<T>,
  remember: (session: string) => void,
): Promise<T> {
  const session = savedSession(saved);
  const lease = await allocate(session, "restore");
  remember(lease.session);
  return lease;
}
export function restoreBrowsingLeaseOnStartup<T extends { session: string }>(
  readSaved: () => unknown,
  allocate: (session: string, intent?: LeaseIntent) => Promise<T>,
  remember: (session: string) => void,
  locks?: Pick<LockManager, "request">,
  beforeRestore?: () => void,
): Promise<T> {
  const restore = () => {
    beforeRestore?.();
    return restoreBrowsingLease(readSaved(), allocate, remember);
  };
  return locks ? locks.request("atlas-browsing-session", restore) : restore();
}
export function browsingSessionToRelease(active: unknown, saved: unknown) {
  return savedSession(typeof active === "string" && active ? active : saved);
}
export function selectBrowsingLeaseForOwner<T extends { session: string }>(
  active: unknown,
  readSaved: () => unknown,
  select: (session: string) => Promise<T>,
  remember: (session: string) => void,
  locks?: Pick<LockManager, "request">,
): Promise<T> {
  const change = async () => {
    const lease = await select(browsingSessionToRelease(active, readSaved()));
    remember(lease.session);
    return lease;
  };
  return locks ? locks.request("atlas-browsing-session", change) : change();
}
export function leaseRetryDelay(attempt: number, retryAfter?: number) {
  return Math.min(
    30000,
    Math.max(
      1000,
      (Number.isFinite(retryAfter) && retryAfter! >= 0
        ? retryAfter!
        : Math.min(30, 2 ** Math.min(attempt, 5))) * 1000,
    ),
  );
}
// Cold starts can wait through a control-plane outage without deleting the
// saved pin or converting a transport timeout into session expiration.
export async function retryBrowsingLeaseOperation<T>(
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    retrying?: (error: LeaseFailure) => void;
  } = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const failure = error as LeaseFailure;
      if (
        TERMINAL_LEASE_CODES.has(failure.code || "") ||
        failure.retryable === false
      )
        throw failure;
      options.retrying?.(failure);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          done,
          leaseRetryDelay(attempt++, failure.retryAfter),
        );
        function done() {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(options.signal!.reason);
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
  }
}
export type LeaseLifecycleOptions<T extends BrowsingLease> = {
  current: () => T | null;
  request: (lease: T, intent: LeaseIntent) => Promise<T>;
  apply: (lease: T, previous: T) => void;
  terminal: (error: LeaseFailure) => void;
  retrying?: (error: LeaseFailure) => void;
  remember?: (lease: T) => void;
  readRemembered?: () => T | null;
  locks?: Pick<LockManager, "request">;
  visible?: () => boolean;
  now?: () => number;
  epoch?: () => unknown;
  schedule?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};
// No location changes or iframe remounts happen here. Only a confirmed server
// revocation is terminal; wall-clock expiry and connectivity loss are not.
export function createBrowsingLeaseLifecycle<T extends BrowsingLease>(
  options: LeaseLifecycleOptions<T>,
) {
  let stopped = false,
    pending: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    attempt = 0,
    authoritativeQueued = false;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const same = (a: BrowsingLease | null, b: BrowsingLease) =>
    a?.session === b.session && a?.generation === b.generation;
  const later = (delay: number) => {
    if (timer) cancel(timer);
    if (!stopped)
      timer = schedule(() => {
        void check();
      }, delay);
  };
  const check = (authoritative = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) {
      // An authentication failure must not be satisfied by a concurrently
      // queued peer-cache refresh. Follow it with one authoritative check.
      if (authoritative) authoritativeQueued = true;
      return pending;
    }
    const original = options.current();
    if (!original?.session) return Promise.resolve();
    if (options.visible && !options.visible()) {
      later(300000);
      return Promise.resolve();
    }
    const started = now();
    const epoch = options.epoch?.();
    const active = () =>
      !stopped &&
      same(options.current(), original) &&
      options.epoch?.() === epoch;
    const work = async () => {
      if (!active()) return;
      let lease: T;
      const peer = options.readRemembered?.();
      const higherGeneration = (
        candidate: BrowsingLease | null | undefined,
        than: BrowsingLease,
      ) =>
        candidate?.session === than.session &&
        Number.isSafeInteger(candidate.generation) &&
        candidate.generation! > (than.generation ?? 0);
      const restoreCurrentGeneration = () =>
        options.request({ ...original, generation: undefined }, "restore");
      if (higherGeneration(peer, original)) {
        // Another frontend window may have restored this same capability after
        // idle expiry. Stored credentials alone do not authorize a generation
        // change: resolve the current assignment through the server again.
        lease = await restoreCurrentGeneration();
      } else if (
        !authoritative &&
        peer &&
        same(peer, original) &&
        (peer.serverTime ?? 0) > (original.serverTime ?? 0) &&
        (peer.expiresLocally ?? 0) > started + 60000
      ) {
        lease = peer;
      } else {
        try {
          lease = await options.request(original, "renew");
        } catch (error) {
          const code = (error as LeaseFailure).code;
          if (code === "SESSION_GENERATION_MISMATCH") {
            // The raw session is the private owner capability. Omitting only
            // the obsolete generation validates its latest assignment; it
            // neither allocates a new session nor revives a revoked one.
            lease = await restoreCurrentGeneration();
          } else if (code === "SESSION_EXPIRED") {
            lease = await options.request(original, "restore");
          } else throw error;
        }
      }
      // Browsers without Web Locks can receive an older response after another
      // window restores the generation. Never overwrite that newer saved state
      // with stale credentials; ask the authoritative server once more.
      if (higherGeneration(options.readRemembered?.(), lease))
        lease = await restoreCurrentGeneration();
      if (
        lease.session !== original.session ||
        (lease.generation ?? 0) < (original.generation ?? 0)
      )
        throw Object.assign(
          Error(
            "The browsing assignment changed unexpectedly. Reconnect to continue.",
          ),
          {
            code: "INVALID_SESSION",
            retryable: false,
          },
        );
      if (!active()) return;
      const normalized = normalizeBrowsingLease(lease, original);
      options.remember?.(normalized);
      options.apply(normalized, original);
      attempt = 0;
      later(300000);
    };
    pending = (
      options.locks
        ? options.locks.request("atlas-browsing-session", work)
        : work()
    )
      .catch((error: LeaseFailure) => {
        if (!active()) return;
        if (
          TERMINAL_LEASE_CODES.has(error.code || "") ||
          error.retryable === false
        ) {
          options.terminal(error);
          stopped = true;
          if (timer) cancel(timer);
          return;
        }
        options.retrying?.(error);
        later(leaseRetryDelay(attempt++, error.retryAfter));
      })
      .finally(() => {
        pending = undefined;
        if (authoritativeQueued && !stopped) {
          authoritativeQueued = false;
          return check(true);
        }
        if (
          !stopped &&
          same(options.current(), original) &&
          options.epoch?.() !== epoch
        )
          later(300000);
      });
    return pending;
  };
  return {
    check,
    start() {
      later(300000);
    },
    stop() {
      stopped = true;
      if (timer) cancel(timer);
    },
  };
}
