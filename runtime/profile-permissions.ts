/** Trusted, durable fencing state. Website documents never receive this database
 * or setter. A dead owner may retain offline saves, never a new cloud epoch. */
import { hubSiteGroup } from "./hub-contracts.ts";
export type ProfilePermit = {
  profileId: string;
  group: string;
  contextId: string;
  epoch: number;
  expiresAt: number;
  offline: boolean;
  revoked: boolean;
};
const caches = new WeakMap<IDBFactory, Map<string, ProfilePermit>>();
const key = (id: string, group: string) => id + "\0" + group;
const cache = (f: IDBFactory) => {
  let m = caches.get(f);
  if (!m) caches.set(f, (m = new Map()));
  return m;
};
function open(f: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = f.open("atlas.profile.control.v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("control");
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error("PROFILE_CONTROL_BLOCKED"));
  });
}
export async function setProfilePermit(f: IDBFactory, p: ProfilePermit) {
  if (!p.contextId || !Number.isSafeInteger(p.epoch) || p.epoch < 1)
    throw Error("PROFILE_PERMIT_INVALID");
  const db = await open(f);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("control", "readwrite", {
        durability: "strict",
      });
      tx.objectStore("control").put(p, key(p.profileId, p.group));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    cache(f).set(key(p.profileId, p.group), p);
  } finally {
    db.close();
  }
}
/** Resume only this exact previously fenced local owner. Never overwrite a
 * newer context/epoch's permit while a repair response is in flight. */
export async function resumeProfilePermit(f: IDBFactory, p: ProfilePermit): Promise<boolean> {
  if (!p.contextId || !Number.isSafeInteger(p.epoch) || p.epoch < 1 || p.revoked || p.offline ||
      !Number.isFinite(p.expiresAt) || p.expiresAt <= Date.now()) throw Error("PROFILE_PERMIT_INVALID");
  const db = await open(f);
  try {
    let applied = false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("control", "readwrite", { durability: "strict" }), store = tx.objectStore("control");
      const r = store.get(key(p.profileId, p.group));
      r.onsuccess = () => {
        const old = r.result as ProfilePermit | undefined;
        if (!old || old.contextId !== p.contextId || old.epoch !== p.epoch || !old.revoked) return;
        store.put(p, key(p.profileId, p.group)); applied = true;
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || Error("PROFILE_LOCAL_COMMIT_ABORTED"));
    });
    if (applied) cache(f).set(key(p.profileId, p.group), p);
    return applied;
  } finally { db.close(); }
}
/** Cleanup must not revoke a newer owner's permit published after our CAS. */
export async function revokeProfilePermit(f: IDBFactory, p: Pick<ProfilePermit, "profileId" | "group" | "contextId" | "epoch">): Promise<boolean> {
  if (!p.contextId || !Number.isSafeInteger(p.epoch) || p.epoch < 1) throw Error("PROFILE_PERMIT_INVALID");
  const db = await open(f);
  try {
    let revoked: ProfilePermit | undefined;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("control", "readwrite", { durability: "strict" }), store = tx.objectStore("control");
      const r = store.get(key(p.profileId, p.group));
      r.onsuccess = () => {
        const old = r.result as ProfilePermit | undefined;
        if (!old || old.contextId !== p.contextId || old.epoch !== p.epoch) return;
        revoked = { ...old, expiresAt: 0, offline: false, revoked: true }; store.put(revoked, key(p.profileId, p.group));
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || Error("PROFILE_LOCAL_COMMIT_ABORTED"));
    });
    if (revoked) cache(f).set(key(p.profileId, p.group), revoked);
    return !!revoked;
  } finally { db.close(); }
}
export function invalidateProfilePermits(
  f: IDBFactory,
  profileId: string,
  contextId?: string,
) {
  for (const [k, p] of cache(f))
    if (p.profileId === profileId && (!contextId || p.contextId === contextId))
      cache(f).set(k, { ...p, revoked: true });
}
export function assertProfileWriteCached(
  f: IDBFactory,
  id: string | null | undefined,
  origin: string,
  contextId?: string,
) {
  if (!id) return;
  const p = cache(f).get(key(id, hubSiteGroup(origin)));
  if (
    !p ||
    !contextId ||
    p.contextId !== contextId ||
    p.revoked ||
    (!p.offline && p.expiresAt <= Date.now())
  )
    throw new DOMException(
      "Open this website here to continue saving.",
      "InvalidStateError",
    );
}
export async function assertProfileWrite(
  f: IDBFactory,
  id: string | null | undefined,
  origin: string,
  contextId?: string,
) {
  if (!id) return;
  const db = await open(f);
  try {
    const p = await new Promise<ProfilePermit | undefined>(
      (resolve, reject) => {
        const tx = db.transaction("control"),
          r = tx.objectStore("control").get(key(id, hubSiteGroup(origin)));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      },
    );
    if (p) cache(f).set(key(id, p.group), p);
    else cache(f).delete(key(id, hubSiteGroup(origin)));
    assertProfileWriteCached(f, id, origin, contextId);
  } finally {
    db.close();
  }
}
