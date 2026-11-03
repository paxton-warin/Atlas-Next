import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "@atlas-link-dispenser/shared";
import type { ManualVerificationState } from "@atlas-link-dispenser/shared";
import { HubSupport } from "./HubSupport";
import { HubAuthorize } from "./HubAuthorize";
import { Admin } from "./Admin";
import { api, post, setCsrf } from "./api";
import {
  HubSessionTransfer,
  HubSessionRestoring,
  HUB_TRANSFER_SIGNED_OUT,
  HUB_TRANSFER_ATTEMPTS,
  clearHubTransferSignOut,
} from "./HubSessionTransfer";
import { AuthFlow } from "./AuthFlow";
import { Notice } from "./ui";
import { HubEntry } from "./HubEntry";
import { HubLaunchLink } from "./EntryLaunchLink";
import { UserDashboard } from "./UserDashboard";
import {
  ManualVerification,
  requiresManualVerification,
} from "./ManualVerification";

type SessionState = {
  user: PublicUser | null;
  csrfToken: string | null;
  manualVerification?: ManualVerificationState;
};

export function hubRestorePending(enabled: boolean, initialized: boolean, userPresent: boolean, checked: boolean, restoring: boolean) {
  return !userPresent && (restoring || (enabled && initialized && !checked));
}
export function App() {
  const [hubEnabled, setHubEnabled] = useState(false);
  useEffect(() => {
    document.title = hubEnabled ? "Atlas Hub" : "Atlas Link Dispenser";
  }, [hubEnabled]);
  const [initialized, setInitialized] = useState<boolean>();
  const [session, setSession] = useState<SessionState>();
  const [error, setError] = useState("");
  const [authCompleting, setAuthCompleting] = useState(false);
  const transferStarted = useRef(false),
    [restoringHub, setRestoringHub] = useState(false),
    [transferChecked, setTransferChecked] = useState(false);
  const [admin, setAdmin] = useState(() =>
    new URLSearchParams(location.search).has("admin"),
  );

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [setup, current, hub] = await Promise.all([
        api<{ initialized: boolean }>("/setup/status"),
        api<SessionState>("/session"),
        api<{ enabled: boolean }>("/hub/config").catch(() => ({
          enabled: false,
        })),
      ]);
      setHubEnabled(hub.enabled);
      setInitialized(setup.initialized);
      setSession(current);
      setCsrf(current.csrfToken);
      if (current.user) setAuthCompleting(false);
      return !!current.user;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Atlas could not start.",
      );
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const update = () => void refresh();
    addEventListener("atlas:manual-verification-required", update);
    return () =>
      removeEventListener("atlas:manual-verification-required", update);
  }, [refresh]);
  useEffect(() => {
    const navigate = () =>
      setAdmin(new URLSearchParams(location.search).has("admin"));
    addEventListener("popstate", navigate);
    return () => removeEventListener("popstate", navigate);
  }, []);

  useEffect(() => {
    if (
      !hubEnabled ||
      !initialized ||
      !session ||
      session.user ||
      location.pathname.startsWith("/hub/session-transfer/") ||
      transferStarted.current
    )
      return;
    try {
      if (localStorage.getItem(HUB_TRANSFER_SIGNED_OUT) === "true") { setTransferChecked(true); return; }
    } catch {
      setTransferChecked(true); return;
    }
    transferStarted.current = true;
    setRestoringHub(true);
    void (async () => {
      const value = await api<{ sources: string[] }>(
        "/hub/session-transfer/availability",
      );
      let attempted: string[] = [];
      try {
        const parsed = JSON.parse(
          sessionStorage.getItem(HUB_TRANSFER_ATTEMPTS) || "[]",
        );
        if (Array.isArray(parsed))
          attempted = parsed.filter((v) => typeof v === "string");
      } catch {}
      const source = value.sources.find(
        (origin) => !attempted.includes(origin),
      );
      if (!source) {
        setRestoringHub(false); setTransferChecked(true);
        return;
      }
      sessionStorage.setItem(
        HUB_TRANSFER_ATTEMPTS,
        JSON.stringify([...attempted, source].slice(-8)),
      );
      const result = await post<{ redirect: string }>(
        "/hub/session-transfer/start",
        { source, returnTo: location.pathname + location.search },
      );
      const redirect = new URL(result.redirect);
      if (redirect.origin !== source && redirect.origin !== location.origin)
        throw Error("Unexpected Hub destination.");
      location.assign(redirect.href);
    })().catch(() => { setRestoringHub(false); setTransferChecked(true); });
  }, [hubEnabled, initialized, session]);

  const exitAdmin = () => {
    history.pushState(null, "", "/");
    setAdmin(false);
  };
  const logout = () => {
    setAuthCompleting(false);
    localStorage.setItem(HUB_TRANSFER_SIGNED_OUT, "true");
    setTransferChecked(true);
    setCsrf(null);
    setSession({ user: null, csrfToken: null });
    exitAdmin();
  };

  const confirmSignIn = async () => {
    setAuthCompleting(true);
    if (!(await refresh())) setError("Sign-in could not be confirmed. Retry your connection.");
  };
  if (error && initialized === undefined)
    return <HubEntry title="Atlas could not open" stage="Check your connection and try again." busy={false}>
      <Notice tone="danger">{error}</Notice>
      <button className="button button--primary" onClick={() => void refresh()}>Try again</button>
    </HubEntry>;
  if (initialized === undefined || session === undefined)
    return <HubEntry stage="Checking your Atlas session…" />;
  if (authCompleting && !session.user)
    return <HubEntry stage={error ? "Sign-in needs another check." : "Finishing sign-in…"} busy={!error}>
      {error && <><Notice tone="danger">{error}</Notice><button className="button button--primary" onClick={() => void confirmSignIn()}>Retry</button></>}
    </HubEntry>;
  if (hubEnabled && location.pathname.startsWith("/hub/session-transfer/"))
    return <HubSessionTransfer />;
  // Discovery begins in an effect, but its unresolved UI is decided in this render.
  // A replacement Hub must never briefly show a new-auth form before checking carryover.
  if (hubRestorePending(hubEnabled, initialized, !!session.user, transferChecked, restoringHub)) return <HubSessionRestoring />;
  if (!session.user)
    return (
      <AuthFlow
        hubEnabled={hubEnabled}
        initialized={initialized}
        onAuthenticated={() => {
          clearHubTransferSignOut();
          void confirmSignIn();
        }}
      />
    );
  if (admin && session.user.role === "admin")
    return <><HubLaunchLink key={session.user.id} userId={session.user.id} /><Admin key={session.user.id} user={session.user} onLogout={logout} onExit={exitAdmin} /></>;
  if (hubEnabled && location.pathname === "/support")
    return (
      <><HubLaunchLink key={session.user.id} userId={session.user.id} /><main className="user-shell hub-standalone-support">
        <header className="user-header">
          <strong>Atlas Hub · Support</strong>
          <a href="/" className="button">
            Back to Hub
          </a>
        </header>
        <div className="hub-standalone-support-content"><HubSupport key={session.user.id} /></div>
      </main></>
    );
  if (requiresManualVerification(session.user, session.manualVerification))
    return (
      <ManualVerification
        hubEnabled={hubEnabled}
        user={session.user}
        initial={session.manualVerification!}
        onApproved={() => void refresh()}
        onLogout={logout}
      />
    );
  if (location.pathname === "/authorize")
    return <HubAuthorize enabled={hubEnabled} />;
  return (
    <><HubLaunchLink key={session.user.id} userId={session.user.id} /><UserDashboard
      key={session.user.id}
      user={session.user}
      onLogout={logout}
      hubEnabled={hubEnabled}
    /></>
  );
}
