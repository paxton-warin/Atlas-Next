/** Native-only catalog coordinator. It never enumerates/imports legacy stores,
 * opens journals/permits, performs cloud I/O, or receives website values. */
import {
  establishReplicaCatalog,
  updateReplicaCatalog,
  nativeActiveSelectionRevision,
  activateNativeReplicaCatalog,
  type ReplicaCatalogEntry,
} from "./replica-catalog-v2.ts";
import {
  openProfileCatalog,
  catalogRequest,
  catalogDone,
} from "./local-idb-catalog.ts";

const PROTOCOL = "atlas-replica-control-v2";
let account: ReplicaCatalogEntry | undefined;
let activationExpectedRevision = 0;
async function operation(type: string, args: any) {
  if (type === "initialize") {
    if (args.nativeOnly !== true)
      throw new TypeError("Native-only local authority required");
    activationExpectedRevision = await nativeActiveSelectionRevision(indexedDB,args.profileId);
    account = await establishReplicaCatalog(
      indexedDB,
      args.profileId,
      undefined,
      args.selection,
    );
    if (account.selection?.startsWith("fresh:") && !account.cloudChecked)
      account = await updateReplicaCatalog(indexedDB, account, {
        cloudChecked: true,
      });
    return { account, legacy: false, nativeOnly: true };
  }
  if (!account) throw new Error("LOCAL_ACCOUNT_NOT_INITIALIZED");
  if (type === "publish-restore") {
    let markerPublicationOrdinal: string | undefined;
    const staging = await openProfileCatalog(indexedDB, args.replicaId);
    try {
      const tx = staging.transaction("meta"),
        end = catalogDone(tx);
      const marker = await catalogRequest(
        tx.objectStore("meta").get("backup-restore-v2"),
      );
      await end;
      if (
        marker?.state !== "ready" ||
        marker.checkpointId !== args.checkpointId ||
        marker.profileId !== account.profileId
      )
        throw new Error("RESTORE_CHECKPOINT_NOT_READY_FOR_ACCOUNT");
      if (/^[0-9]+$/.test(String(marker.publicationOrdinal))) markerPublicationOrdinal = String(marker.publicationOrdinal);
    } finally {
      staging.close();
    }
    account = await updateReplicaCatalog(indexedDB, account, {
      replicaId: args.replicaId,
      incarnation: args.incarnation,
      cloudChecked: true,
      restoreUnavailable: false,
      hasLocal: true,
      seedCheckpointId: args.checkpointId,
      ...(markerPublicationOrdinal ? {seedPublicationOrdinal:markerPublicationOrdinal} : {}),
      deferredPreferences: args.deferredPreferences ?? [],
    });
    if (args.activate === true) await activateNativeReplicaCatalog(indexedDB,activationExpectedRevision,account);
    return account;
  }
  if (type === "cloud-empty") {
    account = await updateReplicaCatalog(indexedDB, account, {
      cloudChecked: true,
      restoreUnavailable: false,
    });
    return account;
  }
  if (type === "cloud-unavailable") {
    account = await updateReplicaCatalog(indexedDB, account, {
      cloudChecked: true,
      restoreUnavailable: true,
    });
    return account;
  }
  if (type === "prepare-site") {
    if (!account.cloudChecked && !account.hasLocal)
      throw new Error("LOCAL_CHECKPOINT_DISCOVERY_NOT_READY");
    const u = new URL(args.origin),
      origin = u.origin;
    if (!/^https?:$/.test(u.protocol) || u.username || u.password)
      throw new TypeError("Invalid local website origin");
    const catalog = await openProfileCatalog(indexedDB, account.replicaId);
    try {
      const tx = catalog.transaction("meta", "readwrite"),
        end = catalogDone(tx),
        store = tx.objectStore("meta");
      // New native namespace readiness is not a claim that any old bytes were
      // imported. Existing completed-checkpoint/native values are not touched.
      store.put({ state: "ready", origin, nativeOnly: true }, [
        "local-site-v2",
        origin,
      ]);
      store.put({ state: "ready", nativeOnly: true }, [
        "local-cookie-profile-v2",
      ]);
      await end;
    } finally {
      catalog.close();
    }
    if (!account.hasLocal)
      account = await updateReplicaCatalog(indexedDB, account, {
        hasLocal: true,
      });
    return { mode: "local-v2", origin, cookieLocal: true, nativeOnly: true };
  }
  throw new TypeError("Unknown native local catalog operation");
}
let chain = Promise.resolve();
self.addEventListener("message", (event: MessageEvent) => {
  const m = event.data;
  if (m?.protocol !== PROTOCOL || !Number.isSafeInteger(m.id)) return;
  chain = chain.then(async () => {
    try {
      self.postMessage({
        protocol: PROTOCOL,
        id: m.id,
        ok: true,
        value: await operation(m.operation, m.args),
      });
    } catch (error) {
      const e = error as Error;
      self.postMessage({
        protocol: PROTOCOL,
        id: m.id,
        ok: false,
        error: { name: e.name, message: e.message },
      });
    }
  });
});
