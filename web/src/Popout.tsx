import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  Globe2,
  PanelsTopLeft,
  RefreshCw,
  X,
} from "lucide-react";
import { createDirectTabUrl } from "../../runtime/direct-tab";
import { isSearchShortcut } from "../../runtime/browser-shortcuts";
import { matchesShortcut } from "../../runtime/panic-shortcut";
import { attachFullscreenKeyboard } from "../../runtime/fullscreen-keyboard";
import {
  api,
  defaults,
  destination,
  readLocal,
  sanitizeSettings,
  themes,
} from "./model";
import {
  createPopoutUrl,
  parsePopoutLaunch,
  type PopoutLaunch,
} from "./popout-link";
import "./popout.css";

type Connection = {
  runtimeOrigin: string;
  nodeRouting?: boolean;
  session?: string;
  ticket?: string;
  expiresLocally?: number;
};
type Page = { url: string; openerId?: string };
const ROOT_PAGE = "popout";
const EXPIRED =
  "This connection has expired. Return to Atlas and reconnect, then open this page again.";

function webAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A thin frontend-origin shell keeps the runtime in the same storage partition
 * as Atlas. It neither owns nor updates the original tab's persisted lease. */
export default function Popout() {
  const [launch] = useState<{ value?: PopoutLaunch; error?: string }>(() => {
    try {
      return { value: parsePopoutLaunch() };
    } catch (error) {
      return { error: (error as Error).message };
    }
  });
  const [settings] = useState(() =>
    sanitizeSettings(readLocal("atlas.settings", defaults)),
  );
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState(launch.error || "");
  const [expired, setExpired] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [address, setAddress] = useState(launch.value?.target || "");
  const [target, setTarget] = useState(launch.value?.target || "");
  const [popupActive, setPopupActive] = useState(false);
  const runtime = useRef<HTMLIFrameElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const startup = useRef<Promise<Connection> | null>(null);
  const active = useRef(ROOT_PAGE);
  const started = useRef(false);
  const pages = useRef(
    new Map<string, Page>([[ROOT_PAGE, { url: launch.value?.target || "" }]]),
  );
  const isExpired = useRef(false);

  function send(type: string, extra: Record<string, unknown> = {}) {
    if (!connection || isExpired.current) return;
    runtime.current?.contentWindow?.postMessage(
      {
        atlas: 1,
        type,
        id: active.current,
        ...extra,
        youtubeAdblock: launch.value?.youtubeAdblock !== false,
      },
      connection.runtimeOrigin,
    );
  }

  function expire() {
    isExpired.current = true;
    setExpired(true);
    setReady(false);
    setLoading(false);
    setError(EXPIRED);
  }

  function showPage(id: string) {
    const page = pages.current.get(id);
    if (!page) return;
    active.current = id;
    setPopupActive(id !== ROOT_PAGE);
    setAddress(page.url === "about:blank" ? "" : page.url);
    setTarget(page.url);
    setMessage("");
    if (webAddress(page.url) && launch.value) {
      history.replaceState(
        null,
        "",
        createPopoutUrl(
          location.origin,
          page.url,
          launch.value.session,
          launch.value.youtubeAdblock,
        ),
      );
    }
  }

  function focusAddress() {
    addressInput.current?.focus();
    addressInput.current?.select();
  }

  useEffect(() => {
    if (!launch.value) return;
    let mounted = true;
    // StrictMode can replay effects. Validate this exact lease only once and
    // never fall back to allocation or another tab's localStorage session.
    startup.current ||= api("/config", {
      signal: AbortSignal.timeout(12000),
    }).then(async (config) => {
      let result = config;
      if (config.nodeRouting) {
        if (!launch.value!.session)
          throw Object.assign(Error(EXPIRED), { status: 409 });
        const lease = await api("/browse/session", {
          method: "POST",
          body: JSON.stringify({ session: launch.value!.session }),
          signal: AbortSignal.timeout(12000),
        });
        if (lease.session !== launch.value!.session)
          throw Object.assign(Error(EXPIRED), { status: 409 });
        if (
          typeof lease.ticket !== "string" ||
          !lease.ticket ||
          lease.ticket.length > 32768 ||
          lease.node?.online === false
        )
          throw Error(
            "This node is unavailable. Return to Atlas to reconnect; this popout will not switch nodes automatically.",
          );
        result = {
          ...config,
          ...lease,
          expiresLocally:
            Number.isFinite(lease.expiresAt) &&
            Number.isFinite(lease.serverTime)
              ? Date.now() + lease.expiresAt - lease.serverTime
              : undefined,
        };
      }
      const origin = new URL(result.runtimeOrigin);
      if (
        !/^https?:$/.test(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.origin === location.origin
      )
        throw Error(
          "The browsing connection is not configured. Return to Atlas to check it.",
        );
      return { ...result, runtimeOrigin: origin.origin };
    });
    startup.current
      .then((config) => {
        if (!mounted) return;
        if (config.expiresLocally && config.expiresLocally <= Date.now())
          expire();
        else setConnection(config);
      })
      .catch((reason) => {
        if (!mounted) return;
        if (reason.status === 409) expire();
        else {
          setError(reason.message || "The browsing connection did not start.");
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [launch]);

  useEffect(() => {
    document.title = "Atlas";
    const preferred = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.mode =
        settings.mode === "system"
          ? preferred.matches
            ? "light"
            : "dark"
          : settings.mode;
    };
    apply();
    preferred.addEventListener("change", apply);
    return () => preferred.removeEventListener("change", apply);
  }, [settings.mode]);

  useEffect(() => {
    if (!connection?.expiresLocally || expired) return;
    const check = () => {
      if (Date.now() >= connection.expiresLocally!) expire();
    };
    const timer = setTimeout(
      check,
      Math.min(2147483647, Math.max(0, connection.expiresLocally - Date.now())),
    );
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [connection, expired]);

  useEffect(() => {
    if (!connection || expired) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== runtime.current?.contentWindow ||
        event.origin !== connection.runtimeOrigin ||
        event.data?.atlas !== 1 ||
        isExpired.current
      )
        return;
      const data = event.data;
      if (data.type === "ready") {
        setReady(true);
        setError("");
        if (!started.current) {
          started.current = true;
          send("panic-key", { id: "system", key: settings.exitKey });
          send("navigate", {
            id: ROOT_PAGE,
            url: launch.value!.target,
            engine: "scramjet",
          });
        }
        return;
      }
      if (data.type === "session-expired") {
        expire();
        return;
      }
      if (data.type === "boot-error") {
        setError(String(data.message || "The browsing runtime did not start."));
        setLoading(false);
        return;
      }
      if (data.type === "focus-search") {
        focusAddress();
        return;
      }
      if (
        data.type === "panic" &&
        settings.exitKey &&
        data.key === settings.exitKey
      ) {
        location.replace(settings.exitUrl);
        return;
      }
      if (
        data.type === "popup-created" &&
        typeof data.id === "string" &&
        data.id.length <= 100 &&
        data.id !== ROOT_PAGE &&
        (webAddress(data.url) || data.url === "about:blank")
      ) {
        if (!pages.current.has(data.id))
          pages.current.set(data.id, {
            url: data.url,
            openerId: pages.current.has(data.openerId)
              ? data.openerId
              : active.current,
          });
        showPage(data.id);
        send("activate", { id: data.id });
        setLoading(true);
        return;
      }
      if (data.type === "popup-focus" && pages.current.has(data.id)) {
        showPage(data.id);
        send("activate", { id: data.id });
        return;
      }
      if (data.type === "popup-closed") {
        const closed = pages.current.get(data.id);
        if (!closed || data.id === ROOT_PAGE) return;
        pages.current.delete(data.id);
        if (active.current === data.id) {
          const opener = pages.current.has(closed.openerId || "")
            ? closed.openerId!
            : ROOT_PAGE;
          showPage(opener);
          send("activate", { id: opener });
          setLoading(false);
        }
        return;
      }
      if (data.type === "open" && webAddress(data.url)) {
        const id = "popout-" + crypto.randomUUID();
        pages.current.set(id, { url: data.url, openerId: active.current });
        showPage(id);
        send("navigate", { id, url: data.url, engine: "scramjet" });
        setLoading(true);
        return;
      }
      const page = pages.current.get(data.id);
      if (!page) return;
      if (data.type === "navigation" && webAddress(data.url)) {
        page.url = data.url;
        if (data.id === active.current) showPage(data.id);
      }
      if (data.id !== active.current) return;
      if (data.type === "loading") {
        setLoading(true);
        setMessage("");
      }
      if (data.type === "loaded") {
        setLoading(false);
        setMessage("");
      }
      if (data.type === "error" || data.type === "slow") {
        setLoading(false);
        setMessage(
          String(
            data.message ||
              "The website did not finish loading. Try reloading it.",
          ),
        );
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [connection, expired, launch, settings]);

  useEffect(() => {
    if (!connection || expired || ready) return;
    const ping = () => send("ping", { id: "system" });
    ping();
    const retry = setInterval(ping, 500);
    const timeout = setTimeout(() => {
      setError(
        "The browsing connection is taking too long. Reload this popout or return to Atlas.",
      );
      setLoading(false);
    }, 25000);
    return () => {
      clearInterval(retry);
      clearTimeout(timeout);
    };
  }, [connection, expired, ready]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const editable =
        event.target instanceof Element &&
        event.target.closest(
          "input,textarea,select,[contenteditable],[data-panic-editor],dialog[open]",
        );
      if (
        settings.exitKey &&
        !editable &&
        matchesShortcut(event, settings.exitKey)
      ) {
        event.preventDefault();
        location.replace(settings.exitUrl);
      } else if (isSearchShortcut(event)) {
        event.preventDefault();
        focusAddress();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [settings]);

  useEffect(
    () =>
      attachFullscreenKeyboard(
        document,
        navigator,
        () => document.fullscreenElement === runtime.current,
        (state) => {
          if (state !== "locked")
            setMessage(
              "This browser may use Escape to leave fullscreen. Allow keyboard capture when prompted.",
            );
        },
      ),
    [],
  );

  let directUrl = "";
  if (connection && ready && !expired && webAddress(target)) {
    try {
      directUrl = createDirectTabUrl(
        connection.runtimeOrigin,
        target,
        connection.ticket,
        launch.value?.youtubeAdblock,
      );
    } catch {
      /* No direct link for internal pages. */
    }
  }
  const theme = themes.find((item) => item.id === settings.theme)!;
  const style = {
    "--accent": settings.accent,
    "--base": theme.bg,
    "--surface": theme.surface,
  } as CSSProperties;

  return (
    <main className="popout-shell" style={style}>
      <header className="popout-toolbar" aria-label="Popout toolbar">
        <a className="popout-brand" href="/" aria-label="Atlas home">
          Atlas
        </a>
        <div className="popout-navigation">
          <button
            type="button"
            aria-label="Go back"
            title="Go back"
            disabled={!ready || expired}
            onClick={() => send("back")}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            aria-label="Go forward"
            title="Go forward"
            disabled={!ready || expired}
            onClick={() => send("forward")}
          >
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            aria-label="Reload"
            title="Reload page"
            disabled={!ready || expired}
            onClick={() => {
              setMessage("");
              send("reload");
            }}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <form
          className="popout-address"
          aria-label="Popout browser controls"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || expired) return;
            try {
              const url = destination(address, settings.search);
              createPopoutUrl(
                location.origin,
                url,
                launch.value?.session,
                launch.value?.youtubeAdblock,
              );
              pages.current.get(active.current)!.url = url;
              showPage(active.current);
              setLoading(true);
              send("navigate", { url, engine: "scramjet" });
              addressInput.current?.blur();
            } catch (reason) {
              setMessage((reason as Error).message);
            }
          }}
        >
          <Globe2 size={15} aria-hidden="true" />
          <input
            ref={addressInput}
            aria-label="Website address"
            placeholder="Search or enter a URL"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={expired}
          />
          <button
            type="submit"
            aria-label="Go to website"
            title="Go to website"
            disabled={!ready || expired}
          >
            <ArrowUpRight size={16} />
          </button>
        </form>
        {popupActive && (
          <button
            type="button"
            className="popout-tool"
            aria-label="Close sign-in popup"
            title="Close popup and return to the previous page"
            disabled={!ready || expired}
            onClick={() => {
              const id = active.current;
              const opener = pages.current.get(id)?.openerId;
              send("close", { id });
              pages.current.delete(id);
              const next =
                opener && pages.current.has(opener) ? opener : ROOT_PAGE;
              showPage(next);
              send("activate", { id: next });
              setLoading(false);
            }}
          >
            <X size={16} />
          </button>
        )}
        {directUrl && (
          <a
            className="popout-tool popout-direct"
            href={directUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open direct node tab"
            title="Direct node tab — separate website storage; you may need to sign in again"
          >
            <ExternalLink size={15} />
            <span>Direct node</span>
          </a>
        )}
        <a
          className="popout-tool popout-return"
          href="/"
          aria-label="Return to Atlas"
          title="Return to Atlas"
        >
          <PanelsTopLeft size={15} />
          <span>Return to Atlas</span>
        </a>
      </header>
      <section className="popout-content" aria-label="Website">
        {connection && !expired && (
          <iframe
            ref={runtime}
            title="Atlas isolated browsing runtime"
            src={
              connection.runtimeOrigin +
              (connection.ticket
                ? "#ticket=" + encodeURIComponent(connection.ticket)
                : "")
            }
            onLoad={() => send("ping", { id: "system" })}
            allow="autoplay; encrypted-media; fullscreen; clipboard-write; camera; microphone"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-presentation"
          />
        )}
        {error ? (
          <div className="popout-state" role="alert">
            <h1>Connection unavailable</h1>
            <p>{error}</p>
            <div>
              <a href="/">Return to Atlas</a>
              {!expired && launch.value && (
                <button type="button" onClick={() => location.reload()}>
                  Reload popout
                </button>
              )}
            </div>
          </div>
        ) : (
          loading && (
            <div className="popout-loading" role="status">
              {ready ? "Loading website…" : "Connecting…"}
            </div>
          )
        )}
        {message && !error && (
          <div className="popout-message" role="status">
            <span>{message}</span>
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => setMessage("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
