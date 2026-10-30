import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, CloudCheck, X } from "lucide-react";
import { getLocalFirstProfile } from "./profile-client";
import type { LocalFirstStatus } from "./local-first-profile.ts";
import { useAnchoredPopover } from "./v21-popover";
import { backupPopupError, backupPopupView } from "./backup-popup-state.ts";
import "./LocalFirstBackupStatus.css";
type Version = {
  checkpointId: string;
  label: string;
  origin: string;
  completedAt: string;
  sequence: number;
};
export default function LocalFirstBackupStatus({
  status,
}: {
  status: LocalFirstStatus;
  website?: string;
}) {
  const [open, show] = useState(false),
    [versions, setVersions] = useState<Version[] | null>(null),
    [error, fail] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [listing, setListing] = useState(false),
    [working, setWorking] = useState(false),
    [loadingLatest, setLoadingLatest] = useState(false),
    [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLElement>(null),
    anchor = useAnchoredPopover(open, trigger);
  const { backup } = status,
    last = backup.lastCompleted;
  const { label, summary, issue } = backupPopupView(backup);
  const Icon =
    last && backup.state === "idle" && !backup.deferred.length
      ? CloudCheck
      : Cloud;
  const close = () => {
    show(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    void getLocalFirstProfile()
      ?.checkLatest()
      .catch(() => {});
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        show(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  async function list(older = false) {
    fail("");
    setListing(true);
    try {
      const profile = getLocalFirstProfile();
      if (!profile) throw new Error("Sign in again");
      const result = (await profile.backup.list(
        older ? (cursor ?? undefined) : undefined,
      )) as { checkpoints: Version[]; nextCursor?: string | null };
      setVersions((prior) =>
        older
          ? [...(prior ?? []), ...(result?.checkpoints ?? [])]
          : (result?.checkpoints ?? []),
      );
      setCursor(result?.nextCursor ?? null);
    } catch (e) {
      fail(backupPopupError(e, "Backups unavailable. Try again."));
    } finally {
      setListing(false);
    }
  }
  async function backUp() {
    if (working) return;
    fail("");
    setWorking(true);
    try {
      const profile = getLocalFirstProfile();
      if (!profile) throw new Error("Sign in again");
      await profile.retry();
    } catch (error) {
      fail(backupPopupError(error));
    } finally {
      setWorking(false);
    }
  }
  async function loadLatest() {
    if (loadingLatest || working) return;
    if (
      [
        "pending",
        "preparing",
        "uploading",
        "publishing",
        "conflict",
        "deferred",
      ].includes(backup.state) &&
      !window.confirm(
        "Load the latest backup? Changes since your last backup will not be included.",
      )
    )
      return;
    fail("");
    setNotice("");
    setLoadingLatest(true);
    try {
      const profile = getLocalFirstProfile();
      if (!profile) throw new Error("Sign in again");
      const destination = await profile.loadLatest();
      if (!destination) {
        setNotice("No newer backup available.");
        return;
      }
      const url = new URL(destination, location.href);
      if (
        url.origin !== location.origin ||
        url.username ||
        url.password ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          url.searchParams.get("backupVersion") ?? "",
        ) ||
        url.searchParams.get("activateBackup") !== "1"
      )
        throw new Error("Invalid backup destination");
      location.assign(url.href);
    } catch (error) {
      fail(backupPopupError(error, "Latest backup unavailable. Try again."));
    } finally {
      setLoadingLatest(false);
    }
  }
  return (
    <div className="profile-status">
      <button
        ref={trigger}
        className="profile-trigger"
        title={label}
        aria-label="Your saves"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => show(!open)}
      >
        <Icon size={18} aria-hidden="true" />
        <span role="status">{label}</span>
      </button>
      {open &&
        createPortal(
          <section
            ref={panel}
            className="profile-menu local-first-backup-menu"
            style={{
              ...anchor,
              overflowY: "auto",
            }}
            role="dialog"
            aria-label="Your saves"
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
              if (event.key === "Tab") {
                const focusable = panel.current?.querySelectorAll<HTMLElement>(
                  "button:not(:disabled),a[href]",
                );
                if (focusable?.length) {
                  const first = focusable[0],
                    last = focusable[focusable.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              }
            }}
          >
            <header>
              <h2>Your saves</h2>
              <button aria-label="Close saves" onClick={close}>
                <X size={18} />
              </button>
            </header>
            <p className="backup-summary" role="status">
              <strong>Saved locally</strong>
              <span>{summary}</span>
            </p>
            <p className="backup-time">
              Last backup:{" "}
              {last ? (
                <time dateTime={last.completedAt}>
                  {new Date(last.completedAt).toLocaleString()}
                </time>
              ) : (
                "Not yet"
              )}
            </p>
            {status.newerBackup && (
              <p className="backup-issue" role="status">
                Newer backup available.
              </p>
            )}
            <div className="profile-actions backup-actions">
              <button
                disabled={working || loadingLatest}
                onClick={() => void backUp()}
              >
                {working ? "Backing up…" : "Back up now"}
              </button>
              <button
                disabled={working || loadingLatest}
                onClick={() => void loadLatest()}
              >
                {loadingLatest ? "Loading…" : "Load latest"}
              </button>
              <button disabled={listing} onClick={() => void list()}>
                Backup versions
              </button>
            </div>
            {(error || notice || status.latestCheckError || issue) && (
              <p className="backup-issue" role={error ? "alert" : "status"}>
                {error ||
                  notice ||
                  (status.latestCheckError
                    ? backupPopupError(
                        status.latestCheckError,
                        "Latest backup unavailable. Try again.",
                      )
                    : issue)}
              </p>
            )}
            {versions && (
              <section
                className="backup-versions"
                aria-label="Completed backup versions"
              >
                <h3>Backup versions</h3>
                {!versions.length && <p>No completed backups yet.</p>}
                <ul>
                  {versions.map((version) => {
                    const url = new URL(location.href);
                    url.searchParams.set("backupVersion", version.checkpointId);
                    url.searchParams.delete("atlasLocalFirst");
                    url.searchParams.delete("freshWorkspace");
                    url.searchParams.delete("activateBackup");
                    url.searchParams.delete("backupActivation");
                    return (
                      <li key={version.checkpointId}>
                        <a
                          href={url.href}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span>{version.label || version.origin}</span>
                          <time dateTime={version.completedAt}>
                            {new Date(version.completedAt).toLocaleString()}
                          </time>
                        </a>
                      </li>
                    );
                  })}
                </ul>
                {cursor && (
                  <button disabled={listing} onClick={() => void list(true)}>
                    Older backups
                  </button>
                )}
              </section>
            )}
          </section>,
          document.body,
        )}
    </div>
  );
}
