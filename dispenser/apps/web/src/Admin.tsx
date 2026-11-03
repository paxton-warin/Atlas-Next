import { HubProfileLimits } from "./HubProfileLimits";
import { EntryLaunchLinkSettings } from "./EntryLaunchLink";
import { HubDocumentResource } from "./HubDocumentResource";
import { AtlasBrandMark } from "./AtlasBrandMark";
import { HubAtlasControls } from "./HubAtlasControls";
import { AdminAnnouncements } from "./HubAnnouncements";
import { HubSupport } from "./HubSupport";
import { HubMetrics } from "./HubMetrics";
import { CloudConfigurator } from "./CloudConfigurator";
import { collectEmails, deleteSnapshot } from "./bulkTools";
import { CheckMailAdmin } from "./CheckMailAdmin";
import {
  KnownEmailAdmin,
  ManualVerificationAdmin,
  VerificationRequestDetails,
} from "./ManualVerificationAdmin";
import {
  Activity,
  Boxes,
  Check,
  ClipboardList,
  ExternalLink,
  FileCheck2,
  Gauge,
  LayoutDashboard,
  Menu,
  ChevronRight,
  Link2,
  ListChecks,
  LogOut,
  MailCheck,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  EmailRuleInput,
  LinkInput,
  PublicUser,
  ManualVerificationState,
} from "@atlas-link-dispenser/shared";
import { api, del, post, put } from "./api";
import {
  describeLinkCheck,
  describeLinkCheckError,
  LinkCheckNotices,
  type LinkCheckFeedback,
  type LinkCheckResult,
} from "./linkHealth";
import { Pagination, useData, usePagedData } from "./pagination";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  Field,
  Input,
  Loading,
  Notice,
  PageHeader,
  Select,
  Textarea,
} from "./ui";

type Section =
  | "infrastructure"
  | "support"
  | "announcements"
  | "overview"
  | "links"
  | "users"
  | "rules"
  | "check-mail"
  | "verification"
  | "manual-verification"
  | "reports"
  | "settings"
  | "audit";
