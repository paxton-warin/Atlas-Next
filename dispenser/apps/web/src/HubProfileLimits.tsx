import { useEffect, useState } from "react";
import { api, post, put } from "./api";
import { Button, Card, Field, Input, Notice } from "./ui";
type Policy = { profileBytes: number; localBytes: number; idbBytes: number };
const MiB = 1024 * 1024;
const fields = [
  ["profileBytes", "Account backup allowance (MiB)", 1, 8192],
  ["localBytes", "localStorage per origin (MiB)", 0.0625, 32],
  ["idbBytes", "IndexedDB per origin (MiB)", 1, 1024],
] as const;
export function HubProfileLimits() {
  const [enabled, enable] = useState(false),
    [defaults, setDefaults] = useState<Policy>(),
    [draft, change] = useState<Record<string, string>>({}),
    [email, setEmail] = useState(""),
    [account, setAccount] = useState<any>(),
    [override, edit] = useState<Record<string, string>>({}),
    [error, fail] = useState(""),
    [notice, notify] = useState(""),
    [busy, setBusy] = useState(false);
  const values = (p: Policy) =>
    Object.fromEntries(fields.map(([k]) => [k, String(p[k] / MiB)]));
  useEffect(() => {
    let live = true;
    void api<{ enabled: boolean }>("/hub/config")
      .then(async (c) => {
        if (!live || !c.enabled) return;
        enable(true);
        const v = await api<{ defaults: Policy }>("/admin/hub/profile-policy");
        if (live) {
          setDefaults(v.defaults);
          change(values(v.defaults));
        }
      })
      .catch((e) => {
        if (live) fail(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    fail("");
    notify("");
    try {
      await action();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const payload = (v: Record<string, string>, nullable = false) =>
    Object.fromEntries(
      fields.map(([k]) => [
        k,
        nullable && v[k] === "" ? null : Number(v[k]) * MiB,
      ]),
    );
  async function find() {
    const value = await api<any>(
      "/admin/hub/profile-policy/account?email=" +
        encodeURIComponent(email.trim()),
    );
    setAccount(value);
    edit(
      Object.fromEntries(
        fields.map(([k]) => [
          k,
          value.override?.[k] == null ? "" : String(value.override[k] / MiB),
        ]),
      ),
    );
  }
  if (!enabled) return null;
  return (
    <Card className="stack">
      <h2>Browser storage limits</h2>
      <p>
        Backup allowance is separate from link-generation quota. Lower limits do
        not delete saves. Server backup limits apply immediately; native website
        limits apply when its document is reopened.
      </p>
      <details>
        <summary>Backup format details</summary>
        <p>
          A portable value can contain up to 64 MiB of decoded data. Each website
          backup replay can use up to 128 MiB of encoded data, including its
          snapshot and journal. Encoding and structure limits still apply.
        </p>
      </details>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {defaults && (
        <form
          className="stack"
          aria-label="Default browser storage limits"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await put<{ defaults: Policy }>(
                "/admin/hub/profile-policy",
                payload(draft),
              );
              setDefaults(r.defaults);
              change(values(r.defaults));
              notify(
                "Default storage limits saved. Existing data was not removed.",
              );
            });
          }}
        >
          <h3>Default limits</h3>
          <div className="settings-form">
            {fields.map(([k, label, min, max]) => (
              <Field key={k} label={label}>
                <Input
                  required
                  type="number"
                  min={min}
                  max={max}
                  step={0.0625}
                  value={draft[k] || ""}
                  onChange={(e) => change({ ...draft, [k]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          <Button type="submit" disabled={busy}>
            Save default limits
          </Button>
        </form>
      )}
      <form
        className="actions"
        aria-label="Find account storage limits"
        onSubmit={(e) => {
          e.preventDefault();
          void run(find);
        }}
      >
        <Field label="Account email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Find account
        </Button>
      </form>
      {account && (
        <>
          <h3>{account.user.email}</h3>
          <p>
            {(account.bytes / MiB).toFixed(2)}MiB backed up. Leave an override
            empty to inherit the default. Unreferenced binary uploads have a
            separate bounded allowance and a 24-hour retry grace period.
          </p>
          <form
            className="stack"
            aria-label="Account browser storage limits"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await put(
                  "/admin/hub/profile-policy/accounts/" + account.user.id,
                  payload(override, true),
                );
                await find();
                notify(
                  "Account storage limits saved. Existing data was not removed.",
                );
              });
            }}
          >
            <div className="settings-form">
              {fields.map(([k, label, min, max]) => (
                <Field key={k} label={"Override " + label}>
                  <Input
                    type="number"
                    min={min}
                    max={max}
                    step={0.0625}
                    placeholder={defaults ? String(defaults[k] / MiB) : ""}
                    value={override[k] || ""}
                    onChange={(e) => edit({ ...override, [k]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
            <Button type="submit" disabled={busy}>
              Save account limits
            </Button>
          </form>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await post<{ chunks: number; bytes: number }>(
                  "/admin/hub/profile-policy/accounts/" +
                    account.user.id +
                    "/collect",
                  {},
                );
                await find();
                notify(
                  `Collected ${r.chunks} expired upload chunks (${(r.bytes / MiB).toFixed(2)}MiB). Current saves and recovery records were preserved.`,
                );
              })
            }
          >
            Collect expired uploads
          </Button>
        </>
      )}
    </Card>
  );
}
