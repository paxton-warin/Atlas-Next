import {
  checkedLocalActorAuthority,
  checkedLocalBindingAuthority,
  revokeLocalAuthority,
  type LocalActorAuthority,
} from "./local-authority.ts";
import {
  createLocalStorageV2Stores,
  readLocalStorageV2Snapshot,
  commitLocalStorageV2,
  LOCAL_STORAGE_RECEIPT_STORE,
  type LocalStorageV2Delta,
} from "./local-storage-v2.ts";
import { profileDatabaseName } from "./local-storage-names.ts";
import { createStorageLocalReceiptWriter } from "./storage-local-receipt.ts";
/** V2-only localStorage actor. No network, cloud permit, owner lease,
 * backup codec, history or remote receipt occurs in this dependency graph. */
import {
  SANDBOX_DATABASE,
  logicalStorageOrigin,
  type StorageChange,
  type StorageSnapshot,
} from "./sandbox-vault.ts";

type Kind = "local" | "session";
type Failure = { name: string; code: string };
type ChangeEvent = {
  sourceDocumentId: string;
  url: string;
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
};
type Mutation = {
  type: "mutate";
  documentId: string;
  sequence: number;
  kind: Kind;
  change: StorageChange;
};
type Operation = {
  message: Mutation;
  cancelled: boolean;
  transaction?: IDBTransaction;
};
type DocumentBinding = {
  documentId: string;
  website: string;
  origin: string;
  sessionId: string;
  quotaBytes: number;
  port: MessagePort;
  live: boolean;
  sequence: number;
  tail: Promise<void>;
  pending: Map<number, Operation>;
  cancelled: Set<number>;
  localReceipt: ReturnType<typeof createStorageLocalReceiptWriter>;
};
type WorkerScope = {
  location: { origin: string };
  indexedDB: IDBFactory;
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    receive: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    receive: (event: MessageEvent) => void,
  ): void;
};
const MAX_DOCUMENTS = 32;
const MAX_PENDING = 8;
const MAX_QUOTA = 32 * 1024 * 1024;
const DEFAULT_QUOTA = 5 * 1024 * 1024;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{16,96}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const ownKeys = (
  value: unknown,
  keys: string[],
): value is Record<string, any> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const positiveSequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const failure = (error: unknown, code: string): Failure => ({
  name: error instanceof DOMException ? error.name : "UnknownError",
  code,
});
function storageKey(binding: DocumentBinding, kind: Kind): IDBValidKey {
  return kind === "local"
    ? binding.origin
    : ["session", binding.sessionId, binding.origin];
}
function validChange(value: unknown): value is StorageChange {
  if (!ownKeys(value, ["op", "key", "value"])) return false;
  return value.op === "clear"
    ? Object.keys(value).length === 1
    : value.op === "remove"
      ? typeof value.key === "string" && !Object.hasOwn(value, "value")
      : value.op === "set" &&
        typeof value.key === "string" &&
        typeof value.value === "string";
}

