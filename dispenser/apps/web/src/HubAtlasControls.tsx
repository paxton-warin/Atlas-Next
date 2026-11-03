import { useEffect, useState } from "react";
import { api, post } from "./api";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "./ui";
export function HubAtlasControls() {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [panel, setPanel] = useState("nodes"),
    [selected, setSelected] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [pending, setPending] = useState<{
      operation: string;
      input: unknown;
      challengeId: string;
    } | null>(null),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [verifying, setVerifying] = useState(false);
  const draft = drafts[panel] || "";
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [panel]: value }));
  const load = async () => {
    try {
      setData(await api("/admin/hub/atlas"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  async function command(operation: string, input: unknown) {
    try {
      if (data?.mfaRequired) {
        const challenge = await post<{ challengeId: string }>(
          "/admin/hub/atlas/challenge",
          { operation, input },
        );
        setPending({ operation, input, challengeId: challenge.challengeId });
        setPassword("");
        setCode("");
      } else
        setData(await post("/admin/hub/atlas/command", { operation, input }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function verify() {
    if (!pending || verifying) return;
    setVerifying(true);
    setError("");
    try {
      setData(
        await post("/admin/hub/atlas/command", { ...pending, password, code }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPassword("");
      setCode("");
      setPending(null);
      setVerifying(false);
    }
  }
  const held = !data?.mutationsEnabled;
  return (
    <Card className="stack">
      <h2>Browser services</h2>
      {error && <Notice tone="danger">{error}</Notice>}
      {pending && (
        <form
          className="stack"
          aria-label="Verify browser service change"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <h3>Verify this change</h3>
          <p>
            Use the coordinator administrator password and authenticator or
            recovery code. Verification applies only to this change for two
            minutes.
          </p>
          <Field label="Coordinator administrator password">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              maxLength={128}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Field label="Authenticator or recovery code">
            <Input
              autoComplete="one-time-code"
              value={code}
              maxLength={128}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </Field>
          <div className="actions">
            <Button type="submit" disabled={verifying}>
              {verifying ? "Verifying…" : "Verify and apply"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setPending(null);
                setPassword("");
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {data?.configured === false ? (
        <p>Connect the Atlas coordinator to manage browser services here.</p>
      ) : (
        data && (
          <>
            <div className="hub-subnav">
              {["nodes", "site", "catalog", "ai", "limits"].map((p) => (
                <Button
                  key={p}
                  onClick={() => {
                    setPanel(p);
                  }}
                >
                  {p === "ai" ? "AI" : p[0].toUpperCase() + p.slice(1)}
                </Button>
              ))}
            </div>
            {held && (
              <Notice>
                Enroll coordinator administrator MFA before making changes.
                Existing configuration remains intact.
              </Notice>
            )}
            <div hidden={panel !== "nodes"}>{data.nodes.map((n: any) => (
                <div key={n.id} className="cloud-config__account">
                  <strong>{n.name}</strong>
                  <span>{n.online ? "Online" : "Unavailable"}</span>
                  <Select
                    aria-label={n.name + " state"}
                    disabled={held}
                    value={n.state}
                    onChange={(e) =>
                      void command("node.update", {
                        id: n.id,
                        state: e.target.value,
                        weight: n.weight,
                      })
                    }
                  >
                    {["active", "draining", "disabled"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </Select>
                  <Input
                    aria-label={n.name + " weight"}
                    type="number"
                    min={1}
                    max={100}
                    disabled={held}
                    defaultValue={n.weight}
                    onBlur={(e) => {
                      if (Number(e.target.value) !== n.weight)
                        void command("node.update", {
                          id: n.id,
                          state: n.state,
                          weight: Number(e.target.value),
                        });
                    }}
                  />
                </div>
              ))}</div>
            <div hidden={panel !== "site"}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void command("site.update", {
                    name: new FormData(e.currentTarget).get("name"),
                  });
                }}
              >
                <Field label="Site name">
                  <Input
                    name="name"
                    defaultValue={data.name}
                    maxLength={40}
                    disabled={held}
                  />
                </Field>
                <Button type="submit" disabled={held}>
                  Save
                </Button>
              </form>
            </div>
            <div hidden={panel !== "catalog"}>
                <Field label="Catalog entry">
                  <Select
                    value={selected}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setDraft(
                        JSON.stringify(
                          data.catalog.find(
                            (v: any) => v.id === e.target.value,
                          ),
                          null,
                          2,
                        ),
                      );
                    }}
                  >
                    <option value="">Choose entry</option>
                    {data.catalog.map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {selected && (
                  <Field label="Entry settings">
                    <Textarea
                      value={draft}
                      disabled={held}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={10}
                    />
                  </Field>
                )}
                <Button
                  disabled={held || !selected}
                  onClick={() => {
                    try {
                      const v = JSON.parse(draft);
                      void command("catalog.update", {
                        ...v,
                        enabled: v.enabled !== false && v.enabled !== 0,
                      });
                    } catch {
                      setError("Enter valid JSON.");
                    }
                  }}
                >
                  Save entry
                </Button>
            </div>
            {(panel === "ai" || panel === "limits") && (
              <>
                <p>
                  Advanced settings. Existing API keys remain hidden; omit keys
                  to preserve them.
                </p>
                <Textarea
                  aria-label={
                    panel === "ai" ? "AI settings" : "Request limit settings"
                  }
                  rows={14}
                  disabled={held}
                  value={
                    draft ||
                    JSON.stringify(
                      panel === "ai" ? data.ai : data.requestLimits,
                      null,
                      2,
                    )
                  }
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button
                  disabled={held}
                  onClick={() => {
                    try {
                      void command(
                        panel === "ai" ? "ai.update" : "requestLimits.update",
                        JSON.parse(
                          draft ||
                            JSON.stringify(
                              panel === "ai" ? data.ai : data.requestLimits,
                            ),
                        ),
                      );
                    } catch {
                      setError("Enter valid JSON.");
                    }
                  }}
                >
                  Save settings
                </Button>
              </>
            )}
          </>
        )
      )}
    </Card>
  );
}
