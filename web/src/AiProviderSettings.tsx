import { useEffect, useState } from "react";
import { Check, Save } from "lucide-react";
import { api } from "./model";
export default function AiProviderSettings({ csrf }: { csrf: string }) {
  const [config, setConfig] = useState<any>(null),
    [apiKey, setApiKey] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/admin/ai")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="setting-card">
      <h2>AI provider</h2>
      <p>
        The built-in chat uses this server-side connection. API keys are
        encrypted in the database and never returned to visitors.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {config && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setSaved(false);
            setError("");
            try {
              await api("/admin/ai", {
                method: "PUT",
                headers: { "x-atlas-csrf": csrf },
                body: JSON.stringify({ ...config, apiKey }),
              });
              setConfig({ ...config, hasKey: !!apiKey || config.hasKey });
              setApiKey("");
              setSaved(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) =>
                setConfig({ ...config, enabled: e.target.checked })
              }
            />
            Enable AI chat
          </label>
          <label className="form-field">
            API protocol
            <select
              aria-label="API protocol"
              value={config.protocol}
              onChange={(e) =>
                setConfig({ ...config, protocol: e.target.value })
              }
            >
              <option value="responses">OpenAI Responses</option>
              <option value="chat-completions">
                OpenAI-compatible Chat Completions
              </option>
            </select>
          </label>
          <label className="form-field">
            Provider base URL
            <input
              required
              type="url"
              value={config.baseUrl}
              onChange={(e) =>
                setConfig({ ...config, baseUrl: e.target.value })
              }
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label className="form-field">
            Model ID
            <input
              required
              maxLength={120}
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              placeholder="Model available from your provider"
            />
          </label>
          <label className="form-field">
            API key
            <input
              type="password"
              autoComplete="new-password"
              maxLength={4096}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config.hasKey
                  ? "Key saved · leave blank to keep it"
                  : "Provider API key"
              }
            />
          </label>
          <label className="form-field">
            Global daily request limit
            <input
              required
              type="number"
              min={1}
              max={10000}
              value={config.dailyLimit}
              onChange={(e) =>
                setConfig({ ...config, dailyLimit: Number(e.target.value) })
              }
            />
            <small>
              Also limited to 20 requests per IP per hour and 2 concurrent
              replies per IP. Set a spending limit with your provider.
            </small>
          </label>
          <div className="button-row">
            <button className="button primary" disabled={busy}>
              <Save size={15} />
              {busy ? "Saving…" : "Save AI settings"}
            </button>
            {saved && (
              <span className="small" role="status">
                <Check size={14} />
                Saved
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
