/** A prepared recovery is durable BEFORE upload. Retrying a lost response uses
 * exactly the same bytes, even if cookie expirations or local data have changed.
 * Only the trusted shell calls finish after checking the real Hub receipt. */
import { checkedProfile } from "./profile-journal.ts";
import { hubSiteGroup, hubLogicalOrigin, hubNamespace } from "./hub-contracts.ts";
import { exportProfileSnapshots } from "./profile-store.ts";
import { changeNamespace, preserveProfileRecovery, type ProfileQueue, type QueuedProfileChange } from "./profile-sync.ts";
import { packProfileRecovery, type PackedProfileRecovery } from "./profile-recovery-archive.ts";

type PendingRecovery = { id: string; group: string; payload: PackedProfileRecovery; changes: QueuedProfileChange[] };
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || Error("PROFILE_RECOVERY_LOCAL_COMMIT_FAILED")); });
function identity(profileId: string, id: string, origin: string) {
  if (!checkedProfile(profileId) || !/^[a-zA-Z0-9-]{16,128}$/.test(id)) throw Error("PROFILE_RECOVERY_ID_INVALID");
  return hubSiteGroup(hubLogicalOrigin(origin));
}
async function open(factory: IDBFactory, profileId: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open("atlas.profile.recovery.v1:profile:" + profileId, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("branches");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error("PROFILE_RECOVERY_LOCAL_BLOCKED"));
  });
}
async function read(factory: IDBFactory, profileId: string, id: string): Promise<PendingRecovery | undefined> {
  const db = await open(factory, profileId);
  try {
    const tx = db.transaction("branches"), done = complete(tx);
    const value = await request(tx.objectStore("branches").get("pending:" + id));
    await done;
    return value;
  } finally { db.close(); }
}
export async function prepareProfileRecovery(factory: IDBFactory, profileId: string, id: string, origin: string, queue: ProfileQueue): Promise<PendingRecovery | null> {
  const group = identity(profileId, id, origin), prior = await read(factory, profileId, id);
  if (prior) {
    if (prior.id !== id || prior.group !== group) throw Error("PROFILE_RECOVERY_CONTEXT_INVALID");
    return prior;
  }
  // Finalization may have committed just before the worker response or shell
  // marker removal was lost. Reuse that EXACT acknowledged archive, never
  // create different bytes under an already-used remote idempotency key.
  const archiveDB = await open(factory, profileId);
  try {
    const tx = archiveDB.transaction("branches"), done = complete(tx);
    const archived = await request(tx.objectStore("branches").get(id));
    await done;
    if (archived) {
      if (archived.snapshot?.format !== "atlas-recovery-packed-v1" || !Array.isArray(archived.changes) ||
          archived.changes.some((c: QueuedProfileChange) => hubNamespace(changeNamespace(c)).siteGroup !== group))
        throw Error("PROFILE_RECOVERY_CONTEXT_INVALID");
      return { id, group, payload: archived.snapshot, changes: archived.changes };
    }
  } finally { archiveDB.close(); }
  const changes = (await queue.list(group)).filter(c => hubNamespace(changeNamespace(c)).siteGroup === group);
  if (!changes.length) return null;
  const snapshots = await exportProfileSnapshots(factory, profileId, undefined, group);
  const payload = await packProfileRecovery({ snapshots, changes: changes.map(c => c.entry) });
  const prepared: PendingRecovery = { id, group, payload, changes };
  const db = await open(factory, profileId);
  try {
    const tx = db.transaction("branches", "readwrite", { durability: "strict" }), done = complete(tx), store = tx.objectStore("branches");
    const existing = store.get("pending:" + id);
    existing.onsuccess = () => { if (existing.result) tx.abort(); else store.add(prepared, "pending:" + id); };
    await done;
  } finally { db.close(); }
  return prepared;
}
export async function finishProfileRecovery(factory: IDBFactory, profileId: string, id: string, origin: string) {
  const group = identity(profileId, id, origin), prepared = await read(factory, profileId, id);
  if (!prepared) {
    // A crash after archive/retirement but before removing the shell marker is
    // harmless. A missing archive, however, never constitutes success.
    const db = await open(factory, profileId);
    try {
      const tx = db.transaction("branches"), done = complete(tx);
      const archived = await request(tx.objectStore("branches").get(id));
      await done;
      if (!archived || archived.snapshot?.format !== "atlas-recovery-packed-v1" ||
          !Array.isArray(archived.changes) || archived.changes.some((change: QueuedProfileChange) => hubNamespace(changeNamespace(change)).siteGroup !== group))
        throw Error("PROFILE_RECOVERY_NOT_PREPARED");
      return;
    } finally { db.close(); }
  }
  if (prepared.group !== group || prepared.id !== id) throw Error("PROFILE_RECOVERY_CONTEXT_INVALID");
  // This existing primitive writes a self-contained local archive first, then
  // retires only the selected immutable journal IDs. No native save is erased.
  await preserveProfileRecovery(factory, profileId, id, prepared.changes, prepared.payload);
  const db = await open(factory, profileId);
  try {
    const tx = db.transaction("branches", "readwrite", { durability: "strict" }), done = complete(tx);
    tx.objectStore("branches").delete("pending:" + id);
    await done;
  } finally { db.close(); }
}
