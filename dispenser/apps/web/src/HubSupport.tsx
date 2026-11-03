import { Bell, X, Plus, Send, ArrowLeft, MessageSquare, RefreshCw, Megaphone } from "lucide-react";
import { AnnouncementDetail } from "./HubAnnouncements";
import { subscribeSupportLive } from "./hubSupportLive";
import { useEffect, useRef, useState } from "react";
import { api, post } from "./api";
import { encodeSupportFiles, SupportMediaList, SupportMediaPicker, type SupportAttachment, type SupportMediaResult } from "./SupportMedia";
import {
  Button,
  Card,
  Field,
  Input,
  Textarea,
  Notice,
  Empty,
  PageHeader,
  Select,
  Loading,
  Badge,
} from "./ui";
type Ticket = {
  id: string;
  subject: string;
  status: string;
  unread: number;
  updated_at: string;
  requester_email?: string | null;
  user_id?: string | null;
  category?: string;
  legacy_source?: string | null;
};
type Message = {
  id: string;
  author: string;
  author_email?: string | null;
  body: string;
  public: boolean;
  created_at: string;
  attachments?: SupportAttachment[];
};
export function supportStatusLabel(status: string, admin = false) {
  if (admin && status === "open") return "Needs reply";
  if (status === "awaiting_you") return admin ? "Awaiting user" : "Awaiting you";
  return status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}
