import { createCookieViewClock } from "../../runtime/cookie-view-cache.ts";
/** Trusted App/Popout adapter for the combined frontend runtime. The advertised
 * capability is authoritative: neither a URL parameter nor a saved preference
 * can enable this branch. Website windows never receive this controller. */
import { createFrontendBrowser } from "../../runtime/frontend-browser.ts";
import type { FrontendAssignment } from "../../runtime/frontend-assignment.ts";
import { sanitizeSiteModes } from "../../runtime/compatibility-policy.ts";
import {
  getActiveProfile,
  getActiveProfileContext,
  prepareProfileDocument,
} from "../../runtime/profile-context.ts";
import { clearProfileWebsiteData } from "../../runtime/profile-store.ts";

type Owner = Window & typeof globalThis;
type Browser = Awaited<ReturnType<typeof createFrontendBrowser>>;
type BrowserFactory = typeof createFrontendBrowser;
export type FrontendRuntimeEvent = {
  id: string;
  type: "loading" | "loaded" | "error" | "slow" | "navigation" | "title" | "favicon" | "popup-created" | "popup-focus" | "popup-closed" | "focus-search" | "panic";
  url?: string;
  message?: string;
  code?: string;
  title?: string;
  favicon?: string;
  openerId?: string;
  key?: string;
};
export type FrontendPageControls = {
  send(type: string, extra?: Record<string, unknown>): void;
  subscribe(listener: (event: any) => void): () => void;
};
export function frontendRuntimeEnabled(config: any): boolean {
  const capability = config?.runtimeProtocols?.opaque;
  const profile = config?.runtimeProtocols?.profile;
  return (capability?.version === 2 && capability.activated === true) ||
    (profile?.version === 2 && profile.activated === true && profile.documentOrigin === "same-origin");
}
const fail = (code: string) => Object.assign(new Error(code), { code });
const WINDOW_KEY = "atlas.frontendWindow.v2";
const ASSIGNMENT_KEY = "atlas.frontendAssignment.v2";
const CONTROLLER_ID = "@atlas-controller";

/** A duplicated browser tab can inherit sessionStorage. An exclusive live
 * document lock detects that clone before any website sessionStorage namespace
 * is granted. Ordinary reloads reuse the released owner's stable identity. */
export async function claimFrontendWindow(owner: Owner) {
  if (!owner.navigator.locks?.request)
    throw fail("FRONTEND_TAB_LOCK_UNAVAILABLE");
  let candidate = owner.sessionStorage.getItem(WINDOW_KEY);
  if (!candidate || !/^[a-f0-9]{32}$/.test(candidate))
    candidate = owner.crypto.randomUUID().replaceAll("-", "");
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = candidate;
    let release!: () => void;
    const lifetime = new Promise<void>((resolve) => (release = resolve));
    const acquired = new Promise<boolean>((resolve, reject) => {
      void owner.navigator.locks
        .request(
          "atlas-frontend-window-v2:" + id,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            resolve(!!lock);
            if (lock) await lifetime;
          },
        )
        .catch(reject);
    });
    if (await acquired) {
      try {
        owner.sessionStorage.setItem(WINDOW_KEY, id);
        if (owner.sessionStorage.getItem(WINDOW_KEY) !== id) throw Error();
      } catch {
        release();
        throw fail("FRONTEND_TAB_STORAGE_UNAVAILABLE");
      }
      return { id, dispose: release };
    }
    candidate = owner.crypto.randomUUID().replaceAll("-", "");
  }
  throw fail("FRONTEND_TAB_OWNER_UNAVAILABLE");
}

