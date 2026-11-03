import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Cloud,
  Plus,
  RefreshCw,
  ExternalLink,
  Check,
  Play,
  Search,
} from "lucide-react";
import { api, post } from "./api";
import { Badge, Button, Card, Field, Input, Notice, Select } from "./ui";
import "./CloudConfigurator.css";
type Account = {
  id: string;
  label: string;
  expectedAccountId: string;
  verifiedAccountId: string | null;
  region: string;
  status: string;
};
type Login = {
  id: string;
  accountId: string;
  status: string;
  authorizationUrl: string | null;
  errorCode: string | null;
  expiresAt: string;
};
type Endpoint = {
  id: string;
  role: "hub" | "frontend" | "node";
  logicalId: string;
  linkId: string | null;
  accountId: string;
  distributionId: string;
  url: string;
  originHost: string;
  revision: number;
  state: string;
};
type Job = {
  id: string;
  plan: {
    accountIdentity: string;
    resources: {
      key: string;
      role: string;
      logicalId: string;
      originHost: string;
      previous?: { url: string };
    }[];
    functionGroups: number;
  };
  planHash: string;
  state: string;
  revision: number;
  checkpoint: {
    resources?: Record<string, { domain: string; status: string }>;
  };
  errorCode: string | null;
};
type Operation =
  | {
      kind: "create";
      role: "hub" | "frontend" | "node";
      count: number;
      originHost: string;
      logicalId: string;
    }
  | { kind: "replace"; endpointId: string; revision: number };
type EndpointFilter = "all" | Endpoint["role"];
const endpointFilters: Array<{ value: EndpointFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "frontend", label: "Frontends" },
  { value: "node", label: "Nodes" },
  { value: "hub", label: "Hub" },
];
const endpointRoleLabel = {
  frontend: "Browser link",
  node: "Node",
  hub: "Hub",
};
export function filterExistingEndpoints(
  endpoints: Endpoint[],
  names: ReadonlyMap<string, string>,
  filter: EndpointFilter,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return endpoints.filter(
    (endpoint) =>
      (filter === "all" || endpoint.role === filter) &&
      (!search ||
        [
          names.get(endpoint.linkId || "") || "",
          endpoint.logicalId,
          endpoint.url,
        ].some((value) => value.toLocaleLowerCase().includes(search))),
  );
}
/** Filtering never clears hidden selections or create-operation drafts. The
 * bulk action adds only visible ACTIVE endpoints; staged imports stay available
 * for individual selection without pretending they are already active. */