export function supportAuthorLabel(author: string, admin: boolean, authorEmail?: string | null, requesterEmail?: string | null) {
  return author === "admin" ? "Atlas support" : admin ? authorEmail || requesterEmail || "User" : "You";
}
export function ticketRequester(ticket?: Pick<Ticket, "requester_email" | "user_id" | "legacy_source">, authorEmail?: string | null) {
  return ticket?.requester_email || authorEmail || (ticket?.legacy_source || ticket?.user_id === null ? "Unlinked legacy requester" : "Account email unavailable");
}
export function filterAdminTickets(tickets: Ticket[], status: string, category: string, query: string) {
  const search = query.trim().toLocaleLowerCase();
  return tickets.filter(t => (status === "all" || t.status === status) && (category === "all" || (t.category || "Other") === category) && (!search || [t.subject,t.requester_email,t.id,t.category].some(value => value?.toLocaleLowerCase().includes(search))));
}
export function filterUserTickets(tickets: Ticket[], previous = false) {
  return tickets.filter((ticket) => (ticket.status === "closed") === previous);
}
export function supportReadPermitted(admin: boolean, active: boolean, visible: boolean) {
  return !admin && active && visible;
}
export function HubSupport({
  admin = false,
  initialTicketId = "",
  active = true,
  openRequest = 0,
}: {
  admin?: boolean;
  initialTicketId?: string;
  active?: boolean;
  openRequest?: number;
}) {
  const base = admin ? "/admin/hub/tickets" : "/hub/tickets";
  const acknowledged = useRef(new Map<string, string>());
  const drafts = useRef(new Map<string, string>());
  const mediaDrafts = useRef(new Map<string, File[]>());
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const [filter, setFilter] = useState(admin ? "all" : "active");
  const [ticketCategory, setTicketCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [detailTicket, setDetailTicket] = useState<Ticket | null>(null);
  const [mobileList, setMobileList] = useState(!initialTicketId);
  const [tickets, setTickets] = useState<Ticket[]>([]),
    [selected, setSelected] = useState(initialTicketId),
    [messages, setMessages] = useState<Message[]>([]),
    [body, setBody] = useState(""),
    [subject, setSubject] = useState(""),
    [category, setCategory] = useState("Other"),
    [internal, setInternal] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const selectedRef = useRef(selected), bodyRef = useRef(body), filesRef = useRef(files), subjectRef = useRef(subject);
  selectedRef.current = selected; bodyRef.current = body; filesRef.current = files; subjectRef.current = subject;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; drafts.current.clear(); mediaDrafts.current.clear(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    async function load() {
      try {
        const r = await api<{ tickets: Ticket[] }>(base);
        if (!disposed) {
          setTickets(r.tickets);
          setLoaded(true);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    }
    void load();
    addEventListener("atlas:notifications-changed", load);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      disposed = true;
      clearInterval(t);
      removeEventListener("atlas:notifications-changed", load);
    };
  }, [base, active]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setMessages([]);
    setDetailTicket(null);
    if (!selected) return;
    async function load() {
      try {
        const r = await api<{ messages: Message[]; ticket: Ticket }>(base + "/" + selected);
        if (disposed) return;
        setMessages(r.messages);
        setDetailTicket(r.ticket);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    }
    void load();
    addEventListener("atlas:notifications-changed", load);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      disposed = true;
      clearInterval(t);
      removeEventListener("atlas:notifications-changed", load);
    };
  }, [base, selected, admin, active]);
  useEffect(() => {
    if (!supportReadPermitted(admin, active, true) || !selected || !messages.length) return;
    const last = messages.at(-1)!.id;
    if (BigInt(acknowledged.current.get(selected) || "0") >= BigInt(last))
      return;
    let disposed = false;
    const frame = requestAnimationFrame(() => {
      if (disposed || !supportReadPermitted(admin, active, document.visibilityState === "visible")) return;
      acknowledged.current.set(selected, last);
      void post("/hub/tickets/" + selected + "/read", { messageId: last })
        .then(() => {
          if (disposed) return;
          dispatchEvent(new Event("atlas:notifications-changed"));
          setTickets((old) =>
            old.map((t) => (t.id === selected ? { ...t, unread: 0 } : t)),
          );
        })
        .catch((e) => {
          if (acknowledged.current.get(selected) === last)
            acknowledged.current.delete(selected);
          if (!disposed) setError((e as Error).message);
        });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [admin, selected, messages, active]);
  useEffect(() => {
    if (initialTicketId && initialTicketId !== selected) {
      drafts.current.set(selected || "new", body);
      setBody(drafts.current.get(initialTicketId) || "");
      mediaDrafts.current.set(selected || "new", files);
      setFiles(mediaDrafts.current.get(initialTicketId) || []);
      setSelected(initialTicketId); setMobileList(false);
    }
  }, [initialTicketId, openRequest]);
  const choose = (id: string) => {
    drafts.current.set(selected || "new", body);
    setBody(drafts.current.get(id || "new") || "");
    mediaDrafts.current.set(selected || "new", files);
    setFiles(mediaDrafts.current.get(id || "new") || []);
    if (!admin) setFilter(tickets.find((ticket) => ticket.id === id)?.status === "closed" ? "previous" : "active");
    setSelected(id); setMobileList(false);
  };
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    const submitted = { ticket: selected, body, subject, category, internal, files };
    const key = submitted.ticket || "new";
    setBusy(true);
    setError("");
    try {
      const attachments = await encodeSupportFiles(submitted.files);
      if (!mounted.current) return;
      if (submitted.ticket) {
        const r = await post<{ message: Message }>(
          base + "/" + submitted.ticket + "/messages",
          { body: submitted.body, public: !submitted.internal, attachments },
        );
        if (!mounted.current) return;
        if (selectedRef.current === submitted.ticket) setMessages((old) => [...old, r.message]);
        if (!admin || !submitted.internal) {
          const status = admin ? "awaiting_you" : "open";
          setDetailTicket(t => t?.id === submitted.ticket ? { ...t, status } : t);
          setTickets(old => old.map(t => t.id === submitted.ticket ? { ...t, status } : t));
          if (!admin && selectedRef.current === submitted.ticket) setFilter("active");
        }
      } else {
        const r = await post<{ ticket: Ticket }>("/hub/tickets", {
          subject: submitted.subject,
          body: submitted.body,
          category: submitted.category,
          attachments,
        });
        if (!mounted.current) return;
        setTickets((old) => [r.ticket, ...old]);
        if (!selectedRef.current) { setSelected(r.ticket.id); setFilter("active"); }
        if (subjectRef.current === submitted.subject) setSubject("");
      }
      if (drafts.current.get(key) === submitted.body) drafts.current.delete(key);
      if (mediaDrafts.current.get(key) === submitted.files) mediaDrafts.current.delete(key);
      if (selectedRef.current === submitted.ticket) {
        if (bodyRef.current === submitted.body) setBody("");
        if (filesRef.current === submitted.files) setFiles([]);
      }
      dispatchEvent(new Event("atlas:notifications-changed"));
    } catch (e) {
      if (mounted.current && selectedRef.current === submitted.ticket) setError((e as Error).message);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const ticket = detailTicket?.id === selected ? detailTicket : tickets.find((t) => t.id === selected);
  const selectedStatus = ticket?.status;
  useEffect(() => {
    if (!admin && selected && selectedStatus) setFilter(selectedStatus === "closed" ? "previous" : "active");
  }, [selected, selectedStatus, admin]);
  const categories = [...new Set(tickets.map(t => t.category || "Other"))].sort((a,b) => a.localeCompare(b));
  const visibleTickets = admin ? filterAdminTickets(tickets, filter, ticketCategory, search) : filterUserTickets(tickets, filter === "previous");
  return <div className="hub-support stack">
    <PageHeader title="Support" description={admin ? "Conversations and replies in one inbox." : "Your conversations with Atlas support."} />
    {error && <Notice tone="danger">{error}</Notice>}
    <div className={`hub-support-grid${mobileList ? " is-list-visible" : " is-conversation-visible"}`}>
      <Card className={`hub-support-list${admin ? " is-admin" : ""}`}>
        <div className="hub-support-list-header"><h2>Conversations</h2>{!admin && <Button tone="primary" onClick={() => choose("")}><Plus size={16} />New ticket</Button>}</div>
        {admin ? <div className="hub-admin-ticket-filters"><Input aria-label="Search tickets by requester or subject" placeholder="Search email or subject" value={search} onChange={e => setSearch(e.target.value)} /><div><Select aria-label="Ticket status" value={filter} onChange={e => setFilter(e.target.value)}>{[["all","All statuses"],["open","Needs reply"],["awaiting_you","Awaiting user"],["closed","Closed"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</Select><Select aria-label="Ticket category" value={ticketCategory} onChange={e => setTicketCategory(e.target.value)}><option value="all">All categories</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</Select></div><small>{visibleTickets.length} of {tickets.length} loaded tickets</small></div> : <div className="hub-ticket-filters" aria-label="Conversation sections">{[["active", "Active tickets"], ["previous", "Previous tickets"]].map(([value, label]) => <Button key={value} tone="ghost" className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</div>}
        <div className="hub-ticket-scroll">
          {!loaded && <Loading label="Loading conversations…" />}
          {loaded && !visibleTickets.length && <Empty title={admin ? tickets.length ? "No matching tickets" : "No tickets" : filter === "previous" ? "No previous tickets" : "No active tickets"}>{!admin && filter === "previous" ? "Closed conversations are kept here for reference." : "New conversations appear here."}</Empty>}
          {visibleTickets.map((t) => <button className={`hub-ticket${selected === t.id ? " is-active" : ""}`} key={t.id} onClick={() => choose(t.id)} aria-current={selected === t.id ? "true" : undefined}>
            <strong>{t.subject}</strong>{admin && <small className="hub-ticket-requester"><span>Requester</span> {ticketRequester(t)}</small>}<span><span className={`hub-ticket-dot${t.status === "closed" ? " is-closed" : ""}`} />{supportStatusLabel(t.status, admin)}{!admin && t.unread > 0 && <b>{t.unread} unread</b>}</span><time dateTime={t.updated_at}>{new Date(t.updated_at).toLocaleDateString()}</time>
          </button>)}
        </div>
      </Card>
      <Card className="hub-support-conversation">
        <header className="hub-conversation-header"><Button tone="ghost" className="hub-support-back" onClick={() => setMobileList(true)}><ArrowLeft size={16} />Conversations</Button><div><h2>{selected ? ticket?.subject || "Conversation" : admin ? "Choose a ticket" : "New ticket"}</h2>{admin && ticket && <p className="hub-ticket-requester"><span>Requester</span> {ticketRequester(ticket)}</p>}{admin && ticket && <small className="hub-ticket-category-label">{ticket.category || "Other"}{!ticket.requester_email && ticket.legacy_source ? " · Legacy ticket, not linked to an account" : ""}</small>}{ticket && <Badge tone={ticket.status === "closed" ? "neutral" : "success"}>{supportStatusLabel(ticket.status, admin)}</Badge>}</div>
          {admin && selected && <Button onClick={async () => { try { const status = ticket?.status === "closed" ? "open" : "closed"; await api(base + "/" + selected, { method: "PATCH", body: JSON.stringify({ status }) }); setTickets((old) => old.map((t) => t.id === selected ? { ...t, status } : t)); setDetailTicket(t => t?.id === selected ? { ...t, status } : t); } catch (e) { setError((e as Error).message); } }}>{ticket?.status === "closed" ? "Reopen ticket" : "Close ticket"}</Button>}
        </header>
        <div className="hub-thread" aria-label="Conversation messages">
          {!selected && admin && <Empty title="Choose a ticket">Select a conversation to read and reply.</Empty>}
          {!selected && !admin && <div className="hub-new-ticket-intro"><MessageSquare size={28} /><h3>How can we help?</h3><p>Choose a category and send your message.</p></div>}
          {selected && messages.map((m) => <article key={m.id} className={`hub-message ${m.author}${!m.public ? " is-internal" : ""}`}><small>{admin && m.author !== "admin" ? ticketRequester(ticket, m.author_email) : supportAuthorLabel(m.author, admin)}{!m.public ? " · Internal note" : ""} · <time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString()}</time></small><p>{m.body}</p><SupportMediaList active={active} attachments={m.attachments} load={(id) => api<SupportMediaResult>(base + "/" + selected + "/attachments/" + id)} /></article>)}
        </div>
        {(!admin || selected) && <div className={`hub-support-composer${internal && admin ? " is-internal" : ""}`}>
          {!admin && ticket?.status === "closed" && <p className="hub-support-previous-note">This ticket is closed. Sending a reply reopens it and moves it to Active tickets.</p>}
          {!selected && <div className="hub-ticket-fields"><Field label="Subject"><Input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} /></Field><Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{["Account access", "Link problem", "Browsing issue", "Other"].map((c) => <option key={c}>{c}</option>)}</Select></Field></div>}
          {admin && <label className="hub-internal-choice"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />Internal note — not sent to user</label>}
          <Field label={selected ? internal && admin ? "Internal note" : "Reply" : "Message"}><Textarea value={body} maxLength={5000} rows={3} onChange={(e) => setBody(e.target.value)} /></Field>
          <SupportMediaPicker files={files} disabled={busy} onChange={(next) => { mediaDrafts.current.set(selected || "new", next); setFiles(next); }} />
          <div className="hub-composer-actions"><small>{body.length.toLocaleString()} / 5,000</small><Button tone="primary" busy={busy} disabled={body.trim().length < (selected ? 1 : 5) || (!selected && subject.trim().length < 3)} onClick={() => void submit()}><Send size={16} />{selected ? internal && admin ? "Save internal note" : "Send reply" : "Create ticket"}</Button></div>
        </div>}
      </Card>
    </div>
  </div>;
}
export type HubNotification = { id: string; kind?: "support" | "announcement"; ticket_id: string | null; announcement_id?: string | null; subject: string; created_at?: string; read_at: string | null };
export function isAnnouncementNotification(n: HubNotification) { return n.kind === "announcement" && Boolean(n.announcement_id); }
/** A read-prioritized feed may reorder or omit newer, already-read records.
 * Never lower the high-water mark or announce an old item as newly published. */
export function notificationSeenCursor(previous: string | null, notifications: readonly Pick<HubNotification, "id">[]) {
  let maximum = BigInt(previous ?? "0");
  for (const notification of notifications) {
    const id = BigInt(notification.id);
    if (id > maximum) maximum = id;
  }
  return maximum.toString();
}
export function NotificationActivity({ notifications, onOpen, onAnnouncement }: { notifications: HubNotification[]; onOpen: (id: string) => void; onAnnouncement?: (id: string) => void }) {
  return <div className="hub-notification-list">{notifications.map((n) => <button key={n.id} className={`hub-notification-item${n.read_at ? "" : " is-unread"}`} onClick={() => { if (isAnnouncementNotification(n)) onAnnouncement?.(n.announcement_id!); else if (n.ticket_id) onOpen(n.ticket_id); }}>{isAnnouncementNotification(n) ? <Megaphone size={17} /> : <MessageSquare size={17} />}<span><strong>{n.subject}</strong><small>{isAnnouncementNotification(n) ? "Atlas announcement" : "Support replied"}{n.created_at ? ` · ${new Date(n.created_at).toLocaleString()}` : ""}</small></span>{!n.read_at && <span className="hub-activity-dot" aria-label="Unread" />}</button>)}</div>;
}
export function HubNotificationBell({ onOpen }: { onOpen: (ticketId: string) => void }) {
  const [count, setCount] = useState(0), [notifications, setNotifications] = useState<HubNotification[]>([]);
  const [toast, setToast] = useState<HubNotification | null>(null), [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [detailId, setDetailId] = useState("");
  const seen = useRef<string | null>(null), ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true, pending = false;
    async function load() {
      if (pending) return; pending = true;
      try { const r = await api<{ unread: number; notifications: HubNotification[] }>("/hub/notifications");
        if (live) { const next = r.notifications.find((n) => !n.read_at) || null; setCount(r.unread); setNotifications(r.notifications); setLoaded(true); setError("");
          if (next && seen.current !== null && BigInt(next.id) > BigInt(seen.current)) setToast(next);
          seen.current = notificationSeenCursor(seen.current, r.notifications);
        }
      } catch { if (live) setError("Activity could not refresh. Your unread state is retained."); } finally { pending = false; }
    }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    addEventListener("atlas:notifications-changed", load);
    const stopLive = subscribeSupportLive(() => dispatchEvent(new Event("atlas:notifications-changed")));
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    return () => { live = false; clearInterval(timer); stopLive(); removeEventListener("atlas:notifications-changed", load); removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); };
  }, [retry]);
  useEffect(() => {
    if (!open) return;
    const pointer = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    addEventListener("pointerdown", pointer); addEventListener("keydown", key);
    return () => { removeEventListener("pointerdown", pointer); removeEventListener("keydown", key); };
  }, [open]);
  const openTicket = (id: string) => { setOpen(false); setToast(null); onOpen(id); };
  return <div className="hub-notifications" ref={ref}>
    <button ref={trigger} className="button button--ghost hub-notification-trigger" aria-label={count ? `Notifications, ${count} unread` : "Notifications"} aria-expanded={open} aria-controls="hub-activity-panel" onClick={() => setOpen(!open)}><Bell size={18} /><span>Notifications</span>{count > 0 && <span className="hub-unread">{count}</span>}</button>
    {open && <section id="hub-activity-panel" className="hub-activity-panel" aria-label="Notification activity"><header><div><h2>Notifications</h2><small>{count} unread {count === 1 ? "notification" : "notifications"} · Unread first</small></div><Button tone="ghost" aria-label="Close notifications" onClick={() => setOpen(false)}><X size={16} /></Button></header>
      {error && <Notice tone="warning">{error}<Button tone="ghost" onClick={() => setRetry((n) => n + 1)}><RefreshCw size={14} />Retry</Button></Notice>}
      {!loaded && !error && <Loading label="Loading activity…" />}
      {loaded && !notifications.length && <Empty title="You're all caught up">Announcements and support replies appear here.</Empty>}
      <NotificationActivity notifications={notifications} onOpen={openTicket} onAnnouncement={(id) => { setOpen(false); setToast(null); setDetailId(id); }} />
    </section>}
    {toast && <div role="status" className="hub-reply-toast"><strong>{isAnnouncementNotification(toast) ? "New Atlas announcement" : "Atlas support replied"}: {toast.subject}</strong><Button onClick={() => { if (isAnnouncementNotification(toast)) { setDetailId(toast.announcement_id!); setToast(null); setOpen(false); } else if (toast.ticket_id) openTicket(toast.ticket_id); }}>{isAnnouncementNotification(toast) ? "Read announcement" : "Read reply"}</Button><Button aria-label="Dismiss notification" onClick={() => setToast(null)}>Dismiss</Button></div>}
    {detailId && <AnnouncementDetail id={detailId} onClose={() => { setDetailId(""); trigger.current?.focus(); }} />}
  </div>;
}
