import { hubNamespace, type HubNamespace } from "../../runtime/hub-contracts.ts";
import type { ProfileImportEntry } from "./profile-import.ts";

const PREFIX = "atlas.profile.legacy-migration.v1:";
type Writer = { epoch: number };
type Manifest = { streams: Array<{ namespace: [string, string, string]; revision?: number }> };
export type LegacyMigrationReceipt = {
  acknowledged: boolean;
  namespace: [string, string, string];
  revision: number;
  payloadHash: string;
  mode: string;
};
export type LegacyMigrationResult = {
  backedUp: number;
  newBackups: number;
  adoptedGroups: string[];
  preservedGroups: string[];
  partialGroups: string[];
};
type Options = {
  ownsLegacy: boolean;
  profileId: string;
  sourceOrigin: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  check(): void;
  entries(): Promise<ProfileImportEntry[]>;
  blockedGroups: Set<string>;
  wire(value: unknown): Promise<unknown>;
  hash(value: string): Promise<string>;
  recover(value: { id: string; namespace: HubNamespace; payload: unknown }): Promise<{ acknowledged: boolean }>;
  manifest(): Promise<Manifest>;
  /** The existing immutable, account-bound commit receipt. Local progress is
   * never sufficient proof that an occupied cloud stream belongs to this import. */
  receipt?(id: string): Promise<LegacyMigrationReceipt>;
  acquire(namespace: HubNamespace): Promise<Writer>;
  commit(value: { namespace: HubNamespace; epoch: number; baseRevision: number; mode: "snapshot"; idempotencyKey: string; payload: unknown }): Promise<{ acknowledged: boolean; revision: number }>;
  release(namespace: HubNamespace, epoch: number): Promise<{ ok: boolean }>;
};
/** Only these existing user-data schemas contain browsing addresses. Do not
 * scrape arbitrary settings/credentials or reinterpret strings inside saves. */