/** Only a captured local authority can bind a document port. */
export function installNativeStorageWorkerV2(scope: WorkerScope) {
  const documents = new Map<string, DocumentBinding>();
  const frontend = new URL(scope.location.origin);
  let live = true,
    initialized = false,
    authorized = false;
  let localAuthority: LocalActorAuthority | null = null;
  let profileId: string | null = null;
  let database: Promise<IDBDatabase> | undefined;
  let channel: BroadcastChannel | undefined;
  let localDirtyTimer: ReturnType<typeof setTimeout> | undefined;
  const localDirtyOrigins = new Set<string>();
  function localDirty(origin: string) {
    if (localDirtyOrigins.size < 32) localDirtyOrigins.add(origin);
    if (localDirtyTimer) return;
    localDirtyTimer = setTimeout(() => {
      localDirtyTimer = undefined;
      const authority = localAuthority;
      if (!authority || !live) return;
      for (const origin of localDirtyOrigins)
        sendOwner({
          type: "profile-native-change",
          profileId: authority.profileId,
          replicaId: authority.replicaId,
          origin,
          kind: "local",
        });
      localDirtyOrigins.clear();
    }, 100);
  }
  const sendOwner = (message: unknown) => {
    if (live) scope.postMessage(message);
  };
  function openDatabase(): Promise<IDBDatabase> {
    return (database ??= new Promise((resolve, reject) => {
      const request = scope.indexedDB.open(
        profileDatabaseName(SANDBOX_DATABASE, profileId),
        1,
      );
      request.onupgradeneeded = () => {
        createLocalStorageV2Stores(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new DOMException("Storage database is blocked", "InvalidStateError"),
        );
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          for (const binding of [...documents.values()]) revoke(binding);
          sendOwner({
            type: "error",
            error: {
              name: "InvalidStateError",
              code: "storage_database_version_changed",
            },
          });
        };
        if (!live) db.close();
        resolve(db);
      };
    }));
  }
  async function snapshot(binding: DocumentBinding, kind: Kind) {
    return readLocalStorageV2Snapshot(await openDatabase(), {
      ...binding,
      kind,
    });
  }
  function status(
    binding: DocumentBinding,
    number: number,
    ok: boolean,
    error?: Failure,
    revision?: number,
  ) {
    if (!binding.live || !binding.localReceipt) return;
    try {
      binding.localReceipt.write(number, {
        ok,
        ...(error ? { error } : {}),
        ...(revision === undefined ? {} : { revision }),
      });
    } catch {
      /* An unavailable local receipt is uncertain, never remote success. */
    }
  }
  function matches(
    a: DocumentBinding,
    origin: string,
    kind: Kind,
    sessionId: string,
  ) {
    return (
      a.origin === origin && (kind === "local" || a.sessionId === sessionId)
    );
  }
  function notifyLocal(
    binding: DocumentBinding,
    kind: Kind,
    delta: LocalStorageV2Delta,
    change: ChangeEvent,
  ) {
    if (!delta.changed) return;
    for (const target of documents.values())
      if (
        target !== binding &&
        target.live &&
        matches(target, binding.origin, kind, binding.sessionId)
      )
        target.port.postMessage({
          type: "delta",
          documentId: target.documentId,
          kind,
          revision: delta.revision,
          delta: {
            key: delta.key,
            oldValue: delta.oldValue,
            newValue: delta.newValue,
          },
          change,
        });
    channel?.postMessage({
      origin: binding.origin,
      kind,
      sessionId: binding.sessionId,
      revision: delta.revision,
      delta: {
        key: delta.key,
        oldValue: delta.oldValue,
        newValue: delta.newValue,
      },
      change,
    });
  }
  async function commitLocal(binding: DocumentBinding, operation: Operation) {
    const captured = localAuthority,
      { message } = operation;
    try {
      const db = await openDatabase();
      const delta = await commitLocalStorageV2({
        db,
        namespace: { ...binding, kind: message.kind },
        documentId:
          binding.documentId + ":" + binding.localReceipt!.grant.binding,
        sequence: message.sequence,
        change: message.change,
        quotaBytes: binding.quotaBytes,
        assertCurrent() {
          if (
            !captured ||
            captured !== localAuthority ||
            !binding.live ||
            operation.cancelled
          )
            throw new DOMException(
              "Local storage binding is no longer current",
              "SecurityError",
            );
        },
        attach(tx) {
          operation.transaction = tx;
        },
      });
      status(binding, message.sequence, true, undefined, delta.revision);
      notifyLocal(binding, message.kind, delta, {
        sourceDocumentId: binding.documentId,
        url: binding.website,
        key: delta.key,
        oldValue: delta.oldValue,
        newValue: delta.newValue,
      });
      if (delta.changed && message.kind === "local") localDirty(binding.origin);
    } catch (error) {
      status(
        binding,
        message.sequence,
        false,
        failure(error, "storage_local_operation_failed"),
      );
    }
  }
  const commit = commitLocal;
  function cancel(binding: DocumentBinding, number: number) {
    const operation = binding.pending.get(number);
    if (operation) {
      operation.cancelled = true;
      try {
        operation.transaction?.abort();
      } catch {}
    } else if (
      number > binding.sequence &&
      number <= binding.sequence + 64 &&
      binding.cancelled.size < 64
    )
      binding.cancelled.add(number);
  }
  function revoke(binding: DocumentBinding) {
    if (!binding.live) return;
    binding.live = false;
    if (localAuthority && binding.localReceipt) {
      const identity =
        binding.documentId + ":" + binding.localReceipt.grant.binding;
      void openDatabase()
        .then((db) => {
          const tx = db.transaction(LOCAL_STORAGE_RECEIPT_STORE, "readwrite");
          tx.objectStore(LOCAL_STORAGE_RECEIPT_STORE).delete(
            IDBKeyRange.bound([identity], [identity + "\0"], false, true),
          );
        })
        .catch(() => {});
    }
    try {
      binding.localReceipt?.dispose();
    } catch {
      /* Revocation remains authoritative. */
    }
    binding.localReceipt = null;
    documents.delete(binding.documentId);
    for (const number of binding.pending.keys()) cancel(binding, number);
    binding.port.postMessage({
      type: "unavailable",
      documentId: binding.documentId,
    });
    binding.port.close();
  }
  function receiveDocument(binding: DocumentBinding, value: unknown) {
    if (!binding.live) return;
    if (
      localAuthority &&
      ownKeys(value, ["type", "documentId", "sequence"]) &&
      value.type === "receipt" &&
      value.documentId === binding.documentId &&
      positiveSequence(value.sequence) &&
      value.sequence <= binding.sequence
    ) {
      void openDatabase()
        .then(
          (db) =>
            new Promise<void>((resolve, reject) => {
              const tx = db.transaction(LOCAL_STORAGE_RECEIPT_STORE),
                r = tx
                  .objectStore(LOCAL_STORAGE_RECEIPT_STORE)
                  .get([
                    binding.documentId +
                      ":" +
                      binding.localReceipt!.grant.binding,
                    value.sequence,
                  ]);
              tx.oncomplete = () => {
                if (r.result)
                  status(
                    binding,
                    value.sequence,
                    true,
                    undefined,
                    r.result.revision,
                  );
                resolve();
              };
              tx.onabort = () => reject(tx.error);
            }),
        )
        .catch(() => {});
      return;
    }
    if (
      !ownKeys(value, ["type", "documentId", "sequence", "kind", "change"]) ||
      value.type !== "mutate" ||
      value.documentId !== binding.documentId ||
      !positiveSequence(value.sequence) ||
      value.sequence !== binding.sequence + 1 ||
      !["local", "session"].includes(value.kind) ||
      !validChange(value.change)
    ) {
      // A malformed document cannot change its origin or address another site.
      // Revocation avoids acknowledging any forged/replayed sequence.
      revoke(binding);
      return;
    }
    const message = value as Mutation;
    binding.sequence = message.sequence;
    if (binding.pending.size >= MAX_PENDING) {
      status(binding, message.sequence, false, {
        name: "QuotaExceededError",
        code: "storage_write_backpressure",
      });
      return;
    }
    if (
      message.change.op === "set" &&
      2 * (message.change.key.length + message.change.value.length) > MAX_QUOTA
    ) {
      status(binding, message.sequence, false, {
        name: "QuotaExceededError",
        code: "storage_write_quota",
      });
      return;
    }
    const operation: Operation = {
      message,
      cancelled: binding.cancelled.delete(message.sequence),
    };
    binding.pending.set(message.sequence, operation);
    binding.tail = binding.tail
      .then(() => commit(binding, operation))
      .catch(() => {
        status(binding, message.sequence, false, {
          name: "UnknownError",
          code: "storage_owner_failed",
        });
      })
      .finally(() => binding.pending.delete(message.sequence));
  }
  async function bind(
    value: Record<string, any>,
    ports: readonly MessagePort[],
  ) {
    if (
      !authorized ||
      !ownKeys(value, [
        "type",
        "documentId",
        "website",
        "sessionId",
        "quotaBytes",
        ...(localAuthority ? ["localAuthority"] : []),
      ]) ||
      !DOCUMENT_ID.test(value.documentId) ||
      typeof value.website !== "string" ||
      !SESSION_ID.test(value.sessionId) ||
      ports.length !== 1 ||
      documents.has(value.documentId) ||
      documents.size >= MAX_DOCUMENTS
    )
      throw new DOMException(
        "Invalid document storage binding",
        "SecurityError",
      );
    const origin = logicalStorageOrigin(value.website);
    if (localAuthority)
      checkedLocalBindingAuthority(
        value.localAuthority,
        localAuthority,
        value.documentId,
        value.website,
      );
    if (new URL(origin).hostname === frontend.hostname)
      throw new DOMException(
        "Frontend storage is not a website capability",
        "SecurityError",
      );
    const quotaBytes = value.quotaBytes ?? DEFAULT_QUOTA;
    if (
      !Number.isSafeInteger(quotaBytes) ||
      quotaBytes < 1 ||
      quotaBytes > MAX_QUOTA
    )
      throw new TypeError("Invalid website storage quota");
    const binding: DocumentBinding = {
      documentId: value.documentId,
      website: new URL(value.website).href,
      origin,
      sessionId: value.sessionId,
      quotaBytes,
      port: ports[0],
      live: true,
      sequence: 0,
      tail: Promise.resolve(),
      pending: new Map(),
      cancelled: new Set(),
      localReceipt: createStorageLocalReceiptWriter(scope, value.documentId, {
        localOnly: true,
      }),
    };
    if (localAuthority && !binding.localReceipt)
      throw new DOMException(
        "Storage local receipt capability is unavailable",
        "NotSupportedError",
      );
    if (localAuthority) binding.localReceipt!.write(0, { ok: true });
    documents.set(binding.documentId, binding);
    try {
      const [local, session] = await Promise.all([
        snapshot(binding, "local"),
        snapshot(binding, "session"),
      ]);
      if (!binding.live) return;
      binding.port.onmessage = (event) => receiveDocument(binding, event.data);
      binding.port.onmessageerror = () => revoke(binding);
      binding.port.start();
      binding.port.postMessage({
        type: "ready",
        documentId: binding.documentId,
        snapshots: { local, session },
        ...(binding.localReceipt
          ? { localReceipt: binding.localReceipt.grant }
          : {}),
      });
      sendOwner({ type: "document-bound", documentId: binding.documentId });
    } catch (error) {
      revoke(binding);
      throw error;
    }
  }
  async function receiveOwner(event: MessageEvent) {
    const value = event.data;
    try {
      if (
        value?.type === "initialize" &&
        value.localAuthority &&
        !initialized
      ) {
        localAuthority = checkedLocalActorAuthority(value.localAuthority);
        profileId = localAuthority.replicaId;
        initialized = authorized = true;
        await openDatabase();
        if (typeof BroadcastChannel !== "undefined") {
          channel = new BroadcastChannel(
            profileDatabaseName("atlas.browsing.storage.v2", profileId),
          );
          channel.onmessage = (event) => {
            const m = event.data;
            if (
              !m ||
              !["local", "session"].includes(m.kind) ||
              !Number.isSafeInteger(m.revision) ||
              !m.delta
            )
              return;
            for (const b of documents.values())
              if (b.live && matches(b, m.origin, m.kind, m.sessionId))
                b.port.postMessage({
                  type: "delta",
                  documentId: b.documentId,
                  kind: m.kind,
                  revision: m.revision,
                  delta: m.delta,
                  change: m.change,
                });
          };
        }
        sendOwner({ type: "ready" });
      } else if (value?.type === "revoke-local") {
        const next = revokeLocalAuthority(
          localAuthority,
          value.expectedAuthGeneration,
        );
        if (localAuthority && !next) {
          for (const b of [...documents.values()]) revoke(b);
          authorized = false;
        }
        localAuthority = next;
      } else if (value?.type === "bind-document")
        await bind(value, event.ports);
      else if (
        ownKeys(value, ["type", "documentId"]) &&
        value.type === "unbind-document"
      ) {
        const binding = documents.get(value.documentId);
        if (binding) revoke(binding);
      } else
        throw new DOMException(
          "Invalid storage owner operation",
          "SecurityError",
        );
    } catch (error) {
      for (const port of event.ports) port.close();
      sendOwner({
        type: "error",
        documentId:
          typeof value?.documentId === "string" ? value.documentId : undefined,
        error: failure(error, "storage_binding_failed"),
      });
    }
  }
  scope.addEventListener("message", receiveOwner);
  return {
    dispose() {
      if (!live) return;
      live = false;
      authorized = false;
      scope.removeEventListener("message", receiveOwner);
      if (localDirtyTimer) clearTimeout(localDirtyTimer);
      localDirtyOrigins.clear();
      for (const binding of [...documents.values()]) revoke(binding);
      channel?.close();
      void database?.then((value) => value.close()).catch(() => {});
    },
  };
}
// Vite can use this module directly as a dedicated-worker entry. Importing it
// in a Window or Node test has no side effect.
if (
  typeof document === "undefined" &&
  typeof self !== "undefined" &&
  typeof indexedDB !== "undefined" &&
  typeof (self as any).postMessage === "function"
)
  installNativeStorageWorkerV2(self as unknown as WorkerScope);
