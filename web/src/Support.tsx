import { useEffect, useState } from "react";
import { Copy, MessageSquare, Plus, Send } from "lucide-react";
import { api, readLocal, writeLocal } from "./model";
type Access = { id: string; token: string; subject?: string };
export default function Support({ toast }: { toast: (s: string) => void }) {
  const [saved, setSaved] = useState<Access[]>(() =>
    readLocal("atlas.tickets", []),
  );
  const [access, setAccess] = useState<Access | null>(null);
  const [ticket, setTicket] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(() => saved.length === 0);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    subject: "",
    category: "Browsing",
    body: "",
    website: "",
  });
  function remember(value: Access) {
    setSaved((old) => {
      const next = [value, ...old.filter((t) => t.id !== value.id)];
      writeLocal("atlas.tickets", next);
      return next;
    });
    setAccess(value);
  }
  useEffect(() => {
    const match = location.hash.match(
      /^#ticket=([a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/,
    );
    if (match) {
      setCreating(false);
      remember({ id: match[1], token: match[2] });
      history.replaceState(null, "", "/support");
    }
  }, []);
  async function refresh(a = access) {
    if (!a) return;
    try {
      setTicket(
        await api("/tickets/" + a.id, {
          headers: { Authorization: "Bearer " + a.token },
        }),
      );
    } catch (e) {
      toast((e as Error).message);
    }
  }
  useEffect(() => {
    setTicket(null);
    void refresh();
    if (!access) return;
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [access?.id]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await api<Access>("/tickets", {
        method: "POST",
        body: JSON.stringify(form),
      });
      remember({ ...result, subject: form.subject });
      setCreating(false);
      setForm({ subject: "", category: "Browsing", body: "", website: "" });
      toast("Ticket created. Save the link to access it later.");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reply(e: React.FormEvent) {
    e.preventDefault();
    if (!access) return;
    setBusy(true);
    try {
      await api("/tickets/" + access.id + "/messages", {
        method: "POST",
        headers: { Authorization: "Bearer " + access.token },
        body: JSON.stringify({ body: message }),
      });
      setMessage("");
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page support-page">
      <div className="page-heading">
        <div>
          <h1>Support</h1>
          <p>Report an issue or send feedback.</p>
        </div>
      </div>
      <div className="support-layout">
        <aside className="ticket-list">
          <button
            className="button primary"
            onClick={() => {
              setCreating(true);
              setAccess(null);
            }}
          >
            <Plus size={17} />
            New ticket
          </button>
          <span className="ticket-list-heading">Your tickets</span>
          {saved.map((t) => (
            <button
              key={t.id}
              className={access?.id === t.id ? "selected" : ""}
              onClick={() => {
                setAccess(t);
                setCreating(false);
              }}
            >
              <MessageSquare size={17} />
              <span>
                {t.subject || "Support ticket"}
                <small>#{t.id.slice(0, 6).toUpperCase()}</small>
              </span>
            </button>
          ))}
          {!saved.length && <p className="muted">No tickets yet.</p>}
        </aside>
        <section className="setting-card ticket-body">
          {creating ? (
            <form onSubmit={create}>
              <h2>New ticket</h2>
              <p>
                Describe the issue or feedback. Include steps to reproduce a
                problem.
              </p>
              <label className="form-field">
                Category
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                >
                  {["Browsing", "Games", "Suggestion", "Other"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                Subject
                <input
                  required
                  minLength={3}
                  maxLength={120}
                  value={form.subject}
                  onChange={(e) =>
                    setForm({ ...form, subject: e.target.value })
                  }
                  placeholder="Brief summary"
                />
              </label>
              <label className="form-field">
                Message
                <textarea
                  required
                  minLength={10}
                  maxLength={5000}
                  rows={5}
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  placeholder="Describe the issue and how to reproduce it."
                />
              </label>
              <label className="honeypot" aria-hidden="true">
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={(e) =>
                    setForm({ ...form, website: e.target.value })
                  }
                />
              </label>
              <p className="small muted">
                Leave out passwords, login codes, and private browsing links.
              </p>
              <button className="button primary" disabled={busy}>
                <Send size={15} />
                {busy ? "Creating…" : "Create ticket"}
              </button>
            </form>
          ) : ticket && access ? (
            <>
              <div className="section-title">
                <h2>{ticket.subject}</h2>
                <span className="badge">
                  {ticket.status.replaceAll("_", " ")}
                </span>
              </div>
              <p className="small muted">Ticket #{access.id.toUpperCase()}</p>
              <button
                className="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      location.origin +
                        "/support#ticket=" +
                        access.id +
                        "." +
                        access.token,
                    );
                    toast("Private ticket link copied.");
                  } catch {
                    toast("Clipboard access was not granted.");
                  }
                }}
              >
                <Copy size={15} />
                Copy private link
              </button>
              <div className="messages">
                {ticket.messages.map((m: any, i: number) => (
                  <article className={"message " + m.author} key={i}>
                    <header>
                      {m.author === "admin" ? "Atlas support" : "You"}
                      <time>{new Date(m.created).toLocaleString()}</time>
                    </header>
                    <p>{m.body}</p>
                  </article>
                ))}
              </div>
              <form onSubmit={reply}>
                <label className="form-field">
                  Your reply
                  <textarea
                    required
                    maxLength={5000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={3}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={busy || !message.trim()}
                >
                  <Send size={15} />
                  Send reply
                </button>
              </form>
            </>
          ) : access ? (
            <div className="empty-state">Loading ticket…</div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <MessageSquare size={32} />
              </div>
              <h2>Select a ticket</h2>
              <p>Choose a ticket to view replies, or create a new one.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
