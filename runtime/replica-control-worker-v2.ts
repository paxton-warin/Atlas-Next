import { hubSiteGroup } from "./hub-contracts.ts";
import { inspectLegacyLocalPresence } from "./local-legacy-presence-v2.ts";
import {
  establishReplicaCatalog,
  updateReplicaCatalog,
  type ReplicaCatalogEntry,
} from "./replica-catalog-v2.ts";
import {
  copyLegacySiteToV2,
  inspectLegacySite,
  prepareLegacyCookiesToV2,
} from "./local-legacy-migration-v2.ts";
import {
  openProfileCatalog,
  catalogRequest,
  catalogDone,
} from "./profile-idb-catalog.ts";
const PROTOCOL = "atlas-replica-control-v2";
let account: ReplicaCatalogEntry | undefined;
let legacyPresent = false;
async function operation(type: string, args: any) {
  if (type === "initialize") {
    account = await establishReplicaCatalog(
      indexedDB,
      args.profileId,
      undefined,
      args.selection,
    );
    const presence = await inspectLegacyLocalPresence(
      indexedDB,
      account.profileId,
    );
    const legacy = (legacyPresent = presence.present);
    if (account.selection?.startsWith("fresh:") && !account.cloudChecked)
      account = await updateReplicaCatalog(indexedDB, account, {
        cloudChecked: true,
      });
    if (
      legacy &&
      !account.selection &&
      !account.hasLocal &&
      !account.cloudChecked
    )
      account = await updateReplicaCatalog(indexedDB, account, {
        cloudChecked: true,
      });
    return { account, legacy };
  }
  if (!account) throw new Error("LOCAL_ACCOUNT_NOT_INITIALIZED");
  if (type === "publish-restore") {
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
    } finally {
      staging.close();
    }
    account = await updateReplicaCatalog(indexedDB, account, {
      replicaId: args.replicaId,
      incarnation: args.incarnation,
      cloudChecked: true,
      hasLocal: true,
      seedCheckpointId: args.checkpointId,
      deferredPreferences: args.deferredPreferences ?? [],
      legacyOrigins: args.legacyOrigins ?? [],
    });
    return account;
  }
  if (type === "cloud-empty") {
    account = await updateReplicaCatalog(indexedDB, account, {
      cloudChecked: true,
      legacyOrigins: args.legacyOrigins ?? [],
    });
    return account;
  }
  if (type === "prepare-site") {
    let current = account;
    const prepare = async () => {
      const origin = new URL(args.origin).origin,
        catalog = await openProfileCatalog(indexedDB, current.replicaId);
      let marker: any;
      try {
        const tx = catalog.transaction("meta"),
          end = catalogDone(tx);
        marker = await catalogRequest(
          tx.objectStore("meta").get(["local-site-v2", origin]),
        );
        await end;
      } finally {
        catalog.close();
      }
      if (current.selection?.startsWith("fresh:")) {
        const freshCatalog = await openProfileCatalog(
          indexedDB,
          current.replicaId,
        );
        try {
          const tx = freshCatalog.transaction("meta", "readwrite"),
            end = catalogDone(tx);
          tx.objectStore("meta").put({ state: "ready", origin, fresh: true }, [
            "local-site-v2",
            origin,
          ]);
          tx.objectStore("meta").put({ state: "ready", fresh: true }, [
            "local-cookie-profile-v2",
          ]);
          await end;
        } finally {
          freshCatalog.close();
        }
        if (!current.hasLocal)
          account = current = await updateReplicaCatalog(indexedDB, current, {
            hasLocal: true,
          });
        return { mode: "local-v2", origin, cookieLocal: true };
      }
      if (current.legacyOrigins?.includes("*"))
        return {
          mode: "legacy",
          origin,
          cookieLocal: false,
          reason: "legacy_cloud_cookie_profile_conversion_pending",
        };
      const cookies = await prepareLegacyCookiesToV2(
        indexedDB,
        current.profileId,
        current.replicaId,
      );
      if (cookies.state === "deferred")
        return {
          mode: "legacy",
          origin,
          cookieLocal: false,
          reason: cookies.reason,
        };
      const cloudLegacy = current.legacyOrigins?.some(
        (old) => old === "*" || hubSiteGroup(old) === hubSiteGroup(origin),
      );
      if (marker?.state === "ready" && !(marker.checkpointId && cloudLegacy))
        return { mode: "local-v2", origin, cookieLocal: true };
      if (cloudLegacy)
        return {
          mode: "legacy",
          origin,
          reason: "legacy_cloud_checkpoint_conversion_pending",
          cookieLocal: true,
        };
      const inspection = await inspectLegacySite(
        indexedDB,
        current.profileId,
        origin,
        { skipCookies: true },
      );
      if (
        inspection.state === "empty" &&
        legacyPresent &&
        current.legacyOrigins === undefined
      )
        return {
          mode: "legacy",
          origin,
          reason: "legacy_cloud_checkpoint_discovery_pending",
          cookieLocal: true,
        };
      const result =
        inspection.state === "deferred"
          ? inspection
          : await copyLegacySiteToV2(
              indexedDB,
              current.profileId,
              current.replicaId,
              origin,
            );
      if (result.state === "deferred")
        return {
          mode: "legacy",
          origin,
          reason: result.reason,
          cookieLocal: true,
        };
      if (!current.hasLocal)
        account = current = await updateReplicaCatalog(indexedDB, current, {
          hasLocal: true,
        });
      return { mode: "local-v2", origin, cookieLocal: true };
    };
    if (!navigator.locks)
      return {
        mode: "legacy",
        origin: new URL(args.origin).origin,
        reason: "local_migration_coordination_unavailable",
      };
    return navigator.locks.request(
      "atlas-local-migration-v2:" +
        current.replicaId +
        ":" +
        new URL(args.origin).origin,
      prepare,
    );
  }
  throw new TypeError("Unknown local catalog operation");
}
let chain = Promise.resolve();
self.addEventListener("message", (event: MessageEvent) => {
  const m = event.data;
  if (m?.protocol !== PROTOCOL || !Number.isSafeInteger(m.id)) return;
  chain = chain.then(async () => {
    try {
      const value = await operation(m.operation, m.args);
      self.postMessage({ protocol: PROTOCOL, id: m.id, ok: true, value });
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
