import type { Tab } from "./model";

export type WindowTabs = {
  version: 1;
  tabs: Tab[];
  order: string[];
  active: string;
  updatedAt?: number;
};
export function windowTabsKey(win: Window = window): string {
  // window.name is not cloned with sessionStorage when another window opens.
  // It contains no account information or credential and survives same-origin reloads.
  if (!/^atlas-window:[a-f0-9-]{36}$/.test(win.name))
    win.name = `atlas-window:${crypto.randomUUID()}`;
  return `atlas.windows.v1.${win.name.slice(13)}`;
}
export function restoreWindowTabs(raw: unknown): WindowTabs {
  const value: Partial<WindowTabs> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<WindowTabs>)
      : { tabs: Array.isArray(raw) ? raw : [] };
  const seen = new Set<string>();
  const tabs = (Array.isArray(value.tabs) ? value.tabs : [])
    .filter((t): t is Tab => {
      if (
        !t ||
        typeof t.id !== "string" ||
        t.id.length > 100 ||
        seen.has(t.id) ||
        typeof t.url !== "string"
      )
        return false;
      try {
        const url = new URL(t.url, "https://atlas.invalid");
        if (
          t.local
            ? !t.url.startsWith("/games/") ||
              url.origin !== "https://atlas.invalid" ||
              !url.pathname.startsWith("/games/")
            : !/^https?:\/\//.test(t.url) ||
              !["http:", "https:"].includes(url.protocol) ||
              !!url.username ||
              !!url.password
        )
          return false;
      } catch {
        return false;
      }
      seen.add(t.id);
      return true;
    })
    .slice(0, 100)
    .map((t) => ({
      id: t.id,
      url: t.url,
      title: typeof t.title === "string" ? t.title.slice(0, 500) : t.url,
      engine: "runtime" as const,
      status: "ready" as const,
      local: t.local === true,
      workspace: t.workspace === "ai" ? ("ai" as const) : ("browser" as const),
      pinned: t.pinned === true,
    }));
  const ids = new Set(tabs.map((t) => t.id));
  const order = [
    ...new Set(
      Array.isArray(value.order)
        ? value.order.filter((id) => typeof id === "string" && ids.has(id))
        : [],
    ),
  ];
  for (const tab of tabs) if (!order.includes(tab.id)) order.push(tab.id);
  return {
    version: 1,
    tabs,
    order,
    active:
      typeof value.active === "string" && ids.has(value.active)
        ? value.active
        : "",
    ...(Number.isSafeInteger(value.updatedAt) && value.updatedAt! >= 0
      ? { updatedAt: value.updatedAt }
      : {}),
  };
}
const savedWindowKey = /^atlas\.windows\.v1\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function savedWindowSnapshot(value: unknown): WindowTabs | null {
  const raw = value as Partial<WindowTabs> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      raw.version !== 1 || !Array.isArray(raw.tabs) ||
      (raw.order !== undefined && (!Array.isArray(raw.order) || raw.order.some(id => typeof id !== "string"))) ||
      (raw.active !== undefined && typeof raw.active !== "string") ||
      (raw.updatedAt !== undefined && (!Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0))) return null;
  const normalized = restoreWindowTabs(raw);
  // Unknown/invalid tab records are not an intentional close-all.
  return raw.tabs.length === 0 || normalized.tabs.length > 0 ? normalized : null;
}
/** Restore presentation state without merging live windows or selecting an
 * account. The caller supplies already-account-scoped logical readers. An own
 * empty window and a newest close-all snapshot are both intentional states. */
export function restoreLatestWindowTabs(
  currentKey: string,
  read: (key: string) => unknown,
  list: () => Iterable<string>,
  restore = true,
): WindowTabs {
  if (!restore) return restoreWindowTabs([]);
  const cache = new Map<string, WindowTabs | null>();
  function saved(key: string): WindowTabs | null {
    if (cache.has(key)) return cache.get(key)!;
    let result: WindowTabs | null = null;
    try {
      result = savedWindowSnapshot(read(key));
    } catch { /* A malformed/unavailable record cannot break first render. */ }
    cache.set(key, result);
    return result;
  }
  if (savedWindowKey.test(currentKey)) {
    const own = saved(currentKey);
    if (own) return own;
  }
  let keys: string[] = [];
  try { keys = [...new Set([...list()].filter(key => typeof key === "string" && savedWindowKey.test(key)))].sort(); }
  catch { /* Legacy fallback still works when enumeration is unavailable. */ }
  let latest: WindowTabs | null = null;
  for (const key of keys) {
    const candidate = saved(key);
    if (candidate && (!latest || (candidate.updatedAt ?? 0) > (latest.updatedAt ?? 0)))
      latest = candidate;
  }
  if (latest) return latest;
  try { return restoreWindowTabs(read("atlas.tabs")); }
  catch { return restoreWindowTabs([]); }
}
type LayoutTab = Pick<Tab, "id" | "url"> & Partial<Pick<Tab, "pinned" | "workspace" | "local">>;
/** Recency belongs to deliberate window layout changes, not background page
 * titles/loading events. Never copy another window's timestamp into a new key. */
