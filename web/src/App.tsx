import ProfileStatus from "./ProfileStatus";
import { getProfileStatus, type ProfileStatus as ProfileState } from "./profile-client";
import { profileHandoffForWebsite, sameShellHandoff } from "./profile-handoff-view";
import ProfileBackupChoice from "./ProfileBackupChoice";
import { useV21Theme } from "./v21-theme";
import { useV21ModalFocus } from "./v21-modal-focus";
import { getHubSession } from "./hub-client-state";
import { HubSupportPanel } from "./HubSupportPanel";
import Catalog from "./Catalog";
import TabStrip from "./TabStrip";
import { useSidebarPeek } from "./use-sidebar-peek";
import {
  windowTabsKey,
  restoreLatestWindowTabs,
  createWindowTabsPersistence,
  orderTabs,
  moveTab,
  adjacentTab,
} from "./tab-state";
import { version as packageVersion } from "../../package.json";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
import { matchesShortcut } from "../../runtime/panic-shortcut";
import { getActiveLocalAuthority } from "../../runtime/profile-context";
import { isSearchShortcut } from "../../runtime/browser-shortcuts";
import {
  createDirectTabUrl,
  createRuntimeFrameUrl,
  runtimeFrameSandbox,
} from "../../runtime/direct-tab";
import { createPopoutUrl } from "./popout-link";
import {
  frontendRuntimeEnabled,
  createFrontendWorkspace,
  clearFrontendWebsiteData,
} from "./frontend-runtime";
import {
  restoreBrowsingLeaseOnStartup,
  clearStaleRelayCredentials,
  browsingSessionToRelease,
  selectBrowsingLeaseForOwner,
  createBrowsingLeaseLifecycle,
  normalizeBrowsingLease,
  browsingLeaseStorageKeys,
  TERMINAL_LEASE_CODES,
  retryBrowsingLeaseOperation,
} from "./browsing-session";
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
  Menu,
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
  profileLocalKey,
  sanitizeSettings,
  themes,
  writeLocal,
  patchTab,
  type Settings as Preferences,
  type Tab,
  type Game,
  type Engine,
} from "./model";
import SearchBox from "./SearchBox";
import { shortcutInitials, shortcutURL } from "./shortcuts";
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
];
function NewTabGreeting() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      setNow(new Date());
      timer = setTimeout(update, 60_000 - (Date.now() % 60_000));
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
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
          })}
        </time>
      </div>
      <h1>
        Good <em>{period}.</em>
      </h1>
    </>
  );
}
const appVersion = packageVersion.replace(/\.0$/, "");

