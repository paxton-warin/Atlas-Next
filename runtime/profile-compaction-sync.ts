import {
  HUB_LIMITS,
  hubNamespace,
  type HubNamespace,
} from "./hub-contracts.ts";
import type {
  CloudHead,
  ProfileCloud,
  ProfileQueue,
  QueuedProfileChange,
} from "./profile-sync.ts";

export type ProfileCompactionPlan = {
  id: string;
  namespace: HubNamespace;
  head: CloudHead;
  payload: unknown;
};
export type ProfileCloudStreamHead = {
  revision: number;
  snapshotRevision?: number;
  restoreBytes?: number;
  snapshotBytes?: number;
};
export const PROFILE_COMPACTION_JOURNALS = 128;
export const PROFILE_COMPACTION_BYTES = 16 * 1024 * 1024;
export function portableWireBytes(value: unknown): number {
  const v = value as any;
  const bytes =
    v?.codec === "atlas-chunks-v1"
      ? v.bytes
      : new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > HUB_LIMITS.streamBytes
  )
    throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
  return bytes;
}
export function needsProfileCompaction(
  head: ProfileCloudStreamHead,
  incomingBytes: number,
): boolean {
  if (
    head.snapshotRevision === undefined ||
    head.restoreBytes === undefined ||
    head.snapshotBytes === undefined
  )
    return false;
  if (
    ![
      head.revision,
      head.snapshotRevision,
      head.restoreBytes,
      head.snapshotBytes,
      incomingBytes,
    ].every((n) => Number.isSafeInteger(n) && n! >= 0) ||
    head.snapshotRevision > head.revision ||
    head.snapshotBytes > head.restoreBytes ||
    head.restoreBytes > HUB_LIMITS.streamBytes
  )
    throw Error("PROFILE_COMPACTION_METADATA_INVALID");
  const count = head.revision - head.snapshotRevision;
  return (
    count > 0 &&
    (count >= PROFILE_COMPACTION_JOURNALS ||
      head.restoreBytes - head.snapshotBytes >= PROFILE_COMPACTION_BYTES ||
      head.restoreBytes + incomingBytes > HUB_LIMITS.streamBytes)
  );
}
const sha = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
async function expectedHash(plan: ProfileCompactionPlan) {
  return sha(
    JSON.stringify([
      hubNamespace(plan.namespace).key,
      "snapshot",
      plan.head.revision,
      await sha(JSON.stringify(plan.payload)),
    ]),
  );
}
function enabled(queue: ProfileQueue, cloud: ProfileCloud) {
  return !!(
    queue.compaction &&
    queue.prepareCompaction &&
    queue.finishCompaction &&
    cloud.snapshot &&
    cloud.receipt &&
    cloud.encode
  );
}
function checkPlan(plan: ProfileCompactionPlan, namespace: HubNamespace) {
  if (
    !plan ||
    !/^[a-zA-Z0-9-]{16,96}$/.test(plan.id) ||
    hubNamespace(plan.namespace).key !== hubNamespace(namespace).key ||
    !Number.isSafeInteger(plan.head?.revision) ||
    plan.head.revision < 0 ||
    !Number.isSafeInteger(plan.head.epoch) ||
    plan.head.epoch < 1
  )
    throw Error("PROFILE_COMPACTION_PLAN_INVALID");
  portableWireBytes(plan.payload);
}
async function commitPlan(
  change: QueuedProfileChange,
  queue: ProfileQueue,
  cloud: ProfileCloud,
  plan: ProfileCompactionPlan,
  now: () => number,
  resume: boolean,
) {
  checkPlan(plan, {
    kind: change.entry.kind,
    origin: change.entry.origin,
    ...(change.entry.kind === "idb" ? { name: change.entry.name || "" } : {}),
  });
  const receipt = await cloud.receipt!(plan.id);
  if (receipt) {
    if (
      receipt.acknowledged !== true ||
      receipt.mode !== "snapshot" ||
      receipt.revision !== plan.head.revision + 1 ||
      JSON.stringify(receipt.namespace) !== hubNamespace(plan.namespace).key ||
      receipt.payloadHash !== (await expectedHash(plan))
    )
      throw Error("PROFILE_COMPACTION_RECEIPT_INVALID");
    await queue.finishCompaction!(change, plan);
    return;
  }
  const local = await queue.head(change),
    remote = await cloud.stream(plan.namespace);
  if (
    !local ||
    local.revision !== plan.head.revision ||
    local.epoch !== plan.head.epoch ||
    remote.revision !== plan.head.revision
  )
    throw Error("PROFILE_REVISION_CONFLICT");
  const writer = await cloud.writer(plan.namespace);
  if (writer.epoch !== plan.head.epoch)
    throw Error("PROFILE_RECOVERY_REQUIRED");
  if (
    !Number.isFinite(Date.parse(writer.expiresAt)) ||
    Date.parse(writer.expiresAt) <= now()
  )
    throw Error("PROFILE_WRITER_EXPIRED");
  if (resume) {
    // Uncommitted chunk manifests may outlive their staging grace. Re-upload
    // the same immutable cloud reduction; never replace the prepared payload.
    const source = await cloud.snapshot!(plan.namespace, plan.head.revision);
    if (
      source.revision !== plan.head.revision ||
      JSON.stringify(source.encoded ? source.payload : await cloud.encode!(source.payload)) !==
        JSON.stringify(plan.payload)
    )
      throw Error("PROFILE_COMPACTION_SOURCE_CHANGED");
  }
  const result = await cloud.commit({
    namespace: plan.namespace,
    epoch: plan.head.epoch,
    baseRevision: plan.head.revision,
    idempotencyKey: plan.id,
    mode: "snapshot",
    payload: plan.payload,
  });
  if (
    result.acknowledged !== true ||
    result.revision !== plan.head.revision + 1
  )
    throw Error("PROFILE_ACK_INVALID");
  await queue.finishCompaction!(change, plan);
}
export async function resumeProfileCompaction(
  change: QueuedProfileChange,
  queue: ProfileQueue,
  cloud: ProfileCloud,
  now: () => number,
): Promise<void> {
  if (!enabled(queue, cloud)) return;
  const plan = await queue.compaction!(change);
  if (plan) await commitPlan(change, queue, cloud, plan, now, true);
}
export async function maybeCompactProfileStream(
  change: QueuedProfileChange,
  queue: ProfileQueue,
  cloud: ProfileCloud,
  namespace: HubNamespace,
  head: CloudHead | null,
  remote: ProfileCloudStreamHead,
  payload: unknown,
  prepared: CloudHead | null | undefined,
  now: () => number,
): Promise<boolean> {
  if (
    !enabled(queue, cloud) ||
    !head ||
    prepared ||
    !needsProfileCompaction(remote, portableWireBytes(payload))
  )
    return false;
  const source = await cloud.snapshot!(namespace, head.revision);
  if (source.revision !== head.revision)
    throw Error("PROFILE_COMPACTION_SOURCE_CHANGED");
  const wire = source.encoded ? source.payload : await cloud.encode!(source.payload);
  portableWireBytes(wire);
  const plan: ProfileCompactionPlan = {
    id: "compact-" + crypto.randomUUID(),
    namespace,
    head: { ...head },
    payload: wire,
  };
  await queue.prepareCompaction!(change, plan);
  await commitPlan(change, queue, cloud, plan, now, false);
  return true;
}
