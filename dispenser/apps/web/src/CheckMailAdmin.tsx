import { useState, type FormEvent } from "react";
import { MailCheck, Plus, RefreshCw } from "lucide-react";
import { api, del, post, put } from "./api";
import { useData } from "./pagination";
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

export interface CheckMailRule {
  id: string;
  kind: "exact" | "domain" | "regex";
  pattern: string;
  enabled: boolean;
  note: string;
}
export interface CheckMailConfig {
  enabled: boolean;
  configured: boolean;
  monthlyLimit: number;
  used: number;
  remaining: number;
  providerRemaining: number | null;
  periodStart: string;
  periodEnd: string;
  allowlist: CheckMailRule[];
}
export interface CheckMailTestResult {
  skipped: boolean;
  reason: "existing_account" | "allowlist" | "disabled" | "check_required";
  matchedRule?: CheckMailRule;
}
export function describeCheckMailTest(result: CheckMailTestResult) {
  switch (result.reason) {
    case "existing_account":
      return "Existing account: Check-Mail is skipped. Returning accounts use no Check-Mail requests.";
    case "allowlist":
      return `Whitelist match: Check-Mail is skipped${result.matchedRule ? ` (${result.matchedRule.note || result.matchedRule.pattern})` : ""}. Ordinary email rules still apply.`;
    case "disabled":
      return "Check-Mail is disabled: no provider request would be made.";
    case "check_required":
      return "New account with no whitelist match: Check-Mail would be required. This test made no provider request.";
  }
}
export function checkMailSettingsBody(
  enabled: boolean,
  monthlyLimit: number,
  apiKey: string,
  clearApiKey: boolean,
) {
  return {
    enabled: clearApiKey ? false : enabled,
    monthlyLimit,
    ...(clearApiKey
      ? { clearApiKey: true }
      : apiKey.trim()
        ? { apiKey: apiKey.trim() }
        : {}),
  };
}
const blankRule: Omit<CheckMailRule, "id"> = {
  kind: "domain",
  pattern: "",
  enabled: true,
  note: "",
};
const ruleTypes = { exact: "Exact email", domain: "Domain", regex: "Regex" };

