import { getActiveProfile, getActiveLocalAuthority } from "../../runtime/profile-context.ts";
import { sameLocalActorAuthority, type LocalActorAuthority } from "../../runtime/local-authority.ts";
import { tabPresets, validCustomIcon, type TabPreset } from "./tab-presets.ts";
import { normalizeShortcut } from "../../runtime/panic-shortcut.ts";
export type Engine = "runtime";
export type Settings = {
  theme: string;
  mode: "dark" | "light" | "system";
  accent: string;
  background: "aurora" | "contour" | "solid" | "wallpaper";
  wallpaper: string;
  dim: number;
  blur: number;
  tabs: "sidebar" | "top";
  compact: boolean;
  motion: boolean;
  search: string;
  engine: Engine;
  restore: boolean;
  history: boolean;
  autocomplete: boolean;
  youtubeAdblock: boolean;
  title: string;
  tabPreset: TabPreset;
  tabIcon: string;
  exitKey: string;
  exitUrl: string;
};
export const defaults: Settings = {
  theme: "forest",
  mode: "dark",
  accent: "#bce39b",
  background: "aurora",
  wallpaper: "",
  dim: 30,
  blur: 0,
  tabs: "sidebar",
  compact: true,
  motion: true,
  search: "https://www.google.com/search?q=%s",
  engine: "runtime",
  restore: true,
  history: true,
  autocomplete: true,
  youtubeAdblock: true,
  title: "",
  tabPreset: "atlas",
  tabIcon: "",
  exitKey: "",
  exitUrl: "https://www.google.com",
};
export const themes = [
  {
    id: "forest",
    name: "Moss",
    accent: "#bce39b",
    bg: "#111914",
    surface: "#1a241e",
  },
  {
    id: "sand",
    name: "Dune",
    accent: "#e0b787",
    bg: "#1e1a17",
    surface: "#2b241e",
  },
  {
    id: "violet",
    name: "Iris",
    accent: "#c8b9ff",
    bg: "#191720",
    surface: "#24212e",
  },
  {
    id: "ocean",
    name: "Tide",
    accent: "#9bd9e3",
    bg: "#111b20",
    surface: "#1a282f",
  },
  {
    id: "rose",
    name: "Rose",
    accent: "#f1b4bf",
    bg: "#211719",
    surface: "#2d2024",
  },
  {
    id: "ink",
    name: "Graphite",
    accent: "#d4d4d4",
    bg: "#171819",
    surface: "#222426",
  },
];
export function sanitizeSettings(value: any): Settings {
  const s = { ...defaults };
  if (!value || typeof value !== "object") return s;
  for (const k of [
    "compact",
    "motion",
    "restore",
    "history",
    "autocomplete",
    "youtubeAdblock",
  ] as const)
    if (typeof value[k] === "boolean") s[k] = value[k];
  if (themes.some((t) => t.id === value.theme)) s.theme = value.theme;
  if (["dark", "light", "system"].includes(value.mode)) s.mode = value.mode;
  if (/^#[0-9a-fA-F]{6}$/.test(value.accent)) s.accent = value.accent;
  if (["aurora", "contour", "solid", "wallpaper"].includes(value.background))
    s.background = value.background;
  if (
    typeof value.wallpaper === "string" &&
    /^data:image\/(png|jpeg|webp);base64,/.test(value.wallpaper) &&
    value.wallpaper.length < 2800000
  )
    s.wallpaper = value.wallpaper;
  for (const k of ["dim", "blur"] as const)
    if (Number.isFinite(value[k]))
      s[k] = Math.max(0, Math.min(k === "blur" ? 30 : 85, value[k]));
  if (["sidebar", "top"].includes(value.tabs)) s.tabs = value.tabs;
  s.engine = "runtime"; // Normalize saved preferences and imports.
  if (
    typeof value.search === "string" &&
    value.search.startsWith("https://") &&
    value.search.includes("%s") &&
    value.search.length < 512
  )
    s.search = value.search;
  if (typeof value.title === "string")
    s.title = value.title.replace(/[\x00-\x1f]/g, "").slice(0, 60);
  if (
    value.tabPreset === "custom" ||
    tabPresets.some((p) => p.id === value.tabPreset)
  )
    s.tabPreset = value.tabPreset;
  else if (value.tabPreset === undefined && s.title) s.tabPreset = "custom";
  if (validCustomIcon(value.tabIcon)) s.tabIcon = value.tabIcon;
  s.exitKey = normalizeShortcut(value.exitKey);
  if (typeof value.exitUrl === "string" && /^https:\/\//.test(value.exitUrl))
    s.exitUrl = value.exitUrl.slice(0, 2048);
  return s;
}
export function destination(value: string, search: string) {
  const input = value.trim();
  if (!input) throw Error("Enter a URL or search.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:/i.test(input))
    throw Error("Use an HTTP or HTTPS address.");
  let url: URL;
  if (/^https?:\/\//i.test(input)) url = new URL(input);
  else if (
    !/\s/.test(input) &&
    /^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(input)
  )
    url = new URL("https://" + input);
  else url = new URL(search.replace("%s", encodeURIComponent(input)));
  if (url.username || url.password)
    throw Error("Remove credentials from the address.");
  return url.href;
}
export const portableAtlasKey = (key: string) =>
  [
    "atlas.settings",
    "atlas.shortcuts",
    "atlas.history",
    "atlas.chats",
    "atlas.onboarded",
    "atlas.sidebarCollapsed",
    "atlas.ai.geminiConsent",
    "atlas.tabs",
  ].includes(key) || /^atlas\.windows\.v1\.[a-f0-9-]{36}$/.test(key);
export function profileLocalKey(key: string) {
  const id = getActiveProfile();
  const local = getActiveLocalAuthority?.();
  return id && portableAtlasKey(key)
    ? "atlas.profile.user:" + id + ":" + (local ? 'replica:' + local.replicaId + ':' : '') + key
    : key;
}
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const encoded = localStorage.getItem(profileLocalKey(key));
    // Native-only replicas never import account-level legacy preferences or
    // replay old pending markers. Only this incarnation or completed v2 restore
    // supplies its application state.
    return JSON.parse(encoded || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
/** Reconcile existing shell preferences after local readiness on each start. Ordinary
 * reads are pure: this explicit, cancellable scan is not a storage prerequisite.
 * Each value is read immediately before visiting, so intervening writes win. */
export function seedPortableAtlasPreferences(
  authority: LocalActorAuthority,
  visit: (key: string, value: string) => void,
  options: {
    current?: () => boolean;
    complete?: () => void;
    storage?: Pick<Storage, "length" | "key" | "getItem">;
    schedule?: (work: () => void) => () => void;
    now?: () => number;
  } = {},
) {
  const storage = options.storage ?? localStorage,
    schedule = options.schedule ?? ((work: () => void) => {
      const timer = setTimeout(work, 16);
      return () => clearTimeout(timer);
    }),
    now = options.now ?? (() => performance.now()),
    prefix = `atlas.profile.user:${authority.profileId}:replica:${authority.replicaId}:`,
    seen = new Set<string>();
  let stopped = false, index = 0, length = storage.length, cancel: (() => void) | undefined;
  const current = () => !stopped &&
    sameLocalActorAuthority(authority, getActiveLocalAuthority()) &&
    getActiveProfile() === authority.profileId && (options.current?.() ?? true);
  function step() {
    cancel = undefined;
    if (!current()) return;
    const start = now();
    let keys = 0, bytes = 0;
    try {
      // Enumeration can shift when another window adds/removes a key. Restart
      // the bounded metadata walk; previously visited values need not repeat.
      if (storage.length !== length) { length = storage.length; index = 0; }
      while (index < length && keys < 16 && bytes < 64 * 1024 && now() - start < 4) {
        const physical = storage.key(index++);
        keys++;
        if (!physical?.startsWith(prefix) || seen.has(physical)) continue;
        const key = physical.slice(prefix.length);
        if (!portableAtlasKey(key)) continue;
        const value = storage.getItem(physical);
        if (!current()) return;
        seen.add(physical);
        if (value !== null) {
          bytes += 2 * (key.length + value.length);
          visit(key, value);
        }
      }
      if (!current()) return;
      if (index >= length) { seen.clear(); options.complete?.(); }
      else cancel = schedule(step);
    } catch {
      // Unavailable browser storage leaves seeding incomplete. A subsequent
      // startup may retry; neither a read nor website readiness is failed.
    }
  }
  cancel = schedule(step);
  return () => { stopped = true; cancel?.(); seen.clear(); };
}
export function writeLocal(key: string, value: unknown) {
  try {
    const physical = profileLocalKey(key),
      encoded = JSON.stringify(value);
    if (localStorage.getItem(physical) === encoded) return true;
    const portable = !!getActiveProfile() && portableAtlasKey(key), local = getActiveLocalAuthority?.();
    localStorage.setItem(physical, encoded);
    if (portable)
      window.dispatchEvent(new CustomEvent("atlas:profile-user-change", {detail:{profileId:getActiveProfile(),
        ...(local ? {replicaId:local.replicaId} : {}),key,value:encoded}}));
    return true;
  } catch {
    return false;
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(Error(data.error || "Request failed."), {
      status: response.status,
      code: typeof data.code === "string" ? data.code : undefined,
      retryable:
        typeof data.retryable === "boolean" ? data.retryable : undefined,
      retryAfter: (() => {
        const value = response.headers.get("Retry-After");
        if (!value) return undefined;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return seconds;
        const date = Date.parse(value);
        return Number.isFinite(date)
          ? Math.max(0, (date - Date.now()) / 1000)
          : undefined;
      })(),
    });
  return data;
}
export type Tab = {
  pinned?: boolean;
  favicon?: string;
  workspace?: "browser" | "ai";
  id: string;
  url: string;
  title: string;
  engine: Engine;
  status: "loading" | "ready" | "error" | "slow";
  message?: string;
  local?: boolean;
};
/** Runtime status events are often repeated. Preserve the array and unrelated
 * tab identities unless one actual field changes. */
export function patchTab(
  tabs: Tab[], id: string, change: Partial<Tab> | ((tab: Tab) => Partial<Tab>),
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return tabs;
  const previous = tabs[index], patch = typeof change === "function" ? change(previous) : change;
  if (Object.keys(patch).every((key) => previous[key as keyof Tab] === patch[key as keyof Tab])) return tabs;
  const next = tabs.slice(); next[index] = { ...previous, ...patch }; return next;
}
export type Game = {
  kind?: "game" | "app";
  thumbnail?: string;
  id: string;
  name: string;
  description: string;
  url: string;
  artwork: string;
  category: string;
  enabled?: number;
};
