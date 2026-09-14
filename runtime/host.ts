// Pinned fork bootstrap/transport; Atlas adds its frame bridge and upgrade handling.
import { createRelayController } from "./relay-controller";
import { migrateCookies, activateWorker } from "./runtime-migration";
import { loadRuntimeConfig, watchRuntimeSession } from "./connection";
import { watchFavicon } from "./favicon";
import { matchesShortcut, normalizeShortcut } from "./panic-shortcut";
import { installPageBridge } from "./page-bridge";
import { attachFullscreenKeyboard } from "./fullscreen-keyboard";
import { createDirectTabUrl } from "./direct-tab";
import { createYouTubeAdblockPlugin } from "./youtube-adblock";
const globals = window as any;
const launchParams = new URLSearchParams(location.hash.slice(1));
const ticket = launchParams.get("ticket") || "";
let youtubeAdblock = launchParams.get("adblock") !== "0";
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
const relayQuery = ticket ? encodeURIComponent(ticket) + "/" : "";
let standaloneExpired = false;
const notify = (type: string, data: Record<string, unknown> = {}) => {
  if (standalone) {
    if (type === "title" && data.title)
      document.title = String(data.title) + " — Atlas";
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
          ),
        );
      } catch {
        // Transient about:blank popup documents have no destination to restore.
      }
    }
    const status = document.querySelector<HTMLElement>("#popup-status");
    if (status) {
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
watchRuntimeSession(ticket, notify);
const records = new Map<
  string,
  {
    element: HTMLIFrameElement;
    frame: any;
    engine: string;
    timer?: ReturnType<typeof setTimeout>;
    disposeFavicon?: () => void;
  }
>();
let panicKey = "";
const panicDocuments = new WeakSet<Document>();
let controller: any;
let initialization: Promise<void> | undefined;
const container = document.getElementById("frames")!;
async function init() {
  await migrateCookies();
  const sw = await activateWorker("/worker.js");
  // Use the fork's shipped bootstrap and matching HTTP transport unchanged.
  // loadRest avoids its init() returning the old active worker during an update.
  const bootstrapPath = "/bootstrap/bootstrap-client.js";
  const { loadRest } = await import(/* @vite-ignore */ bootstrapPath);
  controller =
    config.relayOrigin && config.relayTicket
      ? await createRelayController(sw, config.relayOrigin, config.relayTicket)
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
function attachPageBridge(
  id: string,
  win: Window & typeof globalThis,
  client?: any,
) {
  const record = records.get(id)!;
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
      destroy(id);
      notify("popup-closed", { id, openerId: popup.openerId });
    };
    win.focus = () => {
      for (const [key, r] of records) r.element.hidden = key !== id;
      notify("popup-focus", { id });
    };
  }
  installPageBridge(win, {
    topName: record.element.name,
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
          const button = submitter as
            | HTMLButtonElement
            | HTMLInputElement
            | null;
          const effective = (
            attr: string,
            buttonValue: string | undefined,
            formValue: string,
          ) => (button?.hasAttribute(attr) ? buttonValue! : formValue);
          // The fork restores URL attributes, but not the camel-case formAction getter.
          const action = button?.hasAttribute("formaction")
            ? button.getAttribute("formaction")!
            : form.getAttribute("action") || client.url.href;
          const submitted = document.createElement("form");
          submitted.action = encode(
            publicUrl(
              new URL(
                action || client.url.href,
                form.baseURI || client.url.href,
              ).href,
            ),
          );
          submitted.target = child.element.name;
          submitted.method = effective(
            "formmethod",
            button?.formMethod,
            form.method,
          );
          submitted.enctype = effective(
            "formenctype",
            button?.formEnctype,
            form.enctype,
          );
          submitted.acceptCharset = form.acceptCharset || "UTF-8";
          submitted.hidden = true;
          for (const [name, value] of new FormData(form, button)) {
            const input = document.createElement("input");
            input.name = name;
            if (typeof value === "string") {
              input.type = "hidden";
              input.value = value;
            } else {
              input.type = "file";
              const transfer = new DataTransfer();
              transfer.items.add(value);
              input.files = transfer.files;
            }
            submitted.append(input);
          }
          document.body.append(submitted);
          try {
            HTMLFormElement.prototype.submit.call(submitted);
          } finally {
            setTimeout(() => submitted.remove(), 0);
          }
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
      this.tap(frame.hooks.init.post, ({ window, client }: any) =>
        attachPageBridge(id, window, client),
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
  element.name = "atlas-frame-" + id;
  records.set(id, record);
  container.append(element);
  {
    const { HttpCachePlugin, UrlWatcherPlugin, CatchEscapedLinksPlugin } =
      globals.$runtimekitUtils;
    record.frame = controller.createFrame(element, {
      plugins: [
        pageBridgePlugin(id),
        createYouTubeAdblockPlugin(globals, () => youtubeAdblock),
        new HttpCachePlugin(),
        new UrlWatcherPlugin((value: URL) =>
          notify("navigation", { id, url: String(value) }),
        ),
        new CatchEscapedLinksPlugin(
          (value: URL) =>
            new URL(
              createDirectTabUrl(
                location.origin,
                String(value),
                ticket || undefined,
                youtubeAdblock,
              ),
            ),
        ),
      ],
    });
  }
  element.addEventListener("load", () => {
    const r = records.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    r.disposeFavicon?.();
    notify("loaded", { id });
    try {
      const doc = element.contentDocument;
      notify("title", { id, title: doc?.title?.slice(0, 160) || "" });
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
  engine = "scramjet";
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
  notify("loading", { id });
  await record.frame.go(url);
}
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
    if (typeof id !== "string" || id.length > 100) return;
    if (type === "panic-key") {
      panicKey = normalizeShortcut(event.data.key);
      return;
    }
    if (type === "navigate") await navigate(id, publicUrl(url), "scramjet");
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
        "/clear.html" + (ticket ? "#ticket=" + encodeURIComponent(ticket) : ""),
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
  bar.innerHTML =
    '<strong>Atlas</strong><button type="button" id="popup-back" aria-label="Go back">←</button><button type="button" id="popup-reload" aria-label="Reload">↻</button><input id="popup-address" type="url" aria-label="Website address" required><button>Go ↗</button><span id="popup-status" role="status"></span>';
  const returnLink = document.createElement("a");
  returnLink.href = config.appOrigin;
  returnLink.textContent = "Return to Atlas";
  returnLink.id = "popup-return";
  bar.append(returnLink);
  document.body.prepend(bar);
  container.style.top = "52px";
  container.style.height = "calc(100% - 52px)";
  container.style.position = "absolute";
  const field = bar.querySelector<HTMLInputElement>("input")!;
  const go = async () => {
    if (standaloneExpired) return;
    try {
      await navigate("popup", publicUrl(field.value), "scramjet");
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
    records.get("popup")?.frame?.back();
  bar.querySelector<HTMLButtonElement>("#popup-reload")!.onclick = () =>
    records.get("popup")?.frame?.reload();
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
  const initial =
    launchParams.get("goto") || new URL(location.href).searchParams.get("goto");
  if (initial) {
    field.value = initial;
    void go();
  }
} else notify("ready");
