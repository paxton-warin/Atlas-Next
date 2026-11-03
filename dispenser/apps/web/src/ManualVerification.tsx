import { useEffect, useRef, useState, type FormEvent } from "react";
import { LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import type {
  ManualVerificationRequest,
  ManualVerificationState,
  PublicUser,
} from "@atlas-link-dispenser/shared";
import { api, post, put } from "./api";
import { Badge, Button, Card, Field, Input, Notice, Textarea } from "./ui";

export const requiresManualVerification = (
  user: PublicUser,
  state?: ManualVerificationState,
) => user.role !== "admin" && state?.required === true;

export const verificationDraft = (
  request: ManualVerificationRequest | null,
) => ({
  name: request?.name ?? "",
  schoolName: request?.schoolName ?? "",
  additionalInformation: request?.additionalInformation ?? "",
  revision: request?.revision ?? 0,
});

export function ManualVerification({
  user,
  initial,
  onApproved,
  onLogout,
  hubEnabled = false,
}: {
  hubEnabled?: boolean;
  user: PublicUser;
  initial: ManualVerificationState;
  onApproved: () => void;
  onLogout: () => void;
}) {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState(() => verificationDraft(initial.request));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const callbacks = useRef({ onApproved });
  callbacks.current = { onApproved };

  useEffect(() => {
    let active = true;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await api<ManualVerificationState>("/manual-verification");
        if (!active) return;
        setState(next);
        if (!next.required) callbacks.current.onApproved();
      } catch {
        // Keep the saved request and local edits intact during a temporary outage.
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await put<ManualVerificationState>(
        "/manual-verification",
        draft,
      );
      setState(next);
      setDraft(verificationDraft(next.request));
      setSaved(true);
      if (!next.required) onApproved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save your request.",
      );
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setError("");
    try {
      const next = await api<ManualVerificationState>("/manual-verification");
      setState(next);
      if (!next.required) onApproved();
      // Deliberately do not overwrite a draft or advance its revision on refresh.
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not refresh your request.",
      );
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await post("/logout");
      onLogout();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not sign out.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="user-shell">
      <header className="user-header">
        <div className="brand brand--small">
          <span>A</span>
          <div>
            <strong>Atlas</strong>
            <small>{hubEnabled ? "Hub" : "Link Dispenser"}</small>
          </div>
        </div>
        <div className="user-header__account">
          <span>{user.email}</span>
          {hubEnabled && <a className="button button--ghost" href="/support">Support</a>}
          <Button tone="ghost" disabled={busy} onClick={() => void logout()}>
            <LogOut size={16} /> Sign out
          </Button>
        </div>
      </header>
      <section className="user-content manual-verification">
        <Card className="stack">
          <div className="auth-icon">
            <ShieldCheck />
          </div>
          <VerificationHeading state={state} />
          {error && <Notice tone="danger">{error}</Notice>}
          {saved && <Notice tone="success">Request saved.</Notice>}
          <ManualVerificationForm
            draft={draft}
            submitted={Boolean(state.request)}
            busy={busy}
            onChange={(value) => {
              setDraft(value);
              setSaved(false);
            }}
            onSubmit={submit}
          />
          <div className="button-row">
            <Button disabled={busy} onClick={() => void refresh()}>
              <RefreshCw size={16} /> Check status
            </Button>
            {state.request && state.request.revision !== draft.revision && (
              <Button
                disabled={busy}
                onClick={() => {
                  setDraft(verificationDraft(state.request));
                  setError("");
                }}
              >
                Load saved request
              </Button>
            )}
          </div>
        </Card>
      </section>
    </main>
  );
}

export function VerificationHeading({
  state,
}: {
  state: ManualVerificationState;
}) {
  const pending = state.status === "pending";
  const denied = state.status === "denied";
  return (
    <div className="stack">
      <div className="manual-verification__heading">
        <h1>Manual verification</h1>
        {state.request && (
          <Badge tone={denied ? "danger" : "warning"}>
            {denied ? "Denied" : pending ? "Pending review" : state.status}
          </Badge>
        )}
      </div>
      <p>
        {denied
          ? "Your request was denied. You can update it for the administrator to review."
          : pending
            ? "Your request is awaiting review. You can edit it below."
            : "An administrator needs to verify your account before you can access links."}
      </p>
      {state.request?.reviewNote && (
        <Notice tone={denied ? "danger" : "info"}>
          {state.request.reviewNote}
        </Notice>
      )}
    </div>
  );
}

export function ManualVerificationForm({
  draft,
  submitted,
  busy,
  onChange,
  onSubmit,
}: {
  draft: ReturnType<typeof verificationDraft>;
  submitted: boolean;
  busy: boolean;
  onChange: (value: ReturnType<typeof verificationDraft>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="stack" onSubmit={onSubmit}>
      <Field label="Name">
        <Input
          required
          autoComplete="name"
          maxLength={160}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field label="School name">
        <Input
          required
          autoComplete="organization"
          maxLength={200}
          value={draft.schoolName}
          onChange={(event) =>
            onChange({ ...draft, schoolName: event.target.value })
          }
        />
      </Field>
      <Field label="Additional information">
        <Textarea
          required
          rows={5}
          maxLength={5000}
          value={draft.additionalInformation}
          onChange={(event) =>
            onChange({ ...draft, additionalInformation: event.target.value })
          }
        />
      </Field>
      <Button tone="primary" type="submit" busy={busy}>
        {submitted ? "Save changes" : "Submit request"}
      </Button>
    </form>
  );
}
