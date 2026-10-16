/** Self-boot inside the browser-enforced opaque document. Trusted assets and
 * original-document ports arrive before website scripts; parent DOM injection,
 * native service workers and relay credentials are not used here. The resource
 * graph's explicit unsupported paths remain release gates, not native fallbacks.
 */
import {
  createOpaqueNetworkClient,
  createPinnedOpaqueRewriter,
  bootOpaqueRuntimeClient,
} from "./opaque-runtime-adapter.ts";
import { createSandboxStorageFacades } from "./sandbox-local-storage.ts";
import {
  createSandboxIndexedDB,
  installSandboxIndexedDB,
} from "./sandbox-idb.ts";
import { createSandboxDocumentCookie } from "./sandbox-document-cookie.ts";
import { captureOpaqueCacheNatives, createOpaqueCaches } from "./opaque-caches.ts";
import { createOpaqueRendererClient } from "./opaque-renderer-client.ts";
import { installOpaqueRenderer } from "./opaque-renderer.ts";
import { createOpaqueResourceGraph } from "./opaque-resource-graph.ts";
import { installOpaqueDynamicResources } from "./opaque-dynamic-resources.ts";
import { createOpaqueXMLHttpRequest } from "./opaque-xhr.ts";
import { createOpaqueWebSocket } from "./opaque-websocket.ts";
import { createNativeResourceClient } from "./native-resource-owner.ts";
import { installDocumentControls } from "./document-controls.ts";
import { captureOpaqueFormNatives, installOpaqueForms } from "./opaque-forms.ts";
import {
  createOriginalDocumentPolicy,
  originalExecutionCSP,
} from "./original-document-policy.ts";
import { captureOriginalTrustedTypes } from "./original-trusted-types.ts";
import { createOpaqueWorkerManager } from "./opaque-workers.ts";
import { createOpaqueWorkerGrants } from "./opaque-worker-grants.ts";
declare const __OPAQUE_WORKER_BOOTSTRAP__:string;
import {
  describeDocumentBootFailure,
  type DocumentBootStage,
} from "./document-boot-diagnostics.ts";

/** Capture before website hooks. A WindowProxy is reusable across navigation;
 * reading its native current Document must still equal this original object. */
export function captureOpaqueDocumentIdentity(
  owner: Window & typeof globalThis,
) {
  const document = owner.document;
  const getter = Object.getOwnPropertyDescriptor(owner, "document")?.get;
  if (!getter) throw new TypeError("Native document identity getter required");
  const activeDocument = getter.bind(owner);
  return () => {
    try {
      return activeDocument() === document;
    } catch {
      return false;
    }
  };
}

