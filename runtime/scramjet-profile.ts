/** Profile persistence on the normal, fully rewritten Scramjet controller. */
import type { CookieRequestContext } from "./sandbox-cookies.ts";
import { compilerBindingImport } from "./worker-compiler-bindings.ts";
import {
  installScramjetProfileWorkerInjection,
  installScramjetProfileWorkerConstructors,
} from "./scramjet-profile-workers.ts";

export const SCRAMJET_PROFILE_REGISTRY = Symbol.for("atlas.scramjet.profile.v1");
export const PROFILE_DOCUMENT_HEADER = "x-atlas-profile-document";
export function scramjetProfileLoadReady(
  nativeURL: string,
  contentType: string,
  prepared: boolean,
) {
  if (/^about:(?:blank|srcdoc)(?:[#?]|$)/i.test(nativeURL)) return false;
  return !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType) || prepared;
}
export type PreparedScramjetDocument = {
  documentId: string;
  website: string;
  profileId: string;
  install(window: Window & typeof globalThis, client: any): void;
  dispose(): void;
};
export type ScramjetProfileBridge = {
  profileId: string;
  profileContextId?: string;
  browserSessionId: string;
  frameId: string;
  topLevelURL(): string;
  prepareOrigin(url: string, options?: { interactive?: boolean }): Promise<void>;
  prepareDocument(options: {
    documentId: string;
    website: string;
    topLevelURL: string;
    frameId: string;
    host: Window & typeof globalThis;
    interactive?: boolean;
  }): Promise<PreparedScramjetDocument>;
  getRequestHeader(context: CookieRequestContext): Promise<string>;
  storeResponseCookies(lines: string[], context: CookieRequestContext): Promise<unknown>;
  bindWorkerIndexedDB(options: {
    documentId: string;
    website: string;
  }): Promise<{ port: MessagePort; dispose(): void }>;
};

export function getScramjetProfileBridge(host: Window): ScramjetProfileBridge | undefined {
  for (const owner of [host.parent, host.opener]) {
    try {
      const registry = (owner as any)?.[SCRAMJET_PROFILE_REGISTRY];
      const bridge = registry?.get(host);
      if (bridge) return bridge;
    } catch {}
  }
}

/** Disable the normal engine's old frontend-wide cookie database BEFORE its
 * constructor starts reading it. Profile HTTP/document cookies have one owner. */
export function neutralizeScramjetCookies(globals: any) {
  const controller = globals.$runtimekitController.Controller.prototype;
  for (const name of ["loadSavedCookies", "persistCookies", "propagateCookieSync"])
    Object.defineProperty(controller, name, { configurable: true, writable: true, value: async () => {} });
  Object.defineProperty(controller, "applyCookieSyncEntries", { configurable: true, writable: true, value() {} });
  const jar = globals.$runtimekit.CookieJar.prototype;
  for (const name of ["load", "setCookies"])
    Object.defineProperty(jar, name, { configurable: true, writable: true, value() {} });
  Object.defineProperty(jar, "getCookies", { configurable: true, writable: true, value: () => "" });
  Object.defineProperty(jar, "dump", { configurable: true, writable: true, value: () => "{}" });
}

const documentRequest = (parsed: any) => ["document", "iframe"].includes(parsed.destination);
// A self-navigation in a nested frame may omit the initial $iframe flag. The
// pinned engine retains its rewritten parent-frame identity across that hop.
const primaryRequest = (parsed: any) => documentRequest(parsed) &&
  parsed.isIframe !== true && !parsed.meta?.parentFrameName;
const htmlResponse = (response: any) => /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(response.headers.get("content-type") || "");
const installedDocuments = new WeakMap<Document, { profileId: string; prepared: PreparedScramjetDocument }>();
const installedReferences = new Map<PreparedScramjetDocument, number>();
const preparedDocuments = new Map<string, { context?: string; prepared: PreparedScramjetDocument }>();
function disposePrepared(prepared: PreparedScramjetDocument) {
  if (preparedDocuments.get(prepared.documentId)?.prepared === prepared) preparedDocuments.delete(prepared.documentId);
  prepared.dispose();
}

export function createScramjetProfilePlugin(
  globals: any,
  bridge: ScramjetProfileBridge,
  options: { host: Window & typeof globalThis; frameId: string; workerURL?: string; onError?(error: unknown): void },
) {
  const { ManagedPlugin } = globals.$runtimekitController;
  const ready = new Map<string, PreparedScramjetDocument>();
  const pending = new Set<PreparedScramjetDocument>();
  const requests = new WeakMap<object, { context: CookieRequestContext; cookie: string }>();
  const clients = new WeakMap<object, PreparedScramjetDocument>();
  const documents = new Map<Document, { prepared: PreparedScramjetDocument; stop(): void }>();
  const workerDisposers = new Set<() => void>();
  let live = true;
  let controllerFrame: any;
  const fail = (error: unknown, report = true): never => {
    if (report) options.onError?.(error);
    throw error;
  };
  // Nested frames still fail initialization on an invalid binding. Their
  // failure must not replace a healthy primary document with a tab-wide error.
  const primaryDocument = (win: Window) => {
    try {
      // Read the iframe from the trusted controller, not the website's hooked
      // parent/top getters, which can intentionally present a top-level view.
      if (controllerFrame?.element) return controllerFrame.element.contentWindow === win;
      return win.parent === options.host || win.parent === win;
    }
    catch { return false; }
  };
  // Some document.write/ad navigations arrive without *any* rewritten frame
  // metadata or client URL. Absence is not proof that the primary iframe is
  // navigating: only the controller's assigned src or trusted current URL can
  // identify such a request as foreground. Storage checks still reject it.
  const foregroundRequest = (context: any) => {
    const parsed = context.parsed;
    if (!primaryRequest(parsed)) return false;
    if (parsed.destination !== "iframe" || parsed.clientUrl || parsed.referrerSourceUrl ||
        parsed.meta?.topFrameName || !controllerFrame?.element) return true;
    return context.request.rawUrl?.href === controllerFrame.element.src ||
      parsed.url.href === bridge.topLevelURL();
  };
  const cookieContext = (context: any): CookieRequestContext => {
    const { parsed, request } = context;
    const target = parsed.url.href;
    const logicalURL = (values: unknown[]) => values.find((value): value is string =>
      typeof value === 'string' && /^https?:\/\//.test(value) && new URL(value).origin !== options.host.location?.origin)!;
    const documentURL = logicalURL([parsed.clientUrl?.href, parsed.referrerSourceUrl?.href, bridge.topLevelURL(), target]);
    const topLevelURL = logicalURL([bridge.topLevelURL(), documentURL, target]);
    const topLevelNavigation = primaryRequest(parsed);
    return {
      requestURL: target,
      documentURL,
      topLevelURL: topLevelNavigation ? target : topLevelURL,
      siteForCookiesURL: topLevelURL,
      method: request.method,
      credentials: parsed.fetchCredentials ?? "include",
      topLevelNavigation,
      preflight: request.method === "OPTIONS" && request.initialHeaders?.has?.("access-control-request-method"),
    };
  };
  const plugin = new (class extends ManagedPlugin {
    constructor() { super("atlas-scramjet-profile", []); }
    install(frame: any) {
      super.install(frame);
      controllerFrame = frame;
      const workers = options.workerURL ? installScramjetProfileWorkerInjection(frame, options.workerURL, bridge) : undefined;
      if (workers) workerDisposers.add(() => workers.dispose());
      const hooks = frame.fetchHandler.hooks.fetch;
      this.tap(hooks.response, (context: any, props: any) => {
        if (context.parsed.destination !== "script" || !context.parsed.isModule ||
            props.response.status < 200 || props.response.status >= 300) return;
        const body = props.response.body;
        if (typeof body === "string") props.response.body = compilerBindingImport + body;
        else if (body instanceof Uint8Array) props.response.body = compilerBindingImport + new TextDecoder().decode(body);
      });
      this.tap(hooks.intercept, async (context: any) => {
        if (!live) throw Error("Profile frame is closed");
        try {
          if (documentRequest(context.parsed) || ["worker", "sharedworker"].includes(context.parsed.destination))
            await bridge.prepareOrigin(context.parsed.url.href, {
              interactive: foregroundRequest(context),
            });
          const requestContext = cookieContext(context);
          const cookie = await bridge.getRequestHeader(requestContext);
          requests.set(context.request, { context: requestContext, cookie });
        } catch (error) { fail(error, foregroundRequest(context)); }
      });
      // Tap dispatch starts callbacks concurrently. Cookie hydration therefore
      // finishes in intercept, and this synchronous hook runs before cache and
      // diagnostics callbacks inspect the final credentialed request headers.
      this.tap(hooks.request, (context: any, props: any) => {
        const prepared = requests.get(context.request);
        if (!prepared) fail(Error("Profile request was not prepared"), foregroundRequest(context));
        props.init.headers = (props.init.headers || []).filter(([name]: [string, string]) => name.toLowerCase() !== "cookie");
        if (prepared!.cookie) props.init.headers.push(["Cookie", prepared!.cookie]);
      });
      this.tap(hooks.preresponse, async (context: any, props: any) => {
        try {
          const preparedRequest = requests.get(context.request);
          if (!preparedRequest) throw Error("Profile response has no request context");
          const lines = props.response.rawHeaders.filter(([name]: [string, string]) => name.toLowerCase() === "set-cookie").map(([, value]: [string, string]) => value);
          if (lines.length) await bridge.storeResponseCookies(lines, preparedRequest!.context);
          // The stock shared cookie jar must never persist or propagate Hub
          // response cookies. The durable profile owner has already committed.
          props.response.rawHeaders = props.response.rawHeaders.filter(([name]: [string, string]) => !["set-cookie", PROFILE_DOCUMENT_HEADER].includes(name.toLowerCase()));
          if (!documentRequest(context.parsed) || (props.response.status >= 300 && props.response.status < 400) || !htmlResponse(props.response)) return;
          const documentId = "doc_" + Array.from(options.host.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
          const prepared = await bridge.prepareDocument({
            documentId,
            website: context.parsed.url.href,
            topLevelURL: preparedRequest!.context.topLevelURL,
            frameId: options.frameId,
            host: options.host,
            interactive: foregroundRequest(context),
          });
          if (!live) { prepared.dispose(); throw Error("Profile frame is closed"); }
          if (prepared.documentId !== documentId || prepared.profileId !== bridge.profileId || new URL(prepared.website).href !== context.parsed.url.href) {
            prepared.dispose(); throw Error("Profile document preparation changed identity");
          }
          ready.set(documentId, prepared);
          preparedDocuments.set(documentId, { context: bridge.profileContextId, prepared });
          pending.add(prepared);
          props.response.rawHeaders.push([PROFILE_DOCUMENT_HEADER, documentId]);
        } catch (error) { fail(error, foregroundRequest(context)); }
        finally { requests.delete(context.request); }
      });
      this.tap(frame.hooks.init.pre, ({ window: win, client }: any) => {
        const token = client.initHeaders?.get(PROFILE_DOCUMENT_HEADER);
        let prepared = typeof token === "string" ? ready.get(token) : undefined;
        const inherited = /^(?:about:(?:blank|srcdoc)|blob:|data:)/.test(client.url.href);
        if (!prepared && inherited && typeof token === 'string') {
          const shared = preparedDocuments.get(token);
          if (shared?.prepared.profileId === bridge.profileId && shared.context === bridge.profileContextId) prepared = shared.prepared;
        }
        if (!prepared && inherited) {
          for (const ancestor of [win.parent, win.opener]) {
            try {
              const parent = installedDocuments.get(ancestor?.document);
              if (parent?.profileId === bridge.profileId) { prepared = parent.prepared; break; }
            } catch {}
          }
        }
        if (!prepared) fail(Error("Profile document was not hydrated before initialization"), primaryDocument(win));
        if (!inherited && new URL(client.url.href).origin !== new URL(prepared!.website).origin) fail(Error("Profile document origin changed during initialization"), primaryDocument(win));
        clients.set(client, prepared!);
      });
      this.tap(frame.hooks.init.post, ({ window: win, client }: any) => {
        const prepared = clients.get(client);
        if (!prepared) fail(Error("Profile document initialization is missing"), primaryDocument(win));
        try {
          prepared!.install(win, client);
          const workers = options.workerURL ? installScramjetProfileWorkerConstructors(win, client, bridge) : undefined;
          pending.delete(prepared!);
          const document = win.document;
          installedDocuments.set(document, { profileId: bridge.profileId, prepared: prepared! });
          installedReferences.set(prepared!, (installedReferences.get(prepared!) || 0) + 1);
          const pagehide = (event: PageTransitionEvent) => {
            if (event.persisted) return;
            documents.delete(document);
            workers?.dispose();
            installedDocuments.delete(document);
            win.removeEventListener("pagehide", pagehide);
            // A stock inherited about:blank/srcdoc context may reuse its
            // parent's prepared token. Dispose only after its final view ends.
            const count = (installedReferences.get(prepared!) || 1) - 1;
            if (count) installedReferences.set(prepared!, count);
            else {
              installedReferences.delete(prepared!);
              ready.delete(prepared!.documentId);
              disposePrepared(prepared!);
            }
          };
          win.addEventListener("pagehide", pagehide);
          documents.set(document, { prepared: prepared!, stop: () => { win.removeEventListener("pagehide", pagehide); workers?.dispose(); } });
        } catch (error) { fail(error, primaryDocument(win)); }
      });
    }
    dispose() {
      if (!live) return;
      live = false;
      for (const dispose of workerDisposers) dispose();
      workerDisposers.clear();
      for (const [document, value] of documents) {
        value.stop();
        installedDocuments.delete(document);
        const count = (installedReferences.get(value.prepared) || 1) - 1;
        if (count) installedReferences.set(value.prepared, count);
        else installedReferences.delete(value.prepared);
      }
      for (const prepared of new Set([...ready.values(), ...pending, ...[...documents.values()].map(value => value.prepared)]))
        if (!installedReferences.has(prepared)) disposePrepared(prepared);
      documents.clear(); ready.clear(); pending.clear();
    }
    hasDocument(document: Document) { return documents.has(document); }
  })();
  return plugin;
}
