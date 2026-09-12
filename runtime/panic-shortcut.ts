// Shared by settings capture, the Atlas shell and both browsing engines.
export const modifiers = ["Meta", "Ctrl", "Alt", "Shift"] as const;
const modifierAliases: Record<string, string> = {
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  "⌘": "Meta",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
export const mainKeys = [
  "Escape",
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Insert",
  "CapsLock",
  "Pause",
  "PrintScreen",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  "Plus",
  "-",
  "=",
  "[",
  "]",
  ";",
  "'",
  ",",
  ".",
  "/",
  "\\",
  "`",
];
function keyName(value: string) {
  if (value === " ") return "Space";
  if (value === "+") return "Plus";
  const key = value.trim().toLowerCase();
  const alias: Record<string, string> = {
    esc: "Escape",
    return: "Enter",
    spacebar: "Space",
    del: "Delete",
  };
  return alias[key] || mainKeys.find((k) => k.toLowerCase() === key) || "";
}
export function normalizeShortcut(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) return "";
  if (value === "+" || value === " ") return keyName(value);
  const parts = value.split("+").map((v) => v.trim());
  const key = keyName(parts.pop() || "");
  const mods = parts.map((p) => modifierAliases[p.toLowerCase()]);
  if (!key || mods.some((m) => !m) || new Set(mods).size !== mods.length)
    return "";
  return [...modifiers.filter((m) => mods.includes(m)), key].join("+");
}
type KeyEvent = {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  getModifierState?: (key: string) => boolean;
};
export function captureShortcut(e: KeyEvent): string {
  if (
    e.repeat ||
    e.isComposing ||
    e.getModifierState?.("AltGraph") ||
    ["Dead", "Process", "Unidentified"].includes(e.key) ||
    modifierAliases[e.key.toLowerCase()]
  )
    return "";
  // Option on macOS can produce a symbol instead of the underlying letter.
  const key =
    e.altKey && /^Key[A-Z]$/.test(e.code || "")
      ? e.code!.slice(3).toLowerCase()
      : keyName(e.key);
  if (!key) return "";
  return [
    e.metaKey && "Meta",
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
export function matchesShortcut(e: KeyEvent, shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut);
  return !!normalized && captureShortcut(e) === normalized;
}
export function formatShortcut(value: string): string {
  return normalizeShortcut(value)
    .split("+")
    .map((k) =>
      k === "Meta"
        ? "Cmd"
        : k === "Escape"
          ? "Esc"
          : k.length === 1
            ? k.toUpperCase()
            : k,
    )
    .join(" + ");
}
// Actions checked against Google Chrome Help 157179 and Apple Support 102650.
export function shortcutWarnings(value: string): string[] {
  const shortcut = normalizeShortcut(value);
  if (!shortcut) return [];
  const parts = shortcut.split("+"),
    key = parts.pop()!;
  const reasons: string[] = [];
  if (
    !parts.some((p) => ["Meta", "Ctrl", "Alt"].includes(p)) &&
    !/^F\d+$/.test(key)
  )
    reasons.push(
      `${formatShortcut(shortcut)} is easy to press accidentally while using page controls or playing games. It could leave Atlas unexpectedly. Add Cmd, Ctrl, or Alt to reduce accidental activation.`,
    );
  const actions: Record<string, string> = {
    t: "open a new browser tab",
    f: "open Find on page",
    w: "close the browser tab",
    n: "open a new browser window",
    r: "reload the page",
    l: "focus the address bar",
    p: "open Print",
    s: "save the page",
    d: "bookmark the page",
    o: "open a file",
    g: "find the next match",
    a: "select all",
    c: "copy",
    v: "paste",
    x: "cut",
    z: "undo",
  };
  const exact: Record<string, string> = {
    "Meta+Alt+Escape": "open Force Quit on macOS",
    "Meta+Space": "open Spotlight on macOS",
    "Meta+Tab": "switch apps on macOS",
    "Meta+Shift+Tab": "switch apps on macOS",
    "Meta+Ctrl+f": "toggle full screen on macOS",
    "Meta+q": "quit the app on macOS",
    "Meta+h": "hide the app on macOS",
    "Meta+m": "minimize the window on macOS",
    "Meta+y": "open browser history on macOS",
    "Meta+Alt+i": "open Developer Tools on macOS",
    "Meta+Alt+j": "open the JavaScript Console on macOS",
    "Ctrl+h": "open browser history",
    "Ctrl+j": "open Downloads",
    "Ctrl+u": "view page source",
    "Ctrl+Tab": "switch browser tabs",
    "Ctrl+Shift+Tab": "switch browser tabs",
    "Alt+Tab": "switch apps",
    "Alt+F4": "close the window",
    "Ctrl+Shift+i": "open Developer Tools",
    "Ctrl+Shift+j": "open Developer Tools",
    "Shift+Escape": "open Chrome Task Manager",
    F1: "open browser help",
    F3: "open Find on page",
    F5: "reload the page",
    F6: "move browser focus",
    F7: "toggle caret browsing",
    F11: "toggle full screen",
    F12: "open Developer Tools",
  };
  let action = exact[shortcut];
  if (!action && parts.length === 1 && ["Meta", "Ctrl"].includes(parts[0])) {
    action =
      actions[key] ||
      (/^[1-9]$/.test(key)
        ? "switch browser tabs"
        : ["Plus", "-", "=", "0"].includes(key)
          ? "change browser zoom"
          : "");
    if (action)
      action +=
        parts[0] === "Meta"
          ? " on macOS"
          : " in Chrome on Windows, Linux, or ChromeOS";
  }
  if (!action && /^(Meta|Ctrl)\+Shift\+[tnwr]$/.test(shortcut))
    action = (
      {
        t: "reopen a closed tab",
        n: "open an incognito window",
        w: "close the window",
        r: "reload without the cache",
      } as Record<string, string>
    )[key];
  if (action)
    reasons.push(
      `${formatShortcut(shortcut)} is commonly used to ${action}. The browser or operating system may handle it before Atlas receives the keys, so the panic action may not run.`,
    );
  if (/^(Meta|Ctrl)\+k$/.test(shortcut))
    reasons.push(
      `${formatShortcut(shortcut)} overlaps Atlas's search shortcut and may also focus the browser address bar. The browser may take priority over the panic action.`,
    );
  return reasons;
}
