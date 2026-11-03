import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  LogOut,
  TriangleAlert,
  Menu,
  Database,
  Monitor,
  MessageSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AtlasBrandMark } from "./AtlasBrandMark";
import { HubDocumentResource } from "./HubDocumentResource";
import type {
  AssignmentView,
  PublicUser,
  ReportCategory,
} from "@atlas-link-dispenser/shared";
import { HubSupport, HubNotificationBell } from "./HubSupport";
import { HubAccountSummary } from "./HubAuthorize";
import { api, ApiError, post } from "./api";
import { Badge, Button, Card, Dialog, Empty, Notice } from "./ui";
type UserArea = "links" | "data" | "sessions" | "support";
const userAreas: Array<{ id: UserArea; label: string; icon: typeof Link2 }> = [
  { id: "links", label: "My Atlas", icon: Link2 }, { id: "data", label: "Browser data", icon: Database },
  { id: "sessions", label: "Sessions", icon: Monitor }, { id: "support", label: "Support", icon: MessageSquare },
];
export function userArea(search: string): UserArea {
  const value = new URLSearchParams(search).get("view");
  return userAreas.some((area) => area.id === value) ? value as UserArea : "links";
}
export function nextSupportRequest(previous: { ticketId: string; revision: number }, ticketId: string) {
  return { ticketId, revision: previous.revision + 1 };
}
export function UserDashboard({
  user,
  onLogout,
  hubEnabled = false,
}: {
  user: PublicUser;
  onLogout: () => void;
  hubEnabled?: boolean;
}) {
  const [area, setArea] = useState<UserArea>(() => typeof location === "undefined" ? "links" : userArea(location.search));
  const [visited, setVisited] = useState<UserArea[]>([area]);
  const [mobileOpen, setMobileOpen] = useState(false), [condensed, setCondensed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const selectArea = (next: UserArea, fromHistory = false) => {
    setArea(next); setVisited((current) => current.includes(next) ? current : [...current, next]); setMobileOpen(false);
    if (!fromHistory) history.replaceState(null, "", next === "links" ? "/" : `/?view=${next}`);
  };
  useEffect(() => {
    const navigate = () => selectArea(userArea(location.search), true);
    addEventListener("popstate", navigate); return () => removeEventListener("popstate", navigate);
  }, []);
  const [supportRequest, setSupportRequest] = useState({ ticketId: "", revision: 0 });
  const [assignments, setAssignments] = useState<AssignmentView[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [copied, setCopied] = useState<string>();
  const [reportTarget, setReportTarget] = useState<AssignmentView>();
  const [reported, setReported] = useState(false);
  const allocationPending = useRef(false);
  const mounted = useRef(false);
  const assignmentRevision = useRef(0);
  const pendingRefresh = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const load = async (initial = false) => {
      if (
        pendingRefresh.current ||
        allocationPending.current ||
        (!initial && document.visibilityState === "hidden")
      )
        return;
      const controller = new AbortController();
      const revision = assignmentRevision.current;
      pendingRefresh.current = controller;
      try {
        const result = await api<{ assignments: AssignmentView[] }>(
          "/assignment",
          { signal: controller.signal },
        );
        if (
          mounted.current &&
          !controller.signal.aborted &&
          revision === assignmentRevision.current
        ) {
          const visible = visibleAssignments(result.assignments);
          setAssignments(visible);
          setReportTarget((current) =>
            current && visible.some((item) => item.id === current.id)
              ? current
              : undefined,
          );
        }
      } catch (e) {
        if (
          mounted.current &&
          !controller.signal.aborted &&
          revision === assignmentRevision.current
        )
          setError(
            e instanceof Error ? e.message : "Could not load your links.",
          );
      } finally {
        if (pendingRefresh.current === controller)
          pendingRefresh.current = null;
      }
    };
    const refresh = () => void load();
    void load(true);
    const interval = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      assignmentRevision.current += 1;
      pendingRefresh.current?.abort();
      pendingRefresh.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const getLink = async () => {
    if (allocationPending.current) return;
    allocationPending.current = true;
    assignmentRevision.current += 1;
    pendingRefresh.current?.abort();
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      const created = (
        await post<{ assignment: AssignmentView }>("/assignment")
      ).assignment;
      if (!mounted.current) return;
      setAssignments((current) =>
        visibleAssignments([
          created,
          ...(current ?? []).filter((item) => item.id !== created.id),
        ]),
      );
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "No link is available.");
      setErrorCode(e instanceof ApiError ? e.code : "");
    } finally {
      allocationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const logout = async () => {
    setSigningOut(true); setError("");
    try { await post("/logout"); onLogout(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not sign out."); }
    finally { setSigningOut(false); }
  };
  const copy = async (assignment: AssignmentView) => {
    if (!describeAssignment(assignment).available) return;
    await navigator.clipboard.writeText(assignment.url);
    setCopied(assignment.id);
    setTimeout(() => setCopied(undefined), 1600);
  };
  const problem =
    errorCode === "QUOTA_EXCEEDED"
      ? {
          title: "Weekly Limit Reached",
          message: "You've used all of this week's link requests.",
          retry: false,
        }
      : errorCode === "NO_LINK_AVAILABLE"
        ? {
            title: "No Links Available",
            message:
              "There aren't any links available right now. Please try again later.",
            retry: true,
          }
        : null;
  const label = userAreas.find((item) => item.id === area)!.label;
  return (
    <main className={`user-shell hub-user-shell${condensed ? " is-condensed" : ""}`}>
      {mobileOpen && <button className="hub-drawer-scrim" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
      <aside id="hub-user-navigation" className={`hub-user-nav${mobileOpen ? " is-open" : ""}`}>
        <div className="brand brand--small"><AtlasBrandMark /><div><strong>Atlas</strong><small>{hubEnabled ? "Hub" : "Link Dispenser"}</small></div></div>
        <nav aria-label="Your Hub">
          {(hubEnabled ? userAreas : userAreas.slice(0, 1)).map(({ id, label: title, icon: Icon }) => <button key={id} title={title} aria-label={title} aria-current={area === id ? "page" : undefined} className={area === id ? "is-active" : ""} onClick={() => selectArea(id)}><Icon size={17} /><span>{title}</span></button>)}
        </nav>
        <HubDocumentResource />
        <div className="hub-user-nav-footer"><strong title={user.email}>{user.email}</strong>
          {user.role === "admin" && <a className="button button--ghost" href="/?admin=overview" title="Administration"><Monitor size={16} /><span>Administration</span></a>}
          <Button tone="ghost" busy={signingOut} onClick={() => void logout()} title="Sign out"><LogOut size={16} /><span>Sign out</span></Button>
        </div>
      </aside>
      <div className="hub-user-workspace">
        <header className="hub-topbar">
          <Button tone="ghost" aria-label="Menu" aria-controls="hub-user-navigation" aria-expanded={mobileOpen || !condensed} onClick={() => window.matchMedia("(max-width: 599px)").matches ? setMobileOpen(!mobileOpen) : setCondensed(!condensed)}><Menu size={18} /></Button>
          <span className="hub-breadcrumb">{label}</span><span className="hub-topbar-spacer" />
          {hubEnabled && <HubNotificationBell onOpen={(id) => { setSupportRequest((request) => nextSupportRequest(request, id)); selectArea("support"); }} />}
          <details className="hub-account-menu"><summary aria-label="Account menu">{user.email.slice(0, 1).toUpperCase()}</summary><div><strong>{user.email}</strong>
            {hubEnabled && <><button onClick={() => selectArea("data")}>Browser data</button><button onClick={() => selectArea("sessions")}>Manage browser sessions</button></>}
            {user.role === "admin" && <a href="/?admin=overview">Administration</a>}
            <button disabled={signingOut} onClick={() => void logout()}>Sign out</button>
          </div></details>
        </header>
        <div className="user-content">
          {error && !problem && <Notice tone="danger">{error}</Notice>}
          <section hidden={area !== "links"} className="hub-user-links">
            <div className="page-header"><div><h1>My Atlas</h1></div></div>
            {assignments === undefined ? <div className="loading"><span className="spinner" />Finding your link…</div> : assignments.length ?
              <AssignmentHistory assignments={assignments} busy={busy} copied={copied} problem={problem} onGenerate={() => void getLink()} onCopy={(assignment) => void copy(assignment)} onReport={setReportTarget} /> :
              <EmptyAssignment busy={busy} problem={problem} onGenerate={() => void getLink()} />}
          </section>
          {hubEnabled && (visited.includes("data") || visited.includes("sessions")) && <section hidden={area !== "data" && area !== "sessions"} className="hub-user-account"><HubAccountSummary view={area === "sessions" ? "sessions" : "data"} /></section>}
          {hubEnabled && visited.includes("support") && <section hidden={area !== "support"}><HubSupport active={area === "support"} initialTicketId={supportRequest.ticketId} openRequest={supportRequest.revision} /></section>}
        </div>
      </div>
      <ReportDialog open={Boolean(reportTarget)} assignment={reportTarget ?? null} onClose={() => setReportTarget(undefined)} onSent={() => { setReportTarget(undefined); setReported(true); }} />
      {reported && <div className="toast" role="status"><Check size={16} />Report sent. Thank you.<Button tone="ghost" onClick={() => setReported(false)}>Dismiss</Button></div>}
    </main>
  );
}

type HistoryAssignment = AssignmentView & {
  status?: "ready" | "previous" | "removed" | "unavailable";
  available?: boolean;
};
type AllocationProblem = {
  title: string;
  message: string;
  retry: boolean;
};
export function visibleAssignments(assignments: AssignmentView[]) {
  return assignments.filter((assignment) => assignment.status !== "removed");
}
function EmptyAssignment({
  busy,
  problem,
  onGenerate,
}: {
  busy: boolean;
  problem?: AllocationProblem | null;
  onGenerate: () => void;
}) {
  return (
    <Card>
      <Empty
        title={problem?.title ?? "Get Your Link"}
        action={
          !problem || problem.retry ? (
            <Button tone="primary" busy={busy} onClick={onGenerate}>
              {problem ? "Try again" : "Get Link"}
            </Button>
          ) : undefined
        }
      >
        {problem?.message ?? "Get your assigned link."}
      </Empty>
    </Card>
  );
}
export function describeAssignment(assignment: HistoryAssignment) {
  if (assignment.status === "removed")
    return {
      label: "Removed",
      tone: "neutral" as const,
      available: false,
      description: "",
    };
  if (
    assignment.available === false ||
    !assignment.url ||
    (assignment.status !== undefined &&
      assignment.status !== "ready" &&
      assignment.status !== "previous")
  )
    return {
      label: "Unavailable",
      tone: "warning" as const,
      available: false,
      description: "",
    };
  return {
    label: "Ready",
    tone: "success" as const,
    available: true,
    description: "",
  };
}
export function AssignmentHistory({
  assignments,
  busy,
  copied,
  problem,
  onGenerate,
  onCopy,
  onReport,
}: {
  assignments: AssignmentView[];
  busy: boolean;
  copied?: string;
  problem?: AllocationProblem | null;
  onGenerate: () => void;
  onCopy: (assignment: AssignmentView) => void;
  onReport: (assignment: AssignmentView) => void;
}) {
  const [latest, ...history] = visibleAssignments(assignments);
  if (!latest)
    return (
      <EmptyAssignment busy={busy} problem={problem} onGenerate={onGenerate} />
    );
  const renderAssignment = (assignment: AssignmentView, hero = false) => {
    const view = describeAssignment(assignment);
    return (
      <Card
        className={`assignment-card ${hero ? "assignment-card--hero" : "assignment-card--compact"}`}
        key={assignment.id}
      >
        <div>
          {hero && <h3 className="hub-latest-label">Latest link</h3>}
          {!view.available && (
            <Badge tone={view.tone}>
              <TriangleAlert size={13} /> {view.label}
            </Badge>
          )}
          <h2>{assignment.name}</h2>
          {hero && view.available && <p className="assignment-url">{assignment.url}</p>}
          <small>Generated {formatAssignedAt(assignment.assignedAt)}</small>
        </div>
        <div className="assignment-actions">
          {view.available && (
            <>
              <a
                className="button button--primary"
                href={assignment.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open <ExternalLink size={16} />
              </a>
              <Button onClick={() => onCopy(assignment)}>
                {copied === assignment.id ? (
                  <Check size={16} />
                ) : (
                  <Copy size={16} />
                )}{" "}
                {copied === assignment.id ? "Copied" : "Copy"}
              </Button>
            </>
          )}
          <Button onClick={() => onReport(assignment)}>
            <TriangleAlert size={16} /> Report
          </Button>
        </div>
      </Card>
    );
  };
  return (
    <div className="stack">
      <div className="assignment-list-heading">
        <span />
        <Button tone="primary" busy={busy} onClick={onGenerate}>
          <Link2 size={16} /> Generate another link
        </Button>
      </div>
      {problem && (
        <Notice tone="warning">
          <strong>{problem.title}</strong> {problem.message}
        </Notice>
      )}
      {latest && renderAssignment(latest, true)}
      {history.length > 0 && (
        <section className="stack" aria-label="Link history">
          <h2>Link history</h2>
          <div className="assignment-list">{history.map((item) => renderAssignment(item))}</div>
        </section>
      )}
    </div>
  );
}

function formatAssignedAt(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "just now" : parsed.toLocaleString();
}
function ReportDialog({
  open,
  assignment,
  onClose,
  onSent,
}: {
  open: boolean;
  assignment: AssignmentView | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [category, setCategory] = useState<ReportCategory>("does_not_load");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    if (!assignment) return;
    setBusy(true);
    setError("");
    try {
      await post("/reports", { assignmentId: assignment.id, category, detail });
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the report.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Report a problem"
      description="What happened when you opened your link?"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void send()}>
            Send report
          </Button>
        </>
      }
    >
      <div className="choice-grid">
        {(
          [
            ["does_not_load", "Doesn't load"],
            ["error_page", "Error page"],
            ["very_slow", "Very slow"],
            ["wrong_page", "Wrong page"],
            ["other", "Other"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={category === value ? "choice is-selected" : "choice"}
            onClick={() => setCategory(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="field">
        <span>
          Tell us more <small>(optional)</small>
        </span>
        <textarea
          className="input textarea"
          rows={4}
          maxLength={1000}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
      </label>
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  );
}
