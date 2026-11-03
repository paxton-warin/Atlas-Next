import { useEffect, useRef, useState } from "react";
import { post, api, del } from "./api";
import { Button, Card, Notice, PageHeader, Badge, Loading, Dialog, Field, Input } from "./ui";
import { HubEntry } from "./HubEntry";
export function parseHubAuthorization(search: string) {
  const p = new URLSearchParams(search);
  const branchId = p.get("branchId") || "",
    codeChallenge = p.get("codeChallenge") || "",
    state = p.get("state") || "";
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      branchId,
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state)
  )
    throw Error(
      "This browser sign-in request is incomplete. Return to your Atlas link and authenticate again.",
    );
  const callbackOrigin=p.get("callbackOrigin")||undefined;
  if(callbackOrigin){const u=new URL(callbackOrigin);if(u.protocol!=="https:"||u.origin!==callbackOrigin||u.username||u.password)throw Error("Invalid browser destination.");}
  return { branchId, codeChallenge, state,...(callbackOrigin?{callbackOrigin}:{}) };
}
export function hubCallbackURL(
  result: { callback: string; code: string; state: string },
  expectedState: string,
) {
  const u = new URL(result.callback);
  if (
    u.protocol !== "https:" ||
    u.pathname !== "/auth/hub/callback" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    result.state !== expectedState ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.code)
  )
    throw Error("The browser sign-in response is invalid.");
  u.searchParams.set("code", result.code);
  u.searchParams.set("state", result.state);
  return u.href;
}
export function HubAuthorize({ enabled }: { enabled: boolean }) {
  const [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const pending = useRef<
    Promise<{ callback: string; code: string; state: string }> | undefined
  >(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    try {
      const input = parseHubAuthorization(location.search);
      pending.current ??= post("/hub/handoffs", input);
      pending.current
        .then((result) => {
          if (live) location.replace(hubCallbackURL(result, input.state));
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    } catch (e) {
      setError((e as Error).message);
    }
    return () => {
      live = false;
    };
  }, [enabled, attempt]);
  return (
    <HubEntry stage={!enabled ? "This Atlas connection is not ready." : error ? "Sign-in needs attention." : "Signing you into your Atlas browser…"} busy={enabled && !error}>
      {!enabled ? <Notice>This Hub is not activated yet.</Notice> : error ? <>
        <Notice tone="danger">{error}</Notice>
        <Button onClick={() => { pending.current = undefined; setError(""); setAttempt((x) => x + 1); }}>Try again</Button>
      </> : null}
      {(!enabled || error) && <a href="/" className="button button--ghost">Back to Hub</a>}
    </HubEntry>
  );
}

type BrowserSession = {
  id: string;
  origin: string;
  contextId: string;
  seenAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export function HubAccountSummary({ view = "all" }: { view?: "all" | "data" | "sessions" } = {}) {
  const [sessions, setSessions] = useState<BrowserSession[]>([]),
    [profile, setProfile] = useState<{
      id: string;
      initialized: boolean;
      bytes: number;
      revision: number;
    } | null>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string>(),
    [loaded, setLoaded] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [confirmation, setConfirmation] = useState(""),
    [deleted, setDeleted] = useState(false);
  const load = () =>
    Promise.all([
      api<{ sessions: BrowserSession[] }>("/hub/sessions"),
      api<{ profile: typeof profile }>("/hub/profile"),
    ]).then(([s, p]) => {
      setSessions(s.sessions);
      setProfile(p.profile);
      setLoaded(true);
    });
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<{ sessions: BrowserSession[] }>("/hub/sessions"),
      api<{ profile: typeof profile }>("/hub/profile"),
    ])
      .then(([s, p]) => {
        if (live) {
          setSessions(s.sessions);
          setProfile(p.profile);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="hub-account-summary stack">
      <PageHeader title={view === "sessions" ? "Browser sessions" : "Browser data"} description={view === "sessions" ? "Your signed-in Atlas browsers." : "Your account-backed browser profile."} />
      <Card>
      {error && <Notice tone="danger">{error}</Notice>}
      <section hidden={view === "sessions"}>
      <div className="hub-profile-summary-heading"><h2>Browser profile</h2><Badge tone={profile?.initialized ? "success" : "neutral"}>{profile?.initialized ? "Backed up" : profile === undefined ? "Loading" : "Not started"}</Badge></div>
      <p className="hub-profile-usage">
        {profile === undefined
          ? "Loading profile…"
          : profile?.initialized
            ? `${(profile.bytes / 1024 / 1024).toFixed(1)} MiB backed up · revision ${profile.revision}`
            : "Your profile starts when you authenticate an Atlas browser."}
      </p>
      </section>
      <section hidden={view === "data"}>
      <h2>Browser sessions</h2>
      {!loaded && !error && <Loading label="Loading browser sessions…" />}
      {sessions
        .filter(
          (s) => !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now(),
        )
        .map((s) => (
          <div className="form-row hub-browser-session" key={s.id}>
            <div>
              <strong>{new URL(s.origin).hostname}</strong>
              <small> Last active {new Date(s.seenAt).toLocaleString()}</small>
            </div>
            <Button
              busy={busy === s.id}
              onClick={async () => {
                setBusy(s.id);
                setError("");
                try {
                  await del("/hub/sessions/" + s.id);
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(undefined);
                }
              }}
            >
              Sign out browser
            </Button>
          </div>
        ))}
      {loaded && !sessions.some(
        (s) => !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now(),
      ) && <p>No active browsers.</p>}
      </section>
      </Card>
      {view !== "sessions" && <Card>
        <h2>Manage browser data</h2>
        <p>Your Hub profile contains account-backed website saves, cookies, Atlas settings and recovered saves. Data stored locally on other devices is separate.</p>
        {deleted && <Notice tone="success">Cloud browser data deleted. Atlas browser sessions were signed out. Your Hub account and links remain; local device data was not erased.</Notice>}
        <Button tone="danger" disabled={!profile?.id || !!busy} onClick={() => { setError(""); setConfirmation(""); setDeleteOpen(true); }}>Delete cloud browser data…</Button>
      </Card>}
      <Dialog open={deleteOpen} onClose={() => { if (busy !== "delete-profile") setDeleteOpen(false); }} title="Delete cloud browser data?" description="This permanently deletes this Hub profile, including synced website saves, cookies, Atlas settings and recovered saves. This action cannot be undone."
        footer={<><Button disabled={busy === "delete-profile"} onClick={() => setDeleteOpen(false)}>Cancel</Button><Button tone="danger" busy={busy === "delete-profile"} disabled={confirmation !== "DELETE" || !profile?.id || !!busy} onClick={async () => {
          if (!profile?.id || confirmation !== "DELETE" || busy) return;
          setBusy("delete-profile"); setError("");
          try {
            const result = await api<{ acknowledged: boolean; deleted: boolean }>("/hub/profile", { method: "DELETE", body: JSON.stringify({ profileId: profile.id, confirmation }) });
            if (result.acknowledged !== true || result.deleted !== true) throw Error("Deletion was not confirmed. Refresh Browser data before retrying.");
            setDeleted(true); setProfile(null); setSessions([]); setDeleteOpen(false); await load();
          } catch (e) { setError((e as Error).message); }
          finally { setBusy(undefined); }
        }}>Delete cloud data</Button></>}>
        <p>All signed-in Atlas browser sessions for this profile will stop syncing. Your Hub account, support tickets and link assignments will remain.</p>
        <p>This does not erase data stored on your devices or delete accounts you have with other websites. Close Atlas on other devices before continuing.</p>
        <Field label="Type DELETE to confirm"><Input value={confirmation} autoComplete="off" spellCheck={false} onChange={e => setConfirmation(e.target.value)} /></Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </Dialog>
    </div>
  );
}
