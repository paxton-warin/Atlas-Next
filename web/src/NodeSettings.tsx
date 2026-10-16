import { useEffect, useState } from "react";
import { api, readLocal, writeLocal } from "./model";
import {
  selectBrowsingLeaseForOwner,
  SESSION_STORAGE_KEY,
} from "./browsing-session";
export type BrowsingNodeSelectionProps = {
  browsingSession?: string;
  browsingNode?: { id: string; name: string };
  browsingSessionStorageKey?: string;
  frontendStorage?: boolean;
  /** Combined frontend runtime owns reserve/probe/commit and peer renewal. */
  selectBrowsingNode?: (nodeId: string, csrf: string) => Promise<any>;
  onLeaseSelected: (lease: any, persisted: boolean) => void;
};
export default function NodeSettings({
  csrf,
  browsingSession,
  browsingNode,
  browsingSessionStorageKey = SESSION_STORAGE_KEY,
  frontendStorage = false,
  selectBrowsingNode,
  onLeaseSelected,
}: { csrf: string } & BrowsingNodeSelectionProps) {
  const [nodes, setNodes] = useState<any[]>([]),
    [name, setName] = useState(""),
    [endpoint, setEndpoint] = useState(""),
    [error, setError] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedNode, setSelectedNode] = useState(""),
    [changingConnection, setChangingConnection] = useState(false);
  const request = (path = "", options: RequestInit = {}) =>
    api("/admin/nodes" + path, {
      ...options,
      headers: { ...options.headers, "x-atlas-csrf": csrf },
    });
  const requiresSetup = (node: any) =>
    node.setupRequired && !(selectBrowsingNode && node.id === "local");
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
      <form
        className="setting-card"
        onSubmit={async (event) => {
          event.preventDefault();
          if (changingConnection) return;
          setChangingConnection(true);
          setError("");
          try {
            if (selectBrowsingNode) {
              const lease = await selectBrowsingNode(selectedNode, csrf);
              onLeaseSelected(lease, true);
              return;
            }
            let persisted = false;
            const lease = await selectBrowsingLeaseForOwner(
              browsingSession,
              () => readLocal(browsingSessionStorageKey, ""),
              (session) =>
                request("/select", {
                  method: "POST",
                  body: JSON.stringify({ session, node: selectedNode }),
                }),
              (session) => {
                persisted = writeLocal(browsingSessionStorageKey, session);
              },
              navigator.locks,
            );
            onLeaseSelected(lease, persisted);
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setChangingConnection(false);
          }
        }}
      >
        <h3>This browser's connection</h3>
        <p className="small">
          Current node: {browsingNode?.name || "No active connection"}.
        </p>
        <p className="small">
          Changes only this browser's connection, not other clients or node
          weights. Saved tabs stay intact;{" "}
          {selectBrowsingNode || frontendStorage
            ? "website storage stays on this Atlas frontend when the traffic node changes."
            : "websites may require signing in again on a different node."}{" "}
          Online draining nodes are available for owner tests.
        </p>
        <label className="form-field">
          Assign this browser to
          <select
            aria-label="Assign this browser to"
            value={selectedNode}
            disabled={changingConnection}
            onChange={(event) => setSelectedNode(event.target.value)}
          >
            <option value="">Automatic · active nodes</option>
            {nodes.map((node) => (
              <option
                key={node.id}
                value={node.id}
                disabled={
                  !node.online ||
                  node.state === "disabled" ||
                  requiresSetup(node)
                }
              >
                {node.name}
                {node.state === "draining" ? " · draining" : ""}
                {!node.online
                  ? " · offline"
                  : node.state === "disabled"
                    ? " · disabled"
                    : ""}
              </option>
            ))}
          </select>
        </label>
        <button className="button primary" disabled={changingConnection}>
          {changingConnection
            ? "Changing connection…"
            : "Apply to this browser"}
        </button>
      </form>
      <div className="node-list">
        {nodes.map((node) => (
          <article className="node-card" key={node.id}>
            <div>
              <strong>{node.name}</strong>
              <span className={"node-health " + (node.online ? "online" : "")}>
                {requiresSetup(node)
                  ? "Setup required"
                  : node.online
                    ? "Online"
                    : "Offline"}
              </span>
            </div>
            <p className="small">
              {selectBrowsingNode && node.id === "local"
                ? "Current frontend URL · Main server traffic relay"
                : node.relayMode === "frontend"
                  ? "Current frontend URL · Main server relay"
                  : node.runtimeOrigin ||
                    node.endpoint ||
                    "This server · local browsing runtime"}
            </p>
            {node.id === "local" && (
              <p className="small">
                {requiresSetup(node) && node.relayMode === "frontend" ? (
                  "Update and attach a healthy node to host the isolated browsing frame. Website traffic still uses Main server's IP and bandwidth."
                ) : requiresSetup(node) ? (
                  <>
                    Set <code>RUNTIME_ORIGIN</code> to this server's separate
                    browsing hostname and restart Atlas before enabling it.
                  </>
                ) : node.state === "active" ? (
                  "Main server participates in load balancing alongside the other active nodes."
                ) : (
                  "Main server is not accepting new sessions. Set its state to Active to include it in load balancing."
                )}
              </p>
            )}
            <p className="small">
              {node.connections} connections · {node.sessions} pinned sessions
              {node.hostedSessions
                ? ` · ${node.hostedSessions} hosted frames`
                : ""}
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
                  <option value="active" disabled={node.setupRequired}>
                    Active
                  </option>
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
                  disabled={node.sessions > 0 || node.hostedSessions > 0}
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
