import Catalog from "./Catalog";
import { version as appVersion } from "../../package.json";
import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
import { matchesShortcut } from "../../runtime/panic-shortcut";
import { isSearchShortcut } from "../../runtime/browser-shortcuts";
import { createDirectTabUrl } from "../../runtime/direct-tab";
import { attachFullscreenKeyboard } from "../../runtime/fullscreen-keyboard";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Command,
  Compass,
  ExternalLink,
  Gamepad2,
  Grid2X2,
  Globe2,
  Heart,
  HelpCircle,
  History,
  Leaf,
  Maximize2,
  MoreHorizontal,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  X,
} from "lucide-react";
import {
  api,
  defaults,
  destination,
  readLocal,
  sanitizeSettings,
  themes,
  writeLocal,
  type Settings as Preferences,
  type Tab,
  type Game,
  type Engine,
} from "./model";
import SearchBox from "./SearchBox";
import BrowsingOptions, { ReconnectDialog } from "./BrowsingOptions";
import SetupWizard from "./SetupWizard";
import { tabAppearance } from "./tab-presets";
import { Settings } from "./Settings";
import Support from "./Support";
const AiChat = lazy(() => import("./AiChat"));
const Admin = lazy(() => import("./Admin"));
const seedShortcuts = [
  {
    name: "Google",
    url: "https://www.google.com",
    symbol: "G",
    color: "#d8e5fa",
  },
  {
    name: "YouTube",
    url: "https://www.youtube.com",
    symbol: "▶",
    color: "#f8b7b3",
  },
  {
    name: "ChatGPT",
    url: "https://chatgpt.com",
    symbol: "✳",
    color: "#bce39b",
  },
  {
    name: "Spotify",
    url: "https://open.spotify.com",
    symbol: "≋",
    color: "#90dcad",
  },
  {
    name: "Discord",
    url: "https://discord.com/app",
    symbol: "◕",
    color: "#c2b9f5",
  },
];
function NewTabGreeting() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const period =
    now.getHours() < 12
      ? "morning"
      : now.getHours() < 18
        ? "afternoon"
        : "evening";
  return (
    <>
      <div className="newtab-datetime">
        <time className="newtab-date" dateTime={now.toISOString()}>
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </time>
        <time
          className="newtab-clock"
          aria-label="Current time"
          aria-live="off"
          dateTime={now.toISOString()}
        >
          {now.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
          })}
        </time>
      </div>
      <h1>
        Good <em>{period}.</em>
      </h1>
    </>
  );
}
export default function App() {
  const [settings, setSettings] = useState<Preferences>(() =>
    sanitizeSettings(readLocal("atlas.settings", defaults)),
  );
  const [page, setPage] = useState(
    location.pathname === "/support" ? "support" : "home",
  );
  const [wizard, setWizard] = useState(
    () => !readLocal("atlas.onboarded", false),
  );
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState<any>(null);
  const [connectionExpired, setConnectionExpired] = useState(false);
  const [reconnectReason, setReconnectReason] = useState<
    "expired" | "manual" | null
  >(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState("");
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const s = sanitizeSettings(readLocal("atlas.settings", defaults));
    return s.restore
      ? readLocal<Tab[]>("atlas.tabs", [])
          .filter(
            (t) =>
              t &&
              typeof t.id === "string" &&
              typeof t.url === "string" &&
              /^https?:\/\//.test(t.url),
          )
          .slice(0, 20)
          .map((t) => ({
            ...t,
            engine: "scramjet" as const,
            favicon: undefined,
            status: "ready",
          }))
      : [];
  });
  const [active, setActive] = useState(""),
    [address, setAddress] = useState(""),
    [search, setSearch] = useState(""),
    [collapsed, setCollapsed] = useState(
      () => readLocal<boolean>("atlas.sidebarCollapsed", true) !== false,
    ),
    [shortcutForm, setShortcutForm] = useState(false),
    [shortcut, setShortcut] = useState({ name: "", url: "" });
  const [shortcuts, setShortcuts] = useState(() =>
      readLocal("atlas.shortcuts", seedShortcuts),
    ),
    [games, setGames] = useState<Game[]>([]);
  const [aiOpened, setAiOpened] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [searchFocusRequest, requestSearchFocus] = useState(0);
  function focusSearch() {
    if (wizard) return;
    setFocusMode(false);
    if (page !== "browse" && page !== "home") setPage("home");
    requestSearchFocus((n) => n + 1);
  }
  useEffect(() => {
    if (!searchFocusRequest) return;
    const input = document.querySelector<HTMLInputElement>(
      "#omnibox, .hero-search input",
    );
    input?.focus();
    input?.select();
  }, [searchFocusRequest]);
  const lastBrowserTab = useRef("");
  const lastAiTab = useRef("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const runtimeRef = useRef<HTMLIFrameElement>(null),
    pendingClear = useRef(false),
    live = useRef(new Set<string>()),
    tabsRef = useRef(tabs),
    activeRef = useRef(active);
  const adblockRef = useRef(settings.youtubeAdblock);
  adblockRef.current = settings.youtubeAdblock;
  useEffect(() => {
    let pendingNotice = "";
    // A shell toast is outside the fullscreen iframe. Show failures once the
    // player exits, rather than expiring an invisible message behind the game.
    const showNotice = () => {
      if (!document.fullscreenElement && pendingNotice) {
        setNotice(pendingNotice);
        pendingNotice = "";
      }
    };
    const dispose = attachFullscreenKeyboard(
      document,
      navigator,
      () => document.fullscreenElement === runtimeRef.current,
      (state) => {
        pendingNotice =
          state === "locked"
            ? ""
            : state === "unavailable"
              ? "This browser does not support fullscreen keyboard capture. Esc may exit fullscreen."
              : "Fullscreen keyboard capture was not enabled. Esc may exit fullscreen; check your browser's site permissions.";
        showNotice();
      },
    );
    document.addEventListener("fullscreenchange", showNotice);
    return () => {
      document.removeEventListener("fullscreenchange", showNotice);
      dispose();
    };
  }, []);
  tabsRef.current = tabs;
  activeRef.current = active;
  const current = tabs.find((t) => t.id === active);
  const isAi = current?.workspace === "ai";
  const showingSite =
    !!current && ((page === "browse" && !isAi) || (page === "ai" && isAi));
  const browsingSection = ["home", "browse"].includes(page);
  let directTabUrl: string | undefined;
  if (
    showingSite &&
    !current?.local &&
    config?.runtimeOrigin &&
    !config.connectionError &&
    !connectionExpired &&
    config.node?.online !== false &&
    (!config.expiresLocally || config.expiresLocally > Date.now()) &&
    (!config.nodeRouting || config.ticket)
  ) {
    try {
      if (new URL(current.url).origin !== location.origin)
        directTabUrl = createDirectTabUrl(
          config.runtimeOrigin,
          current.url,
          config.ticket || undefined,
          settings.youtubeAdblock,
        );
    } catch {
      // Internal pages, invalid URLs and unavailable leases have no live link.
    }
  }

  const visibleTabs = tabs.filter((t) =>
    page === "ai" ? t.workspace === "ai" : t.workspace !== "ai",
  );
  const theme = themes.find((t) => t.id === settings.theme)!;
  const toast = (text: string) => setNotice(text);
  function update(patch: Partial<Preferences>) {
    setSettings((old) => {
      const next = sanitizeSettings({ ...old, ...patch });
      if (!writeLocal("atlas.settings", next))
        toast("Device storage is full. Try a smaller background.");
      return next;
    });
  }
  useEffect(() => {
    api("/config")
      .then(async (config) => {
        if (!config.nodeRouting) return setConfig(config);
        try {
          const lease = await api("/browse/session", {
            method: "POST",
            body: JSON.stringify({
              session: readLocal("atlas.nodeSession", ""),
            }),
          });
          writeLocal("atlas.nodeSession", lease.session);
          setConfig({
            ...config,
            ...lease,
            expiresLocally: lease.expiresAt
              ? Date.now() + lease.expiresAt - lease.serverTime
              : undefined,
          });
        } catch (error) {
          setConfig({ ...config, connectionError: (error as Error).message });
          if ((error as Error & { status?: number }).status === 409)
            expireConnection();
        }
      })
      .catch((e) => toast(e.message));
    api<Game[]>("/catalog")
      .then(setGames)
      .catch((e) => toast(e.message));
  }, []);
  useEffect(() => {
    writeLocal("atlas.sidebarCollapsed", collapsed);
  }, [collapsed]);
  useEffect(() => {
    writeLocal("atlas.settings", settings);
  }, [settings]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    const q = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.mode =
        settings.mode === "system"
          ? q.matches
            ? "light"
            : "dark"
          : settings.mode;
    };
    apply();
    q.addEventListener("change", apply);
    return () => q.removeEventListener("change", apply);
  }, [settings.mode]);
  useEffect(() => {
    const appearance = tabAppearance(settings);
    document.title = appearance.title;
    const icon =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ||
      document.createElement("link");
    icon.rel = "icon";
    icon.href = appearance.icon;
    icon.type = appearance.icon.endsWith(".svg")
      ? "image/svg+xml"
      : appearance.icon.endsWith(".ico")
        ? "image/x-icon"
        : "image/png";
    icon.dataset.atlasTabIcon = "true";
    if (!icon.isConnected) document.head.append(icon);
  }, [settings.tabPreset, settings.title, settings.tabIcon]);
  useEffect(() => {
    writeLocal(
      "atlas.tabs",
      settings.restore
        ? tabs.map(({ id, url, title, engine, local, workspace }) => ({
            id,
            url,
            title,
            engine,
            local,
            workspace,
          }))
        : [],
    );
  }, [tabs, settings.restore]);
  function send(type: string, extra: Record<string, unknown> = {}) {
    if (config)
      runtimeRef.current?.contentWindow?.postMessage(
        {
          atlas: 1,
          type,
          id: activeRef.current || "system",
          ...extra,
          youtubeAdblock: adblockRef.current,
        },
        config.runtimeOrigin,
      );
  }
  function expireConnection() {
    setConnectionExpired(true);
    setRuntimeReady(false);
    setReconnectError("");
    setReconnectReason("expired");
  }
  function requestReconnect() {
    setReconnectError("");
    setReconnectReason(connectionExpired ? "expired" : "manual");
  }
  async function reconnectNode() {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectError("");
    try {
      const old = readLocal("atlas.nodeSession", "");
      if (old)
        await api("/browse/session", {
          method: "DELETE",
          body: JSON.stringify({ session: old }),
        });
      writeLocal("atlas.nodeSession", "");
      setConnectionExpired(true);
      setRuntimeReady(false);
      const lease = await api("/browse/session", {
        method: "POST",
        body: JSON.stringify({ session: "" }),
      });
      writeLocal("atlas.nodeSession", lease.session);
      setConfig({
        ...config,
        ...lease,
        connectionError: "",
        expiresLocally: lease.expiresAt
          ? Date.now() + lease.expiresAt - lease.serverTime
          : undefined,
      });
      setConnectionExpired(false);
      setReconnectReason(null);
      restartRuntime();
    } catch (error) {
      setReconnectError((error as Error).message);
    } finally {
      setReconnecting(false);
    }
  }
  useEffect(() => {
    if (!config?.expiresLocally || connectionExpired) return;
    const check = () => {
      if (Date.now() >= config.expiresLocally) expireConnection();
    };
    const timer = setTimeout(
      check,
      Math.max(0, config.expiresLocally - Date.now()),
    );
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
    };
  }, [config?.expiresLocally, connectionExpired]);
  function navigate(
    value: string,
    newTab = false,
    engine?: Engine,
    workspace: "browser" | "ai" = "browser",
  ) {
    try {
      const url = destination(value, settings.search),
        chosen: Engine = "scramjet";
      let id = activeRef.current;
      if (newTab || !id || !tabsRef.current.some((t) => t.id === id))
        id = crypto.randomUUID();
      const tab: Tab = {
        id,
        url,
        title: new URL(url).hostname.replace(/^www\./, ""),
        engine: chosen,
        status: "loading",
        workspace,
      };
      setTabs((old) =>
        old.some((t) => t.id === id)
          ? old.map((t) => (t.id === id ? tab : t))
          : [...old, tab],
      );
      setActive(id);
      setAddress(url);
      setPage(workspace === "ai" ? "ai" : "browse");
      (workspace === "ai" ? lastAiTab : lastBrowserTab).current = id;
      if (runtimeReady) {
        send("navigate", { id, url, engine: chosen });
        live.current.add(id);
      }
      if (settings.history) {
        const entries = readLocal<any[]>("atlas.history", []);
        writeLocal(
          "atlas.history",
          [
            { url, title: tab.title, time: Date.now() },
            ...entries.filter((t) => t.url !== url),
          ].slice(0, 100),
        );
      }
    } catch (e) {
      toast((e as Error).message);
    }
  }
  useEffect(() => {
    if (!runtimeReady) return;
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (tab && !tab.local && !live.current.has(tab.id)) {
      send("navigate", { id: tab.id, url: tab.url, engine: tab.engine });
      live.current.add(tab.id);
    }
  }, [runtimeReady, active]);
  useEffect(() => {
    function receive(e: MessageEvent) {
      if (
        e.source !== runtimeRef.current?.contentWindow ||
        e.origin !== config?.runtimeOrigin ||
        e.data?.atlas !== 1
      )
        return;
      const d = e.data;
      if (d.type === "focus-search") {
        focusSearch();
        return;
      }
      if (
        d.type === "popup-created" &&
        typeof d.id === "string" &&
        typeof d.url === "string" &&
        /^(?:https?:\/\/|about:blank$)/.test(d.url)
      ) {
        live.current.add(d.id);
        const tab: Tab = {
          id: d.id,
          url: d.url,
          title: d.url === "about:blank" ? "New tab" : new URL(d.url).hostname,
          engine: "scramjet",
          status: "loading",
          workspace: "browser",
        };
        setTabs((old) =>
          old.some((t) => t.id === d.id) ? old : [...old, tab],
        );
        setActive(d.id);
        setAddress(d.url === "about:blank" ? "" : d.url);
        lastBrowserTab.current = d.id;
        setPage("browse");
        return;
      }
      if (d.type === "popup-focus") {
        const tab = tabsRef.current.find((t) => t.id === d.id);
        if (tab) activate(tab);
        return;
      }
      if (d.type === "popup-closed") {
        live.current.delete(d.id);
        setTabs((old) => old.filter((t) => t.id !== d.id));
        if (activeRef.current === d.id) {
          const tab =
            tabsRef.current.find((t) => t.id === d.openerId) ||
            tabsRef.current.find((t) => t.id !== d.id);
          if (tab) activate(tab);
          else {
            setActive("");
            setPage("home");
            setAddress("");
          }
        }
        return;
      }
      if (d.type === "session-expired") {
        expireConnection();
        return;
      }
      if (
        d.type === "panic" &&
        !wizard &&
        settings.exitKey &&
        d.key === settings.exitKey
      ) {
        location.replace(settings.exitUrl);
        return;
      }
      if (d.type === "ready") {
        setRuntimeReady(true);
        setRuntimeError("");
        return;
      }
      if (d.type === "boot-error") {
        setRuntimeError(
          String(d.message || "Browsing runtime failed to start."),
        );
        return;
      }
      if (d.type === "open" && typeof d.url === "string") {
        navigate(d.url, true);
        return;
      }
      if (d.type === "clear-ready" && pendingClear.current) {
        send("confirm-clear", { id: "system" });
        return;
      }
      if (d.type === "clear-error") {
        pendingClear.current = false;
        toast(d.message);
        return;
      }
      if (d.type === "cleared") {
        pendingClear.current = false;
        toast("Website data cleared.");
        if (runtimeRef.current)
          runtimeRef.current.src =
            config.runtimeOrigin +
            (config.ticket
              ? "#ticket=" + encodeURIComponent(config.ticket)
              : "");
        setRuntimeReady(false);
        live.current.clear();
        return;
      }
      setTabs((old) =>
        old.map((t) => {
          if (t.id !== d.id) return t;
          if (
            d.type === "navigation" &&
            typeof d.url === "string" &&
            /^https?:\/\//.test(d.url)
          ) {
            if (t.id === activeRef.current) setAddress(d.url);
            return { ...t, url: d.url };
          }
          if (d.type === "title" && d.title)
            return { ...t, title: String(d.title).slice(0, 100) };
          if (d.type === "favicon" && typeof d.favicon === "string")
            return {
              ...t,
              favicon:
                d.favicon.length <= 16384 &&
                /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(d.favicon)
                  ? d.favicon
                  : undefined,
            };
          if (d.type === "error" || d.type === "slow")
            return { ...t, status: d.type, message: d.message };
          if (d.type === "loaded")
            return { ...t, status: "ready", message: undefined };
          if (d.type === "loading") return { ...t, status: "loading" };
          return t;
        }),
      );
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [
    config,
    runtimeReady,
    settings.engine,
    settings.search,
    settings.history,
    settings.exitKey,
    settings.exitUrl,
    wizard,
    page,
  ]);
  useEffect(() => {
    if (runtimeReady)
      send("panic-key", { key: wizard ? "" : settings.exitKey });
  }, [runtimeReady, settings.exitKey, wizard]);
  useEffect(() => {
    if (runtimeReady) send("adblock");
  }, [runtimeReady, settings.youtubeAdblock]);
  useEffect(() => {
    if (!config || config.connectionError || connectionExpired || runtimeReady)
      return;
    const ping = () => send("ping", { id: "system" });
    ping();
    const retry = setInterval(ping, 500);
    const timeout = setTimeout(
      () =>
        setRuntimeError(
          "The browsing runtime did not respond. Check that the runtime port serves Atlas browsing runtime, then reconnect.",
        ),
      15000,
    );
    return () => {
      clearInterval(retry);
      clearTimeout(timeout);
    };
  }, [config, runtimeReady, runtimeAttempt, connectionExpired]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const editable = (e.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable],[data-panic-editor],dialog[open]",
      );
      if (
        !wizard &&
        settings.exitKey &&
        matchesShortcut(e, settings.exitKey) &&
        !editable
      ) {
        e.preventDefault();
        location.replace(settings.exitUrl);
        return;
      }
      if (isSearchShortcut(e)) {
        e.preventDefault();
        focusSearch();
      }
      if (e.key === "Escape") {
        setHistoryOpen(false);
        setShortcutForm(false);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settings.exitKey, settings.exitUrl, wizard, page]);
  function activate(tab: Tab) {
    setActive(tab.id);
    setAddress(tab.url);
    setPage(tab.workspace === "ai" ? "ai" : "browse");
    (tab.workspace === "ai" ? lastAiTab : lastBrowserTab).current = tab.id;
    if (!tab.local) {
      if (!live.current.has(tab.id) && runtimeReady) {
        send("navigate", { id: tab.id, url: tab.url, engine: tab.engine });
        live.current.add(tab.id);
      } else send("activate", { id: tab.id });
    }
  }
  function close(id: string) {
    send("close", { id });
    live.current.delete(id);
    setTabs((old) => old.filter((t) => t.id !== id));
    if (active === id) {
      const remaining = tabs.filter((t) => t.id !== id);
      if (remaining.length) activate(remaining[remaining.length - 1]);
      else {
        setActive("");
        setPage("home");
        setAddress("");
      }
    }
  }
  function launchGame(g: Game) {
    if (g.url.startsWith("/games/")) {
      const tab: Tab = {
        id: crypto.randomUUID(),
        url: g.url,
        title: g.name,
        engine: settings.engine,
        status: "ready",
        local: true,
      };
      setTabs((old) => [...old, tab]);
      setActive(tab.id);
      setPage("browse");
      setAddress(g.name);
    } else navigate(g.url, true);
  }
  function switchSection(next: string) {
    setFocusMode(false);
    if (next === "ai") {
      setAiOpened(true);
      setPage("ai");
      return;
    }
    if (next === "home") {
      const pool = tabsRef.current;
      const remembered = lastBrowserTab.current;
      const tab = pool.find((t) => t.id === remembered) || pool.at(-1);
      if (tab) activate(tab);
      else {
        setActive("");
        setPage(next);
        setAddress("");
      }
    } else setPage(next);
  }
  function openAi(url: string) {
    navigate(url, true, settings.engine, "ai");
  }
  function restartRuntime() {
    setRuntimeReady(false);
    setRuntimeError("");
    live.current.clear();
    setRuntimeAttempt((v) => v + 1);
    setTabs((old) =>
      old.map((t) =>
        t.local ? t : { ...t, status: "loading", message: undefined },
      ),
    );
  }
  function clearWeb() {
    pendingClear.current = true;
    setTabs([]);
    setActive("");
    setPage("home");
    live.current.clear();
    send("clear", { id: "system" });
  }
  const style = {
    "--accent": settings.accent,
    "--base": theme.bg,
    "--surface": theme.surface,
    "--dim": settings.dim / 100,
    "--wallpaper": settings.wallpaper ? `url("${settings.wallpaper}")` : "none",
    "--wallpaper-blur": settings.blur + "px",
  } as CSSProperties;
  if (location.pathname.startsWith("/_control/"))
    return (
      <div style={style} className="atlas">
        <Suspense
          fallback={<div className="empty-state">Opening control room…</div>}
        >
          <Admin />
        </Suspense>
      </div>
    );
  const tabList = (
    <>
      <button
        className="new-tab"
        aria-label="New tab"
        title="New tab"
        onClick={() => {
          setActive("");
          setPage(page === "ai" ? "ai" : "home");
          setAddress("");
        }}
      >
        <Plus size={17} />
        <span>{page === "ai" ? "New AI tab" : "New tab"}</span>
      </button>
      {visibleTabs.map((t) => (
        <div
          key={t.id}
          className={"tab " + (active === t.id && showingSite ? "active" : "")}
        >
          <button
            className="tab-main"
            aria-label={t.title}
            title={t.title}
            onClick={() => activate(t)}
          >
            {t.status === "loading" ? (
              <span className="spinner" />
            ) : t.local ? (
              <Gamepad2 size={16} />
            ) : t.favicon ? (
              <img
                className="tab-favicon"
                src={t.favicon}
                alt=""
                aria-hidden="true"
                width={16}
                height={16}
                draggable={false}
                onError={() =>
                  setTabs((old) =>
                    old.map((tab) =>
                      tab.id === t.id ? { ...tab, favicon: undefined } : tab,
                    ),
                  )
                }
              />
            ) : (
              <Globe2 size={16} />
            )}
            <span>{t.title}</span>
          </button>
          <button
            className="icon-button close-tab"
            aria-label={"Close " + t.title}
            onClick={() => close(t.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </>
  );
  return (
    <div
      className={
        "atlas " +
        (settings.compact ? "compact " : "") +
        (!settings.motion ? "no-motion " : "") +
        (settings.tabs === "top" ? "top-tabs " : "") +
        (collapsed ? "sidebar-collapsed " : "") +
        (focusMode && browsingSection ? "focus-mode " : "") +
        (page === "home" ? "home-section " : "") +
        (browsingSection ? "browser-section " : "content-section ")
      }
      style={style}
    >
      <div className={"ambient " + settings.background} aria-hidden="true" />
      <header className="topbar">
        <button className="brand" onClick={() => setPage("home")}>
          <span className="brand-mark">A</span>
          {config?.name || "Atlas"}
          <span className="brand-dot" />
        </button>
        <nav className="main-nav">
          {[
            ["home", "Browser", Globe2],
            ["ai", "AI", Sparkles],
            ["games", "Games", Gamepad2],
            ["apps", "Apps", Grid2X2],
            ["support", "Support", HelpCircle],
            ["settings", "Settings", Settings2],
          ].map(([key, label, Icon]: any) => (
            <button
              key={key}
              aria-label={label}
              className={
                page === key || (key === "home" && page === "browse")
                  ? "selected"
                  : ""
              }
              onClick={() => switchSection(key)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-end">
          <button
            className="icon-button"
            aria-label="Toggle color mode"
            onClick={() =>
              update({ mode: settings.mode === "light" ? "dark" : "light" })
            }
          >
            <Sun size={18} />
          </button>
        </div>
      </header>
      <div className="workspace">
        {browsingSection && settings.tabs === "sidebar" && (
          <aside className="sidebar">
            <div className="sidebar-heading">
              <span className="eyebrow">
                {page === "ai" ? "AI tabs" : "Tabs"}
              </span>
              <button
                className="icon-button"
                aria-label={collapsed ? "Expand tabs" : "Collapse tabs"}
                title={collapsed ? "Expand tabs" : "Collapse tabs"}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? (
                  <PanelLeftOpen size={16} />
                ) : (
                  <PanelLeftClose size={16} />
                )}
              </button>
            </div>
            <div className="tabs-list">{tabList}</div>
            <div className="sidebar-bottom">
              <button
                aria-label="Recently visited"
                title="Recently visited"
                onClick={() => setHistoryOpen(true)}
              >
                <History size={17} />
                <span>Recently visited</span>
              </button>
              <button
                aria-label="Open settings"
                title="Settings"
                onClick={() => setPage("settings")}
              >
                <Settings2 size={17} />
                <span>Settings</span>
              </button>
            </div>
          </aside>
        )}
        <main className="main-panel">
          {browsingSection && settings.tabs === "top" && (
            <div className="horizontal-tabs">{tabList}</div>
          )}
          {page === "browse" && (
            <div className="browser-toolbar">
              <div className="toolbar-actions">
                <button
                  className="icon-button"
                  aria-label="Go back"
                  disabled={!showingSite}
                  onClick={() => send("back")}
                >
                  <ArrowLeft size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Go forward"
                  disabled={!showingSite}
                  onClick={() => send("forward")}
                >
                  <ArrowRight size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Reload page"
                  onClick={() =>
                    current?.local
                      ? document
                          .querySelector<HTMLIFrameElement>(
                            `iframe[data-local="${active}"]`,
                          )
                          ?.contentWindow?.location.reload()
                      : send("reload")
                  }
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <SearchBox
                toolbar
                value={address}
                change={setAddress}
                enabled={settings.autocomplete}
                submit={(value) => navigate(value, false, current?.engine)}
              />
              <BrowsingOptions
                routing={!!config?.nodeRouting}
                node={config?.node}
                problem={connectionExpired || !!config?.connectionError}
                reconnect={requestReconnect}
                directUrl={directTabUrl}
              />
              {directTabUrl ? (
                <a
                  className="icon-button popout-button"
                  href={directTabUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Pop out tab"
                  title="Pop out tab — open directly on this node"
                >
                  <ExternalLink size={16} />
                </a>
              ) : (
                <button
                  className="icon-button popout-button"
                  disabled
                  aria-label="Pop out tab"
                  title="Open a website with an active connection to pop it out"
                >
                  <ExternalLink size={16} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
                title={focusMode ? "Exit focus mode" : "Focus mode"}
                onClick={() => setFocusMode(!focusMode)}
              >
                <Maximize2 size={16} />
              </button>
            </div>
          )}

          <div className="page-scroll" hidden={showingSite}>
            {page === "home" && (
              <div className="home-page">
                <div className="home-browsing-options">
                  <BrowsingOptions
                    routing={!!config?.nodeRouting}
                    node={config?.node}
                    problem={connectionExpired || !!config?.connectionError}
                    reconnect={requestReconnect}
                    directUrl={directTabUrl}
                  />
                </div>
                <section className="home-hero">
                  <NewTabGreeting />
                  <SearchBox
                    value={search}
                    change={setSearch}
                    enabled={settings.autocomplete}
                    submit={(value) => {
                      navigate(value, true);
                      setSearch("");
                    }}
                  />
                  <div className="shortcuts">
                    {shortcuts.map((s: any, i: number) => (
                      <div className="shortcut" key={s.name + i}>
                        <button
                          className="shortcut-target"
                          onClick={() => navigate(s.url, true)}
                        >
                          <span
                            style={
                              { "--shortcut-color": s.color } as CSSProperties
                            }
                          >
                            {s.symbol}
                          </span>
                          <small>{s.name}</small>
                        </button>
                        <button
                          className="shortcut-remove"
                          aria-label={"Remove shortcut " + s.name}
                          onClick={() => {
                            const next = shortcuts.filter(
                              (_: any, n: number) => n !== i,
                            );
                            setShortcuts(next);
                            writeLocal("atlas.shortcuts", next);
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="shortcut add-shortcut"
                      onClick={() => setShortcutForm(true)}
                    >
                      <span>
                        <Plus size={19} />
                      </span>
                      <small>Add shortcut</small>
                    </button>
                  </div>
                </section>
                <div className="newtab-footer">
                  <div className="newtab-credit">
                    <span>
                      Made by <strong>Paxton Warin</strong>
                    </span>
                    <span
                      className="newtab-version"
                      aria-label={`Atlas version ${appVersion}`}
                    >
                      v{appVersion}
                    </span>
                  </div>
                  <button
                    className="newtab-customize"
                    onClick={() => setPage("settings")}
                  >
                    <Settings2 size={15} /> Customize
                  </button>
                </div>
              </div>
            )}
            {aiOpened && (
              <div className="ai-container" hidden={page !== "ai"}>
                <Suspense
                  fallback={<div className="empty-state">Loading AI…</div>}
                >
                  <AiChat />
                </Suspense>
              </div>
            )}

            {page === "settings" && (
              <Settings
                settings={settings}
                update={update}
                toast={toast}
                wizard={() => {
                  setWizard(true);
                }}
                clear={clearWeb}
              />
            )}
            {page === "support" && <Support toast={toast} />}
            {(page === "games" || page === "apps") && (
              <Catalog
                key={page}
                items={games}
                kind={page === "apps" ? "app" : "game"}
                launch={launchGame}
              />
            )}
            {page === "browse" && !current && (
              <div className="empty-state">
                <Globe2 size={32} />
                <h2>New tab</h2>
                <p>Type an address above to start exploring.</p>
              </div>
            )}
          </div>
          <div className="runtime-area" hidden={!showingSite}>
            {config && !config.connectionError && !connectionExpired && (
              <iframe
                title="Atlas isolated browsing runtime"
                ref={runtimeRef}
                src={
                  config.runtimeOrigin +
                  (runtimeAttempt ? "?session=" + runtimeAttempt : "") +
                  (config.ticket
                    ? "#ticket=" + encodeURIComponent(config.ticket)
                    : "")
                }
                onLoad={() => send("ping", { id: "system" })}
                allow="autoplay; encrypted-media; fullscreen; clipboard-write; camera; microphone"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-presentation"
                hidden={!!current?.local}
              />
            )}
            {tabs
              .filter((t) => t.local)
              .map((t) => (
                <iframe
                  title={t.title}
                  data-local={t.id}
                  src={t.url}
                  key={t.id}
                  hidden={active !== t.id}
                  sandbox="allow-scripts allow-same-origin"
                />
              ))}
            {current &&
              !current.local &&
              (connectionExpired ||
                config?.connectionError ||
                runtimeError ||
                current.status === "error" ||
                current.status === "slow") && (
                <div className="runtime-error">
                  <Globe2 size={26} />
                  <h2>
                    {connectionExpired
                      ? "Browsing session expired"
                      : current.status === "slow"
                        ? "Page is taking longer than expected"
                        : "Page could not load"}
                  </h2>
                  <p>
                    {connectionExpired
                      ? "Reconnect to continue browsing."
                      : config?.connectionError ||
                        runtimeError ||
                        current.message}
                  </p>
                  <div className="button-row">
                    <button
                      className="button primary"
                      onClick={() =>
                        connectionExpired || config?.connectionError
                          ? requestReconnect()
                          : runtimeError
                            ? restartRuntime()
                            : navigate(current.url, false, current.engine)
                      }
                    >
                      {connectionExpired || config?.connectionError
                        ? "Reconnect node"
                        : "Try again"}
                    </button>
                    <button
                      className="button"
                      onClick={() => setPage("support")}
                    >
                      Get help
                    </button>
                  </div>
                </div>
              )}
          </div>
        </main>
      </div>
      {notice && !wizard && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button aria-label="Dismiss message" onClick={() => setNotice("")}>
            <X size={13} />
          </button>
        </div>
      )}
      {wizard && (
        <SetupWizard
          notice={notice}
          settings={settings}
          update={update}
          toast={toast}
          clear={clearWeb}
          finish={() => {
            writeLocal("atlas.onboarded", true);
            setWizard(false);
          }}
        />
      )}
      <ReconnectDialog
        reason={reconnectReason}
        busy={reconnecting}
        error={reconnectError}
        cancel={() => setReconnectReason(null)}
        reconnect={reconnectNode}
      />
      {shortcutForm && (
        <div className="modal-backdrop">
          <form
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Add shortcut"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const url = destination(shortcut.url, settings.search);
                const next = [
                  ...shortcuts,
                  {
                    name: shortcut.name.trim(),
                    url,
                    symbol: shortcut.name.charAt(0).toUpperCase(),
                    color: settings.accent,
                  },
                ];
                setShortcuts(next);
                writeLocal("atlas.shortcuts", next);
                setShortcutForm(false);
                setShortcut({ name: "", url: "" });
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >
            <div className="section-title">
              <h2>Add shortcut</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close dialog"
                onClick={() => setShortcutForm(false)}
              >
                <X size={18} />
              </button>
            </div>
            <label className="form-field">
              Name
              <input
                required
                maxLength={24}
                value={shortcut.name}
                onChange={(e) =>
                  setShortcut({ ...shortcut, name: e.target.value })
                }
              />
            </label>
            <label className="form-field">
              Website
              <input
                required
                type="url"
                value={shortcut.url}
                onChange={(e) =>
                  setShortcut({ ...shortcut, url: e.target.value })
                }
                placeholder="https://"
              />
            </label>
            <button className="button primary wide">
              Add shortcut
              <Plus size={17} />
            </button>
          </form>
        </div>
      )}
      {historyOpen && (
        <div className="modal-backdrop">
          <section
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Browsing history"
          >
            <div className="section-title">
              <h2>Recently visited</h2>
              <button
                className="icon-button"
                aria-label="Close history"
                onClick={() => setHistoryOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="history-list">
              {readLocal<any[]>("atlas.history", []).map((h) => (
                <button
                  key={h.url}
                  onClick={() => {
                    navigate(h.url, true);
                    setHistoryOpen(false);
                  }}
                >
                  <Globe2 size={16} />
                  <span>
                    {h.title}
                    <small>{h.url}</small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
              {!readLocal<any[]>("atlas.history", []).length && (
                <p className="muted">No browsing history yet.</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
