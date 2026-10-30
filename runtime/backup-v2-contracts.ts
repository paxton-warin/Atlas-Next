/** Backup protocol types only; native storage must not depend on these types at runtime. */
import type { HubNamespace } from "./hub-contracts.ts";
export type BackupNamespace = HubNamespace;
export type BackupPart = { ordinal: number; sha256: string; bytes: number };
export type BackupNamespaceVersion = {
  namespaceVersionId: string;
  parentNamespaceVersionId: string | null;
  namespace: BackupNamespace;
  localCut: number;
  schemaEpoch: number;
  kind: "baseline" | "delta" | "deleted";
  rootDigest: string;
  parts: BackupPart[];
  coverage: "complete-at-cut";
};
export type BackupManifest = {
  format: "atlas-checkpoint-v2";
  checkpointId: string;
  replicaId: string;
  incarnation: string;
  sequence: number;
  parentCheckpointId: string | null;
  manifestDigest: string;
  adoptedThrough: number;
  namespaces: BackupNamespaceVersion[];
};
export type BackupPublishReceipt = {
  acknowledged: true;
  checkpointId: string;
  manifestDigest: string;
  sequence: number;
  publicationOrdinal: number | string;
  completedAt: string;
  coverage: Array<{ namespaceVersionId: string; localCut: number }>;
  replicaId: string;
  historyShortened: boolean;
};
export type BackupPartEnvelope = {
  format: "atlas-record-page-v2";
  namespaceVersionId: string;
  records: Array<{
    recordId: string;
    index: number;
    count: number;
    totalBytes: number;
    sha256: string;
    data: string;
  }>;
};
export const BACKUP_V2_LIMITS = Object.freeze({
  partBytes: 256 * 1024,
  fragmentBytes: 180 * 1024,
  nativeRecordBytes: 256 * 1024,
  encodedRecordBytes: 1024 * 1024,
  recordNodes: 4096,
  cycleBytes: 8 * 1024 * 1024,
  pageRecords: 64,
  pageBytes: 256 * 1024,
  prepareMs: 30000,
  catchupPasses: 3,
  intervalMs: 60000,
  quietMs: 500,
});
export function canonicalBackupJSON(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "number" && !Number.isFinite(v))
        throw Error("BACKUP_MANIFEST_INVALID");
      if (["undefined", "function", "symbol", "bigint"].includes(typeof v))
        throw Error("BACKUP_MANIFEST_INVALID");
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null)
      throw Error("BACKUP_MANIFEST_INVALID");
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(v).sort())
      out[key] = visit((v as Record<string, unknown>)[key]);
    return out;
  };
  return JSON.stringify(visit(value));
}
export async function backupSHA256(
  bytes: Uint8Array | string,
): Promise<string> {
  const input =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function backupManifestDigest(
  manifest: Omit<BackupManifest, "manifestDigest"> | BackupManifest,
): Promise<string> {
  const { manifestDigest: _digest, ...rest } = manifest as BackupManifest;
  return backupSHA256(canonicalBackupJSON(rest));
}
export function backupDeferred(code: string, message: string) {
  return Object.assign(new Error(message), {
    name: "AbortError",
    code,
    backupDeferred: true,
  });
}
