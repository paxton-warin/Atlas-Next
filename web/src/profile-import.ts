import {
  hubNamespace,
  type HubNamespace,
} from "../../runtime/hub-contracts.ts";
export const LEGACY_PROFILE_OWNER_KEY = "atlas.profile.legacy-owner.v1";
export type ProfileImportEntry = { namespace: HubNamespace; payload: unknown };
/** Claim once for the first signed-in account, even if it already has a cloud
 * profile or cancels import. Neither cancellation nor account switching transfers
 * ownership of this browser's untouched legacy data to another account. */
export function reserveLegacyOwner(
  id: string,
  storage: Pick<Storage, "getItem" | "setItem">,
  exclusive: (run: () => Promise<boolean>) => Promise<boolean>,
) {
  return exclusive(async () => {
    const old = storage.getItem(LEGACY_PROFILE_OWNER_KEY);
    if (old && old !== id) return false;
    storage.setItem(LEGACY_PROFILE_OWNER_KEY, id);
    if (storage.getItem(LEGACY_PROFILE_OWNER_KEY) !== id)
      throw Error("Browser ownership could not be saved.");
    return true;
  });
}
/** Import preparation is cancellable through every asynchronous export/wire/hash
 * boundary. Staged uploads are not published: a cancelled plan commits only the
 * empty Atlas default. The caller removes the visible Cancel control before hash
 * or the irreversible commit request starts. */
export async function runInitialProfileImport(o: {
  ownsLegacy: boolean;
  cancelled: () => boolean;
  exportSnapshots: () => Promise<ProfileImportEntry[]>;
  readUserData: () => Record<string, string>;
  wire: (value: unknown) => Promise<unknown>;
  freeze: () => void;
  manifestHash: (entries: ProfileImportEntry[]) => Promise<string>;
  commit: (
    entries: ProfileImportEntry[],
    hash: string,
  ) => Promise<{ acknowledged: boolean }>;
}) {
  let entries: ProfileImportEntry[] = [],
    nonportable: string[] = [],
    retained = o.ownsLegacy && !o.cancelled();
  let snapshots: ProfileImportEntry[] = [];
  if (retained) {
    try {
      snapshots = await o.exportSnapshots();
    } catch (e) {
      if (!o.cancelled()) throw e;
    }
  }
  if (o.cancelled()) retained = false;
  if (retained)
    for (const item of snapshots) {
      if (o.cancelled()) break;
      try {
        const payload = await o.wire(item.payload);
        if (o.cancelled()) break;
        entries.push({ namespace: item.namespace, payload });
      } catch (e) {
        if (o.cancelled()) break;
        if (
          e instanceof TypeError &&
          /not portable|Unsupported portable|Accessor values/.test(e.message)
        ) {
          nonportable.push(hubNamespace(item.namespace).key);
          continue;
        }
        throw e;
      }
    }
  const defaults = () =>
    o.wire({
      format: "atlas-user-snapshot-v1",
      values: { "atlas.onboarded": "true" },
    });
  if (o.cancelled()) retained = false;
  if (retained) {
    try {
      const payload = await o.wire({
        format: "atlas-user-snapshot-v1",
        values: { ...o.readUserData(), "atlas.onboarded": "true" },
      });
      if (!o.cancelled())
        entries.push({ namespace: { kind: "atlas" }, payload });
      else retained = false;
    } catch (e) {
      if (!o.cancelled()) throw e;
      retained = false;
    }
  }
  if (!retained) {
    entries = [{ namespace: { kind: "atlas" }, payload: await defaults() }];
    nonportable = [];
  }
  // No further visible cancellation promise is made after this synchronous
  // boundary, but an already queued click during hashing is still honored.
  o.freeze();
  let hash = await o.manifestHash(entries);
  if (retained && o.cancelled()) {
    retained = false;
    entries = [{ namespace: { kind: "atlas" }, payload: await defaults() }];
    nonportable = [];
    hash = await o.manifestHash(entries);
  }
  const receipt = await o.commit(entries, hash);
  if (!receipt.acknowledged)
    throw Error("Profile initialization was not acknowledged.");
  return { retained, nonportable };
}
