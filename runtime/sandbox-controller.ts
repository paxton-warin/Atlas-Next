import { createSandboxPopupBroker } from "./sandbox-popups.ts";
import { getProfileLimits } from "./profile-limits.ts";
import { bindSandboxDocument } from "./sandbox-broker.ts";
import { bindSandboxIndexedDB } from "./sandbox-idb.ts";
import { bindSandboxCaches } from "./sandbox-caches.ts";
import { bindSandboxNetwork } from "./sandbox-network.ts";
import { createSandboxRenderer } from "./sandbox-renderer.ts";
import { createSandboxWorkerBroker } from "./sandbox-worker-broker.ts";
import type { bindOpaqueWebSockets } from "./opaque-websocket.ts";
import { logicalStorageOrigin, type SandboxVault } from "./sandbox-vault.ts";
import {
  createOriginalDocumentPolicy,
  type OriginalDocumentPolicy,
} from "./original-document-policy.ts";
import { createOriginalDocumentPlan } from "./original-document-plan.ts";
import {
  cleanFormNavigation,
  type TrustedFormNavigation,
} from "./form-navigation.ts";
import {
  cleanDocumentBootFailure,
  type DocumentBootFailure,
} from "./document-boot-diagnostics.ts";
import {
  cleanPageCommand,
  cleanPageTelemetry,
  type PageCommand,
  type PageTelemetry,
} from "./page-controls-protocol.ts";

