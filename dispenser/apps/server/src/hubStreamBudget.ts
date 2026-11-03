/** Exact portable wire restore budget. It does not alter data or fold native
 * IndexedDB semantics; old snapshots/journals are authenticated before backfill. */
import type { PoolClient } from "pg";
import { HUB_LIMITS } from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import { decrypt } from "./security.js";
export function streamRestoreBytes(encoded: string): number {
  let value: any;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new AppError(
      "HUB_INVALID",
      "The stored backup could not be verified.",
      503,
    );
  }
  if (value?.codec === "atlas-chunks-v1") {
    if (
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > HUB_LIMITS.streamBytes
    )
      throw new AppError(
        "HUB_INVALID",
        "The stored backup size could not be verified.",
        503,
      );
    return value.bytes;
  }
  return Buffer.byteLength(encoded);
}
export async function initializeStreamBudgets(
  c: PoolClient,
  profileId: string,
  key: string,
) {
  const streams = (
    await c.query(
      "SELECT namespace,snapshot_revision,encrypted_payload FROM hub_streams WHERE profile_id=$1 AND restore_bytes IS NULL",
      [profileId],
    )
  ).rows;
  for (const stream of streams) {
    let bytes = stream.encrypted_payload
      ? streamRestoreBytes(decrypt(stream.encrypted_payload, key))
      : 0;
    const journals = (
      await c.query(
        "SELECT encrypted_payload FROM hub_commits WHERE profile_id=$1 AND namespace=$2 AND revision>$3 AND encrypted_payload IS NOT NULL ORDER BY revision",
        [profileId, stream.namespace, stream.snapshot_revision],
      )
    ).rows;
    for (const journal of journals)
      bytes += streamRestoreBytes(decrypt(journal.encrypted_payload, key));
    if (!Number.isSafeInteger(bytes))
      throw new AppError(
        "HUB_INVALID",
        "The stored backup size could not be verified.",
        503,
      );
    await c.query(
      "UPDATE hub_streams SET restore_bytes=$3 WHERE profile_id=$1 AND namespace=$2",
      [profileId, stream.namespace, bytes],
    );
  }
}
