// Called only during a fresh application mount, before any website is loaded.
// A live session's expiry/revocation continues to require explicit reconnect.
export async function restoreBrowsingLease<T extends { session: string }>(
  saved: unknown,
  allocate: (session: string) => Promise<T>,
  remember: (session: string) => void,
): Promise<T> {
  const session = typeof saved === "string" && saved.length <= 100 ? saved : "";
  let lease: T;
  try {
    lease = await allocate(session);
  } catch (error) {
    if (!session || (error as { status?: number })?.status !== 409) throw error;
    // One attempt only. Network errors, offline nodes, and rate limits must
    // not silently replace a still-valid pin or cause allocation retry loops.
    lease = await allocate("");
  }
  remember(lease.session);
  return lease;
}

// The lock spans reading storage, allocation and persistence. A second window
// therefore reuses the first window's replacement instead of racing it.
export function restoreBrowsingLeaseOnStartup<T extends { session: string }>(
  readSaved: () => unknown,
  allocate: (session: string) => Promise<T>,
  remember: (session: string) => void,
  locks?: Pick<LockManager, "request">,
): Promise<T> {
  const restore = () => restoreBrowsingLease(readSaved(), allocate, remember);
  // Browsers without Web Locks may allocate independent leases in a race.
  // Keep each active window pinned to its own result; never follow storage
  // changes or revoke a different window's lease when reconnecting.
  return locks ? locks.request("atlas-browsing-session", restore) : restore();
}

export function browsingSessionToRelease(active: unknown, saved: unknown) {
  const session = typeof active === "string" && active ? active : saved;
  return typeof session === "string" && session.length <= 100 ? session : "";
}