export function legacyWebsiteOriginHints(values: Record<string, string>): string[] {
  const origins = new Set<string>();
  const add = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item.url !== "string") continue;
      try { const url = new URL(item.url); if (/^https?:$/.test(url.protocol) && !url.username && !url.password) origins.add(url.origin); }
      catch { /* Invalid or non-website addresses are not evidence. */ }
    }
  };
  for (const [key, raw] of Object.entries(values)) {
    if (!["atlas.history", "atlas.shortcuts", "atlas.tabs"].includes(key) && !key.startsWith("atlas.windows.v1.")) continue;
    try { const value = JSON.parse(raw); add(key.startsWith("atlas.windows.v1.") ? value?.tabs : value); }
    catch { /* Malformed legacy metadata remains untouched. */ }
  }
  return [...origins];
}
function fromTuple(n: [string, string, string]): HubNamespace {
  return n[0] === "atlas" ? { kind: "atlas" } : {
    kind: n[0] as "local" | "cookies" | "idb",
    origin: n[0] === "cookies" ? "https://" + n[1] : n[1],
    ...(n[0] === "idb" ? { name: n[2] } : {}),
  };
}
function groupStreams(m: Manifest, group: string) {
  return m.streams.filter(s => hubNamespace(fromTuple(s.namespace)).siteGroup === group);
}
function stableUUID(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid migration digest.");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Old physical origins may hold DIFFERENT saves for the same website. Back up
 * every recognized namespace before hydration, then adopt only entirely absent
 * website groups. An existing save, tombstone, busy writer or local outbox wins;
 * neither recency guesses nor per-key/IDB merging can establish a safe winner.
 * Recovery IDs are profile + source + exact payload bound, including lost ACKs.
 */
export async function migrateLegacyOrigin(o: Options): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { backedUp: 0, newBackups: 0, adoptedGroups: [], preservedGroups: [], partialGroups: [] };
  if (!o.ownsLegacy) return result; // Do not even inspect another account's stores.
  o.check();
  const source = new URL(o.sourceOrigin);
  if (!/^https?:$/.test(source.protocol) || source.origin !== o.sourceOrigin || source.username || source.password)
    throw Error("Invalid legacy browser address.");
  const entries = await o.entries();
  o.check();
  const prepared: Array<ProfileImportEntry & { id: string; payloadHash: string }> = [];
  // Finish ALL recovery ACKs before any canonical writer is acquired. A partial
  // publication therefore still has a complete independent downloadable backup.
  for (const entry of entries) {
    const n = hubNamespace(entry.namespace);
    const payload = await o.wire({
      format: "atlas-legacy-origin-recovery-v1",
      sourceOrigin: o.sourceOrigin,
      namespace: entry.namespace,
      snapshot: entry.payload,
    });
    o.check();
    const payloadHash = await o.hash(JSON.stringify(payload));
    const id = stableUUID(await o.hash(JSON.stringify(["atlas-legacy-origin-v1", o.profileId, o.sourceOrigin, n.key, payloadHash])));
    const marker = PREFIX + o.profileId + ":" + o.sourceOrigin + ":" + id;
    let saved: any;
    try { saved = JSON.parse(o.storage.getItem(marker) || "null"); } catch { /* Revalidate through the server, never trust malformed receipts. */ }
    if (saved?.acknowledged !== true || saved.id !== id || saved.payloadHash !== payloadHash) {
      const receipt = await o.recover({ id, namespace: entry.namespace, payload });
      o.check();
      if (receipt.acknowledged !== true) throw Error("The old browser backup has not been acknowledged. Retry before leaving this address.");
      o.storage.setItem(marker, JSON.stringify({ acknowledged: true, id, payloadHash }));
      result.newBackups++;
    }
    result.backedUp++;
    prepared.push({ ...entry, id, payloadHash });
  }
  const groups = new Map<string, typeof prepared>();
  for (const entry of prepared) {
    if (entry.namespace.kind === "atlas") continue; // Metadata is preserved, never merged into existing preferences.
    const group = hubNamespace(entry.namespace).siteGroup;
    groups.set(group, [...(groups.get(group) || []), entry]);
  }
  for (const [group, items] of groups) {
    o.check();
    const progressKey = PREFIX + "group:" + o.profileId + ":" + o.sourceOrigin + ":" + group;
    let progress: any;
    try { progress = JSON.parse(o.storage.getItem(progressKey) || "null"); } catch { /* A bad local marker cannot authorize overwrites. */ }
    // Prepare the canonical wire exactly once. In addition to deterministic
    // idempotency keys, its existing server receipt binds mode/base/hash. A
    // partial import can therefore resume without treating a local marker as
    // ownership or mistaking a peer's revision-one save for our own.
    const signature = await o.hash(JSON.stringify(items.map(i => i.id)));
    const canResume = progress?.phase === "publishing" && progress.signature === signature && progress.count === items.length && !!o.receipt;
    const canonical = new Map<string, { payload: unknown; idempotencyKey: string; receiptHash: string }>();
    const prepare = async () => {
      if (canonical.size) return;
      for (const item of items) {
        const key = hubNamespace(item.namespace).key;
        const payload = await o.wire(item.payload);
        o.check();
        canonical.set(key, {
          payload,
          idempotencyKey: "legacy-origin-" + await o.hash(JSON.stringify([o.profileId, o.sourceOrigin, item.id])),
          receiptHash: await o.hash(JSON.stringify([key, "snapshot", 0, await o.hash(JSON.stringify(payload))])),
        });
        o.check();
      }
    };
    const proveOccupied = async (manifest: Manifest): Promise<Set<string> | null> => {
      const streams = groupStreams(manifest, group), proven = new Set<string>();
      if (!streams.length) return proven;
      if (!canResume) return null;
      await prepare();
      for (const stream of streams) {
        const key = hubNamespace(fromTuple(stream.namespace)).key, planned = canonical.get(key);
        if (!planned || stream.revision !== 1) return null;
        let receipt: LegacyMigrationReceipt;
        try { receipt = await o.receipt!(planned.idempotencyKey); }
        catch (error: any) {
          if (error?.status === 404 || error?.code === "HUB_NOT_FOUND") return null;
          throw error; // A temporary failure is not evidence of a conflict or success.
        }
        o.check();
        if (receipt.acknowledged !== true || receipt.revision !== 1 || receipt.mode !== "snapshot" ||
            JSON.stringify(receipt.namespace) !== key || receipt.payloadHash !== planned.receiptHash)
          return null;
        if (proven.has(key)) return null;
        proven.add(key);
      }
      return proven;
    };
    if (o.blockedGroups.has(group) || await proveOccupied(await o.manifest()) === null) {
      result.preservedGroups.push(group);
      if (progress?.phase === "publishing") result.partialGroups.push(group);
      continue;
    }
    let writer: Writer;
    try { writer = await o.acquire(items[0].namespace); }
    catch (error: any) {
      if (error?.code !== "HUB_WRITER_BUSY") throw error;
      result.preservedGroups.push(group);
      continue; // No forced takeover merely to import old data.
    }
    try {
      o.check();
      // The manifest before acquiring the writer is only a hint. Recheck while
      // holding the actual exclusive group writer, and still commit with CAS0.
      const committed = await proveOccupied(await o.manifest());
      if (committed === null) {
        result.preservedGroups.push(group);
        if (progress?.phase === "publishing") result.partialGroups.push(group);
        continue;
      }
      await prepare();
      o.storage.setItem(progressKey, JSON.stringify({ phase: "publishing", signature, count: items.length }));
      for (const item of items) {
        o.check();
        const key = hubNamespace(item.namespace).key;
        if (committed.has(key)) continue;
        const { payload, idempotencyKey } = canonical.get(key)!;
        const receipt = await o.commit({ namespace: item.namespace, epoch: writer.epoch, baseRevision: 0, mode: "snapshot", idempotencyKey, payload });
        o.check();
        if (receipt.acknowledged !== true || receipt.revision !== 1)
          throw Error("The old browser import has not been acknowledged. Its complete backup is retained in Recovered saves.");
      }
      o.storage.setItem(progressKey, JSON.stringify({ phase: "complete", signature, count: items.length }));
      result.adoptedGroups.push(group);
    } finally {
      // Do not strand a temporary import owner and make the replacement wait a
      // full lease. This exact-epoch release cannot release a peer's new writer.
      const released = await o.release(items[0].namespace, writer.epoch);
      o.check();
      if (released.ok !== true) throw Error("The old browser is still finishing its transfer. Retry before leaving this address.");
    }
  }
  return result;
}
