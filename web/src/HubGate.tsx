import {
  flushProfile,
  getLocalFirstProfile,
  prepareProfileReplacement,
  stopProfile,
  getProfileStatus,
  listProfileRecoveries,
  downloadProfileRecovery,
  type ProfileStatus,
} from "./profile-client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  initializeHubCloud,
  setHubSession,
  type HubClientSession,
} from "./hub-client-state";
import { setActiveProfile } from "../../runtime/profile-context";
import { ArrowUpRight } from "lucide-react";
import { AtlasEntryFrame } from "./AtlasEntryFrame";
import "./HubGate.css";
import type {BackupRestoreProgress} from "../../runtime/backup-v2-restore.ts";
import {restorePresentation} from "./restore-progress.ts";
function sessionIdentity(s: HubClientSession | null) {
  return JSON.stringify([s?.authenticated, s?.grant?.profileId, s?.grant?.contextId,
    s?.grant?.sessionId, s?.endpointTransition?.revision, s?.endpointTransition?.hubOrigin]);
}
export default function HubGate({ children }: { children: ReactNode }) {
  const [restoreProgress,setRestoreProgress]=useState<BackupRestoreProgress>();
  const hydrated = useRef<string | null>(null);
  const currentSession = useRef<HubClientSession | null>(null);
  const sessionVersion = useRef(0);
  const signingOut = useRef(false);
  const [state, setState] = useState<HubClientSession | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [transitioning, setTransitioning] = useState(false),
    [migrationReview, setMigrationReview] = useState(""),
    [recoveries, setRecoveries] = useState<Awaited<ReturnType<typeof listProfileRecoveries>>["recoveries"] | null>(null),
    [reviewConfirmed, setReviewConfirmed] = useState(false),
    [error, setError] = useState(() =>
      new URLSearchParams(location.search).has("hub_error")
        ? "Sign-in did not complete. Please try again."
        : "",
    ),
    [message, setMessage] = useState("Checking your Atlas session…"),
    [attempt, setAttempt] = useState(0),
    [profileStatus, setProfileStatus] =
      useState<ProfileStatus>(getProfileStatus()),
    [transition, setTransition] =
      useState<HubClientSession["endpointTransition"]>();
  useEffect(()=>{
    const h=(event:Event)=>{const d=(event as CustomEvent).detail, g=currentSession.current?.grant;
      if(g&&d?.profileId===g.profileId&&d.contextId===g.contextId&&d.sessionId===g.sessionId)setRestoreProgress(d.progress);
    };
    addEventListener("atlas:backup-restore-progress",h);
    return()=>removeEventListener("atlas:backup-restore-progress",h);
  },[]);
  useEffect(() => {
    const h = (e: Event) => setProfileStatus((e as CustomEvent).detail);
    addEventListener("atlas:profile-status", h);
    return () => removeEventListener("atlas:profile-status", h);
  }, []);
  useEffect(() => {
    const h = () => void logout();
    addEventListener("atlas:profile-signout", h);
    return () => removeEventListener("atlas:profile-signout", h);
  });
  useEffect(() => {
    let live = true,
      pending = false;
    async function load() {
      if (pending || signingOut.current) return;
      pending = true;
      setLoading(true);
      setError("");
      setRestoreProgress(undefined);
      let version = sessionVersion.current;
      try {
        const r = await fetch("/api/hub/state", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const s = (await r.json()) as HubClientSession;
        if (!r.ok)
          throw Error(
            "Atlas Hub is temporarily unavailable. Retry your connection.",
          );
        if (!live || signingOut.current || version !== sessionVersion.current) return;
        if (
          localStorage.getItem("atlas.hub.signed-out") === "true" &&
          s.enabled
        ) {
          if (s.authenticated && s.csrf)
            await fetch("/api/hub/logout", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "content-type": "application/json",
                "x-atlas-hub-csrf": s.csrf,
              },
              body: "{}",
            });
          if (!live || signingOut.current || version !== sessionVersion.current) return;
          setState({
            ...s,
            authenticated: false,
            grant: undefined,
            csrf: undefined,
          });
          setReady(false);
          setMessage("You have signed out.");
          return;
        }
        if (sessionIdentity(currentSession.current) !== sessionIdentity(s)) {
          ++sessionVersion.current;
          // A newer identity/transition cancels the old button operation too.
          setBusy(false);
        }
        version = sessionVersion.current;
        currentSession.current = s;
        setState(s);
        setHubSession(s);
        setTransition(s.endpointTransition);
        if (!s.endpointTransition) {
          setTransitioning(false);
          setMigrationReview("");
          setRecoveries(null);
          setReviewConfirmed(false);
        }
        if (!s.enabled) {
          setReady(true);
          return;
        }
        if (!s.authenticated) {
          setReady(false);
          setMigrationReview("");
          setRecoveries(null);
          setReviewConfirmed(false);
          stopProfile();
          setActiveProfile(null);
          hydrated.current = null;
          setMessage(
            s.branchAvailable === false
              ? "This Atlas address is not connected to the Hub. Open the Hub for an available link."
              : s.blocked
                ? "Your account does not currently have browsing access."
                : "Sign in to access your saved browser.",
          );
          return;
        }
        const identity =
          s.grant!.profileId +
          ":" +
          s.grant!.contextId +
          ":" +
          s.grant!.sessionId;
        if (hydrated.current === identity) {
          if (s.endpointTransition) {
            setTransitioning(true);
            setError("");
            setMessage(
              "This Atlas address has been replaced. Saving your browser before returning to Hub…",
            );
            await prepareProfileReplacement();
            if (!live || signingOut.current || version !== sessionVersion.current) return;
            location.assign(new URL(s.endpointTransition.hubOrigin).origin);
            return;
          }
          setReady(true);
          setError("");
          return;
        }
        setReady(false);
        setMigrationReview("");
        setRecoveries(null);
        setReviewConfirmed(false);
        setActiveProfile(s.grant!.profileId);
        setMessage("Restoring your browser…");
        const result = await initializeHubCloud(s);
        if (!live || signingOut.current || version !== sessionVersion.current) return;
        if (result.ready) hydrated.current = identity;
        if (result.ready && s.endpointTransition) {
          setReady(false);
          setTransitioning(true);
          setMessage("Saving your browser before returning to Hub…");
          await prepareProfileReplacement();
          if (!live || signingOut.current || version !== sessionVersion.current) return;
          location.assign(new URL(s.endpointTransition.hubOrigin).origin);
          return;
        }
        setReady(result.ready);
        setTransitioning(false);
        setMessage(
          result.message || "Your profile is not ready. Retry to continue.",
        );
        setError("");
      } catch (e) {
        if (live && !signingOut.current && version === sessionVersion.current) {
          if ((e as { code?: string }).code === "PROFILE_MIGRATION_REVIEW_REQUIRED") {
            setMigrationReview((e as Error).message);
            setError("");
          } else setError((e as Error).message);
        }
      } finally {
        pending = false;
        if (live) setLoading(false);
      }
    }
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    const resume = () => void load();
    addEventListener("online", resume);
    addEventListener("pageshow", resume);
    return () => {
      live = false;
      ++sessionVersion.current;
      clearInterval(t);
      removeEventListener("online", resume);
      removeEventListener("pageshow", resume);
    };
  }, [attempt]);
  async function signin() {
    signingOut.current = false;
    const version = ++sessionVersion.current;
    localStorage.removeItem("atlas.hub.signed-out");
    setMessage("Signing you in…");
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/hub/signin", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo: location.pathname + location.search }),
      });
      const data = await r.json();
      if (!r.ok)
        throw Error(
          data.error?.message || data.error || "Sign-in could not start.",
        );
      const url = new URL(data.redirect);
      if (url.origin !== state?.hubOrigin || url.pathname !== "/authorize")
        throw Error("The sign-in destination was invalid.");
      if (signingOut.current || version !== sessionVersion.current) return;
      location.assign(url.href);
    } catch (e) {
      if (!signingOut.current && version === sessionVersion.current) {
        setError((e as Error).message);
        setBusy(false);
      }
    }
  }
  async function logout() {
    signingOut.current = true;
    ++sessionVersion.current;
    currentSession.current = null;
    setMigrationReview("");
    setRecoveries(null);
    setReviewConfirmed(false);
    setTransition(undefined);
    setTransitioning(false);
    setLoading(false);
    localStorage.setItem("atlas.hub.signed-out", "true");
    setBusy(true);
    setError("");
    let savedLocallyOnly = false;
    try {
      window.dispatchEvent(new CustomEvent("atlas:profile-quiesce"));
      const localFirst = !!getLocalFirstProfile();
      await flushProfile();
      if (localFirst) {
        stopProfile();setActiveProfile(null);setHubSession(null);hydrated.current=null;setReady(false);
        setState(s=>s?{...s,authenticated:false,grant:undefined,csrf:undefined}:null);
      }
    } catch {
      savedLocallyOnly = true;
    }
    localStorage.setItem("atlas.hub.signed-out", "true");
    setBusy(true);
    try {
      await fetch("/api/hub/logout", {
        signal: AbortSignal.timeout(8000),
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-atlas-hub-csrf": state?.csrf || "",
        },
        body: "{}",
      });
    } catch {
      /* Explicit local sign-out never waits for a healthy Hub. */
    } finally {
      hydrated.current = null;
      setHubSession(null);
      stopProfile();
      setActiveProfile(null);
      setState((s) =>
        s
          ? { ...s, authenticated: false, grant: undefined, csrf: undefined }
          : null,
      );
      setReady(false);
      setBusy(false);
      setMessage(
        savedLocallyOnly
          ? "You have signed out. Unsynced saves remain on this browser for your next sign-in."
          : "You have signed out.",
      );
    }
  }
  async function continueAfterReview() {
    if (!reviewConfirmed || busy || !transition) return;
    setBusy(true);
    setError("");
    const version = sessionVersion.current;
    try {
      await prepareProfileReplacement({ acceptRecoveredSaves: true });
      if (signingOut.current || version !== sessionVersion.current ||
          sessionIdentity(currentSession.current) !== sessionIdentity(state)) return;
      location.assign(new URL(transition.hubOrigin).origin);
    } catch (e) {
      if (!signingOut.current && version === sessionVersion.current) setError((e as Error).message);
    } finally {
      if (version === sessionVersion.current) setBusy(false);
    }
  }
  const reviewActions = migrationReview ? <>
    <p className="migration-review-summary">{migrationReview}</p>
    <p className="migration-review-summary">Continue uses the account’s current saves. Different older versions are not merged or substituted. Keep this old address available until you have checked your saves.</p>
    <button className="secondary" disabled={busy} onClick={() => {
      setError("");
      const version = sessionVersion.current;
      void listProfileRecoveries().then(v => {
        if (!signingOut.current && version === sessionVersion.current) setRecoveries(v.recoveries);
      }).catch(e => { if (!signingOut.current && version === sessionVersion.current) setError(e.message); });
    }}>View recovered saves</button>
    {recoveries && <section className="migration-recoveries" aria-label="Recovered saves">
      {recoveries.length ? recoveries.map(r => <button key={r.id} className="secondary" disabled={busy} onClick={() => {
        setError("");
        const version = sessionVersion.current;
        void downloadProfileRecovery(r.id).catch(e => {
          if (!signingOut.current && version === sessionVersion.current) setError(e.message);
        });
      }}>Download {new Date(r.createdAt).toLocaleString()}<span>{r.namespace} · {Math.ceil(r.bytes / 1024)} KiB</span></button>) : <p>No recovered saves are available.</p>}
    </section>}
    <label className="migration-review-check"><input type="checkbox" checked={reviewConfirmed} disabled={busy} onChange={e => setReviewConfirmed(e.target.checked)} /><span>I understand that continuing does not replace account saves with different older versions.</span></label>
    <button disabled={!reviewConfirmed || busy} onClick={() => void continueAfterReview()}>{busy ? "Saving before transfer…" : "Continue with account saves"}</button>
    <button className="secondary" disabled={busy} onClick={() => void logout()}>Sign out</button>
  </> : null;
  if (ready)
    return (
      <>
        {error && !transitioning && (
          <div className="hub-gate-banner" role="alert">
            {error}
            <button onClick={() => setAttempt((v) => v + 1)}>Retry</button>
          </div>
        )}
        <div className="hub-preserved-app" inert={transitioning || undefined} aria-hidden={transitioning || undefined}>{children}</div>
        {transitioning && <div className="hub-transition-overlay">
          <AtlasEntryFrame title={migrationReview ? "Review older saves" : "This address has moved"} message={migrationReview ? "Your older data needs a review before you leave this address." : message} pending={migrationReview ? busy : loading || busy} error={error}>
            {reviewActions}
            {!migrationReview && error && !loading && <button onClick={() => setAttempt(v => v + 1)}>Retry transfer</button>}
          </AtlasEntryFrame>
        </div>}
      </>
    );
  const importing = !!state?.authenticated && !!profileStatus.importing;
  const pending = migrationReview ? busy : loading || busy;
  const heading = migrationReview ? "Review older saves" : pending
    ? "Opening Atlas"
    : !state
    ? error ? "Atlas could not open" : "Opening Atlas"
    : transition
      ? "This address has moved"
      : state.blocked
        ? "Browsing access unavailable"
        : state.branchAvailable === false
          ? "This link is unavailable"
          : state.authenticated
            ? importing ? "Set up your browser" : "Restoring your browser"
            : "Welcome to Atlas";
  const progress=restoreProgress?restorePresentation(restoreProgress):undefined;
  function continueLocally(){
    const g=currentSession.current?.grant;if(!g)return;
    if(loading)dispatchEvent(new CustomEvent("atlas:backup-restore-skip",{detail:{profileId:g.profileId,contextId:g.contextId,sessionId:g.sessionId}}));
    else {sessionStorage.setItem("atlas.backup.skip-once:"+g.profileId,g.contextId);setAttempt(v=>v+1);}
  }
  return (
    <AtlasEntryFrame title={heading} message={migrationReview ? "Your older data needs a review before you leave this address." : importing ? profileStatus.message : message} pending={pending} error={error}>
      {restoreProgress && progress && restoreProgress.phase!=="error" && <section className="entry-restore-progress" aria-label="Backup restore">
        <div className="entry-progress-track" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
          <span className={progress.percent===undefined?"indeterminate":undefined} style={progress.percent===undefined?undefined:{width:progress.percent+"%"}}/>
        </div>
        <div className="entry-progress-caption"><span>{progress.label}</span><span>{progress.percent===undefined?"":progress.percent+"%"}</span></div>
        {progress.eta&&<p className="entry-progress-eta">{progress.eta}</p>}
      </section>}
      {restoreProgress && !["finalizing","ready"].includes(restoreProgress.phase) && state?.authenticated && <div className="entry-restore-choice">
        <button className="secondary" onClick={continueLocally}>Continue without restoring</button>
        <p>Your cloud backup stays saved. This link will use separate local data.</p>
      </div>}
      {reviewActions}
      {!pending && state?.enabled && !state.authenticated && state.branchAvailable !== false && (
        <button onClick={() => void signin()}>Sign in<ArrowUpRight size={16} aria-hidden="true" /></button>
      )}
      {importing && (
        <button className="secondary entry-cancel" onClick={() => dispatchEvent(new CustomEvent("atlas:profile-cancel-import"))}>Skip import</button>
      )}
      {!migrationReview && !loading && !busy && (error || state?.authenticated) && (
        <button onClick={() => setAttempt((v) => v + 1)}>Retry</button>
      )}
      {!migrationReview && !pending && state?.hubOrigin && <a href={state.hubOrigin}>Open Atlas Hub<ArrowUpRight size={16} aria-hidden="true" /></a>}
      {!migrationReview && !pending && state?.authenticated && <button className="secondary" onClick={() => void logout()}>Sign out</button>}
    </AtlasEntryFrame>
  );
}