type NetworkBinding = Parameters<typeof bindSandboxNetwork>[0];
type Options = {
  /** Selected by the trusted manifest, not website messages or preferences. */
  documentOrigin?: "opaque" | "same-origin";
  website: string;
  container: HTMLElement;
  vault?: Pick<SandboxVault, "snapshot" | "write">;
  storageProvider?: {
    bind(input: {
      documentId: string;
      website: string;
      sessionId: string;
    }): Promise<{ port: MessagePort; endpoint: string; dispose(): void }>;
  };
  cookieProvider?: {
    bind(input: {
      documentId: string;
      website: string;
      topLevelURL?: string;
      siteForCookiesURL?: string | null;
    }): Promise<{ port: MessagePort; endpoint: string; dispose(): void }>;
  };
  sessionId?: string;
  factory: IDBFactory;
  profileId?: string | null;
  profileContextId?: string;
  fetch: NetworkBinding["fetch"];
  workerFetch?: Parameters<typeof createSandboxWorkerBroker>[0]["workerFetch"];
  webSocketConnect?: Parameters<typeof bindOpaqueWebSockets>[0]["connect"];
  /** This loader executes in trusted frontend code BEFORE namespaces are bound.
   * Original response headers/meta are never accepted from website messages. */
  sourceProvider?: {
    prepare(input: {
      documentId: string;
      website: string;
      signal: AbortSignal;
      parentDocumentId?: string;
      topLevelURL?: string;
    }): Promise<{
      url: string;
      html: string;
      contentPolicies: readonly string[];
      coep: "unsafe-none" | "require-corp" | "credentialless";
    }>;
    releaseDocument?(documentId: string): void;
  };
  frameProvider?: {
    reserve(input: {
      documentId: string;
      website: string;
      signal: AbortSignal;
      parentDocumentId?: string;
      bootstrapNonce?: string;
      kind?: "popup";
    }): Promise<{
      frameURL: string;
      resourceOrigin: string;
      serverBootstrapNonce?: boolean;
      expiresAt?: number;
      refresh?(): Promise<number>;
      dispose?(): void;
    }>;
  };
  rendererProvider?: {
    reserveRenderer(input: {
      parentDocumentId: string;
      scriptHashes: readonly string[];
    }): Promise<{ helperURL: string; childId: string; secret: string }>;
  };
  nativeResourceProvider?: {
    bind(input: {
      documentId: string;
      website: string;
      topLevelURL: string;
      contentPolicies: string[];
      coep: "unsafe-none" | "require-corp" | "credentialless";
    }): Promise<{
      port: MessagePort;
      ready: Promise<void>;
      resourceOrigin: string;
      dispose(): void;
    }>;
  };
  /** Internal recursive binding. Only trusted controller code constructs this;
   * the parent website receives a URL, never the child capability endpoints. */
  nested?: {
    window: Window;
    parentDocumentId: string;
    depth: number;
    ancestorOrigins: string[];
    active(): boolean;
    publish(url: string, origin: string): void;
    authorize(url: string): void;
    messageAncestor(
      depth: number,
      origin: string,
      targetOrigin: string,
      payload: unknown,
      ports: MessagePort[],
      path: number[],
    ): void;
  };
  reservedDocument?: {
    documentId: string;
    nonce: string;
    kind: "popup";
    offer: MessageEvent;
    reservation: {
      frameURL: string;
      resourceOrigin: string;
      serverBootstrapNonce?: boolean;
      expiresAt?: number;
      refresh?(): Promise<number>;
      dispose?(): void;
    };
  };
  popupContext?: boolean;
  controllerOpenerDepth?: number;
  popupOpener?: {
    origin: string;
    deliver(
      origin: string,
      targetOrigin: string,
      payload: unknown,
      ports: MessagePort[],
    ): void;
  };
  nestedBudget?: { active: number };
  topLevelURL?: string;
  forbiddenOrigins?: string[];
  timeoutMs?: number;
  /** Called only from the bound control port, not a window message listener.
   * The owner must create a NEW binding for any website document navigation. */
  onNavigation?: (url: string, form?: TrustedFormNavigation) => void;
  /** Trusted self-boot replaces only its initial DOM with document.write. This
   * one-shot lifecycle exception never transfers capabilities to a new realm. */
  selfBootContent?: boolean;
  contentAttestationTimeoutMs?: number;
  onContentState?: (
    state: "ready" | "error",
    failure?: DocumentBootFailure,
  ) => void;
  /** Presentation/diagnostics from this exact original document port only. */
  onTelemetry?: (event: PageTelemetry) => void;
};
const PROTOCOL = 2;
const allowedKeys = (value: object, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/** Inactive architecture component. A WindowProxy is NOT a document identity.
 * Every document receives fresh random IDs/nonces/ports; owner navigation or
 * unexpected frame loads revoke the old grant. No general Origin:null handler
 * authenticates website operations, and no page selects its own namespace.
 */
export function createSandboxDocument(options: Options) {
  const owner = options.container.ownerDocument.defaultView!;
  const attestationTimeout = options.contentAttestationTimeoutMs ?? 3000;
  if (
    !Number.isFinite(attestationTimeout) ||
    attestationTimeout < 1 ||
    attestationTimeout > 30000
  )
    throw new TypeError("Invalid content attestation timeout.");
  const frontendOrigin = owner.location.origin;
  const sameOrigin = options.documentOrigin === "same-origin";
  if (options.documentOrigin !== undefined && !["opaque", "same-origin"].includes(options.documentOrigin))
    throw new TypeError("Invalid document origin mode");
  const website = new URL(options.website);
  if (
    options.nativeResourceProvider &&
    (!options.sourceProvider || !options.frameProvider)
  )
    throw new TypeError(
      "Native resources require trusted source and physical frame policy providers.",
    );
  logicalStorageOrigin(website.href);
  if (!options.vault && !options.storageProvider)
    throw new TypeError("A document storage backend is required.");
  if (options.storageProvider && !options.sessionId)
    throw new TypeError(
      "A stable browsing-tab sessionStorage identity is required.",
    );
  const forbidden = [frontendOrigin, ...(options.forbiddenOrigins || [])];
  if (forbidden.some((url) => new URL(url).hostname === website.hostname))
    throw new TypeError("Frontend resources are not website capabilities.");
  const documentId =
    options.reservedDocument?.documentId ??
    "doc_" + owner.crypto.randomUUID().replaceAll("-", "");
  const nonce =
    options.reservedDocument?.nonce ??
    owner.crypto.randomUUID() + owner.crypto.randomUUID();
  const frameURL = new URL(
    `/browse/${options.reservedDocument ? "popup" : "frame"}/${documentId}`,
    frontendOrigin,
  );
  frameURL.hash = nonce;
  const frame = options.container.ownerDocument.createElement("iframe");
  const documentWindow = () => options.nested?.window ?? frame.contentWindow;
  const nestedBudget = options.nestedBudget ?? { active: 0 };
  if (!sameOrigin) frame.sandbox.add("allow-scripts", "allow-popups");
  frame.referrerPolicy = "no-referrer";
  frame.title = "Website";
  let live = true,
    offered = false,
    bound = false,
    loaded = false,
    contentStarted = false,
    contentLoad = false,
    contentReady = false,
    contentAttested = false,
    contentReported = false;
  let contentChallenge: string | undefined;
  let pageSequence = 0;
  let attestationTimer: number | undefined;
  let control: MessagePort | undefined;
  let offer: MessagePort | undefined;
  let preparedSource:
    | Awaited<ReturnType<NonNullable<Options["sourceProvider"]>["prepare"]>>
    | undefined;
  let originalPolicy: OriginalDocumentPolicy | undefined;
  let logicalBaseURL = website.href,
    navigationRequested = false;
  let nativeResources:
    | Awaited<
        ReturnType<NonNullable<Options["nativeResourceProvider"]>["bind"]>
      >
    | undefined;
  const preparation = new AbortController();
  let initializeAfterLoad: (() => void) | undefined;
  const disposers: (() => void)[] = [];
  let fulfill!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, fail) => {
    fulfill = resolve;
    reject = fail;
  });
  // Revocation is an expected lifecycle path; consumers may inspect ready later.
  void ready.catch(() => {});
  const timer = owner.setTimeout(
    () => dispose(new Error("sandbox_binding_timeout")),
    options.timeoutMs ?? 10000,
  );
  function dispose(error = new Error("sandbox_document_disposed")) {
    if (!live) return;
    live = false;
    preparation.abort();
    options.sourceProvider?.releaseDocument?.(documentId);
    owner.clearTimeout(timer);
    owner.clearTimeout(attestationTimer);
    contentChallenge = undefined;
    owner.removeEventListener("message", receive);
    frame.removeEventListener("load", load);
    for (const cancel of disposers.splice(0)) {
      try {
        cancel();
      } catch {}
    }
    control?.close();
    offer?.close();
    initializeAfterLoad = undefined;
    if (!options.nested) frame.remove();
    if (!bound) reject(error);
  }
  function failContent(error: Error, failure?: DocumentBootFailure) {
    try {
      if (options.selfBootContent && !contentReported) {
        contentReported = true;
        options.onContentState?.("error", failure);
      }
    } finally {
      dispose(error);
    }
  }
  function publishContent() {
    if (!live || !contentReady || !contentAttested || contentReported) return;
    contentReported = true;
    control?.postMessage({
      protocol: PROTOCOL,
      documentId,
      type: "page-controls-activate",
    });
    options.onContentState?.("ready");
  }
  function deliverWindowMessage(
    origin: string,
    payload: unknown,
    ports: MessagePort[],
    source: object,
  ) {
    if (!live || !bound) return;
    control!.postMessage(
      {
        protocol: PROTOCOL,
        documentId,
        type: "window-message-data",
        origin,
        payload,
        source,
      },
      ports,
    );
  }
  function load() {
    // Bootstrap posts ready during parsing, potentially before initial load.
    // The first load is expected; subsequent navigations cannot inherit ports.
    if (loaded) {
      if (contentLoad && !contentChallenge && !contentAttested) {
        contentLoad = false;
        // A load event alone does not identify a Document: an unrelated native
        // navigation can cancel document.write's expected load. The private
        // original-realm endpoint must attest its captured native document
        // identity AFTER this load before any content-ready report is trusted.
        contentChallenge = owner.crypto.randomUUID().replaceAll("-", "");
        attestationTimer = owner.setTimeout(
          () => failContent(new Error("sandbox_document_attestation_timeout")),
          attestationTimeout,
        );
        control!.postMessage({
          protocol: PROTOCOL,
          documentId,
          type: "attest-document",
          nonce: contentChallenge,
        });
      } else failContent(new Error("sandbox_document_navigated"));
      return;
    }
    loaded = true;
    if (live && initializeAfterLoad) {
      const initialize = initializeAfterLoad;
      initializeAfterLoad = undefined;
      initialize();
    }
  }
  async function receive(event: MessageEvent) {
    const message = event.data;
    if (
      !live ||
      offered ||
      event.source !== documentWindow() ||
      event.origin !== (sameOrigin ? frontendOrigin : "null") ||
      !message ||
      message.protocol !== PROTOCOL ||
      message.type !== "sandbox-ready" ||
      message.documentId !== documentId ||
      message.nonce !== nonce ||
      event.ports.length !== 1 ||
      !allowedKeys(message, ["protocol", "type", "documentId", "nonce"])
    )
      return;
    offered = true;
    // Nested bootstraps offer only after their own initial native load. The
    // trusted owner cannot observe an element inside an opaque parent DOM.
    if (options.nested) loaded = true;
    // This channel was created by the original document while parsing. Unlike
    // its reusable WindowProxy, the receiving endpoint cannot move to whatever
    // document happens to occupy the frame after an asynchronous hydration.
    offer = event.ports[0];
    owner.removeEventListener("message", receive);
    try {
      // Hydrate before enabling website execution, not by an asynchronous read
      // that returns an empty map while the real database is still opening.
      const durable = options.storageProvider
        ? await options.storageProvider.bind({
            documentId,
            website: website.href,
            sessionId: options.sessionId!,
          })
        : undefined;
      if (!live) {
        durable?.dispose();
        return;
      }
      if (durable) disposers.push(durable.dispose);
      const cookies = options.cookieProvider
        ? await options.cookieProvider.bind({
            documentId,
            website: website.href,
            topLevelURL: options.topLevelURL ?? website.href,
            siteForCookiesURL: options.topLevelURL ?? website.href,
          })
        : undefined;
      if (!live) {
        cookies?.dispose();
        return;
      }
      if (cookies) disposers.push(cookies.dispose);
      const snapshot = durable
        ? undefined
        : await options.vault!.snapshot(website.origin);
      if (!live) return;
      const channels = Array.from({ length: 4 }, () => new MessageChannel());
      control = channels[0].port1;
      const storage = durable
        ? undefined
        : bindSandboxDocument({
            documentId,
            website: website.href,
            frontendOrigin,
            port: channels[1].port1,
            vault: options.vault!,
          });
      const indexedDB = bindSandboxIndexedDB({
        documentId,
        website: website.href,
        frontendOrigin,
        port: channels[2].port1,
        factory: options.factory,
        profileId: options.profileId,
        profileContextId: options.profileContextId,
        limits: { quotaBytes: getProfileLimits(options.profileId).idbBytes },
      });
      const network = bindSandboxNetwork({
        documentId,
        documentURL: website.href,
        frontendOrigin,
        forbiddenOrigins: options.forbiddenOrigins,
        port: channels[3].port1,
        fetch: options.fetch,
        originalPolicy,
      });
      const cacheChannel = options.selfBootContent
        ? new MessageChannel()
        : undefined;
      if (cacheChannel) {
        const caches = bindSandboxCaches({
          documentId,
          website: website.href,
          frontendOrigin,
          port: cacheChannel.port1,
          factory: options.factory,
          profileId: options.profileId,
        });
        disposers.push(caches.dispose, () => cacheChannel.port2.close());
      }
      if (storage) disposers.push(storage.dispose);
      else {
        channels[1].port1.close();
        channels[1].port2.close();
      }
      disposers.push(indexedDB.dispose, network.dispose);
      const workers =
        options.selfBootContent && originalPolicy
          ? createSandboxWorkerBroker({
              enforceOriginalPolicy: !sameOrigin,
              documentId,
              documentURL: website.href,
              frontendOrigin,
              forbiddenOrigins: options.forbiddenOrigins,
              originalPolicy,
              fetch: options.fetch,
              workerFetch: options.workerFetch,
              factory: options.factory,
              profileId: options.profileId,
              profileContextId: options.profileContextId,
              channel: () =>
                new (owner as Window & typeof globalThis).MessageChannel(),
              post: (message, transfer) =>
                control!.postMessage(message, transfer),
            })
          : undefined;
      if (workers) disposers.push(workers.dispose);
      const renderer =
        options.selfBootContent &&
        originalPolicy &&
        options.rendererProvider &&
        ["https://chatgpt.com", "https://chat.openai.com"].includes(
          website.origin,
        )
          ? createSandboxRenderer({
              window: owner as Window & typeof globalThis,
              parentWindow: documentWindow()!,
              documentId,
              website: website.href,
              policy: originalPolicy,
              active: () => live && bound,
              fetch: options.fetch,
              reserveHelper: (input) =>
                options.rendererProvider!.reserveRenderer(input),
              post: (message) => control!.postMessage(message),
            })
          : undefined;
      if (renderer) disposers.push(renderer.dispose);
      const children = new Map<
        number,
        {
          binding: ReturnType<typeof createSandboxDocument>;
          slot: number;
          window: Window;
        }
      >();
      const cancelChild = (requestId: number) => {
        const child = children.get(requestId);
        if (!child) return;
        children.delete(requestId);
        nestedBudget.active--;
        child.binding.dispose();
      };
      disposers.push(() => {
        for (const id of [...children.keys()]) cancelChild(id);
      });
      const nestedResult = (
        requestId: number,
        phase: string,
        values: object = {},
      ) => {
        if (live && bound)
          control!.postMessage({
            protocol: PROTOCOL,
            documentId,
            type: "nested-result",
            requestId,
            phase,
            ...values,
          });
      };
      const receiveNested = (message: any, portCount: number) => {
        if (
          !options.selfBootContent ||
          !options.sourceProvider ||
          !options.frameProvider ||
          !originalPolicy ||
          portCount
        )
          return false;
        if (
          message.type === "nested-cancel" &&
          allowedKeys(message, [
            "protocol",
            "documentId",
            "type",
            "requestId",
          ]) &&
          Number.isSafeInteger(message.requestId)
        ) {
          cancelChild(message.requestId);
          return true;
        }
        if (message.type !== "nested-reserve") return false;
        const requestId = message.requestId;
        if (
          !allowedKeys(message, [
            "protocol",
            "documentId",
            "type",
            "requestId",
            "url",
            "slot",
          ]) ||
          !Number.isSafeInteger(requestId) ||
          requestId < 1 ||
          typeof message.url !== "string" ||
          message.url.length > 16384 ||
          !Number.isInteger(message.slot) ||
          message.slot < 0 ||
          message.slot >= 32
        )
          return true;
        try {
          if (
            children.has(requestId) ||
            nestedBudget.active >= 32 ||
            (options.nested?.depth ?? 0) >= 8
          )
            throw Error("nested_document_limit");
          const parent = documentWindow()!,
            child = parent.frames[message.slot];
          if (!child || child === parent || child.parent !== parent)
            throw Error("nested_document_window_denied");
          const target = new URL(
            originalPolicy.upgradeURL(new URL(message.url, website.href).href),
          );
          logicalStorageOrigin(target.href);
          if (
            forbidden.some(
              (value) => new URL(value).hostname === target.hostname,
            )
          )
            throw Error("nested_document_destination_denied");
          originalPolicy.checkURL({ url: target.href, kind: "frame" });
          for (const [id, previous] of children)
            if (previous.window === child) cancelChild(id);
          const childSlot = () => {
            try {
              if (child.parent !== parent) return -1;
              for (let i = 0; i < parent.length && i < 32; i++)
                if (parent.frames[i] === child) return i;
            } catch {}
            return -1;
          };
          nestedBudget.active++;
          const binding = createSandboxDocument({
            ...options,
            reservedDocument: undefined,
            popupOpener: undefined,
            website: target.href,
            topLevelURL: options.topLevelURL ?? website.href,
            // Same top-level sessionStorage identity, separated by logical
            // origin by the storage owner; no child chooses a profile ID.
            nestedBudget,
            nested: {
              window: child,
              parentDocumentId: documentId,
              depth: (options.nested?.depth ?? 0) + 1,
              ancestorOrigins: [
                website.origin,
                ...(options.nested?.ancestorOrigins ?? []),
              ],
              active: () => live && bound && childSlot() >= 0,
              authorize: (url) =>
                originalPolicy!.checkURL({ url, kind: "frame" }),
              publish: (frameURL, origin) =>
                nestedResult(requestId, "reserved", { frameURL, origin }),
              messageAncestor: (
                depth,
                origin,
                targetOrigin,
                payload,
                ports,
                path,
              ) => {
                const slot = childSlot();
                if (
                  !live ||
                  !bound ||
                  children.get(requestId)?.binding !== binding ||
                  slot < 0
                )
                  return;
                const sourcePath = [slot, ...path];
                if (depth === 1) {
                  if (targetOrigin !== "*" && targetOrigin !== website.origin)
                    return;
                  deliverWindowMessage(origin, payload, ports, {
                    childPath: sourcePath,
                  });
                } else
                  options.nested?.messageAncestor(
                    depth - 1,
                    origin,
                    targetOrigin,
                    payload,
                    ports,
                    sourcePath,
                  );
              },
            },
            onNavigation: (next) => {
              // A new child document requires a fresh document-bound grant.
              nestedResult(requestId, "navigate", { url: next });
              cancelChild(requestId);
            },
            onTelemetry: undefined,
            onContentState: (state, failure) => {
              if (state === "ready") nestedResult(requestId, "ready");
              else {
                nestedResult(requestId, "error", {
                  code: failure?.code ?? "nested_document_content_failed",
                });
                cancelChild(requestId);
              }
            },
          });
          children.set(requestId, {
            binding,
            slot: message.slot,
            window: child,
          });
          void binding.ready.catch(() => {
            nestedResult(requestId, "error");
            cancelChild(requestId);
          });
        } catch {
          nestedResult(requestId, "error");
        }
        return true;
      };
      const popups =
        options.selfBootContent &&
        options.frameProvider &&
        options.sourceProvider
          ? await createSandboxPopupBroker({
              documentOrigin: options.documentOrigin,
              window: owner as Window & typeof globalThis,
              parentWindow: documentWindow()!,
              documentId,
              website: () => website.href,
              active: () => live && bound,
              reserve: (input) => options.frameProvider!.reserve(input),
              post: (message) => control!.postMessage(message),
              deliverOpener: (origin, payload, ports, popupId) =>
                deliverWindowMessage(origin, payload, ports, { popupId }),
              bind: (input) =>
                createSandboxDocument({
                  ...options,
                  website: input.website,
                  sessionId: input.sessionId,
                  topLevelURL: input.website,
                  popupContext: true,
                  controllerOpenerDepth:
                    (options.controllerOpenerDepth ?? 0) + 1,
                  reservedDocument: {
                    documentId: input.documentId,
                    nonce: input.nonce,
                    kind: "popup",
                    offer: input.offer,
                    reservation: input.reservation,
                  },
                  popupOpener: {
                    origin: website.origin,
                    deliver: input.opener,
                  },
                  nested: {
                    window: input.window,
                    parentDocumentId: documentId,
                    depth: 0,
                    ancestorOrigins: [],
                    active: () => live && bound && !input.window.closed,
                    publish: () => {},
                    authorize: () => {},
                    messageAncestor: () => {},
                  },
                  onContentState: (state) => input.state(state === "ready"),
                  onTelemetry: undefined,
                  onNavigation: () => input.state(false),
                }),
            })
          : undefined;
      if (popups) {
        if (!live) {
          popups.dispose();
          return;
        }
        disposers.push(popups.dispose);
      }
      const socketChannel = options.webSocketConnect
        ? new MessageChannel()
        : undefined;
      if (socketChannel) {
        const { bindOpaqueWebSockets } = await import("./opaque-websocket.ts");
        if (!live) {
          socketChannel.port1.close();
          socketChannel.port2.close();
          return;
        }
        const sockets = bindOpaqueWebSockets({
          port: socketChannel.port1,
          documentId,
          documentURL: website.href,
          frontendOrigin,
          forbiddenOrigins: options.forbiddenOrigins,
          connect: (url, protocols, context, events) => {
            const destination = originalPolicy?.upgradeURL(url) ?? url;
            originalPolicy?.checkURL({ url: destination, kind: "connect" });
            return options.webSocketConnect!(
              destination,
              protocols,
              context,
              events,
            );
          },
        });
        disposers.push(sockets.dispose);
      }
      control.onmessage = (event) => {
        const message = event.data;
        if (
          !live ||
          !message ||
          message.protocol !== PROTOCOL ||
          message.documentId !== documentId
        )
          return;
        if (bound && popups?.receive(message, event.ports)) return;
        if (
          bound &&
          message.type === "window-message" &&
          message.popupOpener === true &&
          options.popupOpener
        ) {
          if (typeof message.targetOrigin === "string")
            options.popupOpener.deliver(
              website.origin,
              message.targetOrigin,
              message.payload,
              [...event.ports],
            );
          return;
        }
        if (
          bound &&
          message.type === "window-message" &&
          allowedKeys(message, [
            "protocol",
            "documentId",
            "type",
            "ancestorDepth",
            "childRequestId",
            "targetOrigin",
            "payload",
          ])
        ) {
          if (
            typeof message.targetOrigin !== "string" ||
            message.targetOrigin.length > 2048
          )
            return;
          const targetOrigin = message.targetOrigin;
          try {
            if (
              targetOrigin !== "*" &&
              new URL(targetOrigin).origin !== targetOrigin
            )
              return;
          } catch {
            return;
          }
          if (
            Number.isInteger(message.ancestorDepth) &&
            message.ancestorDepth >= 1 &&
            message.ancestorDepth <= (options.nested?.depth ?? 0) &&
            message.childRequestId === undefined
          )
            options.nested!.messageAncestor(
              message.ancestorDepth,
              website.origin,
              targetOrigin,
              message.payload,
              [...event.ports],
              [],
            );
          else if (
            Number.isSafeInteger(message.childRequestId) &&
            message.ancestorDepth === undefined
          ) {
            const child = children.get(message.childRequestId);
            if (
              child?.binding.live &&
              (targetOrigin === "*" ||
                targetOrigin === child.binding.logicalOrigin)
            )
              child.binding.receiveWindowMessage(
                website.origin,
                message.payload,
                [...event.ports],
                { ancestorDepth: 1 },
              );
          }
          return;
        }
        if (bound && receiveNested(message, event.ports.length)) return;
        if (bound && workers?.receive(message, event.ports.length)) return;
        if (bound && renderer?.receive(message, event.ports.length)) return;
        if (
          !bound &&
          message.type === "bound" &&
          allowedKeys(message, ["protocol", "documentId", "type"])
        ) {
          const initialize = () => {
            if (!live || bound) return;
            control!.postMessage({
              protocol: PROTOCOL,
              documentId,
              type: "initialize",
              website: website.href,
              rendererEnabled: !!renderer,
              nestedEnabled:
                !!options.sourceProvider && !!options.frameProvider,
              nestedDocument: !!options.nested,
              ancestorOrigins: options.nested?.ancestorOrigins ?? [],
              popupContext: options.popupContext === true,
              controllerOpenerDepth: options.controllerOpenerDepth ?? 0,
              openerOrigin: options.popupOpener?.origin,
              popupEntries: popups?.entries() ?? [],
              snapshot,
              storageEndpoint: durable?.endpoint,
              cookieEndpoint: cookies?.endpoint,
              ...(preparedSource
                ? {
                    source: {
                      url: preparedSource.url,
                      html: preparedSource.html,
                      contentPolicies: preparedSource.contentPolicies,
                      baseURL: logicalBaseURL,
                    },
                  }
                : {}),
              ...(nativeResources
                ? { nativeResourceOrigin: nativeResources.resourceOrigin }
                : {}),
            });
            bound = true;
            owner.clearTimeout(timer);
            fulfill();
          };
          // In the self-boot path the blank bootstrap's initial native load must
          // settle before its same-realm document.write can cause another load.
          if (options.selfBootContent && !loaded)
            initializeAfterLoad = initialize;
          else initialize();
        } else if (
          bound &&
          options.selfBootContent &&
          message.type === "document-content" &&
          allowedKeys(message, [
            "protocol",
            "documentId",
            "type",
            "phase",
            "failure",
          ])
        ) {
          if (message.phase === "start" && !contentStarted) {
            contentStarted = true;
            contentLoad = true;
            // Arm the one expected load before allowing document.open/write.
            // Message and load task sources need not otherwise arrive in order.
            control!.postMessage({
              protocol: PROTOCOL,
              documentId,
              type: "permit-document-content",
            });
          } else if (
            options.nested &&
            contentStarted &&
            message.phase === "loaded"
          ) {
            if (!contentChallenge && !contentAttested) load();
          } else if (contentStarted && message.phase === "ready") {
            contentReady = true;
            // Auxiliary document.write can settle without another native
            // Window load. Its original private endpoint must still attest the
            // captured native Document after reporting content readiness.
            if (
              options.nested &&
              contentLoad &&
              !contentChallenge &&
              !contentAttested
            )
              load();
            publishContent();
          } else if (message.phase === "error") {
            const failure =
              message.failure === undefined
                ? undefined
                : cleanDocumentBootFailure(message.failure);
            if (message.failure !== undefined && !failure) return;
            failContent(
              new Error(failure?.code ?? "sandbox_document_content_failed"),
              failure,
            );
          }
        } else if (
          bound &&
          options.selfBootContent &&
          message.type === "document-attestation" &&
          allowedKeys(message, [
            "protocol",
            "documentId",
            "type",
            "nonce",
            "active",
          ]) &&
          contentChallenge &&
          message.nonce === contentChallenge &&
          typeof message.active === "boolean"
        ) {
          owner.clearTimeout(attestationTimer);
          contentChallenge = undefined;
          if (!message.active)
            failContent(new Error("sandbox_document_identity_changed"));
          else {
            contentAttested = true;
            publishContent();
          }
        } else if (
          bound &&
          (!options.selfBootContent || contentAttested) &&
          message.type === "page-telemetry" &&
          allowedKeys(message, ["protocol", "documentId", "type", "event"])
        ) {
          const event = cleanPageTelemetry(message.event, website.origin);
          if (event) options.onTelemetry?.(event);
        } else if (
          bound &&
          !navigationRequested &&
          message.type === "form-navigation" &&
          allowedKeys(message, ["protocol", "documentId", "type", "navigation"])
        ) {
          const navigation = cleanFormNavigation(message.navigation);
          if (!navigation || !options.onNavigation) return;
          try {
            const url = new URL(
              originalPolicy?.upgradeURL(navigation.url) ?? navigation.url,
            );
            logicalStorageOrigin(url.href);
            if (
              forbidden.some(
                (value) => new URL(value).hostname === url.hostname,
              )
            )
              return;
            originalPolicy?.checkURL({ url: url.href, kind: "form" });
            navigationRequested = true;
            options.onNavigation(
              url.href,
              Object.freeze({
                ...navigation,
                url: url.href,
                initiatorURL: website.href,
                authorizeURL(next: string, redirects: number) {
                  originalPolicy?.checkURL({
                    url: next,
                    kind: "form",
                    redirectCount: redirects,
                  });
                },
              }),
            );
          } catch {}
        } else if (
          bound &&
          message.type === "navigate" &&
          typeof message.url === "string" &&
          message.url.length <= 16384 &&
          allowedKeys(message, ["protocol", "documentId", "type", "url"])
        ) {
          try {
            const url = new URL(message.url, website);
            logicalStorageOrigin(url.href);
            if (
              forbidden.some(
                (value) => new URL(value).hostname === url.hostname,
              )
            )
              return;
            options.onNavigation?.(url.href);
          } catch {}
        }
      };
      control.onmessageerror = () =>
        dispose(new Error("sandbox_control_message_failed"));
      control.start();
      offer.postMessage(
        {
          protocol: PROTOCOL,
          type: "bind-capabilities",
          documentId,
          nonce,
          capabilities: [
            ...(cookies ? ["cookies"] : []),
            ...(socketChannel ? ["webSocket"] : []),
            ...(nativeResources ? ["nativeResources"] : []),
            ...(cacheChannel ? ["caches"] : []),
          ],
        },
        [
          ...channels.map((channel, index) =>
            index === 1 && durable ? durable.port : channel.port2,
          ),
          ...(cookies ? [cookies.port] : []),
          ...(socketChannel ? [socketChannel.port2] : []),
          ...(nativeResources ? [nativeResources.port] : []),
          ...(cacheChannel ? [cacheChannel.port2] : []),
        ],
      );
    } catch (error) {
      dispose(error as Error);
    }
  }
  owner.addEventListener("message", receive);
  frame.addEventListener("load", load);
  async function prepareFrame() {
    try {
      if (options.sourceProvider) {
        preparedSource = await options.sourceProvider.prepare({
          documentId,
          website: website.href,
          signal: preparation.signal,
          ...(options.nested
            ? {
                parentDocumentId: options.nested.parentDocumentId,
                topLevelURL: options.topLevelURL,
              }
            : {}),
        });
        if (!live) return;
        const finalURL = new URL(preparedSource.url);
        logicalStorageOrigin(finalURL.href);
        if (
          forbidden.some(
            (value) => new URL(value).hostname === finalURL.hostname,
          ) ||
          typeof preparedSource.html !== "string" ||
          preparedSource.html.length > 8 * 1024 * 1024 ||
          !Array.isArray(preparedSource.contentPolicies) ||
          preparedSource.contentPolicies.some(
            (value) => typeof value !== "string",
          ) ||
          !["unsafe-none", "require-corp", "credentialless"].includes(
            preparedSource.coep,
          )
        )
          throw new TypeError("Invalid trusted website source.");
        // Redirects choose the final logical site's storage/cookie/network
        // authority BEFORE any document capability is registered or offered.
        options.nested?.authorize(finalURL.href);
        website.href = finalURL.href;
        if (sameOrigin) preparedSource = { ...preparedSource, contentPolicies: [], coep: "unsafe-none" };
        originalPolicy = createOriginalDocumentPolicy({
          documentURL: website.href,
          contentPolicies: preparedSource.contentPolicies,
        });
        // Authorize ORIGINAL inline bytes and element metadata in trusted code,
        // before RuntimeKit rewriting or construction of any website port.
        const plan = await createOriginalDocumentPlan({
          documentURL: website.href,
          policy: originalPolicy,
          natives: {
            DOMParser: (owner as Window & typeof globalThis).DOMParser,
          },
        }).prepare(preparedSource.html, preparation.signal);
        if (!live) return;
        preparedSource = { ...preparedSource, html: plan.html };
        logicalBaseURL = plan.baseURL;
      }
      const reservation =
        options.reservedDocument?.reservation ??
        (await options.frameProvider?.reserve({
          documentId,
          website: website.href,
          signal: preparation.signal,
          bootstrapNonce: nonce,
          ...(options.reservedDocument
            ? { kind: options.reservedDocument.kind }
            : {}),
          ...(options.nested
            ? { parentDocumentId: options.nested.parentDocumentId }
            : {}),
        }));
      if (!live) {
        reservation?.dispose?.();
        return;
      }
      if (reservation) {
        if (
          reservation.frameURL !==
          frontendOrigin +
            (options.reservedDocument ? "/browse/popup/" : "/browse/frame/") +
            documentId
        )
          throw new TypeError(
            "Frame reservation changed frontend document URL.",
          );
        if (options.nested && !reservation.serverBootstrapNonce)
          throw new TypeError(
            "Nested documents require private server bootstrap nonces",
          );
        if (reservation.serverBootstrapNonce) frameURL.hash = "";
        if (reservation.dispose) disposers.push(reservation.dispose);
      }
      if (options.nativeResourceProvider) {
        nativeResources = await options.nativeResourceProvider.bind({
          documentId,
          website: website.href,
          topLevelURL: options.topLevelURL ?? website.href,
          contentPolicies: preparedSource!.contentPolicies.slice(),
          coep: preparedSource!.coep,
        });
        if (!live) {
          nativeResources.dispose();
          return;
        }
        disposers.push(nativeResources.dispose);
        if (nativeResources.resourceOrigin !== reservation!.resourceOrigin)
          throw new TypeError(
            "Native resource provider changed selected-node policy.",
          );
        // Do not await enrollment readiness before transferring the original
        // peer port: that enrollment must be performed inside THIS opaque realm.
        void nativeResources.ready.catch(() => {
          if (live) failContent(new Error("sandbox_native_resources_failed"));
        });
      }
      if (!live) return;
      if (options.nested) {
        if (!options.nested.active()) throw Error("nested_parent_stale");
        options.nested.publish(frameURL.href, website.origin);
        if (options.reservedDocument)
          void receive(options.reservedDocument.offer);
      } else {
        frame.src = frameURL.href;
        options.container.appendChild(frame);
      }
    } catch (error) {
      dispose(error as Error);
    }
  }
  // Keep the old synchronous lifecycle harness unchanged when no provider is
  // requested; actual source preparation may await only in trusted code.
  if (!options.sourceProvider && !options.frameProvider) {
    frame.src = frameURL.href;
    options.container.appendChild(frame);
  } else void prepareFrame();
  return {
    frame,
    documentId,
    ready,
    get logicalOrigin() {
      return website.origin;
    },
    receiveWindowMessage: deliverWindowMessage,
    command(value: PageCommand) {
      if (!live || !bound || (options.selfBootContent && !contentAttested))
        return false;
      const command = cleanPageCommand(value);
      if (!command)
        throw new TypeError("Invalid document presentation command");
      control!.postMessage({
        protocol: PROTOCOL,
        documentId,
        type: "page-command",
        sequence: ++pageSequence,
        command,
      });
      return true;
    },
    dispose,
    get live() {
      return live;
    },
  };
}

/** Actual built runtime contract, distinct from the generic lifecycle harness.
 * Missing durable/cookie providers fail before creating a blank bound frame. */
export function createOpaqueWebsiteDocument(
  options: Options & {
    storageProvider: NonNullable<Options["storageProvider"]>;
    cookieProvider: NonNullable<Options["cookieProvider"]>;
    sessionId: string;
  },
) {
  if (!options.storageProvider || !options.cookieProvider || !options.sessionId)
    throw new TypeError(
      "Opaque self-boot requires durable storage and cookie providers.",
    );
  return createSandboxDocument({ ...options, selfBootContent: true });
}
