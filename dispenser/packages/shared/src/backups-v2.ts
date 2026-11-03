/** Versioned, bounded backup transport. Never grants local storage authority. */
import type { HubNamespace } from "./hub.js";
export const BACKUP_V2 = Object.freeze({
  version: 2,
  format: "atlas-checkpoint-v2",
  intervalMs: 60_000,
  partBytes: 256 * 1024,
  cycleBytes: 8 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  recordBytes: 1024 * 1024,
  recordNodes: 4096,
  maxParts: 32,
  maxNamespaces: 64,
  maxChangedNamespaces: 64,
  maxCatalogNamespaces: 1024,
  catalogPageItems: 32,
  catalogPageBytes: 64 * 1024,
  maxRecords: 8192,
  maxRecordFragments: 8,
  pageItems: 20,
  stagingHours: 24,
  dailyPoints: 7,
  maximumChain: 16,
  rollupAfter: 8,
});
export type BackupV2ErrorCode =
  | "BACKUP_SEED_GONE"
  | "BACKUP_UPGRADE_REQUIRED"
  | "BACKUP_CATALOG_FULL"
  | "BACKUP_INVALID"
  | "BACKUP_CONFLICT"
  | "BACKUP_NOT_FOUND"
  | "BACKUP_BUSY"
  | "BACKUP_QUOTA_EXCEEDED"
  | "BACKUP_INCOMPLETE"
  | "BACKUP_REPLICA_DELETED";
export type BackupPartV2 = { ordinal: number; sha256: string; bytes: number };
export type BackupNamespaceVersionV2 = {
  namespace: HubNamespace;
  namespaceVersionId: string;
  parentNamespaceVersionId: string | null;
  localCut: number;
  schemaEpoch: string | number;
  kind: "baseline" | "delta" | "deleted";
  rootDigest: string;
  parts: BackupPartV2[];
  coverage: "complete-at-cut";
};
export type BackupCheckpointV2 = {
  format: "atlas-checkpoint-v2";
  checkpointId: string;
  replicaId: string;
  incarnation: string;
  sequence: number;
  parentCheckpointId: string | null;
  manifestDigest: string;
  adoptedThrough: number;
  namespaces: BackupNamespaceVersionV2[];
};
export type BackupRecordFragmentV2 = {
  recordId: string;
  index: number;
  count: number;
  totalBytes: number;
  sha256: string;
  data: string;
};
export type BackupRecordPageV2 = {
  format: "atlas-record-page-v2";
  namespaceVersionId: string;
  records: BackupRecordFragmentV2[];
};
export type BackupPublishReceiptV2 = {
  acknowledged: true;
  checkpointId: string;
  replicaId: string;
  sequence: number;
  manifestDigest: string;
  publicationOrdinal: string;
  completedAt: string;
  coverage: Array<{ namespaceVersionId: string; localCut: number }>;
  historyShortened: boolean;
};
/** Object property order is not a publication identity. Arrays retain order. */
export function canonicalBackupJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalBackupJson).join(",") + "]";
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid backup manifest value");
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ":" +
          canonicalBackupJson((value as Record<string, unknown>)[key]),
      )
      .join(",") +
    "}"
  );
}
export function backupManifestIdentity(value: BackupCheckpointV2): string {
  const { manifestDigest: _digest, ...identity } = value;
  return canonicalBackupJson(identity);
}
