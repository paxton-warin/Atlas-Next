import { tabPresets, validCustomIcon, type TabPreset } from "./tab-presets";
import { normalizeShortcut } from "../../runtime/panic-shortcut";
export type Engine = "scramjet";
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
  engine: "scramjet",
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
  s.engine = "scramjet"; // Normalize saved preferences and imports.
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
export function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
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
    });
  return data;
}
export type Tab = {
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
