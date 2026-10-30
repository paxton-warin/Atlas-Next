import { createCookieLocalReceiptWriter } from "./cookie-local-receipt.ts";
import {
  checkedLocalActorAuthority,
  checkedLocalBindingAuthority,
  revokeLocalAuthority,
  type LocalActorAuthority,
} from "./local-authority.ts";
/** Trusted frontend dedicated cookie worker. Its owner channel has the jar's
 * network authority; each document gets only a fixed-context get/set port and
 * its private filtered-result key. Never install this in website code. */
import {
  LocalCookieJarV2 as SandboxCookieJar,
  type CookieDocumentContext,
  type CookieRequestContext,
} from "./local-cookie-jar-v2.ts";
import {
  COOKIE_RESULT_PROTOCOL,
  newCookieResultKey,
  sealCookieResult,
} from "./sandbox-cookie-result.ts";
/** A document may update its same-origin SPA path, never its website authority. */
export function cookieDocumentURL(value: unknown, initial: string) {
  if (typeof value !== "string" || value.length > 16384)
    throw new DOMException("Invalid cookie document URL", "SecurityError");
  const url = new URL(value),
    bound = new URL(initial);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.origin !== bound.origin ||
    url.username ||
    url.password
  )
    throw new DOMException(
      "Cookie website origin is immutable",
      "SecurityError",
    );
  url.hash = "";
  return url.href;
}
type Scope = {
  location: { origin: string };
  indexedDB: IDBFactory;
  postMessage(value: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
};
export function installCookieNativeWorkerV2(scope: Scope) {
  type Binding = {
    context: CookieDocumentContext;
    url: string;
    document: ReturnType<SandboxCookieJar["document"]>;
    port: MessagePort;
    key: Uint8Array;
    next: number;
    version: number;
    pending: number;
    live: boolean;
    tail: Promise<void>;
    localReceipt: ReturnType<typeof createCookieLocalReceiptWriter>;
    stopChanges: () => void;
    cookieRevision: number;
    packets: Map<number, { packet: string; operation: "get" | "set" }>;
  };
  let localAuthority: LocalActorAuthority | null = null;
  const bindings = new Map<string, Binding>();
  const controls = new Map<string, AbortController>();
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  const dirtyOrigins = new Set<string>();
  const nativeChanged = (origin: string, legacyProfileId?: string) => {
    if (!localAuthority) return;
    if (dirtyOrigins.size < 32) dirtyOrigins.add(origin);
    if (!dirtyTimer)
      dirtyTimer = setTimeout(() => {
        dirtyTimer = undefined;
        if (!live || !localAuthority) return;
        for (const origin of dirtyOrigins)
          send({
            type: "profile-native-change",
            profileId: localAuthority.profileId,
            replicaId: localAuthority.replicaId,
            origin,
            kind: "cookies",
          });
        dirtyOrigins.clear();
      }, 100);
  };
  let jar: SandboxCookieJar | undefined,
    live = true,
    ready = false,
    controlPending = 0;
  const send = (value: unknown) => {
    if (live) scope.postMessage(value);
  };
  function revoke(id: string) {
    const b = bindings.get(id);
    if (!b) return;
    bindings.delete(id);
    b.live = false;
    b.stopChanges();
    b.document.dispose();
    b.key.fill(0);
    b.localReceipt?.dispose();
    b.packets.clear();
    b.port.postMessage({
      protocol: COOKIE_RESULT_PROTOCOL,
      documentId: id,
      type: "revoked",
    });
    b.port.close();
  }
  function dispose() {
    if (!live) return;
    for (const id of bindings.keys()) revoke(id);
    send({ type: "unavailable" });
    live = false;
    ready = false;
    clearTimeout(dirtyTimer);
    dirtyOrigins.clear();
    for (const controller of controls.values()) controller.abort();
    controls.clear();
    jar?.close();
  }
  const errorName = (error: any) =>
    ["AbortError", "QuotaExceededError", "InvalidStateError"].includes(
      error?.name,
    )
      ? error.name
      : "UnknownError";
  scope.addEventListener("message", async ({ data, ports }) => {
    if (!live || !data) return;
    try {
      if (data.type === "initialize") {
        if (jar) throw Error();
        const frontend = new URL(scope.location.origin);
        localAuthority = checkedLocalActorAuthority(data.localAuthority);
        jar = new SandboxCookieJar({
          factory: scope.indexedDB,
          profileId: localAuthority.replicaId,
          localAuthority,
          localAuthorityCurrent: () => localAuthority,
          browserSessionId: localAuthority.browserSessionId,
          onNativeCommit: (origin) => nativeChanged(origin),
          forbiddenOrigins: [frontend.origin, ...(data.forbiddenOrigins || [])],
        });
        ready = true;
        send({ type: "ready" });
      } else if (data.type === "bind-document") {
        if (
          !ready ||
          !jar ||
          ports.length !== 1 ||
          bindings.size >= 32 ||
          bindings.has(data.context?.documentId)
        )
          throw Error();
        const context = Object.freeze({
          ...data.context,
        }) as CookieDocumentContext;
        if (localAuthority)
          checkedLocalBindingAuthority(
            data.localAuthority,
            localAuthority,
            context.documentId,
            context.documentURL,
          );
        const document = jar.document(context),
          port = ports[0],
          key = newCookieResultKey();
        const b: Binding = {
          context,
          url: cookieDocumentURL(context.documentURL, context.documentURL),
          document,
          port,
          key,
          next: 1,
          version: 0,
          pending: 0,
          live: true,
          tail: Promise.resolve(),
          localReceipt: localAuthority
            ? createCookieLocalReceiptWriter(scope, context.documentId, { splitOperations: true })
            : null,
          stopChanges: () => {},
          cookieRevision: 0,
          packets: new Map(),
        };
        if (localAuthority && !b.localReceipt)
          throw new DOMException(
            "Cookie local receipt capability is unavailable",
            "NotSupportedError",
          );
        const initialView = localAuthority
          ? await document.snapshot()
          : undefined;
        if (localAuthority && !initialView?.entries)
          throw new DOMException(
            "Local cookie view did not initialize",
            "InvalidStateError",
          );
        b.cookieRevision = initialView?.revision || 0;
        const observe = () =>
          b.document.observeChanges((cookieRevision) => {
            if (b.live)
              port.postMessage({
                protocol: COOKIE_RESULT_PROTOCOL,
                documentId: context.documentId,
                type: "invalidate",
                cookieRevision,
              });
          });
        if (localAuthority) b.stopChanges = observe();
        bindings.set(context.documentId, b);
        port.onmessage = ({ data: op }) => {
          if (
            localAuthority &&
            b.live &&
            op?.protocol === COOKIE_RESULT_PROTOCOL &&
            op.documentId === context.documentId &&
            op.type === "receipt" &&
            ["get", "set"].includes(op.operation) &&
            Number.isSafeInteger(op.sequence) &&
            op.sequence > 0 &&
            op.sequence < b.next &&
            Object.keys(op).every((k) =>
              [
                "protocol",
                "documentId",
                "type",
                "sequence",
                "operation",
              ].includes(k),
            )
          ) {
            // Regenerate an acknowledgement only. The source mutation is never
            // submitted again, including while its original completion is pending.
            void b.tail
              .then(() => {
                const saved = b.packets.get(op.sequence);
                if (b.live && saved && saved.operation === op.operation)
                  b.localReceipt!.write(op.sequence, saved.packet, saved.operation);
              })
              .catch(() => {});
            return;
          }
          if (
            op?.protocol === COOKIE_RESULT_PROTOCOL &&
            op.documentId === context.documentId &&
            op.type === "dispose" &&
            Object.keys(op).every((k) =>
              ["protocol", "documentId", "type"].includes(k),
            )
          )
            return revoke(context.documentId);
          if (
            !b.live ||
            !op ||
            Object.keys(op).some(
              (k) =>
                ![
                  "protocol",
                  "documentId",
                  "sequence",
                  "type",
                  "line",
                  "url",
                ].includes(k),
            ) ||
            op.protocol !== COOKIE_RESULT_PROTOCOL ||
            op.documentId !== context.documentId ||
            op.sequence !== b.next ||
            !Number.isSafeInteger(b.next) ||
            !["get", "set"].includes(op.type) ||
            (op.type === "set"
              ? typeof op.line !== "string" || op.line.length > 16384
              : op.line !== undefined) ||
            b.pending >= 8
          )
            return revoke(context.documentId);
          let currentURL: string;
          try {
            currentURL = cookieDocumentURL(op.url, context.documentURL);
          } catch {
            return revoke(context.documentId);
          }
          b.next++;
          b.pending++;
          b.tail = b.tail
            .then(async () => {
              if (!b.live) return;
              if (b.url !== currentURL) {
                b.stopChanges();
                b.document.dispose();
                b.document = jar!.document({
                  ...context,
                  documentURL: currentURL,
                });
                b.url = currentURL;
                if (localAuthority) b.stopChanges = observe();
              }
              let localResult: any;
              let view = "",
                expiresAt: number | null = null,
                error: string | undefined;
              try {
                const result =
                  op.type === "set"
                    ? await b.document.set(
                        op.line,
                        localAuthority
                          ? {
                              binding:
                                context.documentId +
                                ":" +
                                b.localReceipt!.grant.binding,
                              sequence: op.sequence,
                            }
                          : undefined,
                      )
                    : await b.document.snapshot();
                view = "view" in result ? result.view : result.value;
                expiresAt = result.expiresAt;
                if (localAuthority) {
                  localResult = result;
                  b.cookieRevision = result.revision;
                }
              } catch (failure) {
                error = errorName(failure);
              }
              if (!b.live || !localAuthority) return;
              const packet = sealCookieResult(key, {
                documentId: context.documentId,
                sequence: op.sequence,
                operation: op.type,
                view,
                viewVersion: ++b.version,
                expiresAt,
                ...(error ? { error } : {}),
                ...(localAuthority
                  ? {
                      localMode: 2 as const,
                      cookieRevision: b.cookieRevision,
                      ...(op.type === "get"
                        ? { entries: localResult?.entries || [] }
                        : {
                            delta: {
                              baseVersion: b.version - 1,
                              baseRevision:
                                localResult?.delta?.baseRevision ??
                                b.cookieRevision,
                              upsert: localResult?.delta?.upsert || [],
                              remove: localResult?.delta?.remove || [],
                            },
                          }),
                    }
                  : {}),
              });
              if (localAuthority) {
                b.packets.set(op.sequence, { packet, operation: op.type });
                while (b.packets.size > 8)
                  b.packets.delete(b.packets.keys().next().value!);
                b.localReceipt!.write(op.sequence, packet, op.type);
              }
            })
            .catch(() => revoke(context.documentId))
            .finally(() => {
              b.pending--;
            });
        };
        port.onmessageerror = () => revoke(context.documentId);
        port.start();
        port.postMessage({
          protocol: COOKIE_RESULT_PROTOCOL,
          documentId: context.documentId,
          type: "ready",
          key: key.slice(),
          documentURL: context.documentURL,
          ...(b.localReceipt ? { localReceipt: b.localReceipt.grant } : {}),
          ...(localAuthority
            ? {
                localMode: 2,
                view: initialView!.value,
                entries: initialView!.entries,
                cookieRevision: initialView!.revision,
                viewVersion: 0,
                expiresAt: initialView!.expiresAt,
              }
            : {}),
        });
        send({ type: "document-bound", documentId: context.documentId });
      } else if (data.type === "revoke-local") {
        const next = revokeLocalAuthority(
          localAuthority,
          data.expectedAuthGeneration,
        );
        if (localAuthority && !next) {
          for (const id of bindings.keys()) revoke(id);
          await jar?.close();
          ready = false;
        }
        localAuthority = next;
      } else if (data.type === "unbind-document") revoke(data.documentId);
      else if (data.type === "dispose") dispose();
      else if (data.type === "cancel-network")
        controls
          .get(data.id)
          ?.abort(new DOMException("Cookie request aborted", "AbortError"));
      else if (
        data.type === "request-header" ||
        data.type === "response-cookies"
      ) {
        if (
          !jar ||
          !ready ||
          controlPending >= (localAuthority ? 512 : 32) ||
          typeof data.id !== "string" ||
          data.id.length > 128 ||
          controls.has(data.id)
        )
          throw Error();
        controlPending++;
        const abort = new AbortController();
        controls.set(data.id, abort);
        const fixed = {
          ...data.context,
          signal: abort.signal,
        } as CookieRequestContext;
        try {
          const result =
            data.type === "request-header"
              ? await jar.getRequestHeader(fixed)
              : await jar.storeResponseCookies(data.lines, fixed);
          send({ type: "network-result", id: data.id, result });
        } catch (error) {
          send({
            type: "network-result",
            id: data.id,
            error: errorName(error),
          });
        } finally {
          controls.delete(data.id);
          controlPending--;
        }
      }
    } catch (error) {
      if (
        localAuthority &&
        ["request-header", "response-cookies"].includes(data.type) &&
        typeof data.id === "string"
      ) {
        send({ type: "network-result", id: data.id, error: errorName(error) });
        return;
      }
      send({
        type: "error",
        documentId: data.context?.documentId,
        error: errorName(error),
      });
      if (data.type === "initialize") dispose();
    }
  });
  return { dispose };
}
if (
  typeof globalThis.document === "undefined" &&
  typeof globalThis.postMessage === "function" &&
  typeof globalThis.indexedDB !== "undefined"
)
  installCookieNativeWorkerV2(globalThis as unknown as Scope);
