import { acquireSharedProfileOwner } from "./shared-profile-owner.ts";
import { watchPageLoad } from "./page-load-watchdog.ts";
import { acquireSharedAssignmentCoordinator } from "./shared-assignment-coordinator.ts";
import { createScramjetWebsiteDocument, type ScramjetRuntimeEvent } from "./scramjet-document.ts";
import { getActiveProfile, getActiveProfileContext, prepareProfileDocument, getActiveLocalAuthority } from "./profile-context.ts";
import { hubSiteGroup } from "./hub-contracts.ts";
import { checkpointElementVisible, type ProfileCheckpointRequest } from "./website-checkpoint.ts";
/** Trusted frontend composition for the private opaque runtime. No owner,
 * assignment, relay ticket, trusted rewriter or upstream response body is
 * granted to website code. This module does not activate the public UI. */
import {
  createFrontendAssignmentCoordinator,
  type FrontendAssignment,
  type AssignmentState,
} from "./frontend-assignment.ts";
import { createSandboxStorageOwner } from "./sandbox-storage-owner.ts";
import { createSandboxCookieOwner } from "./sandbox-cookie-owner.ts";
import { createNativeResourceProvider } from "./native-resource-provider.ts";
import { createFrontendFrameReservations } from "./frontend-frame-reservation.ts";
import { createFrontendDocumentSource } from "./frontend-document-source.ts";
import {
  createSandboxRelayFetch,
  createSandboxRelayWebSocketConnect,
} from "./sandbox-relay.ts";
import { createOpaqueWebsiteDocument } from "./sandbox-controller.ts";
import type { NativeResourceIdentity } from "./native-resource-preparer.ts";
import { DiagnosticLog, requestCategory } from "./diagnostics.ts";
import {
  cleanPageCommand,
  type PageCommand,
  type PageTelemetry,
} from "./page-controls-protocol.ts";
import type { TrustedFormNavigation } from "./form-navigation.ts";

type Owner = Window & typeof globalThis;
type Coordinator = ReturnType<typeof createFrontendAssignmentCoordinator>;
type Document = ReturnType<typeof createOpaqueWebsiteDocument> | ReturnType<typeof createScramjetWebsiteDocument>;
type Fetch = ReturnType<typeof createSandboxRelayFetch>;
type SocketConnect = ReturnType<typeof createSandboxRelayWebSocketConnect>;
type NativeProvider = Awaited<ReturnType<typeof createNativeResourceProvider>>;
type Transform = NonNullable<
  Parameters<NativeProvider["attach"]>[0]["transform"]
>;
type RewriterFactory = (input: {
  documentId: string;
  documentURL: string;
  frontendOrigin: string;
}) => Transform;
type RuntimeAssets = Readonly<{
  version: 2;
  engine?: "scramjet-controller";
  runtimePath?: "/browse/runtime/";
  documentOrigin: "opaque" | "same-origin";
  bootstrap: string;
  trustedRewriter: string;
  workers: Readonly<{ storage: string; cookies: string; relay: string }>;
}>;
const components = {
  coordinator: createFrontendAssignmentCoordinator,
  storage: createSandboxStorageOwner,
  cookies: createSandboxCookieOwner,
  native: createNativeResourceProvider,
  frames: createFrontendFrameReservations,
  source: createFrontendDocumentSource,
  fetch: createSandboxRelayFetch,
  socket: createSandboxRelayWebSocketConnect,
  document: createOpaqueWebsiteDocument,
  async rewriter(
    url: string,
  ): Promise<{ createFrontendResourceRewriter: RewriterFactory }> {
    return import(/* @vite-ignore */ url);
  },
};
type Options = {
  container: HTMLElement;
  window?: Owner;
  factory?: IDBFactory;
  /** Stable tab identity survives a full trusted frontend reload, not traffic
   * node selection. Different tabs must not share sessionStorage identity. */
  tabSessionId?: string;
  forbiddenOrigins?: string[];
  timeoutMs?: number;
  coordinatorOptions?: Omit<
    Parameters<typeof createFrontendAssignmentCoordinator>[0],
    "workerURL" | "window" | "frontendOrigin" | "onAssignment" | "onState"
  >;
  onState?: (
    state:
      | AssignmentState
      | { status: "loading" | "ready" | "error"; code?: string },
  ) => void;
  onLocation?: (url: string) => void;
  onTelemetry?: (event: PageTelemetry) => void;
  onRuntimeEvent?: (event: ScramjetRuntimeEvent) => void;
  onAssignmentState?: (state: AssignmentState) => void;
  onAssignment?: Parameters<
    typeof createFrontendAssignmentCoordinator
  >[0]["onAssignment"];
  /** Trusted dependency seam for deterministic composition tests only. Defaults
   * always use actual durable owners, assigned relay and opaque controller. */
  components?: Partial<typeof components>;
};
const failure = (code: string) => Object.assign(new Error(code), { code });
const identity = (a: FrontendAssignment) =>
  [
    a.sessionHash,
    a.generation,
    a.node.id,
    a.relayOrigin,
    a.frontendOrigin,
    a.browserSessionId,
  ].join("\0");
