import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Globe2,
  Gamepad2,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Undo2,
  X,
  PanelsTopLeft,
} from "lucide-react";
import type { Tab } from "./model";
import { profileHandoffTabLabel, type ProfileHandoffView } from "./profile-handoff-view";
import "./tabs.css";

type Props = {
  tabs: Tab[];
  handoffs?: Record<string, ProfileHandoffView | null>;
  active: string;
  horizontal?: boolean;
  mobile?: boolean;
  previewEnabled?: boolean;
  closedCount: number;
  onActivate(tab: Tab): void;
  onNew(): void;
  onClose(id: string): void;
  onPin(id: string): void;
  onMove(id: string, before: string, after?: boolean): void;
  onStep(id: string, direction: -1 | 1): void;
  onUndo(): void;
};
function domain(tab: Tab) {
  try {
    return tab.local ? "Atlas game" : new URL(tab.url).hostname;
  } catch {
    return "Website";
  }
}
function readPortalTheme(shell: Element | null): CSSProperties {
  const computed = shell ? getComputedStyle(shell) : null;
  return Object.fromEntries(
    [
      "--accent",
      "--base",
      "--surface",
      "--text",
      "--muted",
      "--line",
      "--input",
      "--canvas",
      "--surface-raised",
      "--surface-overlay",
      "--surface-sunken",
      "--surface-hover",
      "--surface-active",
      "--border",
      "--border-subtle",
      "--border-strong",
      "--text-muted",
      "--text-dim",
      "--accent-wash",
      "--accent-text",
    ].map((key) => [
      key,
      computed?.getPropertyValue(key).trim() ||
        (
          {
            "--accent": "#bce39b",
            "--base": "#111914",
            "--surface": "#1a241e",
            "--text": "#eef0e9",
            "--muted": "#bac5bb",
            "--line": "#344237",
            "--input": "#101813",
          } as Record<string, string>
        )[key],
    ]),
  ) as CSSProperties;
}
/** The expensive theme read belongs to a mounted portal, not every closed tab
 * strip render. Layout effect applies tokens before paint; a coalesced observer
 * keeps an already-open portal current when the application theme changes. */