function webURL(input: unknown, frontend: string): string {
  if (typeof input !== "string" || input.length > 8192)
    throw fail("FRONTEND_BROWSER_DESTINATION_DENIED");
  const url = new URL(input);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname === new URL(frontend).hostname
  )
    throw fail("FRONTEND_BROWSER_DESTINATION_DENIED");
  return url.href;
}
async function digest(owner: Owner, value: string) {
  return [
    ...new Uint8Array(
      await owner.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
type Options = {
  container: HTMLElement;
  initialSession?: string;
  onEvent: (event: FrontendRuntimeEvent) => void;
  onAssignment?: (assignment: FrontendAssignment) => void;
  onConnection?: (state: { status: string; code?: string }) => void;
  /** Trusted dependency seam for deterministic adapter tests only. */
  createBrowser?: BrowserFactory;
  claimWindow?: typeof claimFrontendWindow;
};
type TabEntry = {
  element: HTMLDivElement;
  browser: Promise<Browser>;
  browserFailed?: boolean;
  starting?: { promise: Promise<unknown>; url: string };
  instance?: Browser;
  live: boolean;
  started: boolean;
  version: number;
  url: string;
  history: string[];
  index: number;
  expected?: string;
};

export function createFrontendWorkspace(options: Options) {
  const owner = options.container.ownerDocument.defaultView as Owner;
  if (!owner) throw fail("FRONTEND_BROWSER_OWNER_MISMATCH");
  let live = true,
    active = "", panicKey = "";
  const tabs = new Map<string, TabEntry>();
  // A normal controller owns its popup realms. They are aliases of that same
  // mounted host, not newly allocated browsing clients or remounted websites.
  const managed = new Map<string, { ownerId: string; openerId: string; url: string }>();
  const closedRoots = new Set<string>();
  const owningId = (id: string) => managed.get(id)?.ownerId ?? id;
  const owningTab = (id: string) => tabs.get(owningId(id));
  const runtimeId = (id: string) => managed.has(id) ? id : undefined;
  const pageControls = new Map<string, FrontendPageControls>(),
    pageListeners = new Map<string, Set<(event: any) => void>>(),
    pageSettings = new Map<
      string,
      { sites: ReturnType<typeof sanitizeSiteModes>; diagnostics: boolean }
    >();
  function publishPage(id: string, event: any) {
    if (!live || !owningTab(id)?.live) return;
    for (const listener of pageListeners.get(id) ?? []) {
      try {
        listener({ ...event, id });
      } catch {}
    }
  }
  async function configurePage(id: string) {
    const tab = owningTab(id),
      settings = pageSettings.get(id);
    if (!live || !tab?.live || !settings) return;
    const browser = await tab.browser;
    if (!live || !tab.live || owningTab(id) !== tab) return;
    const url = managed.get(id)?.url ?? tab.url;
    const command = { type: "compatibility-config" as const,
      metadata: settings.sites[new URL(url).origin] === true, diagnostics: settings.diagnostics };
    if (managed.has(id)) browser.runtimeCommand?.(command.type, id, { sites: settings.sites, diagnostics: settings.diagnostics });
    else browser.pageCommand(command);
  }
  function controlsFor(id: string): FrontendPageControls {
    let value = pageControls.get(id);
    if (value) return value;
    value = {
      send(type, extra = {}) {
        if (!live) return;
        if (type === "compatibility-config") {
          pageSettings.set(id, {
            sites: sanitizeSiteModes(extra.sites),
            diagnostics: extra.diagnostics === true,
          });
          void configurePage(id).catch((error) => report(id, error));
        } else if (type === "compatibility-export") {
          const tab = owningTab(id);
          if (tab?.live)
            void tab.browser
              .then((browser) => {
                if (live && tab.live && owningTab(id) === tab) {
                  if (managed.has(id)) browser.runtimeCommand?.(type, id);
                  else browser.pageCommand({ type });
                }
              })
              .catch((error) => report(id, error));
        }
      },
      subscribe(listener) {
        let listeners = pageListeners.get(id);
        if (!listeners) {
          listeners = new Set();
          pageListeners.set(id, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners!.delete(listener);
        };
      },
    };
    pageControls.set(id, value);
    return value;
  }
  const identity = (options.claimWindow ?? claimFrontendWindow)(owner);
  void identity.catch(() => {});
  // Popouts restore their explicit handoff, not another Atlas window's global
  // current pin. The shared native lock still serializes owner operations, but
  // the cache and channel are scoped/disabled rather than silently following.
  const coordinatorOptions = (async () => {
    if (!options.initialSession) {
      const profile = getActiveProfile();
      if (!profile) return undefined;
      const context = getActiveProfileContext();
      if (!context) throw fail("FRONTEND_PROFILE_CONTEXT_REQUIRED");
      // Website data belongs to the stable profile. Transport authorization
      // belongs to this branch sign-in and must not survive A→B→A/sign-out.
      const scope = profile + ":" + context;
      const key = ASSIGNMENT_KEY + ".profile." + scope;
      return {
        storage: {
          getItem(name: string) {
            if (name !== ASSIGNMENT_KEY)
              throw fail("FRONTEND_CACHE_KEY_DENIED");
            return owner.localStorage.getItem(key);
          },
          setItem(name: string, value: string) {
            if (name !== ASSIGNMENT_KEY)
              throw fail("FRONTEND_CACHE_KEY_DENIED");
            owner.localStorage.setItem(key, value);
          },
        },
        channelName: "atlas-frontend-assignment-v2:profile:" + scope,
      };
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(options.initialSession))
      throw fail("INVALID_SESSION");
    const key =
      ASSIGNMENT_KEY +
      ".popout." +
      (await digest(owner, options.initialSession));
    return {
      initialSession: { session: options.initialSession },
      channel: false as const,
      storage: {
        getItem(name: string) {
          if (name !== ASSIGNMENT_KEY) throw fail("FRONTEND_CACHE_KEY_DENIED");
          return owner.localStorage.getItem(key);
        },
        setItem(name: string, value: string) {
          if (name !== ASSIGNMENT_KEY) throw fail("FRONTEND_CACHE_KEY_DENIED");
          owner.localStorage.setItem(key, value);
        },
      },
    };
  })();
  void coordinatorOptions.catch(() => {});
  function emit(event: FrontendRuntimeEvent) {
    if (live) {
      options.onEvent(event);
      publishPage(event.id, event);
    }
  }
  function report(id: string, error: any) {
    if (error?.code === "FRONTEND_NAVIGATION_STALE") return;
    const message =
      error?.code === "HUB_LEASE_MISMATCH"
        ? "Your browsing connection belongs to an earlier sign-in. Try again."
        : error?.code === "PROFILE_CONTINUED_ELSEWHERE"
          ? "This website continued in your other browser. Choose Continue here to return."
          : /^[A-Z][A-Z0-9_]+$/.test(error?.message || "")
            ? "Your browsing connection needs to be restored. Try again."
            : error?.message || "The website did not load.";
    emit({
      id,
      type: "error",
      code: error?.code,
      message,
    });
  }
  function activate(id: string) {
    if (closedRoots.has(id)) return;
    active = id;
    const rootId = owningId(id), tab = tabs.get(rootId);
    for (const [tabId, entry] of tabs) entry.element.hidden = rootId !== tabId;
    if (tab) void tab.browser.then(browser => {
      if (live && tab.live && active === id) browser.runtimeCommand?.("activate", runtimeId(id));
    }).catch(error => report(id, error));
  }
  function beginBrowser(id: string, created: TabEntry) {
    created.browserFailed = false;
    const flight = (async () => {
      const claimed = await identity;
      const tabSessionId =
        "tab_" + (await digest(owner, claimed.id + "\0" + id));
      const coordinator = await coordinatorOptions;
      if (!live || !created.live) throw fail("FRONTEND_BROWSER_DISPOSED");
      const browser = await (options.createBrowser ?? createFrontendBrowser)({
        container: created.element,
        tabSessionId,
        coordinatorOptions: coordinator,
        onAssignment: ({ assignment }) => {
          if (live && created.live) options.onAssignment?.(assignment);
        },
        onAssignmentState: (state) => {
          if (live && created.live) options.onConnection?.(state);
        },
        onRuntimeEvent: (event) => {
          if (!live || !created.live) return;
          const pageId = event.id ?? id;
          if (event.type === "popup-created") {
            if (!event.id || !event.url || tabs.has(event.id) || (managed.has(event.id) && managed.get(event.id)!.ownerId !== id)) return;
            managed.set(event.id, { ownerId: id, openerId: event.openerId ?? id, url: event.url });
          } else if (pageId !== id && managed.get(pageId)?.ownerId !== id) return;
          if (event.type === "navigation" && event.url && managed.has(pageId)) managed.get(pageId)!.url = event.url;
          if (event.type === "popup-created" || event.type === "popup-focus") activate(pageId);
          emit({ ...event, id: pageId, openerId: event.openerId ?? id });
          if (event.type === "loaded") void configurePage(pageId).catch(error => report(pageId, error));
          if (event.type === "popup-closed") {
            managed.delete(pageId); pageSettings.delete(pageId); pageControls.delete(pageId); pageListeners.delete(pageId);
            if (closedRoots.has(id) && ![...managed.values()].some(value => value.ownerId === id)) disposeRoot(id);
          }
        },
        onLocation: (location) => {
          if (!live || !created.live) return;
          const next = webURL(location, owner.location.origin);
          created.url = next;
          if (created.expected !== undefined) {
            created.history[created.index] = next;
            created.expected = undefined;
          } else if (created.history[created.index] !== next) {
            created.history.splice(++created.index);
            created.history.push(next);
          }
          emit({ id, type: "navigation", url: next });
        },
        onTelemetry: (event) => {
          if (!live || !created.live) return;
          if (event.type === "title") emit({ id, ...event });
          else publishPage(id, event);
        },
        onState: (state) => {
          if (!live || !created.live) return;
          if (state.status === "loading") emit({ id, type: "loading" });
          else if (state.status === "ready") {
            emit({ id, type: "loaded" });
            void configurePage(id).catch((error) => report(id, error));
          } else if (state.status === "error")
            report(id, fail(state.code || "FRONTEND_DOCUMENT_FAILED"));
        },
      });
      if (!live || !created.live) {
        browser.dispose();
        throw fail("FRONTEND_BROWSER_DISPOSED");
      }
      created.instance = browser;
      return browser;
    })();
    created.browser = flight;
    void flight.catch((error) => {
      if (created.browser !== flight) return;
      created.browserFailed = true;
      if (created.live) report(id, error);
    });
  }
  function retryBrowser(id: string, tab: TabEntry): Promise<Browser> {
    if (live && tab.live && tab.browserFailed && !tab.instance)
      beginBrowser(id, tab);
    return tab.browser;
  }
  function entry(id: string, url: string) {
    if (!live || typeof id !== "string" || !id || id.length > 256)
      throw fail("FRONTEND_TAB_ID_INVALID");
    let tab = tabs.get(id);
    if (tab) {
      retryBrowser(id, tab);
      return tab;
    }
    const element = owner.document.createElement("div");
    element.dataset.frontendTab = id;
    element.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    element.hidden = id !== active;
    options.container.appendChild(element);
    const created: TabEntry = {
      element,
      browser: undefined as any,
      live: true,
      started: false,
      version: 0,
      url,
      history: [],
      index: -1,
    };
    tabs.set(id, created);
    beginBrowser(id, created);
    return created;
  }
  async function navigate(id: string, input: unknown, traversal = false) {
    const url = webURL(input, owner.location.origin);
    const popup = managed.get(id);
    if (popup) {
      const tab = tabs.get(popup.ownerId);
      if (!tab?.live) throw fail("FRONTEND_TAB_OWNER_UNAVAILABLE");
      activate(id); popup.url = url;
      const browser = await tab.browser;
      if (!live || !tab.live || !managed.has(id)) return;
      if (!browser.runtimeCommand?.("navigate", id, { url, engine: "runtime" })) throw fail("FRONTEND_CONTROL_NOT_IMPLEMENTED");
      return;
    }
    const tab = entry(id, url),
      version = ++tab.version;
    activate(id);
    tab.url = url;
    tab.expected = url;
    if (!traversal) {
      tab.history.splice(++tab.index);
      tab.history.push(url);
    }
    emit({ id, type: "loading" });
    try {
      const browser = await tab.browser;
      if (!live || !tab.live || version !== tab.version) return;
      const pendingStart = tab.starting;
      if (pendingStart) {
        await pendingStart.promise;
        if (!live || !tab.live || version !== tab.version) return;
        // A newer navigation waits for the one owner/connection startup, then
        // applies only its final destination rather than starting another owner.
        if (pendingStart.url !== url) await browser.navigate(url);
      } else if (!tab.started) {
        const starting = { url, promise: undefined as unknown as Promise<unknown> };
        const flight = Promise.resolve().then(() => browser.start(url)).then(() => {
          if (live && tab.live) tab.started = true;
        }).finally(() => {
          if (tab.starting === starting) tab.starting = undefined;
        });
        starting.promise = flight;
        tab.starting = starting;
        await flight;
      } else await browser.navigate(url);
      browser.runtimeCommand?.("panic-key", undefined, { key: panicKey });
    } catch (error) {
      if (live && tab.live && version === tab.version) report(id, error);
      throw error;
    }
  }
  function forgetControls(id: string) {
    pageSettings.delete(id); pageControls.delete(id); pageListeners.delete(id);
  }
  function disposeRoot(id: string) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.live = false; ++tab.version; tab.instance?.dispose(); tab.element.remove();
    tabs.delete(id); closedRoots.delete(id); forgetControls(id);
  }
  function close(id: string) {
    const popup = managed.get(id);
    if (popup) {
      const tab = tabs.get(popup.ownerId);
      if (tab) void tab.browser.then(browser => browser.runtimeCommand?.("close", id)).catch(error => report(id, error));
      managed.delete(id); forgetControls(id);
      if (closedRoots.has(popup.ownerId) && ![...managed.values()].some(value => value.ownerId === popup.ownerId)) disposeRoot(popup.ownerId);
      return;
    }
    const tab = tabs.get(id);
    if (!tab) return;
    if ([...managed.values()].some(value => value.ownerId === id)) {
      // Opener closure does not close live popup realms or their forms/media.
      closedRoots.add(id); forgetControls(id);
      void tab.browser.then(browser => browser.runtimeCommand?.("close")).catch(error => report(id, error));
      return;
    }
    disposeRoot(id);
  }
  return {
    pageControls: controlsFor,
    async connect() {
      const controller = entry(CONTROLLER_ID, "https://example.invalid/");
      return (await controller.browser).connect();
    },
    async navigate(id: string, url: string) {
      return navigate(id, url);
    },
    activate,
    close,
    async command(type: string, extra: Record<string, unknown> = {}) {
      const id = typeof extra.id === "string" ? extra.id : active;
      if (type === "navigate") return navigate(id, extra.url);
      if (type === "activate") {
        activate(id);
        return;
      }
      if (type === "close") {
        close(id);
        return;
      }
      if (type === "panic-key") {
        panicKey = typeof extra.key === "string" ? extra.key : "";
        for (const tab of tabs.values()) void tab.browser.then(browser => browser.runtimeCommand?.(type, undefined, { key: panicKey })).catch(error => report(id, error));
        return;
      }
      const tab = owningTab(id);
      if (!tab) return;
      if (managed.has(id)) {
        const browser = await tab.browser;
        if (browser.runtimeCommand?.(type, id, extra)) return;
      }
      if (type === "reload" || type === "back" || type === "forward") {
        const browser = await (type === "reload" ? retryBrowser(owningId(id), tab) : tab.browser);
        if (tab.started && browser.historyCommand?.(type)) return;
      }
      if (type === "reload") return navigate(id, tab.url, true);
      if (type === "back" || type === "forward") {
        const next = tab.index + (type === "back" ? -1 : 1);
        if (next >= 0 && next < tab.history.length) {
          tab.index = next;
          return navigate(id, tab.history[next], true);
        }
        return;
      }
      throw fail("FRONTEND_CONTROL_NOT_IMPLEMENTED");
    },
    async reconnect() {
      const currentId = owningTab(active) ? owningId(active) : CONTROLLER_ID;
      const current = tabs.get(currentId);
      if (!current) throw fail("FRONTEND_NO_ACTIVE_DOCUMENT");
      const browser = await retryBrowser(currentId, current);
      await browser.connect();
      await browser.reconnect();
      await Promise.all(
        [...tabs.values()]
          .filter((t) => t !== current)
          .map(async (t) => (await t.browser).check()),
      );
    },
    async selectNode(nodeId: string, csrf: string) {
      const current = owningTab(active) ?? tabs.get(CONTROLLER_ID);
      if (!current) throw fail("FRONTEND_NO_ACTIVE_DOCUMENT");
      const browser = await current.browser;
      await browser.connect();
      const assignment = await browser.selectNode(nodeId, csrf);
      await Promise.all(
        [...tabs.values()]
          .filter((t) => t !== current)
          .map(async (t) => (await t.browser).check()),
      );
      return assignment;
    },
    get frame() {
      return owningTab(active)?.instance?.document?.frame;
    },
    dispose() {
      if (!live) return;
      live = false;
      managed.clear();
      for (const id of [...tabs.keys()]) disposeRoot(id);
      void identity.then(
        (claimed) => claimed.dispose(),
        () => {},
      );
    },
  };
}

/** Explicit Settings action only. Never touches Atlas settings/admin state or
 * legacy node databases. Other windows must close live website transactions. */
export async function clearFrontendWebsiteData(owner: Owner) {
  const profile = getActiveProfile();
  if (profile) {
    const context = getActiveProfileContext();
    if (!context) throw fail("PROFILE_NOT_INITIALIZED");
    const { flushProfile } = await import("./profile-client");
    await flushProfile();
    const cookieClock = createCookieViewClock(owner, profile);
    cookieClock?.invalidate();
    try {
      await clearProfileWebsiteData(owner.indexedDB, profile, context, prepareProfileDocument);
    } finally { cookieClock?.invalidate(); }
    await flushProfile();
    return;
  }
  if (typeof owner.indexedDB.databases !== "function")
    throw fail("FRONTEND_DATABASE_ENUMERATION_UNAVAILABLE");
  const names = new Set([
    "atlas.browsing.v2",
    "atlas.browsing.cookies.v2",
    ...(await owner.indexedDB.databases())
      .map((database) => database.name)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          name.startsWith("atlas.browsing.idb.v2:") &&
          !name.startsWith("atlas.browsing.idb.v2:profile:"),
      ),
  ]);
  await Promise.all(
    [...names].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = owner.indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () =>
            reject(request.error ?? fail("FRONTEND_DATABASE_CLEAR_FAILED"));
          request.onblocked = () =>
            reject(
              fail(
                "Close other Atlas browsing windows, then clear website data again.",
              ),
            );
        }),
    ),
  );
}
