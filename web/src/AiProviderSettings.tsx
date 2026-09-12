import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, RefreshCw, Save } from "lucide-react";
import { api } from "./model";
type Usage = {
  minute: { requests: number; tokens: number };
  day: { requests: number; tokens: number };
  cooldown: { until: number; reason: string } | null;
};
type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  model: string;
  billing: string;
  enabled: boolean;
  freeTierConfirmed: boolean;
  hasKey: boolean;
  apiKey?: string;
  clearKey?: boolean;
  routingStatus: string;
  limits: Record<string, number>;
  usage: Usage;
};
type Config = {
  enabled: boolean;
  freeOnly: boolean;
  allowGeminiDataUse: boolean;
  dailyLimit: number;
  maxOutputTokens: number;
  providers: Provider[];
};
export default function AiProviderSettings({ csrf }: { csrf: string }) {
  const [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/admin/ai")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  function edit(next: Config) {
    setConfig(next);
    setSaved(false);
  }
  function update(id: string, patch: Partial<Provider>) {
    if (config)
      edit({
        ...config,
        providers: config.providers.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      });
  }
  function move(index: number, direction: number) {
    if (!config) return;
    const providers = [...config.providers];
    [providers[index], providers[index + direction]] = [
      providers[index + direction],
      providers[index],
    ];
    edit({ ...config, providers });
  }
  return (
    <section className="setting-card ai-routing-settings">
      <h2>AI providers</h2>
      <p>
        Providers run in priority order. Atlas tries the next eligible provider
        on a quota or connection failure, only before an answer starts.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {config && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setSaved(false);
            try {
              setConfig(
                await api("/admin/ai", {
                  method: "PUT",
                  headers: { "x-atlas-csrf": csrf },
                  body: JSON.stringify(config),
                }),
              );
              setSaved(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset className="request-limit-fields" disabled={busy}>
            <div className="ai-routing-toggles">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) =>
                    edit({ ...config, enabled: e.target.checked })
                  }
                />
                Enable AI chat
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={config.freeOnly}
                  onChange={(e) =>
                    edit({ ...config, freeOnly: e.target.checked })
                  }
                />
                Free-only routing
              </label>
            </div>
            <p className="small">
              Free-only routing excludes xAI, custom endpoints and unconfirmed
              free-tier accounts. Keep paid billing disabled at Groq/Google:
              Atlas cannot verify your account's billing plan or override
              provider charges.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.allowGeminiDataUse}
                onChange={(e) =>
                  edit({ ...config, allowGeminiDataUse: e.target.checked })
                }
              />
              Allow the optional Gemini free-tier backup
            </label>
            <p className="small">
              Google may use free-tier prompts and replies to improve its
              products. Visitors must also opt in from the chat disclosure
              before their messages go to this backup.
            </p>
            <div className="ai-budget-grid">
              <label className="form-field">
                Global daily request limit
                <input
                  type="number"
                  required
                  min={1}
                  max={1000000}
                  value={config.dailyLimit}
                  onChange={(e) =>
                    edit({ ...config, dailyLimit: Number(e.target.value) })
                  }
                />
              </label>
              <label className="form-field">
                Maximum reply tokens
                <input
                  type="number"
                  required
                  min={128}
                  max={4096}
                  value={config.maxOutputTokens}
                  onChange={(e) =>
                    edit({ ...config, maxOutputTokens: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <p className="small">
              Global and provider budgets apply to everyone, including
              whitelisted IPs. Per-IP controls are under Request limits.
            </p>
            <div className="ai-provider-list">
              {config.providers.map((provider, index) => (
                <section
                  key={provider.id}
                  className="ai-provider-card"
                  aria-label={provider.name}
                >
                  <header className="ai-provider-heading">
                    <span className="badge">{index + 1}</span>
                    <h3>{provider.name}</h3>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={index === 0}
                      aria-label={`Move ${provider.name} up`}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={index === config.providers.length - 1}
                      aria-label={`Move ${provider.name} down`}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                  </header>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={provider.enabled}
                      onChange={(e) =>
                        update(provider.id, { enabled: e.target.checked })
                      }
                    />
                    Enable {provider.name}
                  </label>
                  <div className="ai-budget-grid">
                    <label className="form-field">
                      Model ID
                      <input
                        aria-label={`${provider.name} model`}
                        required={provider.enabled}
                        maxLength={120}
                        value={provider.model}
                        onChange={(e) =>
                          update(provider.id, { model: e.target.value })
                        }
                      />
                    </label>
                    <label className="form-field">
                      Account tier
                      <select
                        aria-label={`${provider.name} account tier`}
                        value={provider.billing}
                        onChange={(e) =>
                          update(provider.id, {
                            billing: e.target.value,
                            freeTierConfirmed: false,
                          })
                        }
                      >
                        {["groq", "gemini"].includes(provider.id) && (
                          <option value="free">Free-tier account</option>
                        )}
                        <option value="paid">Paid / API credits</option>
                      </select>
                    </label>
                  </div>
                  {provider.billing === "free" && (
                    <label className="checkbox">
                      <input
                        aria-label={`Confirm ${provider.name} free tier`}
                        type="checkbox"
                        checked={provider.freeTierConfirmed}
                        onChange={(e) =>
                          update(provider.id, {
                            freeTierConfirmed: e.target.checked,
                          })
                        }
                      />
                      This key uses a free-tier account or project with paid
                      billing disabled.
                    </label>
                  )}
                  {provider.id === "custom" && (
                    <div className="ai-budget-grid">
                      <label className="form-field">
                        Provider base URL
                        <input
                          type="url"
                          required
                          value={provider.baseUrl}
                          onChange={(e) =>
                            update(provider.id, { baseUrl: e.target.value })
                          }
                        />
                      </label>
                      <label className="form-field">
                        API protocol
                        <select
                          value={provider.protocol}
                          onChange={(e) =>
                            update(provider.id, { protocol: e.target.value })
                          }
                        >
                          <option value="responses">Responses</option>
                          <option value="chat-completions">
                            Chat Completions
                          </option>
                        </select>
                      </label>
                    </div>
                  )}
                  <label className="form-field">
                    API key
                    <input
                      aria-label={`${provider.name} API key`}
                      type="password"
                      autoComplete="new-password"
                      maxLength={4096}
                      value={provider.apiKey || ""}
                      onChange={(e) =>
                        update(provider.id, {
                          apiKey: e.target.value,
                          clearKey: false,
                        })
                      }
                      placeholder={
                        provider.hasKey
                          ? "Key saved · leave blank to keep it"
                          : "Paste this provider's key"
                      }
                    />
                  </label>
                  {provider.hasKey && (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={provider.clearKey || false}
                        onChange={(e) =>
                          update(provider.id, {
                            clearKey: e.target.checked,
                            apiKey: "",
                          })
                        }
                      />
                      Remove saved {provider.name} key
                    </label>
                  )}
                  <div className="ai-budget-grid quotas">
                    {Object.entries({
                      rpm: "Requests / minute",
                      rpd: "Requests / day",
                      tpm: "Tokens / minute",
                      tpd: "Tokens / day",
                    }).map(([field, label]) => (
                      <label className="form-field" key={field}>
                        {label}
                        <input
                          aria-label={`${provider.name} ${label}`}
                          type="number"
                          required
                          min={1}
                          max={10000000}
                          value={provider.limits[field]}
                          onChange={(e) =>
                            update(provider.id, {
                              limits: {
                                ...provider.limits,
                                [field]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p className="small">
                    Local caps, not an entitlement to provider capacity. Match
                    your account's actual limits; Gemini defaults are
                    conservative starting caps, not Google's published quota.
                  </p>
                  <div className="ai-provider-usage">
                    <span>Saved status: {provider.routingStatus}</span>
                    <span>
                      Minute: {provider.usage.minute.requests} requests ·{" "}
                      {provider.usage.minute.tokens.toLocaleString()} tokens
                    </span>
                    <span>
                      Today (UTC): {provider.usage.day.requests} requests ·{" "}
                      {provider.usage.day.tokens.toLocaleString()} tokens
                    </span>
                    {provider.usage.cooldown && (
                      <span>
                        Cooling down until{" "}
                        {new Date(
                          provider.usage.cooldown.until,
                        ).toLocaleTimeString()}{" "}
                        · {provider.usage.cooldown.reason}
                      </span>
                    )}
                  </div>
                </section>
              ))}
            </div>
            <p className="small">
              Token counts use reported usage when available, otherwise
              conservative reservations. Usage and cooldowns survive restarts.
              Saving settings does not reset budgets.
            </p>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                <Save size={15} />
                {busy ? "Saving…" : "Save AI settings"}
              </button>
              <button
                className="button"
                type="button"
                onClick={async () => {
                  try {
                    const result: Config = await api("/admin/ai");
                    setConfig((old) =>
                      old
                        ? {
                            ...old,
                            providers: old.providers.map((p) => ({
                              ...p,
                              usage: result.providers.find(
                                (v) => v.id === p.id,
                              )!.usage,
                            })),
                          }
                        : old,
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <RefreshCw size={14} />
                Refresh usage
              </button>
              {saved && (
                <span className="small" role="status">
                  <Check size={14} />
                  Saved
                </span>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