const nav: Array<{ id: Section; label: string; icon: ReactNode }> = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard /> },
  { id: "users", label: "Users", icon: <Users /> },
  { id: "links", label: "Access", icon: <Link2 /> },
  { id: "infrastructure", label: "Infrastructure", icon: <Activity /> },
  { id: "support", label: "Support", icon: <ClipboardList /> },
  { id: "settings", label: "Settings", icon: <Settings /> },
];
export function adminGroup(section: Section): Section {
  return ["verification", "manual-verification"].includes(section)
    ? "users"
    : ["reports", "announcements"].includes(section)
      ? "support"
      : ["rules", "check-mail", "audit"].includes(section)
        ? "settings"
        : section;
}
type AdminPanel = Section | "storage" | "directories" | "denied" | "services" | "cloud";
const adminPanels: Array<{ id: AdminPanel; section: Section; label: string }> = [
  { id: "overview", section: "overview", label: "Overview" },
  { id: "users", section: "users", label: "Accounts" },
  { id: "manual-verification", section: "manual-verification", label: "Manual verification" },
  { id: "verification", section: "verification", label: "Email verification" },
  { id: "links", section: "links", label: "Browser links" },
  { id: "infrastructure", section: "infrastructure", label: "Monitoring" },
  { id: "services", section: "infrastructure", label: "Browser services" },
  { id: "cloud", section: "infrastructure", label: "Cloud operations" },
  { id: "support", section: "support", label: "Conversations" },
  { id: "announcements", section: "announcements", label: "Announcements" },
  { id: "reports", section: "reports", label: "Link reports" },
  { id: "settings", section: "settings", label: "General" },
  { id: "storage", section: "settings", label: "Browser storage" },
  { id: "rules", section: "rules", label: "Email rules" },
  { id: "directories", section: "rules", label: "Known directories" },
  { id: "denied", section: "rules", label: "Denied attempts" },
  { id: "check-mail", section: "check-mail", label: "Check-Mail" },
  { id: "audit", section: "audit", label: "Audit log" },
];
export function adminDestination(search: string): AdminPanel {
  const params = new URLSearchParams(search);
  const section = params.get("admin") || "overview";
  const view = params.get("view");
  return adminPanels.find((p) => p.id === view && p.section === section)?.id
    ?? adminPanels.find((p) => p.id === section)?.id ?? "overview";
}
export function adminPanelURL(id: AdminPanel) {
  const panel = adminPanels.find((p) => p.id === id)!;
  return `/?admin=${panel.section}${panel.id === panel.section ? "" : `&view=${panel.id}`}`;
}
export async function signOutHub(onLogout: () => void, request: () => Promise<unknown> = () => post("/logout")) {
  await request();
  onLogout();
}
export function Admin({ user, onLogout, onExit }: {
  user: PublicUser; onLogout: () => void; onExit: () => void;
}) {
  const [panel, setPanel] = useState<AdminPanel>(() => adminDestination(location.search));
  const [visited, setVisited] = useState<AdminPanel[]>([panel]);
  const [remembered, setRemembered] = useState<Partial<Record<Section, AdminPanel>>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const [signingOut, setSigningOut] = useState(false), [logoutError, setLogoutError] = useState("");
  const logout = async () => {
    setSigningOut(true); setLogoutError("");
    try { await signOutHub(onLogout); }
    catch (failure) { setLogoutError(failure instanceof Error ? failure.message : "Could not sign out."); }
    finally { setSigningOut(false); }
  };
  const active = adminPanels.find((p) => p.id === panel)!;
  const group = adminGroup(active.section);
  const groupLabel = nav.find((n) => n.id === group)!.label;
  const select = (next: AdminPanel, fromHistory = false) => {
    setPanel(next);
    setVisited((current) => current.includes(next) ? current : [...current, next]);
    const item = adminPanels.find((p) => p.id === next)!;
    setRemembered((current) => ({ ...current, [adminGroup(item.section)]: next }));
    setMobileOpen(false);
    if (!fromHistory) history.replaceState(null, "", adminPanelURL(next));
  };
  useEffect(() => {
    const navigate = () => select(adminDestination(location.search), true);
    addEventListener("popstate", navigate);
    return () => removeEventListener("popstate", navigate);
  }, []);
  const renderPanel = (id: AdminPanel) => {
    switch (id) {
      case "overview": return <><Overview /><HubMetrics compact active={panel === id} /></>;
      case "users": return <UserAdmin />;
      case "manual-verification": return <ManualVerificationAdmin />;
      case "verification": return <Verification />;
      case "links": return <Links />;
      case "infrastructure": return <HubMetrics active={panel === id} />;
      case "services": return <HubAtlasControls />;
      case "cloud": return <CloudConfigurator active={panel === id} />;
      case "support": return <HubSupport admin active={panel === id} />;
      case "announcements": return <AdminAnnouncements active={panel === id} />;
      case "reports": return <Reports />;
      case "settings": return <SettingsAdmin showStorage={false} />;
      case "storage": return <><PageHeader title="Browser storage" description="Account backup and per-website storage allowances." /><HubProfileLimits /></>;
      case "rules": return <Rules includeRelated={false} />;
      case "directories": return <KnownEmailAdmin />;
      case "denied": return <DeniedEmailLog />;
      case "check-mail": return <CheckMailAdmin />;
      case "audit": return <Audit />;
    }
  };
  return (
    <div className={`admin-shell hub-admin-shell${condensed ? " is-condensed" : ""}`}>
      {mobileOpen && <button className="hub-drawer-scrim" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
      <aside id="hub-admin-navigation" className={mobileOpen ? "admin-nav is-open" : "admin-nav"}>
        <div className="brand brand--small"><AtlasBrandMark /><div><strong>Atlas · Hub</strong><small>Administrator</small></div></div>
        <nav aria-label="Administration">
          {nav.map((item) => <button key={item.id} className={group === item.id ? "is-active" : ""}
            aria-current={group === item.id ? "page" : undefined} title={item.label}
            onClick={() => select(remembered[item.id] || item.id)}>{item.icon}<span>{item.label}</span></button>)}
        </nav>
        <HubDocumentResource />
        <div className="admin-nav__footer"><small>Signed in as</small><strong title={user.email}>{user.email}</strong>
          <Button tone="ghost" onClick={onExit} title="Back to Hub"><ExternalLink size={16} /><span>Back to Hub</span></Button>
          <Button tone="ghost" busy={signingOut} onClick={() => void logout()} title="Sign out"><LogOut size={16} /><span>Sign out</span></Button>
          {logoutError && <Notice tone="danger">{logoutError}</Notice>}
        </div>
      </aside>
      <div className="hub-admin-workspace">
        <header className="hub-topbar">
          <Button tone="ghost" aria-label="Menu" aria-controls="hub-admin-navigation" aria-expanded={mobileOpen || !condensed}
            onClick={() => window.matchMedia("(max-width: 599px)").matches ? setMobileOpen(!mobileOpen) : setCondensed(!condensed)}><Menu size={18} /></Button>
          <span className="hub-breadcrumb" title={`Administration · ${groupLabel}`}><span>Administration</span><ChevronRight size={14} /><span>{groupLabel}</span></span>
          <span className="hub-topbar-spacer" /><span className="hub-topbar-identity" title={user.email}>{user.email}</span>
        </header>
        <main className="admin-main">
          <nav className="hub-subnav" aria-label={`${groupLabel} sections`}>
            {adminPanels.filter((p) => adminGroup(p.section) === group).map((item) =>
              <Button key={item.id} tone="ghost" className={panel === item.id ? "is-active" : ""}
                aria-current={panel === item.id ? "page" : undefined} onClick={() => select(item.id)}>{item.label}</Button>)}
          </nav>
          {visited.map((id) => <div key={id} hidden={panel !== id} className="hub-admin-panel" data-hub-panel={id}>{renderPanel(id)}</div>)}
        </main>
      </div>
    </div>
  );
}

function Overview() {
  const state = useData(
    () => api<Record<string, string | number>>("/admin/overview"),
    [],
  );
  const metrics = [
    ["users", "Total users", Users],
    ["users_today", "Users today", Check],
    ["active_assignments", "Active assignments", Link2],
    ["allocations_today", "Allocations today", Gauge],
    ["available_links", "Available links", Boxes],
    ["links_at_capacity", "Links at capacity", Gauge],
    ["unhealthy_links", "Unhealthy links", Activity],
    ["open_reports", "Open reports", ClipboardList],
    ["verification_success_rate", "Verification success %", MailCheck],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="Control center"
        title="Overview"
        description="A clear view of access, supply, and platform health."
        actions={
          <Button onClick={() => void state.reload()}>
            <RefreshCw size={16} /> Refresh
          </Button>
        }
      />
      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <Notice tone="danger">{state.error}</Notice>
      ) : (
        <div className="metric-grid">
          {metrics.map(([key, label, Icon]) => (
            <Card className="metric" key={key}>
              <span>
                <Icon />
              </span>
              <strong>{state.data?.[key] ?? 0}</strong>
              <small>{label}</small>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

interface LinkRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  capacity: number | null;
  weight: number;
  health_status: string;
  health_monitoring: boolean;
  expires_at: string | null;
  notes: string;
  used: number;
  open_reports: number;
}
const blankLink: LinkInput = {
  name: "",
  url: "https://",
  enabled: true,
  capacity: null,
  weight: 1,
  notes: "",
  healthMonitoring: true,
  expiresAt: null,
};
function Links() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const state = usePagedData<{ links: LinkRow[] }>(
    `/admin/links?q=${encodeURIComponent(q)}&status=${filter}`,
  );
  const [editor, setEditor] = useState<LinkRow | "new">();
  const [bulk, setBulk] = useState(false);
  const [remove, setRemove] = useState<LinkRow>();
  const [reset, setReset] = useState<LinkRow>();
  const [busy, setBusy] = useState("");
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [checkResults, setCheckResults] = useState<
    Record<string, { name: string; feedback: LinkCheckFeedback }>
  >({});
  const check = async (link: LinkRow) => {
    const { id, name } = link;
    setChecking((current) => new Set(current).add(id));
    setCheckResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const result = await post<LinkCheckResult>(`/admin/links/${id}/check`);
      setCheckResults((current) => ({
        ...current,
        [id]: { name, feedback: describeLinkCheck(result) },
      }));
      await state.reload();
    } catch (error) {
      setCheckResults((current) => ({
        ...current,
        [id]: { name, feedback: describeLinkCheckError(error) },
      }));
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  const setEnabled = async (link: LinkRow, enabled: boolean) => {
    setBusy(`enabled-${link.id}`);
    try {
      await put(`/admin/links/${link.id}/enabled`, { enabled });
      await state.reload();
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Distribution"
        title="Links"
        description="Manage availability, capacity, weighting, and health."
        actions={
          <>
            <BulkAdminAction mode="links" onDone={() => void state.reload()} />
            <Button onClick={() => setBulk(true)}>
              <Upload size={16} /> Bulk add
            </Button>
            <Button tone="primary" onClick={() => setEditor("new")}>
              <Plus size={16} /> Add link
            </Button>
          </>
        }
      />
      <div className="list-toolbar">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search links"
            placeholder="Search name or URL"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Select
          aria-label="Filter links"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All links</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="healthy">Healthy</option>
          <option value="unavailable">Unavailable</option>
          <option value="unknown">Unknown health</option>
        </Select>
      </div>
      <LinkCheckNotices results={checkResults} />
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : !state.data?.links.length ? (
        <Card>
          <Empty
            title={q || filter !== "all" ? "No matching links" : "No links yet"}
            action={
              <Button tone="primary" onClick={() => setBulk(true)}>
                Add links
              </Button>
            }
          >
            {q || filter !== "all"
              ? "Try another search or status filter."
              : "Paste a list or add your first destination."}
          </Empty>
        </Card>
      ) : (
        <div className="record-grid">
          {state.data.links.map((link) => (
            <Card className="link-card" key={link.id}>
              <header>
                <div>
                  <h3>{link.name}</h3>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.url}
                  </a>
                </div>
                <Badge
                  tone={
                    !link.enabled
                      ? "neutral"
                      : link.health_status === "healthy"
                        ? "success"
                        : link.health_status === "unavailable"
                          ? "danger"
                          : "warning"
                  }
                >
                  {link.enabled ? link.health_status : "disabled"}
                </Badge>
              </header>
              <div className="capacity">
                <span
                  style={{
                    width: `${link.capacity ? Math.min(100, (link.used / link.capacity) * 100) : Math.min(100, link.used / 10)}%`,
                  }}
                />
                <div>
                  <small>{link.used} assigned</small>
                  <small>
                    {link.capacity === null
                      ? "Unlimited capacity"
                      : `${Math.max(0, link.capacity - link.used)} available`}
                  </small>
                </div>
              </div>
              <footer>
                <Button
                  busy={checking.has(link.id)}
                  onClick={() => void check(link)}
                >
                  <Activity size={15} /> Check
                </Button>
                <Button onClick={() => setEditor(link)}>Edit</Button>
                <Button
                  busy={busy === `enabled-${link.id}`}
                  onClick={() => void setEnabled(link, !link.enabled)}
                >
                  <Power size={15} /> {link.enabled ? "Disable" : "Enable"}
                </Button>
                {link.used > 0 && (
                  <Button onClick={() => setReset(link)}>Reset</Button>
                )}
                <Button tone="danger" onClick={() => setRemove(link)}>
                  <Trash2 size={15} /> Delete
                </Button>
              </footer>
            </Card>
          ))}
        </div>
      )}
      <Pagination label="Links" {...state.pager} />
      <LinkEditor
        value={editor}
        onClose={() => setEditor(undefined)}
        onSaved={() => {
          setEditor(undefined);
          void state.reload();
        }}
      />
      <BulkLinks
        open={bulk}
        onClose={() => setBulk(false)}
        onSaved={() => {
          setBulk(false);
          void state.reload();
        }}
      />
      <Dialog
        open={Boolean(remove)}
        onClose={() => setRemove(undefined)}
        title="Permanently delete this link?"
        description="This cannot be undone. The link, its assignments, reports, and health history will be removed from the database."
        footer={
          <>
            <Button onClick={() => setRemove(undefined)}>Cancel</Button>
            <Button
              tone="danger"
              busy={busy === "remove"}
              onClick={async () => {
                if (!remove) return;
                setBusy("remove");
                try {
                  await del(`/admin/links/${remove.id}`);
                  setRemove(undefined);
                  await state.reload();
                } finally {
                  setBusy("");
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p>
          <strong>{remove?.name}</strong> and all of its related records will be
          erased. Use Disable instead if you may need this link or its history
          later.
        </p>
      </Dialog>
      <Dialog
        open={Boolean(reset)}
        onClose={() => setReset(undefined)}
        title="Reset all assignments?"
        description="Every user currently assigned to this link will need to request another."
        footer={
          <>
            <Button onClick={() => setReset(undefined)}>Cancel</Button>
            <Button
              tone="danger"
              busy={busy === "reset"}
              onClick={async () => {
                if (!reset) return;
                setBusy("reset");
                try {
                  await post(`/admin/links/${reset.id}/reset-assignments`);
                  setReset(undefined);
                  await state.reload();
                } finally {
                  setBusy("");
                }
              }}
            >
              Reset {reset?.used ?? 0} assignments
            </Button>
          </>
        }
      >
        <Notice tone="warning">
          This does not delete assignment history or reports.
        </Notice>
      </Dialog>
    </>
  );
}
function LinkEditor({
  value,
  onClose,
  onSaved,
}: {
  value: LinkRow | "new" | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial =
    value && value !== "new"
      ? {
          name: value.name,
          url: value.url,
          enabled: value.enabled,
          capacity: value.capacity,
          weight: value.weight,
          expiresAt: value.expires_at,
          notes: value.notes,
          healthMonitoring: value.health_monitoring,
        }
      : blankLink;
  const [form, setForm] = useState<LinkInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setForm(initial), [value]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (value === "new") await post("/admin/links", form);
      else if (value) await put(`/admin/links/${value.id}`, form);
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not save link.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={Boolean(value)}
      onClose={onClose}
      title={value === "new" ? "Add link" : "Edit link"}
      description="Capacity left blank means unlimited."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button form="link-editor" type="submit" tone="primary" busy={busy}>
            Save link
          </Button>
        </>
      }
    >
      <form id="link-editor" className="form-grid" onSubmit={save}>
        <Field label="Name">
          <Input
            required
            maxLength={160}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="URL">
          <Input
            required
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
        </Field>
        <Field label="Capacity">
          <Input
            type="number"
            min={1}
            placeholder="Unlimited"
            value={form.capacity ?? ""}
            onChange={(e) =>
              setForm({
                ...form,
                capacity: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </Field>
        <Field label="Weight">
          <Input
            type="number"
            min={1}
            max={10000}
            value={form.weight}
            onChange={(e) =>
              setForm({ ...form, weight: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Notes">
          <Textarea
            rows={3}
            value={form.notes ?? ""}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </Field>
        <div className="toggle-row">
          <label>
            <input
              type="checkbox"
              checked={form.healthMonitoring}
              onChange={(e) =>
                setForm({ ...form, healthMonitoring: e.target.checked })
              }
            />{" "}
            Health monitoring
          </label>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  );
}
function BulkLinks({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    inserted: unknown[];
    skipped: string[];
  }>();
  const [error, setError] = useState("");
  const count = text.split(/\r?\n/).filter((x) => x.trim()).length;
  const upload = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await post<{ inserted: unknown[]; skipped: string[] }>(
        "/admin/links/bulk",
        { text },
      );
      setResult(next);
      if (!next.skipped.length) setTimeout(onSaved, 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bulk add links"
      description="Paste up to 5,000 links. Put one link on each line."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={!count}
            onClick={() => void upload()}
          >
            <Upload size={16} /> Add {count || ""} link{count === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="bulk-example">
        <code>https://first.example</code>
        <code>Community link | https://second.example</code>
      </div>
      <Textarea
        autoFocus
        rows={12}
        spellCheck={false}
        placeholder={
          "https://one.example\nhttps://two.example\nNamed link | https://three.example"
        }
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(undefined);
        }}
      />
      <p className="field-help">
        Blank lines are ignored. Existing URLs are skipped safely.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {result && (
        <Notice tone={result.skipped.length ? "warning" : "success"}>
          {result.inserted.length} added
          {result.skipped.length
            ? `, ${result.skipped.length} already existed.`
            : "."}
        </Notice>
      )}
    </Dialog>
  );
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
  admin_notes: string;
  quota_override: Record<string, number | null> | null;
  assignment_id: string | null;
  link_name: string | null;
  active_assignment_count: number;
}
interface UserDetails {
  manualVerification?: ManualVerificationState;
  user: UserRow & {
    verified_at: string | null;
    quota_reset_at: string | null;
    suspension_reason: string;
  };
  usage: { week: number };
  counts: Record<ActivityKind, number>;
  assignments: Array<{
    id: string;
    name: string;
    url: string;
    active: boolean;
    assigned_at: string;
  }>;
  reports: Array<{
    id: string;
    link_name: string;
    category: string;
    status: string;
    created_at: string;
  }>;
  verifications: Array<{
    id: string;
    status: string;
    attempt_count: number;
    created_at: string;
  }>;
  sessions: Array<{
    id: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
    ip: string;
  }>;
}
function UserAdmin() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const state = usePagedData<{ users: UserRow[] }>(
    `/admin/users?q=${encodeURIComponent(q)}&status=${filter}`,
  );
  const [selected, setSelected] = useState<UserRow>();
  const users = state.data?.users;
  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Users"
        description="Search accounts, inspect access, and adjust individual limits."
        actions={
          <>
            <BulkAdminAction mode="accounts" />
            <Select
              aria-label="Filter users"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All users</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="Search users"
                placeholder="Search email"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
          </>
        }
      />
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : !users?.length ? (
        <Card>
          <Empty title="No matching users">
            Try another search or status filter.
          </Empty>
        </Card>
      ) : (
        <div className="table-card" tabIndex={0} role="region" aria-label="Scrollable data table">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Current link</th>
                <th>Last login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users?.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.email}</strong>
                    <small>{user.role}</small>
                  </td>
                  <td>
                    <Badge
                      tone={user.status === "active" ? "success" : "danger"}
                    >
                      {user.status}
                    </Badge>
                  </td>
                  <td>
                    {user.active_assignment_count > 1
                      ? `${user.active_assignment_count} active links`
                      : (user.link_name ?? "None")}
                  </td>
                  <td>{date(user.last_login_at)}</td>
                  <td>
                    <Button onClick={() => setSelected(user)}>Open</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination label="Users" {...state.pager} />
      <UserDetail
        user={selected}
        onClose={() => setSelected(undefined)}
        onSaved={() => {
          setSelected(undefined);
          void state.reload();
        }}
      />
    </>
  );
}
function UserDetail({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(user?.status ?? "active");
  const [notes, setNotes] = useState(user?.admin_notes ?? "");
  const [week, setWeek] = useState<string>(
    user?.quota_override?.linksPerWeek?.toString() ?? "",
  );
  const [details, setDetails] = useState<UserDetails>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false), [deleteEmail, setDeleteEmail] = useState("");
  useEffect(() => {
    setStatus(user?.status ?? "active");
    setNotes(user?.admin_notes ?? "");
    setWeek(user?.quota_override?.linksPerWeek?.toString() ?? "");
    setDetails(undefined);
    setError("");
    setDeleteOpen(false); setDeleteEmail("");
    let current = true;
    if (user)
      api<UserDetails>(`/admin/users/${user.id}`)
        .then((result) => {
          if (current) setDetails(result);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [user]);
  const save = async () => {
    if (!user) return;
    setBusy("save");
    setError("");
    try {
      const quota = week.trim().toLowerCase();
      if (
        quota &&
        quota !== "unlimited" &&
        (!Number.isInteger(Number(quota)) || Number(quota) < 1)
      )
        throw new Error(
          "Weekly quota must be a positive whole number, unlimited, or blank.",
        );
      await put(`/admin/users/${user.id}`, {
        status,
        adminNotes: notes,
        quotaOverride:
          quota === ""
            ? null
            : { linksPerWeek: quota === "unlimited" ? null : Number(quota) },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save user.");
    } finally {
      setBusy("");
    }
  };
  const action = async (kind: string, close = true) => {
    if (!user) return;
    setBusy(kind);
    setError("");
    try {
      await post(`/admin/users/${user.id}/${kind}`);
      if (close) onSaved();
      else setDetails(await api<UserDetails>(`/admin/users/${user.id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy("");
    }
  };
  return (
    <Dialog
      open={Boolean(user)}
      onClose={onClose}
      title={user?.email ?? "User"}
      description={`Created ${date(user?.created_at)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy === "save"}
            onClick={() => void save()}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="detail-sections">
        <section>
          <h3>Account</h3>
          <div className="form-grid">
            <Field label="Status">
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </Select>
            </Field>
            <Field label="Current assignment">
              <Input
                disabled
                value={user?.link_name ?? "No active assignment"}
              />
            </Field>
          </div>
        </section>
        <section>
          <h3>Quota</h3>
          <div className="quota-summary">
            <span>
              <strong>{details?.usage.week ?? "—"}</strong> used this week
            </span>
          </div>
          <Field
            label="Links per week"
            hint="Blank uses the global default. Type unlimited for no limit."
          >
            <Input value={week} onChange={(e) => setWeek(e.target.value)} />
          </Field>
          <Button
            busy={busy === "reset-quota"}
            onClick={() => void action("reset-quota", false)}
          >
            Reset current usage
          </Button>
        </section>
        {user && (
          <UserActivity
            key={user.id}
            userId={user.id}
            counts={details?.counts}
          />
        )}
        <section>
          <h3>Administration notes</h3>
          <Textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </section>
        {details?.manualVerification?.request && (
          <section>
            <h3>Manual verification</h3>
            <Badge
              tone={
                details.manualVerification.status === "approved"
                  ? "success"
                  : details.manualVerification.status === "denied"
                    ? "danger"
                    : "warning"
              }
            >
              {details.manualVerification.status}
            </Badge>
            <VerificationRequestDetails
              request={details.manualVerification.request}
            />
            <a
              className="button button--neutral"
              href="/?admin=manual-verification"
            >
              Review requests
            </a>
          </section>
        )}
        <section>
          <h3>Security & assignment</h3>
          <div className="button-row">
            <Button
              busy={busy === "revoke-sessions"}
              onClick={() => void action("revoke-sessions")}
            >
              Revoke all sessions
            </Button>
            <Button
              tone="danger"
              busy={busy === "reset-assignment"}
              onClick={() => void action("reset-assignment")}
            >
              Reset assignment
            </Button>
          </div>
        </section>
        {user?.role !== "admin" && <section>
          <h3>Delete account</h3>
          <p>Permanently delete this user and their cloud browser profile. Their sessions and link assignments will be removed. Local data on their devices and retained operational records are not erased.</p>
          {!deleteOpen ? <Button tone="danger" disabled={!!busy} onClick={() => { setDeleteEmail(""); setDeleteOpen(true); }}>Delete user…</Button> : <div className="hub-delete-confirm">
            <Field label={`Type ${user?.email || "the user's email"} to confirm`}><Input value={deleteEmail} autoComplete="off" spellCheck={false} onChange={e => setDeleteEmail(e.target.value)} /></Field>
            <div className="button-row"><Button disabled={!!busy} onClick={() => setDeleteOpen(false)}>Keep user</Button><Button tone="danger" busy={busy === "delete-user"} disabled={!user || deleteEmail !== user.email || !!busy} onClick={async () => {
              if (!user || busy || deleteEmail !== user.email) return;
              setBusy("delete-user"); setError("");
              try { const result = await del<{ ok: boolean }>(`/admin/users/${user.id}`); if (result.ok !== true) throw Error("Account deletion was not confirmed. Refresh before retrying."); onSaved(); }
              catch (e) { setError((e as Error).message); }
              finally { setBusy(""); }
            }}>Permanently delete user</Button></div>
          </div>}
        </section>}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}

type ActivityKind = "assignments" | "reports" | "verifications" | "sessions";
interface ActivityRow {
  id: string;
  name?: string;
  url?: string;
  active?: boolean;
  assigned_at?: string;
  link_name?: string;
  category?: string;
  status?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string | null;
  ip?: string | null;
  attempt_count?: number;
}
function UserActivity({
  userId,
  counts,
}: {
  userId: string;
  counts?: Record<ActivityKind, number>;
}) {
  const [kind, setKind] = useState<ActivityKind>("assignments");
  const state = usePagedData<{ items: ActivityRow[] }>(
    `/admin/users/${userId}/activity?kind=${kind}`,
  );
  const labels: Record<ActivityKind, string> = {
    assignments: "Assignments",
    reports: "Reports",
    verifications: "Verifications",
    sessions: "Sessions",
  };
  return (
    <section>
      <div className="activity-toolbar">
        <h3>Activity</h3>
        <Select
          aria-label="User activity type"
          value={kind}
          onChange={(event) => setKind(event.target.value as ActivityKind)}
        >
          {(Object.keys(labels) as ActivityKind[]).map((item) => (
            <option key={item} value={item}>
              {labels[item]}
              {counts ? ` (${counts[item]})` : ""}
            </option>
          ))}
        </Select>
      </div>
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading label="Loading activity…" />
      ) : state.error ? null : !state.data?.items.length ? (
        <p>No {labels[kind].toLowerCase()} recorded.</p>
      ) : (
        <div className="mini-list">
          {state.data.items.map((item) => (
            <div key={item.id}>
              <span>
                <strong>
                  {kind === "assignments"
                    ? item.name
                    : kind === "reports"
                      ? item.link_name
                      : kind === "verifications"
                        ? `Verification · ${item.attempt_count} attempt${item.attempt_count === 1 ? "" : "s"}`
                        : item.ip || "Unknown IP"}
                </strong>
                <small>{date(item.assigned_at ?? item.created_at)}</small>
                {kind === "reports" && (
                  <small>{item.category?.replaceAll("_", " ")}</small>
                )}
                {(kind === "sessions" || kind === "verifications") && (
                  <small>Expires {date(item.expires_at)}</small>
                )}
              </span>
              <Badge
                tone={
                  kind === "assignments" && item.active ? "success" : "neutral"
                }
              >
                {kind === "assignments"
                  ? item.active
                    ? "active"
                    : "past"
                  : kind === "sessions"
                    ? item.revoked_at
                      ? "revoked"
                      : item.expires_at &&
                          new Date(item.expires_at).getTime() <= Date.now()
                        ? "expired"
                        : "active"
                    : item.status}
              </Badge>
            </div>
          ))}
        </div>
      )}
      <Pagination label={labels[kind]} {...state.pager} />
    </section>
  );
}

interface RuleRow extends EmailRuleInput {
  id: string;
  note: string;
  denialMessage: string;
}
const blankRule: EmailRuleInput = {
  kind: "domain",
  action: "allow",
  pattern: "",
  priority: 100,
  enabled: true,
  note: "",
  denialMessage: "",
};
function Rules({ includeRelated = true }: { includeRelated?: boolean } = {}) {
  const state = usePagedData<{ rules: RuleRow[] }>("/admin/email-rules");
  const [editor, setEditor] = useState<RuleRow | "new">();
  const [testEmail, setTestEmail] = useState("");
  const [test, setTest] = useState<{
    allowed: boolean;
    rule: RuleRow | null;
  }>();
  const testRule = async () =>
    setTest(await post("/admin/email-rules/test", { email: testEmail }));
  return (
    <>
      <PageHeader
        eyebrow="Registration"
        title="Email Rules"
        description="Allow or block exact addresses, domains, and safe regex patterns, with an optional message for blocked users."
        actions={
          <Button tone="primary" onClick={() => setEditor("new")}>
            <Plus size={16} /> Add rule
          </Button>
        }
      />
      <Card className="tester">
        <div>
          <h3>Test email</h3>
          <p>See exactly which rule wins before changing access.</p>
        </div>
        <div className="tester__form">
          <Input
            type="email"
            placeholder="user@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
          />
          <Button onClick={() => void testRule()}>Test</Button>
        </div>
        {test && (
          <Notice tone={test.allowed ? "success" : "danger"}>
            <strong>{test.allowed ? "ALLOWED" : "BLOCKED"}</strong>
            {test.rule
              ? ` · ${test.rule.note || test.rule.pattern}`
              : " · Default policy"}
            {!test.allowed && test.rule?.denialMessage
              ? ` · Message: ${test.rule.denialMessage}`
              : null}
          </Notice>
        )}
      </Card>
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : !state.data?.rules.length ? (
        <Card>
          <Empty title="No email rules">
            Add a rule to manage registration access.
          </Empty>
        </Card>
      ) : (
        <div className="table-card" tabIndex={0} role="region" aria-label="Scrollable data table">
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Decision</th>
                <th>Type</th>
                <th>Pattern</th>
                <th>Note</th>
                <th>Blocked-user message</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.data?.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.priority}</td>
                  <td>
                    <Badge
                      tone={rule.action === "allow" ? "success" : "danger"}
                    >
                      {rule.action}
                    </Badge>
                  </td>
                  <td>{rule.kind}</td>
                  <td>
                    <code>{rule.pattern}</code>
                  </td>
                  <td>{rule.note || "—"}</td>
                  <td>
                    {rule.action === "deny" && rule.denialMessage
                      ? rule.denialMessage
                      : "—"}
                  </td>
                  <td>
                    <Button onClick={() => setEditor(rule)}>Edit</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination label="Email rules" {...state.pager} />
      <RuleEditor
        value={editor}
        onClose={() => setEditor(undefined)}
        onSaved={() => {
          setEditor(undefined);
          void state.reload();
        }}
      />
      {includeRelated && <><DeniedEmailLog /><KnownEmailAdmin /></>}
    </>
  );
}

interface DeniedEmailLogin {
  id: string;
  email: string;
  matched_rule_pattern: string | null;
  decision_source: string;
  request_ip: string | null;
  created_at: string;
}
function DeniedEmailLog() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const state = usePagedData<{ items: DeniedEmailLogin[] }>(
    `/admin/denied-email-logins?q=${encodeURIComponent(query)}`,
  );
  return (
    <Card>
      <h2>Denied email attempts</h2>
      <p>
        Search addresses rejected by email rules or the default registration
        policy. For example, enter <code>@example.com</code>.
      </p>
      <form
        className="tester__form"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input.trim());
        }}
      >
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label="Search denied email attempts"
          placeholder="@example.com"
        />
        <Button type="submit">
          <Search size={15} /> Search
        </Button>
      </form>
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable data table">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Matched rule</th>
                <th>Source</th>
                <th>IP</th>
                <th>Denied</th>
              </tr>
            </thead>
            <tbody>
              {state.data?.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.email}</td>
                  <td>{item.matched_rule_pattern ?? "Default policy"}</td>
                  <td>{item.decision_source.replaceAll("_", " ")}</td>
                  <td>{item.request_ip ?? "—"}</td>
                  <td>{date(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!state.loading && !state.error && !state.data?.items.length && (
        <Empty title="No denied attempts">
          No matching denied email attempts were found.
        </Empty>
      )}
      <Pagination label="Denied attempts" {...state.pager} />
    </Card>
  );
}
function RuleEditor({
  value,
  onClose,
  onSaved,
}: {
  value: RuleRow | "new" | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = value && value !== "new" ? value : blankRule;
  const [form, setForm] = useState<EmailRuleInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setForm(initial), [value]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (value === "new") await post("/admin/email-rules", form);
      else if (value) await put(`/admin/email-rules/${value.id}`, form);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save rule.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={Boolean(value)}
      onClose={onClose}
      title={value === "new" ? "Add email rule" : "Edit email rule"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {value !== "new" && value && (
            <Button
              tone="danger"
              onClick={async () => {
                await del(`/admin/email-rules/${value.id}`);
                onSaved();
              }}
            >
              Delete
            </Button>
          )}
          <Button tone="primary" busy={busy} onClick={() => void save()}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Decision">
          <Select
            value={form.action}
            onChange={(e) =>
              setForm({ ...form, action: e.target.value as "allow" | "deny" })
            }
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </Select>
        </Field>
        <Field label="Rule type">
          <Select
            value={form.kind}
            onChange={(e) =>
              setForm({
                ...form,
                kind: e.target.value as EmailRuleInput["kind"],
              })
            }
          >
            <option value="exact">Exact email</option>
            <option value="domain">Domain</option>
            <option value="regex">Regex</option>
          </Select>
        </Field>
        <Field label="Pattern">
          <Input
            required
            placeholder={
              form.kind === "domain"
                ? "@example.com"
                : form.kind === "exact"
                  ? "person@example.com"
                  : "^[a-z]+@example\\.com$"
            }
            value={form.pattern}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
          />
        </Field>
        <Field label="Priority">
          <Input
            type="number"
            value={form.priority}
            onChange={(e) =>
              setForm({ ...form, priority: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Explanation">
          <Textarea
            rows={3}
            value={form.note ?? ""}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        {form.action === "deny" && (
          <Field
            label="Message shown when blocked"
            hint="Optional. Leave blank to show the standard blocked-email message."
          >
            <Textarea
              rows={3}
              maxLength={500}
              placeholder="Use your organization email address."
              value={form.denialMessage ?? ""}
              onChange={(e) =>
                setForm({ ...form, denialMessage: e.target.value })
              }
            />
          </Field>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}

function Verification() {
  const attempts = usePagedData<{
    verifications: Array<Record<string, unknown>>;
  }>("/admin/verifications");
  const google = useData(
    () =>
      api<{ connection: { email: string; connected_at: string } | null }>(
        "/admin/google/status",
      ),
    [],
  );
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const connect = async () => {
    setBusy("connect");
    try {
      const result = await post<{ url: string }>("/admin/google/connect");
      location.href = result.url;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not connect.");
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Google Drive"
        title="Verification"
        description="Connection status and recent passwordless verification activity."
      />
      <Card className="integration-card">
        <span className="integration-icon">
          <ShieldCheck />
        </span>
        <div>
          <h3>Google Drive Verification</h3>
          {google.data?.connection ? (
            <>
              <Badge tone="success">Connected</Badge>
              <p>{google.data.connection.email}</p>
            </>
          ) : (
            <>
              <Badge tone="warning">Not connected</Badge>
              <p>Connect the Google account that will share temporary files.</p>
            </>
          )}
        </div>
        <div className="integration-actions">
          <Button
            tone="primary"
            busy={busy === "connect"}
            onClick={() => void connect()}
          >
            {google.data?.connection ? "Reconnect" : "Connect"}
          </Button>
          {google.data?.connection && (
            <>
              <Button
                busy={busy === "test"}
                onClick={async () => {
                  setBusy("test");
                  try {
                    setMessage(
                      (await post<{ message: string }>("/admin/google/test"))
                        .message,
                    );
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : "Test failed.");
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Test connection
              </Button>
              <Button
                tone="danger"
                onClick={async () => {
                  await del("/admin/google");
                  await google.reload();
                }}
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
      </Card>
      {message && (
        <Notice tone={message.includes("working") ? "success" : "danger"}>
          {message}
        </Notice>
      )}
      <Card>
        <h2>Verification attempts</h2>
        {attempts.error && (
          <Notice tone="danger">
            {attempts.error}{" "}
            <Button onClick={() => void attempts.reload()}>Retry</Button>
          </Notice>
        )}
        {attempts.loading ? (
          <Loading />
        ) : attempts.error ? null : !attempts.data?.verifications.length ? (
          <Empty title="No verification attempts">
            Verification activity will appear here.
          </Empty>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable data table">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Expires</th>
                  <th>Cleanup</th>
                </tr>
              </thead>
              <tbody>
                {attempts.data?.verifications.map((item, i) => (
                  <tr key={String(item.id ?? i)}>
                    <td>{String(item.email)}</td>
                    <td>
                      <Badge
                        tone={
                          item.status === "used"
                            ? "success"
                            : item.status === "pending"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {String(item.status)}
                      </Badge>
                    </td>
                    <td>
                      {String(item.attempt_count)} / {String(item.max_attempts)}
                    </td>
                    <td>{date(String(item.expires_at))}</td>
                    <td>{String(item.cleanup_status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination label="Verification attempts" {...attempts.pager} />
      </Card>
    </>
  );
}

interface ReportRow {
  id: string;
  link_id: string;
  email: string;
  link_name: string;
  category: string;
  detail: string;
  status: string;
  admin_note: string;
  created_at: string;
  link_report_count: number;
}
function Reports() {
  const state = usePagedData<{
    reports: ReportRow[];
    aggregates: Array<{
      id: string;
      name: string;
      reports: number;
      unique_users: number;
      categories: Record<string, number>;
    }>;
  }>("/admin/reports");
  const [selected, setSelected] = useState<ReportRow>();
  return (
    <>
      <PageHeader
        eyebrow="Quality"
        title="Reports"
        description="Review user problems, spot repeated failures, and close the loop."
      />
      {Boolean(state.data?.aggregates.length) && (
        <div className="report-summary">
          {state.data!.aggregates.slice(0, 3).map((item) => (
            <Card key={item.id}>
              <Badge tone="warning">Top 3 · Last 24 hours</Badge>
              <h3>{item.name}</h3>
              <strong>{item.reports} reports</strong>
              <p>
                {item.unique_users} unique users ·{" "}
                {Object.entries(item.categories)
                  .map(([key, value]) => `${value} ${key.replaceAll("_", " ")}`)
                  .join(" · ")}
              </p>
            </Card>
          ))}
        </div>
      )}
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : !state.data?.reports.length ? (
        <Card>
          <Empty title="No reports">
            Reported link problems will appear here.
          </Empty>
        </Card>
      ) : (
        <div className="table-card" tabIndex={0} role="region" aria-label="Scrollable data table">
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th>Problem</th>
                <th>User</th>
                <th>Status</th>
                <th>Reported</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.data?.reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    <strong>{report.link_name}</strong>
                    <small>{report.link_report_count} total reports</small>
                  </td>
                  <td>{report.category.replaceAll("_", " ")}</td>
                  <td>{report.email}</td>
                  <td>
                    <Badge
                      tone={report.status === "open" ? "warning" : "success"}
                    >
                      {report.status}
                    </Badge>
                  </td>
                  <td>{date(report.created_at)}</td>
                  <td>
                    <Button onClick={() => setSelected(report)}>Review</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination label="Reports" {...state.pager} />
      <ReportReview
        report={selected}
        onClose={() => setSelected(undefined)}
        onSaved={() => {
          setSelected(undefined);
          void state.reload();
        }}
      />
    </>
  );
}
function ReportReview({
  report,
  onClose,
  onSaved,
}: {
  report: ReportRow | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(report?.status ?? "open");
  const [note, setNote] = useState(report?.admin_note ?? "");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    setStatus(report?.status ?? "open");
    setNote(report?.admin_note ?? "");
  }, [report]);
  return (
    <Dialog
      open={Boolean(report)}
      onClose={onClose}
      title={report?.link_name ?? "Report"}
      description={`Submitted by ${report?.email ?? ""}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="danger"
            busy={busy === "disable"}
            onClick={async () => {
              if (!report) return;
              setBusy("disable");
              await post(`/admin/reports/${report.id}/disable-link`);
              setBusy("");
              onSaved();
            }}
          >
            Disable affected link
          </Button>
          <Button
            tone="primary"
            busy={busy === "save"}
            onClick={async () => {
              if (!report) return;
              setBusy("save");
              await put(`/admin/reports/${report.id}`, {
                status,
                adminNote: note,
              });
              setBusy("");
              onSaved();
            }}
          >
            Save report
          </Button>
        </>
      }
    >
      <div className="detail-sections">
        <Notice tone="warning">{report?.category.replaceAll("_", " ")}</Notice>
        {report?.detail && <p>{report.detail}</p>}
        <p>
          <strong>{report?.link_report_count ?? 0}</strong> reports have been
          submitted for this link.
        </p>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </Select>
        </Field>
        <Field label="Internal notes">
          <Textarea
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function SettingsAdmin({ showStorage = true }: { showStorage?: boolean } = {}) {
  const state = useData(
    () =>
      api<{ settings: Record<string, Record<string, unknown>> }>(
        "/admin/settings",
      ),
    [],
  );
  const [editing, setEditing] = useState<{
    key: string;
    value: Record<string, unknown>;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await put(`/admin/settings/${editing.key}`, editing.value);
      setEditing(undefined);
      await state.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid settings.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Operational policy is stored in the database and applies without redeploying."
      />
      {showStorage && <HubProfileLimits />}
      {state.loading && !state.data ? (
        <Loading />
      ) : (
        <div className="settings-grid">
          <EntryLaunchLinkSettings value={state.data?.settings.entryLaunchLink} onSaved={(next) => state.setData((current) => current ? { ...current, settings: { ...current.settings, entryLaunchLink: next } } : current)} />
          {Object.entries(state.data?.settings ?? {}).filter(([key]) => key !== "entryLaunchLink").map(([key, value]) => (
            <Card key={key}>
              <header>
                <span>
                  <Settings />
                </span>
                <div>
                  <h3>{title(key)}</h3>
                  <p>{Object.keys(value).length} configurable values</p>
                </div>
              </header>
              <dl>
                {Object.entries(value)
                  .slice(0, 5)
                  .map(([name, item]) => (
                    <div key={name}>
                      <dt>{title(name)}</dt>
                      <dd>
                        {Array.isArray(item)
                          ? item.join(", ")
                          : typeof item === "boolean"
                            ? item
                              ? "On"
                              : "Off"
                            : String(item)}
                      </dd>
                    </div>
                  ))}
              </dl>
              <Button onClick={() => setEditing({ key, value: { ...value } })}>
                Edit settings
              </Button>
            </Card>
          ))}
        </div>
      )}
      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(undefined)}
        title={`Edit ${title(editing?.key ?? "")} settings`}
        description="Changes apply without restarting."
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button tone="primary" busy={busy} onClick={() => void save()}>
              Save settings
            </Button>
          </>
        }
      >
        <div className="settings-form">
          {editing &&
            Object.entries(editing.value).map(([name, item]) => (
              <SettingField
                key={name}
                name={name}
                value={item}
                onChange={(value) =>
                  setEditing({
                    ...editing,
                    value: { ...editing.value, [name]: value },
                  })
                }
              />
            ))}
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </Dialog>
    </>
  );
}
function SettingField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (typeof value === "boolean")
    return (
      <label className="check setting-check">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <strong>{title(name)}</strong>
          <small>{value ? "Enabled" : "Disabled"}</small>
        </span>
      </label>
    );
  if (name === "defaultMode")
    return (
      <Field label="Default registration policy">
        <Select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="allow">Allow unless blocked</option>
          <option value="deny">Block unless allowed</option>
        </Select>
      </Field>
    );
  if (name === "strategy")
    return (
      <Field label="Allocation strategy">
        <Select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="balanced_random">Balanced + randomized</option>
          <option value="random">Random</option>
          <option value="weighted_random">Weighted random</option>
          <option value="sequential">Sequential</option>
        </Select>
      </Field>
    );
  if (Array.isArray(value))
    return (
      <Field label={title(name)} hint="Separate values with commas.">
        <Input
          value={value.join(", ")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((item) => Number(item.trim()))
                .filter(Number.isFinite),
            )
          }
        />
      </Field>
    );
  if (typeof value === "number")
    return (
      <Field label={title(name)}>
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </Field>
    );
  return (
    <Field label={title(name)}>
      <Input
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
function Audit() {
  const state = usePagedData<{ events: Array<Record<string, unknown>> }>(
    "/admin/audit",
  );
  return (
    <>
      <PageHeader
        eyebrow="Accountability"
        title="Audit Log"
        description="A durable history of sensitive administrative changes."
      />
      {state.error && (
        <Notice tone="danger">
          {state.error}{" "}
          <Button onClick={() => void state.reload()}>Retry</Button>
        </Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : !state.data?.events.length ? (
        <Card>
          <Empty title="No audit events">
            Administrative changes will appear here.
          </Empty>
        </Card>
      ) : (
        <div className="timeline">
          {state.data?.events.map((event, i) => (
            <article key={String(event.id ?? i)}>
              <span>
                <Check />
              </span>
              <div>
                <h3>{String(event.action).replaceAll("_", " ")}</h3>
                <p>
                  {String(event.admin_email ?? "System")} ·{" "}
                  {String(event.target_type)}
                  {event.target_id ? ` ${String(event.target_id)}` : ""}
                </p>
                <time>{date(String(event.created_at))}</time>
              </div>
            </article>
          ))}
        </div>
      )}
      <Pagination label="Audit events" {...state.pager} />
    </>
  );
}
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";
const title = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (x) => x.toUpperCase());

function downloadBulk(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function BulkAdminAction({
  mode,
  onDone,
}: {
  mode: "links" | "accounts";
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const execute = async () => {
    setBusy(true);
    setMessage("");
    let removed = 0;
    try {
      if (mode === "accounts") {
        const text = await collectEmails((page) =>
          api(`/admin/users?page=${page}&pageSize=100&status=all`),
        );
        downloadBulk("atlas-account-emails.txt", text, "text/plain");
        setMessage("Account email list downloaded (all statuses).");
      } else {
        const snapshot = (await api<{ links: LinkRow[] }>("/admin/links"))
          .links;
        if (!snapshot.length) {
          setMessage("No links to delete.");
          return;
        }
        if (
          window.prompt(
            `Delete ALL ${snapshot.length} links across all pages and filters? Assignments, reports and health history will be removed. Accounts stay intact. Save a database backup first. Type DELETE ${snapshot.length} to continue.`,
          ) !== `DELETE ${snapshot.length}`
        )
          return;
        downloadBulk(
          "atlas-links-before-delete.json",
          JSON.stringify(snapshot, null, 2),
          "application/json",
        );
        // Recheck the reviewed snapshot before the first deletion.
        const current = (await api<{ links: LinkRow[] }>("/admin/links")).links;
        const urls = new Map(current.map((x) => [x.id, x.url]));
        if (snapshot.some((x) => urls.get(x.id) !== x.url))
          throw Error("Link pool changed; review and retry.");
        await deleteSnapshot(
          snapshot.map((x) => x.id),
          async (id) => {
            const result = await del<{ ok: boolean; deleted: boolean }>(
              `/admin/links/${id}`,
            );
            if (result.ok !== true || result.deleted !== true)
              throw Error(
                "Unexpected delete response; refresh before retrying.",
              );
          },
          (n) => {
            removed = n;
            setMessage(`Deleted ${n}/${snapshot.length}`);
          },
          () => new Promise((r) => setTimeout(r, 500)),
        );
        const final = (await api<{ links: LinkRow[] }>("/admin/links")).links;
        const ids = new Set(snapshot.map((x) => x.id));
        if (final.some((x) => ids.has(x.id)))
          throw Error("Some reviewed links remain; refresh before retrying.");
        setMessage(
          `Deleted ${removed} links. Accounts preserved. ${final.length} links remain (including any concurrent additions).`,
        );
      }
    } catch (e) {
      setMessage(
        `Stopped. ${mode === "links" ? `Confirmed deletions: ${removed}. ` : ""}${e instanceof Error ? e.message : "Request failed"} Refresh before retrying; the last request may have completed.`,
      );
    } finally {
      setBusy(false);
      onDone?.();
    }
  };
  return (
    <div>
      <Button
        tone={mode === "links" ? "danger" : undefined}
        busy={busy}
        onClick={() => void execute()}
      >
        {mode === "links"
          ? "Bulk delete all links"
          : "Export all account emails (.txt)"}
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
