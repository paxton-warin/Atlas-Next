import { useEffect, useState, type FormEvent } from "react";
import { Plus, RefreshCw, Search, Upload } from "lucide-react";
import type { ManualVerificationRequest } from "@atlas-link-dispenser/shared";
import { api, del, post, put } from "./api";
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

export interface VerificationDomain {
  id: string;
  domain: string;
  enabled: boolean;
  schoolCount: number;
  knownEmailCount: number;
}
export interface SchoolDirectory {
  id: string;
  domainId: string;
  name: string;
  enabled: boolean;
  emailCount: number;
  createdAt: string;
  updatedAt: string;
}
const base = "/admin/manual-verification";
const failureText = (failure: unknown) =>
  failure instanceof Error ? failure.message : "The request failed.";
const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export async function readDirectoryFile(file: File) {
  if (file.size > 1_900_000)
    throw new Error("Choose a directory smaller than 1.9 MB.");
  const text = await file.text();
  if (!text.trim()) throw new Error("The directory is empty.");
  return text;
}

export function KnownEmailAdmin() {
  const state = useData(() =>
    api<{ domains: VerificationDomain[] }>(`${base}/domains`),
  );
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<VerificationDomain>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (
      state.data &&
      !state.data.domains.some((domain) => domain.id === selected)
    )
      setSelected(state.data.domains[0]?.id ?? "");
  }, [state.data, selected]);
  const toggle = async (domain: VerificationDomain) => {
    setBusy(domain.id);
    setError("");
    try {
      await put(`${base}/domains/${domain.id}`, { enabled: !domain.enabled });
      await state.reload();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy("");
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    setError("");
    try {
      await del(`${base}/domains/${removing.id}`);
      setRemoving(undefined);
      await state.reload();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy("");
    }
  };
  const active = state.data?.domains.find((domain) => domain.id === selected);
  return (
    <section className="stack known-email-section">
      <div className="manual-admin-heading">
        <div>
          <h2>Known emails</h2>
          <p>
            After email rules pass, unlisted addresses in enabled domains
            require manual verification. School directories do not bypass email
            rules or Check-Mail.
          </p>
        </div>
        <div className="button-row">
          <Button onClick={() => void state.reload()} disabled={state.loading}>
            <RefreshCw size={16} /> Refresh
          </Button>
          <Button tone="primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add domain
          </Button>
        </div>
      </div>
      {(error || state.error) && (
        <Notice tone="danger">{error || state.error}</Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : !state.data?.domains.length ? (
        <Card>
          <Empty title="No verification domains">
            Add a domain, then upload its school directories.
          </Empty>
        </Card>
      ) : (
        <>
          <VerificationDomainList
            domains={state.data.domains}
            selected={selected}
            busy={busy}
            onSelect={setSelected}
            onToggle={(domain) => void toggle(domain)}
            onRemove={setRemoving}
          />
          {active && (
            <SchoolDirectories
              key={active.id}
              domain={active}
              onChanged={() => state.reload()}
            />
          )}
        </>
      )}
      {adding && (
        <DomainEditor
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void state.reload();
          }}
        />
      )}
      {removing && (
        <Dialog
          open
          title={`Remove ${removing.domain}?`}
          description="Remove this domain and its school directories from directory verification. Submitted requests are retained."
          onClose={() => setRemoving(undefined)}
          footer={
            <>
              <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
              <Button
                tone="danger"
                busy={busy === removing.id}
                onClick={() => void remove()}
              >
                Remove domain
              </Button>
            </>
          }
        >
          <p>Email rules and the Check-Mail whitelist will not change.</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </Dialog>
      )}
    </section>
  );
}

