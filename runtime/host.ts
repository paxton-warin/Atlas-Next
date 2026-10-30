import {
  installDocumentGuard,
  originalDocumentTitle,
  type DocumentGuard,
} from "./site-compatibility";
import {
  sanitizeSiteModes,
  type SiteModes,
} from "./compatibility-policy";
import { DiagnosticLog, requestCategory } from "./diagnostics";
// Pinned fork bootstrap/transport; Atlas adds its frame bridge and upgrade handling.
import {
  createRelayController,
  refreshRelayCredentials,
} from "./relay-controller";
import { orderedCredentialUpdates } from "./credential-updates";
import { migrateCookies, activateWorker } from "./runtime-migration";
import { loadRuntimeConfig, watchRuntimeSession } from "./connection";
import { watchFavicon } from "./favicon";
import { matchesShortcut, normalizeShortcut } from "./panic-shortcut";
import { installPageBridge } from "./page-bridge";
import { createManagedFormSubmitter } from "./managed-form";
import { createLocalDownloadInstaller } from "./local-download";
import { attachFullscreenKeyboard } from "./fullscreen-keyboard";
import { createDirectTabUrl, directTabTarget } from "./direct-tab";
import { encodeTarget, decodeTarget } from "./url-codec";
import { installOpaqueRenderer, type OpaqueResource } from "./opaque-renderer";
import { createHttpCachePlugin } from "./http-cache";
import { createLogicalStoragePlugin } from "./logical-storage";
import {
  createScramjetProfilePlugin,
  getScramjetProfileBridge,
  neutralizeScramjetCookies,
  scramjetProfileLoadReady,
} from "./scramjet-profile";
import { installProfileWebSocketTransport } from "./scramjet-websocket";
import profileWorkerURL from "./scramjet-profile-workers.ts?worker&url";
import { createRequestHeadersPlugin } from "./request-headers";
import { createYouTubeAdblockPlugin } from "./youtube-adblock";
import { createVerifiedStylesheetPlugin } from "./verified-stylesheet";
import { createDiscordScriptSelectorPlugin } from "./discord-script-selector";
import { checkpointControllerRoot } from "./website-checkpoint";
const globals = window as any;
const submitManagedForm = createManagedFormSubmitter(window);
const installLocalDownloads = createLocalDownloadInstaller(window);
const opaqueRequests = new WeakMap<
  object,
  {
    policies: string[];
    kind: "document" | "module";
    allowOrigin?: string;
    allowCredentials?: string;
  }
