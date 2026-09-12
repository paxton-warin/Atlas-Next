import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Globe2, RefreshCw } from "lucide-react";

export default function BrowsingOptions({
  node,
  reconnect,
  routing,
  problem,
}: {
  node?: { name: string; online: boolean };
  reconnect: () => void;
  routing: boolean;
  problem: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div
      ref={root}
      className="browsing-options"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="browsing-options-trigger"
        aria-label="Connection options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Connection status and node"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Globe2 size={14} />
        <span>Connection</span>
        {problem && (
          <i className="connection-dot" aria-label="Reconnect needed" />
        )}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label="Connection options"
          className="browsing-options-menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
            if (e.key === "Tab") {
              close();
              return;
            }
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button[role^="menuitem"]',
              ),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            items[
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                    items.length
            ]?.focus();
          }}
        >
          <div className="menu-node">
            <span className="menu-caption">Status</span>
            <strong>
              {problem
                ? "Reconnect needed"
                : node?.online === false
                  ? "Offline"
                  : !routing
                    ? "Local connection"
                    : node
                      ? "Connected"
                      : "Connecting…"}
            </strong>
          </div>
          {routing && (
            <>
              <div className="menu-node">
                <span className="menu-caption">Node</span>
                <strong>{node?.name || "Not assigned"}</strong>
                <small>
                  {node ? "Session pinned" : "Waiting for assignment"}
                </small>
              </div>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close();
                  reconnect();
                }}
              >
                <RefreshCw size={14} />
                Reconnect node
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ReconnectDialog({
  reason,
  busy,
  error,
  cancel,
  reconnect,
}: {
  reason: "expired" | "manual" | null;
  busy: boolean;
  error: string;
  cancel: () => void;
  reconnect: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    if (!reason) return;
    const prior = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".primary")?.focus();
    return () => {
      dialog.close();
      if (prior?.isConnected) prior.focus();
    };
  }, [reason]);
  if (!reason) return null;
  return (
    <dialog
      ref={ref}
      className="small-modal reconnect-dialog"
      aria-labelledby={id}
      aria-describedby={`${id}-description`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancel();
      }}
    >
      <h2 id={id}>
        {reason === "expired"
          ? "Browsing session expired"
          : "Reconnect browsing?"}
      </h2>
      <p id={`${id}-description`}>
        {reason === "expired"
          ? "Reconnect to continue browsing. Your tabs will stay open."
          : "Atlas will choose an available node and reload your current tab."}{" "}
        Your browsing IP may change.
      </p>
      {error && (
        <p role="alert" className="reconnect-error">
          {error}
        </p>
      )}
      <div className="button-row">
        <button className="button secondary" disabled={busy} onClick={cancel}>
          Not now
        </button>
        <button
          autoFocus
          className="button primary"
          disabled={busy}
          onClick={reconnect}
        >
          <RefreshCw size={15} />
          {busy ? "Reconnecting…" : "Reconnect node"}
        </button>
      </div>
    </dialog>
  );
}