const nativeIdentity = (a: FrontendAssignment): NativeResourceIdentity => ({
  nodeId: a.node.id,
  resourceOrigin: a.relayOrigin,
  leaseHash: a.sessionHash,
  generation: a.generation,
});
const TAB_KEY = "atlas.frontendTab.v2";

/** Load only same-frontend, content-addressed trusted runtime assets. The sixth
 * asset (adapted HttpEngine) is imported by the manifest's trusted relay worker;
 * its hash is verified by the server/build manifest, not website input. */
export async function loadFrontendRuntimeAssets(
  owner: Owner,
  signal: AbortSignal,
): Promise<RuntimeAssets> {
  const response = await owner.fetch("/api/browse/controller/runtime", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  if (!response.ok) throw failure("FRONTEND_RUNTIME_MANIFEST_UNAVAILABLE");
  const text = await response.text();
  if (text.length > 16384) throw failure("FRONTEND_RUNTIME_MANIFEST_INVALID");
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure("FRONTEND_RUNTIME_MANIFEST_INVALID");
  }
  const asset = (url: unknown, kind: string) => {
    if (
      typeof url !== "string" ||
      !new RegExp("^/browse/assets/" + kind + "-[a-f0-9]{16}\\.js$").test(url)
    )
      throw failure("FRONTEND_RUNTIME_MANIFEST_INVALID");
    const parsed = new URL(url, owner.location.origin);
    if (
      parsed.origin !== owner.location.origin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw failure("FRONTEND_RUNTIME_MANIFEST_INVALID");
    return parsed.href;
  };
  if (value?.version !== 2 || !value.workers ||
      (value.documentOrigin !== undefined && !["opaque", "same-origin"].includes(value.documentOrigin)) ||
      (value.engine !== undefined && (value.engine !== "scramjet-controller" || value.runtimePath !== "/browse/runtime/" || value.documentOrigin !== "same-origin")))
    throw failure("FRONTEND_RUNTIME_MANIFEST_INVALID");
  return Object.freeze({
    version: 2,
    ...(value.engine ? { engine: value.engine, runtimePath: value.runtimePath } : {}),
    documentOrigin: value.documentOrigin ?? "opaque",
    bootstrap: asset(value.bootstrap, "document"),
    trustedRewriter: asset(value.trustedRewriter, "rewriter"),
    workers: Object.freeze({
      storage: asset(value.workers.storage, "storage"),
      cookies: asset(value.workers.cookies, "cookies"),
      relay: asset(value.workers.relay, "relay"),
    }),
  });
}

export async function createFrontendBrowser(options: Options) {
  const owner =
    options.window ?? (options.container.ownerDocument.defaultView as Owner);
  if (!owner || options.container.ownerDocument.defaultView !== owner)
    throw failure("FRONTEND_BROWSER_OWNER_MISMATCH");
  const frontend = owner.location.origin,
    deps = { ...components, ...options.components };
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
    throw failure("FRONTEND_BROWSER_INVALID_TIMEOUT");
  let tabSessionId = options.tabSessionId;
  if (!tabSessionId) {
    try {
      tabSessionId = owner.sessionStorage.getItem(TAB_KEY) ?? undefined;
      if (!tabSessionId) {
        tabSessionId = "tab_" + owner.crypto.randomUUID().replaceAll("-", "");
        owner.sessionStorage.setItem(TAB_KEY, tabSessionId);
        if (owner.sessionStorage.getItem(TAB_KEY) !== tabSessionId)
          throw Error();
      }
    } catch {
      throw failure("FRONTEND_TAB_STORAGE_UNAVAILABLE");
    }
  }
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(tabSessionId))
    throw failure("FRONTEND_TAB_ID_INVALID");
  const initialization = new owner.AbortController(),
    manifestTimer = owner.setTimeout(() => initialization.abort(), timeout);
  let assets: RuntimeAssets, rewrite: RewriterFactory;
  try {
    assets = await loadFrontendRuntimeAssets(owner, initialization.signal);
    const module = assets.engine === "scramjet-controller" ? null : await Promise.race([
      deps.rewriter(assets.trustedRewriter),
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(failure("FRONTEND_RUNTIME_LOAD_TIMEOUT"));
        initialization.signal.addEventListener("abort", abort, { once: true });
        if (initialization.signal.aborted) abort();
      }),
    ]);
    if (assets.engine !== "scramjet-controller" && typeof module?.createFrontendResourceRewriter !== "function")
      throw failure("FRONTEND_TRUSTED_REWRITER_REQUIRED");
    rewrite = module?.createFrontendResourceRewriter!;
  } finally {
    owner.clearTimeout(manifestTimer);
  }
  let live = true,
    assignmentEpoch = 0,
    navigationEpoch = 0,
    navigationIntent = 0,
    desiredURL: string | undefined;
  let buildingIdentity: string | undefined;
  const learnedRelayOrigins = new Set(options.forbiddenOrigins ?? []);
  const forbiddenOrigins = () => [...learnedRelayOrigins];
  type Entry = {
    source: ReturnType<typeof createFrontendDocumentSource>;
    finalURL?: string;
    fetch?: Fetch;
    socket?: SocketConnect;
    diagnostics: DiagnosticLog;
    diagnosticsEnabled: boolean;
  };
  type Bundle = {
    identity: string;
    assignment: FrontendAssignment;
    storage: Awaited<ReturnType<typeof createSandboxStorageOwner>>;
    cookies: Awaited<ReturnType<typeof createSandboxCookieOwner>>;
    localNative?: Awaited<ReturnType<typeof import("./native-owner-v2.ts").createNativeOwnerV2>>;
    native?: NativeProvider;
    frames?: ReturnType<typeof createFrontendFrameReservations>;
    entries: Map<string, Entry>;
    live: boolean;
    dispose(): void;
  };
  type Mounted = {
    binding: Document;
    bundle: Bundle;
    requestedURL: string;
    cancel(): void;
  };
  let bundle: Bundle | undefined,
    mounted: Mounted | undefined,
    bundleFlight: Promise<void> = Promise.resolve(),
    mountFlight: Promise<Document> | undefined;
  let coordinator!: Coordinator;
  function state(value: Parameters<NonNullable<Options["onState"]>>[0]) {
    try {
      options.onState?.(value);
    } catch {}
  }
  function checkBundle(value: Bundle) {
    if (
      !live ||
      !value.live ||
      !coordinator.current ||
      identity(coordinator.current) !== value.identity
    )
      throw failure("FRONTEND_BROWSER_ASSIGNMENT_CHANGED");
  }
  function removeDocument() {
    const previous = mounted;
    mounted = undefined;
    if (previous) {
      previous.cancel();
      const entry = previous.bundle.entries.get(previous.binding.documentId);
      entry?.source.dispose();
      previous.bundle.entries.delete(previous.binding.documentId);
      previous.binding.dispose();
    }
  }
  const quiesce=(event:Event)=>{
    const siteGroup=(event as CustomEvent).detail?.siteGroup;
    if(siteGroup&&(!desiredURL||hubSiteGroup(new URL(desiredURL).origin)!==siteGroup))return;
    ++navigationIntent;removeDocument();state({status:"error",code:"PROFILE_CONTINUED_ELSEWHERE"});
  };
  const profileReady=(event:Event)=>{
    const {origin,siteGroup}=(event as CustomEvent).detail||{};
    if(live&&desiredURL&&(siteGroup?hubSiteGroup(new URL(desiredURL).origin)===siteGroup:new URL(desiredURL).origin===origin))void navigate(desiredURL).catch(()=>{});
  };
  let lastActiveAt = Date.now();
  let rootActive = true;
  const checkpoint = (event: Event) => {
    const detail = (event as CustomEvent<ProfileCheckpointRequest>).detail;
    const current = mounted;
    if (!live || options.container.isConnected === false || !current || !current.binding.live || !desiredURL || !detail ||
        !Array.isArray(detail.candidates) || !("checkpoint" in current.binding)) return;
    const origin = new URL(desiredURL).origin;
    if (hubSiteGroup(origin) !== detail.siteGroup) return;
    detail.candidates.push({
      origin,
      visible: rootActive && checkpointElementVisible(options.container),
      lastActiveAt,
      async checkpoint() {
        if (!live || mounted !== current || !current.binding.live || !desiredURL ||
            new URL(desiredURL).origin !== origin || !("checkpoint" in current.binding))
          throw failure("PROFILE_CHECKPOINT_DOCUMENT_CHANGED");
        await current.binding.checkpoint();
      },
    });
  };
  owner.addEventListener("atlas:profile-checkpoint", checkpoint);
  owner.addEventListener("atlas:profile-quiesce",quiesce);
  owner.addEventListener("atlas:profile-ready",profileReady);
  const checkedURL = (input: string) => {
    const u = new URL(input),
      forbidden = [
        frontend,
        ...forbiddenOrigins(),
        ...(coordinator.current ? [coordinator.current.relayOrigin] : []),
      ];
    if (
      !/^https?:$/.test(u.protocol) ||
      u.username ||
      u.password ||
      forbidden.some((raw) => new URL(raw).hostname === u.hostname)
    )
      throw failure("FRONTEND_BROWSER_DESTINATION_DENIED");
    return u.href;
  };
  async function mount(
    url: string,
    value: Bundle,
    form?: TrustedFormNavigation,
  ): Promise<Document> {
    await prepareProfileDocument(url);
    checkBundle(value);
    const website = checkedURL(url),
      version = ++navigationEpoch,
      intent = navigationIntent;
    removeDocument();
    state({ status: "loading" });
    let finish!: () => void,
      reject!: (error: Error) => void,
      completed = false;
    const content = new Promise<void>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    void content.catch(() => {});
    const cancel = () => {
      if (completed) return;
      completed = true;
      stopLoadWatch();
      reject(failure("FRONTEND_NAVIGATION_STALE"));
    };
    const stopLoadWatch = watchPageLoad({
      clock: owner,
      delayMs: timeout,
      kind: assets.engine === "scramjet-controller" ? "website" : "opaque-proof",
      slow() {
        if (!completed && live && version === navigationEpoch)
          options.onRuntimeEvent?.({ type: "slow", message: "Still loading. You can keep waiting and using this page." });
      },
      expired() {
        if (completed) return;
        completed = true;
        reject(failure("FRONTEND_DOCUMENT_CONTENT_TIMEOUT"));
        if (mounted?.binding === binding) {
          removeDocument();
          state({ status: "error", code: "FRONTEND_DOCUMENT_CONTENT_TIMEOUT" });
        }
      },
    });
    let binding: Document;
    try {
      const makeDocument = assets.engine === "scramjet-controller"
        ? (input: Parameters<typeof createOpaqueWebsiteDocument>[0]) => createScramjetWebsiteDocument({
            ...input, cookieProvider: value.cookies, browserSessionId: value.assignment.browserSessionId,
            localNative: value.localNative,
            async runtimeTicket() {
              checkBundle(value);
              const response = await owner.fetch("/api/browse/controller/runtime-ticket", {
                method: "POST", credentials: "same-origin", cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ session: coordinator.current!.session, generation: coordinator.current!.generation }),
              });
              if (!response.ok) throw failure("SCRAMJET_RUNTIME_TICKET_FAILED");
              const result = await response.json(); checkBundle(value); return result;
            },
            onRuntimeEvent(event) { if (live && version === navigationEpoch) options.onRuntimeEvent?.(event); },
            onLocation(next) {
              if (!live || version !== navigationEpoch) return;
              desiredURL = next; options.onLocation?.(next);
            },
          })
        : deps.document;
      binding = makeDocument({
        documentOrigin: assets.documentOrigin,
        website,
        container: options.container,
        factory: options.factory ?? owner.indexedDB,
        profileId: getActiveProfile(),
        profileContextId: getActiveProfileContext(),
        storageProvider: value.storage,
        cookieProvider: value.cookies,
        sessionId: tabSessionId!,
        timeoutMs: timeout,
        forbiddenOrigins: forbiddenOrigins(),
        sourceProvider: {
          async prepare(input) {
            checkBundle(value);
            if (
              version !== navigationEpoch ||
              intent !== navigationIntent ||
              value.entries.has(input.documentId)
            )
              throw failure("FRONTEND_NAVIGATION_STALE");
            const initial = checkedURL(input.website);
            await prepareProfileDocument(initial);
            const source = deps.source({
              frontendOrigin: frontend,
              enforceOriginalPolicy: assets.documentOrigin !== "same-origin",
              forbiddenOrigins: forbiddenOrigins(),
              selectedNodeOrigin: () => {
                checkBundle(value);
                return coordinator.current!.relayOrigin;
              },
              fetch: deps.fetch({
                documentId: input.documentId,
                documentURL: initial,
                topLevelURL: input.topLevelURL ?? form?.initiatorURL ?? initial,
                frontendOrigin: frontend,
                forbiddenOrigins: forbiddenOrigins(),
                relay: coordinator.transport,
                cookies: value.cookies,
              }),
            });
            const entry: Entry = {
              source,
              diagnostics: new DiagnosticLog(),
              diagnosticsEnabled: false,
            };
            value.entries.set(input.documentId, entry);
            try {
              const prepared = await source.prepare({
                ...input,
                ...(form && !input.parentDocumentId ? { navigation: form } : {}),
              });
              checkBundle(value);
              if (version !== navigationEpoch || intent !== navigationIntent)
                throw failure("FRONTEND_NAVIGATION_STALE");
              const finalURL = checkedURL(prepared.url);
              await prepareProfileDocument(finalURL);
              entry.finalURL = finalURL;
              const assignedFetch = deps.fetch({
                documentId: input.documentId,
                documentURL: finalURL,
                topLevelURL: input.topLevelURL ?? finalURL,
                frontendOrigin: frontend,
                forbiddenOrigins: forbiddenOrigins(),
                relay: coordinator.transport,
                cookies: value.cookies,
              });
              entry.fetch = async (request, context) => {
                const fields = {
                  origin: new URL(request.url).origin,
                  category: requestCategory(request.url),
                  method: request.method,
                  destination: request.destination,
                  credentialed: request.credentials !== "omit",
                };
                entry.diagnostics.record("request", fields);
                try {
                  const response = await assignedFetch(request, context);
                  entry.diagnostics.record("response", {
                    ...fields,
                    status: response.status,
                  });
                  return response;
                } catch (error) {
                  entry.diagnostics.record("error", fields);
                  throw error;
                }
              };
              entry.socket = deps.socket({
                documentId: input.documentId,
                documentURL: finalURL,
                topLevelURL: input.topLevelURL ?? finalURL,
                frontendOrigin: frontend,
                forbiddenOrigins: forbiddenOrigins(),
                relay: coordinator.transport,
                cookies: value.cookies,
              });
              if (!input.parentDocumentId) {
                desiredURL = finalURL;
                try { options.onLocation?.(finalURL); } catch {}
              }
              return prepared;
            } catch (error) {
              source.dispose();
              value.entries.delete(input.documentId);
              throw error;
            }
          },
          releaseDocument(documentId) {
            const entry=value.entries.get(documentId);
            entry?.source.dispose();value.entries.delete(documentId);
          },
        },
        frameProvider: value.frames,
        rendererProvider: value.frames,
        nativeResourceProvider: value.native,
        workerFetch: (input) => {
          checkBundle(value);
          const entry = value.entries.get(input.parentDocumentId);
          const workerURL = checkedURL(input.documentURL);
          if (
            !entry?.finalURL ||
            new URL(workerURL).origin !== new URL(entry.finalURL).origin
          )
            throw failure("FRONTEND_WORKER_BINDING_MISMATCH");
          const assignedFetch = deps.fetch({
            documentId: input.documentId,
            documentURL: workerURL,
            topLevelURL: entry.finalURL,
            frontendOrigin: frontend,
            forbiddenOrigins: forbiddenOrigins(),
            relay: coordinator.transport,
            cookies: value.cookies,
          });
          return (request, context) => {
            checkBundle(value);
            if (
              value.entries.get(input.parentDocumentId) !== entry ||
              version !== navigationEpoch
            )
              throw failure("FRONTEND_WORKER_BINDING_MISMATCH");
            return assignedFetch(request, context);
          };
        },
        fetch: (request, context) => {
          checkBundle(value);
          const entry = value.entries.get(context.documentId);
          if (!entry?.fetch || entry.finalURL !== context.documentURL)
            throw failure("FRONTEND_DOCUMENT_BINDING_MISMATCH");
          return entry.fetch(request, context);
        },
        webSocketConnect: (url, protocols, context, events) => {
          checkBundle(value);
          const entry = value.entries.get(context.documentId);
          if (!entry?.socket || entry.finalURL !== context.documentURL)
            throw failure("FRONTEND_DOCUMENT_BINDING_MISMATCH");
          return entry.socket(url, protocols, context, events);
        },
        onNavigation: (next, form) => {
          if (
            live &&
            mounted?.binding === binding &&
            version === navigationEpoch
          )
            void navigate(next, form).catch(() => {});
        },
        onContentState: (status, detail) => {
          if (version !== navigationEpoch || !live || completed) return;
          completed = true;
          stopLoadWatch();
          if (status === "ready") {
            finish();
            state({ status: "ready" });
          } else {
            const code = detail?.code ?? "FRONTEND_DOCUMENT_CONTENT_FAILED";
            reject(failure(code));
            state({
              status: "error",
              code,
            });
          }
        },
        onTelemetry: (event) => {
          if (
            !live ||
            version !== navigationEpoch ||
            mounted?.binding !== binding
          )
            return;
          if (assets.engine === "scramjet-controller") { options.onTelemetry?.(event); return; }
          const entry = value.entries.get(binding.documentId);
          if (!entry) return;
          try {
            options.onTelemetry?.(
              event.type === "compatibility-diagnostics"
                ? {
                    type: event.type,
                    report: { ...entry.diagnostics.snapshot(), version: 1 },
                  }
                : event,
            );
          } catch {}
        },
      });
      mounted = { binding, bundle: value, requestedURL: website, cancel };
    } catch (error) {
      cancel();
      throw error;
    }
    const result = Promise.all([binding.ready, content])
      .then(() => {
        checkBundle(value);
        if (
          version !== navigationEpoch ||
          intent !== navigationIntent ||
          mounted?.binding !== binding
        )
          throw failure("FRONTEND_NAVIGATION_STALE");
        return binding;
      })
      .catch((error) => {
        if (version === navigationEpoch && live) {
          removeDocument();
          state({
            status: "error",
            code: error.code ?? "FRONTEND_DOCUMENT_FAILED",
          });
        }
        throw error;
      });
    void result.catch(() => {});
    mountFlight = result;
    return result;
  }
  async function makeBundle(
    assignment: FrontendAssignment,
    version: number,
  ): Promise<Bundle> {
    const snapshot = identity(assignment),
      entries = new Map<string, Entry>(),
      created: { dispose(): void }[] = [];
    const check = () => {
      if (
        !live ||
        version !== assignmentEpoch ||
        !coordinator.current ||
        identity(coordinator.current) !== snapshot
      )
        throw failure("FRONTEND_BROWSER_ASSIGNMENT_CHANGED");
    };
    const registrationHeaders = () => {
      check();
      return {
        "x-atlas-browse-session": coordinator.current!.session,
        "x-atlas-browse-generation": String(coordinator.current!.generation),
      };
    };
    try {
      const localAuthority = getActiveLocalAuthority?.();
      const scope = localAuthority ? [localAuthority.replicaId, localAuthority.localAuthGeneration].join("\0")
        : [snapshot, getActiveProfile(), getActiveProfileContext()].join("\0");
      const storageOptions = {
        workerURL: assets.workers.storage, profileId: getActiveProfile(), localAuthority: localAuthority ?? undefined, nativeV2: !!localAuthority,
        profileContextId: getActiveProfileContext(), registrationHeaders, window: owner, timeoutMs: timeout,
        localReceipts: assets.engine === "scramjet-controller" && assets.documentOrigin === "same-origin" && !!getActiveProfile(),
      };
      const cookieOptions = {
        workerURL: assets.workers.cookies, profileId: getActiveProfile(), localAuthority: localAuthority ?? undefined, nativeV2: !!localAuthority,
        profileContextId: getActiveProfileContext(), registrationHeaders, window: owner, timeoutMs: timeout,
        browserSessionId: assignment.browserSessionId, forbiddenOrigins: forbiddenOrigins(),
        cacheViews: assets.engine === "scramjet-controller",
      };
      // A local authority never falls back to a remotely registered legacy owner.
      const makeStorage = () => deps.storage(storageOptions);
      const makeCookies = () => deps.cookies(cookieOptions);
      const share = assets.engine === "scramjet-controller";
      const results = await Promise.allSettled([
        share && !options.components?.storage
          ? acquireSharedProfileOwner(owner, "storage:" + scope, makeStorage)
          : makeStorage(),
        share && !options.components?.cookies
          ? acquireSharedProfileOwner(owner, "cookies:" + scope, makeCookies)
          : makeCookies(),
      ]);
      for (const result of results)
        if (result.status === "fulfilled") created.push(result.value);
      check();
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
      const storage = (
        results[0] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof createSandboxStorageOwner>>
        >
      ).value;
      const cookies = (
        results[1] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof createSandboxCookieOwner>>
        >
      ).value;
      const localNative = localAuthority ? await acquireSharedProfileOwner(owner, 'native-v2:' + scope, async () =>
        (await import('./native-owner-v2.ts')).createNativeOwnerV2(localAuthority,{host:owner,timeoutMs:timeout})) : undefined;
      if (localNative) created.push(localNative);
      const frames = assets.engine === "scramjet-controller" ? undefined : deps.frames({
        assignment: () => {
          check();
          return coordinator.current!;
        },
        window: owner,
        timeoutMs: timeout,
      });
      if (frames) created.push(frames);
      const native = assets.engine === "scramjet-controller" ? undefined : await deps.native({
        window: owner,
        timeoutMs: timeout,
        onUnavailable(code) {
          if (
            live &&
            version === assignmentEpoch &&
            coordinator.current &&
            identity(coordinator.current) === snapshot
          )
            state({ status: "error", code });
        },
        identity: () => {
          check();
          return nativeIdentity(coordinator.current!);
        },
        async grant(expected, context) {
          check();
          if (
            expected.nodeId !== assignment.node.id ||
            expected.resourceOrigin !== assignment.relayOrigin ||
            expected.leaseHash !== assignment.sessionHash ||
            expected.generation !== assignment.generation
          )
            throw failure("FRONTEND_NATIVE_OWNER_MISMATCH");
          const response = await owner.fetch(
            "/api/browse/controller/resource-owner",
            {
              method: "POST",
              credentials: "same-origin",
              redirect: "error",
              cache: "no-store",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                session: coordinator.current!.session,
                generation: coordinator.current!.generation,
              }),
              signal: context.signal,
            },
          );
          if (!response.ok) throw failure("FRONTEND_NATIVE_OWNER_UNAVAILABLE");
          const text = await response.text();
          if (text.length > 16384)
            throw failure("FRONTEND_NATIVE_OWNER_INVALID");
          check();
          return JSON.parse(text);
        },
        documentBindings(context) {
          check();
          const entry = entries.get(context.documentId);
          if (!entry?.fetch || entry.finalURL !== context.documentURL)
            throw failure("FRONTEND_DOCUMENT_BINDING_MISMATCH");
          const transform = rewrite({
            documentId: context.documentId,
            documentURL: context.documentURL,
            frontendOrigin: frontend,
          });
          if (typeof transform !== "function")
            throw failure("FRONTEND_TRUSTED_REWRITER_REQUIRED");
          return {
            fetch: entry.fetch,
            transform,
            forbiddenOrigins: forbiddenOrigins(),
          };
        },
      });
      if (native) created.push(native);
      check();
      const result: Bundle = {
        identity: snapshot,
        assignment,
        entries,
        storage,
        cookies,
        frames,
        native,
        localNative,
        live: true,
        dispose() {
          if (!result.live) return;
          result.live = false;
          for (const entry of entries.values()) entry.source.dispose();
          entries.clear();
          for (const item of created.reverse()) {
            try {
              item.dispose();
            } catch {}
          }
        },
      };
      return result;
    } catch (error) {
      for (const item of created.reverse()) {
        try {
          item.dispose();
        } catch {}
      }
      throw error;
    }
  }
  function assigned(
    event: Parameters<NonNullable<Options["onAssignment"]>>[0],
  ) {
    if (!live) return;
    try {
      options.onAssignment?.(event);
    } catch {}
    const nextIdentity = identity(event.assignment);
    learnedRelayOrigins.add(event.assignment.relayOrigin);
    if (
      (bundle?.live &&
        bundle.identity === nextIdentity &&
        bundle.storage.live !== false && bundle.cookies.live !== false &&
        (!bundle.native || bundle.native.stats().live)) ||
      buildingIdentity === nextIdentity
    ) {
      if (event.identityChanged === false && mounted && "renewCredentials" in mounted.binding)
        void mounted.binding.renewCredentials().catch((error: any) => state({status:"error",code:error.code || "SCRAMJET_RUNTIME_RENEW_FAILED"}));
      return;
    }
    const version = ++assignmentEpoch;
    buildingIdentity = nextIdentity;
    ++navigationEpoch;
    removeDocument();
    bundle?.dispose();
    bundle = undefined;
    const operation = (async () => {
      const next = await makeBundle(event.assignment, version);
      if (!live || version !== assignmentEpoch) {
        next.dispose();
        throw failure("FRONTEND_BROWSER_ASSIGNMENT_CHANGED");
      }
      bundle = next;
      if (desiredURL) await mount(desiredURL, next);
    })().finally(() => {
      if (version === assignmentEpoch) buildingIdentity = undefined;
    });
    bundleFlight = operation;
    void operation.catch((error) => {
      if (live && version === assignmentEpoch)
        state({
          status: "error",
          code: error.code ?? "FRONTEND_OWNERS_UNAVAILABLE",
        });
    });
  }
  const coordinate = assets.engine === "scramjet-controller" && options.coordinatorOptions && !options.components?.coordinator
    ? (input: Parameters<typeof deps.coordinator>[0]) => acquireSharedAssignmentCoordinator(owner, options.coordinatorOptions!, input)
    : deps.coordinator;
  coordinator = coordinate({
    ...options.coordinatorOptions,
    workerURL: assets.workers.relay,
    window: owner,
    frontendOrigin: frontend,
    onAssignment: assigned,
    onState: (value) => {
      try {
        options.onAssignmentState?.(value);
      } catch {}
      // A renewed relay becoming ready is not evidence that website content
      // finished. Only the attested content callback publishes document ready.
      if (value.status !== "ready") state(value);
    },
  });
  async function settle() {
    for (;;) {
      const pending = bundleFlight;
      await pending;
      if (pending === bundleFlight) break;
    }
    if (!live || !bundle) throw failure("FRONTEND_BROWSER_DISPOSED");
    return bundle;
  }
  async function navigate(url: string, form?: TrustedFormNavigation) {
    desiredURL = checkedURL(url);
    const intent = ++navigationIntent,
      expected = desiredURL,
      previous = mounted,
      current = await settle();
    if (intent !== navigationIntent) throw failure("FRONTEND_NAVIGATION_STALE");
    // A replacement bundle can already have mounted this latest intent while
    // navigate awaited its owners. Do not load that document a second time.
    if (
      mounted &&
      mounted !== previous &&
      mounted.bundle === current &&
      mounted.requestedURL === expected &&
      mountFlight
    )
      return mountFlight;
    if (assets.engine === "scramjet-controller" && mounted?.bundle === current &&
        "runtimeControl" in mounted.binding && !form) {
      await prepareProfileDocument(expected);
      if (intent !== navigationIntent) throw failure("FRONTEND_NAVIGATION_STALE");
      if (mounted.binding.runtimeControl("navigate", undefined, { url: expected, engine: "runtime" })) {
        mounted.requestedURL = expected;
        // Readiness remains driven by the normal frame's loading/loaded events,
        // not by this command acknowledgement. Keep popups and the controller.
        return mounted.binding;
      }
    }
    return mount(expected, current, form);
  }
  let connecting: Promise<void> | undefined;
  async function connect() {
    if (!live) throw failure("FRONTEND_BROWSER_DISPOSED");
    connecting ??= (async () => {
      await coordinator.start();
      await settle();
    })().catch((error) => {
      connecting = undefined;
      throw error;
    });
    await connecting;
    if (!live) throw failure("FRONTEND_BROWSER_DISPOSED");
    return coordinator.current;
  }
  return {
    assets,
    tabSessionId,
    /** Trusted shell may establish its pinned assignment before a website is
     * opened, so Home/administration never fall back to legacy lease APIs. */
    connect,
    async start(website: string) {
      await connect();
      return navigate(website);
    },
    navigate,
    runtimeCommand(type: string, targetId?: string, values: Record<string, unknown> = {}) {
      if (assets.engine !== "scramjet-controller" || !live || !mounted || !("runtimeControl" in mounted.binding)) return false;
      const result = mounted.binding.runtimeControl(type, targetId, values);
      if (result && type === "activate") {
        rootActive = targetId === undefined;
        if (rootActive) lastActiveAt = Date.now();
      }
      return result;
    },
    historyCommand(type: 'back' | 'forward' | 'reload') {
      if (assets.engine !== "scramjet-controller" || !live || !mounted || !("browserControl" in mounted.binding)) return false;
      return mounted.binding.browserControl(type);
    },
    pageCommand(input: PageCommand) {
      const command = cleanPageCommand(input);
      if (!command) throw failure("FRONTEND_PAGE_COMMAND_INVALID");
      const current = mounted,
        entry = current?.bundle.entries.get(current.binding.documentId);
      if (assets.engine === "scramjet-controller") return !!(live && current?.binding.live && current.binding.command(command));
      if (!live || !current?.binding.live || !entry) return false;
      const sent = current.binding.command(command);
      if (
        sent &&
        command.type === "compatibility-config" &&
        command.diagnostics !== entry.diagnosticsEnabled
      ) {
        entry.diagnosticsEnabled = command.diagnostics;
        entry.diagnostics.enable(command.diagnostics);
        entry.diagnostics.record("document", {
          origin: new URL(entry.finalURL!).origin,
          context: "embedded",
        });
      }
      return sent;
    },
    async check() {
      const lease = await coordinator.check({ authoritative: true });
      await settle();
      return lease;
    },
    async selectNode(nodeId: string, csrf: string) {
      const lease = await coordinator.selectNode(nodeId, csrf);
      await settle();
      return lease;
    },
    async reconnect() {
      const lease = await coordinator.reconnect();
      await settle();
      return lease;
    },
    get assignment() {
      return coordinator.current;
    },
    get document() {
      return mounted?.binding;
    },
    get live() {
      return live;
    },
    dispose() {
      if (!live) return;
      live = false;
      ++assignmentEpoch;
      ++navigationEpoch;
      ++navigationIntent;
      initialization.abort();
      owner.removeEventListener("atlas:profile-checkpoint", checkpoint);
      owner.removeEventListener("atlas:profile-quiesce",quiesce);
      owner.removeEventListener("atlas:profile-ready",profileReady);
      removeDocument();
      bundle?.dispose();
      bundle = undefined;
      coordinator.stop();
    },
  };
}
