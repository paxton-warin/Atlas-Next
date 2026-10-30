export function AnnouncementBody({ text }: { text: string }) {
  return <div className="hub-announcement-text">{text.trim().split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph.split(/(\*\*[^*]+\*\*)/g).map((part, key) => part.startsWith("**") && part.endsWith("**") ? <strong key={key}>{part.slice(2, -2)}</strong> : part)}</p>)}</div>;
}
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bell, X } from "lucide-react";
import { useAnchoredPopover } from "./v21-popover";
import { useV21ModalFocus } from "./v21-modal-focus";
import { getHubSession } from "./hub-client-state";
import "./HubSupportPanel.css";
import { encodeSupportFiles, SupportMediaPicker, SupportMediaList, type SupportAttachment, type SupportMediaResult } from "./SupportMedia";
type Ticket = { id: string; subject: string; status: string; unread: number };
type Message = { id: string; author: string; body: string; created_at: string; attachments?: SupportAttachment[] };
type Notification = {
  id: string;
  kind?: "support" | "announcement";
  announcement_id?: string;
  ticket_id: string | null;
  subject: string;
  read_at: string | null;
};
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const session = getHubSession();
  if (!session?.authenticated || !session.csrf)
    throw Error("Sign in to Atlas Hub first.");
  const response = await fetch("/api/hub/support" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-atlas-hub-csrf": session.csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  const active = getHubSession();
  if (
    !active?.authenticated ||
    active.grant?.sessionId !== session.grant?.sessionId ||
    active.grant?.userId !== session.grant?.userId ||
    active.grant?.profileId !== session.grant?.profileId ||
    active.grant?.contextId !== session.grant?.contextId
  )
    throw Error("Support session changed. Open it again after signing in.");
  if (!response.ok)
    throw Error(
      result.error?.message || "Support could not be loaded. Retry shortly.",
    );
  return result;
}
/** Unread-first ordering must never move the toast cursor backwards. */
export function notificationRefresh(previous: string, notifications: readonly Notification[]) {
  const prior = BigInt(previous);
  let high = prior;
  let latest: Notification | undefined;
  for (const notification of notifications) {
    const id = BigInt(notification.id);
    if (id > high) high = id;
    if (!notification.read_at && id > prior && (!latest || id > BigInt(latest.id))) latest = notification;
  }
  return { seen: high.toString(), latest };
}
type Announcement = {
  id: string;
  notification_id: string;
  title: string;
  body: string;
  published_at: string;
  read_at?: string | null;
};
function isAnnouncement(notification: Notification) {
  return notification.kind === "announcement" &&
    typeof notification.announcement_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notification.announcement_id);
}
/** A feed preview is not a read. Only a loaded, visible detail earns an ACK. */
function AnnouncementDialog({ notification, onClose, onRead }: {
  notification: Notification;
  onClose: () => void;
  onRead: () => void;
}) {
  const [value, setValue] = useState<Announcement | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [read, setRead] = useState(!!notification.read_at);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const reading = useRef(false);
  const attemptedRead = useRef(false);
  const readCallback = useRef(onRead);
  readCallback.current = onRead;
  useEffect(() => {
    live.current = true;
    const panel = dialog.current;
    if (panel && !panel.open) panel.showModal();
    return () => { live.current = false; if (panel?.open) panel.close(); };
  }, []);
  useV21ModalFocus(true, dialog, onClose, "button");
  useEffect(() => {
    let current = true;
    setValue(null);
    setError("");
    void request<{ announcement: Announcement }>("/announcements/" + notification.announcement_id)
      .then(({ announcement }) => {
        if (!current) return;
        if (announcement.id !== notification.announcement_id ||
            announcement.notification_id !== notification.id ||
            typeof announcement.title !== "string" || typeof announcement.body !== "string" ||
            !Number.isFinite(Date.parse(announcement.published_at)))
          throw Error("This announcement could not be verified. Try again.");
        setValue(announcement);
      })
      .catch((e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [notification.announcement_id, notification.id, attempt]);
  async function acknowledge() {
    if (reading.current || !live.current || !dialog.current?.open ||
        document.visibilityState !== "visible" || !body.current?.isConnected ||
        !body.current.getClientRects().length || !value) return;
    reading.current = true;
    attemptedRead.current = true;
    setReadError("");
    try {
      const result = await request<{ ok: boolean }>("/announcements/" + notification.announcement_id + "/read", "POST");
      if (result.ok !== true) throw Error("The read status was not saved. Try again.");
      if (live.current) { setRead(true); readCallback.current(); }
    } catch (e) {
      if (live.current) setReadError((e as Error).message);
    } finally { reading.current = false; }
  }
  useEffect(() => {
    if (!value || read) return;
    let frame = 0;
    const visible = () => {
      if (document.visibilityState !== "visible" || attemptedRead.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (!attemptedRead.current) void acknowledge(); });
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", visible); };
  }, [value, read]);
  return <dialog ref={dialog} className="hub-announcement-dialog" aria-labelledby="atlas-announcement-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><p className="hub-announcement-eyebrow">Atlas announcement</p>
      <h2 id="atlas-announcement-title">{value?.title || "Announcement"}</h2>
      {value && <time dateTime={value.published_at}>{new Date(value.published_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>}
    </div><button type="button" aria-label="Close announcement" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <div className="hub-announcement-content">
      {readError && <div className="hub-announcement-error" role="alert"><p>{readError}</p><button type="button" onClick={() => void acknowledge()}>Retry marking as read</button></div>}
      {error ? <div className="hub-announcement-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>Try again</button></div>
        : value ? <div ref={body} className="hub-announcement-body"><AnnouncementBody text={value.body} /></div>
        : <p role="status">Loading announcement…</p>}
    </div><footer>{value && <span className="hub-announcement-read-status">{read ? "Read" : readError ? "Read status not saved" : "Saving read status…"}</span>}<button type="button" onClick={onClose}>Done</button></footer>
  </dialog>;
}
export function openHubSupport(ticketId?: string) {
  dispatchEvent(
    new CustomEvent("atlas:hub-support-open", { detail: { ticketId } }),
  );
}
/** In-app only. Notifications never advance a conversation's read cursor. */
export function HubSupportPanel({
  active: pageActive,
  pageTarget,
  onOpen,
  legacySupport,
}: {
  active: boolean;
  pageTarget: HTMLElement | null;
  onOpen: () => void;
  legacySupport: ReactNode;
}) {
  const [authenticated, setAuthenticated] = useState(
      !!getHubSession()?.authenticated,
    ),
    [visited, setVisited] = useState(pageActive),
    [activityOpen, setActivityOpen] = useState(false),
    [count, setCount] = useState(0),
    [notifications, setNotifications] = useState<Notification[]>([]),
    [toast, setToast] = useState<Notification | null>(null),
    [announcement, setAnnouncement] = useState<Notification | null>(null),
    [tickets, setTickets] = useState<Ticket[]>([]),
    [selected, setSelected] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [files, setFiles] = useState<File[]>([]),
    [previous, setPrevious] = useState(false);
  const open = pageActive && authenticated;
  const openPage = useRef(onOpen);
  openPage.current = onOpen;
  const account = useRef(getHubSession()?.grant?.userId);
  const drafts = useRef(new Map<string, string>());
  const fileDrafts = useRef(new Map<string, File[]>());
  const filesRef = useRef(files);
  filesRef.current = files;
  const selectedStatus = tickets.find(ticket => ticket.id === selected)?.status;
  useEffect(() => {
    if (selectedStatus) setPrevious(selectedStatus === "closed");
  }, [selected, selectedStatus]);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const heading = useRef<HTMLHeadingElement>(null);
  const seen = useRef("0"),
    conversation = useRef<HTMLDivElement>(null),
    activityTrigger = useRef<HTMLButtonElement>(null),
    activityPanel = useRef<HTMLElement>(null),
    active = useRef({ open, selected });
  active.current = { open, selected };
  const activityAnchor = useAnchoredPopover(activityOpen, activityTrigger);
  useEffect(() => {
    const change = () => {
      const session = getHubSession();
      const value = !!session?.authenticated;
      setAuthenticated(value);
      if (!value || account.current !== session?.grant?.userId) {
        setActivityOpen(false);
        setNotifications([]);
        setCount(0);
        setToast(null);
        setAnnouncement(null);
        setTickets([]);
        setMessages([]);
        setSelected("");
        setSubject("");
        setBody("");
        drafts.current.clear();
        fileDrafts.current.clear();
        setFiles([]);
        setPrevious(false);
        seen.current = "0";
      }
      account.current = session?.grant?.userId;
    };
    addEventListener("atlas:hub-session", change);
    return () => removeEventListener("atlas:hub-session", change);
  }, []);
  function selectTicket(ticket: string) {
    drafts.current.set(selectedRef.current, bodyRef.current);
    fileDrafts.current.set(selectedRef.current, filesRef.current);
    setFiles(fileDrafts.current.get(ticket) || []);
    if (!ticket) setPrevious(false);
    setSelected(ticket);
    setBody(drafts.current.get(ticket) || "");
    setError("");
  }
  function show(ticket?: string) {
    setAnnouncement(null);
    if (ticket !== undefined) selectTicket(ticket);
    setActivityOpen(false);
    setToast(null);
    openPage.current();
  }
  function closeAnnouncement() {
    setAnnouncement(null);
    requestAnimationFrame(() => activityTrigger.current?.focus());
  }
  function openNotification(notification: Notification) {
    if (!isAnnouncement(notification)) { show(notification.ticket_id || undefined); return; }
    setActivityOpen(false);
    setToast(null);
    setAnnouncement(notification);
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const id = (event as CustomEvent).detail?.ticketId;
      show(
        typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : undefined,
      );
    };
    addEventListener("atlas:hub-support-open", listener);
    return () => removeEventListener("atlas:hub-support-open", listener);
  }, []);
  useEffect(() => {
    if (!pageActive) return;
    setVisited(true);
    setToast(null);
    setActivityOpen(false);
    const id = requestAnimationFrame(() =>
      heading.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(id);
  }, [pageActive]);
  useEffect(() => {
    if (!activityOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !activityPanel.current?.contains(target) &&
        !activityTrigger.current?.contains(target)
      )
        setActivityOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActivityOpen(false);
        activityTrigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [activityOpen]);
  async function refresh() {
    const value = await request<{
      notifications: Notification[];
      unread: number;
    }>("/notifications");
    setCount(value.unread);
    setNotifications(value.notifications);
    const update = notificationRefresh(seen.current, value.notifications);
    if (update.latest) setToast(update.latest);
    seen.current = update.seen;
  }
  useEffect(() => {
    if (!authenticated) return;
    let live = true,
      pending = false;
    async function poll() {
      if (!live || pending) return;
      pending = true;
      try {
        await refresh();
      } catch {
      } finally {
        pending = false;
      }
    }
    const deepLink =
      location.pathname === "/support"
        ? new URLSearchParams(location.hash.slice(1)).get("ticket")
        : null;
    const capability = deepLink?.match(/^([a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/);
    if (capability)
      void request<{ ticketId: string }>("/legacy-tickets/claim", "POST", {
        source: "atlas",
        id: capability[1],
        token: capability[2],
      })
        .then((value) => {
          if (live) {
            selectTicket(value.ticketId);
            openPage.current();
            history.replaceState(null, "", location.pathname + location.search);
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    // A legacy ticket is claimed only through its existing bearer capability.
    try {
      const legacy = JSON.parse(localStorage.getItem("atlas.tickets") || "[]");
      if (Array.isArray(legacy))
        void Promise.all(
          legacy
            .slice(0, 100)
            .filter(
              (v) => typeof v?.id === "string" && typeof v?.token === "string",
            )
            .map((v) =>
              request("/legacy-tickets/claim", "POST", {
                source: "atlas",
                id: v.id,
                token: v.token,
              }).catch(() => undefined),
            ),
        ).then(() => {
          if (live) void poll();
        });
    } catch {}
    void poll();
    let stream: EventSource | undefined,
      identity = "";
    const openStream = () => {
      const s = getHubSession(),
        next = s?.authenticated
          ? [s.grant?.userId, s.grant?.sessionId, s.grant?.contextId].join(":")
          : "";
      if (
        typeof EventSource !== "undefined" &&
        next === identity &&
        stream &&
        stream.readyState !== EventSource.CLOSED
      )
        return;
      stream?.close();
      identity = next;
      if (!next || typeof EventSource === "undefined") return;
      stream = new EventSource("/api/hub/support/events", {
        withCredentials: true,
      });
      const currentStream = stream;
      const invalidation = () => {
        const current = getHubSession();
        if (
          !live ||
          [
            current?.grant?.userId,
            current?.grant?.sessionId,
            current?.grant?.contextId,
          ].join(":") !== identity
        )
          return;
        void poll();
        dispatchEvent(new Event("atlas:hub-support-changed"));
      };
      stream.addEventListener("ready", invalidation);
      stream.addEventListener("support", invalidation);
      stream.addEventListener("error", () => void poll());
      stream.addEventListener("authorization", () => {
        currentStream.close();
        void poll();
      });
    };
    openStream();
    addEventListener("atlas:hub-session", openStream);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 15000);
    const resume = (event: Event) => {
      if (event.type === "online") {
        stream?.close();
        stream = undefined;
        openStream();
      }
      if (document.visibilityState === "visible") void poll();
    };
    addEventListener("online", resume);
    addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      clearInterval(timer);
      stream?.close();
      removeEventListener("atlas:hub-session", openStream);
      removeEventListener("online", resume);
      removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [authenticated]);
  useEffect(() => {
    if (!open || !authenticated) return;
    let live = true;
    const load = () =>
      void request<{ tickets: Ticket[] }>("/tickets")
        .then((r) => {
          if (live) setTickets(r.tickets);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    addEventListener("atlas:hub-support-changed", load);
    return () => {
      live = false;
      removeEventListener("atlas:hub-support-changed", load);
    };
  }, [open, authenticated, selected]);
  useEffect(() => {
    setMessages([]);
    if (!open || !selected || !authenticated) return;
    let live = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await request<{ messages: Message[] }>(
          "/tickets/" + selected,
        );
        if (live) setMessages(value.messages);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        pending = false;
      }
    };
    void load();
    addEventListener("atlas:hub-support-changed", load);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      live = false;
      clearInterval(timer);
      removeEventListener("atlas:hub-support-changed", load);
    };
  }, [open, selected, authenticated]);
  useEffect(() => {
    if (!open || !selected || !messages.length || announcement) return;
    const id = requestAnimationFrame(() => {
      if (
        document.visibilityState !== "visible" ||
        !conversation.current?.isConnected ||
        !active.current.open ||
        active.current.selected !== selected
      )
        return;
      void request("/tickets/" + selected + "/read", "POST", {
        messageId: messages.at(-1)!.id,
      })
        .then(() => {
          setTickets((old) =>
            old.map((ticket) =>
              ticket.id === selected ? { ...ticket, unread: 0 } : ticket,
            ),
          );
          return refresh();
        })
        .catch(() => {});
    });
    return () => cancelAnimationFrame(id);
  }, [open, selected, messages, announcement]);
  async function submit() {
    if (busy) return;
    const submitted = {
      ticket: selected,
      body,
      subject,
      account: account.current,
      files,
    };
    setBusy(true);
    setError("");
    try {
      const attachments = await encodeSupportFiles(submitted.files);
      if (account.current !== submitted.account) return;
      if (submitted.ticket) {
        const value = await request<{ message: Message }>(
          "/tickets/" + submitted.ticket + "/messages",
          "POST",
          { body: submitted.body, attachments },
        );
        if (account.current !== submitted.account) return;
        if (selectedRef.current === submitted.ticket)
          setMessages((old) => [...old, value.message]);
      } else {
        const value = await request<{ ticket: Ticket }>("/tickets", "POST", {
          subject: submitted.subject,
          body: submitted.body,
          category: "Other",
          attachments,
        });
        if (account.current !== submitted.account) return;
        if (selectedRef.current === "") setSelected(value.ticket.id);
        if (subjectRef.current === submitted.subject) setSubject("");
      }
      if (fileDrafts.current.get(submitted.ticket) === submitted.files)
        fileDrafts.current.delete(submitted.ticket);
      if (selectedRef.current === submitted.ticket && filesRef.current === submitted.files)
        setFiles([]);
      if (selectedRef.current === submitted.ticket) setPrevious(false);
      if (drafts.current.get(submitted.ticket) === submitted.body)
        drafts.current.delete(submitted.ticket);
      if (
        selectedRef.current === submitted.ticket &&
        bodyRef.current === submitted.body
      )
        setBody("");
      dispatchEvent(new Event("atlas:hub-support-changed"));
    } catch (e) {
      if (
        account.current === submitted.account &&
        selectedRef.current === submitted.ticket
      )
        setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {authenticated && (
        <button
          ref={activityTrigger}
          className="hub-support-trigger"
          aria-label={
            count ? `Notifications, ${count} unread` : "Notifications"
          }
          aria-expanded={activityOpen}
          aria-controls="atlas-notifications"
          aria-haspopup="dialog"
          onClick={() => setActivityOpen((value) => !value)}
        >
          <span className="hub-notification-icon" aria-hidden="true">
            <Bell size={17} />
            {count > 0 && <span className="hub-notification-badge">{count > 99 ? "99+" : count}</span>}
          </span>
        </button>
      )}
      {authenticated && activityOpen && (
        <aside
          ref={activityPanel}
          id="atlas-notifications"
          className="hub-notifications"
          style={activityAnchor}
          role="dialog"
          aria-label="Notifications"
        >
          <header>
            <div><h2>Notifications</h2><small className="hub-notifications-order">Unread first</small></div>
            <button
              aria-label="Close notifications"
              onClick={() => {
                setActivityOpen(false);
                activityTrigger.current?.focus();
              }}
            >
              <X size={18} />
            </button>
          </header>
          {notifications.length ? (
            notifications.map((notification) => (
              <button
                className="notification-item"
                key={notification.id}
                onClick={() => openNotification(notification)}
              >
                <span
                  className={
                    "notification-dot" +
                    (notification.read_at ? " notification-read" : "")
                  }
                  aria-hidden="true"
                />
                <span>
                  {notification.subject}
                  <small>
                    {isAnnouncement(notification) ? (notification.read_at ? "Read announcement" : "Unread announcement") : (notification.read_at ? "Read reply" : "Unread reply")}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p>No new notifications.</p>
          )}
          <button onClick={() => show()}>Open support</button>
        </aside>
      )}
      {authenticated && toast && !open && !announcement && (
        <div className="hub-support-toast" role="status">
          {isAnnouncement(toast) ? "New announcement: " : "Atlas support replied: "}{toast.subject}
          <button onClick={() => openNotification(toast)}>{isAnnouncement(toast) ? "Read announcement" : "Read reply"}</button>
          <button
            aria-label={isAnnouncement(toast) ? "Dismiss announcement notification" : "Dismiss support notification"}
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {authenticated && announcement && <AnnouncementDialog key={announcement.id} notification={announcement}
        onClose={closeAnnouncement} onRead={() => { void refresh().catch(() => {}); }} />}
      {pageTarget &&
        visited &&
        createPortal(
          authenticated ? (
            <section
              className="page hub-support-page"
              aria-labelledby="atlas-support-heading"
            >
              <div className="page-heading">
                <div>
                  <h1 id="atlas-support-heading" ref={heading} tabIndex={-1}>
                    Support
                  </h1>
                  <p>Report an issue or send feedback.</p>
                </div>
              </div>
              <div className="hub-support-panel">
                {error && <p role="alert">{error}</p>}
                <div className="hub-support-columns">
                  <nav aria-label="Support conversations">
                    <button
                      onClick={() => selectTicket("")}
                      aria-pressed={!selected}
                    >
                      New ticket
                    </button>
                    <div className="support-ticket-sections" aria-label="Ticket sections">
                      <button type="button" aria-pressed={!previous} onClick={() => setPrevious(false)}>Active tickets</button>
                      <button type="button" aria-pressed={previous} onClick={() => setPrevious(true)}>Previous tickets</button>
                    </div>
                    {!tickets.some(t => (t.status === "closed") === previous) && <p className="muted">{previous ? "No previous tickets." : "No active tickets."}</p>}
                    {tickets.filter(t => (t.status === "closed") === previous).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => selectTicket(t.id)}
                        aria-pressed={selected === t.id}
                      >
                        {t.subject}
                        {t.unread > 0 && ` · ${t.unread} unread`}
                      </button>
                    ))}
                  </nav>
                  <div className="hub-support-conversation" ref={conversation}>
                    {selected ? (
                      <div className="hub-support-messages">
                        {messages.map((m) => (
                          <article key={m.id}>
                            <strong>
                              {m.author === "admin" ? "Atlas support" : "You"}
                            </strong>
                            <p>{m.body}</p>
                            <SupportMediaList key={selected + ":" + m.id} active={open && !announcement} attachments={m.attachments} load={(id) => request<SupportMediaResult>("/tickets/" + selected + "/attachments/" + id)} />
                          </article>
                        ))}
                      </div>
                    ) : (
                      <label>
                        Subject
                        <input
                          maxLength={120}
                          value={subject}
                          onChange={(e) => setSubject(e.target.value)}
                        />
                      </label>
                    )}
                    {selectedStatus === "closed" && <p className="muted">This ticket is closed. Sending a reply will reopen it.</p>}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                      }}
                    >
                      <label>
                        {selected ? "Your reply" : "Message"}
                        <textarea
                          maxLength={5000}
                          required
                          minLength={5}
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                        />
                      </label>
                      <SupportMediaPicker files={files} onChange={setFiles} disabled={busy} />
                      <button
                        disabled={
                          busy ||
                          !body.trim() ||
                          (!selected && subject.trim().length < 3)
                        }
                      >
                        {busy
                          ? "Sending…"
                          : selected
                            ? "Send reply"
                            : "Create ticket"}
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            </section>
          ) : (
            legacySupport
          ),
          pageTarget,
        )}
    </>
  );
}
