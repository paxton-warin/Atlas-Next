import { createBackupRestoreReader } from "./backup-v2-restore-reader.ts";
/** Completed-checkpoint restore into an unpublished, physically separate
 * replica. One bounded encoded record and its decoded value are live at once.
 * This module never changes the current replica pointer. */
import {
  atlasBackupDatabase,
  ATLAS_BACKUP_NAMESPACE,
} from "./backup-v2-preferences.ts";
import {
  backupSHA256,
  BACKUP_V2_LIMITS,
  canonicalBackupJSON,
  type BackupNamespaceVersion,
} from "./backup-v2-contracts.ts";
import { decodeBackupKey } from "./backup-v2-keys.ts";
import {
  decodePortableValue,
  hubNamespace,
  type PortableGraph,
} from "./hub-contracts.ts";
import {
  preflightBackupRecord,
  type BackupEncodedRecord,
} from "./backup-v2-capture.ts";
import {
  profileDatabaseName,
  profileIDBPrefix,
  PROFILE_IDB_KEEP,
  checkedProfile,
} from "./profile-journal.ts";
import { profileCatalogName } from "./profile-idb-catalog.ts";
import { createLocalStorageV2Stores } from "./local-storage-v2.ts";
import {
  emptyLocalDirtyControl,
  localDirtyControlKey,
  localDirtySizeKey,
} from "./local-dirty-v2.ts";
import { localIDBRecordUsage } from "./local-idb-accounting.ts";
import { boundedIDBValueBytes, SANDBOX_IDB_LIMITS } from "./sandbox-idb.ts";
import type { BackupNativeSourceDescriptor } from "./backup-v2-indexeddb-source.ts";
import { openBackupNamespaceCatalog } from "./backup-v2-catalog.ts";
export type BackupRestoreTransport = {
  request<T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  download(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  subscribeActivity?: (listener: (path: string) => void) => () => void;
  subscribeResponseHeaders?: (
    listener: (headers: {
      path: string;
      status: number;
      restoreReader: string | null;
    }) => void,
  ) => () => void;
};
type Schema = {
  format: "atlas-local-schema-v2";
  kind: "idb" | "cookies" | "local" | "atlas";
  version: number;
  stores: Array<{
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    generator: null | { next: number } | { exhausted: true };
    indexes: Array<{
      name: string;
      keyPath: string | string[];
      unique: boolean;
      multiEntry: boolean;
    }>;
  }>;
};
type RecordMeta = {
  recordId: string;
  store: string;
  operation: string;
  totalBytes: number;
  sha256: string;
  fragments: Array<{ sha256: string; index: number }>;
};
export type BackupRestoreProgress = {
  phase:
    | "discovering"
    | "planning"
    | "restoring"
    | "finalizing"
    | "ready"
    | "error";
  completedBytes: number;
  totalBytes?: number;
  completedRecords: number;
  totalRecords?: number;
  downloadedBytes: number;
  namespaces: number;
  totalNamespaces?: number;
  elapsedMs: number;
  readerPinned?: true;
  readerLeaseId?: string;
};
export type StagedBackupRestore = {
  publicationOrdinal?: string;
  readerPinned?: true;
  readerLeaseId?: string;
  stagingReplicaId: string;
  checkpointId: string;
  descriptors: BackupNativeSourceDescriptor[];
  origins: string[];
  atlasPreferences: Record<string, string>;
  deferredPreferences: string[];
};
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const complete = (t: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = () => rej(t.error || Error("BACKUP_RESTORE_TX_ABORTED"));
    t.onerror = () => {};
  });
