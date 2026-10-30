import {
  profileDatabaseName,
  checkedProfile,
  appendProfileJournal,
} from "./profile-journal.ts";
import {
  assertProfileWrite,
  assertProfileWriteCached,
} from "./profile-permissions.ts";
import { createStorageLocalReceiptWriter } from "./storage-local-receipt.ts";
/** Trusted dedicated-worker storage owner for opaque website documents.
 *
 * Website keys/values stay on browser-local MessagePorts and native IndexedDB.
 * The owner WebSocket carries commit receipts only. A receipt is successful
 * only after the native transaction's complete event, never after queuing a
 * put. The server's marker/wait messages never create a storage operation.
 */
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

/** Install in a trusted same-frontend dedicated worker, not in an opaque page.
 * The caller transfers a fresh port for each document after authorizing its
 * server-side capability. Only this trusted channel selects website/session.
 */
export function installSandboxStorageWorker(scope: WorkerScope) {
  const documents = new Map<string, DocumentBinding>();
  const frontend = new URL(scope.location.origin);
  let live = true,
    initialized = false,
    connected = false,
    socket: WebSocket | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  let profileId: string | null = null;
  let profileContextId: string | undefined;
  let localReceipts = false;
  let database: Promise<IDBDatabase> | undefined;
  let channel: BroadcastChannel | undefined;
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
        if (!request.result.objectStoreNames.contains("origins"))
          request.result.createObjectStore("origins");
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
    const db = await openDatabase();
    return new Promise<StorageSnapshot>((resolve, reject) => {
      const transaction = db.transaction("origins", "readonly");
      const request = transaction
        .objectStore("origins")
        .get(storageKey(binding, kind));
      transaction.oncomplete = () =>
        resolve(request.result || { revision: 0, entries: [] });
      transaction.onabort = () =>
        reject(
          transaction.error ||
            new DOMException("Storage read aborted", "AbortError"),
        );
    });
  }
  function status(
    binding: DocumentBinding,
    number: number,
    ok: boolean,
    error?: Failure,
    revision?: number,
  ) {
    // This is a transport for the existing result, not a second commit or an
    // optimistic save. Success callers run only after strict native completion.
    if (binding.live && (!ok || (connected && socket?.readyState === WebSocket.OPEN))) {
      try {
        binding.localReceipt?.write(number, {
          ok,
          ...(error ? { error } : {}),
          ...(revision !== undefined ? { revision } : {}),
        });
      } catch {
        try { binding.localReceipt?.dispose(); } catch { /* Optional transport cleanup. */ }
        binding.localReceipt = null;
      }
    }
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "result",
          documentId: binding.documentId,
          sequence: number,
          ok,
          ...(error ? { error } : {}),
          ...(revision !== undefined ? { revision } : {}),
        }),
      );
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
  function notify(
    binding: DocumentBinding,
    kind: Kind,
    value: StorageSnapshot,
    change: ChangeEvent,
  ) {
    for (const target of documents.values()) {
      if (
        target.live &&
        matches(target, binding.origin, kind, binding.sessionId)
      )
        try { target.port.postMessage({
          type: "snapshot",
          documentId: target.documentId,
          kind,
          snapshot: value,
          change,
        }); } catch { /* A failed peer notification does not undo the commit. */ }
    }
    try { channel?.postMessage({
      origin: binding.origin,
      kind,
      sessionId: binding.sessionId,
      change,
    }); } catch { /* Cross-owner delivery is best effort after native commit. */ }
  }
  function commit(binding: DocumentBinding, operation: Operation) {
    return new Promise<void>(async (finish) => {
      const { message } = operation;
      let db: IDBDatabase;
      try {
        if (message.kind === "local")
          await assertProfileWrite(
            scope.indexedDB,
            profileId,
            binding.origin,
            profileContextId,
          );
        db = await openDatabase();
      } catch (error) {
        status(
          binding,
          message.sequence,
          false,
          failure(error, "storage_database_unavailable"),
        );
        finish();
        return;
      }
      if (
        !binding.live ||
        operation.cancelled ||
        !connected ||
        socket?.readyState !== WebSocket.OPEN
      ) {
        status(binding, message.sequence, false, {
          name: operation.cancelled ? "AbortError" : "NetworkError",
          code: "storage_operation_unavailable",
        });
        finish();
        return;
      }
      // Native read/write transaction serialization protects concurrent tabs.
      // Strict durability requests disk flush before acknowledging, where the
      // browser supports the standard IDBTransactionOptions member.
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction("origins", "readwrite", {
          durability: "strict",
        });
      } catch (error) {
        status(
          binding,
          message.sequence,
          false,
          failure(error, "storage_transaction_failed"),
        );
        finish();
        return;
      }
      operation.transaction = transaction;
      const store = transaction.objectStore("origins");
      const request = store.get(storageKey(binding, message.kind));
      let next: StorageSnapshot | undefined,
        event: ChangeEvent | undefined,
        aborted: Failure | undefined,
        changed = false;
      request.onsuccess = () => {
        try {
          if (message.kind === "local")
            assertProfileWriteCached(
              scope.indexedDB,
              profileId,
              binding.origin,
              profileContextId,
            );
          if (!binding.live || operation.cancelled || !connected)
            throw new DOMException(
              "Storage operation was cancelled",
              "AbortError",
            );
          const previous: StorageSnapshot = request.result || {
            revision: 0,
            entries: [],
          };
          const entries = new Map(previous.entries);
          const previousBytes = previous.entries.reduce(
            (n, [key, value]) => n + 2 * (key.length + value.length),
            0,
          );
          const change = message.change;
          const key = change.op === "clear" ? null : change.key;
          const oldValue = key === null ? null : (entries.get(key) ?? null);
          const newValue = change.op === "set" ? change.value : null;
          changed =
            change.op === "clear" ? entries.size > 0 : oldValue !== newValue;
          if (change.op === "set") entries.set(change.key, change.value);
          else if (change.op === "remove") entries.delete(change.key);
          else entries.clear();
          let bytes = 0;
          for (const [key, value] of entries)
            bytes += 2 * (key.length + value.length);
          if (bytes > binding.quotaBytes && bytes > previousBytes)
            throw new DOMException(
              "Website storage quota exceeded",
              "QuotaExceededError",
            );
          next = {
            revision: previous.revision + (changed ? 1 : 0),
            entries: [...entries],
          };
          event = {
            sourceDocumentId: binding.documentId,
            url: binding.website,
            key,
            oldValue,
            newValue,
          };
          if (changed) {
            store.put(next, storageKey(binding, message.kind));
            if (message.kind === "local") store.put({format:2,revision:next.revision,
              bytes:bytes+entries.size*64+128,count:entries.size},["local-migration-size-v2",binding.origin]);
            if (profileId && message.kind === "local")
              appendProfileJournal(
                store,
                {
                  profileId,
                  kind: "local",
                  origin: binding.origin,
                  payload: { change: message.change, revision: next.revision },
                  bytes: Math.max(
                    64,
                    2 * JSON.stringify(message.change).length,
                  ),
                },
                "array",
              );
          }
        } catch (error) {
          aborted = failure(error, "storage_write_failed");
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        if (next && event) {
          // Native completion is the acknowledgement authority. Optional
          // notification transports must never turn this durable write into
          // an HTTP timeout or leave this document's operation tail pending.
          try { status(binding, message.sequence, true, undefined, next.revision); }
          finally { finish(); }
          if (changed && profileId && message.kind === "local")
            try { sendOwner({
              type: "profile-native-change",
              profileId,
              origin: binding.origin,
              kind: "local",
            }); } catch { /* The committed journal remains available to sync. */ }
          if (changed) notify(binding, message.kind, next, event);
          else
            try { binding.port.postMessage({
              type: "snapshot",
              documentId: binding.documentId,
              kind: message.kind,
              snapshot: next,
            }); } catch { /* No-op notification failure cannot suppress its ACK. */ }
        } else {
          status(binding, message.sequence, false, {
            name: "UnknownError",
            code: "storage_empty_transaction",
          });
          finish();
        }
      };
      transaction.onabort = () => {
        status(
          binding,
          message.sequence,
          false,
          aborted ||
            failure(
              transaction.error ||
                new DOMException("Storage transaction aborted", "AbortError"),
              "storage_transaction_aborted",
            ),
        );
        finish();
      };
      transaction.onerror = () => {};
    });
  }
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
    try { binding.localReceipt?.dispose(); } catch { /* Revocation remains authoritative. */ }
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
      !connected ||
      !ownKeys(value, [
        "type",
        "documentId",
        "website",
        "sessionId",
        "quotaBytes",
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
      localReceipt: localReceipts
        ? createStorageLocalReceiptWriter(scope, value.documentId)
        : null,
    };
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
        ...(binding.localReceipt ? { localReceipt: binding.localReceipt.grant } : {}),
      });
      sendOwner({ type: "document-bound", documentId: binding.documentId });
    } catch (error) {
      revoke(binding);
      throw error;
    }
  }
  function receiveSocket(event: MessageEvent) {
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      socket?.close(1008, "Invalid storage control");
      return;
    }
    if (ownKeys(value, ["type"]) && value.type === "ready") {
      connected = true;
      sendOwner({ type: "ready" });
    } else if (ownKeys(value, ["type"]) && value.type === "pong") return;
    else if (
      ownKeys(value, ["type", "documentId", "sequence"]) &&
      value.type === "wait" &&
      DOCUMENT_ID.test(value.documentId) &&
      positiveSequence(value.sequence)
    ) {
      // Deliberately informational: server markers never trigger local writes.
    } else if (
      ownKeys(value, ["type", "documentId", "sequence"]) &&
      value.type === "cancel" &&
      DOCUMENT_ID.test(value.documentId) &&
      positiveSequence(value.sequence)
    ) {
      const binding = documents.get(value.documentId);
      if (binding) cancel(binding, value.sequence);
    } else if (
      ownKeys(value, ["type", "documentId"]) &&
      value.type === "revoke"
    ) {
      const binding = documents.get(value.documentId);
      if (binding) revoke(binding);
    } else socket?.close(1008, "Invalid storage control");
  }
  async function receiveOwner(event: MessageEvent) {
    const value = event.data;
    try {
      if (
        ownKeys(value, [
          "type",
          "socketURL",
          "profileId",
          "profileContextId",
          "localReceipts",
        ]) &&
        value.type === "initialize" &&
        !initialized
      ) {
        const url = new URL(value.socketURL, frontend);
        if (
          !/^wss?:$/.test(url.protocol) ||
          url.host !== frontend.host ||
          url.protocol !== (frontend.protocol === "https:" ? "wss:" : "ws:") ||
          !/^\/browse\/storage\/owner\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw new DOMException(
            "Storage owner URL is not a trusted endpoint",
            "SecurityError",
          );
        profileId = checkedProfile(value.profileId);
        profileContextId =
          typeof value.profileContextId === "string"
            ? value.profileContextId
            : undefined;
        if (value.localReceipts !== undefined && typeof value.localReceipts !== "boolean")
          throw new TypeError("Invalid local storage receipt option");
        // Opaque/unprofiled legacy owners retain the original network protocol.
        localReceipts = value.localReceipts === true && !!profileId && !!profileContextId;
        initialized = true;
        socket = new WebSocket(url);
        socket.onmessage = receiveSocket;
        socket.onclose = () => {
          connected = false;
          for (const binding of [...documents.values()]) revoke(binding);
          sendOwner({ type: "unavailable" });
        };
        socket.onerror = () =>
          sendOwner({
            type: "error",
            error: {
              name: "NetworkError",
              code: "storage_owner_connection_failed",
            },
          });
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "ping" }));
        }, 30000);
        if (typeof BroadcastChannel !== "undefined") {
          channel = new BroadcastChannel(
            profileDatabaseName("atlas.browsing.storage.v2", profileId),
          );
          channel.onmessage = async (event) => {
            const message = event.data;
            if (
              !ownKeys(message, ["origin", "kind", "sessionId", "change"]) ||
              !["local", "session"].includes(message.kind) ||
              typeof message.origin !== "string"
            )
              return;
            const peers = [...documents.values()].filter(
              (binding) =>
                binding.live &&
                matches(
                  binding,
                  message.origin,
                  message.kind,
                  message.sessionId,
                ),
            );
            if (!peers.length) return;
            try {
              const value = await snapshot(peers[0], message.kind);
              for (const binding of peers)
                if (binding.live)
                  binding.port.postMessage({
                    type: "snapshot",
                    documentId: binding.documentId,
                    kind: message.kind,
                    snapshot: value,
                    change: message.change,
                  });
            } catch {}
          };
        }
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
      connected = false;
      scope.removeEventListener("message", receiveOwner);
      if (heartbeat) clearInterval(heartbeat);
      for (const binding of [...documents.values()]) revoke(binding);
      channel?.close();
      socket?.close(1000, "Storage owner disposed");
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
  installSandboxStorageWorker(self as unknown as WorkerScope);