export function installOpaqueDocument(options: {
  global: Window & typeof globalThis;
  core: any;
  wasm: Uint8Array;
}) {
  const owner = options.global;
  if (owner.origin !== "null")
    throw new TypeError("Opaque document origin required");
  const document = owner.document,
    workerBootstrapSource=typeof __OPAQUE_WORKER_BOOTSTRAP__==="string"?__OPAQUE_WORKER_BOOTSTRAP__:undefined,
    workerModule=workerBootstrapSource?new owner.WebAssembly.Module(options.wasm as BufferSource):undefined,
    formNatives = captureOpaqueFormNatives(owner),
    trustedTypes = captureOriginalTrustedTypes(owner),
    activeDocument = captureOpaqueDocumentIdentity(owner),
    nativeOpen = owner.Document.prototype.open.bind(document),
    nativeWrite = owner.Document.prototype.write.bind(document),
    nativeClose = owner.Document.prototype.close.bind(document),
    nativeAdd = owner.addEventListener.bind(owner),
    nativeRemove = owner.removeEventListener.bind(owner),
    nativeApply = owner.Reflect.apply,
    nativeMessageData = Object.getOwnPropertyDescriptor(
      owner.MessageEvent.prototype,
      "data",
    )!.get!;
  const natives = {
    DOMParser: owner.DOMParser,
    Blob: owner.Blob,
    createObjectURL: owner.URL.createObjectURL.bind(owner.URL),
    revokeObjectURL: owner.URL.revokeObjectURL.bind(owner.URL),
    importModule: owner.Function("url", "return import(url)") as (
      url: string,
    ) => Promise<unknown>,
    appendChild: owner.Node.prototype.appendChild,
    setAttribute: trustedTypes.setAttribute,
    setScriptText: trustedTypes.setScriptText,
    parseFromString: trustedTypes.parseFromString,
    getAttribute: owner.Element.prototype.getAttribute,
    removeAttribute: owner.Element.prototype.removeAttribute,
    insertBefore: owner.Node.prototype.insertBefore,
  };
  const networkNatives = {
    Request: owner.Request,
    Response: owner.Response,
    Headers: owner.Headers,
  };
  const workerNatives={Worker:owner.Worker,Blob:owner.Blob,createObjectURL:owner.URL.createObjectURL.bind(owner.URL),revokeObjectURL:owner.URL.revokeObjectURL.bind(owner.URL)};
  let claimed = false,
    disposed = false;
  const cleanup: (() => void)[] = [];
  cleanup.push(trustedTypes.dispose);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    nativeRemove("atlas:document-capabilities", receive);
    for (const close of cleanup.splice(0).reverse()) {
      try {
        close();
      } catch {}
    }
  };
  const receive = (event: Event) => {
    if (claimed || disposed) return;
    const grant = (event as CustomEvent).detail;
    if (
      !grant ||
      typeof grant.documentId !== "string" ||
      ![
        grant.control,
        grant.storage,
        grant.indexedDB,
        grant.network,
        grant.cookies,
      ].every((port) => port instanceof owner.MessagePort)
    )
      return;
    claimed = true;
    nativeRemove("atlas:document-capabilities", receive);
    const { documentId, control } = grant;
    // Capture before RuntimeKit hooks MessagePort APIs. The control capability
    // remains in this closure; no website global exports it.
    const send = control.postMessage.bind(control);
    const listenControl = control.addEventListener.bind(control),
      removeControl = control.removeEventListener.bind(control),
      startControl = control.start.bind(control),
      closeControl = control.close.bind(control);
    let initialized = false,
      contentWritten = false;
    let renderer: ReturnType<typeof createOpaqueRendererClient> | undefined;
    let pageControls: ReturnType<typeof installDocumentControls> | undefined,
      pageSequence = 0;
    let permitResolve: (() => void) | undefined,
      permitReject: ((error: Error) => void) | undefined,
      permitTimer: number | undefined;
    const receiveControl = async (event: MessageEvent) => {
      const data = nativeApply(nativeMessageData, event, []);
      if (disposed || data?.protocol !== 2 || data.documentId !== documentId)
        return;
      if (initialized && renderer?.receive(data)) return;
      if (initialized && data.type === "permit-document-content") {
        permitResolve?.();
        return;
      }
      if (initialized && data.type === "page-controls-activate") {
        if (contentWritten && activeDocument()) pageControls?.activate();
        return;
      }
      if (
        initialized &&
        data.type === "page-command" &&
        Number.isSafeInteger(data.sequence) &&
        data.sequence === pageSequence + 1
      ) {
        if (
          contentWritten &&
          activeDocument() &&
          pageControls?.command(data.command)
        )
          pageSequence = data.sequence;
        return;
      }
      if (
        initialized &&
        data.type === "attest-document" &&
        typeof data.nonce === "string" &&
        /^[a-f0-9]{32}$/.test(data.nonce)
      ) {
        let active = false;
        try {
          active = contentWritten && activeDocument();
        } catch {}
        send({
          protocol: 2,
          documentId,
          type: "document-attestation",
          nonce: data.nonce,
          active,
        });
        return;
      }
      if (initialized || data.type !== "initialize") return;
      initialized = true;
      let bootStage: DocumentBootStage = "source";
      try {
        const website = new URL(data.website),
          frontend = owner.location.origin;
        if (
          !/^https?:$/.test(website.protocol) ||
          website.origin === frontend ||
          website.username ||
          website.password
        )
          throw new TypeError("Invalid logical document URL");
        bootStage = "storage";
        const storage = await createSandboxStorageFacades({
          documentId,
          endpoint: data.storageEndpoint,
          port: grant.storage,
          window: owner,
        });
        cleanup.push(storage.dispose);
        bootStage = "cookies";
        const cookies = await createSandboxDocumentCookie({
          documentId,
          endpoint: data.cookieEndpoint,
          port: grant.cookies,
          window: owner,
        });
        cleanup.push(cookies.dispose);
        bootStage = "indexeddb";
        const indexedDB = createSandboxIndexedDB(grant.indexedDB, documentId);
        cleanup.push(() => indexedDB.dispose());
        bootStage = "network";
        const network = createOpaqueNetworkClient({
          port: grant.network,
          documentId,
          documentURL: website.href,
          natives: networkNatives,
        });
        cleanup.push(network.dispose);
        const caches = grant.caches instanceof owner.MessagePort
          ? createOpaqueCaches({
              port: grant.caches, documentId, documentURL: website.href,
              fetch: network.fetch,
              describeResponse: network.describeCacheResponse,
              rememberResponse: network.rememberCacheResponse,
              natives: captureOpaqueCacheNatives(owner),
            })
          : undefined;
        if (caches) cleanup.push(caches.dispose);
        bootStage = "native-enrollment";
        const nativeResources =
          grant.nativeResources instanceof owner.MessagePort
            ? createNativeResourceClient({
                port: grant.nativeResources,
                documentId,
                resourceOrigin: data.nativeResourceOrigin,
              })
            : undefined;
        if (nativeResources) {
          cleanup.push(nativeResources.dispose);
          // Captured native Image/src setter enrolls before RuntimeKit or site
          // prototypes can observe the one-use gateway cookie rendezvous.
          await nativeResources.ready;
        }
        const prefix = frontend + "/browse/logical/" + documentId + "/";
        const rewriter = createPinnedOpaqueRewriter({
          ...options,
          wasmModule:workerModule,
          documentURL: website.href,
          prefix,
        });
        bootStage = "policy";
        const originalPolicy = data.source
          ? createOriginalDocumentPolicy({
              documentURL: website.href,
              contentPolicies: data.source.contentPolicies,
            })
          : undefined;
        const graph = createOpaqueResourceGraph({
          documentURL: website.href,
          documentBaseURL: data.source?.baseURL ?? website.href,
          network,
          rewriter,
          document,
          natives,
          nativeResources,
          originalPolicy,
          executionPolicy: originalPolicy
            ? originalExecutionCSP(originalPolicy, data.nativeResourceOrigin,!!workerBootstrapSource)
            : undefined,
        });
        cleanup.push(graph.dispose);
        bootStage = "source";
        let sourceHTML: string;
        if (data.source) {
          if (
            data.source.url !== website.href ||
            typeof data.source.html !== "string" ||
            data.source.html.length > 8 * 1024 * 1024
          )
            throw new TypeError("Invalid trusted document source");
          sourceHTML = data.source.html;
        } else {
          if (nativeResources)
            throw new TypeError(
              "Native resources require original policy-qualified source",
            );
          const source = await network.fetch(website.href, {
            credentials: "include",
            mode: "same-origin",
          });
          if (
            !source.ok ||
            !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
              source.headers.get("content-type") || "",
            )
          )
            throw new TypeError("Website document response failed");
          sourceHTML = await source.text();
        }
        bootStage = "graph";
        const html = await graph.prepareDocument(sourceHTML);
        if (disposed) return;
        const xhr = createOpaqueXMLHttpRequest({
          window: owner,
          documentURL: () => boot.client.url.href,
          fetch: network.fetch,
          request: network.request,
        });
        cleanup.push(xhr.dispose);
        const sockets =
          grant.webSocket instanceof owner.MessagePort
            ? createOpaqueWebSocket({
                port: grant.webSocket,
                documentId,
                documentURL: () => boot.client.url.href,
                window: owner,
              })
            : undefined;
        if (sockets) cleanup.push(sockets.dispose);
        const workerGrants=workerBootstrapSource?createOpaqueWorkerGrants({port:control,documentId}):undefined;
        if(workerGrants)cleanup.push(workerGrants.dispose);
        const workers=workerBootstrapSource&&workerGrants&&originalPolicy?createOpaqueWorkerManager({global:owner,documentURL:website.href,documentBaseURL:data.source?.baseURL??website.href,network,rewriter,coreSource:"",wasm:options.wasm,wasmModule:workerModule,runtimeModuleURL:"",bootstrapSource:workerBootstrapSource,parentPolicy:originalPolicy,prefix,natives:workerNatives,bindWorker:binding=>workerGrants.bind(binding)}):undefined;
        if(workers)cleanup.push(workers.dispose);
        bootStage = "runtime";
        const boot = bootOpaqueRuntimeClient({
          ...options,
          documentURL: website.href,
          prefix,
          network,
          localStorage: storage.localStorage,
          sessionStorage: storage.sessionStorage,
          cookies,
          trustedTypes,
          installCaches: caches ? (_client, global) => caches.install(global) : undefined,
          installIndexedDB: (_client, global) =>
            installSandboxIndexedDB(global, indexedDB),
          installXHR: (_client, global) =>
            Object.defineProperty(global, "XMLHttpRequest", {
              configurable: true,
              writable: true,
              value: xhr.XMLHttpRequest,
            }),
          installWebSocket: sockets ? () => sockets.install() : undefined,
          installWorkers:workers?(_client,global)=>Object.defineProperty(global,"Worker",{configurable:true,writable:true,value:workers.Worker}):undefined,
          onNavigate: (url) =>
            send({ protocol: 2, documentId, type: "navigate", url }),
          sendSetCookie: async () => {
            throw new DOMException(
              "Cookie authority is document-bound",
              "SecurityError",
            );
          },
          importModule: (base, specifier) =>
            graph.importModule(base, specifier),
          resolveModule: (base, specifier) =>
            graph.resolveModule(base, specifier),
        });
        cleanup.push(boot.dispose);
        for (const port of [
          control,
          grant.storage,
          grant.indexedDB,
          grant.network,
          grant.cookies,
          ...(sockets ? [grant.webSocket] : []),
          ...(nativeResources ? [grant.nativeResources] : []),
          ...(caches ? [grant.caches] : []),
        ])
          boot.client.nativeMessagePorts.add(port);
        const resources = installOpaqueDynamicResources({
          global: owner,
          client: boot.client,
          graph,
        });
        cleanup.push(resources.dispose);
        if (originalPolicy)
          trustedTypes.install({ policy: originalPolicy, rewriter });
        // document.open/write replaces the initial bootstrap DOM in this SAME
        // opaque realm. It neither navigates to a node nor injects via parent.
        const permit = new Promise<void>((resolve, reject) => {
          permitResolve = () => {
            owner.clearTimeout(permitTimer);
            permitResolve = undefined;
            permitReject = undefined;
            resolve();
          };
          permitReject = reject;
          permitTimer = owner.setTimeout(
            () => reject(new Error("Document content permission timed out")),
            10000,
          );
        });
        send({
          protocol: 2,
          documentId,
          type: "document-content",
          phase: "start",
        });
        await permit;
        if (disposed) return;
        bootStage = "write";
        nativeOpen();
        if(data.rendererEnabled === true) {
          renderer=createOpaqueRendererClient({window:owner,documentId,frontend,live:()=>!disposed&&activeDocument(),send});
          cleanup.push(renderer.dispose);
          const removeRenderer=installOpaqueRenderer(owner,boot.client,{fetchResource:async()=>{throw Error("RENDERER_TRUSTED_BROKER_REQUIRED")},reserveNavigation:(url,element)=>renderer!.reserve(url,element),report:()=>{}});
          if(removeRenderer)cleanup.push(removeRenderer);
        }
        pageControls = installDocumentControls({
          window: owner,
          documentId,
          documentURL: website.href,
          liveDocument: () => !disposed && activeDocument(),
          report: (event) =>
            send({ protocol: 2, documentId, type: "page-telemetry", event }),
        });
        cleanup.push(pageControls.dispose);
        const forms = installOpaqueForms({
          window: owner, documentURL:website.href, baseURL:data.source?.baseURL ?? website.href,
          natives:formNatives, policy:originalPolicy,
          forbiddenOrigins:[frontend,...(data.nativeResourceOrigin?[data.nativeResourceOrigin]:[])],
          restoreURL:value=>value.startsWith(prefix)||value.startsWith(new URL(prefix).pathname)?rewriter.restoreURL(value):value,
          liveDocument:()=>!disposed&&activeDocument(),
          navigate:navigation=>send({protocol:2,documentId,type:"form-navigation",navigation}),
        });
        cleanup.push(forms.dispose);
        trustedTypes.write(document, html);
        nativeClose();
        contentWritten = true;
        // document.open removes Window listeners. Install this only after that
        // operation; MessagePort listeners and the private control closure stay.
        nativeAdd("pagehide", dispose);
        cleanup.push(() => nativeRemove("pagehide", dispose));
        send({
          protocol: 2,
          documentId,
          type: "document-content",
          phase: "ready",
        });
      } catch (error) {
        if (disposed) return;
        send({
          protocol: 2,
          documentId,
          type: "document-content",
          phase: "error",
          failure: describeDocumentBootFailure(bootStage, error),
        });
        dispose();
      }
    };
    listenControl("message", receiveControl);
    startControl();
    cleanup.push(() => {
      owner.clearTimeout(permitTimer);
      permitReject?.(new Error("Opaque document disposed"));
      permitResolve = undefined;
      permitReject = undefined;
      removeControl("message", receiveControl);
      closeControl();
    });
  };
  nativeAdd("atlas:document-capabilities", receive);
  return { dispose };
}