export function VerificationDomainList({
  domains,
  selected,
  busy,
  onSelect,
  onToggle,
  onRemove,
}: {
  domains: VerificationDomain[];
  selected: string;
  busy: string;
  onSelect: (id: string) => void;
  onToggle: (domain: VerificationDomain) => void;
  onRemove: (domain: VerificationDomain) => void;
}) {
  return (
    <div className="table-card" tabIndex={0} role="region" aria-label="Scrollable data table">
      <table>
        <thead>
          <tr>
            <th>Domain</th>
            <th>Schools</th>
            <th>Known emails</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {domains.map((domain) => (
            <tr key={domain.id}>
              <td>
                <Button
                  aria-pressed={selected === domain.id}
                  onClick={() => onSelect(domain.id)}
                >
                  {domain.domain}
                </Button>
              </td>
              <td>{domain.schoolCount.toLocaleString()}</td>
              <td>{domain.knownEmailCount.toLocaleString()}</td>
              <td>
                <Badge tone={domain.enabled ? "success" : "neutral"}>
                  {domain.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </td>
              <td>
                <div className="button-row">
                  <Button
                    disabled={busy === domain.id}
                    onClick={() => onToggle(domain)}
                  >
                    {domain.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    tone="danger"
                    disabled={busy === domain.id}
                    onClick={() => onRemove(domain)}
                  >
                    Remove
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DomainEditor({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(`${base}/domains`, { domain: domain.trim(), enabled });
      onSaved();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title="Add verification domain" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Domain">
          <Input
            required
            maxLength={253}
            placeholder="school.example"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />{" "}
          Enabled
        </label>
        <p>
          Enabled domains require manual verification for addresses missing from
          their enabled school directories.
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="button-row">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" tone="primary" busy={busy}>
            Add domain
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SchoolDirectories({
  domain,
  onChanged,
}: {
  domain: VerificationDomain;
  onChanged: () => Promise<void>;
}) {
  const state = useData(
    () =>
      api<{ schools: SchoolDirectory[] }>(
        `${base}/domains/${domain.id}/schools`,
      ),
    [domain.id],
  );
  const [editor, setEditor] = useState<SchoolDirectory | "new">();
  const [upload, setUpload] = useState<SchoolDirectory>();
  const [remove, setRemove] = useState<SchoolDirectory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = async () => {
    await Promise.all([state.reload(), onChanged()]);
  };
  const removeSchool = async () => {
    if (!remove) return;
    setBusy(true);
    setError("");
    try {
      await del(`${base}/schools/${remove.id}`);
      setRemove(undefined);
      await saved();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="stack">
      <div className="manual-admin-heading">
        <h3>{domain.domain} · School directories</h3>
        <Button tone="primary" onClick={() => setEditor("new")}>
          <Plus size={16} /> Add school
        </Button>
      </div>
      {(error || state.error) && (
        <Notice tone="danger">{error || state.error}</Notice>
      )}
      {state.loading ? (
        <Loading />
      ) : !state.data?.schools.length ? (
        <Empty title="No school directories">
          Add a school and upload its known-email file.
        </Empty>
      ) : (
        <SchoolDirectoryList
          schools={state.data.schools}
          onEdit={setEditor}
          onUpload={setUpload}
          onRemove={setRemove}
        />
      )}
      {editor && (
        <SchoolEditor
          domain={domain}
          value={editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            void saved();
          }}
        />
      )}
      {upload && (
        <DirectoryUpload
          school={upload}
          domain={domain.domain}
          onClose={() => setUpload(undefined)}
          onSaved={() => {
            setUpload(undefined);
            void saved();
          }}
        />
      )}
      {remove && (
        <Dialog
          open
          title={`Remove ${remove.name}?`}
          description="This removes the school directory and its known-email entries."
          onClose={() => setRemove(undefined)}
          footer={
            <>
              <Button onClick={() => setRemove(undefined)}>Cancel</Button>
              <Button
                tone="danger"
                busy={busy}
                onClick={() => void removeSchool()}
              >
                Remove directory
              </Button>
            </>
          }
        >
          <p>
            Accounts no longer listed in another enabled directory may require
            manual verification.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
        </Dialog>
      )}
    </Card>
  );
}

export function SchoolDirectoryList({
  schools,
  onEdit,
  onUpload,
  onRemove,
}: {
  schools: SchoolDirectory[];
  onEdit: (school: SchoolDirectory) => void;
  onUpload: (school: SchoolDirectory) => void;
  onRemove: (school: SchoolDirectory) => void;
}) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable data table">
      <table>
        <thead>
          <tr>
            <th>School</th>
            <th>Emails</th>
            <th>Status</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {schools.map((school) => (
            <tr key={school.id}>
              <td>
                <strong>{school.name}</strong>
              </td>
              <td>{school.emailCount.toLocaleString()}</td>
              <td>
                <Badge tone={school.enabled ? "success" : "neutral"}>
                  {school.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </td>
              <td>{date(school.updatedAt)}</td>
              <td>
                <div className="button-row">
                  <Button onClick={() => onEdit(school)}>Edit</Button>
                  <Button onClick={() => onUpload(school)}>
                    <Upload size={15} /> Upload
                  </Button>
                  <Button tone="danger" onClick={() => onRemove(school)}>
                    Remove
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DirectoryFileField({
  onChange,
  disabled,
}: {
  onChange: (file: File | undefined) => void;
  disabled: boolean;
}) {
  return (
    <Field
      label="Known-email file"
      hint="Plain text with email addresses. Only addresses for this domain are accepted."
    >
      <Input
        type="file"
        accept=".txt,.csv,text/plain,text/csv"
        disabled={disabled}
        onChange={(event) => onChange(event.target.files?.[0])}
      />
    </Field>
  );
}

function SchoolEditor({
  domain,
  value,
  onClose,
  onSaved,
}: {
  domain: VerificationDomain;
  value: SchoolDirectory | "new";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(value === "new" ? "" : value.name);
  const [enabled, setEnabled] = useState(
    value === "new" ? true : value.enabled,
  );
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (value === "new")
        await post(`${base}/domains/${domain.id}/schools`, {
          name,
          enabled,
          ...(file ? { text: await readDirectoryFile(file) } : {}),
        });
      else await put(`${base}/schools/${value.id}`, { name, enabled });
      onSaved();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={value === "new" ? "Add school directory" : "Edit school directory"}
      description={domain.domain}
      onClose={onClose}
    >
      <form className="stack" onSubmit={save}>
        <Field label="School name">
          <Input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {value === "new" && (
          <DirectoryFileField disabled={busy} onChange={setFile} />
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />{" "}
          Enabled
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="button-row">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" tone="primary" busy={busy}>
            Save directory
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DirectoryUpload({
  school,
  domain,
  onClose,
  onSaved,
}: {
  school: SchoolDirectory;
  domain: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [mode, setMode] = useState<"replace" | "add">("replace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setError("Choose a known-email file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await put(`${base}/schools/${school.id}/emails`, {
        text: await readDirectoryFile(file),
        mode,
      });
      onSaved();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Upload · ${school.name}`}
      description={domain}
      onClose={onClose}
    >
      <form className="stack" onSubmit={save}>
        <DirectoryFileField disabled={busy} onChange={setFile} />
        <Field label="Upload mode">
          <Select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as "replace" | "add")
            }
          >
            <option value="replace">Replace directory</option>
            <option value="add">Add to directory</option>
          </Select>
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="button-row">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" tone="primary" busy={busy} disabled={!file}>
            Upload directory
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ManualVerificationAdmin() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("pending");
  const state = usePagedData<{ requests: ManualVerificationRequest[] }>(
    `${base}/requests?q=${encodeURIComponent(search)}&status=${status}`,
  );
  const [selected, setSelected] = useState<ManualVerificationRequest>();
  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Manual verification"
        description="Review submitted account-verification requests."
        actions={
          <>
            <Select
              aria-label="Filter verification requests"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="pending">Pending</option>
              <option value="denied">Denied</option>
              <option value="approved">Approved</option>
              <option value="all">All requests</option>
            </Select>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="Search verification requests"
                placeholder="Search email or name"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <Button onClick={() => void state.reload()}>
              <RefreshCw size={16} /> Refresh
            </Button>
          </>
        }
      />
      {state.error && <Notice tone="danger">{state.error}</Notice>}
      {state.loading ? (
        <Loading />
      ) : state.error ? null : !state.data?.requests.length ? (
        <Card>
          <Empty title="No matching requests">
            Submitted requests will appear here.
          </Empty>
        </Card>
      ) : (
        <VerificationRequestList
          requests={state.data.requests}
          onReview={setSelected}
        />
      )}
      <Pagination label="Verification requests" {...state.pager} />
      {selected && (
        <VerificationReview
          key={`${selected.id}:${selected.revision}`}
          request={selected}
          onClose={() => setSelected(undefined)}
          onSaved={() => {
            setSelected(undefined);
            void state.reload();
          }}
        />
      )}
    </>
  );
}

export function VerificationRequestList({
  requests,
  onReview,
}: {
  requests: ManualVerificationRequest[];
  onReview: (request: ManualVerificationRequest) => void;
}) {
  return (
    <div className="table-card" tabIndex={0} role="region" aria-label="Scrollable data table">
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>School</th>
            <th>Status</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>{request.email}</td>
              <td>{request.name}</td>
              <td>{request.schoolName}</td>
              <td>
                <Badge
                  tone={
                    request.status === "approved"
                      ? "success"
                      : request.status === "denied"
                        ? "danger"
                        : "warning"
                  }
                >
                  {request.status}
                </Badge>
              </td>
              <td>{date(request.updatedAt)}</td>
              <td>
                <Button onClick={() => onReview(request)}>Review</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VerificationReview({
  request,
  onClose,
  onSaved,
}: {
  request: ManualVerificationRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(request.reviewNote ?? "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const review = async (decision: "approved" | "denied") => {
    if (busy) return;
    setBusy(decision);
    setError("");
    try {
      await put(
        `${base}/requests/${request.id}/review`,
        verificationReviewBody(request, decision, note),
      );
      onSaved();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy("");
    }
  };
  return (
    <Dialog
      open
      title={request.email ?? request.name}
      description={`Manual verification · ${request.status}`}
      onClose={onClose}
      footer={
        <>
          <Button disabled={Boolean(busy)} onClick={onClose}>
            Close
          </Button>
          <Button
            tone="danger"
            busy={busy === "denied"}
            disabled={Boolean(busy)}
            onClick={() => void review("denied")}
          >
            Deny
          </Button>
          <Button
            tone="primary"
            busy={busy === "approved"}
            disabled={Boolean(busy)}
            onClick={() => void review("approved")}
          >
            Approve
          </Button>
        </>
      }
    >
      <div className="stack">
        <VerificationRequestDetails request={request} />
        <Field label="Review note" hint="Shown to the account holder.">
          <Textarea
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {error && (
          <Notice tone="danger">
            {error} <Button onClick={onSaved}>Refresh requests</Button>
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

export const verificationReviewBody = (
  request: ManualVerificationRequest,
  decision: "approved" | "denied",
  reviewNote: string,
) => ({ decision, revision: request.revision, reviewNote });

export function VerificationRequestDetails({
  request,
}: {
  request: ManualVerificationRequest;
}) {
  return (
    <dl className="manual-request-details">
      <div>
        <dt>Name</dt>
        <dd>{request.name}</dd>
      </div>
      <div>
        <dt>School name</dt>
        <dd>{request.schoolName}</dd>
      </div>
      <div>
        <dt>Additional information</dt>
        <dd className="preserve-text">{request.additionalInformation}</dd>
      </div>
      <div>
        <dt>Submitted</dt>
        <dd>{date(request.submittedAt)}</dd>
      </div>
      <div>
        <dt>Updated</dt>
        <dd>{date(request.updatedAt)}</dd>
      </div>
      <div>
        <dt>Reviewed</dt>
        <dd>{date(request.reviewedAt)}</dd>
      </div>
    </dl>
  );
}