export default function App() {
  const [settings, setSettings] = useState<Preferences>(() =>
    sanitizeSettings(readLocal("atlas.settings", defaults)),
  );
  const [page, setPage] = useState(
    location.pathname === "/support" ? "support" : "home",
  );
  const [supportPageTarget, setSupportPageTarget] = useState<HTMLDivElement | null>(null);
  const [wizard, setWizard] = useState(
    () => !readLocal("atlas.onboarded", false),
  );
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState<any>(null);
  const configRef = useRef<any>(null);
  const opaqueMode = frontendRuntimeEnabled(config);
  const adminRoute = location.pathname.startsWith("/_control/");
  const frontendArea = useRef<HTMLDivElement>(null);
  const frontendWorkspace = useRef<ReturnType<
    typeof createFrontendWorkspace
  > | null>(null);
  configRef.current = config;
  const renewLease = useRef<() => void>(() => {});
  const runtimeBootFailed = useRef(false);
  const leaseEpoch = useRef(0);
  const startup = useRef<{
    config: Promise<any>;
    catalog: Promise<Game[]>;
  } | null>(null);
  const [connectionExpired, setConnectionExpired] = useState(false);
  const [reconnectReason, setReconnectReason] = useState<
    "expired" | "manual" | null
  >(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState("");
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [windowKey] = useState(() => windowTabsKey());
  const [initialWindow] = useState(() => restoreLatestWindowTabs(
    windowKey,
    (key) => readLocal(key, null),
    () => {
      // Derive the exact active-profile prefix from a complete portable key.
      // A different account's or an unclaimed legacy window is never listed.
      const physical = profileLocalKey(windowKey);
      const prefix = physical.slice(0, physical.length - windowKey.length);
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; ++i) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
      return keys;
    },
    settings.restore,
  ));
  const [tabs, setTabs] = useState<Tab[]>(initialWindow.tabs);
  const [tabPersistence] = useState(() => {
    const physical = profileLocalKey(windowKey), generation = getActiveLocalAuthority()?.localAuthGeneration;
    return createWindowTabsPersistence({ previous: readLocal(windowKey, null),
      current: () => profileLocalKey(windowKey) === physical && getActiveLocalAuthority()?.localAuthGeneration === generation,
      write: (snapshot) => writeLocal(windowKey, snapshot),
      failed: () => setNotice("Device storage is full. Recent tab changes have not been saved."),
    });
  });
  const [tabOrder, setTabOrder] = useState<string[]>(initialWindow.order);
  const [closedTabs, setClosedTabs] = useState<Tab[]>([]);
  const tabActivity = useRef<string[]>(
    initialWindow.active ? [initialWindow.active] : [],
  );
  const [active, setActive] = useState(initialWindow.active),
    [address, setAddress] = useState(
      initialWindow.tabs.find((t) => t.id === initialWindow.active)?.url || "",
    ),
    [search, setSearch] = useState(""),
    [collapsed, setCollapsed] = useState(
      () => readLocal<boolean>("atlas.sidebarCollapsed", true) !== false,
    ),
    [shortcutForm, setShortcutForm] = useState(false),
    [shortcut, setShortcut] = useState({ name: "", url: "" }),
    [shortcutError, setShortcutError] = useState("");
  useEffect(() => {
    if (initialWindow.active && location.pathname !== "/support") {
      const tab = initialWindow.tabs.find((t) => t.id === initialWindow.active);
      setPage(tab?.workspace === "ai" ? "ai" : "browse");
    }
  }, [initialWindow]);
  const [shortcuts, setShortcuts] = useState(() => {
      const saved = readLocal("atlas.shortcuts", seedShortcuts);
      // Retire only the former built-in shortcut. Keep custom names, URLs,
      // symbols and colors, including user-created community shortcuts.
      return (Array.isArray(saved) ? saved : seedShortcuts).filter(
        (shortcut) =>
          shortcut &&
          !(
            shortcut.name === "Discord" &&
            shortcut.url === "https://discord.com/app" &&
            shortcut.symbol === "◕" &&
            shortcut.color === "#c2b9f5"
          ),
      );
    }),
    [games, setGames] = useState<Game[]>([]);
  const [aiOpened, setAiOpened] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [profileStatus, setProfileStatus] = useState<ProfileState>(getProfileStatus);
  useEffect(() => {
    const updateProfileStatus = (event: Event) => {
      const next = (event as CustomEvent<ProfileState>).detail;
      setProfileStatus((previous) => sameShellHandoff(previous, next) ? previous : next);
    };
    window.addEventListener("atlas:profile-status", updateProfileStatus);
    setProfileStatus(getProfileStatus());
    return () => window.removeEventListener("atlas:profile-status", updateProfileStatus);
  }, []);
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [searchFocusRequest, requestSearchFocus] = useState(0);
  function focusSearch() {
    if (wizard) return;
    setFocusMode(false);
    if (page !== "browse" && page !== "home") setPage("home");
    requestSearchFocus((n) => n + 1);
  }
  const focusSearchRef = useRef(focusSearch);
  focusSearchRef.current = focusSearch;
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
  const shortcutDialog = useRef<HTMLFormElement>(null);
  const historyDialog = useRef<HTMLElement>(null);
  useV21ModalFocus(shortcutForm, shortcutDialog, () => setShortcutForm(false), "input");
  useV21ModalFocus(historyOpen, historyDialog, () => setHistoryOpen(false));
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const utilitiesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!utilitiesOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!utilitiesRef.current?.contains(target) && !target.closest(".profile-menu,.hub-activity-panel")) setUtilitiesOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [utilitiesOpen]);
  useEffect(() => setUtilitiesOpen(false), [page]);
  useEffect(() => {
    if (!navigationOpen) return;
    const dismiss = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !(event.target as Element)?.closest(".main-nav,.mobile-nav-toggle")
      )
        setNavigationOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [navigationOpen]);
  const runtimeRef = useRef<HTMLIFrameElement>(null),
    pendingClear = useRef(false),
    live = useRef(new Set<string>()),
    tabsRef = useRef(tabs),
    activeRef = useRef(active);
  const runtimePreferences = useRef({ settings, wizard });
  runtimePreferences.current = { settings, wizard };
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
      () =>
        document.fullscreenElement ===
        (frontendWorkspace.current?.frame ?? runtimeRef.current),
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
  const profileHandoff = showingSite && !current?.local &&
    !connectionExpired && !config?.connectionError && !runtimeError
      ? profileHandoffForWebsite(profileStatus, current?.url)
      : null;
  const handoffPanel = useRef<HTMLElement>(null);
  const handoffActionFocused = useRef(false);
  useEffect(() => {
    if (handoffActionFocused.current && profileHandoff?.busy) {
      handoffPanel.current?.focus({ preventScroll: true });
      handoffActionFocused.current = false;
    }
  }, [profileHandoff?.busy, profileHandoff?.backupPending]);
  const browsingSection = ["home", "browse"].includes(page);
  const railPeek = useSidebarPeek(collapsed && browsingSection && settings.tabs === "sidebar" && !focusMode && !utilitiesOpen);
  const compactChrome = settings.compact || railPeek.compactViewport;
  let directTabUrl: string | undefined;
  let popoutUrl: string | undefined;
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
      if (new URL(current.url).origin !== location.origin) {
        directTabUrl = createDirectTabUrl(
          config.runtimeOrigin,
          current.url,
          config.ticket || undefined,
          settings.youtubeAdblock,
          config.runtimePath,
        );
        if (!config.nodeRouting || config.session)
          popoutUrl = createPopoutUrl(
            location.origin,
            current.url,
            config.nodeRouting ? config.session : undefined,
            settings.youtubeAdblock,
          );
      }
    } catch {
      // Internal pages, invalid URLs and unavailable leases have no live link.
    }
  }

  if (opaqueMode) {
    directTabUrl = undefined;
    popoutUrl =
      showingSite &&
      current &&
      !current.local &&
      /^https?:\/\//i.test(current.url) &&
      config?.session &&
      !connectionExpired
        ? createPopoutUrl(
            location.origin,
            current.url,
            config.session,
            settings.youtubeAdblock,
          )
        : undefined;
  }

  const aiTabList = page === "ai";
  const visibleTabs = useMemo(() => orderTabs(
    tabs.filter((t) =>
      aiTabList ? t.workspace === "ai" : t.workspace !== "ai",
    ),
    tabOrder,
  ), [tabs, aiTabList, tabOrder]);
  const theme = themes.find((t) => t.id === settings.theme)!;
  const visualMode = useV21Theme(settings.theme, settings.mode, settings.accent);
  const toast = (text: string) => setNotice(text);
  function update(patch: Partial<Preferences>) {
    setSettings((old) => sanitizeSettings({ ...old, ...patch }));
  }
  useEffect(() => {
    let mounted = true;
    // StrictMode replays effects in development. Share the network work and
    // ignore callbacks from the cleaned-up effect, rather than allocating twice.
    startup.current ||= {
      config: retryBrowsingLeaseOperation(() =>
        api("/config", { signal: AbortSignal.timeout(12000) }),
      ).then(async (config) => {
        if (frontendRuntimeEnabled(config) || !config.nodeRouting)
          return config;
        const savedKeys = browsingLeaseStorageKeys(config);
        try {
          const lease = await restoreBrowsingLeaseOnStartup(
            () => readLocal(savedKeys.session, ""),
            (session, intent) =>
              retryBrowsingLeaseOperation(
                () =>
                  api("/browse/session", {
                    method: "POST",
                    body: JSON.stringify({ session, intent }),
                    signal: AbortSignal.timeout(12000),
                  }),
                {
                  retrying: () =>
                    setNotice("Reconnecting to the current browsing node…"),
                },
              ),
            (session) => {
              writeLocal(savedKeys.session, session);
            },
            navigator.locks,
            () => clearStaleRelayCredentials(localStorage),
          );
          const normalized = normalizeBrowsingLease(lease);
          writeLocal(savedKeys.lease, normalized);
          return { ...config, ...normalized };
        } catch (error) {
          return {
            ...config,
            connectionError: (error as Error).message,
            connectionErrorStatus: (error as { status?: number }).status,
            connectionErrorCode: (error as { code?: string }).code,
            session: readLocal(savedKeys.session, ""),
          };
        }
      }),
      catalog: api<Game[]>("/catalog"),
    };
    startup.current.config
      .then((config) => {
        if (!mounted) return;
        setConfig(config);
        if (TERMINAL_LEASE_CODES.has(config.connectionErrorCode))
          expireConnection();
      })
      .catch((e) => {
        if (mounted) toast(e.message);
      });
    startup.current.catalog
      .then((games) => {
        if (mounted) setGames(games);
      })
      .catch((e) => {
        if (mounted) toast(e.message);
      });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!opaqueMode || !frontendArea.current) return;
    let mounted = true;
    const workspace = createFrontendWorkspace({
      container: frontendArea.current,
      onAssignment(assignment) {
        if (!mounted) return;
        configRef.current = {
          ...configRef.current,
          ...assignment,
          runtimeOrigin: location.origin,
          node: { ...assignment.node, online: true },
          nodeRouting: true,
          connectionError: "",
        };
        setConfig(configRef.current);
        setConnectionExpired(false);
      },
      onConnection(state) {
        if (!mounted) return;
        if (state.status === "revoked" || state.status === "invalid")
          expireConnection();
        else if (state.status === "retrying")
          setNotice(
            "Retrying the pinned browsing node; your page remains open…",
          );
        else if (state.status === "error")
          setRuntimeError(
            state.code || "The browsing connection did not start.",
          );
        else if (state.status === "ready") setRuntimeError("");
      },
      onEvent(event) {
        if (!mounted) return;
        if (event.type === "focus-search") { focusSearchRef.current(); return; }
        if (event.type === "panic") {
          const current = runtimePreferences.current;
          if (!current.wizard && current.settings.exitKey && event.key === current.settings.exitKey) location.replace(current.settings.exitUrl);
          return;
        }
        if (event.type === "popup-created" && event.url) {
          live.current.add(event.id);
          setTabs(old => old.some(tab => tab.id === event.id) ? old : [...old, {
            id: event.id, url: event.url!, title: event.url === "about:blank" ? "New tab" : new URL(event.url!).hostname,
            engine: "runtime", status: "loading", workspace: "browser",
          }]);
          tabActivity.current = [event.id, ...tabActivity.current.filter(key => key !== event.id)];
          setActive(event.id); setAddress(event.url === "about:blank" ? "" : event.url);
          lastBrowserTab.current = event.id; setPage("browse"); return;
        }
        if (event.type === "popup-focus") {
          const tab = tabsRef.current.find(tab => tab.id === event.id);
          if (tab) activate(tab);
          return;
        }
        if (event.type === "popup-closed") {
          live.current.delete(event.id);
          setTabs(old => old.some(tab => tab.id === event.id) ? old.filter(tab => tab.id !== event.id) : old);
          setTabOrder(old => old.includes(event.id) ? old.filter(key => key !== event.id) : old);
          if (activeRef.current === event.id) {
            const tab = tabsRef.current.find(tab => tab.id === event.openerId) || tabsRef.current.find(tab => tab.id !== event.id);
            if (tab) activate(tab);
            else { setActive(""); setPage("home"); setAddress(""); }
          }
          return;
        }
        if (event.type === "favicon") {
          const favicon = event.favicon;
          setTabs(old => patchTab(old, event.id, {
            favicon: typeof favicon === "string" && favicon.length <= 16384 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(favicon) ? favicon : undefined }));
          return;
        }
        if (event.type === "title") {
          setTabs((old) =>
            patchTab(old, event.id, (tab) => ({ title: event.title || new URL(tab.url).hostname })),
          );
          return;
        }
        if (event.type === "navigation" && event.url) {
          if (activeRef.current === event.id) setAddress(event.url);
          setTabs((old) =>
            patchTab(old, event.id, (tab) => tab.url === event.url ? {} : {
                    url: event.url!,
                    title: new URL(event.url!).hostname,
                  }),
          );
        } else if (["loading", "loaded", "error", "slow"].includes(event.type))
          setTabs((old) =>
            patchTab(old, event.id, {
                    status:
                      event.type === "loaded"
                        ? "ready"
                        : event.type === "error" || event.type === "slow"
                          ? event.type
                          : "loading",
                    message: event.type === "error" || event.type === "slow" ? event.message : undefined,
                  }),
          );
      },
    });
    frontendWorkspace.current = workspace;
    // This is trusted controller readiness, not website-content readiness.
    setRuntimeReady(true);
    void workspace.connect().catch((error) => {
      if (mounted)
        setRuntimeError(
          error.message || "The browsing connection did not start.",
        );
    });
    return () => {
      mounted = false;
      workspace.dispose();
      if (frontendWorkspace.current === workspace)
        frontendWorkspace.current = null;
      live.current.clear();
    };
  }, [opaqueMode, runtimeAttempt, adminRoute]);
  useEffect(() => {
    writeLocal("atlas.sidebarCollapsed", collapsed);
  }, [collapsed]);
  useEffect(() => {
    writeLocal("atlas.shortcuts", shortcuts);
  }, [shortcuts]);
  useEffect(() => {
    if (!writeLocal("atlas.settings", settings))
      setNotice("Device storage is full. Try a smaller background.");
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
  useLayoutEffect(() => {
    tabPersistence.update({ tabs, order: tabOrder, active, restore: settings.restore });
  }, [tabs, tabOrder, active, settings.restore, tabPersistence]);
  useEffect(() => {
    const flush = () => { tabPersistence.flush(); };
    const beforeRevoke = (event: Event) => {
      if ((event as CustomEvent).detail?.generation === getActiveLocalAuthority()?.localAuthGeneration) flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("atlas:profile-local-before-revoke", beforeRevoke);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("atlas:profile-local-before-revoke", beforeRevoke);
      tabPersistence.flush(); tabPersistence.cancel();
    };
  }, [tabPersistence]);
  const runtimeLoaded = useRef(false);
  useEffect(() => {
    runtimeLoaded.current = false;
  }, [
    config?.runtimeOrigin,
    config?.runtimePath,
    config?.session,
    config?.generation,
    runtimeAttempt,
    connectionExpired,
  ]);
  function send(type: string, extra: Record<string, unknown> = {}) {
    if (frontendRuntimeEnabled(configRef.current)) {
      if (
        ["navigate", "activate", "close", "reload", "back", "forward", "panic-key"].includes(
          type,
        )
      )
        void frontendWorkspace.current
          ?.command(type, { id: activeRef.current, ...extra })
          .catch(() => {});
      return;
    }
    if (config && runtimeLoaded.current)
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
    leaseEpoch.current++;
    setReconnectError("");
    try {
      if (opaqueMode) {
        await frontendWorkspace.current!.reconnect();
        setConnectionExpired(false);
        setReconnectReason(null);
        setRuntimeError("");
        return;
      }
      const savedKeys = browsingLeaseStorageKeys(config);
      const old = browsingSessionToRelease(
        config?.session,
        readLocal(savedKeys.session, ""),
      );
      // Reserve the replacement before releasing the old pin. An outage must
      // leave the currently usable connection and its browser data intact.
      const lease = await selectBrowsingLeaseForOwner(
        old,
        () => readLocal(savedKeys.session, ""),
        (session) =>
          api("/browse/session", {
            method: "POST",
            body: JSON.stringify({
              intent: "new",
              session,
              generation: config?.generation,
            }),
            signal: AbortSignal.timeout(12000),
          }),
        (session) => {
          writeLocal(savedKeys.session, session);
        },
        navigator.locks,
      );
      const normalized = normalizeBrowsingLease(lease);
      writeLocal(savedKeys.session, normalized.session);
      writeLocal(savedKeys.lease, normalized);
      configRef.current = { ...config, ...normalized, connectionError: "" };
      setConfig(configRef.current);
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
    if (
      opaqueMode ||
      !config?.nodeRouting ||
      !config.session ||
      connectionExpired
    )
      return;
    const savedKeys = browsingLeaseStorageKeys(config);
    const lifecycle = createBrowsingLeaseLifecycle<any>({
      current: () => configRef.current,
      epoch: () => leaseEpoch.current,
      visible: () => !document.hidden,
      request: (lease, intent) =>
        api("/browse/session", {
          method: "POST",
          body: JSON.stringify({
            intent: lease.connectionError ? "restore" : intent,
            session: lease.session,
            generation: lease.generation,
          }),
          signal: AbortSignal.timeout(12000),
        }),
      locks: navigator.locks,
      readRemembered: () => readLocal(savedKeys.lease, null),
      remember: (lease) => {
        writeLocal(savedKeys.lease, lease);
        if (readLocal(savedKeys.session, "") === configRef.current?.session)
          writeLocal(savedKeys.session, lease.session);
      },
      apply: (lease, previous) => {
        const bootFailed = runtimeBootFailed.current;
        if (bootFailed) lease = { ...lease, bootTicket: lease.ticket };
        configRef.current = {
          ...configRef.current,
          ...lease,
          connectionError: "",
          connectionErrorCode: undefined,
        };
        setConfig(configRef.current);
        if (
          lease.session !== previous.session ||
          lease.generation !== previous.generation ||
          bootFailed
        ) {
          runtimeBootFailed.current = false;
          restartRuntime();
        } else {
          send("session-update", {
            sessionHash: lease.sessionHash,
            generation: lease.generation,
            ticket: lease.ticket,
            relayTicket: lease.relayTicket,
            relayOrigin: lease.relayOrigin,
            ticketExpiresAt: lease.ticketExpiresAt,
          });
        }
      },
      terminal: () => expireConnection(),
      retrying: () => {
        // Keep the mounted website alive while the same pinned lease retries.
        if (configRef.current?.connectionError)
          setNotice("Reconnecting to the current browsing node…");
      },
    });
    renewLease.current = () => {
      void lifecycle.check(true);
    };
    const check = () => {
      if (!document.hidden) void lifecycle.check();
    };
    lifecycle.start();
    // Failed cold starts have not mounted a runtime yet; validate immediately.
    if (config.connectionError) void lifecycle.check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("online", check);
    return () => {
      lifecycle.stop();
      renewLease.current = () => {};
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("online", check);
    };
  }, [
    config?.session,
    config?.generation,
    config?.nodeRouting,
    connectionExpired,
  ]);
  function navigate(
    value: string,
    newTab = false,
    engine?: Engine,
    workspace: "browser" | "ai" = "browser",
  ) {
    try {
      const url = destination(value, settings.search),
        chosen: Engine = "runtime";
      let id = activeRef.current;
      if (newTab || !id || !tabsRef.current.some((t) => t.id === id))
        id = crypto.randomUUID();
      const tab: Tab = {
        pinned: tabsRef.current.find((t) => t.id === id)?.pinned,
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
      tabActivity.current = [
        id,
        ...tabActivity.current.filter((key) => key !== id),
      ];
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
          engine: "runtime",
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
        setTabs((old) => old.some(t => t.id === d.id) ? old.filter((t) => t.id !== d.id) : old);
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
      if (d.type === "session-expired" || d.type === "session-refresh-needed") {
        if (d.boot === true) runtimeBootFailed.current = true;
        renewLease.current();
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
        runtimeBootFailed.current = false;
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
          runtimeRef.current.src = createRuntimeFrameUrl(
            config.runtimeOrigin,
            config.ticket,
            config.runtimePath,
          );
        setRuntimeReady(false);
        live.current.clear();
        return;
      }
      setTabs((old) =>
        patchTab(old, d.id, (t) => {
          if (
            d.type === "navigation" &&
            typeof d.url === "string" &&
            /^https?:\/\//.test(d.url)
          ) {
            if (t.id === activeRef.current) setAddress(d.url);
            return { url: d.url };
          }
          if (d.type === "title" && d.title)
            return { title: String(d.title).slice(0, 100) };
          if (d.type === "favicon" && typeof d.favicon === "string")
            return {
              favicon:
                d.favicon.length <= 16384 &&
                /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(d.favicon)
                  ? d.favicon
                  : undefined,
            };
          if (d.type === "error" || d.type === "slow")
            return { status: d.type, message: d.message };
          if (d.type === "loaded")
            return { status: "ready", message: undefined };
          if (d.type === "loading") return { status: "loading" };
          return {};
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
    if (
      opaqueMode ||
      !config ||
      config.connectionError ||
      connectionExpired ||
      runtimeReady
    )
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
    tabActivity.current = [
      tab.id,
      ...tabActivity.current.filter((id) => id !== tab.id),
    ];
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
    const closed = tabsRef.current.find((t) => t.id === id);
    if (!closed) return;
    setClosedTabs((old) => [closed, ...old].slice(0, 20));
    send("close", { id });
    live.current.delete(id);
    setTabs((old) => old.filter((t) => t.id !== id));
    setTabOrder((old) => old.filter((key) => key !== id));
    if (activeRef.current === id) {
      const remaining = orderTabs(
        tabsRef.current.filter(
          (t) => t.id !== id && t.workspace === closed.workspace,
        ),
        tabOrder,
      );
      const next =
        tabActivity.current
          .map((key) => remaining.find((t) => t.id === key))
          .find(Boolean) || remaining[0];
      if (next) activate(next);
      else {
        setActive("");
        setPage(closed.workspace === "ai" ? "ai" : "home");
        setAddress("");
      }
    }
  }
  function undoClose() {
    const closed = closedTabs[0];
    if (!closed) return;
    const tab = {
      ...closed,
      id: crypto.randomUUID(),
      status: "ready" as const,
      favicon: undefined,
    };
    setClosedTabs((old) => old.slice(1));
    setTabs((old) => [...old, tab]);
    activate(tab);
  }
  function stepTab(id: string, direction: -1 | 1) {
    const adjacent = adjacentTab(tabsRef.current, tabOrder, id, direction);
    if (!adjacent) return;
    setTabOrder((old) => {
      const next = orderTabs(tabsRef.current, old).map((t) => t.id);
      const a = next.indexOf(id),
        b = next.indexOf(adjacent);
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
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
    if (opaqueMode) {
      frontendWorkspace.current?.dispose();
      frontendWorkspace.current = null;
      setTabs([]);
      setActive("");
      setPage("home");
      live.current.clear();
      void clearFrontendWebsiteData(window)
        .then(
          () => toast("Website data cleared."),
          (error) => toast(error.message),
        )
        .finally(() => setRuntimeAttempt((value) => value + 1));
      return;
    }
    pendingClear.current = true;
    setTabs([]);
    setActive("");
    setPage("home");
    live.current.clear();
    send("clear", { id: "system" });
  }
  const style = useMemo(() => ({
    "--accent": settings.accent,
    "--base": theme.bg,
    "--surface": theme.surface,
    "--dim": settings.dim / 100,
    "--wallpaper": settings.wallpaper ? `url("${settings.wallpaper}")` : "none",
    "--wallpaper-blur": settings.blur + "px",
  }) as CSSProperties, [settings.accent, theme.bg, theme.surface, settings.dim, settings.wallpaper, settings.blur]);
  if (adminRoute)
    return (
      <div style={style} className="atlas" data-v21-theme={settings.theme} data-mode={visualMode}>
        {opaqueMode && (
          <div ref={frontendArea} data-frontend-runtime="2" hidden />
        )}
        <Suspense
          fallback={<div className="empty-state">Opening control room…</div>}
        >
          <Admin
            browsingSession={config?.session}
            browsingNode={config?.node}
            browsingSessionStorageKey={browsingLeaseStorageKeys(config).session}
            frontendStorage={
              config?.runtimeProtocols?.sameOrigin?.activated === true
            }
            selectBrowsingNode={
              opaqueMode
                ? (node, csrf) =>
                    frontendWorkspace.current!.selectNode(node, csrf)
                : undefined
            }
            onLeaseSelected={(lease, persisted) => {
              if (opaqueMode) {
                window.history.replaceState(null, "", "/");
                setReconnectReason(null);
                setReconnectError("");
                setPage(tabs.length ? "browse" : "home");
                toast(
                  "This browser's connection changed to " +
                    lease.node.name +
                    ".",
                );
                return;
              }
              leaseEpoch.current++;
              configRef.current = {
                ...configRef.current,
                ...normalizeBrowsingLease(lease),
                nodeRouting: true,
                connectionError: "",
              };
              window.history.replaceState(null, "", "/");
              setConfig((current: any) => ({
                ...current,
                ...normalizeBrowsingLease(lease),
                nodeRouting: true,
                connectionError: "",
                expiresLocally: lease.expiresAt
                  ? Date.now() + lease.expiresAt - lease.serverTime
                  : undefined,
              }));
              setConnectionExpired(false);
              setReconnectReason(null);
              setReconnectError("");
              setPage(tabs.length ? "browse" : "home");
              restartRuntime();
              toast(
                persisted
                  ? "This browser's connection changed to " +
                      lease.node.name +
                      "."
                  : "Connection changed for this window. Device storage is unavailable; reload may select another connection.",
              );
            }}
          />
        </Suspense>
      </div>
    );
  const tabStripProps = {
    previewEnabled: !railPeek.open,
    tabs: visibleTabs,
    handoffs: !connectionExpired && !config?.connectionError && !runtimeError
      ? Object.fromEntries(visibleTabs.map(tab => [
          tab.id,
          tab.local ? null : profileHandoffForWebsite(profileStatus, tab.url),
        ]))
      : {},
    active: showingSite ? active : "",
    horizontal: settings.tabs === "top",
    closedCount: closedTabs.length,
    onActivate: activate,
    onClose: close,
    onUndo: undoClose,
    onStep: stepTab,
    onPin: (id: string) =>
      setTabs((old) =>
        old.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
      ),
    onMove: (id: string, before: string, after = false) =>
      setTabOrder((old) => moveTab(tabsRef.current, old, id, before, after)),
    onNew: () => {
      setActive("");
      setPage(page === "ai" ? "ai" : "home");
      setAddress("");
    },
  };
  const tabList = <TabStrip {...tabStripProps} />;
  return (
    <div
      className={
        "atlas sidebar-adaptive " +
        (compactChrome ? "chrome-compact " : "") +
        (railPeek.open ? "sidebar-peeking " : "") +
        (settings.compact ? "compact " : "") +
        (!settings.motion ? "no-motion " : "") +
        (settings.tabs === "top" ? "top-tabs " : "") +
        (collapsed && !railPeek.open ? "sidebar-collapsed " : "") +
        (focusMode && browsingSection ? "focus-mode " : "") +
        (page === "home" ? "home-section " : "") +
        (browsingSection ? "browser-section " : "content-section ")
      }
      style={style}
      data-v21-theme={settings.theme}
      data-mode={visualMode}
      data-rail-collapsed={collapsed && browsingSection && settings.tabs === "sidebar"}
    >
      <header className="topbar" ref={railPeek.header} {...railPeek.events}>
        <button className="brand" onClick={() => setPage("home")}>
          <span className="brand-mark">A</span>
          {config?.name || "Atlas"}
          <span className="brand-dot" />
        </button>
        <nav
          id="atlas-main-navigation"
          className={"main-nav" + (navigationOpen ? " mobile-open" : "")}
          aria-label="Atlas pages"
        >
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
              aria-current={page === key || (key === "home" && page === "browse") ? "page" : undefined}
              className={
                page === key || (key === "home" && page === "browse")
                  ? "selected"
                  : ""
              }
              onClick={() => {
                switchSection(key);
                setNavigationOpen(false);
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {browsingSection && settings.tabs === "sidebar" && (
          <aside className="sidebar">
            <div className="sidebar-heading">
              <span className="eyebrow" data-count={visibleTabs.length} aria-label={`${visibleTabs.length} open tabs`} title={`${visibleTabs.length} open tabs`}>
                {collapsed && !railPeek.open
                  ? visibleTabs.length
                  : `${page === "ai" ? "AI tabs" : "Tabs"} · ${visibleTabs.length}`}
              </span>
              <button
                className="icon-button sidebar-toggle"
                aria-label={railPeek.open ? "Keep sidebar open" : collapsed ? "Expand tabs" : "Collapse tabs"}
                title={railPeek.open ? "Keep sidebar open" : collapsed ? "Expand tabs" : "Collapse tabs"}
                aria-description={`${visibleTabs.length} open tabs. Hover for one second to preview without resizing the website.`}
                aria-expanded={!collapsed || railPeek.open}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? (
                  <PanelLeftOpen size={16} />
                ) : (
                  <PanelLeftClose size={16} />
                )}
                <span className="sidebar-toggle-label">{railPeek.open ? "Keep open" : collapsed ? "Expand" : "Collapse"}</span>
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
            </div>
          </aside>
        )}
        <div className="topbar-end rail-utilities" ref={utilitiesRef} data-open={utilitiesOpen} onKeyDown={(event) => {
          if (event.key === "Escape" && utilitiesOpen && utilitiesRef.current?.contains(event.target as Node)) {
            event.preventDefault(); event.stopPropagation(); setUtilitiesOpen(false);
            utilitiesRef.current.querySelector<HTMLButtonElement>(".rail-utilities-toggle")?.focus();
          }
        }}>
          <button className="icon-button rail-utilities-toggle" aria-label="More Atlas tools" aria-expanded={utilitiesOpen} aria-controls="atlas-rail-tools" onClick={() => setUtilitiesOpen(!utilitiesOpen)} title="Saves, notifications, history and appearance"><MoreHorizontal size={19} /></button>
          <div id="atlas-rail-tools" className="rail-utilities-content" role="group" aria-label="Atlas tools">
          <button className="icon-button compact-history" aria-label="Recently visited" title="Recently visited" onClick={() => setHistoryOpen(true)}><History size={17} /><span>History</span></button>
          <ProfileStatus website={showingSite && !current?.local ? current?.url : undefined} />
          <HubSupportPanel
            active={page === "support"}
            pageTarget={supportPageTarget}
            onOpen={() => {
              setFocusMode(false);
              setPage("support");
              setNavigationOpen(false);
            }}
            legacySupport={<Support toast={toast} />}
          />
          <button
            className="mobile-nav-toggle button"
            aria-label="Menu"
            aria-controls="atlas-main-navigation"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen((value) => !value)}
          >
            <Menu size={17} />
            <span>Menu</span>
          </button>
          <button
            className="icon-button"
            aria-label="Toggle color mode"
            onClick={() =>
              update({ mode: settings.mode === "light" ? "dark" : "light" })
            }
          >
            <Sun size={18} />
            <span className="rail-tool-label">Appearance</span>
          </button>
          </div>
        </div>
      </header>
      <div className="workspace">
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
              {popoutUrl ? (
                <a
                  className="icon-button toolbar-view-button popout-button"
                  href={popoutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Pop out tab"
                  title="Pop out tab — keep this Atlas connection and website storage"
                >
                  <ExternalLink size={16} />
                </a>
              ) : (
                <button
                  className="icon-button toolbar-view-button popout-button"
                  disabled
                  aria-label="Pop out tab"
                  title="Open a website with an active connection to pop it out"
                >
                  <ExternalLink size={16} />
                </button>
              )}
              <button
                className="icon-button toolbar-view-button"
                aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
                aria-pressed={focusMode}
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
                <div className={"ambient " + settings.background} aria-hidden="true" />
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
                          aria-label={s.name}
                          onClick={() => navigate(s.url, true)}
                        >
                          <span
                            aria-hidden="true"
                            style={
                              { "--shortcut-color": s.color } as CSSProperties
                            }
                          >
                            {shortcutInitials(s.name)}
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
                      aria-label="Add shortcut"
                      onClick={() => { setShortcutError(""); setShortcutForm(true); }}
                    >
                      <span>
                        <Plus size={19} />
                      </span>
                      <small>Add</small>
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
                  <AiChat key={profileLocalKey("atlas.chats") + ":" + (getActiveLocalAuthority()?.localAuthGeneration ?? "browser")} />
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
            <div className="support-page-outlet" ref={setSupportPageTarget} hidden={page !== "support"} />
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
            {opaqueMode && (
              <div
                ref={frontendArea}
                data-frontend-runtime="2"
                hidden={!!current?.local}
                style={{ position: "absolute", inset: 0 }}
              />
            )}
            {!opaqueMode &&
              config &&
              !config.connectionError &&
              !connectionExpired && (
                <iframe
                  title="Atlas isolated browsing runtime"
                  ref={runtimeRef}
                  src={createRuntimeFrameUrl(
                    config.runtimeOrigin,
                    config.bootTicket ?? config.ticket,
                    config.runtimePath,
                    runtimeAttempt,
                  )}
                  onLoad={() => {
                    runtimeLoaded.current = true;
                    send("ping", { id: "system" });
                  }}
                  allow="autoplay; encrypted-media; fullscreen; clipboard-write; camera; microphone"
                  sandbox={runtimeFrameSandbox(config)}
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
            {profileHandoff && (
              <section
                className="runtime-error profile-handoff"
                ref={handoffPanel}
                tabIndex={-1}
                role="status"
                aria-live="polite"
                aria-busy={profileHandoff.busy}
                aria-labelledby="profile-handoff-heading"
              >
                <Globe2 size={28} aria-hidden="true" />
                <h2 id="profile-handoff-heading">{profileHandoff.title}</h2>
                <p>{profileHandoff.message}</p>
                {profileHandoff.canContinue && (
                  <button
                    className="button primary"
                    onClick={() => {
                      handoffActionFocused.current = true;
                      window.dispatchEvent(new CustomEvent("atlas:profile-continue", {
                        detail: { origin: new URL(current!.url).origin },
                      }));
                    }}
                  >
                    Continue here
                  </button>
                )}
                {profileHandoff.canRetry && (
                  <button
                    className="button primary"
                    onClick={() => window.dispatchEvent(new CustomEvent("atlas:profile-retry"))}
                  >
                    Retry sync
                  </button>
                )}
                {profileHandoff.busy && <span className="spinner" aria-hidden="true" />}
                {profileHandoff.kind === "waiting" && (
                  <ProfileBackupChoice
                    key={new URL(current!.url).origin}
                    view={profileHandoff}
                    origin={new URL(current!.url).origin}
                    confirm={(origin) => {
                      handoffActionFocused.current = true;
                      window.dispatchEvent(new CustomEvent("atlas:profile-use-backup", {
                        detail: { origin },
                      }));
                    }}
                  />
                )}
              </section>
            )}
            {current &&
              !current.local &&
              !profileHandoff &&
              current.status === "slow" &&
              !connectionExpired && !config?.connectionError && !runtimeError && (
                <div className="runtime-slow" role="status">
                  <span>Still loading. You can keep using this page.</span>
                  <button type="button" aria-label="Dismiss loading notice" onClick={() =>
                    setTabs((old) => patchTab(old, current.id, (tab) => tab.status === "slow" ? { status: "loading", message: undefined } : {}))
                  }>Dismiss</button>
                </div>
              )}
            {current &&
              !current.local &&
              !profileHandoff &&
              (connectionExpired ||
                config?.connectionError ||
                runtimeError ||
                current.status === "error") && (
                <div className="runtime-error">
                  <Globe2 size={26} />
                  <h2>
                    {connectionExpired
                      ? "Browsing session expired"
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
      <nav className="mobile-bottom-nav" aria-label="Mobile workspace">
        {[
          ["home", "Browser", Globe2],
          ["ai", "AI", Sparkles],
          ["games", "Games", Gamepad2],
          ["apps", "Apps", Grid2X2],
        ].map(([key, label, Icon]: any) => (
          <button
            key={key}
            aria-label={`Open ${label === "Browser" ? "browser" : label}`}
            aria-current={page === key || (key === "home" && page === "browse") ? "page" : undefined}
            onClick={() => {
              switchSection(key);
              setNavigationOpen(false);
            }}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
        <TabStrip {...tabStripProps} mobile />
      </nav>
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
            ref={shortcutDialog}
            tabIndex={-1}
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Add shortcut"
            onSubmit={(e) => {
              e.preventDefault();
              setShortcutError("");
              try {
                const url = shortcutURL(shortcut.url);
                const name = shortcut.name.trim();
                if (!name) throw Error("Enter a shortcut name.");
                const next = [
                  ...shortcuts,
                  {
                    name,
                    url,
                    symbol: shortcutInitials(name),
                    color: settings.accent,
                  },
                ];
                setShortcuts(next);
                writeLocal("atlas.shortcuts", next);
                setShortcutForm(false);
                setShortcut({ name: "", url: "" });
              } catch (e) {
                setShortcutError((e as Error).message);
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
                onChange={(e) => { setShortcutError(""); setShortcut({ ...shortcut, name: e.target.value }); }}
              />
            </label>
            <div className="form-field">
              <label htmlFor="shortcut-website">Website</label>
              <input
                id="shortcut-website"
                required
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="shortcut-website-hint"
                value={shortcut.url}
                onChange={(e) => { setShortcutError(""); setShortcut({ ...shortcut, url: e.target.value }); }}
                placeholder="example.com"
              />
              <small id="shortcut-website-hint">Enter a domain or full URL. We’ll add https:// if needed.</small>
            </div>
            {shortcutError && <p className="error" role="alert">{shortcutError}</p>}
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
            ref={historyDialog}
            tabIndex={-1}
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
