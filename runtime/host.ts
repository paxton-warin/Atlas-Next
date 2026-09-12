// Pinned fork bootstrap/transport; Atlas adds its frame bridge and upgrade handling.
import { migrateCookies, activateWorker } from "./runtime-migration";
import { watchFavicon } from "./favicon";
const globals = window as any;
const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket") || "";
const response = await fetch("/runtime-config", {
  headers: ticket ? { authorization: "Bearer " + ticket } : {},
});
const config = await response.json();
if (!response.ok)
  throw Error(
    config.message || config.error || "Browsing node is unavailable.",
  );
const relayQuery = ticket ? encodeURIComponent(ticket) + "/" : "";
const standalone = parent === window;
const notify = (type: string, data: Record<string, unknown> = {}) => {
  if (standalone) {
    if (type === "title" && data.title)
      document.title = String(data.title) + " — Atlas";
    if (type === "navigation" && typeof data.url === "string") {
      const field = document.querySelector<HTMLInputElement>("#popup-address");
      if (field) field.value = data.url;
    }
    return;
  }
  parent.postMessage({ atlas: 1, type, ...data }, config.appOrigin);
};
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
let controller: any;
let initialization: Promise<void> | undefined;
let uvInitialization: Promise<void> | undefined;
let uvIconFetcher: Promise<typeof fetch>;
const container = document.getElementById("frames")!;
async function activated(reg: ServiceWorkerRegistration) {
  if (reg.active) return reg.active;
  const sw = reg.installing || reg.waiting;
  if (!sw) throw Error("No worker is available.");
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(Error("Worker activation timed out.")),
      15000,
    );
    const changed = () => {
      if (sw.state === "activated") {
        clearTimeout(t);
        sw.removeEventListener("statechange", changed);
        resolve();
      }
    };
    sw.addEventListener("statechange", changed);
    changed();
  });
  return reg.active!;
}
async function init() {
  await migrateCookies();
  const sw = await activateWorker("/worker.js");
  // Use the fork's shipped bootstrap and matching HTTP transport unchanged.
  // loadRest avoids its init() returning the old active worker during an update.
  const bootstrapPath = "/bootstrap/bootstrap-client.js";
  const { loadRest } = await import(/* @vite-ignore */ bootstrapPath);
  controller = await loadRest(sw, {
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
        () => reject(Error("Scramjet initialization timed out.")),
        25000,
      ),
    ),
  ]);
}
function load(src: string) {
  return new Promise<void>((ok, bad) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => ok();
    s.onerror = () => bad(Error("Runtime asset failed to load."));
    document.head.append(s);
  });
}
async function initUv() {
  await load("/vendor/uv/uv.bundle.js");
  await load("/uv/uv.config.js");
  await load("/vendor/baremux/index.js");
  const reg = await navigator.serviceWorker.register("/uv/sw.js", {
    scope: "/uv/",
    updateViaCache: "none",
  });
  await activated(reg);
  const mux = new globals.BareMux.BareMuxConnection(
    "/vendor/baremux/worker.js",
  );
  await mux.setTransport("/vendor/epoxy/index.mjs", [
    {
      wisp: config.runtimeOrigin.replace(/^http/, "ws") + "/wisp/" + relayQuery,
      wisp_v2: true,
    },
  ]);
  // The host at / is outside UV's /uv/ worker scope. Fetch UV icons from a
  // same-origin, worker-controlled document rather than issuing an unproxied
  // request or changing either engine's service-worker scope.
  uvIconFetcher = new Promise<typeof fetch>((resolve) => {
    const relay = document.createElement("iframe");
    relay.hidden = true;
    relay.title = "Ultraviolet icon loader";
    relay.setAttribute("aria-hidden", "true");
    const timeout = setTimeout(() => {
      relay.remove();
      resolve(async () => {
        throw Error("Icon loader timed out.");
      });
    }, 8000);
    relay.onload = () => {
      clearTimeout(timeout);
      const realm = relay.contentWindow as Window & typeof globalThis;
      resolve(realm.fetch.bind(realm));
    };
    relay.src = "/uv/favicon.html";
    document.body.append(relay);
  });
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
}
async function navigate(id: string, url: string, engine: string) {
  if (engine === "ultraviolet")
    await (uvInitialization ??= initUv().catch((error) => {
      uvInitialization = undefined;
      throw error;
    }));
  else
    await (initialization ??= init().catch((error) => {
      initialization = undefined;
      throw error;
    }));
  let record = records.get(id);
  if (record && record.engine !== engine) {
    destroy(id);
    record = undefined;
  }
  if (!record) {
    const element = document.createElement("iframe");
    element.title = "Proxied website";
    element.allow =
      "autoplay; encrypted-media; fullscreen; clipboard-write; camera; microphone";
    record = { element, engine, frame: null };
    records.set(id, record);
    container.append(element);
    if (engine === "scramjet") {
      const { HttpCachePlugin, UrlWatcherPlugin, CatchEscapedLinksPlugin } =
        globals.$runtimekitUtils;
      record.frame = controller.createFrame(element, {
        plugins: [
          new HttpCachePlugin(),
          new UrlWatcherPlugin((value: URL) =>
            notify("navigation", { id, url: String(value) }),
          ),
          new CatchEscapedLinksPlugin(
            (value: URL) =>
              new URL(
                "/?goto=" +
                  encodeURIComponent(String(value)) +
                  (ticket ? "#ticket=" + encodeURIComponent(ticket) : ""),
                location.origin,
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
          const nativeUrl = Object.getOwnPropertyDescriptor(
            Document.prototype,
            "URL",
          )!.get!.call(doc) as string;
          const prefix = r.frame
            ? r.frame.context.prefix.href
            : new URL(globals.__uv$config.prefix, location.origin).href;
          const pageUrl = r.frame
            ? globals.$runtimekit.restoreurl(nativeUrl, r.frame.context)
            : globals.__uv$config.decodeUrl(nativeUrl.slice(prefix.length));
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
              return r.frame
                ? globals.$runtimekit.transformUrl(target, r.frame.context, {
                    origin: new URL(pageUrl),
                    base: new URL(pageUrl),
                  })
                : prefix + globals.__uv$config.encodeUrl(target);
            },
            (favicon) => notify("favicon", { id, favicon }),
            r.engine === "ultraviolet"
              ? async (...args) => (await uvIconFetcher)(...args)
              : fetch,
          );
        }
      } catch {}
    });
  }
  for (const [key, item] of records) item.element.hidden = key !== id;
  clearTimeout(record.timer);
  record.disposeFavicon?.();
  notify("favicon", { id, favicon: "" });
  record.timer = setTimeout(
    () =>
      notify("slow", {
        id,
        message:
          "This page is taking longer than expected. You can wait, reload, or try another engine.",
      }),
    30000,
  );
  notify("loading", { id });
  if (record.frame) await record.frame.go(url);
  else
    record.element.src =
      globals.__uv$config.prefix + globals.__uv$config.encodeUrl(url);
}
window.addEventListener("message", async (event) => {
  if (
    event.source !== parent ||
    event.origin !== config.appOrigin ||
    event.data?.atlas !== 1
  )
    return;
  const { type, id, url, engine } = event.data;
  if (type === "ping") {
    notify("ready");
    return;
  }
  try {
    if (typeof id !== "string" || id.length > 100) return;
    if (type === "navigate")
      await navigate(
        id,
        publicUrl(url),
        engine === "ultraviolet" ? "ultraviolet" : "scramjet",
      );
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
  document.body.prepend(bar);
  container.style.top = "52px";
  container.style.height = "calc(100% - 52px)";
  container.style.position = "absolute";
  const field = bar.querySelector<HTMLInputElement>("input")!;
  const go = async () => {
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
  const initial = new URL(location.href).searchParams.get("goto");
  if (initial) {
    field.value = initial;
    void go();
  }
} else notify("ready");