export function selectVisibleActiveEndpoints(
  previous: Operation[],
  visible: Endpoint[],
): Operation[] {
  const selected = new Set(
    previous.flatMap((o) => (o.kind === "replace" ? [o.endpointId] : [])),
  );
  return [
    ...previous,
    ...visible
      .filter((e) => e.state === "active" && !selected.has(e.id))
      .map((e) => ({
        kind: "replace" as const,
        endpointId: e.id,
        revision: e.revision,
      })),
  ];
}
const stateLabel: Record<string, string> = {
  preview: "Review operation",
  queued: "Queued",
  running: "Configuring",
  waiting: "Waiting for AWS",
  sign_in_required: "Sign-in required",
  ready_for_activation: "Ready for runtime validation",
  complete: "Complete",
  failed: "Needs attention",
  cancelled: "Cancelled",
};
const accountLabel: Record<string, string> = {
  connected: "Connected",
  pending: "Signing in",
  sign_in_required: "Sign in",
  error: "Needs attention",
};
export function CloudConfigurator({
  active = true,
}: { active?: boolean } = {}) {
  const [data, setData] = useState<{
    accounts: Account[];
    logins: Login[];
    provider: string;
  }>();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [links, setLinks] = useState<
    { id: string; name: string; url: string }[]
  >([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [faultAccount, setFaultAccount] = useState("");
  const [scenario, setScenario] = useState("expired");
  const [simulationMessage, setSimulationMessage] = useState("");
  const [role, setRole] = useState<"hub" | "frontend" | "node">("frontend");
  const [count, setCount] = useState(1);
  const [origin, setOrigin] = useState("");
  const [logical, setLogical] = useState("");
  const [operations, setOperations] = useState<Operation[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [accountForm, setAccountForm] = useState(false);
  const [importForm, setImportForm] = useState(false);
  const [endpointFilter, setEndpointFilter] = useState<EndpointFilter>("all");
  const [endpointQuery, setEndpointQuery] = useState("");
  const linkNames = useMemo(
    () => new Map(links.map((link) => [link.id, link.name])),
    [links],
  );
  const visibleEndpoints = useMemo(
    () =>
      filterExistingEndpoints(
        endpoints,
        linkNames,
        endpointFilter,
        endpointQuery,
      ),
    [endpoints, linkNames, endpointFilter, endpointQuery],
  );
  const selectedEndpointIds = new Set(
    operations.flatMap((o) => (o.kind === "replace" ? [o.endpointId] : [])),
  );
  const visibleEndpointIds = new Set(visibleEndpoints.map((e) => e.id));
  const hiddenSelectedCount = [...selectedEndpointIds].filter(
    (id) => !visibleEndpointIds.has(id),
  ).length;
  const reload = async () => {
    try {
      const [a, e, j] = await Promise.all([
        api<{ accounts: Account[]; logins: Login[]; provider: string }>(
          "/admin/cloud/accounts",
        ),
        api<{
          endpoints: Endpoint[];
          links: { id: string; name: string; url: string }[];
        }>("/admin/cloud/endpoints"),
        api<{ jobs: Job[] }>("/admin/cloud/jobs"),
      ]);
      setData(a);
      setEndpoints(e.endpoints);
      setLinks(e.links);
      setJobs(j.jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed.");
    }
  };
  useEffect(() => {
    if (!active) return;
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 5000);
    return () => clearInterval(timer);
  }, [active]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };
  const preview = () =>
    run(async () => {
      await post("/admin/cloud/plans", { accountId: target, operations });
      setOperations([]);
    });
  return (
    <div className="cloud-config stack">
      <div className="cloud-config__heading">
        <div>
          <h2>
            <Cloud size={20} /> CloudFront
          </h2>
          <p>Accounts, browser links, Hub addresses, and node endpoints.</p>
        </div>
        <Button onClick={() => void reload()} aria-label="Refresh CloudFront">
          <RefreshCw size={16} />
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {data?.provider === "local_simulator" && (
        <Notice>Local simulator. This environment never calls AWS.</Notice>
      )}
      <Card className="stack">
        <div className="cloud-config__heading">
          <h3>AWS accounts</h3>
          <Button onClick={() => setAccountForm(!accountForm)}>
            <Plus size={15} /> Add account
          </Button>
        </div>
        {accountForm && (
          <form
            className="cloud-config__form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await post("/admin/cloud/accounts", {
                  label: f.get("label"),
                  expectedAccountId: f.get("account"),
                  region: f.get("region"),
                });
                setAccountForm(false);
              });
            }}
          >
            <Field label="Name">
              <Input
                name="label"
                maxLength={120}
                placeholder="New account"
                required
              />
            </Field>
            <Field label="AWS account ID">
              <Input
                name="account"
                inputMode="numeric"
                pattern="[0-9]{12}"
                maxLength={12}
                required
              />
            </Field>
            <Field label="Region">
              <Input name="region" defaultValue="us-east-1" required />
            </Field>
            <Button tone="primary" type="submit" disabled={busy}>
              Add account
            </Button>
          </form>
        )}
        {!data?.accounts.length ? (
          <p>No AWS accounts connected.</p>
        ) : (
          data.accounts.map((a) => {
            const login = data.logins.find(
              (l) =>
                l.accountId === a.id &&
                ["queued", "waiting_code", "code_submitted"].includes(l.status),
            );
            return (
              <div className="cloud-config__account" key={a.id}>
                <div>
                  <strong>{a.label}</strong>
                  <small>
                    {a.expectedAccountId} · {a.region}
                  </small>
                </div>
                <Badge tone={a.status === "connected" ? "success" : "warning"}>
                  {accountLabel[a.status] ?? a.status}
                </Badge>
                <Button
                  disabled={busy || !!login}
                  onClick={() =>
                    void run(() => post(`/admin/cloud/accounts/${a.id}/login`))
                  }
                >
                  {a.status === "connected"
                    ? "Sign in again"
                    : "Sign in to AWS"}
                </Button>
                {login && (
                  <div className="cloud-config__login">
                    {login.authorizationUrl ? (
                      <>
                        <a
                          href={login.authorizationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open AWS sign-in <ExternalLink size={14} />
                        </a>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const code = codes[login.id] ?? "";
                            setCodes((v) => ({ ...v, [login.id]: "" }));
                            void run(() =>
                              post(`/admin/cloud/login/${login.id}/code`, {
                                code,
                              }),
                            );
                          }}
                        >
                          <Field label="Authorization code">
                            <Input
                              type="password"
                              autoComplete="off"
                              value={codes[login.id] ?? ""}
                              onChange={(e) =>
                                setCodes((v) => ({
                                  ...v,
                                  [login.id]: e.target.value,
                                }))
                              }
                              disabled={login.status !== "waiting_code"}
                            />
                          </Field>
                          <Button
                            type="submit"
                            disabled={
                              busy ||
                              login.status !== "waiting_code" ||
                              !codes[login.id]
                            }
                          >
                            Finish sign-in
                          </Button>
                        </form>
                      </>
                    ) : (
                      <p>
                        {login.status === "queued"
                          ? "Waiting for configurator worker…"
                          : "Verifying account…"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Card>
      <Card className="stack">
        <div className="cloud-config__heading">
          <h3>Existing endpoints</h3>
          <Button onClick={() => setImportForm(!importForm)}>
            Add existing endpoint
          </Button>
        </div>
        {importForm && (
          <EndpointImport
            accounts={data?.accounts ?? []}
            links={links}
            busy={busy}
            onSubmit={(value) =>
              void run(async () => {
                await post("/admin/cloud/endpoints", value);
                setImportForm(false);
              })
            }
          />
        )}
        <div className="cloud-config__endpoint-tools">
          <div className="cloud-config__endpoint-types">
            <span className="cloud-config__filter-label">Type</span>
            <div
              className="cloud-config__role-filters"
              role="group"
              aria-label="Endpoint type"
            >
              {endpointFilters.map((filter) => (
                <Button
                  key={filter.value}
                  aria-pressed={endpointFilter === filter.value}
                  onClick={() => setEndpointFilter(filter.value)}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="cloud-config__endpoint-search">
            <Field label="Search endpoints">
              <Input
                type="search"
                aria-label="Search endpoints"
                placeholder="Name, ID or URL"
                value={endpointQuery}
                onChange={(event) => setEndpointQuery(event.target.value)}
              />
            </Field>
            <Search size={16} aria-hidden="true" />
          </div>
        </div>
        <div className="cloud-config__endpoint-summary" aria-live="polite">
          <span>
            {visibleEndpoints.length} of {endpoints.length} endpoints
          </span>
          <span>
            {selectedEndpointIds.size} selected
            {hiddenSelectedCount > 0 ? ` · ${hiddenSelectedCount} hidden` : ""}
          </span>
        </div>
        {!endpoints.length ? (
          <p>
            Add existing endpoints to replace individual links, Hub, or nodes.
          </p>
        ) : (
          <div>
            <div className="cloud-config__heading">
              <Button
                onClick={() =>
                  setOperations((previous) =>
                    selectVisibleActiveEndpoints(previous, visibleEndpoints),
                  )
                }
                disabled={!visibleEndpoints.some((e) => e.state === "active")}
              >
                Select visible active
              </Button>
              <Button
                tone="ghost"
                disabled={selectedEndpointIds.size === 0}
                onClick={() =>
                  setOperations((previous) =>
                    previous.filter((o) => o.kind !== "replace"),
                  )
                }
              >
                Clear selection
              </Button>
            </div>
            {!visibleEndpoints.length ? (
              <div className="cloud-config__no-matches">
                <strong>No matches</strong>
                <p>Try a different name, ID, URL or endpoint type.</p>
                <Button
                  tone="ghost"
                  onClick={() => {
                    setEndpointQuery("");
                    setEndpointFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <div className="cloud-config__endpoints">
                {visibleEndpoints.map((e) => (
                  <label key={e.id} className="cloud-config__endpoint">
                    <input
                      type="checkbox"
                      aria-label={`Select ${e.role === "frontend" ? linkNames.get(e.linkId || "") || "Atlas link" : e.logicalId}`}
                      disabled={!["active", "staged"].includes(e.state)}
                      checked={operations.some(
                        (o) => o.kind === "replace" && o.endpointId === e.id,
                      )}
                      onChange={(event) =>
                        setOperations((previous) =>
                          event.target.checked
                            ? previous.some(
                                (o) =>
                                  o.kind === "replace" && o.endpointId === e.id,
                              )
                              ? previous
                              : [
                                  ...previous,
                                  {
                                    kind: "replace",
                                    endpointId: e.id,
                                    revision: e.revision,
                                  },
                                ]
                            : previous.filter(
                                (o) =>
                                  !(
                                    o.kind === "replace" &&
                                    o.endpointId === e.id
                                  ),
                              ),
                        )
                      }
                    />
                    <span>
                      <strong>
                        {e.role === "frontend"
                          ? (linkNames.get(e.linkId || "") ?? "Atlas link")
                          : e.logicalId}
                      </strong>
                      <small className="cloud-config__endpoint-role">
                        {endpointRoleLabel[e.role]}
                      </small>
                      <small>{e.url}</small>
                    </span>
                    <Badge>
                      {e.state === "staged"
                        ? "Needs AWS verification"
                        : e.state}
                    </Badge>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
      {data?.provider === "local_simulator" && (
        <Card className="stack">
          <details>
            <summary>Local failure testing</summary>
            <p>
              Apply one failure to the next matching simulator request. No AWS
              account is changed.
            </p>
            <div className="cloud-config__form">
              <Field label="Failure account">
                <Select
                  aria-label="Failure account"
                  value={faultAccount}
                  onChange={(e) => setFaultAccount(e.target.value)}
                >
                  <option value="">Choose account</option>
                  {data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Simulate">
                <Select
                  aria-label="Simulate"
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                >
                  <option value="expired">Expired sign-in</option>
                  <option value="wrong_account">Wrong AWS account</option>
                  <option value="throttled">Throttled request</option>
                  <option value="lost_ack">Lost create acknowledgement</option>
                  <option value="revision">Stale AWS revision</option>
                  <option value="deployment_delay">Delayed deployment</option>
                </Select>
              </Field>
              <Button
                disabled={busy || !faultAccount}
                onClick={() =>
                  void run(async () => {
                    await post("/admin/cloud/simulator/faults", {
                      accountId: faultAccount,
                      scenario,
                    });
                    setSimulationMessage(
                      "The next matching simulator request will use this scenario.",
                    );
                  })
                }
              >
                Apply local scenario
              </Button>
            </div>
            {simulationMessage && <Notice>{simulationMessage}</Notice>}
          </details>
        </Card>
      )}
      <Card className="stack">
        <h3>New operation</h3>
        <Field label="Destination account">
          <Select
            aria-label="Destination account"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose account</option>
            {data?.accounts
              .filter((a) => a.status === "connected")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {a.expectedAccountId}
                </option>
              ))}
          </Select>
        </Field>
        <form
          className="cloud-config__form"
          onSubmit={(e) => {
            e.preventDefault();
            setOperations((v) => [
              ...v,
              {
                kind: "create",
                role,
                count: role === "frontend" ? count : 1,
                originHost: origin,
                logicalId: logical,
              },
            ]);
          }}
        >
          <Field label="Create">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
            >
              <option value="frontend">Browser links</option>
              <option value="hub">Hub address</option>
              <option value="node">Node endpoint</option>
            </Select>
          </Field>
          <Field label="Origin hostname">
            <Input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="server.example.com"
              required
            />
          </Field>
          {role === "frontend" ? (
            <Field label="Number of links">
              <Input
                type="number"
                min={1}
                max={5000}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                required
              />
            </Field>
          ) : (
            <Field label={role === "node" ? "Existing node ID" : "Hub ID"}>
              <Input
                value={logical}
                onChange={(e) => setLogical(e.target.value)}
                required
              />
            </Field>
          )}
          <Button type="submit">
            <Plus size={15} /> Add to operation
          </Button>
        </form>
        {operations.length > 0 && (
          <>
            <ul>
              {operations.map((o, i) => (
                <li key={i}>
                  {o.kind === "create"
                    ? `Create ${o.role === "frontend" ? o.count : 1} ${o.role} endpoint${o.count === 1 ? "" : "s"}`
                    : `Replace ${endpoints.find((e) => e.id === o.endpointId)?.url ?? "endpoint"}`}{" "}
                  <button
                    className="cloud-config__remove"
                    onClick={() =>
                      setOperations((v) => v.filter((_, n) => n !== i))
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <Button
              tone="primary"
              disabled={busy || !target}
              onClick={() => void preview()}
            >
              Review operation
            </Button>
          </>
        )}
      </Card>
      <div className="stack">
        <h3>Operations</h3>
        {!jobs.length ? (
          <p>No operations yet.</p>
        ) : (
          jobs.map((j) => (
            <Card key={j.id} className={`stack cloud-job-${j.id}`}>
              <div className="cloud-config__heading">
                <strong>
                  {j.plan.resources.length} endpoint
                  {j.plan.resources.length === 1 ? "" : "s"} →{" "}
                  {j.plan.accountIdentity}
                </strong>
                <Badge
                  tone={
                    j.state === "failed"
                      ? "danger"
                      : j.state === "complete"
                        ? "success"
                        : "neutral"
                  }
                >
                  {stateLabel[j.state] ?? j.state}
                </Badge>
              </div>
              <p>
                {Object.keys(j.checkpoint.resources ?? {}).length} configured ·{" "}
                {j.plan.functionGroups} viewer-header function
                {j.plan.functionGroups === 1 ? "" : "s"}
              </p>
              {j.errorCode && (
                <Notice tone="danger">
                  {j.errorCode.replaceAll("_", " ").toLowerCase()}
                </Notice>
              )}
              {j.state === "ready_for_activation" && (
                <Notice>
                  CloudFront is configured. Runtime checks, sync transitions,
                  and coordinator activation are still required. Existing links
                  have not changed.
                </Notice>
              )}
              {j.state === "preview" && (
                <>
                  <ul>
                    {j.plan.resources.slice(0, 10).map((r) => (
                      <li key={r.key}>
                        {r.previous ? "Replace" : "Create"} {r.role}
                        {r.previous
                          ? ` · ${r.previous.url}`
                          : ` · ${r.originHost}`}
                      </li>
                    ))}
                  </ul>
                  {j.plan.resources.length > 10 && (
                    <small>And {j.plan.resources.length - 10} more.</small>
                  )}
                  <small>
                    Existing assignments and quota remain unchanged. Nothing is
                    deleted.
                  </small>
                  <Button
                    tone="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        post(`/admin/cloud/jobs/${j.id}/approve`, {
                          revision: j.revision,
                        }),
                      )
                    }
                  >
                    <Check size={15} /> Approve configuration
                  </Button>
                </>
              )}
              {["failed", "sign_in_required", "waiting"].includes(j.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      post(`/admin/cloud/jobs/${j.id}/resume`, {
                        revision: j.revision,
                      }),
                    )
                  }
                >
                  <Play size={15} /> Retry
                </Button>
              )}
              {!["complete", "cancelled"].includes(j.state) && (
                <Button
                  tone="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      post(`/admin/cloud/jobs/${j.id}/cancel`, {
                        revision: j.revision,
                      }),
                    )
                  }
                >
                  Cancel operation
                </Button>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
function EndpointImport({
  accounts,
  links,
  busy,
  onSubmit,
}: {
  accounts: Account[];
  links: { id: string; name: string; url: string }[];
  busy: boolean;
  onSubmit: (value: unknown) => void;
}) {
  const [role, setRole] = useState("frontend");
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    onSubmit({
      role,
      accountId: f.get("account"),
      linkId: f.get("link"),
      logicalId: f.get("logical"),
      distributionId: f.get("distribution"),
      url: f.get("url"),
      originHost: f.get("origin"),
    });
  };
  return (
    <form onSubmit={submit} className="cloud-config__form">
      <Field label="Role">
        <Select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="frontend">Browser link</option>
          <option value="hub">Hub</option>
          <option value="node">Node</option>
        </Select>
      </Field>
      <Field label="AWS account">
        <Select name="account" required>
          <option value="">Choose account</option>
          {accounts
            .filter((a) => a.status === "connected")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
        </Select>
      </Field>
      {role === "frontend" ? (
        <Field label="Existing link">
          <Select name="link" required>
            <option value="">Choose link</option>
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.url}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label={role === "node" ? "Node ID" : "Hub ID"}>
          <Input name="logical" required />
        </Field>
      )}
      <Field label="Distribution ID">
        <Input name="distribution" required />
      </Field>
      <Field label="CloudFront address">
        <Input
          name="url"
          type="url"
          placeholder="https://dexample.cloudfront.net"
          required
        />
      </Field>
      <Field label="Origin hostname">
        <Input name="origin" required />
      </Field>
      <Button type="submit" disabled={busy}>
        Add endpoint
      </Button>
    </form>
  );
}
export default CloudConfigurator;
