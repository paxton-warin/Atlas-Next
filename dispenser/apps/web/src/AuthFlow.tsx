import { ArrowLeft, Check, ExternalLink, FileText, Mail } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, post, setCsrf } from "./api";
import { AtlasBrandMark } from "./AtlasBrandMark";
import { Button, Card, Field, Input, Notice } from "./ui";
type Step = {
  verificationId: string;
  email: string;
  expiresAt: string;
  codeLength: number;
  driveUrl: string;
};
const savedStep = () => {
  try {
    const value = sessionStorage.getItem("atlas-verification");
    if (!value) return undefined;
    const step = JSON.parse(value) as Step;
    return new Date(step.expiresAt) > new Date() ? step : undefined;
  } catch {
    return undefined;
  }
};
export function AuthFlow({
  initialized,
  onAuthenticated,
  hubEnabled = false,
}: {
  hubEnabled?: boolean;
  initialized: boolean;
  onAuthenticated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<Step | undefined>(savedStep);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [bootstrap] = useState(!initialized);
  const [token, setToken] = useState("");
  const recovery = window.location.pathname === "/adminrecovery";
  const [help, setHelp] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step) codeRef.current?.focus();
  }, [step]);
  const request = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await post<Step>("/auth/request", {
        email: email || step?.email,
      });
      setStep(next);
      setEmail(next.email);
      sessionStorage.setItem("atlas-verification", JSON.stringify(next));
      setCode("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Unable to send the file.",
      );
    } finally {
      setBusy(false);
    }
  };
  const verify = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!step || code.length !== step.codeLength) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ csrfToken: string }>("/auth/verify", {
        verificationId: step.verificationId,
        code,
      });
      sessionStorage.removeItem("atlas-verification");
      setCsrf(result.csrfToken);
      onAuthenticated();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "That code did not work.",
      );
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (step && code.length === step.codeLength) void verify();
  }, [code, step?.codeLength]);
  const setup = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ csrfToken: string }>("/setup/bootstrap", {
        method: "POST",
        body: JSON.stringify({ email, token }),
        headers: { "content-type": "application/json" },
      });
      setCsrf(result.csrfToken);
      onAuthenticated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Setup failed.");
    } finally {
      setBusy(false);
    }
  };
  const recover = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ csrfToken: string }>("/setup/recover", {
        method: "POST",
        body: JSON.stringify({ email, token }),
      });
      setCsrf(result.csrfToken);
      onAuthenticated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  };
  if (bootstrap)
    return (
      <AuthLayout hubEnabled={hubEnabled}>
        <Card className="auth-card">
          <span className="auth-icon">
            <Check />
          </span>
          <h1>
            {hubEnabled ? "Set up Atlas Hub" : "Set up Atlas Link Dispenser"}
          </h1>
          <p>
            Create the first administrator using the email and one-time token
            from your server configuration.
          </p>
          <form className="stack" onSubmit={setup}>
            <Field label="Administrator email">
              <Input
                autoFocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Bootstrap token">
              <Input
                type="password"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button tone="primary" busy={busy} type="submit">
              Create administrator
            </Button>
          </form>
        </Card>
      </AuthLayout>
    );
  if (recovery)
    return (
      <AuthLayout hubEnabled={hubEnabled}>
        <Card className="auth-card">
          <span className="auth-icon">
            <Check />
          </span>
          <h1>Administrator recovery</h1>
          <p>
            Use the administrator email and bootstrap token from the server
            configuration.
          </p>
          <form className="stack" onSubmit={recover}>
            <Field label="Administrator email">
              <Input
                autoFocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Bootstrap token">
              <Input
                type="password"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button tone="primary" busy={busy} type="submit">
              Recover administrator session
            </Button>
            <Button
              tone="ghost"
              type="button"
              onClick={() => {
                window.location.assign("/");
              }}
            >
              <ArrowLeft size={15} /> Back to verification
            </Button>
          </form>
        </Card>
      </AuthLayout>
    );
  if (!step)
    return (
      <AuthLayout hubEnabled={hubEnabled}>
        <Card className="auth-card">
          <span className="auth-icon">
            <Mail />
          </span>
          <h1>{hubEnabled ? "Sign in to Hub" : "Verify your email"}</h1>
          <p>Enter the Google account you want to use.</p>
          <form className="stack" onSubmit={request}>
            <Field label="Email address">
              <Input
                autoFocus
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button tone="primary" busy={busy} type="submit">
              Continue
            </Button>
          </form>
        </Card>
      </AuthLayout>
    );
  return (
    <AuthLayout hubEnabled={hubEnabled}>
      <Card className="auth-card auth-card--wide">
        <span className="auth-icon">
          <FileText />
        </span>
        <h1>Check Google Drive</h1>
        <p>
          We shared a verification file with <strong>{step.email}</strong>.
        </p>
        <p className="auth-quick-steps">
          Open the file, copy the verification code, then paste it below.
        </p>
        <a
          className="button button--primary auth-open-file"
          href={
            step.driveUrl || "https://drive.google.com/drive/shared-with-me"
          }
          target="_blank"
          rel="noreferrer"
        >
          Open your verification file <ExternalLink size={16} />
        </a>
        <form className="stack code-form" onSubmit={verify}>
          <Field label="Verification code">
            <Input
              ref={codeRef}
              className="code-input"
              aria-label={`${step.codeLength} digit verification code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={step.codeLength}
              placeholder={"•".repeat(step.codeLength)}
              value={code}
              onChange={(e) =>
                setCode(
                  e.target.value.replace(/\D/g, "").slice(0, step.codeLength),
                )
              }
            />
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button
            tone="primary"
            busy={busy}
            disabled={code.length !== step.codeLength}
            type="submit"
          >
            Verify
          </Button>
        </form>
        <div className="auth-secondary auth-secondary--verification">
          <Button tone="ghost" disabled={busy} onClick={() => void request()}>
            Send another file
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              sessionStorage.removeItem("atlas-verification");
              setStep(undefined);
              setCode("");
              setError("");
            }}
          >
            <ArrowLeft size={15} /> Use a different email
          </Button>
          <Button tone="ghost" onClick={() => setHelp(!help)}>
            Need help?
          </Button>
        </div>
        {help && (
          <Notice tone="info">
            <strong>Can’t find the file?</strong> Open the Google sharing email
            sent to {step.email}. If it is missing, check Google Drive’s{" "}
            <a
              href="https://drive.google.com/drive/shared-with-me"
              target="_blank"
              rel="noreferrer"
            >
              Shared with me
            </a>{" "}
            page and search for “Atlas Verification Code.” Atlas verifies this
            way to reduce automated abuse; Google sharing is also more reliable
            than outside email in many managed school workspaces.
          </Notice>
        )}
      </Card>
    </AuthLayout>
  );
}
function AuthLayout({
  children,
  hubEnabled = false,
}: {
  children: React.ReactNode;
  hubEnabled?: boolean;
}) {
  return (
    <main className="auth-layout">
      <div className="brand">
        <AtlasBrandMark />
        <div>
          <strong>Atlas</strong>
          <small>{hubEnabled ? "Hub" : "Link Dispenser"}</small>
        </div>
      </div>
      {children}
      <p className="auth-footnote">Atlas{hubEnabled ? " Hub" : " Link Dispenser"}</p>
    </main>
  );
}
