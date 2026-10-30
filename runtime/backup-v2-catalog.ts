import {
  createBackupRestoreReader,
  type BackupRestoreReaderClock,
  type BackupRestoreReaderPin,
} from "./backup-v2-restore-reader.ts";
/** Bounded, immutable checkpoint namespace discovery. Native storage actors do
 * not import this module. Catalog pages are consumed in the backup worker. */
import { hubNamespace } from "./hub-contracts.ts";
import type { BackupNamespaceVersion } from "./backup-v2-contracts.ts";

export const BACKUP_CATALOG_LIMITS = Object.freeze({
  namespaces: 1024,
  pageItems: 32,
  pageBytes: 65536,
  cursorBytes: 2048,
});
export type BackupCatalogTransport = {
  request<T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  subscribeActivity?: (listener: (path: string) => void) => () => void;
  subscribeResponseHeaders?: (
    listener: (headers: {
      path: string;
      status: number;
      restoreReader: string | null;
    }) => void,
  ) => () => void;
};
export type BackupCheckpointHeader = {
  checkpointId: string;
  publicationOrdinal?: number | string;
  namespaces?: BackupNamespaceVersion[];
  [field: string]: unknown;
};
export type BackupCatalogDescriptor = {
  format: "atlas-paged-catalog-v1";
  namespaceCount: number;
  rootDigest: string;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const invalid = (message = "The completed backup catalog was invalid.") =>
  Object.assign(new Error(message), { code: "BACKUP_CATALOG_INVALID" });
function checkedNamespace(value: unknown): BackupNamespaceVersion {
  const n = value as BackupNamespaceVersion;
  if (
    !n ||
    !UUID.test(n.namespaceVersionId) ||
    !["baseline", "delta", "deleted"].includes(n.kind) ||
    !Number.isSafeInteger(n.localCut) ||
    n.localCut < 0 ||
    !DIGEST.test(n.rootDigest) ||
    !Array.isArray(n.parts) ||
    n.parts.length > 32 ||
    n.coverage !== "complete-at-cut"
  )
    throw invalid();
  hubNamespace(n.namespace);
  return n;
}
export async function openBackupNamespaceCatalog(
  transport: BackupCatalogTransport,
  checkpointId: string,
  signal?: AbortSignal,
  restoreId: string = crypto.randomUUID(),
  options?: {
    readerLost(error: Error): void;
    readerStarted?(leaseId: string): void;
    readerClock?: BackupRestoreReaderClock;
  },
): Promise<{
  checkpoint: BackupCheckpointHeader;
  catalog?: BackupCatalogDescriptor;
  readerPin?: BackupRestoreReaderPin;
  reader?: ReturnType<typeof createBackupRestoreReader>;
  namespaces: AsyncIterable<BackupNamespaceVersion>;
}> {
  if (!UUID.test(checkpointId) || !UUID.test(restoreId)) throw invalid();
  const observedAt = options?.readerClock?.now() ?? performance.now(),
    path =
      "/checkpoints/" + checkpointId + "?catalog=paged&restoreId=" + restoreId;
  let reader: ReturnType<typeof createBackupRestoreReader> | undefined,
    headerProtected = false;
  const removeHeaders = options
    ? transport.subscribeResponseHeaders?.((headers) => {
        if (
          headers.path !== path ||
          headers.status !== 200 ||
          headers.restoreReader !== "v1" ||
          reader
        )
          return;
        headerProtected = true;
        reader = createBackupRestoreReader({
          transport,
          checkpointId,
          pin: {
            version: 1,
            leaseId: restoreId,
            ttlMs: 120000,
            renewAfterMs: 30000,
            observedAt,
          },
          signal,
          lost: options.readerLost,
          clock: options.readerClock,
        });
        options.readerStarted?.(restoreId);
      })
    : undefined;
  try {
    const response = await transport.request<{
      checkpoint: BackupCheckpointHeader;
      catalog?: BackupCatalogDescriptor;
      restoreReaderPin?: {
        version: 1;
        leaseId: string;
        ttlMs: number;
        renewAfterMs: number;
      };
    }>(path, undefined, undefined, signal);
    const checkpoint = response?.checkpoint,
      catalog = response?.catalog;
    const rawPin = response?.restoreReaderPin;
    if (
      rawPin !== undefined &&
      (!rawPin ||
        typeof rawPin !== "object" ||
        rawPin.version !== 1 ||
        typeof rawPin.leaseId !== "string" ||
        !UUID.test(rawPin.leaseId) ||
        rawPin.leaseId !== restoreId ||
        rawPin.ttlMs !== 120000 ||
        rawPin.renewAfterMs !== 30000)
    )
      throw invalid("The restore protection metadata was invalid.");
    if (headerProtected && !rawPin)
      throw invalid(
        "The restore protection header did not match its metadata.",
      );
    const readerPin = rawPin ? { ...rawPin, observedAt } : undefined;
    if (!checkpoint || checkpoint.checkpointId !== checkpointId)
      throw invalid();
    if (catalog) {
      if (
        catalog.format !== "atlas-paged-catalog-v1" ||
        !DIGEST.test(catalog.rootDigest) ||
        !Number.isSafeInteger(catalog.namespaceCount) ||
        catalog.namespaceCount < 0 ||
        catalog.namespaceCount > BACKUP_CATALOG_LIMITS.namespaces ||
        checkpoint.namespaces !== undefined
      )
        throw invalid();
    } else if (
      !Array.isArray(checkpoint.namespaces) ||
      checkpoint.namespaces.length > 64
    )
      throw invalid();
    async function* namespaces(): AsyncGenerator<BackupNamespaceVersion> {
      const seen = new Set<string>();
      function accept(raw: unknown) {
        const n = checkedNamespace(raw),
          key = hubNamespace(n.namespace).key;
        if (seen.has(key))
          throw invalid("The completed backup repeated a namespace.");
        seen.add(key);
        return n;
      }
      if (!catalog) {
        for (const n of checkpoint.namespaces!) {
          if (signal?.aborted) throw signal.reason;
          yield accept(n);
        }
        return;
      }
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (signal?.aborted) throw signal.reason;
        if (++pages > BACKUP_CATALOG_LIMITS.namespaces + 1)
          throw invalid("The backup catalog did not finish.");
        const page = await transport.request<{
          checkpointId: string;
          rootDigest: string;
          namespaces: BackupNamespaceVersion[];
          nextCursor?: string | null;
        }>(
          "/checkpoints/" +
            checkpointId +
            "/namespaces" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
          undefined,
          undefined,
          signal,
        );
        if (
          !page ||
          page.checkpointId !== checkpointId ||
          page.rootDigest !== catalog.rootDigest ||
          !Array.isArray(page.namespaces) ||
          page.namespaces.length > BACKUP_CATALOG_LIMITS.pageItems ||
          new TextEncoder().encode(JSON.stringify(page)).byteLength >
            BACKUP_CATALOG_LIMITS.pageBytes
        )
          throw invalid();
        for (const n of page.namespaces) {
          if (signal?.aborted) throw signal.reason;
          if (seen.size >= catalog.namespaceCount)
            throw invalid("The backup catalog exceeded its declared count.");
          yield accept(n);
        }
        if (page.nextCursor != null && page.nextCursor !== "") {
          if (
            typeof page.nextCursor !== "string" ||
            !/^[A-Za-z0-9_.-]+$/.test(page.nextCursor) ||
            page.nextCursor.length > BACKUP_CATALOG_LIMITS.cursorBytes ||
            cursors.has(page.nextCursor) ||
            !page.namespaces.length
          )
            throw invalid();
          cursor = page.nextCursor;
          cursors.add(cursor);
        } else cursor = undefined;
      } while (cursor);
      if (seen.size !== catalog.namespaceCount)
        throw invalid("The completed backup catalog was incomplete.");
    }
    return { checkpoint, catalog, readerPin, reader, namespaces: namespaces() };
  } catch (error) {
    reader?.close();
    throw error;
  } finally {
    removeHeaders?.();
  }
}