>();
async function opaqueResource(
  record: any,
  client: any,
  url: URL,
  credentials: "include" | "omit" = "include",
  kind: "document" | "module" = "document",
): Promise<OpaqueResource> {
  const meta = {
    origin: new URL(client.url.href),
    base: new URL(client.url.href),
  };
  const rawClientUrl = new URL(
    globals.$runtimekit.transformUrl(
      client.url.href,
      record.frame.context,
      meta,
    ),
  );
  const request = {
    rawUrl: new URL(
      globals.$runtimekit.transformUrl(url.href, record.frame.context, meta, {
        mode: "no-cors",
        credentials,
      }),
    ),
    rawClientUrl,
    rawReferrer: rawClientUrl.href,
    referrer: rawClientUrl.href,
    // Empty destination returns original bytes, not injected/re-written JS.
    rawDestination: "",
    mode: "no-cors",
    method: "GET",
    body: null,
    cache: "no-store",
    clientId: record.frame.id + "-opaque",
    initialHeaders: globals.$runtimekit.RuntimeKitHeaders.fromRawHeaders([]),
  };
  const capture = {
    policies: [] as string[],
    kind,
    allowOrigin: undefined as string | undefined,
    allowCredentials: undefined as string | undefined,
  };
  opaqueRequests.set(request, capture);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      (async () => {
        const response = await record.frame.fetchHandler.handleFetch(request);
        reader = new Response(response.body).body!.getReader();
        if (expired) {
          await reader.cancel().catch(() => {});
          throw Error("renderer_resource_timeout");
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          size = 0;
        try {
          for (;;) {
            if (expired) throw Error("renderer_resource_timeout");
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 1024000) throw Error("renderer_resource_size");
            text += decoder.decode(next.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
        return {
          status: response.status,
          type: (response.headers.get("content-type") || "")
            .split(";")[0]
            .trim()
            .toLowerCase(),
          text,
          policies: capture.policies,
          allowOrigin: capture.allowOrigin,
          allowCredentials: capture.allowCredentials,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          void reader?.cancel().catch(() => {});
          reject(Error("renderer_resource_timeout"));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    opaqueRequests.delete(request);
  }
}
declare const __RUNTIME_REVISION__: string;
function startDiagnostics(
  record: { diagnostics?: DiagnosticLog },
  enabled: boolean,
) {
  record.diagnostics?.enable(enabled);
  if (enabled)
    record.diagnostics?.record("worker", {
      revision: __RUNTIME_REVISION__,
      state: navigator.serviceWorker.controller?.state || "missing",
      context: standalone ? "top-level" : "embedded",
    });
}
const launchParams = new URLSearchParams(location.hash.slice(1));
let ticket = launchParams.get("ticket") || "";
let youtubeAdblock = launchParams.get("adblock") !== "0";
let siteModes: SiteModes = {};
const diagnosticModes = new Map<string, boolean>();
const standalone = parent === window;
const config = await loadRuntimeConfig(ticket).catch((error) => {
  if (standalone) {
    const panel = document.createElement("main");
    panel.className = "runtime-boot-error";
    const heading = document.createElement("h1");
    heading.textContent = "Connection unavailable";
    const detail = document.createElement("p");
    detail.textContent =
      "Return to Atlas, reconnect, and open this page again.";
    panel.append(heading, detail);
    document.body.replaceChildren(panel);
  }
  throw error;
});
let relayQuery = ticket ? encodeURIComponent(ticket) + "/" : "";
let standaloneExpired = false;
const notify = (type: string, data: Record<string, unknown> = {}) => {
  if (standalone) {
    // Keep the real browser tab generic; site titles still belong to the site.
    if (type === "title") document.title = "Atlas";
    if (type === "navigation" && typeof data.url === "string") {
      if (records.get(String(data.id))?.element.hidden) return;
      const field = document.querySelector<HTMLInputElement>("#popup-address");
      if (field) field.value = data.url;
      // Keep reload/back-to-this-tab on its latest URL, without putting the
      // browsing destination or bearer ticket in HTTP query strings/referrers.
      try {
        history.replaceState(
          null,
          "",
          createDirectTabUrl(
            location.origin,
            data.url,
            ticket || undefined,
            youtubeAdblock,
            config.runtimePath,
          ),
        );
      } catch {
        // Transient about:blank popup documents have no destination to restore.
      }
    }
    const status = document.querySelector<HTMLElement>("#popup-status");
    if (status) {
      if (type === "session-refresh-needed") {
        if (
          ["SESSION_REVOKED", "INVALID_SESSION"].includes(String(data.code))
        ) {
          type = "session-expired";
        } else {
          status.textContent =
            "This direct tab needs a fresh connection. Return to Atlas and reopen it.";
          return;
        }
      }
      if (type === "session-expired") {
        standaloneExpired = true;
        status.textContent = "Session expired. Return to Atlas and reconnect.";
        document
          .querySelectorAll<
            HTMLInputElement | HTMLButtonElement
          >("#popup-toolbar input, #popup-toolbar button")
          .forEach((control) => {
            control.disabled = true;
          });
      } else if (standaloneExpired) return;
      else if (type === "error" || type === "slow")
        status.textContent = String(data.message || "Page failed to load.");
      else if (type === "loading") status.textContent = "Loading…";
      else if (type === "loaded") status.textContent = "";
    }
    return;
  }
  parent.postMessage({ atlas: 1, type, ...data }, config.appOrigin);
};
const sessionWatch = watchRuntimeSession(() => ticket, notify);
const profileBridge = config.profileRuntime === true ? getScramjetProfileBridge(window) : undefined;
if (config.profileRuntime === true && !profileBridge) {
  const message = "Your profile saves are not ready. Reopen this tab from Atlas.";
  const panel = document.createElement("main");
  const heading = document.createElement("h1");
  heading.textContent = "Website saves unavailable";
  const detail = document.createElement("p");
  detail.textContent = message;
  panel.append(heading, detail);
  document.body.replaceChildren(panel);
  notify("boot-error", { message });
  throw Error("PROFILE_RUNTIME_BRIDGE_MISSING");
}
const records = new Map<
  string,
  {
    element: HTMLIFrameElement;
    frame: any;
    engine: string;
    url?: string;
    timer?: ReturnType<typeof setTimeout>;
    disposeFavicon?: () => void;
    guards?: Map<Document, DocumentGuard>;
    renderers?: Map<Document, () => void>;
    diagnostics?: DiagnosticLog;
    profile?: ReturnType<typeof createScramjetProfilePlugin>;
    checkpointRoot?: { window: Window & typeof globalThis; document: Document; logicalURL(): string };
  }
>();
let panicKey = "";
const panicDocuments = new WeakSet<Document>();
let controller: any;
let initialization: Promise<void> | undefined;
const container = document.getElementById("frames")!;
async function init() {
  if (!profileBridge) await migrateCookies();
  const sw = await activateWorker("/worker.js");
  // Use the fork's shipped bootstrap and matching HTTP transport unchanged.
  // loadRest avoids its init() returning the old active worker during an update.
  const bootstrapPath = "/bootstrap/bootstrap-client.js";
  const { loadRest } = await import(/* @vite-ignore */ bootstrapPath);
  if (profileBridge && (!config.relayOrigin || !config.relayTicket))
    throw Error("PROFILE_RUNTIME_RELAY_MISSING");
  controller =
    config.relayOrigin && config.relayTicket
      ? await createRelayController(sw, config.relayOrigin, config.relayTicket, profileBridge ? neutralizeScramjetCookies : undefined)
      : await loadRest(sw, {
          transport: "http",
          workerPath: "/worker.js",
          streamRelayPath: "/relay/" + relayQuery,
          httpengineClientPath: "/clients/httpengine-client.js",
          runtimekitBundlePath: "/runtime/runtimekit.js",
          runtimekitWasmPath: "/runtime/runtimekit.wasm",
          runtimekitUtilsBundlePath: "/runtime/runtimekit-utils.js",
          runtimekitControllerApiPath: "/controller/controller.api.js",
          runtimekitControllerInjectPath: "/controller/controller.inject.js",
          runtimekitControllerWorkerPath: "/controller/controller.worker.js",
        });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) controller?.disposeRequestChannel?.();
  });
  controller.config.codec = { encode: encodeTarget, decode: decodeTarget };
  if (profileBridge) {
    // Keep original worker code in its normal script/module URL. The pin's
    // data: encapsulation has no hierarchical base for rewritten /~/ imports.
    controller.runtimekitConfig.flags.encapsulateWorkers = false;
    const disposeSockets = installProfileWebSocketTransport(controller.transport, profileBridge);
    window.addEventListener("pagehide", (event) => { if (!event.persisted) disposeSockets(); });
  }
  await Promise.race([
    controller.wait(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Error("Atlas connection initialization timed out.")),
        25000,
      ),
    ),
  ]);
}
function publicUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192)
    throw Error("Invalid URL.");
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("Use a web URL.");
  if (
    [
      new URL(config.appOrigin).hostname,
      new URL(config.runtimeOrigin).hostname,
    ].includes(u.hostname) &&
    !(
      config.fixture === true &&
      u.hostname === "127.0.0.1" &&
      u.port === "4199"
    )
  )
    throw Error("Open application pages using the navigation.");
  return u.href;
}
function destroy(id: string) {
  const record = records.get(id);
  if (!record) return;
  clearTimeout(record.timer);
  record.disposeFavicon?.();
  record.profile?.dispose();
  for (const guard of record.guards?.values() || []) guard.dispose();
  for (const dispose of record.renderers?.values() || []) dispose();
  diagnosticModes.delete(id);
  // Cancel this exact frame capability before removing its owner/realm.
  // CSS-hidden live tabs do not execute this destruction path.
  if (record.frame) controller?.abortFrameRequests?.(record.frame.prefix);
  record.element.remove();
  if (record.frame && controller) {
    const i = controller.frames.indexOf(record.frame);
    if (i >= 0) controller.frames.splice(i, 1);
  }
  records.delete(id);
  popups.delete(id);
}
const popups = new Map<
  string,
  { opener: Window | null; openerId: string; name: string; baseUrl: string }
