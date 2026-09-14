import { randomUUID } from "node:crypto";
import { signTicket, verifyTicket } from "./node-ticket.mjs";
import { token, digest } from "./store.mjs";
const TTL = 12 * 60 * 60 * 1000;
const FRESH = 45000;
const fail = (message, statusCode = 400) =>
  Object.assign(Error(message), { statusCode });
export function createNodePool(
  store,
  { runtimeOrigin, localRelayMode = "isolated" } = {},
) {
  const { db, seal, unseal, audit } = store;
  const frontendRelay = localRelayMode === "frontend";
  const isolatedReady =
    !runtimeOrigin || new URL(runtimeOrigin).hostname !== "runtime.invalid";
  if (!store.get("localNodeSecret"))
    store.set("localNodeSecret", seal(token()));
  let localConnections = () => 0;
  const localSecret = unseal(store.get("localNodeSecret"));
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL, credential TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active', weight INTEGER NOT NULL DEFAULT 1, seen INTEGER NOT NULL DEFAULT 0,
    connections INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS browse_leases (hash TEXT PRIMARY KEY, node TEXT NOT NULL, origin TEXT NOT NULL,
    created INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS browse_leases_node ON browse_leases(node);`);
  db.prepare(
    "INSERT OR IGNORE INTO nodes VALUES ('local','Main server','','',?,1,0,0)",
  ).run(process.env.LOCAL_BROWSING === "false" ? "disabled" : "active");
  const node = (id) => db.prepare("SELECT * FROM nodes WHERE id=?").get(id);
  if (
    !db
      .prepare("PRAGMA table_info(browse_leases)")
      .all()
      .some((c) => c.name === "runtime_node")
  )
    db.exec("ALTER TABLE browse_leases ADD COLUMN runtime_node TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS browse_leases_runtime_node ON browse_leases(runtime_node)",
  );
  const hostCapable = (n) =>
    (store.get("nodeCapabilities") || {})[n.id]?.includes("frontend-relay-v1");
  const hosts = () =>
    db
      .prepare("SELECT * FROM nodes WHERE id != 'local' AND state = 'active'")
      .all()
      .filter((n) => Date.now() - n.seen < FRESH && hostCapable(n));
  const localReady = () => (frontendRelay ? hosts().length > 0 : isolatedReady);
  const online = (n) =>
    n && (n.id === "local" ? localReady() : Date.now() - n.seen < FRESH);
  const available = (n) => online(n) && n.state !== "disabled";
  const prune = () =>
    db.prepare("DELETE FROM browse_leases WHERE seen<?").run(Date.now() - TTL);
  function list() {
    prune();
    return db
      .prepare(
        "SELECT id,name,endpoint,state,weight,seen,connections FROM nodes ORDER BY id",
      )
      .all()
      .map((n) => ({
        ...n,
        connections: n.id === "local" ? localConnections() : n.connections,
        online: online(n),
        runtimeOrigin:
          n.id === "local"
            ? frontendRelay
              ? null
              : runtimeOrigin
            : n.endpoint,
        relayMode: n.id === "local" ? localRelayMode : "direct",
        capabilities: (store.get("nodeCapabilities") || {})[n.id] || [],
        setupRequired: n.id === "local" && !localReady(),
        hostedSessions: db
          .prepare("SELECT count(*) n FROM browse_leases WHERE runtime_node=?")
          .get(n.id).n,
        sessions: db
          .prepare("SELECT count(*) AS n FROM browse_leases WHERE node=?")
          .get(n.id).n,
      }));
  }
  function add({ name, endpoint, weight = 1 }) {
    const u = new URL(endpoint);
    if (
      ![
        "https:",
        ...(process.env.NODE_ENV === "production" ? [] : ["http:"]),
      ].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw fail("Use the node's HTTPS origin.");
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      !Number.isInteger(weight) ||
      weight < 1 ||
      weight > 100
    )
      throw fail("Enter a name and weight from 1 to 100.");
    const id = randomUUID(),
      secret = token();
    db.prepare(
      "INSERT INTO nodes(id,name,endpoint,credential,weight) VALUES (?,?,?,?,?)",
    ).run(id, name.trim(), u.origin, seal(secret), weight);
    audit("node.add", id);
    return { id, token: secret };
  }
  async function attach({ name, endpoint, code }, controlUrl) {
    if (typeof code !== "string" || !code.trim() || code.length > 64)
      throw fail("Enter the pairing code printed by the node.");
    const normalized = new URL(endpoint).origin;
    let n = db.prepare("SELECT * FROM nodes WHERE endpoint=?").get(normalized);
    if (!n) {
      const created = add({
        name: name || new URL(endpoint).hostname,
        endpoint,
      });
      n = node(created.id);
    }
    const secret = unseal(n.credential);
    let response;
    try {
      response = await fetch(n.endpoint + "/node/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id, token: secret, code, controlUrl }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    } catch {
      throw fail(
        "Node endpoint is unreachable. Check its CloudFront connection, then retry Attach.",
        502,
      );
    }
    if (!response.ok)
      throw fail(
        response.status === 401
          ? "Pairing code is incorrect or expired."
          : "Node pairing failed. Check the node's status and retry.",
        response.status === 401 ? 400 : 502,
      );
    await heartbeat(n.id, secret, 0);
    return { id: n.id, attached: true };
  }
  function update(id, patch) {
    const n = node(id);
    if (!n) throw fail("Node not found.", 404);
    if (id === "local" && patch.state === "active" && !localReady())
      throw fail(
        frontendRelay
          ? "Update and attach at least one healthy node with frontend-relay support before enabling Main server."
          : "Set RUNTIME_ORIGIN to the main server's separate browsing hostname before enabling Main server.",
      );
    if (
      !["active", "draining", "disabled"].includes(patch.state) ||
      !Number.isInteger(patch.weight) ||
      patch.weight < 1 ||
      patch.weight > 100
    )
      throw fail("Invalid node settings.");
    db.prepare("UPDATE nodes SET state=?,weight=? WHERE id=?").run(
      patch.state,
      patch.weight,
      id,
    );
    audit("node.update", id);
  }
  function remove(id) {
    prune();
    if (id === "local")
      throw fail("Disable the main server instead of removing it.");
    if (
      db
        .prepare(
          "SELECT count(*) n FROM browse_leases WHERE node=? OR runtime_node=?",
        )
        .get(id, id).n
    )
      throw fail(
        "Drain this node until its sessions end before removing it.",
        409,
      );
    db.prepare("DELETE FROM nodes WHERE id=?").run(id);
    const order = store.get("nodeAssignmentOrder") || {};
    delete order[id];
    store.set("nodeAssignmentOrder", order);
    const capabilities = store.get("nodeCapabilities") || {};
    delete capabilities[id];
    store.set("nodeCapabilities", capabilities);
    audit("node.remove", id);
  }
  function authenticate(id, secret) {
    const n = node(id);
    if (
      !n ||
      !n.credential ||
      !secret ||
      digest(unseal(n.credential)) !== digest(secret)
    )
      throw fail("Node verification failed.", 401);
    return n;
  }
  async function heartbeat(id, secret, connections) {
    const n = authenticate(id, secret);
    // A heartbeat alone doesn't prove that the backend can reach the relay.
    const response = await fetch(n.endpoint + "/node/health", {
      headers: { authorization: "Bearer " + secret },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    const health = response.ok ? await response.json() : null;
    if (!health || health.id !== id)
      throw fail("Node endpoint check failed.", 502);
    const capabilities = store.get("nodeCapabilities") || {};
    capabilities[id] = Array.isArray(health.capabilities)
      ? health.capabilities.filter((c) => c === "frontend-relay-v1")
      : [];
    store.set("nodeCapabilities", capabilities);
    db.prepare("UPDATE nodes SET seen=?,connections=? WHERE id=?").run(
      Date.now(),
      Math.max(0, Math.min(100000, Number(connections) || 0)),
      id,
    );
  }
  async function allocate(raw, origin, runtimeOrigin) {
    prune();
    let hash, lease;
    if (raw) {
      if (typeof raw !== "string" || raw.length > 100)
        throw fail("Invalid browsing session.");
      hash = digest(raw);
      lease = db.prepare("SELECT * FROM browse_leases WHERE hash=?").get(hash);
      if (!lease || lease.origin !== origin)
        throw fail(
          "Browsing session expired. Choose Reconnect to start a new session.",
          409,
        );
    } else {
      // Synchronous SQLite allocation reserves a lease before the next request.
      const candidates = list().filter((n) => n.state === "active" && n.online);
      const order = store.get("nodeAssignmentOrder") || {};
      candidates.sort(
        (a, b) =>
          (a.sessions + a.connections) / a.weight -
            (b.sessions + b.connections) / b.weight ||
          (order[a.id] || 0) - (order[b.id] || 0) ||
          a.id.localeCompare(b.id),
      );
      if (!candidates.length)
        throw fail("No browsing nodes are available.", 503);
      raw = token();
      hash = digest(raw);
      lease = {
        hash,
        node: candidates[0].id,
        origin,
        created: Date.now(),
        seen: Date.now(),
        runtime_node:
          candidates[0].id === "local" && frontendRelay
            ? hosts()
                .filter(
                  (n) =>
                    new URL(n.endpoint).hostname !== new URL(origin).hostname,
                )
                .sort((a, b) => a.id.localeCompare(b.id))[0]?.id
            : null,
      };
      if (candidates[0].id === "local" && frontendRelay && !lease.runtime_node)
        throw fail(
          "No isolated runtime host is available for Main server.",
          503,
        );
      db.prepare(
        "INSERT INTO browse_leases(hash,node,origin,created,seen,runtime_node) VALUES (?,?,?,?,?,?)",
      ).run(
        hash,
        lease.node,
        origin,
        lease.created,
        lease.seen,
        lease.runtime_node,
      );
      // Persist tie-break order separately from leases, so reconnect/release
      // cannot repeatedly favor UUID-named remotes over the "local" node.
      order[lease.node] =
        Object.values(order).reduce(
          (max, value) => Math.max(max, Number(value) || 0),
          0,
        ) + 1;
      store.set("nodeAssignmentOrder", order);
    }
    db.prepare("UPDATE browse_leases SET seen=? WHERE hash=?").run(
      Date.now(),
      hash,
    );
    const n = node(lease.node);
    if (n?.id === "local" && frontendRelay && !lease.runtime_node)
      throw fail(
        "Main server connection changed. Choose Reconnect to start a new session.",
        409,
      );
    if (n?.id === "local" && !frontendRelay && lease.runtime_node)
      throw fail(
        "Main server connection changed. Choose Reconnect to start a new session.",
        409,
      );
    const host = lease.runtime_node ? node(lease.runtime_node) : n;
    const selectedOrigin = lease.runtime_node
      ? host?.endpoint
      : n?.id === "local"
        ? runtimeOrigin
        : n?.endpoint;
    const hostAvailable =
      host &&
      (host.id === "local" ||
        (Date.now() - host.seen < FRESH && host.state !== "disabled"));
    if (lease.runtime_node && (!hostAvailable || !n || n.state === "disabled"))
      throw fail(
        "Your assigned node or runtime host is unavailable. Reconnect explicitly to select another connection.",
        503,
      );
    if (host?.id !== "local" && available(host)) {
      const response = await fetch(host.endpoint + "/node/control", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer " + unseal(host.credential),
        },
        body: JSON.stringify(nodeState(host.id)),
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok)
        throw fail(
          "Your assigned node is unreachable. Reconnect explicitly to select another node.",
          503,
        );
    }
    const serverTime = Date.now(),
      expiresAt = serverTime + TTL;
    return {
      serverTime,
      expiresAt,
      session: raw,
      runtimeOrigin: selectedOrigin,
      node: {
        id: n?.id || lease.node,
        name: n?.name || "Removed node",
        online: lease.runtime_node
          ? Boolean(hostAvailable && n && n.state !== "disabled")
          : available(n),
      },
      relayOrigin: lease.runtime_node ? origin : selectedOrigin,
      runtimeHost: lease.runtime_node
        ? { id: host.id, name: host.name }
        : undefined,
      ticket: lease.runtime_node
        ? signTicket(
            {
              lease: hash,
              origin,
              runtimeOrigin: selectedOrigin,
              node: host.id,
              name: n.name,
              role: "runtime-host",
              expires: expiresAt,
              relayOrigin: origin,
              relayTicket: signTicket(
                {
                  lease: hash,
                  origin,
                  runtimeOrigin: selectedOrigin,
                  node: "local",
                  name: n.name,
                  role: "frontend-relay",
                  expires: expiresAt,
                },
                localSecret,
              ),
            },
            unseal(host.credential),
          )
        : signTicket(
            {
              lease: hash,
              origin,
              runtimeOrigin: selectedOrigin,
              node: n.id,
              name: n.name,
              expires: expiresAt,
            },
            n.id === "local" ? localSecret : unseal(n.credential),
          ),
    };
  }
  function resolve(ticket, runtimeOrigin, purpose = "runtime") {
    let t;
    try {
      t = verifyTicket(ticket, localSecret, runtimeOrigin);
    } catch {
      throw fail("Invalid browsing ticket.", 401);
    }
    if (t.expires < Date.now() || t.runtimeOrigin !== runtimeOrigin)
      throw fail("Browsing ticket expired. Reconnect from Atlas.", 401);
    const lease = db
      .prepare("SELECT * FROM browse_leases WHERE hash=?")
      .get(t.lease);
    if (!lease || lease.origin !== t.origin || Date.now() - lease.seen > TTL)
      throw fail("Browsing session expired.", 401);
    const n = node(lease.node);
    if (
      lease.runtime_node &&
      (purpose !== "relay" ||
        t.role !== "frontend-relay" ||
        t.node !== "local" ||
        node(lease.runtime_node)?.endpoint !== runtimeOrigin)
    )
      throw fail("Invalid relay ticket.", 401);
    if (lease.runtime_node) {
      const host = node(lease.runtime_node);
      if (!host || host.state === "disabled" || Date.now() - host.seen >= FRESH)
        throw fail(
          "Runtime host is unavailable. Reconnect explicitly from Atlas.",
          503,
        );
    }
    // Never fail over an existing session: its outbound IP must not silently change.
    if (!(n && n.state !== "disabled" && (lease.runtime_node || online(n))))
      throw fail(
        "Your browsing node is offline. Reconnect explicitly to choose another node.",
        503,
      );
    db.prepare("UPDATE browse_leases SET seen=? WHERE hash=?").run(
      Date.now(),
      lease.hash,
    );
    return {
      node: { id: n.id, name: n.name },
      appOrigin: t.origin,
      session: lease.hash,
    };
  }
  function release(raw, origin) {
    if (typeof raw !== "string" || raw.length > 100)
      throw fail("Invalid browsing session.");
    db.prepare("DELETE FROM browse_leases WHERE hash=? AND origin=?").run(
      digest(raw),
      origin,
    );
  }
  function nodeState(id) {
    const n = node(id);
    if (!n) throw fail("Node not found.", 404);
    prune();
    const revision = (store.get("nodeControlRevision") || 0) + 1;
    store.set("nodeControlRevision", revision);
    return {
      revision,
      state: n.state,
      leases: db
        .prepare(
          "SELECT hash FROM browse_leases WHERE node=? OR runtime_node=?",
        )
        .all(id, id)
        .map((x) => x.hash),
    };
  }
  return {
    list,
    attach,
    add,
    update,
    remove,
    authenticate,
    heartbeat,
    allocate,
    resolve,
    release,
    nodeState,
    setLocalConnections: (provider) => {
      localConnections = provider;
    },
  };
}
