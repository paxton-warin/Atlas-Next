import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import { api, post, put } from "./api";
import { Button, Card, Dialog, Field, Input, Notice } from "./ui";
import "./EntryLaunchLink.css";

export type EntryLaunchLink = {
  url: string;
  hubEnabled: boolean;
  browserEnabled: boolean;
};
export const DEFAULT_ENTRY_LAUNCH_LINK: EntryLaunchLink = {
  url: "https://docs.google.com/document/d/1YcSpjvV7n1VJRXPRu-2k8CW2r-CDv9QEGToRxkTfwxY/edit?tab=t.0",
  hubEnabled: false,
  browserEnabled: false,
};

export function normalizeEntryLaunchLink(value: unknown): EntryLaunchLink | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Partial<EntryLaunchLink>;
  if (typeof config.url !== "string" || config.url.length > 2048 ||
      typeof config.hubEnabled !== "boolean" || typeof config.browserEnabled !== "boolean") return null;
  try {
    const url = new URL(config.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return { url: url.href, hubEnabled: config.hubEnabled, browserEnabled: config.browserEnabled };
  } catch { return null; }
}

export function hubLaunchRouteEligible(path: string) {
  // Authorization, cross-origin handoffs and service/helper documents must never show entry announcements.
  return !/^\/(?:api|auth|authorize|setup|health|worker\.js|hub\/(?:session-transfer|authorize|profile|branch))(?:\/|$)/i.test(path);
}

export type DocumentAnnouncement = EntryLaunchLink & { announcementId: string; acknowledged: boolean };
type AnnouncementSnapshot = { announcement: DocumentAnnouncement | null; open: boolean; busy: boolean; error: string };
type AnnouncementEnvironment = {
  load: () => Promise<unknown>;
  acknowledge: (announcementId: string) => Promise<unknown>;
  eligible: () => boolean;
};
export function normalizeDocumentAnnouncement(value: unknown): DocumentAnnouncement | null {
  const config = normalizeEntryLaunchLink(value);
  if (!config) return null;
  const announcement = value as Partial<DocumentAnnouncement>;
  if (typeof announcement.announcementId !== "string" || !/^[a-f0-9]{64}$/.test(announcement.announcementId) || typeof announcement.acknowledged !== "boolean") return null;
  return { ...config, announcementId: announcement.announcementId, acknowledged: announcement.acknowledged };
}

export function createDocumentAnnouncementController(environment: AnnouncementEnvironment) {
  let started = false, presented = false;
  let config: DocumentAnnouncement | null = null;
  let snapshot: AnnouncementSnapshot = { announcement: null, open: false, busy: false, error: "" };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const present = () => {
    if (presented || !config?.hubEnabled || config.acknowledged || !environment.eligible()) return;
    presented = true;
    snapshot = { announcement: config, open: true, busy: false, error: "" };
    notify();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (!environment.eligible()) return;
      if (started) { present(); return; }
      started = true;
      void environment.load().then((value) => {
        config = normalizeDocumentAnnouncement(value);
        present();
      }).catch(() => { /* Optional presentation never interferes with authentication. */ });
    },
    async close(saved: boolean) {
      if (!snapshot.open || snapshot.busy) return;
      if (!saved || !snapshot.announcement) { snapshot = { ...snapshot, open: false, error: "" }; notify(); return; }
      snapshot = { ...snapshot, busy: true, error: "" }; notify();
      try {
        const result = await environment.acknowledge(snapshot.announcement!.announcementId) as Partial<DocumentAnnouncement> | null;
        if (!result || result.acknowledged !== true || result.announcementId !== snapshot.announcement!.announcementId)
          throw Error("Your preference could not be confirmed. Please try again.");
        snapshot = { ...snapshot, open: false, busy: false, error: "" }; notify();
      } catch (failure) {
        snapshot = { ...snapshot, busy: false, error: failure instanceof Error ? failure.message : "Your preference could not be saved. Please try again." }; notify();
      }
    },
  };
}

type AnnouncementController = ReturnType<typeof createDocumentAnnouncementController>;
const documentControllers = new WeakMap<Document, Map<string, AnnouncementController>>();
function documentAnnouncementController(userId: string) {
  let accounts = documentControllers.get(document);
  if (!accounts) { accounts = new Map(); documentControllers.set(document, accounts); }
  let controller = accounts.get(userId);
  if (!controller) {
    controller = createDocumentAnnouncementController({
      load: () => api<DocumentAnnouncement>("/hub/document-announcement"),
      acknowledge: (announcementId) => post("/hub/document-announcement/ack", { announcementId }),
      eligible: () => window.self === window.top && document.visibilityState === "visible" && hubLaunchRouteEligible(location.pathname),
    });
    accounts.set(userId, controller);
  }
  return controller;
}