export function CheckMailAdmin() {
  const state = useData(() => api<CheckMailConfig>("/admin/check-mail"));
  const [editor, setEditor] = useState<CheckMailRule | "new">();
  const [remove, setRemove] = useState<CheckMailRule>();
  return (
    <>
      <PageHeader
        eyebrow="Registration"
        title="Check-Mail"
        description="Reject disposable emails for new accounts without spending requests on returning users or trusted addresses."
        actions={
          <Button onClick={() => void state.reload()} disabled={state.loading}>
            <RefreshCw size={16} /> Refresh
          </Button>
        }
      />
      <div className="stack">
        <Notice>
          Only new accounts are checked. This whitelist bypasses Check-Mail
          only; it does not override ordinary email deny rules, sign-in policy,
          or verification requirements.
        </Notice>
        {state.error && (
          <Notice tone="danger">
            {state.error}{" "}
            <Button onClick={() => void state.reload()}>Retry</Button>
          </Notice>
        )}
        {state.loading ? (
          <Loading />
        ) : state.data ? (
          <>
            <CheckMailUsage value={state.data} />
            <CheckMailSettings
              value={state.data}
              onSaved={() => state.reload()}
            />
            <CheckMailTester />
            <Card className="stack">
              <div>
                <h2>Provider-bypass whitelist</h2>
                <p>
                  Add trusted domains such as <code>fcpsschools.net</code>,
                  exact addresses, or safe regex patterns. Matching new accounts
                  do not spend Check-Mail requests.
                </p>
                <Button tone="primary" onClick={() => setEditor("new")}>
                  <Plus size={16} /> Add whitelist rule
                </Button>
              </div>
              {!state.data.allowlist.length ? (
                <Empty title="No whitelist rules">
                  Add a trusted domain or address to save provider requests.
                </Empty>
              ) : (
                <div
                  className="table-wrap"
                  tabIndex={0}
                  aria-label="Check-Mail whitelist"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Pattern</th>
                        <th>Status</th>
                        <th>Note</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.allowlist.map((rule) => (
                        <tr key={rule.id}>
                          <td>{ruleTypes[rule.kind]}</td>
                          <td style={{ overflowWrap: "anywhere" }}>
                            <code>{rule.pattern}</code>
                          </td>
                          <td>
                            <Badge tone={rule.enabled ? "success" : "neutral"}>
                              {rule.enabled ? "Enabled" : "Disabled"}
                            </Badge>
                          </td>
                          <td>{rule.note || "—"}</td>
                          <td>
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: ".4rem",
                              }}
                            >
                              <Button
                                aria-label={`Edit ${rule.pattern}`}
                                onClick={() => setEditor(rule)}
                              >
                                Edit
                              </Button>
                              <Button
                                tone="danger"
                                aria-label={`Delete ${rule.pattern}`}
                                onClick={() => setRemove(rule)}
                              >
                                Delete
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        ) : null}
      </div>
      {editor && (
        <CheckMailRuleEditor
          key={editor === "new" ? "new" : editor.id}
          value={editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            void state.reload();
          }}
        />
      )}
      {remove && (
        <CheckMailRuleRemoval
          rule={remove}
          onClose={() => setRemove(undefined)}
          onRemoved={() => {
            setRemove(undefined);
            void state.reload();
          }}
        />
      )}
    </>
  );
}

export function CheckMailUsage({ value }: { value: CheckMailConfig }) {
  return (
    <Card className="stack">
      <div>
        <h2>Request budget</h2>
        <p>
          Local guard: <strong>{value.used.toLocaleString()}</strong> used ·{" "}
          <strong>{value.remaining.toLocaleString()}</strong> remaining of{" "}
          <strong>{value.monthlyLimit.toLocaleString()}</strong> allowed per
          30-day window. Your provider plan allows 1,000 requests per month.
        </p>
        <p>
          Window: {formatDate(value.periodStart)} –{" "}
          {formatDate(value.periodEnd)}. The local budget is a guard, not the
          provider's billing counter.
        </p>
        <p>
          Provider remaining:{" "}
          <strong>
            {value.providerRemaining === null
              ? "Not yet reported"
              : value.providerRemaining.toLocaleString()}
          </strong>
          . Refreshing this page and testing whitelist decisions never contact
          Check-Mail.
        </p>
      </div>
      {value.remaining <= 0 && (
        <Notice tone="warning">
          The local request budget is exhausted. New accounts requiring a
          provider check must wait; returning accounts and whitelist matches
          still use no requests.
        </Notice>
      )}
    </Card>
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not started"
    : date.toLocaleDateString();
}
export function CheckMailSettings({
  value,
  onSaved,
}: {
  value: CheckMailConfig;
  onSaved: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(value.enabled);
  const [limit, setLimit] = useState(value.monthlyLimit);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    const body = checkMailSettingsBody(enabled, limit, apiKey, clearKey);
    // Keep no persisted browser copy, and remove the input value on submission.
    setApiKey("");
    try {
      await put("/admin/check-mail", body);
      setClearKey(false);
      setSaved(true);
      await onSaved();
    } catch {
      // Provider/configuration failures must not echo the submitted credential.
      setError(
        "Could not save Check-Mail settings. Check the request limit and key, then try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="stack">
      <div>
        <h2>Provider settings</h2>
        <Badge tone={value.configured ? "success" : "warning"}>
          {value.configured ? "API key configured" : "API key not configured"}
        </Badge>
        <p>
          Set the key here. No environment configuration or restart is needed.
          Saving a key does not make a paid verification request.
        </p>
      </div>
      <form className="stack" onSubmit={(event) => void save(event)}>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled && !clearKey}
            disabled={busy || clearKey}
            onChange={(event) => setEnabled(event.target.checked)}
          />{" "}
          Check disposable emails for new accounts
        </label>
        <div className="form-grid">
          <Field
            label={value.configured ? "Replace API key" : "API key"}
            hint={
              value.configured
                ? "Leave blank to keep the saved key. The saved key is never returned to the browser."
                : "Stored encrypted on the server. Paste your Check-Mail API key."
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={busy || clearKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          <Field
            label="Local request limit"
            hint="1–1,000 requests in a 30-day window. Set this below your plan limit to reserve credits for other uses."
          >
            <Input
              type="number"
              min={1}
              max={1000}
              step={1}
              required
              value={limit}
              disabled={busy}
              onChange={(event) => setLimit(Number(event.target.value))}
            />
          </Field>
        </div>
        {value.configured && (
          <label className="check">
            <input
              type="checkbox"
              checked={clearKey}
              disabled={busy}
              onChange={(event) => {
                setClearKey(event.target.checked);
                setApiKey("");
              }}
            />{" "}
            Remove saved API key and disable Check-Mail
          </label>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {saved && <Notice tone="success">Check-Mail settings saved.</Notice>}
        <div>
          <Button type="submit" tone="primary" busy={busy}>
            Save Check-Mail settings
          </Button>
        </div>
      </form>
    </Card>
  );
}
function CheckMailTester() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<CheckMailTestResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const test = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(
        await post<CheckMailTestResult>("/admin/check-mail/test", {
          email: email.trim(),
        }),
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not test this address.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="stack">
      <div>
        <h2>Test without spending requests</h2>
        <p>
          Check the account and whitelist decision locally. This does not verify
          whether an email is disposable or send it to Check-Mail.
        </p>
      </div>
      <form className="tester__form" onSubmit={(event) => void test(event)}>
        <Input
          aria-label="Email to test for Check-Mail"
          type="email"
          required
          placeholder="student@fcpsschools.net"
          value={email}
          disabled={busy}
          onChange={(event) => {
            setEmail(event.target.value);
            setResult(undefined);
          }}
        />
        <Button type="submit" busy={busy}>
          <MailCheck size={16} /> Test decision
        </Button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {result && (
        <Notice tone={result.skipped ? "success" : "info"}>
          {describeCheckMailTest(result)}
        </Notice>
      )}
    </Card>
  );
}
function CheckMailRuleEditor({
  value,
  onClose,
  onSaved,
}: {
  value: CheckMailRule | "new";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Omit<CheckMailRule, "id">>(
    value === "new"
      ? { ...blankRule }
      : {
          kind: value.kind,
          pattern: value.pattern,
          enabled: value.enabled,
          note: value.note,
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (value === "new") await post("/admin/check-mail/allowlist", form);
      else
        await put(
          `/admin/check-mail/allowlist/${encodeURIComponent(value.id)}`,
          form,
        );
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save whitelist rule.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={
        value === "new"
          ? "Add Check-Mail whitelist rule"
          : "Edit Check-Mail whitelist rule"
      }
      description="Bypasses only the paid disposable-email check. Ordinary registration and email rules still apply."
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="check-mail-rule-form"
            tone="primary"
            busy={busy}
          >
            Save whitelist rule
          </Button>
        </>
      }
    >
      <form
        id="check-mail-rule-form"
        className="stack"
        onSubmit={(event) => void save(event)}
      >
        <Field label="Rule type">
          <Select
            value={form.kind}
            disabled={busy}
            onChange={(event) =>
              setForm({
                ...form,
                kind: event.target.value as CheckMailRule["kind"],
              })
            }
          >
            <option value="domain">Domain</option>
            <option value="exact">Exact email</option>
            <option value="regex">Regex</option>
          </Select>
        </Field>
        <Field
          label="Pattern"
          hint={
            form.kind === "domain"
              ? "Matches this exact email domain; use a separate rule for each subdomain."
              : form.kind === "regex"
                ? "Use a bounded, safe regex. Anchor it with ^ and $ for a complete-address match."
                : "Matches one complete email address."
          }
        >
          <Input
            required
            maxLength={500}
            value={form.pattern}
            disabled={busy}
            placeholder={
              form.kind === "domain"
                ? "fcpsschools.net"
                : form.kind === "exact"
                  ? "person@example.com"
                  : "^[a-z]+@example\\.com$"
            }
            onChange={(event) =>
              setForm({ ...form, pattern: event.target.value })
            }
          />
        </Field>
        <Field label="Note">
          <Textarea
            rows={3}
            maxLength={500}
            value={form.note}
            disabled={busy}
            placeholder="Trusted school domain"
            onChange={(event) => setForm({ ...form, note: event.target.value })}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={busy}
            onChange={(event) =>
              setForm({ ...form, enabled: event.target.checked })
            }
          />{" "}
          Enabled
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  );
}
function CheckMailRuleRemoval({
  rule,
  onClose,
  onRemoved,
}: {
  rule: CheckMailRule;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await del(`/admin/check-mail/allowlist/${encodeURIComponent(rule.id)}`);
      onRemoved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not delete whitelist rule.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="Delete whitelist rule?"
      description="Future new accounts matching this rule may require a Check-Mail request."
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button tone="danger" busy={busy} onClick={() => void remove()}>
            Delete whitelist rule
          </Button>
        </>
      }
    >
      <p>
        <code>{rule.pattern}</code>
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  );
}
