import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";
import type { ProfileHandoffView } from "./profile-handoff-view";

/** An explicit, scoped choice. This component never treats a click as a save
 * acknowledgement or changes the profile, website frame, or local data. */
export default function ProfileBackupChoice({
  view,
  origin,
  confirm,
}: {
  view: ProfileHandoffView;
  origin: string;
  confirm: (origin: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const flight = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<Element | null>(null);
  const previousOrigin = useRef(origin);
  const identity = useId();
  const available = view.kind === "waiting" && view.canUseBackup && !view.backupPending;

  useEffect(() => { setPortal(trigger.current?.closest(".atlas") ?? document.querySelector(".atlas")); }, []);

  useEffect(() => {
    // A normal handoff may finish while the warning is open. Never turn that
    // transition into an automatic request to take over an old version.
    if (!available || previousOrigin.current !== origin) setOpen(false);
    previousOrigin.current = origin;
  }, [available, origin]);
  useEffect(() => {
    if (!view.backupPending) {
      flight.current = false;
      setSubmitted(false);
    }
  }, [view.backupPending, view.message, origin]);
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (open && available) {
      if (!panel.open) panel.showModal();
      cancel.current?.focus();
    } else if (panel.open) panel.close();
    return () => { if (panel.open) panel.close(); };
  }, [open, available, portal]);

  return (
    <>
      {available && (
        <button
          ref={trigger}
          type="button"
          className="button secondary profile-backup-choice"
          aria-haspopup="dialog"
          disabled={submitted}
          onClick={() => { if (!flight.current) setOpen(true); }}
        >
          Use last saved version
        </button>
      )}
      {portal && createPortal(<dialog
        ref={dialog}
        className="profile-backup-dialog"
        aria-modal="true"
        aria-labelledby={`${identity}-title`}
        aria-describedby={`${identity}-description ${identity}-warning`}
        onCancel={(event) => { event.preventDefault(); setOpen(false); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="profile-backup-heading">
          <span className="profile-backup-symbol" aria-hidden="true"><CircleAlert size={22} /></span>
          <h2 id={`${identity}-title`}>Open last saved version?</h2>
        </header>
        <div className="profile-backup-copy">
          <p id={`${identity}-description`}>Only data already uploaded to your account can be restored. If there is no saved data, this website starts fresh.</p>
          <div id={`${identity}-warning`} className="profile-backup-warning">
            <p>Changes that haven’t uploaded won’t appear here. Unsaved progress may be lost.</p>
            <p>Your other browser stops syncing this website; saves already stored there remain for recovery.</p>
          </div>
        </div>
        <footer className="profile-backup-actions">
          <button ref={cancel} type="button" className="button secondary" onClick={() => setOpen(false)}>Keep waiting</button>
          <button
            type="button"
            className="button primary"
            disabled={submitted || !available}
            onClick={() => {
              if (!available || flight.current) return;
              flight.current = true;
              setSubmitted(true);
              setOpen(false);
              confirm(origin);
            }}
          >
            Open last saved version
          </button>
        </footer>
      </dialog>, portal)}
    </>
  );
}
