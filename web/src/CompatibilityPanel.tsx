import { useEffect, useRef, useState } from "react";
import type { FrontendPageControls } from "./frontend-runtime.ts";
import {
  SITE_PREFERENCE_KEY,
  sanitizeSiteModes,
  ruleFor,
  validStatus,
  validRuntimeStatus,
  type CompatibilityStatus,
  type SiteModes,
} from "../../runtime/compatibility-policy";
function load(): SiteModes {
  try {
    return sanitizeSiteModes(
      JSON.parse(localStorage.getItem(SITE_PREFERENCE_KEY) || "{}"),
    );
  } catch {
    return {};
  }
}
export function cleanDiagnosticReport(value: any) {
  if (
    value?.version !== 1 ||
    typeof value.active !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > 128
  )
    return;
  const events = new Set([
    "request",
    "response",
    "navigation",
    "document",
    "worker",
    "media",
    "error",
  ]);
  const entries = [];
  for (const raw of value.entries) {
    if (
      !raw ||
      !events.has(raw.event) ||
      !Number.isFinite(raw.at) ||
      raw.at < 0 ||
      raw.at > 300000
    )
      return;
    const entry: Record<string, unknown> = { event: raw.event, at: raw.at };
    if (["embedded", "top-level"].includes(raw.context))
      entry.context = raw.context;
    if (
      typeof raw.revision === "string" &&
      /^[a-f0-9]{7,40}$/.test(raw.revision)
    )
      entry.revision = raw.revision;
    if (
      [
        "installing",
        "installed",
        "activating",
        "activated",
        "redundant",
        "missing",
      ].includes(raw.state)
    )
      entry.state = raw.state;
    if (raw.origin !== undefined) {
      try {
        const url = new URL(raw.origin);
        if (url.origin !== raw.origin || !/^https?:$/.test(url.protocol))
          return;
        entry.origin = url.origin;
      } catch {
        return;
      }
    }
    if (
      ["authentication", "license", "media", "resource"].includes(raw.category)
    )
      entry.category = raw.category;
    if (
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        raw.method,
      )
    )
      entry.method = raw.method;
    if (Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599)
      entry.status = raw.status;
    if (Number.isInteger(raw.cookies) && raw.cookies >= 0 && raw.cookies <= 100)
      entry.cookies = raw.cookies;
    if (typeof raw.credentialed === "boolean")
      entry.credentialed = raw.credentialed;
    if (
      [
        "document",
        "iframe",
        "script",
        "style",
        "image",
        "font",
        "video",
        "audio",
        "worker",
        "websocket",
        "",
      ].includes(raw.destination)
    )
      entry.destination = raw.destination;
    entries.push(entry);
  }
  return { version: 1, active: value.active, entries };
}
export default function CompatibilityPanel({
  frame,
  runtimeOrigin,
  id,
  url,
  fixture = false,
  ready = false,
  panelOpen,
  onOpen,
  onClose,
  control,
}: {
  frame: Window | null | undefined;
  runtimeOrigin?: string;
  id?: string;
  url?: string;
  fixture?: boolean;
  ready?: boolean;
  panelOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  /** Trusted v2 document-bound subscription, never an opaque Window message. */
  control?: FrontendPageControls;
}) {
  const [sites, setSites] = useState(load);
  const [diagnostics, setDiagnostics] = useState(false);
  const [status, setStatus] = useState<CompatibilityStatus>();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [hidden, setHidden] = useState(!!document.fullscreenElement);
  const seen = useRef(new Set<string>());
  const panel = useRef<HTMLElement>(null);
  const visible = panelOpen ?? open;
  useEffect(() => {
    if (panelOpen && !hidden)
      panel.current?.querySelector<HTMLElement>("button,input")?.focus();
  }, [panelOpen, hidden]);
  let origin = "";
  try {
    origin = new URL(url || "").origin;
  } catch {}
  const supported = !!url && !!ruleFor(url, fixture);
  function send(type: string, extra: Record<string, unknown> = {}) {
    if (ready && control) control.send(type, extra);
    else if (!control && ready && frame && runtimeOrigin && id)
      frame.postMessage({ atlas: 1, type, id, ...extra }, runtimeOrigin);
  }
  useEffect(() => {
    setStatus(undefined);
    setNotice("");
  }, [id, origin]);
  useEffect(() => {
    send("compatibility-config", { sites, diagnostics });
    // A runtime may be creating its record asynchronously; resend after ready/navigation.
    const receive = (data: any) => {
      if (["ready", "navigation", "loaded"].includes(data.type))
        send("compatibility-config", { sites, diagnostics });
      if (data.id !== id) return;
      if (
        data.type === "runtime-compatibility" &&
        validRuntimeStatus(data) &&
        data.origin === origin
      ) {
        const key = origin + ":" + data.rule + ":" + data.state;
        if (!seen.current.has(key)) {
          seen.current.add(key);
          setNotice(
            data.state === "applied"
              ? "Compatibility adjustments applied."
              : "The isolated response renderer did not load. Reload this page to retry.",
          );
        }
      }
      if (
        data.type === "compatibility-status" &&
        validStatus(data) &&
        data.origin === origin
      ) {
        setStatus(data);
        const key =
          origin + ":" + data.rule + ":" + !!data.applied + ":" + data.risk;
        if (!seen.current.has(key)) {
          if (seen.current.size >= 256) seen.current.clear();
          seen.current.add(key);
          if (data.applied || data.risk)
            setNotice(
              data.applied
                ? "Compatibility adjustments applied."
                : "This site may still be classified based on its content.",
            );
        }
      }
      if (data.type === "compatibility-diagnostics") {
        const report = cleanDiagnosticReport(data.report);
        if (!report) return;
        const href = URL.createObjectURL(
          new Blob([JSON.stringify(report, null, 2)], {
            type: "application/json",
          }),
        );
        const a = document.createElement("a");
        a.href = href;
        a.download = "atlas-local-diagnostics.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }
    };
    if (control) return control.subscribe(receive);
    const listener = (event: MessageEvent) => {
      if (
        event.source === frame &&
        event.origin === runtimeOrigin &&
        event.data?.atlas === 1
      )
        receive(event.data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [control, frame, runtimeOrigin, id, origin, sites, diagnostics, ready]);
  useEffect(() => {
    const fullscreen = () => setHidden(!!document.fullscreenElement);
    const storage = (event: StorageEvent) => {
      if (event.key === SITE_PREFERENCE_KEY) setSites(load());
    };
    document.addEventListener("fullscreenchange", fullscreen);
    window.addEventListener("storage", storage);
    return () => {
      document.removeEventListener("fullscreenchange", fullscreen);
      window.removeEventListener("storage", storage);
    };
  }, []);
  function toggle(enabled: boolean) {
    const next = { ...sites };
    if (enabled) next[origin] = true;
    else delete next[origin];
    try {
      localStorage.setItem(SITE_PREFERENCE_KEY, JSON.stringify(next));
    } catch {
      setNotice(
        "Device storage is full; this choice applies to this window only.",
      );
    }
    setSites(sanitizeSiteModes(next));
  }
  if (!url || !id || !runtimeOrigin) return null;
  return (
    <div className="site-options">
      {panelOpen === undefined && (
        <button
          type="button"
          className="browsing-options-trigger"
          aria-label="Page compatibility"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Page options
        </button>
      )}
      {visible && !hidden && (
        <section
          ref={panel}
          role={panelOpen === undefined ? undefined : "dialog"}
          className="site-options-panel"
          aria-label={
            panelOpen === undefined
              ? "Page compatibility options"
              : "Page options"
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              onClose?.();
            }
          }}
        >
          <strong>Page options</strong>
          {onClose && (
            <button
              type="button"
              aria-label="Close page options"
              onClick={onClose}
            >
              Close
            </button>
          )}
          <p>
            Runtime adjustments are automatic. Actual site content may still be
            classified.
          </p>
          <label>
            <input
              type="checkbox"
              checked={!!sites[origin]}
              disabled={!supported}
              onChange={(e) => toggle(e.target.checked)}
            />{" "}
            Adjust site metadata for this origin
          </label>
          {!supported && (
            <small>No reviewed metadata rule for this site.</small>
          )}
          <button type="button" onClick={() => toggle(false)}>
            Restore page defaults
          </button>
          {status && (
            <small>
              {status.applied} metadata adjustments
              {status.throttled ? " · frequent updates limited" : ""}
            </small>
          )}
          <label>
            <input
              type="checkbox"
              checked={diagnostics}
              onChange={(e) => setDiagnostics(e.target.checked)}
            />{" "}
            Record local diagnostics (5 minutes)
          </label>
          <button
            type="button"
            disabled={!diagnostics}
            onClick={() => send("compatibility-export")}
          >
            Export local diagnostics
          </button>
          <small>
            No cookie values, credentials, query strings, or page text are
            exported.
          </small>
        </section>
      )}
      {notice && !hidden && (
        <div className="site-options-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              onOpen?.();
            }}
          >
            Details
          </button>
          <button
            type="button"
            aria-label="Dismiss compatibility notice"
            onClick={() => setNotice("")}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
