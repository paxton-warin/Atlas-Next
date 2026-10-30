import {
  bindLocalSandboxIndexedDB as bindSandboxIndexedDB,
  type SandboxIDBLimits,
} from "./local-idb-backend-v2.ts";
import {
  checkedLocalActorAuthority,
  checkedLocalBindingAuthority,
  revokeLocalAuthority,
  type LocalActorAuthority,
  type LocalBindingAuthority,
} from "./local-authority.ts";
export const LOCAL_NATIVE_PROTOCOL = "atlas-local-native-v2";
type Scope = {
  location: { origin: string };
  indexedDB: IDBFactory;
  postMessage(value: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
};
/** Minimal native actor. No backup, codec, Hub request or writer-lease imports.
 * A website's port is transferred here, never serviced by the parent UI realm. */
export function installLocalNativeWorker(scope: Scope) {
  let authority: LocalActorAuthority | null = null,
    disposed = false;
  const documents = new Map<string, () => void>();
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Map<string, LocalBindingAuthority>();
  function nativeChanged(binding: LocalBindingAuthority) {
    if (dirty.size < 32) dirty.set(binding.logicalOrigin, binding);
    if (dirtyTimer) return;
    dirtyTimer = setTimeout(() => {
      dirtyTimer = undefined;
      for (const capability of dirty.values())
        if (
          authority &&
          capability.localAuthGeneration === authority.localAuthGeneration
        )
          scope.postMessage({
            protocol: LOCAL_NATIVE_PROTOCOL,
            type: "dirty",
            replicaId: capability.replicaId,
            documentId: capability.documentId,
            logicalOrigin: capability.logicalOrigin,
          });
      dirty.clear();
    }, 100);
  }
  const closeDocuments = () => {
    for (const close of documents.values()) close();
    documents.clear();
    clearTimeout(dirtyTimer);
    dirtyTimer = undefined;
    dirty.clear();
  };
  scope.addEventListener("message", (event) => {
    const m = event.data;
    if (
      !m ||
      m.protocol !== LOCAL_NATIVE_PROTOCOL ||
      !Number.isSafeInteger(m.id)
    )
      return;
    try {
      if (disposed)
        throw new DOMException("Local actor disposed", "InvalidStateError");
      let value: unknown = undefined;
      if (m.operation === "initialize") {
        const next = checkedLocalActorAuthority(m.authority);
        if (
          authority &&
          (authority.profileId !== next.profileId ||
            authority.replicaId !== next.replicaId ||
            authority.localAuthGeneration !== next.localAuthGeneration ||
            authority.browserSessionId !== next.browserSessionId)
        )
          closeDocuments();
        authority = next;
        value = { replicaId: next.replicaId };
      } else if (m.operation === "bind-idb") {
        if (
          !authority ||
          event.ports.length !== 1 ||
          documents.size >= 32 ||
          documents.has(m.documentId)
        )
          throw new DOMException(
            "Invalid local document binding",
            "SecurityError",
          );
        const capability = checkedLocalBindingAuthority(
          m.authority,
          authority,
          m.documentId,
          m.website,
        );
        const close = bindSandboxIndexedDB({
          port: event.ports[0],
          documentId: m.documentId,
          website: m.website,
          frontendOrigin: scope.location.origin,
          factory: scope.indexedDB,
          profileId: authority.replicaId,
          localAuthority: capability,
          localAuthorityCurrent: () => authority,
          limits: m.limits as Partial<SandboxIDBLimits> | undefined,
          onLocalMutation: () => nativeChanged(capability),
        });
        documents.set(m.documentId, () => close.dispose());
        value = { documentId: m.documentId };
      } else if (m.operation === "unbind") {
        documents.get(m.documentId)?.();
        documents.delete(m.documentId);
      } else if (m.operation === "revoke") {
        const next = revokeLocalAuthority(authority, m.expectedAuthGeneration);
        if (authority && !next) closeDocuments();
        authority = next;
      } else if (m.operation === "dispose") {
        closeDocuments();
        clearTimeout(dirtyTimer);
        dirty.clear();
        authority = null;
        disposed = true;
      } else throw new TypeError("Unknown local actor operation");
      scope.postMessage({
        protocol: LOCAL_NATIVE_PROTOCOL,
        id: m.id,
        ok: true,
        value,
      });
    } catch (error) {
      const e = error as Error;
      scope.postMessage({
        protocol: LOCAL_NATIVE_PROTOCOL,
        id: m.id,
        ok: false,
        error: {
          name: e?.name || "UnknownError",
          code: e?.name || "LOCAL_ACTOR_FAILED",
          message: e?.message || "Local actor failed",
        },
      });
    }
  });
}
if (
  typeof document === "undefined" &&
  typeof self !== "undefined" &&
  "indexedDB" in self
)
  installLocalNativeWorker(self as unknown as Scope);