export function DocumentAnnouncementDialog({ announcement, open, busy, error, onClose }: {
  announcement: DocumentAnnouncement; open: boolean; busy: boolean; error: string; onClose: (saved: boolean) => void;
}) {
  const [saved, setSaved] = useState(false);
  return <Dialog open={open} title="New document link" description="Your administrator shared a document link. Open it in a new tab when you’re ready."
    onClose={() => { if (!busy) onClose(saved); }}
    footer={<><Button type="button" disabled={busy} onClick={() => onClose(saved)}>{saved ? "Done" : "Not now"}</Button>
      <a className="button button--primary" href={announcement.url} target="_blank" rel="noopener noreferrer">Open document<ExternalLink aria-hidden="true" size={16} /></a></>}>
    <div className="entry-document-announcement">
      <p className="entry-document-announcement__url">{announcement.url}</p>
      <label className="check entry-document-announcement__saved"><input type="checkbox" checked={saved} disabled={busy} onChange={(event) => setSaved(event.target.checked)} /><span>I've saved this link. Don't show this again.</span></label>
      <p className="field-help">This preference applies to your account in Atlas Hub and Atlas Browser. A different document link will appear again.</p>
      {busy && <p role="status" className="field-help">Saving your preference…</p>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  </Dialog>;
}

export function HubLaunchLink({ userId }: { userId: string }) {
  const [snapshot, setSnapshot] = useState<AnnouncementSnapshot>({ announcement: null, open: false, busy: false, error: "" });
  useEffect(() => {
    const controller = documentAnnouncementController(userId);
    const update = () => setSnapshot(controller.snapshot());
    const unsubscribe = controller.subscribe(update);
    const start = () => controller.start();
    update(); start();
    document.addEventListener("visibilitychange", start);
    return () => { unsubscribe(); document.removeEventListener("visibilitychange", start); };
  }, [userId]);
  return snapshot.announcement
    ? <DocumentAnnouncementDialog key={snapshot.announcement.announcementId} announcement={snapshot.announcement} open={snapshot.open} busy={snapshot.busy} error={snapshot.error}
      onClose={(saved) => { void documentAnnouncementController(userId).close(saved); }} />
    : null;
}

export function EntryLaunchLinkSettings({ value, onSaved }: { value?: unknown; onSaved: (value: EntryLaunchLink) => void | Promise<void> }) {
  const config = normalizeEntryLaunchLink(value) ?? DEFAULT_ENTRY_LAUNCH_LINK;
  const [draft, setDraft] = useState<EntryLaunchLink>(config);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { setDraft({ url: config.url, hubEnabled: config.hubEnabled, browserEnabled: config.browserEnabled }); }, [config.url, config.hubEnabled, config.browserEnabled]);
  const update = (change: Partial<EntryLaunchLink>) => { setDraft((current) => ({ ...current, ...change })); setSaved(false); setError(""); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next = normalizeEntryLaunchLink(draft);
    if (!next) { setError("Enter a complete http:// or https:// address without a username or password."); return; }
    setBusy(true); setError(""); setSaved(false);
    try {
      await put("/admin/settings/entryLaunchLink", next);
      await onSaved(next);
      window.dispatchEvent(new CustomEvent("atlas:document-resource-updated", { detail: next }));
      setSaved(true);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Document announcement could not be saved."); }
    finally { setBusy(false); }
  };
  return <Card className="entry-launch-settings">
    <header><span><ExternalLink aria-hidden="true" /></span><div><h3>Document link announcement</h3><p>Optional notice when Atlas opens · Disabled by default</p></div></header>
    <form onSubmit={(event) => void save(event)}>
      <Field label="Link address" hint="Use a complete http:// or https:// address.">
        <Input type="url" required maxLength={2048} value={draft.url} disabled={busy} onChange={(event) => update({ url: event.target.value })} />
      </Field>
      <fieldset disabled={busy} className="entry-launch-settings__destinations">
        <legend>Show the announcement when users enter</legend>
        <label className="check"><input type="checkbox" checked={draft.hubEnabled} onChange={(event) => update({ hubEnabled: event.target.checked })} /><span>Atlas Hub</span></label>
        <label className="check"><input type="checkbox" checked={draft.browserEnabled} onChange={(event) => update({ browserEnabled: event.target.checked })} /><span>Atlas Browser</span></label>
      </fieldset>
      <p className="field-help">Choose either app or both. Users see a dismissible dialog; the document opens only when they select Open document.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {saved && <Notice tone="success">Document announcement saved.</Notice>}
      <Button type="submit" tone="primary" busy={busy}>Save announcement</Button>
    </form>
  </Card>;
}