export function timestampWindowTabs<T extends { tabs: LayoutTab[]; order: string[]; active: string }>(
  snapshot: T,
  previous: unknown,
  now: number,
): T & { updatedAt: number } {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid window snapshot time");
  const current = savedWindowSnapshot({ ...snapshot, version: 1, updatedAt: undefined });
  if (!current) throw new TypeError("Invalid window layout snapshot");
  let prior: WindowTabs | null = null;
  try { prior = savedWindowSnapshot(previous); } catch { /* Ignore malformed prior data. */ }
  const layout = (value: WindowTabs) => JSON.stringify([
    value.tabs.map(tab => [tab.id, tab.url, tab.pinned, tab.workspace, tab.local]),
    value.order,
    value.active,
  ]);
  const same = prior && layout(prior) === layout(current);
  let updatedAt = now;
  if (prior?.updatedAt !== undefined)
    updatedAt = same ? prior.updatedAt : Math.max(now, prior.updatedAt + 1);
  if (!Number.isSafeInteger(updatedAt)) throw new RangeError("Window snapshot time is exhausted");
  return { ...snapshot, updatedAt };
}
export function orderTabs(tabs: Tab[], order: string[]): Tab[] {
  const index = new Map(order.map((id, i) => [id, i]));
  const original = new Map(tabs.map((tab, i) => [tab.id, i]));
  return [...tabs].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (index.get(a.id) ?? original.get(a.id)! + order.length) -
        (index.get(b.id) ?? original.get(b.id)! + order.length),
  );
}
type PersistedTab = Pick<Tab, "id" | "url" | "title" | "engine" | "local" | "workspace" | "pinned">;
export type WindowTabsSnapshot = {
  version: 1; tabs: PersistedTab[]; order: string[]; active: string; updatedAt: number;
};
type PresentationInput = { tabs: Tab[]; order: string[]; active: string; restore: boolean };
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
function samePresentation(a: Pick<WindowTabsSnapshot, "tabs" | "order" | "active">,
  tabs: PersistedTab[], order: string[], active: string, titles = true) {
  return a.active === active && sameOrder(a.order, order) && a.tabs.length === tabs.length && a.tabs.every((t, i) => {
    const next = tabs[i];
    return t.id === next.id && t.url === next.url && !!t.local === !!next.local &&
      !!t.pinned === !!next.pinned && (t.workspace ?? "browser") === (next.workspace ?? "browser") &&
      (!titles || (t.title === next.title && t.engine === next.engine));
  });
}
/** Presentation-only persistence. Ephemeral events perform no serialization or
 * storage reads. Pending writes remain scoped to the captured window/account. */
export function createWindowTabsPersistence(options: {
  previous: unknown;
  write(snapshot: WindowTabsSnapshot): boolean;
  current(): boolean;
  failed?(): void;
  clock?: { now(): number; wallNow(): number; schedule(work: () => void, delay: number): unknown; cancel(id: unknown): void };
}) {
  const clock = options.clock ?? { now: () => performance.now(), wallNow: () => Date.now(),
    schedule: (work: () => void, delay: number) => setTimeout(work, delay), cancel: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  const previous = savedWindowSnapshot(options.previous);
  let desired: WindowTabsSnapshot | null = previous ? { ...previous, updatedAt: previous.updatedAt ?? 0 } : null;
  let pending = false, timer: unknown, firstPendingAt: number | undefined;
  const cancelTimer = () => { if (timer !== undefined) clock.cancel(timer); timer = undefined; };
  function flush() {
    cancelTimer();
    if (!pending || !desired) return true;
    if (!options.current()) { pending = false; firstPendingAt = undefined; return false; }
    let saved = false;
    try { saved = options.write(desired); } catch {}
    if (saved) { pending = false; firstPendingAt = undefined; }
    else { firstPendingAt = undefined; options.failed?.(); }
    return saved;
  }
  function arm() {
    cancelTimer();
    firstPendingAt ??= clock.now();
    timer = clock.schedule(flush, Math.max(0, Math.min(250, firstPendingAt + 1000 - clock.now())));
  }
  return {
    update(input: PresentationInput) {
      if (!options.current()) return false;
      const tabs = input.restore ? input.tabs : [], order = input.restore ? input.order : [], active = input.restore ? input.active : "";
      if (desired && samePresentation(desired, tabs, order, active)) return false;
      const now = clock.wallNow();
      if (!Number.isSafeInteger(now) || now < 0) throw RangeError("Invalid window snapshot time");
      const layoutChanged = !desired || !samePresentation(desired, tabs, order, active, false);
      const updatedAt = layoutChanged ? Math.max(now, (desired?.updatedAt ?? -1) + 1) : desired!.updatedAt;
      if (!Number.isSafeInteger(updatedAt)) throw RangeError("Window snapshot time is exhausted");
      desired = { version: 1, tabs: tabs.map(({ id, url, title, engine, local, workspace, pinned }) =>
        ({ id, url, title, engine, local, workspace, pinned })), order: [...order], active, updatedAt };
      pending = true; arm(); return true;
    },
    flush,
    cancel() { cancelTimer(); pending = false; firstPendingAt = undefined; },
  };
}
export function moveTab(
  tabs: Tab[],
  order: string[],
  id: string,
  before: string,
  after = false,
): string[] {
  const source = tabs.find((t) => t.id === id),
    target = tabs.find((t) => t.id === before);
  if (
    !source ||
    !target ||
    id === before ||
    !!source.pinned !== !!target.pinned ||
    source.workspace !== target.workspace
  )
    return order;
  const next = orderTabs(tabs, order)
    .map((t) => t.id)
    .filter((key) => key !== id);
  next.splice(next.indexOf(before) + (after ? 1 : 0), 0, id);
  return next;
}
export function adjacentTab(
  tabs: Tab[],
  order: string[],
  id: string,
  direction: -1 | 1,
): string | undefined {
  const tab = tabs.find((t) => t.id === id);
  const group = orderTabs(tabs, order).filter(
    (t) => t.workspace === tab?.workspace && !!t.pinned === !!tab?.pinned,
  );
  return group[group.findIndex((t) => t.id === id) + direction]?.id;
}
