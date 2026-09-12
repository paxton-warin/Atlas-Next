import { useEffect, useState } from "react";
import { Check, Plus, Save } from "lucide-react";
import { api } from "./model";
type Policy = {
  enabled: boolean;
  whitelist: string[];
  aiConcurrent: number;
  rules: Record<string, { max: number; windowSeconds: number }>;
};
type State = {
  config: Policy;
  defaults: Policy;
  rules: { key: string; label: string }[];
  clientIp: string;
};
export default function RequestLimitSettings({ csrf }: { csrf: string }) {
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<Policy | null>(null);
  const [whitelist, setWhitelist] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  function edit(next: Policy) {
    setConfig(next);
    setSaved(false);
  }
  useEffect(() => {
    api("/admin/request-limits")
      .then((data: State) => {
        setState(data);
        setConfig(data.config);
        setWhitelist(data.config.whitelist.join("\n"));
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="setting-card request-limit-settings">
      <h2>Request limits</h2>
      <p>
        Control how often each IP can use the Atlas API. Changes take effect
        when saved, without restarting the server.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {state && config && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setSaved(false);
            setError("");
            try {
              const result = await api("/admin/request-limits", {
                method: "PUT",
                headers: { "x-atlas-csrf": csrf },
                body: JSON.stringify({
                  ...config,
                  whitelist: whitelist.split(/[\s,]+/).filter(Boolean),
                }),
              });
              setConfig(result.config);
              setWhitelist(result.config.whitelist.join("\n"));
              setSaved(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="request-limit-fields">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => edit({ ...config, enabled: e.target.checked })}
              />
              Enable IP request limits
            </label>
            <p className="small">
              Turn off to remove all per-IP API limits and per-IP AI concurrency
              limits. Set an individual limit to 0 to disable just that rule.
            </p>
            <div className="request-limit-rules">
              {state.rules.map(({ key, label }) => (
                <div className="request-limit-rule" key={key}>
                  <strong>{label}</strong>
                  <label className="form-field">
                    Requests
                    <input
                      aria-label={`${label}: requests`}
                      type="number"
                      required
                      min={0}
                      max={1000000}
                      step={1}
                      value={config.rules[key].max}
                      onChange={(e) =>
                        edit({
                          ...config,
                          rules: {
                            ...config.rules,
                            [key]: {
                              ...config.rules[key],
                              max: Number(e.target.value),
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label className="form-field">
                    Window (seconds)
                    <input
                      aria-label={`${label}: window in seconds`}
                      type="number"
                      required
                      min={1}
                      max={86400}
                      step={1}
                      value={config.rules[key].windowSeconds}
                      onChange={(e) =>
                        edit({
                          ...config,
                          rules: {
                            ...config.rules,
                            [key]: {
                              ...config.rules[key],
                              windowSeconds: Number(e.target.value),
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
            <p className="small">
              All API requests is an overall cap, in addition to each individual
              rule. Node heartbeats have their own cap.
            </p>
            <label className="form-field">
              Concurrent AI replies per IP
              <input
                type="number"
                required
                min={0}
                max={10000}
                step={1}
                value={config.aiConcurrent}
                onChange={(e) =>
                  edit({ ...config, aiConcurrent: Number(e.target.value) })
                }
              />
            </label>
            <label className="form-field">
              IP whitelist
              <textarea
                aria-label="IP whitelist"
                rows={5}
                spellCheck={false}
                placeholder={"192.0.2.10\n198.51.100.0/24\n2001:db8::/48"}
                value={whitelist}
                onChange={(e) => {
                  setWhitelist(e.target.value);
                  setSaved(false);
                }}
              />
              <small>
                One IP address or CIDR range per line. These addresses skip
                every IP rule above, including concurrent AI replies.
              </small>
            </label>
            <div className="button-row">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setWhitelist(
                    [
                      ...new Set([
                        ...whitelist.split(/[\s,]+/).filter(Boolean),
                        state.clientIp,
                      ]),
                    ].join("\n"),
                  );
                  setSaved(false);
                }}
              >
                <Plus size={14} />
                Add current IP
              </button>
              <span className="small">
                Server sees: <code>{state.clientIp}</code>
              </span>
            </div>
            <p className="small">
              Authentication still applies. Global AI budgets, per-ticket reply
              limits and browsing session/server connection limits remain
              separate. Behind CloudFront, use the trusted-proxy setup so the
              server sees the visitor IP.
            </p>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                <Save size={15} />
                {busy ? "Saving…" : "Save request limits"}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  edit(structuredClone(state.defaults));
                  setWhitelist(state.defaults.whitelist.join("\n"));
                }}
              >
                Restore defaults
              </button>
              {saved && (
                <span className="small" role="status">
                  <Check size={14} />
                  Request limits saved
                </span>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
