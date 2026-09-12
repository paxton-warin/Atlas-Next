import { useEffect, useState } from "react";
import {
  ShieldCheck,
  ArrowLeft,
  LogOut,
  Inbox,
  Grid2X2,
  Activity,
  Settings2,
  ArrowUpRight,
  Send,
  Check,
  Plus,
} from "lucide-react";
import NodeSettings from "./NodeSettings";
import AiProviderSettings from "./AiProviderSettings";
import { api, type Game } from "./model";
export default function Admin() {
  const [initialized, setInitialized] = useState<boolean | null>(null),
    [csrf, setCsrf] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [setupToken, setSetupToken] = useState(""),
    [enroll, setEnroll] = useState<any>(null),
    [recovery, setRecovery] = useState<string[]>([]),
    [section, setSection] = useState("Tickets");
  const [tickets, setTickets] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [body, setBody] = useState(""),
    [overview, setOverview] = useState<any>(null),
    [games, setGames] = useState<Game[]>([]),
    [edit, setEdit] = useState<any>(null),
    [name, setName] = useState("Atlas");
  const adminApi = (path: string, options: RequestInit = {}) =>
    api("/admin" + path, {
      ...options,
      headers: { ...options.headers, "x-atlas-csrf": csrf },
    });
  useEffect(() => {
    api("/admin/access", {
      method: "POST",
      body: JSON.stringify({ path: location.pathname }),
    })
      .then((v) => setInitialized(v.initialized))
      .catch((e) => setError(e.message));
    api("/admin/state")
      .then((v) => setCsrf(v.csrf))
      .catch(() => {});
  }, []);
  async function refresh() {
    if (!csrf) return;
    try {
      const [t, o, g] = await Promise.all([
        adminApi("/tickets"),
        adminApi("/overview"),
        adminApi("/catalog"),
      ]);
      setTickets(t);
      setOverview(o);
      setName(o.name);
      setGames(g);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, [csrf]);
  async function authenticate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (initialized) {
        const result = await api("/admin/login", {
          method: "POST",
          body: JSON.stringify({ password, code }),
        });
        setCsrf(result.csrf);
        setPassword("");
        setCode("");
      } else if (enroll) {
        const result = await api("/admin/complete", {
          method: "POST",
          body: JSON.stringify({ challenge: enroll.challenge, code }),
        });
        setRecovery(result.recovery);
        setCsrf(result.csrf);
        setPassword("");
        setCode("");
        setEnroll(null);
        setInitialized(true);
      } else
        setEnroll(
          await api("/admin/enroll", {
            method: "POST",
            body: JSON.stringify({ token: setupToken, password }),
          }),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openTicket(id: string) {
    try {
      setSelected(await adminApi("/tickets/" + id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <a href="/" className="brand">
          <span className="brand-mark">A</span>Atlas
          <span className="badge">Control room</span>
        </a>
        {csrf && (
          <button
            className="button"
            onClick={() =>
              void action(async () => {
                await adminApi("/logout", { method: "POST" });
                setCsrf("");
                setTickets([]);
                setSelected(null);
                setOverview(null);
                setGames([]);
                setRecovery([]);
              })
            }
          >
            <LogOut size={16} />
            Lock panel
          </button>
        )}
      </header>
      {!csrf ? (
        <main className="auth-card">
          <div className="empty-icon">
            <ShieldCheck size={30} />
          </div>
          <span className="eyebrow">ADMIN</span>
          <h1>{initialized ? "Welcome back." : "Administrator setup"}</h1>
          <p>
            {initialized
              ? "Verify with your password and authenticator."
              : "Set up the one administrator for this Atlas."}
          </p>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          {initialized !== null && (
            <form onSubmit={authenticate}>
              {!initialized && !enroll && (
                <label className="form-field">
                  One-time setup token
                  <input
                    required
                    type="password"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    autoComplete="off"
                  />
                  <small>
                    Generate it on your server with{" "}
                    <code>pnpm admin:token</code>.
                  </small>
                </label>
              )}
              {!enroll && (
                <label className="form-field">
                  Administrator password
                  <input
                    type="password"
                    required
                    minLength={initialized ? 1 : 12}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={
                      initialized ? "current-password" : "new-password"
                    }
                  />
                </label>
              )}
              {enroll && (
                <>
                  <img
                    className="qr"
                    src={enroll.qr}
                    alt="Scan this QR code in your authenticator"
                  />
                  <label className="form-field">
                    Or enter this authenticator key
                    <code className="secret-key">{enroll.secret}</code>
                  </label>
                </>
              )}
              {(initialized || enroll) && (
                <label className="form-field">
                  Authenticator or recovery code
                  <input
                    required
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.trim())}
                  />
                </label>
              )}
              <button className="button primary wide" disabled={busy}>
                {busy
                  ? "Verifying…"
                  : initialized
                    ? "Unlock control room"
                    : enroll
                      ? "Finish setup"
                      : "Set up authenticator"}
                <ArrowUpRight size={17} />
              </button>
            </form>
          )}
          <a className="back-link" href="/">
            <ArrowLeft size={14} />
            Back to Atlas
          </a>
        </main>
      ) : (
        <div className="admin-body">
          <nav className="admin-nav">
            {[
              ["Tickets", Inbox],
              ["Catalog", Grid2X2],
              ["Site settings", Settings2],
              ["AI provider", Settings2],
              ["Browsing nodes", Activity],
              ["Health & audit", Activity],
            ].map(([s, Icon]: any) => (
              <button
                key={s}
                className={section === s ? "selected" : ""}
                onClick={() => {
                  setSection(s);
                  setSelected(null);
                  setEdit(null);
                }}
              >
                <Icon size={18} />
                {s}
              </button>
            ))}
          </nav>
          <main className="admin-main">
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            {recovery.length > 0 && (
              <section className="setting-card">
                <h2>Save your recovery codes</h2>
                <p>
                  Each code works once, together with your password. Store them
                  somewhere private.
                </p>
                <pre>{recovery.join("\n")}</pre>
                <button className="button" onClick={() => setRecovery([])}>
                  <Check size={16} />
                  I've saved them
                </button>
              </section>
            )}
            <div className="page-heading">
              <div>
                <span className="eyebrow">ATLAS CONTROL ROOM</span>
                <h1>{section}</h1>
              </div>
              <span className="badge">
                <ShieldCheck size={13} />
                Verified
              </span>
            </div>
            {section === "Tickets" &&
              (selected ? (
                <section className="setting-card">
                  <button className="button" onClick={() => setSelected(null)}>
                    <ArrowLeft size={15} />
                    All tickets
                  </button>
                  <h2>{selected.subject}</h2>
                  <span className="badge">{selected.status}</span>
                  <div className="messages">
                    {selected.messages.map((m: any, i: number) => (
                      <article className={"message " + m.author} key={i}>
                        <header>
                          {m.author}
                          <time>{new Date(m.created).toLocaleString()}</time>
                        </header>
                        <p>{m.body}</p>
                      </article>
                    ))}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        await adminApi(
                          "/tickets/" + selected.id + "/messages",
                          { method: "POST", body: JSON.stringify({ body }) },
                        );
                        setBody("");
                        await openTicket(selected.id);
                      });
                    }}
                  >
                    <label className="form-field">
                      Reply
                      <textarea
                        required
                        rows={4}
                        maxLength={5000}
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                      />
                    </label>
                    <div className="button-row">
                      <button className="button primary" disabled={busy}>
                        <Send size={15} />
                        Send reply
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await adminApi("/tickets/" + selected.id, {
                              method: "PATCH",
                              body: JSON.stringify({
                                status:
                                  selected.status === "closed"
                                    ? "open"
                                    : "closed",
                              }),
                            });
                            await openTicket(selected.id);
                          })
                        }
                      >
                        {selected.status === "closed"
                          ? "Reopen"
                          : "Close ticket"}
                      </button>
                    </div>
                  </form>
                </section>
              ) : (
                <>
                  <div className="stat-grid">
                    {[
                      ["Open conversations", overview?.open ?? 0],
                      ["Total tickets", overview?.tickets ?? 0],
                      ["Available games", overview?.catalog ?? 0],
                    ].map(([label, value]) => (
                      <div className="setting-card" key={label}>
                        <p>{label}</p>
                        <strong className="stat-value">{value}</strong>
                      </div>
                    ))}
                  </div>
                  <section className="setting-card">
                    {tickets.length ? (
                      tickets.map((t) => (
                        <button
                          className="ticket-row"
                          key={t.id}
                          onClick={() => void openTicket(t.id)}
                        >
                          <MessageIcon />
                          <span>
                            <strong>{t.subject}</strong>
                            <small>
                              {t.category} ·{" "}
                              {new Date(t.updated).toLocaleDateString()}
                            </small>
                          </span>
                          <span className="badge">
                            {t.status.replaceAll("_", " ")}
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      ))
                    ) : (
                      <div className="empty-state">
                        <Inbox size={34} />
                        <h2>No tickets</h2>
                        <p>New support tickets appear in this inbox.</p>
                      </div>
                    )}
                  </section>
                </>
              ))}
            {section === "Catalog" && (
              <>
                <button
                  className="button primary"
                  onClick={() =>
                    setEdit({
                      id: crypto.randomUUID(),
                      name: "",
                      description: "",
                      url: "",
                      category: "Arcade",
                      artwork: "hex",
                      enabled: true,
                    })
                  }
                >
                  <Plus size={16} />
                  Add a game
                </button>
                {edit && (
                  <form
                    className="setting-card"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        await adminApi("/catalog/" + edit.id, {
                          method: "PUT",
                          body: JSON.stringify(edit),
                        });
                        setEdit(null);
                      });
                    }}
                  >
                    <h2>{edit.name || "New game"}</h2>
                    {["name", "description", "url", "category"].map((k) => (
                      <label className="form-field" key={k}>
                        {k}
                        <input
                          required
                          value={edit[k]}
                          onChange={(e) =>
                            setEdit({ ...edit, [k]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                    <label className="form-field">
                      Artwork
                      <select
                        value={edit.artwork}
                        onChange={(e) =>
                          setEdit({ ...edit, artwork: e.target.value })
                        }
                      >
                        {[
                          "numbers",
                          "snake",
                          "tic",
                          "hex",
                          "alchemy",
                          "chess",
                        ].map((a) => (
                          <option key={a}>{a}</option>
                        ))}
                      </select>
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={edit.enabled}
                        onChange={(e) =>
                          setEdit({ ...edit, enabled: e.target.checked })
                        }
                      />
                      Visible in catalog
                    </label>
                    <button className="button primary" disabled={busy}>
                      Save game
                    </button>
                  </form>
                )}
                <section className="setting-card">
                  {games.map((g) => (
                    <button
                      className="ticket-row"
                      key={g.id}
                      onClick={() => setEdit({ ...g, enabled: !!g.enabled })}
                    >
                      <Grid2X2 size={19} />
                      <span>
                        <strong>{g.name}</strong>
                        <small>
                          {g.category} · {g.enabled ? "Visible" : "Hidden"}
                        </small>
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </section>
              </>
            )}
            {section === "Site settings" && (
              <form
                className="setting-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    await adminApi("/settings", {
                      method: "PUT",
                      body: JSON.stringify({ name }),
                    });
                  });
                }}
              >
                <h2>The essentials</h2>
                <label className="form-field">
                  Site name
                  <input
                    required
                    maxLength={40}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p>
                  Hostnames and the administrator path are configured on the
                  server. Public users never receive administrator credentials.
                </p>
                <button className="button primary" disabled={busy}>
                  Save changes
                </button>
              </form>
            )}
            {section === "AI provider" && <AiProviderSettings csrf={csrf} />}
            {section === "Browsing nodes" && <NodeSettings csrf={csrf} />}
            {section === "Health & audit" && (
              <>
                <section className="setting-card">
                  <h2>Pinned browsing runtime</h2>
                  <p>
                    Built from Scramjet's official demo source. Site
                    compatibility needs workflow testing.
                  </p>
                  <dl>
                    <dt>Source revision</dt>
                    <dd>
                      <code>{overview?.runtime.commit}</code>
                    </dd>
                    <dt>Scramjet / controller</dt>
                    <dd>
                      {overview?.runtime.core} / {overview?.runtime.controller}
                    </dd>
                    <dt>Ultraviolet</dt>
                    <dd>{overview?.runtime.ultraviolet}</dd>
                  </dl>
                  <p className="small muted">
                    Chromebook, Google authentication, ChatGPT authentication
                    and Spotify playback: awaiting real-device verification.
                  </p>
                </section>
                <section className="setting-card">
                  <h2>Recent activity</h2>
                  {overview?.audit.map((a: any) => (
                    <div className="audit-row" key={a.id}>
                      <span>{a.action}</span>
                      <small>{new Date(a.created).toLocaleString()}</small>
                    </div>
                  ))}
                </section>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
function MessageIcon() {
  return <Inbox size={19} />;
}
