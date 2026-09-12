import { useEffect, useState } from "react";
import { api } from "./model";
export default function NodeSettings({ csrf }: { csrf: string }) {
  const [nodes, setNodes] = useState<any[]>([]),
    [name, setName] = useState(""),
    [endpoint, setEndpoint] = useState(""),
    [error, setError] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false);
  const request = (path = "", options: RequestInit = {}) =>
    api("/admin/nodes" + path, {
      ...options,
      headers: { ...options.headers, "x-atlas-csrf": csrf },
    });
  const refresh = () =>
    request()
      .then(setNodes)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);
  async function update(node: any, patch: any) {
    try {
      await request("/" + node.id, {
        method: "PUT",
        body: JSON.stringify({ ...node, ...patch }),
      });
      setError("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="setting-card node-settings">
      <h2>Browsing nodes</h2>
      <p>
        Visitors connect directly to their assigned node. Existing sessions stay
        pinned; draining stops new assignments without moving active sessions.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="node-list">
        {nodes.map((node) => (
          <article className="node-card" key={node.id}>
            <div>
              <strong>{node.name}</strong>
              <span className={"node-health " + (node.online ? "online" : "")}>
                {node.online ? "Online" : "Offline"}
              </span>
            </div>
            <p className="small">
              {node.endpoint || "This server · local browsing runtime"}
            </p>
            <p className="small">
              {node.connections} connections · {node.sessions} pinned sessions
              {node.seen
                ? " · Seen " + new Date(node.seen).toLocaleTimeString()
                : ""}
            </p>
            <div className="button-row">
              <label>
                State{" "}
                <select
                  aria-label={node.name + " state"}
                  value={node.state}
                  onChange={(e) => void update(node, { state: e.target.value })}
                >
                  <option value="active">Active</option>
                  <option value="draining">Draining</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label>
                Weight{" "}
                <input
                  aria-label={node.name + " weight"}
                  type="number"
                  min="1"
                  max="100"
                  value={node.weight}
                  onChange={(e) => {
                    const weight = Number(e.target.value);
                    if (weight >= 1 && weight <= 100)
                      void update(node, { weight });
                  }}
                />
              </label>
              {node.id !== "local" && (
                <button
                  className="button"
                  disabled={node.sessions > 0}
                  onClick={async () => {
                    if (!confirm("Remove " + node.name + "?")) return;
                    try {
                      await request("/" + node.id, { method: "DELETE" });
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <h3>Attach a node</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await request("", {
              method: "POST",
              body: JSON.stringify({ name, endpoint, code }),
            });
            setCode("");
            setName("");
            setEndpoint("");
            setError("");
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="form-field">
          Node name
          <input
            aria-label="Node name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            placeholder="VPS 2"
          />
        </label>
        <label className="form-field">
          CloudFront endpoint
          <input
            aria-label="Node endpoint"
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            required
            placeholder="https://dxx101.cloudfront.net"
          />
        </label>
        <label className="form-field">
          Pairing code
          <input
            aria-label="Node pairing code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="off"
            placeholder="Code printed by the node"
          />
        </label>
        <button className="button primary" disabled={busy}>
          Attach node
        </button>
      </form>
    </section>
  );
}
