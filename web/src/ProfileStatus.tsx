import LocalFirstBackupStatus from "./LocalFirstBackupStatus";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, CloudCheck, CloudOff, CloudUpload, CircleAlert } from "lucide-react";
import {
  getProfileStatus,
  listProfileRecoveries,
  downloadProfileRecovery,
  repairProfileSync,
  type ProfileStatus as Status,
} from "./profile-client";
import { useAnchoredPopover } from "./v21-popover";
import { profileStatusLabel, profileSyncRepairAvailable, profileStatusMessage } from "./profile-status-view";
import { profileStatusForWebsite } from "./profile-handoff-view";
import { getHubSession } from "./hub-client-state";
export default function ProfileStatus({ website }: { website?: string }) {
  const [s, set] = useState<Status>(getProfileStatus()),
    [enabled, on] = useState(!!getHubSession()?.authenticated),
    [open, show] = useState(false),
    [recoveries, versions] = useState<Array<{
      id: string;
      createdAt: string;
    }> | null>(null),
    [error, fail] = useState(""),
    [confirmRepair, confirm] = useState(false),
    [repairing, repairBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const anchor = useAnchoredPopover(open, trigger);
  useEffect(() => {
    const status = (e: Event) => set((e as CustomEvent).detail),
      session = () => on(!!getHubSession()?.authenticated);
    window.addEventListener("atlas:profile-status", status);
    window.addEventListener("atlas:hub-session", session);
    set(getProfileStatus());
    session();
    return () => {
      window.removeEventListener("atlas:profile-status", status);
      window.removeEventListener("atlas:hub-session", session);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        show(false);
        trigger.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) show(false);
    };
    window.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  if (!enabled) return null;
  if (s.localFirst) return <LocalFirstBackupStatus status={s.localFirst} website={website}/>;
  const action = (name: string) => window.dispatchEvent(new CustomEvent(name));
  const label = profileStatusLabel(profileStatusForWebsite(s, website));
  const SaveIcon = s.state === "synced" ? CloudCheck
    : s.state === "pending" || s.state === "restoring" ? CloudUpload
    : s.state === "offline" ? CloudOff
    : s.state === "error" || s.state === "conflict" ? CircleAlert : Cloud;
  return (
    <div className="profile-status">
      <button
        ref={trigger}
        className="profile-trigger"
        aria-label="Your saves"
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => show(!open)}
      >
        <SaveIcon size={18} aria-hidden="true" />
        <span role="status">
          {label}
        </span>
      </button>
      {open &&
        createPortal(
          <section
            className={confirmRepair ? "profile-menu profile-repair-menu" : "profile-menu"}
            ref={panel}
            style={anchor}
            role="dialog"
            aria-label="Your saves"
          >
            <header>
              <h2>Your saves</h2>
              <button
                aria-label="Close saves"
                onClick={() => {
                  show(false);
                  trigger.current?.focus();
                }}
              >
                ×
              </button>
            </header>
            {!confirmRepair && <p>{profileStatusMessage(s.message)}</p>}
            {!confirmRepair && error && <p role="alert">{profileStatusMessage(error)}</p>}
            {profileSyncRepairAvailable(s) && !confirmRepair && (
              <button disabled={repairing} onClick={() => { fail(""); confirm(true); }}>Repair sync…</button>
            )}
            {confirmRepair && <section className="profile-repair-confirm" aria-labelledby="profile-repair-title" aria-busy={repairing}>
              <h3 id="profile-repair-title">Repair synchronization?</h3>
              <div className="profile-repair-copy">
              <p>Atlas will back up your locally stored website changes to Recovered saves, then reload the affected websites using the latest Hub save. The two versions will not be merged. Text or progress that the website has not saved may be lost.</p>
              <p>If the backup is not confirmed, Atlas keeps your local saves and stops the repair.</p>
              {error && <p role="alert">{profileStatusMessage(error)}</p>}
              </div>
              <footer>
              <button disabled={repairing} onClick={() => {
                repairBusy(true); fail("");
                void repairProfileSync().then(() => confirm(false)).catch(e => fail(e.message)).finally(() => repairBusy(false));
              }}>{repairing ? "Backing up and repairing…" : "Back up & repair"}</button>
              <button disabled={repairing} onClick={() => confirm(false)}>Cancel</button>
              </footer>
            </section>}
            {!confirmRepair && ["error", "offline", "conflict"].includes(s.state) &&
              !s.canContinue && (
                <button disabled={repairing} onClick={() => action("atlas:profile-retry")}>
                  Retry sync
                </button>
              )}
            <button
              hidden={confirmRepair}
              onClick={() =>
                void listProfileRecoveries()
                  .then((v) => versions(v.recoveries))
                  .catch((e) => fail(e.message))
              }
            >
              Recovered saves
            </button>
            {!confirmRepair && recoveries && (
              <section>
                <h3>Recovered saves</h3>
                {recoveries.length ? (
                  recoveries.map((r) => (
                    <p key={r.id}>
                      <button
                        onClick={() =>
                          void downloadProfileRecovery(r.id).catch((e) =>
                            fail(e.message),
                          )
                        }
                      >
                        Download {new Date(r.createdAt).toLocaleString()}
                      </button>
                    </p>
                  ))
                ) : (
                  <p>No recovered saves.</p>
                )}
              </section>
            )}
            <button
              hidden={confirmRepair}
              disabled={repairing}
              onClick={() => {
                show(false);
                action("atlas:profile-signout");
              }}
            >
              Sign out
            </button>
          </section>,
          document.body,
        )}
    </div>
  );
}