async function create(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, t: IDBTransaction) => void,
) {
  const r = factory.open(name, version);
  r.onupgradeneeded = () => upgrade(r.result, r.transaction!);
  const db = await request(r);
  db.onversionchange = () => db.close();
  return db;
}
function inlineKey(value: unknown, keyPath: string, key: IDBValidKey) {
  let at = value as Record<string, any>;
  for (const part of keyPath.split(".").slice(0, -1)) {
    if (!Object.hasOwn(at, part))
      Object.defineProperty(at, part, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    at = at[part];
  }
  Object.defineProperty(at, keyPath.split(".").at(-1)!, {
    value: key,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}
export async function prepareBackupV2Restore(options: {
  factory: IDBFactory;
  transport: BackupRestoreTransport;
  checkpointId: string;
  stagingReplicaId?: string;
  profileId?: string;
  signal?: AbortSignal;
  onProgress?: (
    namespace: string,
    records: number,
    progress: BackupRestoreProgress,
  ) => void;
}): Promise<StagedBackupRestore> {
  const { factory, transport } = options;
  const readerAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, readerAbort.signal])
    : readerAbort.signal;
  const stagingReplicaId = options.stagingReplicaId ?? crypto.randomUUID();
  checkedProfile(stagingReplicaId);
  const existing = new Set((await factory.databases()).map((d) => d.name));
  if (
    existing.has(profileCatalogName(stagingReplicaId)) ||
    [...existing].some((name) => name?.includes(":profile:" + stagingReplicaId))
  )
    throw Error("BACKUP_RESTORE_DESTINATION_EXISTS");
  const namespaceCatalog = await openBackupNamespaceCatalog(
      transport,
      options.checkpointId,
      signal,
      crypto.randomUUID(),
      {
        readerLost: (error) => readerAbort.abort(error),
        readerStarted: (leaseId) =>
          options.onProgress?.("metadata", 0, {
            phase: "planning",
            completedBytes: 0,
            completedRecords: 0,
            downloadedBytes: 0,
            namespaces: 0,
            elapsedMs: 0,
            readerPinned: true,
            readerLeaseId: leaseId,
          }),
      },
    ),
    checkpoint = namespaceCatalog.checkpoint;
  const reader =
    namespaceCatalog.reader ??
    createBackupRestoreReader({
      transport,
      checkpointId: options.checkpointId,
      pin: namespaceCatalog.readerPin,
      signal: options.signal,
      lost: (error) => readerAbort.abort(error),
    });
  let catalog: IDBDatabase;
  try {
    catalog = await create(
      factory,
      profileCatalogName(stagingReplicaId),
      1,
      (db) => {
        db.createObjectStore("meta");
        // Bounded disk spool; no profile-sized decoded value list in memory.
        db.createObjectStore("restore-records");
        db.createObjectStore("restore-parts");
      },
    );
  } catch (error) {
    reader.close();
    throw error;
  }
  const descriptors: BackupNativeSourceDescriptor[] = [],
    origins = new Set<string>(),
    atlasPreferences: Record<string, string> = {},
    deferredPreferences: string[] = [];
  let preferenceBytes = 0,
    recordsCompleted = 0,
    completedRecords = 0,
    completedBytes = 0,
    totalRecords = 0,
    totalBytes = 0,
    downloadedBytes = 0,
    namespaces = 0;
  const started = performance.now(),
    planned: BackupNamespaceVersion[] = [];
  let lastProgress = -Infinity;
  const progress = (
    phase: BackupRestoreProgress["phase"],
    namespace = "",
    force = false,
  ) => {
    reader.activity();
    const now = performance.now();
    if (!force && now - lastProgress < 100) return;
    lastProgress = now;
    options.onProgress?.(namespace, recordsCompleted, {
      phase,
      completedBytes,
      completedRecords,
      downloadedBytes,
      namespaces,
      ...(phase === "planning"
        ? {}
        : { totalBytes, totalRecords, totalNamespaces: planned.length }),
      elapsedMs: now - started,
      ...(namespaceCatalog.readerPin
        ? {
            readerPinned: true as const,
            readerLeaseId: namespaceCatalog.readerPin.leaseId,
          }
        : {}),
    });
  };
  // Two decoded part envelopes at most. Other verified raw parts live only in
  // the unpublished staging catalog, so each network part is fetched once.
  const decodedParts = new Map<string, any>();
  async function partPage(hash: string) {
    if (decodedParts.has(hash)) {
      const page = decodedParts.get(hash);
      decodedParts.delete(hash);
      decodedParts.set(hash, page);
      return page;
    }
    let tx = catalog.transaction("restore-parts"),
      done = complete(tx);
    let encoded = (await request(tx.objectStore("restore-parts").get(hash))) as
      | Uint8Array
      | undefined;
    await done;
    if (!encoded) {
      encoded = await transport.download("/parts/" + hash, signal);
      check();
      if (
        encoded.byteLength > BACKUP_V2_LIMITS.partBytes ||
        (await backupSHA256(encoded)) !== hash
      )
        throw Error("BACKUP_RESTORE_PART_DIGEST");
      tx = catalog.transaction("restore-parts", "readwrite");
      done = complete(tx);
      tx.objectStore("restore-parts").add(encoded, hash);
      await done;
      downloadedBytes += encoded.byteLength;
      progress("restoring");
    } else if ((await backupSHA256(encoded)) !== hash)
      throw Error("BACKUP_RESTORE_PART_DIGEST");
    const page = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(encoded),
    );
    if (page?.format !== "atlas-record-page-v2" || !Array.isArray(page.records))
      throw Error("BACKUP_RESTORE_PART_INVALID");
    decodedParts.set(hash, page);
    if (decodedParts.size > 2)
      decodedParts.delete(decodedParts.keys().next().value!);
    return page;
  }
  const check = () => {
    if (signal?.aborted) throw signal.reason;
  };
  async function record(
    meta: RecordMeta,
    namespace: BackupNamespaceVersion,
  ): Promise<BackupEncodedRecord> {
    check();
    if (
      !/^[a-f0-9]{64}$/.test(meta.recordId) ||
      !Number.isSafeInteger(meta.totalBytes) ||
      meta.totalBytes < 1 ||
      meta.totalBytes > BACKUP_V2_LIMITS.encodedRecordBytes ||
      !Array.isArray(meta.fragments) ||
      meta.fragments.length < 1 ||
      meta.fragments.length > 8
    )
      throw Error("BACKUP_RESTORE_RECORD_INVALID");
    const bytes = new Uint8Array(meta.totalBytes);
    let offset = 0;
    for (let index = 0; index < meta.fragments.length; index++) {
      const part = meta.fragments[index];
      if (
        !/^[a-f0-9]{64}$/.test(part.sha256) ||
        !Number.isSafeInteger(part.index) ||
        part.index < 0
      )
        throw Error("BACKUP_RESTORE_FRAGMENT_INVALID");
      const page = await partPage(part.sha256),
        fragment = page?.records?.[part.index];
      if (
        page?.format !== "atlas-record-page-v2" ||
        !fragment ||
        fragment.recordId !== meta.recordId ||
        fragment.index !== index ||
        fragment.count !== meta.fragments.length ||
        fragment.totalBytes !== meta.totalBytes ||
        fragment.sha256 !== meta.sha256 ||
        typeof fragment.data !== "string"
      )
        throw Error("BACKUP_RESTORE_FRAGMENT_IDENTITY");
      const raw = atob(fragment.data);
      if (btoa(raw) !== fragment.data || offset + raw.length > bytes.byteLength)
        throw Error("BACKUP_RESTORE_FRAGMENT_LENGTH");
      for (let j = 0; j < raw.length; j++) bytes[offset++] = raw.charCodeAt(j);
    }
    if (
      offset !== bytes.byteLength ||
      (await backupSHA256(bytes)) !== meta.sha256
    )
      throw Error("BACKUP_RESTORE_RECORD_DIGEST");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as BackupEncodedRecord;
    if (
      !value ||
      !["put", "schema"].includes(value.operation) ||
      value.operation !== meta.operation ||
      value.store !== meta.store ||
      !Number.isSafeInteger(value.generation) ||
      value.generation > namespace.localCut
    )
      throw Error("BACKUP_RESTORE_RECORD_INVALID");
    const identity = await backupSHA256(
      canonicalBackupJSON({
        namespace: namespace.namespace,
        store: value.store,
        key: value.key || null,
        operationKey: value.operation === "schema" ? "schema" : "record",
      }),
    );
    if (identity !== meta.recordId)
      throw Error("BACKUP_RESTORE_RECORD_IDENTITY");
    if (
      !value.value ||
      !Array.isArray(value.value.nodes) ||
      value.value.nodes.length > BACKUP_V2_LIMITS.recordNodes
    )
      throw Error("BACKUP_RESTORE_GRAPH_INVALID");
    return value;
  }
  async function planMetadata(namespace: BackupNamespaceVersion) {
    let cursor: string | undefined,
      pages = 0;
    const visited = new Set<string>();
    do {
      check();
      if (++pages > 10000) throw Error("BACKUP_RESTORE_PAGE_LIMIT");
      const page = await transport.request<{
        records: RecordMeta[];
        nextCursor?: string;
      }>(
        "/namespace-versions/" +
          namespace.namespaceVersionId +
          "/records" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        undefined,
        undefined,
        signal,
      );
      if (!Array.isArray(page.records) || page.records.length > 64)
        throw Error("BACKUP_RESTORE_PAGE_INVALID");
      progress("planning", "metadata:" + namespace.namespaceVersionId, true);
      const tx = catalog.transaction("restore-records", "readwrite"),
        done = complete(tx);
      for (const meta of page.records) {
        if (
          !/^[a-f0-9]{64}$/.test(meta.recordId) ||
          !Number.isSafeInteger(meta.totalBytes) ||
          meta.totalBytes < 1 ||
          meta.totalBytes > BACKUP_V2_LIMITS.encodedRecordBytes ||
          !["put", "schema"].includes(meta.operation) ||
          !Array.isArray(meta.fragments) ||
          !meta.fragments.length ||
          meta.fragments.length > 8
        ) {
          tx.abort();
          await done.catch(() => {});
          throw Error("BACKUP_RESTORE_RECORD_INVALID");
        }
        tx.objectStore("restore-records").add(meta, [
          namespace.namespaceVersionId,
          meta.recordId,
        ]);
      }
      await done;
      for (const meta of page.records) {
        totalRecords++;
        totalBytes += meta.totalBytes;
      }
      progress("planning", "metadata:" + namespace.namespaceVersionId, true);
      cursor = page.nextCursor;
      if (cursor) {
        if (visited.has(cursor)) throw Error("BACKUP_RESTORE_CURSOR_LOOP");
        visited.add(cursor);
      }
    } while (cursor);
  }
  async function* stagedMetadata(namespace: BackupNamespaceVersion) {
    let after: string | undefined;
    while (true) {
      check();
      const range = IDBKeyRange.bound(
        after
          ? [namespace.namespaceVersionId, after]
          : [namespace.namespaceVersionId],
        [namespace.namespaceVersionId, []],
        !!after,
        false,
      );
      const tx = catalog.transaction("restore-records"),
        done = complete(tx);
      const rows = (await request(
        tx.objectStore("restore-records").getAll(range, 64),
      )) as RecordMeta[];
      await done;
      if (!rows.length) return;
      for (const row of rows) yield row;
      after = rows.at(-1)!.recordId;
    }
  }
  function accepted(meta: RecordMeta) {
    completedRecords++;
    completedBytes += meta.totalBytes;
    progress("restoring");
  }
  async function clearPreparation() {
    decodedParts.clear();
    const tx = catalog.transaction(
        ["restore-records", "restore-parts"],
        "readwrite",
      ),
      done = complete(tx);
    tx.objectStore("restore-records").clear();
    tx.objectStore("restore-parts").clear();
    await done;
  }
  try {
    let t = catalog.transaction("meta", "readwrite"),
      end = complete(t);
    t.objectStore("meta").put(
      {
        state: "preparing",
        checkpointId: checkpoint.checkpointId,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      },
      "backup-restore-v2",
    );
    await end;
    progress("planning", "", true);
    for await (const ns of namespaceCatalog.namespaces) {
      check();
      if (ns.kind === "deleted") continue;
      planned.push(ns);
      await planMetadata(ns);
    }
    progress("restoring", "", true);
    for (const ns of planned) {
      check();
      hubNamespace(ns.namespace);
      if (
        !Number.isSafeInteger(ns.localCut) ||
        ns.localCut < 0 ||
        !Number.isSafeInteger(Number(ns.schemaEpoch))
      )
        throw Error("BACKUP_RESTORE_CUT_INVALID");
      if (ns.kind === "deleted") continue;
      let header: Schema | undefined;
      for await (const meta of stagedMetadata(ns))
        if (meta.operation === "schema") {
          const r = await record(meta, ns);
          header = decodePortableValue(r.value as PortableGraph) as Schema;
          accepted(meta);
          break;
        }
      const kind = ns.namespace.kind;
      if (
        !["local", "cookies", "idb", "atlas"].includes(kind) ||
        !header ||
        header.format !== "atlas-local-schema-v2" ||
        header.kind !== kind ||
        !Array.isArray(header.stores) ||
        header.stores.length > 32 ||
        !Number.isSafeInteger(header.version) ||
        header.version < 1
      )
        throw Error("BACKUP_RESTORE_SCHEMA_INVALID");
      const origin = ns.namespace.origin || "",
        scope =
          kind === "atlas"
            ? ""
            : kind === "cookies"
              ? new URL(origin).hostname
              : kind === "idb"
                ? ns.namespace.name || ""
                : origin;
      const dirtyNamespace =
        kind === "atlas"
          ? ATLAS_BACKUP_NAMESPACE
          : JSON.stringify([
              kind,
              kind === "cookies" ? scope : origin,
              kind === "idb" ? scope : "",
            ]);
      const physical =
          kind === "atlas"
            ? atlasBackupDatabase(stagingReplicaId)
            : kind === "idb"
              ? profileIDBPrefix(origin, stagingReplicaId) +
                encodeURIComponent(scope)
              : profileDatabaseName(
                  kind === "local"
                    ? "atlas.browsing.v2"
                    : "atlas.browsing.cookies.v2",
                  stagingReplicaId,
                ),
        metaName =
          kind === "local"
            ? "origins"
            : kind === "cookies" || kind === "atlas"
              ? "meta"
              : PROFILE_IDB_KEEP;
      const db = await create(
        factory,
        physical,
        kind === "idb" ? header.version : 1,
        (db) => {
          if (kind === "atlas") {
            db.createObjectStore("meta");
            db.createObjectStore("preferences");
          } else if (kind === "local") createLocalStorageV2Stores(db);
          else if (kind === "cookies") {
            const s = db.createObjectStore("cookies", { keyPath: "id" });
            s.createIndex("site", "site");
            s.createIndex("domain", "domain");
            s.createIndex("expires", "expires");
            db.createObjectStore("meta");
          } else {
            db.createObjectStore(PROFILE_IDB_KEEP);
            for (const s of header!.stores) {
              if (
                typeof s.name !== "string" ||
                s.name === PROFILE_IDB_KEEP ||
                s.indexes.length > 16
              )
                throw Error("BACKUP_RESTORE_SCHEMA_INVALID");
              const store = db.createObjectStore(s.name, {
                keyPath: s.keyPath,
                autoIncrement: s.autoIncrement,
              });
              for (const i of s.indexes)
                store.createIndex(i.name, i.keyPath, {
                  unique: i.unique,
                  multiEntry: i.multiEntry,
                });
            }
          }
        },
      );
      let localBytes = 0,
        localCount = 0,
        idbBytes = 128,
        idbRecords = 0,
        idbIndexes = 0;
      const storeUsage = new Map<
        string,
        { bytes: number; records: number; indexEntries: number }
      >();
      try {
        if (kind === "idb")
          for (const s of header.stores) {
            let bytes =
              128 + 2 * s.name.length + boundedIDBValueBytes(s.keyPath);
            for (const i of s.indexes)
              bytes +=
                128 + 2 * i.name.length + boundedIDBValueBytes(i.keyPath);
            storeUsage.set(s.name, { bytes, records: 0, indexEntries: 0 });
            idbBytes += bytes;
          }
        let yieldAt = performance.now();
        for await (const meta of stagedMetadata(ns)) {
          if (meta.operation === "schema") continue;
          check();
          const r = await record(meta, ns),
            key = decodeBackupKey(r.key!),
            value = decodePortableValue(r.value!),
            nativeBytes = preflightBackupRecord(value);
          const nativeStore =
            kind === "idb"
              ? r.store
              : kind === "local"
                ? "values-v2"
                : kind === "atlas"
                  ? "preferences"
                  : "cookies";
          if (
            kind === "idb" &&
            !header.stores.some((s) => s.name === nativeStore)
          )
            throw Error("BACKUP_RESTORE_STORE_INVALID");
          t = db.transaction([nativeStore, metaName], "readwrite");
          end = complete(t);
          const store = t.objectStore(nativeStore),
            metaStore = t.objectStore(metaName);
          if (kind === "atlas") {
            if (typeof key !== "string" || typeof value !== "string")
              throw Error("BACKUP_RESTORE_ATLAS_INVALID");
            store.put(value, key);
            const bytes = 2 * (key.length + value.length);
            if (preferenceBytes + bytes <= 1024 * 1024) {
              atlasPreferences[key] = value;
              preferenceBytes += bytes;
            } else deferredPreferences.push(key);
          } else if (kind === "local") {
            if (typeof key !== "string" || typeof value !== "string")
              throw Error("BACKUP_RESTORE_LOCAL_INVALID");
            store.put(value, ["local", origin, key]);
            localBytes += 2 * (key.length + value.length);
            localCount++;
          } else if (kind === "cookies") {
            const cookie = value as any;
            if (
              typeof key !== "string" ||
              cookie?.id !== key ||
              cookie.site !== scope ||
              typeof cookie.name !== "string" ||
              typeof cookie.value !== "string"
            )
              throw Error("BACKUP_RESTORE_COOKIE_INVALID");
            if (cookie.sessionId !== null)
              cookie.sessionId = "profile-" + stagingReplicaId;
            store.put(cookie);
            localBytes += new TextEncoder().encode(
              JSON.stringify(cookie),
            ).byteLength;
            localCount++;
          } else {
            const added =
              store.keyPath === null ? store.add(value, key) : store.add(value);
            added.onsuccess = () => {
              if (factory.cmp(added.result, key) !== 0) t.abort();
            };
            const usage = localIDBRecordUsage(
                store,
                key,
                value,
                boundedIDBValueBytes,
                { ...SANDBOX_IDB_LIMITS, quotaBytes: Number.MAX_SAFE_INTEGER },
                factory,
              ),
              totals = storeUsage.get(nativeStore)!;
            totals.bytes += usage.bytes;
            totals.records++;
            totals.indexEntries += usage.indexEntries;
            idbBytes += usage.bytes;
            idbRecords++;
            idbIndexes += usage.indexEntries;
            metaStore.put(usage, ["local-record-v2", nativeStore, key]);
          }
          metaStore.put(
            {
              storeEpoch: 1,
              estimatedNativeBytes: nativeBytes,
              shapeEligible: true,
            },
            localDirtySizeKey(
              dirtyNamespace,
              kind === "idb" ? r.store : "",
              1,
              key,
            ),
          );
          await end;
          recordsCompleted++;
          accepted(meta);
          // Native completion already yields between records. Avoid an extra
          // clamped timer for every tiny record; yield explicitly every 4ms.
          if (performance.now() - yieldAt >= 4) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            yieldAt = performance.now();
          }
        }
        // Preserve native generators even after their former highest key was
        // deleted/cleared. Sentinels are restored/deleted in the SAME transaction.
        if (kind === "idb") {
          t = db.transaction(
            [...header.stores.map((s) => s.name), metaName],
            "readwrite",
          );
          end = complete(t);
          for (const s of header.stores)
            if (s.autoIncrement) {
              if (!s.generator) throw Error("BACKUP_RESTORE_GENERATOR_MISSING");
              const high =
                "exhausted" in s.generator
                  ? 9007199254740992
                  : s.generator.next - 1;
              if (
                (!Number.isSafeInteger(high) && high !== 9007199254740992) ||
                high < 0
              )
                throw Error("BACKUP_RESTORE_GENERATOR_INVALID");
              if (high >= 1) {
                const store = t.objectStore(s.name),
                  prior = store.openCursor(IDBKeyRange.only(high));
                prior.onsuccess = () => {
                  const actual = prior.result
                    ? {
                        key: prior.result.primaryKey,
                        value: prior.result.value,
                      }
                    : null;
                  const v =
                      s.keyPath === null
                        ? null
                        : inlineKey({}, s.keyPath as string, high),
                    sentinel =
                      s.keyPath === null ? store.put(v, high) : store.put(v);
                  sentinel.onsuccess = () => {
                    if (actual) {
                      s.keyPath === null
                        ? store.put(actual.value, actual.key)
                        : store.put(actual.value);
                    } else store.delete(high);
                  };
                };
              }
            }
          await end;
        }
        t = db.transaction(metaName, "readwrite");
        end = complete(t);
        const ms = t.objectStore(metaName),
          control = emptyLocalDirtyControl(dirtyNamespace);
        control.generation = ns.localCut;
        control.acknowledgedGeneration = ns.localCut;
        control.schemaEpoch = Number(ns.schemaEpoch);
        for (const s of header.stores)
          control.storeEpochs[kind === "idb" ? s.name : ""] = 1;
        ms.put(control, localDirtyControlKey(dirtyNamespace));
        if (kind === "local")
          ms.put(
            {
              format: 2,
              revision: ns.localCut,
              bytes: localBytes,
              count: localCount,
            },
            origin,
          );
        else if (kind === "cookies") {
          const prior = ms.get("local-usage-v2");
          prior.onsuccess = () =>
            ms.put(
              {
                bytes: (prior.result?.bytes || 0) + localBytes,
                count: (prior.result?.count || 0) + localCount,
              },
              "local-usage-v2",
            );
          ms.put(ns.localCut, "revision");
        } else if (kind === "idb") {
          ms.put(
            {
              bytes: idbBytes,
              records: idbRecords,
              indexEntries: idbIndexes,
              localAccountingVersion: 2,
            },
            "usage",
          );
          for (const [name, usage] of storeUsage)
            ms.put(usage, ["local-store-v2", name]);
        }
        await end;
      } finally {
        db.close();
      }
      const descriptor: BackupNativeSourceDescriptor = {
        id: dirtyNamespace,
        namespace: ns.namespace,
        database: physical,
        metadataStore: metaName,
        dirtyNamespace,
        kind: kind as "local" | "cookies" | "idb" | "atlas",
        scope,
      };
      descriptors.push(descriptor);
      if (origin) origins.add(origin);
      t = catalog.transaction("meta", "readwrite");
      end = complete(t);
      if (kind === "idb")
        t.objectStore("meta").put({ origin, name: scope, physical }, [
          "database",
          origin,
          scope,
        ]);
      if (origin)
        t.objectStore("meta").put(
          {
            state: "ready",
            origin,
            checkpointId: checkpoint.checkpointId,
            localCut: ns.localCut,
          },
          ["local-site-v2", origin],
        );
      await end;
      namespaces++;
      progress("restoring", dirtyNamespace, true);
    }
    if (completedRecords !== totalRecords || completedBytes !== totalBytes)
      throw Error("BACKUP_RESTORE_PLAN_MISMATCH");
    progress("finalizing", "", true);
    await clearPreparation();
    t = catalog.transaction("meta", "readwrite");
    end = complete(t);
    t.objectStore("meta").put(
      {
        state: "ready",
        checkpointId: checkpoint.checkpointId,
        ...(/^[0-9]+$/.test(String(checkpoint.publicationOrdinal))
          ? { publicationOrdinal: String(checkpoint.publicationOrdinal) }
          : {}),
        descriptors,
        origins: [...origins],
        ...(options.profileId ? { profileId: options.profileId } : {}),
      },
      "backup-restore-v2",
    );
    await end;
    return {
      ...(namespaceCatalog.readerPin
        ? {
            readerPinned: true as const,
            readerLeaseId: namespaceCatalog.readerPin.leaseId,
          }
        : {}),
      stagingReplicaId,
      checkpointId: checkpoint.checkpointId,
      ...(/^[0-9]+$/.test(String(checkpoint.publicationOrdinal))
        ? { publicationOrdinal: String(checkpoint.publicationOrdinal) }
        : {}),
      descriptors,
      origins: [...origins],
      atlasPreferences,
      deferredPreferences,
    };
  } catch (error) {
    await clearPreparation().catch(() => {});
    const t = catalog.transaction("meta", "readwrite"),
      end = complete(t);
    t.objectStore("meta").put(
      {
        state: "incomplete",
        checkpointId: checkpoint.checkpointId,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      },
      "backup-restore-v2",
    );
    await end;
    throw error;
  } finally {
    reader.close();
    catalog.close();
  }
}