>();
function activeStandaloneId() {
  return (
    [...records].find(([, record]) => !record.element.hidden)?.[0] || "popup"
  );
}
function activateStandalone(id: string) {
  const next = records.has(id)
    ? id
    : records.has("popup")
      ? "popup"
      : records.keys().next().value;
  if (!next) return;
  for (const [key, record] of records) record.element.hidden = key !== next;
  const record = records.get(next)!;
  if (record.url) notify("navigation", { id: next, url: record.url });
  notify("loaded", { id: next });
  record.element.focus();
}
function attachPageBridge(
  id: string,
  win: Window & typeof globalThis,
  client?: any,
) {
  const record = records.get(id)!;
  if (!record || !client) return;
  if (win === record.element.contentWindow) {
    record.checkpointRoot = { window: win, document: win.document, logicalURL: () => client.url.href };
  }
  record.guards ??= new Map();
  if (!record.guards.has(win.document)) {
    while (record.guards.size >= 16) {
      const oldest = record.guards.entries().next().value!;
      oldest[1].dispose();
      record.renderers?.get(oldest[0])?.();
      record.renderers?.delete(oldest[0]);
      record.guards.delete(oldest[0]);
    }
    const guard = installDocumentGuard(win, {
      id,
      pageUrl: () => client.url.href,
      fixture: config.fixture === true,
      ...(profileBridge ? { sampleRisk: false } : {}),
      enabled: () => siteModes[new URL(client.url.href).origin] === true,
      onTitle: (title) => {
        if (win === record.element.contentWindow)
          notify("title", { id, title });
      },
      report: (value) => {
        // Child documents keep independent policies; only the active root reports.
        if (win === record.element.contentWindow)
          notify("compatibility-status", value);
      },
    });
    const guardDoc = win.document;
    record.guards.set(guardDoc, guard);
    win.addEventListener("pagehide", (event) => {
      if (!(event as PageTransitionEvent).persisted) {
        record.guards?.delete(guardDoc);
        record.renderers?.get(guardDoc)?.();
        record.renderers?.delete(guardDoc);
      }
    });
  }
  record.diagnostics?.record("document", {
    origin: client.url.origin,
    context: standalone ? "top-level" : "embedded",
  });
  // The reviewed renderer stays native/opaque in profile mode too. Its fetches
  // still pass through this frame's assigned transport and profile cookie hooks.
  const disposeRenderer = installOpaqueRenderer(win, client, {
    fixture: config.fixture === true,
    fetchResource: (url, credentials, kind) =>
      opaqueResource(record, client, url, credentials, kind),
    report: (state, resources) => {
      record.diagnostics?.record(state === "error" ? "error" : "document", {
        origin: client.url.origin,
      });
      notify("runtime-compatibility", {
        id,
        origin: client.url.origin,
        rule: "opaque-renderer-reviewed",
        state,
        resources,
      });
    },
  });
  if (disposeRenderer) {
    record.renderers ??= new Map();
    record.renderers.set(win.document, disposeRenderer);
  }
  const popup = popups.get(id);
  if (popup && win === record.element.contentWindow) {
    // A website frame is sandboxed from navigating a sibling iframe directly.
    // Delegate the returned popup Window's location setter to its owning host.
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(client),
      "url",
    )!;
    Object.defineProperty(client, "url", {
      configurable: true,
      get: () => descriptor.get!.call(client),
      set: (value) => {
        const current = descriptor.get!.call(client).href;
        const next = new URL(
          String(value),
          current === "about:blank" ? popup.baseUrl : current,
        );
        record.frame.go(publicUrl(next.href));
      },
    });
    client.locationProxy.assign = (value: string) => {
      client.url = value;
    };
    client.locationProxy.replace = (value: string) => {
      const current = descriptor.get!.call(client).href;
      const next = publicUrl(
        new URL(
          String(value),
          current === "about:blank" ? popup.baseUrl : current,
        ).href,
      );
      const encoded = globals.$runtimekit.transformUrl(
        next,
        record.frame.context,
        {
          origin: new URL(next),
          base: new URL(next),
        },
      );
      // Call from the owning runtime, retaining replace's history semantics.
      record.element.contentWindow!.location.replace(encoded);
    };
    Object.defineProperty(win, "opener", {
      configurable: true,
      get: () => popup.opener,
    });
    Object.defineProperty(win, "closed", {
      configurable: true,
      get: () => !records.has(id),
    });
    win.close = () => {
      const wasVisible = !record.element.hidden;
      destroy(id);
      // The embedded shell activates the opener in response to this event.
      // A standalone runtime has no shell, so restore its visible context here.
      if (standalone && wasVisible) activateStandalone(popup.openerId);
      notify("popup-closed", { id, openerId: popup.openerId });
    };
    win.focus = () => {
      if (standalone) activateStandalone(id);
      else for (const [key, r] of records) r.element.hidden = key !== id;
      notify("popup-focus", { id });
    };
  }
  installLocalDownloads(win, {
    pageURL: () => client.url.href,
    nativeBlobURL: (url) => globals.$runtimekit.unrewriteBlob(
      url, client.context, client.meta,
    ),
  });
  installPageBridge(win, {
    topName: record.element.name,
    isRoot: win === record.element.contentWindow,
    submitToRoot: (form, submitter) => submitManagedForm(form, submitter, {
      window: record.element.contentWindow!,
      pageUrl: client.url.href,
      encode: (url) => globals.$runtimekit.transformUrl(
        publicUrl(url), record.frame.context,
        { origin: new URL(client.url.href), base: new URL(client.url.href) },
      ),
    }),
    pageUrl: () => client.url.href,
    focusSearch: () => notify("focus-search", { id }),
    open: (url, name, opener, noOpener) => {
      const existing =
        !noOpener &&
        name !== "_blank" &&
        [...popups].find(
          ([key, info]) =>
            records.has(key) && info.openerId === id && info.name === name,
        );
      const popupId = existing ? existing[0] : crypto.randomUUID();
      popups.set(popupId, {
        opener: noOpener ? null : opener,
        openerId: id,
        name,
        baseUrl: client.url.href,
      });
      const child =
        records.get(popupId) || createRecord(popupId, record.engine);
      const childWindow = child.element.contentWindow!;
      // A synchronous Window return is needed by OAuth callers that open a blank
      // window and navigate it later. The controller supplies the actual realm.
      if (client && !existing) {
        client.init.hookSubcontext(childWindow);
      }
      for (const [key, r] of records) r.element.hidden = key !== popupId;
      notify("popup-created", {
        id: popupId,
        openerId: id,
        url,
        engine: record.engine,
      });
      const encode = (value: string) =>
        globals.$runtimekit.transformUrl(value, child.frame.context, {
          origin: new URL(
            url === "about:blank" ? client?.url.href || location.href : url,
          ),
          base: new URL(
            url === "about:blank" ? client?.url.href || location.href : url,
          ),
        });
      if (url !== "about:blank") child.element.src = encode(url);
      return {
        window: childWindow,
        name: child.element.name,
        submit(form: HTMLFormElement, submitter?: HTMLElement | null) {
          submitManagedForm(form, submitter, {
            window: childWindow,
            pageUrl: client.url.href,
            encode: (value) => encode(publicUrl(value)),
          });
        },
      };
    },
  });
}
function pageBridgePlugin(id: string) {
  const { ManagedPlugin } = globals.$runtimekitController;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-page-bridge", []);
    }
    install(frame: any) {
      super.install(frame);
      this.tap(frame.hooks.init.pre, ({ client }: any) => {
        // Retain the native srcdoc setter before document runtime hooks install.
        void client.descriptors.store["HTMLIFrameElement.prototype.srcdoc"];
      });
      this.tap(frame.hooks.init.post, ({ window, client }: any) =>
        attachPageBridge(id, window, client),
      );
    }
  })();
}
function diagnosticsPlugin(id: string) {
  const { ManagedPlugin } = globals.$runtimekitController;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-local-diagnostics", []);
    }
    install(frame: any) {
      super.install(frame);
      const log = records.get(id)?.diagnostics;
      const fields = (ctx: any) => ({
        origin: ctx.parsed.url.origin,
        category: requestCategory(ctx.parsed.url.href),
        method: ctx.request.method,
        destination: ctx.parsed.destination,
      });
      this.tap(
        frame.fetchHandler.hooks.fetch.request,
        (ctx: any, props: any) => {
          const opaque = opaqueRequests.get(ctx.request);
          if (opaque && props.init?.headers) {
            props.init.headers = props.init.headers.filter(
              ([name]: [string, string]) =>
                !["origin", "sec-fetch-dest", "sec-fetch-mode"].includes(
                  name.toLowerCase(),
                ),
            );
            props.init.headers.push([
              "Sec-Fetch-Dest",
              opaque.kind === "module" ? "script" : "iframe",
            ]);
            props.init.headers.push([
              "Sec-Fetch-Mode",
              opaque.kind === "module" ? "cors" : "navigate",
            ]);
            if (opaque.kind === "module")
              props.init.headers.push(["Origin", "null"]);
          }
          const headers: [string, string][] = props.init?.headers || [];
          log?.record("request", {
            ...fields(ctx),
            credentialed: headers.some(([n]) =>
              ["cookie", "authorization"].includes(n.toLowerCase()),
            ),
          });
        },
      );
      this.tap(
        frame.fetchHandler.hooks.fetch.preresponse,
        (ctx: any, props: any) => {
          const capture = opaqueRequests.get(ctx.request);
          if (capture) {
            capture.policies = props.response.rawHeaders
              .filter(
                ([name]: [string, string]) =>
                  name.toLowerCase() === "content-security-policy",
              )
              .map(([, value]: [string, string]) => value);
            capture.allowOrigin = props.response.rawHeaders.find(
              ([name]: [string, string]) =>
                name.toLowerCase() === "access-control-allow-origin",
            )?.[1];
            capture.allowCredentials = props.response.rawHeaders.find(
              ([name]: [string, string]) =>
                name.toLowerCase() === "access-control-allow-credentials",
            )?.[1];
          }
          log?.record("response", {
            ...fields(ctx),
            status: props.response.status,
            cookies: (props.response.rawHeaders || []).filter(
              ([n]: [string, string]) => n.toLowerCase() === "set-cookie",
            ).length,
          });
        },
      );
    }
  })();
}
function createRecord(id: string, engine: string) {
  const element = document.createElement("iframe");
  element.title = "Proxied website";
  element.allow =
    "autoplay; encrypted-media; fullscreen; clipboard-write; camera; microphone";
  const record = { element, engine, frame: null } as NonNullable<
    ReturnType<typeof records.get>
  >;
  element.name = "view-" + id;
  record.diagnostics = new DiagnosticLog();
  startDiagnostics(record, diagnosticModes.get(id) === true);
  records.set(id, record);
  container.append(element);
  {
    const { UrlWatcherPlugin, CatchEscapedLinksPlugin } =
      globals.$runtimekitUtils;
    const storagePlugin = profileBridge
      ? createScramjetProfilePlugin(globals, {
          ...profileBridge,
          topLevelURL: () => [record.url, popups.get(id)?.baseUrl, profileBridge.topLevelURL()]
            .find((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url))!,
        }, {
          host: window,
          frameId: id,
          workerURL: profileWorkerURL,
          onError: (error) => notify("error", { id, message: (error as Error)?.message || "Website saves are unavailable." }),
        })
      : createLogicalStoragePlugin(globals);
    if (profileBridge) record.profile = storagePlugin as ReturnType<typeof createScramjetProfilePlugin>;
    record.frame = controller.createFrame(element, {
      plugins: [
        storagePlugin,
        pageBridgePlugin(id),
        diagnosticsPlugin(id),
        createYouTubeAdblockPlugin(globals, () => youtubeAdblock),
        createRequestHeadersPlugin(globals),
        createDiscordScriptSelectorPlugin(globals),
        createVerifiedStylesheetPlugin(globals),
        createHttpCachePlugin(globals),
        new UrlWatcherPlugin((value: URL) => {
          record.url = String(value);
          record.diagnostics?.record("navigation", { origin: String(value) });
          notify("navigation", { id, url: record.url });
        }),
        new CatchEscapedLinksPlugin(
          (value: URL) =>
            new URL(
              createDirectTabUrl(
                location.origin,
                String(value),
                ticket || undefined,
                youtubeAdblock,
                config.runtimePath,
              ),
            ),
        ),
      ],
    });
  }
  element.addEventListener("load", () => {
    const r = records.get(id);
    if (!r) return;
    if (profileBridge) {
      const document = element.contentDocument;
      if (!document) return;
      const nativeURL = Object.getOwnPropertyDescriptor(Document.prototype, "URL")!.get!.call(document);
      if (!scramjetProfileLoadReady(nativeURL, document.contentType, r.profile?.hasDocument(document) === true)) return;
    }
    clearTimeout(r.timer);
    r.disposeFavicon?.();
    notify("loaded", { id });
    try {
      const doc = element.contentDocument;
      notify("title", {
        id,
        title: doc ? originalDocumentTitle(doc).slice(0, 160) : "",
      });
      if (doc && doc.URL !== "about:blank") {
        if (!panicDocuments.has(doc)) {
          panicDocuments.add(doc);
          doc.addEventListener(
            "keydown",
            (event) => {
              const editable = (event.target as Element | null)?.closest?.(
                "input,textarea,select,[contenteditable]",
              );
              if (matchesShortcut(event, panicKey) && !editable) {
                event.preventDefault();
                notify("panic", { key: panicKey });
              }
            },
            true,
          );
        }
        const nativeUrl = Object.getOwnPropertyDescriptor(
          Document.prototype,
          "URL",
        )!.get!.call(doc) as string;
        const prefix = r.frame.context.prefix.href;
        const pageUrl = globals.$runtimekit.restoreurl(
          nativeUrl,
          r.frame.context,
        );
        r.disposeFavicon = watchFavicon(
          doc,
          (value) => {
            if (value.length > 350000) throw Error("Icon URL too long");
            if (/^data:image\//i.test(value)) return value;
            // Native link getters return rewritten URLs; retain the frame's
            // proxy prefix so fetching uses the same engine/session as the page.
            const parsed = new URL(value, pageUrl);
            if (parsed.href.startsWith(prefix)) return parsed.href;
            const target = publicUrl(parsed.href);
            return globals.$runtimekit.transformUrl(target, r.frame.context, {
              origin: new URL(pageUrl),
              base: new URL(pageUrl),
            });
          },
          (favicon) => notify("favicon", { id, favicon }),
          fetch,
        );
      }
    } catch {}
  });
  return record;
}

async function navigate(id: string, url: string, engine: string) {
  engine = "runtime";
  await (initialization ??= init().catch((error) => {
    initialization = undefined;
    throw error;
  }));
  let record = records.get(id);
  if (record && record.engine !== engine) {
    destroy(id);
    record = undefined;
  }
  if (!record) record = createRecord(id, engine);
  for (const [key, item] of records) item.element.hidden = key !== id;
  clearTimeout(record.timer);
  record.disposeFavicon?.();
  notify("favicon", { id, favicon: "" });
  record.timer = setTimeout(
    () =>
      notify("slow", {
        id,
        message:
          "This page is taking longer than expected. You can wait, reload, or reconnect the node.",
      }),
    30000,
  );
  record.diagnostics?.record("navigation", { origin: new URL(url).origin });
  notify("loading", { id });
  await record.frame.go(url);
}
const updateRuntimeCredentials = orderedCredentialUpdates<{
  ticket: string;
  ticketExpiresAt: number;
  relayTicket: string;
  assignedOrigin: string;
}>({ ticket, ticketExpiresAt: config.ticketExpiresAt || 0 }, async (update) => {
  await (initialization ??= init());
  await refreshRelayCredentials(
    controller,
    update.assignedOrigin,
    update.relayTicket,
  );
  ticket = update.ticket;
  relayQuery = encodeURIComponent(ticket) + "/";
  if (config.relayOrigin) config.relayTicket = update.relayTicket;
  sessionWatch.update(ticket);
});
window.addEventListener("message", async (event) => {
  if (
    event.source !== parent ||
    event.origin !== config.appOrigin ||
    event.data?.atlas !== 1
  )
    return;
  const { type, id, url, engine } = event.data;
  if (typeof event.data.youtubeAdblock === "boolean")
    youtubeAdblock = event.data.youtubeAdblock;
  if (type === "ping") {
    notify("ready");
    return;
  }
  try {
    if (type === "session-update") {
      const update = event.data;
      if (
        typeof update.sessionHash !== "string" ||
        update.sessionHash !== config.session ||
        typeof update.ticket !== "string" ||
        !update.ticket ||
        update.ticket.length > 32768 ||
        update.generation !== (config.generation ?? 0)
      )
        return;
      const assignedOrigin = config.relayOrigin || config.runtimeOrigin;
      if (update.relayOrigin !== assignedOrigin) return;
      const nextRelayTicket = config.relayOrigin
        ? update.relayTicket
        : update.ticket;
      if (typeof nextRelayTicket !== "string" || !nextRelayTicket) return;
      const applied = await updateRuntimeCredentials({
        ticket: update.ticket,
        ticketExpiresAt: update.ticketExpiresAt,
        relayTicket: nextRelayTicket,
        assignedOrigin,
      });
      if (applied) notify("session-updated", { generation: update.generation });
      return;
    }
    if (typeof id !== "string" || id.length > 100) return;
    if (type === "profile-checkpoint") {
      const { requestId, origin } = event.data;
      if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId) || typeof origin !== "string") return;
      try {
        if (!profileBridge || id !== profileBridge.frameId) throw Error("PROFILE_CHECKPOINT_ROOT_REQUIRED");
        const result = checkpointControllerRoot(records.get(id), origin);
        notify("profile-checkpoint-result", { id, requestId, ok: true, supported: result.supported });
      } catch (error) {
        notify("profile-checkpoint-result", { id, requestId, ok: false,
          code: error instanceof Error ? error.message : "PROFILE_CHECKPOINT_FAILED" });
      }
      return;
    }
    if (type === "compatibility-config") {
      siteModes = sanitizeSiteModes(event.data.sites);
      const r = records.get(id);
      for (const [doc, guard] of r?.guards || []) {
        guard.update();
      }
      if (typeof event.data.diagnostics === "boolean") {
        const next = event.data.diagnostics;
        if (diagnosticModes.get(id) !== next) {
          diagnosticModes.set(id, next);
          if (r) startDiagnostics(r, next);
        }
      }
      return;
    }
    if (type === "compatibility-export") {
      notify("compatibility-diagnostics", {
        id,
        report: records.get(id)?.diagnostics?.snapshot() || {
          version: 1,
          active: false,
          entries: [],
        },
      });
      return;
    }
    if (type === "panic-key") {
      panicKey = normalizeShortcut(event.data.key);
      return;
    }
    if (type === "navigate") await navigate(id, publicUrl(url), "runtime");
    else if (type === "activate")
      for (const [key, r] of records) r.element.hidden = key !== id;
    else if (type === "close") destroy(id);
    else if (type === "reload") {
      const r = records.get(id);
      if (r?.frame) r.frame.reload();
      else if (r) r.element.src = r.element.src;
    } else if (type === "back" || type === "forward") {
      const r = records.get(id);
      if (r?.frame) r.frame[type]();
      else
        type === "back"
          ? r?.element.contentWindow?.history.back()
          : r?.element.contentWindow?.history.forward();
    } else if (type === "clear") {
      location.replace(
        (config.runtimePath || "/") + "clear.html" + (ticket ? "#ticket=" + encodeURIComponent(ticket) : ""),
      );
    }
  } catch (err) {
    notify("error", {
      id,
      message: err instanceof Error ? err.message : "Browsing failed.",
    });
  }
});
if (standalone) {
  const bar = document.createElement("form");
  bar.id = "popup-toolbar";
  bar.setAttribute("aria-label", "Popout browser controls");
  bar.innerHTML = `
    <span class="popup-brand">Atlas</span>
    <button type="button" id="popup-back" aria-label="Go back" title="Go back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg>
    </button>
    <button type="button" id="popup-reload" aria-label="Reload" title="Reload">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8M21 3v5h-5"/></svg>
    </button>
    <div class="popup-address-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/></svg>
      <input id="popup-address" type="url" aria-label="Website address" placeholder="Enter a URL" autocomplete="off" spellcheck="false" required>
      <button type="submit" id="popup-go" aria-label="Go to website" title="Go to website">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg>
      </button>
    </div>
    <span id="popup-status" role="status" aria-live="polite"></span>`;
  const returnLink = document.createElement("a");
  returnLink.href = config.appOrigin;
  returnLink.setAttribute("aria-label", "Return to Atlas");
  returnLink.title = "Return to Atlas";
  const connection = document.createElement("details");
  connection.style.cssText = "position:relative;font:12px system-ui";
  const connectionLabel = document.createElement("summary");
  connectionLabel.textContent = "Connection";
  const connectionInfo = document.createElement("div");
  connectionInfo.style.cssText =
    "position:absolute;right:0;top:30px;width:220px;z-index:100;background:#18251c;color:#edf3e8;padding:12px;border:1px solid #56715b;border-radius:8px";
  connectionInfo.textContent = "Traffic node: " + (config.node?.name || "Main server");
  connection.append(connectionLabel, connectionInfo);
  bar.append(connection);
  returnLink.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg><span class="popup-return-label">Return to Atlas</span>`;
  returnLink.id = "popup-return";
  bar.append(returnLink);
  document.body.classList.add("runtime-standalone");
  document.body.prepend(bar);
  const field = bar.querySelector<HTMLInputElement>("input")!;
  const go = async () => {
    if (standaloneExpired) return;
    try {
      await navigate(activeStandaloneId(), publicUrl(field.value), "runtime");
    } catch (e) {
      bar.querySelector("#popup-status")!.textContent =
        e instanceof Error ? e.message : "Page failed.";
    }
  };
  bar.onsubmit = (e) => {
    e.preventDefault();
    void go();
  };
  bar.querySelector<HTMLButtonElement>("#popup-back")!.onclick = () =>
    records.get(activeStandaloneId())?.frame?.back();
  bar.querySelector<HTMLButtonElement>("#popup-reload")!.onclick = () =>
    records.get(activeStandaloneId())?.frame?.reload();
  let keyboardNotice = "";
  attachFullscreenKeyboard(
    document,
    navigator,
    () =>
      [...records.values()].some(
        (r) => r.element === document.fullscreenElement,
      ),
    (state) => {
      keyboardNotice =
        state === "locked"
          ? ""
          : "Keyboard capture unavailable. Esc may exit fullscreen.";
    },
  );
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && keyboardNotice) {
      bar.querySelector("#popup-status")!.textContent = keyboardNotice;
      keyboardNotice = "";
    }
  });
  try {
    const initial =
      directTabTarget(launchParams) ||
      new URL(location.href).searchParams.get("goto");
    if (initial) {
      field.value = initial;
      void go();
    }
  } catch {
    bar.querySelector("#popup-status")!.textContent =
      "Invalid page address. Return to Atlas and open it again.";
  }
} else notify("ready");
