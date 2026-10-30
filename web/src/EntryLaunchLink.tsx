import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { getHubSession } from "./hub-client-state";
import { useV21ModalFocus } from "./v21-modal-focus";
import {
  createDocumentAnnouncementClient,
  isBrowserEntry,
  type DocumentAnnouncement,
} from "./entry-launch-link";
import "./entry-launch-link.css";

const client = createDocumentAnnouncementClient((...args) => fetch(...args));
function currentIdentity() {
  const session = getHubSession();
  return session?.enabled &&
    session.authenticated &&
    session.csrf &&
    session.grant?.userId &&
    session.grant.profileId
    ? `${session.grant.userId}:${session.grant.profileId}`
    : "";
}

/** Mounted inside the ready HubGate: sign-in and restoration are never covered. */
export default function EntryLaunchLinkNotice() {
  const eligible = isBrowserEntry(location.pathname, window.top === window);
  const [identity, setIdentity] = useState(currentIdentity);
  const [entry, setEntry] = useState<{
    identity: string;
    announcement: DocumentAnnouncement;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const announcement =
    eligible && identity && entry?.identity === identity
      ? entry.announcement
      : null;

  useEffect(() => {
    const change = () => setIdentity(currentIdentity());
    window.addEventListener("atlas:hub-session", change);
    change();
    return () => window.removeEventListener("atlas:hub-session", change);
  }, []);
  useEffect(() => {
    let live = true;
    setEntry(null);
    setSaved(false);
    setError("");
    if (eligible && identity)
      void client.load(identity).then((value) => {
        if (live && value && currentIdentity() === identity)
          setEntry({ identity, announcement: value });
      });
    return () => {
      live = false;
    };
  }, [eligible, identity]);
  useEffect(() => {
    const panel = dialog.current;
    if (!announcement || !panel) return;
    if (!panel.open) panel.showModal();
    return () => {
      if (panel.open) panel.close();
    };
  }, [announcement]);

  async function dismiss() {
    if (!announcement || submitting.current) return;
    if (currentIdentity() !== identity) {
      setEntry(null);
      return;
    }
    if (!saved) {
      client.dismiss(identity);
      setEntry(null);
      return;
    }
    const session = getHubSession();
    if (!session?.csrf) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await client.acknowledge(announcement, session.csrf);
      if (currentIdentity() === identity) {
        client.dismiss(identity);
        setEntry(null);
      }
    } catch {
      if (currentIdentity() === identity)
        setError("Preference could not be saved. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  useV21ModalFocus(!!announcement, dialog, () => void dismiss(), "button");

  if (!announcement) return null;
  return (
    <dialog
      ref={dialog}
      className="document-announcement-dialog"
      aria-labelledby="document-announcement-title"
      aria-describedby="document-announcement-description"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        void dismiss();
      }}
    >
      <header>
        <div>
          <h2 id="document-announcement-title">New document link</h2>
          <p id="document-announcement-description">
            Your administrator shared a document link. Open it in a new tab when
            you’re ready.
          </p>
        </div>
        <button
          type="button"
          className="document-announcement-close"
          aria-label="Close document link"
          disabled={busy}
          onClick={() => void dismiss()}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="document-announcement-body">
        <p className="document-announcement-url">{announcement.url}</p>
        <label className="document-announcement-saved">
          <input
            type="checkbox"
            checked={saved}
            disabled={busy}
            onChange={(event) => setSaved(event.target.checked)}
          />
          <span>I've saved this link. Don't show this again.</span>
        </label>
        <p className="document-announcement-help">
          This preference applies to your account in Atlas Hub and Atlas
          Browser. A different document link will appear again.
        </p>
        {busy && (
          <p role="status" className="document-announcement-help">
            Saving your preference…
          </p>
        )}
        {error && (
          <p className="document-announcement-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={() => void dismiss()}>
          {saved ? "Done" : "Not now"}
        </button>
        <a
          className="document-announcement-open"
          href={announcement.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open document <ExternalLink size={16} aria-hidden="true" />
        </a>
      </footer>
    </dialog>
  );
}
