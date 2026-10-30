/** Coordinate cloud heads/native publication by website, not by account.
 * Keep the historical account lock shared so an older open shell's exclusive
 * operations cannot race this version. No timeout steals a running operation.
 */
export type ProfileLockManager = Pick<LockManager, "request">;
export function withProfileGroupLock<T>(
  profileId: string,
  siteGroup: string,
  run: () => Promise<T>,
  locks: ProfileLockManager = globalThis.navigator?.locks,
): Promise<T> {
  if (!locks?.request) return Promise.reject(Error("Profile coordination is unavailable."));
  if (!profileId || !siteGroup) return Promise.reject(Error("Invalid profile lock scope."));
  return locks.request("atlas-profile-drain:" + profileId, { mode: "shared" }, () =>
    locks.request("atlas-profile-group:" + JSON.stringify([profileId, siteGroup]),
      { mode: "exclusive" }, run),
  );
}
