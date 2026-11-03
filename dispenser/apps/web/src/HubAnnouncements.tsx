export function AnnouncementBody({ text }: { text: string }) {
  return <div className="hub-announcement-text">{text.trim().split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph.split(/(\*\*[^*]+\*\*)/g).map((part, key) => part.startsWith("**") && part.endsWith("**") ? <strong key={key}>{part.slice(2, -2)}</strong> : part)}</p>)}</div>;
}
import { useEffect, useRef, useState } from "react";
import { Megaphone, RefreshCw, Send, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import { api, post } from "./api";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, Notice, PageHeader, Textarea } from "./ui";

export type Announcement = { id: string; notification_id: string; title: string; body: string; published_at: string; withdrawn_at: string | null };
export const ANNOUNCEMENT_TITLE_LIMIT = 120;
export const ANNOUNCEMENT_BODY_LIMIT = 5000;
export function announcementDraftValid(title: string, body: string) {
  return title.trim().length > 0 && title.length <= ANNOUNCEMENT_TITLE_LIMIT && body.trim().length > 0 && body.length <= ANNOUNCEMENT_BODY_LIMIT;
}
export function AnnouncementContent({ title, body }: Pick<Announcement, "title" | "body">) {
  return <article className="hub-announcement-content"><span className="hub-announcement-eyebrow"><Megaphone size={15} />Atlas announcement</span><h3>{title}</h3><AnnouncementBody text={body} /></article>;
}
export function announcementReadPermitted(open: boolean, loaded: boolean, visible: boolean) { return open && loaded && visible; }
export function AnnouncementDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null), [error, setError] = useState(""), [readError, setReadError] = useState(""), [retry, setRetry] = useState(0);
  const acknowledged = useRef(false), content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setAnnouncement(null); setError(""); setReadError(""); acknowledged.current = false;
    void api<{ announcement: Announcement }>(`/hub/announcements/${encodeURIComponent(id)}`, { signal: controller.signal }).then((r) => { if (!controller.signal.aborted) setAnnouncement(r.announcement); }).catch((e) => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [id, retry]);
  useEffect(() => {
    if (!id || !announcement || announcement.id !== id) return;
    let disposed = false, pending = false;
    const acknowledge = () => {
      if (!content.current?.isConnected || !content.current.closest("dialog")?.open || !content.current.getClientRects().length) return;
      if (disposed || pending || acknowledged.current || !announcementReadPermitted(Boolean(id), Boolean(announcement), document.visibilityState === "visible")) return;
      pending = true;
      void post(`/hub/announcements/${encodeURIComponent(id)}/read`, {}).then(() => {
        if (disposed) return;
        acknowledged.current = true; setReadError(""); dispatchEvent(new Event("atlas:notifications-changed"));
      }).catch(() => { if (!disposed) setReadError("This announcement is open, but its read status could not be saved. Reopen it to try again."); }).finally(() => { pending = false; });
    };
    const frame = requestAnimationFrame(acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => { disposed = true; cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", acknowledge); };
  }, [id, announcement]);
  return <Dialog open={Boolean(id)} onClose={onClose} title="Announcement" description="News from Atlas." footer={<Button onClick={onClose}>Done</Button>}>
    {error ? <Notice tone="danger">{error}<p>This announcement may have been withdrawn.</p><Button onClick={() => setRetry((n) => n + 1)}><RefreshCw size={15} />Retry</Button></Notice> : !announcement ? <Loading label="Loading announcement…" /> : <div ref={content}><AnnouncementContent title={announcement.title} body={announcement.body} /><small className="hub-announcement-date">Published {new Date(announcement.published_at).toLocaleString()}</small></div>}
    {readError && <Notice tone="warning">{readError}</Notice>}
  </Dialog>;
}

type PublishAttempt = { id: string; title: string; body: string };
export function AdminAnnouncements({ active = true }: { active?: boolean }) {
  const [title, setTitle] = useState(""), [body, setBody] = useState(""), [preview, setPreview] = useState(false), [attempt, setAttempt] = useState<PublishAttempt | null>(null), [withdraw, setWithdraw] = useState<Announcement | null>(null);
  const [history, setHistory] = useState<Announcement[]>([]), [cursors, setCursors] = useState<string[]>([""]), [nextCursor, setNextCursor] = useState<string | null>(null), [reload, setReload] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [mutationError, setMutationError] = useState(""), [notice, setNotice] = useState("");
  const publishing = useRef(false), stableAttempt = useRef<PublishAttempt | null>(null);
  const cursor = cursors.at(-1)!;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setLoading(true); setError(""); setHistory([]); setNextCursor(null);
    const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor);
    void api<{ announcements: Announcement[]; nextCursor: string | null }>(`/admin/hub/announcements?${query}`, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return; setHistory(r.announcements); setNextCursor(r.nextCursor);
    }).catch((e) => { if (!controller.signal.aborted) setError((e as Error).message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, cursor, reload]);
  const review = () => {
    if (!announcementDraftValid(title, body)) return;
    if (!stableAttempt.current || stableAttempt.current.title !== title || stableAttempt.current.body !== body) stableAttempt.current = { id: crypto.randomUUID(), title, body };
    setAttempt(stableAttempt.current); setMutationError("");
  };
  async function publish() {
    if (!attempt || publishing.current) return;
    publishing.current = true; setBusy(true); setMutationError("");
    try {
      await post("/admin/hub/announcements", attempt);
      setAttempt(null); stableAttempt.current = null; setTitle(""); setBody(""); setCursors([""]); setReload((n) => n + 1); setNotice("Announcement published. Users can find it in their notifications."); dispatchEvent(new Event("atlas:notifications-changed"));
    } catch (e) { setMutationError((e as Error).message); }
    finally { publishing.current = false; setBusy(false); }
  }
  async function confirmWithdraw() {
    if (!withdraw || publishing.current) return;
    publishing.current = true; setBusy(true); setMutationError("");
    try {
      await post(`/admin/hub/announcements/${encodeURIComponent(withdraw.id)}/withdraw`, {});
      setWithdraw(null); setReload((n) => n + 1); setNotice("Announcement withdrawn. It is no longer shown in user notifications."); dispatchEvent(new Event("atlas:notifications-changed"));
    } catch (e) { setMutationError((e as Error).message); }
    finally { publishing.current = false; setBusy(false); }
  }
  return <div className="hub-announcements stack">
    <PageHeader title="Announcements" description="Publish news to notifications in Atlas Hub and Atlas Browser." />
    {notice && <Notice tone="success">{notice}</Notice>}
    <Card className="hub-announcement-compose"><div className="hub-announcement-heading"><div><h2>New announcement</h2><p>Shared with all users. Paragraphs and **bold** are supported. Published announcements cannot be edited.</p></div><Megaphone size={21} /></div>
      <Field label="Title" hint={`${title.length} / ${ANNOUNCEMENT_TITLE_LIMIT}`}><Input value={title} maxLength={ANNOUNCEMENT_TITLE_LIMIT} onChange={(e) => setTitle(e.target.value)} placeholder="A short, clear headline" /></Field>
      <Field label="Message" hint={`${body.length.toLocaleString()} / 5,000 · Paragraphs and **bold** supported`}><Textarea value={body} maxLength={ANNOUNCEMENT_BODY_LIMIT} rows={5} onChange={(e) => setBody(e.target.value)} placeholder="What would you like everyone to know?" /></Field>
      <div className="hub-announcement-actions"><small>Users choose when to open and read it.</small><div><Button disabled={!announcementDraftValid(title, body)} onClick={() => setPreview(true)}><Eye size={16} />Preview</Button><Button tone="primary" disabled={!announcementDraftValid(title, body)} onClick={review}><Send size={16} />Review and publish</Button></div></div>
    </Card>
    <section className="stack hub-announcement-history" aria-label="Announcement history"><div className="hub-announcement-heading"><div><h2>Published history</h2><p>Most recent first. Withdrawn announcements stay here for reference.</p></div><Button disabled={loading} onClick={() => setReload((n) => n + 1)}><RefreshCw size={15} />Refresh</Button></div>
      {loading ? <Loading label="Loading announcements…" /> : error ? <Notice tone="danger">{error}<Button onClick={() => setReload((n) => n + 1)}>Retry</Button></Notice> : !history.length ? <Card><Empty title="No announcements yet">Publish your first announcement to keep everyone up to date.</Empty></Card> : history.map((item) => <Card className="hub-announcement-history-item" key={item.id}><div className="hub-announcement-heading"><div><h3>{item.title}</h3><time dateTime={item.published_at}>{new Date(item.published_at).toLocaleString()}</time></div><Badge tone={item.withdrawn_at ? "neutral" : "success"}>{item.withdrawn_at ? "Withdrawn" : "Published"}</Badge></div><div className="hub-announcement-body"><AnnouncementBody text={item.body} /></div><div className="hub-announcement-history-footer">{item.withdrawn_at ? <small>Withdrawn {new Date(item.withdrawn_at).toLocaleString()}</small> : <Button tone="ghost" onClick={() => { setWithdraw(item); setMutationError(""); }}>Withdraw announcement</Button>}</div></Card>)}
      <div className="hub-announcement-pagination"><Button disabled={loading || cursors.length === 1} onClick={() => setCursors((p) => p.slice(0, -1))}><ChevronLeft size={16} />Newer</Button><small>Page {cursors.length}</small><Button disabled={loading || !nextCursor} onClick={() => { if (nextCursor) setCursors((p) => [...p, nextCursor]); }}>Older<ChevronRight size={16} /></Button></div>
    </section>
    <Dialog open={active && preview} onClose={() => setPreview(false)} title="Preview announcement" description="This is how your message will appear when a user opens it." footer={<Button onClick={() => setPreview(false)}>Back to editing</Button>}><AnnouncementContent title={title} body={body} /></Dialog>
    <Dialog open={active && Boolean(attempt)} onClose={() => { if (!busy) setAttempt(null); }} title="Publish to all users?" description="This announcement will appear in Atlas Hub and Atlas Browser notifications. You can withdraw it later, but cannot edit it." footer={<><Button disabled={busy} onClick={() => setAttempt(null)}>Back to editing</Button><Button tone="primary" busy={busy} onClick={() => void publish()}><Send size={16} />Publish announcement</Button></>}>
      {attempt && <AnnouncementContent title={attempt.title} body={attempt.body} />}{mutationError && <Notice tone="danger">{mutationError}<p>Your draft is retained. Retry uses the same publish request to avoid duplicates.</p></Notice>}
    </Dialog>
    <Dialog open={active && Boolean(withdraw)} onClose={() => { if (!busy) setWithdraw(null); }} title="Withdraw announcement?" description="This removes it from user notifications, including unread items. It stays in your published history." footer={<><Button disabled={busy} onClick={() => setWithdraw(null)}>Keep published</Button><Button tone="danger" busy={busy} onClick={() => void confirmWithdraw()}>Withdraw announcement</Button></>}><strong>{withdraw?.title}</strong>{mutationError && <Notice tone="danger">{mutationError}</Notice>}</Dialog>
  </div>;
}