function ThemedTabPortal({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const shell = document.querySelector(".atlas");
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const next = readPortalTheme(shell);
      setTheme((previous) => Object.keys(next).every((key) =>
        previous[key as keyof CSSProperties] === next[key as keyof CSSProperties],
      ) ? previous : next);
    };
    update();
    const observer = new MutationObserver(() => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    });
    for (const target of new Set([shell, document.body, document.documentElement])) {
      if (target) observer.observe(target, { attributes: true,
        attributeFilter: ["style", "class", "data-mode", "data-v21-mode", "data-v21-theme"],
      });
    }
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  return createPortal(<div data-atlas-tab-portal="" style={{ display: "contents", ...theme }}>{children}</div>, document.body);
}
export default function TabStrip(props: Props) {
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(
    null,
  );
  const [preview, setPreview] = useState<{
    tab: Tab;
    x: number;
    y: number;
  } | null>(null);
  const [search, setSearch] = useState(false),
    [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false),
    [dragging, setDragging] = useState(""),
    [over, setOver] = useState("");
  const [dropAfter, setDropAfter] = useState(false);
  const panel = useRef<HTMLDivElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  const openPanel = (kind: "search" | "drawer") => {
    returnFocus.current = document.activeElement as HTMLElement;
    kind === "search" ? setSearch(true) : setDrawer(true);
  };
  useEffect(() => {
    if (!menu && !search && !drawer) return;
    const restore = () => {
      setMenu(null);
      setSearch(false);
      setDrawer(false);
      returnFocus.current?.focus();
    };
    const timer = setTimeout(
      () => panel.current?.querySelector<HTMLElement>("input,button")?.focus(),
      0,
    );
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        restore();
      }
      if (e.key === "Tab" && panel.current) {
        const items = [
          ...panel.current.querySelectorAll<HTMLElement>(
            "input,button:not(:disabled)",
          ),
        ];
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          items.at(-1)?.focus();
        } else if (!e.shiftKey && i === items.length - 1) {
          e.preventDefault();
          items[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", key);
    };
  }, [menu, search, drawer]);
  const action = (tab: Tab, el: HTMLElement) => {
    returnFocus.current = drawer
      ? document.querySelector<HTMLElement>(".mobile-tabs-toggle") || el
      : el;
    const r = el.getBoundingClientRect();
    // One focus-trapped overlay at a time. A drawer must not cover its menu.
    setDrawer(false);
    setPreview(null);
    setMenu({
      tab,
      x: Math.min(r.right + 6, window.innerWidth - 220),
      y: Math.min(r.top, window.innerHeight - 230),
    });
  };
  const handoffFor = (tab: Tab) => props.handoffs?.[tab.id];
  const activeTab = props.tabs.find((tab) => tab.id === props.active);
  const list = (inDrawer = false) => (
    <>
      <button
        className="new-tab"
        aria-label="New tab"
        title="New tab"
        onClick={() => {
          props.onNew();
          setDrawer(false);
        }}
      >
        <Plus size={17} />
        <span>New tab</span>
      </button>
      <div
        className="tab-items"
        role="tablist"
        aria-label="Open tabs"
        aria-orientation={
          props.horizontal && !inDrawer ? "horizontal" : "vertical"
        }
      >
        {props.tabs.map((t, i) => (
          <div
            key={t.id}
            data-tab-id={t.id}
            className={`tab ${props.active === t.id ? "active" : ""} ${t.pinned ? "pinned" : ""} ${over === t.id ? (dropAfter ? "drop-after" : "drop-before") : ""}`}
            draggable
            onDragStart={(e) => {
              if (
                (e.target as HTMLElement).closest(".tab-actions,.close-tab")
              ) {
                e.preventDefault();
                return;
              }
              setPreview(null);
              setDragging(t.id);
              e.dataTransfer.setData("text/atlas-tab", t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragging) {
                e.preventDefault();
                setOver(t.id);
                const bounds = e.currentTarget.getBoundingClientRect();
                setDropAfter(
                  props.horizontal && !inDrawer
                    ? e.clientX > bounds.left + bounds.width / 2
                    : e.clientY > bounds.top + bounds.height / 2,
                );
                e.currentTarget.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                });
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging) props.onMove(dragging, t.id, dropAfter);
              setOver("");
              setDragging("");
            }}
            onDragEnd={() => {
              setOver("");
              setDragging("");
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              action(
                t,
                e.currentTarget.querySelector<HTMLElement>(".tab-main")!,
              );
            }}
          >
            <button
              className="tab-main"
              role="tab"
              aria-selected={props.active === t.id}
              tabIndex={
                props.active === t.id || (!props.active && i === 0) ? 0 : -1
              }
              aria-label={t.title}
              aria-description={handoffFor(t)?.title ?? (t.status === "error" ? "Page error. Select this tab for details and retry." : undefined)}
              title={`${t.title}\n${domain(t)}`}
              onClick={() => {
                props.onActivate(t);
                setDrawer(false);
              }}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                if (!dragging && !inDrawer && props.previewEnabled !== false)
                  setPreview({
                    tab: t,
                    x: props.horizontal ? r.left : r.right + 10,
                    y: props.horizontal ? r.bottom + 8 : r.top,
                  });
              }}
              onMouseLeave={() => setPreview(null)}
              onFocus={(e) => {
                if (inDrawer || props.previewEnabled === false) return;
                const r = e.currentTarget.getBoundingClientRect();
                setPreview({
                  tab: t,
                  x: props.horizontal ? r.left : r.right + 10,
                  y: props.horizontal ? r.bottom + 8 : r.top,
                });
              }}
              onBlur={() => setPreview(null)}
              onKeyDown={(e) => {
                if (e.key === "F10" && e.shiftKey) {
                  e.preventDefault();
                  action(t, e.currentTarget);
                  return;
                }
                const prev =
                    props.horizontal && !inDrawer ? "ArrowLeft" : "ArrowUp",
                  next =
                    props.horizontal && !inDrawer ? "ArrowRight" : "ArrowDown";
                if (![prev, next, "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const items = [
                  ...e.currentTarget
                    .closest("[role=tablist]")!
                    .querySelectorAll<HTMLButtonElement>("[role=tab]"),
                ];
                const index =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? items.length - 1
                      : (i + (e.key === next ? 1 : -1) + items.length) %
                        items.length;
                items[index]?.focus();
              }}
            >
              {handoffFor(t)?.busy ? (
                <span className="spinner" aria-hidden="true" />
              ) : handoffFor(t) ? (
                <Globe2 size={17} aria-hidden="true" />
              ) : t.status === "loading" ? (
                <span className="spinner" />
              ) : t.status === "error" ? (
                <CircleAlert size={17} aria-hidden="true" />
              ) : t.local ? (
                <Gamepad2 size={17} />
              ) : t.favicon ? (
                <img
                  src={t.favicon}
                  className="tab-favicon"
                  alt=""
                  width={17}
                  height={17}
                  draggable={false}
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                <Globe2 size={17} />
              )}
              <span>{t.title}</span>
              {t.pinned && <Pin className="pin-indicator" size={11} />}{" "}
              {handoffFor(t) ? (
                <span className="tab-page-error tab-handoff-status" role="status">{profileHandoffTabLabel(handoffFor(t)!)}</span>
              ) : t.status === "error" && (
                <span className="tab-page-error" role="status">Page error</span>
              )}
            </button>
            <button
              className="tab-actions icon-button"
              aria-label={`Tab actions for ${t.title}`}
              onClick={(e) => action(t, e.currentTarget)}
            >
              <MoreHorizontal size={15} />
            </button>
            {!t.pinned && (
              <button
                className="icon-button close-tab"
                aria-label={`Close ${t.title}`}
                onClick={() => props.onClose(t.id)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="tab-tools">
        {!inDrawer && activeTab && (
          <button
            className="icon-button rail-tab-actions"
            aria-label="Tab actions"
            title="Tab actions"
            onClick={(e) => action(activeTab, e.currentTarget)}
          >
            <MoreHorizontal size={17} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Search open tabs"
          title="Search open tabs"
          onClick={() => openPanel("search")}
        >
          <Search size={17} />
          <span>Search tabs</span>
        </button>
        <button
          className="icon-button"
          aria-label="Reopen closed tab"
          title="Reopen closed tab"
          disabled={!props.closedCount}
          onClick={props.onUndo}
        >
          <Undo2 size={17} />
          <span>Reopen tab</span>
        </button>
      </div>
    </>
  );
  return (
    <>
      {props.mobile ? (
        <button
          className="mobile-tabs-toggle button"
          onClick={() => openPanel("drawer")}
          aria-label={`Tabs (${props.tabs.length})`}
        >
          <PanelsTopLeft size={17} />
          <span>Tabs {props.tabs.length}</span>
        </button>
      ) : (
        list()
      )}
      {preview && props.previewEnabled !== false &&
        !menu &&
        !search &&
        !drawer &&
        <ThemedTabPortal>
          <div
            className="tab-preview"
            role="tooltip"
            style={{
              left: Math.min(preview.x, window.innerWidth - 270),
              top: Math.max(8, Math.min(preview.y, window.innerHeight - 80)),
            }}
          >
            <strong>{preview.tab.title}</strong>
            <small>{domain(preview.tab)}</small>
            {handoffFor(preview.tab) ? (
              <p className="tab-preview-status">{handoffFor(preview.tab)!.title} {handoffFor(preview.tab)!.message}</p>
            ) : preview.tab.status === "error" && <p className="tab-preview-status">This page could not load. Select the tab for details and retry.</p>}
          </div>
        </ThemedTabPortal>}
      {menu &&
        <ThemedTabPortal>
          <div
            className="tab-menu-dismiss"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setMenu(null);
                returnFocus.current?.focus();
              }
            }}
          >
            <div
              className="tab-context-menu"
              ref={panel}
              role="menu"
              aria-label="Tab actions"
              style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}
            >
              <button
                role="menuitem"
                onClick={() => {
                  props.onPin(menu.tab.id);
                  setMenu(null);
                  returnFocus.current?.focus();
                }}
              >
                <Pin size={16} />
                {menu.tab.pinned ? "Unpin tab" : "Pin tab"}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  props.onStep(menu.tab.id, -1);
                  setMenu(null);
                  returnFocus.current?.focus();
                }}
              >
                <ArrowUp size={16} />
                Move {props.horizontal ? "left" : "up"}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  props.onStep(menu.tab.id, 1);
                  setMenu(null);
                  returnFocus.current?.focus();
                }}
              >
                <ArrowDown size={16} />
                Move {props.horizontal ? "right" : "down"}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  props.onClose(menu.tab.id);
                  setMenu(null);
                }}
              >
                <X size={16} />
                Close tab
              </button>
            </div>
          </div>
        </ThemedTabPortal>}
      {(search || drawer) &&
        <ThemedTabPortal>
          <div
            className="modal-backdrop tabs-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setSearch(false);
                setDrawer(false);
                returnFocus.current?.focus();
              }
            }}
          >
            <div
              className={`small-modal ${drawer ? "tab-drawer" : "tab-search-dialog"}`}
              role="dialog"
              aria-modal="true"
              aria-label={search ? "Search open tabs" : "Open tabs"}
              ref={panel}
            >
              <div className="section-title">
                <h2>
                  {search ? "Search tabs" : `Tabs · ${props.tabs.length}`}
                </h2>
                <button
                  className="icon-button"
                  aria-label="Close tab list"
                  onClick={() => {
                    setSearch(false);
                    setDrawer(false);
                    returnFocus.current?.focus();
                  }}
                >
                  <X size={19} />
                </button>
              </div>
              {search ? (
                <>
                  <button className="button tab-search-undo" disabled={!props.closedCount} onClick={props.onUndo} aria-label="Reopen last closed tab"><Undo2 size={16} />Reopen closed tab</button>
                  <input
                    aria-label="Find an open tab"
                    placeholder="Search titles or websites"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="tab-search-results">
                    {props.tabs
                      .filter((t) =>
                        `${t.title} ${domain(t)}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((t) => (
                        <button
                          key={t.id}
                          onClick={() => {
                            props.onActivate(t);
                            setSearch(false);
                            setDrawer(false);
                          }}
                        >
                          <Globe2 size={17} />
                          <span>
                            {t.title}
                            <small>{domain(t)}</small>
                          </span>
                        </button>
                      ))}
                    {!props.tabs.length && (
                      <p className="muted">
                        No open tabs. Open a website to get started.
                      </p>
                    )}
                    {props.tabs.length > 0 &&
                      !props.tabs.some((t) =>
                        `${t.title} ${domain(t)}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      ) && <p className="muted">No matching tabs.</p>}
                  </div>
                </>
              ) : (
                list(true)
              )}
            </div>
          </div>
        </ThemedTabPortal>}
    </>
  );
}
