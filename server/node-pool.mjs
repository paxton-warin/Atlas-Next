import { createFrontendAssignments } from "./frontend-assignments.mjs";
import {
  acceptedNodeCapabilities,
  FRONTEND_CONTROLLER_RELAY_V2,
  FRONTEND_NATIVE_RESOURCES_V1,
} from "./runtime-capabilities.mjs";
import {
  RESOURCE_OWNER_ROLE,
  RESOURCE_OWNER_PURPOSE,
} from "./native-resource-authority.mjs";
import { randomUUID } from "node:crypto";
import { signTicket, verifyTicket, connectionError } from "./node-ticket.mjs";
import { token, digest } from "./store.mjs";
const TTL = 12 * 60 * 60 * 1000;
const TICKET_TTL = 12 * 60 * 60 * 1000;
const FRESH = 45000;
const TOMBSTONE_TTL = 7 * 24 * 60 * 60 * 1000;
const fail = (message, statusCode = 400) =>
  Object.assign(Error(message), { statusCode });
export function createNodePool(
  store,
  { runtimeOrigin, localRelayMode = "isolated", sameOriginRuntime = false } = {},
) {
  const { db, seal, unseal, audit } = store;
  const frontendRelay = localRelayMode === "frontend";
  const isolatedReady =
    !runtimeOrigin || new URL(runtimeOrigin).hostname !== "runtime.invalid";
  if (!store.get("localNodeSecret"))
    store.set("localNodeSecret", seal(token()));
  let localConnections = () => 0;
  let localRelayStats = () => null;
  // Only fresh, authenticated relay observations describe connected browsing
  // sessions. Stored twelve-hour assignments are not concurrency measurements.
  const remoteRelayStats = new Map();
  const activeSessionCount = (stats) =>
    stats &&
    Number.isSafeInteger(stats.activeSessions) &&
    stats.activeSessions >= 0 &&
    Number.isSafeInteger(stats.connections) &&
    stats.connections >= stats.activeSessions &&
    stats.connections <= 100000
      ? stats.activeSessions
      : null;
  function sessionObservation(n) {
    if (n.id === "local") {
      try {
        const count = activeSessionCount(localRelayStats());
        return {
          activeSessions: count,
          activeSessionsUpdatedAt: count === null ? 0 : Date.now(),
        };
      } catch {
        return { activeSessions: null, activeSessionsUpdatedAt: 0 };
      }
    }
    const observation = remoteRelayStats.get(n.id);
    return {
      activeSessions:
        observation &&
        Date.now() - n.seen < FRESH &&
        Date.now() - observation.updatedAt < FRESH
          ? observation.activeSessions
          : null,
      activeSessionsUpdatedAt: observation?.updatedAt || 0,
    };
  }
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
  if (
    !db
      .prepare("PRAGMA table_info(browse_leases)")
      .all()
      .some((c) => c.name === "generation")
  )
    db.exec(
      "ALTER TABLE browse_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 1",
    );
  db.exec(`CREATE TABLE IF NOT EXISTS browse_lease_tombstones (
    hash TEXT PRIMARY KEY, node TEXT NOT NULL, origin TEXT NOT NULL, runtime_node TEXT,
    generation INTEGER NOT NULL, reason TEXT NOT NULL, removed INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS browse_lease_tombstones_expiry ON browse_lease_tombstones(expires);`);
  const hostCapable = (n) =>
    (store.get("nodeCapabilities") || {})[n.id]?.includes("frontend-relay-v1");
  const hosts = () =>
    db
      .prepare("SELECT * FROM nodes WHERE id != 'local' AND state = 'active'")
      .all()
      .filter((n) => Date.now() - n.seen < FRESH && hostCapable(n));
  const localReady = () => sameOriginRuntime || (frontendRelay ? hosts().length > 0 : isolatedReady);
  const online = (n) =>
    n && (n.id === "local" ? localReady() : Date.now() - n.seen < FRESH);
  const available = (n) => online(n) && n.state !== "disabled";
  function prune() {
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO browse_lease_tombstones
      SELECT hash,node,origin,runtime_node,generation,'expired',seen+?,seen+?+?
      FROM browse_leases WHERE seen<=?`,
    ).run(TTL, TTL, TOMBSTONE_TTL, now - TTL);
    db.prepare("DELETE FROM browse_leases WHERE seen<=?").run(now - TTL);
    db.prepare("DELETE FROM browse_lease_tombstones WHERE expires<=?").run(now);
  }
  function retire(hash, origin, reason = "revoked") {
    const row = db
      .prepare("SELECT * FROM browse_leases WHERE hash=? AND origin=?")
      .get(hash, origin);
    if (row) {
      db.prepare(
        "INSERT OR REPLACE INTO browse_lease_tombstones VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        hash,
        row.node,
        origin,
        row.runtime_node,
        row.generation,
        reason,
        Date.now(),
        Date.now() + TOMBSTONE_TTL,
      );
      db.prepare("DELETE FROM browse_leases WHERE hash=? AND origin=?").run(
        hash,
        origin,
      );
    } else if (reason === "revoked") {
      db.prepare(
        "UPDATE browse_lease_tombstones SET reason='revoked',removed=?,expires=? WHERE hash=? AND origin=?",
      ).run(Date.now(), Date.now() + TOMBSTONE_TTL, hash, origin);
    }
  }
  function missingSession(hash, origin) {
    const tombstone = db
      .prepare(
        "SELECT * FROM browse_lease_tombstones WHERE hash=? AND origin=?",
      )
      .get(hash, origin);
    return connectionError(
      tombstone?.reason === "revoked"
        ? "This browsing session was revoked. Reconnect to start a new session."
        : "Browsing session expired. Choose Reconnect to start a new session.",
      409,
      tombstone?.reason === "revoked"
        ? "SESSION_REVOKED"
        : tombstone
          ? "SESSION_EXPIRED"
          : "INVALID_SESSION",
    );
  }
  function list({ includeConcurrency = false } = {}) {
    prune();
    return db
      .prepare(
        "SELECT id,name,endpoint,state,weight,seen,connections FROM nodes ORDER BY id",
      )
      .all()
      .map((n) => ({
        ...n,
        ...(includeConcurrency ? sessionObservation(n) : {}),
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
  function ccu() {
    const rows = list({ includeConcurrency: true });
    const observed = rows.filter((n) => n.activeSessions !== null);
    return {
      activeSessions: observed.reduce((total, n) => total + n.activeSessions, 0),
      complete: observed.length === rows.length,
      reportingNodes: observed.length,
      totalNodes: rows.length,
      updatedAt: observed.length
        ? Math.min(...observed.map((n) => n.activeSessionsUpdatedAt))
        : 0,
      freshnessMs: FRESH,
    };
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
    remoteRelayStats.delete(id);
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
    capabilities[id] = acceptedNodeCapabilities(health.capabilities);
    store.set("nodeCapabilities", capabilities);
    db.prepare("UPDATE nodes SET seen=?,connections=? WHERE id=?").run(
      Date.now(),
      Math.max(0, Math.min(100000, Number(connections) || 0)),
      id,
    );
    // Do not trust a new heartbeat field or use raw relay connections as CCU.
    // The paired endpoint's protected health response is the measurement source.
    remoteRelayStats.set(id, {
      activeSessions: activeSessionCount(health.relay),
      updatedAt: Date.now(),
    });
  }
  async function allocate(raw, origin, runtimeOrigin) {
    return allocateLease(raw, origin, runtimeOrigin);
  }
  const operations = new Map();
  function operate(input = {}, origin, runtimeOrigin) {
    const {
      intent = input.session ? "restore" : "new",
      session: raw = "",
      generation,
    } = input;
    if (
      !["restore", "renew", "new"].includes(intent) ||
      typeof raw !== "string" ||
      raw.length > 100 ||
      (generation != null &&
        (!Number.isSafeInteger(generation) || generation < 1)) ||
      (intent === "renew" && !raw)
    )
      return Promise.reject(
        connectionError(
          "Invalid browsing session operation.",
          400,
          "INVALID_SESSION",
        ),
      );
    const key = origin + ":" + (raw ? digest(raw) : "new:" + randomUUID());
    const pending = operations.get(key);
    if (pending) {
      if (pending.intent === intent && pending.generation === generation)
        return pending.promise;
      return Promise.reject(
        connectionError(
          "This connection is already being updated.",
          409,
          "SESSION_BUSY",
          true,
        ),
      );
    }
    const promise = Promise.resolve()
      .then(async () => {
        prune();
        const hash = raw ? digest(raw) : "";
        let lease =
          hash &&
          db.prepare("SELECT * FROM browse_leases WHERE hash=?").get(hash);
        const tombstone =
          hash &&
          db
            .prepare(
              "SELECT * FROM browse_lease_tombstones WHERE hash=? AND origin=?",
            )
            .get(hash, origin);
        if (
          (lease && lease.origin !== origin) ||
          (!lease && hash && !tombstone && intent !== "new")
        )
          throw missingSession(hash, origin);
        if (lease && frontendAssignments.isFrontend(hash))
          throw connectionError(
            "Refresh Atlas to use the current frontend browsing protocol.",
            409,
            "RUNTIME_PROTOCOL_REQUIRED",
          );
        if (generation != null && lease && generation !== lease.generation)
          throw connectionError(
            "This browsing assignment changed. Refresh the connection state.",
            409,
            "SESSION_GENERATION_MISMATCH",
            true,
          );
        if (intent === "new" || !raw) {
          // Reserve first. A failed replacement never destroys the current pin.
          if (lease) return select(raw, origin, runtimeOrigin, "");
          const nextRaw = token();
          try {
            const result = await allocateLease(
              "",
              origin,
              runtimeOrigin,
              "",
              nextRaw,
              true,
            );
            if (tombstone) retire(hash, origin);
            return result;
          } catch (error) {
            db.prepare(
              "DELETE FROM browse_leases WHERE hash=? AND origin=?",
            ).run(digest(nextRaw), origin);
            throw error;
          }
        }
        if (!lease) {
          if (intent !== "restore" || tombstone.reason !== "expired")
            throw missingSession(hash, origin);
          if (generation != null && generation !== tombstone.generation)
            throw connectionError(
              "This browsing assignment changed.",
              409,
              "SESSION_GENERATION_MISMATCH",
              true,
            );
          const previous = node(tombstone.node),
            host = tombstone.runtime_node
              ? node(tombstone.runtime_node)
              : previous;
          if (!previous || previous.state === "disabled" || !available(host))
            throw connectionError(
              "Your previous browsing node is temporarily unavailable. Retry this connection or explicitly choose a new session.",
              503,
              "NODE_UNAVAILABLE",
              true,
            );
          // The old raw capability remains private to its holder. Incrementing the
          // assignment generation prevents old transport tickets from reviving.
          db.prepare(
            "INSERT INTO browse_leases(hash,node,origin,created,seen,runtime_node,generation) VALUES (?,?,?,?,?,?,?)",
          ).run(
            hash,
            tombstone.node,
            origin,
            Date.now(),
            Date.now(),
            tombstone.runtime_node,
            tombstone.generation + 1,
          );
          try {
            const result = await allocateLease(
              raw,
              origin,
              runtimeOrigin,
              "",
              "",
              true,
            );
            db.prepare("DELETE FROM browse_lease_tombstones WHERE hash=?").run(
              hash,
            );
            return result;
          } catch (error) {
            db.prepare(
              "DELETE FROM browse_leases WHERE hash=? AND generation=?",
            ).run(hash, tombstone.generation + 1);
            throw error;
          }
        }
        return allocateLease(raw, origin, runtimeOrigin, "", "", true);
      })
      .finally(() => operations.delete(key));
    operations.set(key, { intent, generation, promise });
    return promise;
  }
  // Preferred-node reservations are private to the owner selection operation.
  // The public allocation route never receives or forwards a preference.
  async function allocateLease(
    raw,
    origin,
    runtimeOrigin,
    preferredNode = "",
    replacementSession = "",
    strict = false,
  ) {
    prune();
    let hash, lease;
    if (raw) {
      if (typeof raw !== "string" || raw.length > 100)
        throw fail("Invalid browsing session.");
      hash = digest(raw);
      lease = db.prepare("SELECT * FROM browse_leases WHERE hash=?").get(hash);
      if (!lease || lease.origin !== origin) throw missingSession(hash, origin);
      if (frontendAssignments.isFrontend(hash))
        throw connectionError(
          "Refresh Atlas to use the current frontend browsing protocol.",
          409,
          "RUNTIME_PROTOCOL_REQUIRED",
        );
    } else {
      // Synchronous SQLite allocation reserves a lease before the next request.
      const candidates = list().filter((n) =>
        preferredNode
          ? n.id === preferredNode && n.state !== "disabled" && n.online
          : n.state === "active" && n.online,
      );
      const order = store.get("nodeAssignmentOrder") || {};
      candidates.sort(
        (a, b) =>
          (a.sessions + a.connections) / a.weight -
            (b.sessions + b.connections) / b.weight ||
          (order[a.id] || 0) - (order[b.id] || 0) ||
          a.id.localeCompare(b.id),
      );
      if (!candidates.length)
        throw connectionError(
          "No browsing nodes are available.",
          503,
          "NODE_UNAVAILABLE",
          true,
        );
      raw = replacementSession || token();
      hash = digest(raw);
      lease = {
        hash,
        node: candidates[0].id,
        origin,
        created: Date.now(),
        seen: Date.now(),
        generation: 1,
        runtime_node:
          candidates[0].id === "local" && frontendRelay && !sameOriginRuntime
            ? hosts()
                .filter(
                  (n) =>
                    new URL(n.endpoint).hostname !== new URL(origin).hostname,
                )
                .sort((a, b) => a.id.localeCompare(b.id))[0]?.id
            : null,
      };
      if (candidates[0].id === "local" && frontendRelay && !sameOriginRuntime && !lease.runtime_node)
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
    if (sameOriginRuntime) {
      // The document origin stays on this frontend. Only the authenticated
      // transport assignment changes; Main never needs a separate frame host.
      if (lease.runtime_node) {
        db.prepare("UPDATE browse_leases SET runtime_node=NULL WHERE hash=?").run(hash);
        lease.runtime_node = null;
      }
      const relay = await controllerRelay(raw, origin, lease.generation);
      const expiresAt = relay.ticketExpiresAt;
      return {
        serverTime: relay.serverTime,
        expiresAt,
        ticketExpiresAt: expiresAt,
        leaseExpiresAt: relay.leaseExpiresAt,
        generation: relay.generation,
        session: raw,
        sessionHash: hash,
        runtimeOrigin: origin,
        runtimePath: "/browse/runtime/",
        relayOrigin: relay.relayOrigin,
        relayTicket: relay.ticket,
        node: { ...relay.node, online: true },
        ticket: signTicket({
          role: "frontend-runtime-v1", node: relay.node.id, lease: hash,
          generation: relay.generation, origin, runtimeOrigin: origin,
          relayOrigin: relay.relayOrigin, relayTicket: relay.ticket, expires: expiresAt,
        }, localSecret),
      };
    }
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
    if (
      (strict || lease.runtime_node) &&
      (!hostAvailable || !n || n.state === "disabled")
    )
      throw connectionError(
        "Your assigned node or runtime host is unavailable. Reconnect explicitly to select another connection.",
        503,
        "NODE_UNAVAILABLE",
        true,
      );
    if (host?.id !== "local" && available(host)) {
      let response;
      try {
        response = await fetch(host.endpoint + "/node/control", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: "Bearer " + unseal(host.credential),
          },
          body: JSON.stringify(nodeState(host.id)),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
      } catch {
        throw connectionError(
          "Your assigned node is unreachable. Retry the same connection.",
          503,
          "CONTROL_UNAVAILABLE",
          true,
        );
      }
      if (!response.ok)
        throw connectionError(
          "Your assigned node is unreachable. Reconnect explicitly to select another node.",
          503,
          "CONTROL_UNAVAILABLE",
          true,
        );
    }
    const current = db
      .prepare("SELECT * FROM browse_leases WHERE hash=?")
      .get(hash);
    if (!current || current.generation !== lease.generation)
      throw missingSession(hash, origin);
    if (
      strict &&
      (!node(lease.node) ||
        node(lease.node).state === "disabled" ||
        !available(
          lease.runtime_node ? node(lease.runtime_node) : node(lease.node),
        ))
    )
      throw connectionError(
        "Your assigned node is unavailable.",
        503,
        "NODE_UNAVAILABLE",
        true,
      );
    const serverTime = Date.now(),
      expiresAt = serverTime + TICKET_TTL;
    return {
      serverTime,
      expiresAt,
      ticketExpiresAt: expiresAt,
      leaseExpiresAt: current.seen + TTL,
      generation: current.generation,
      session: raw,
      sessionHash: hash,
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
              generation: current.generation,
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
                  generation: current.generation,
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
              generation: current.generation,
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
  const selecting = new Set();
  async function select(raw, origin, runtimeOrigin, requestedNode) {
    if (
      typeof requestedNode !== "string" ||
      requestedNode.length > 100 ||
      (raw != null && (typeof raw !== "string" || raw.length > 100))
    )
      throw fail("Invalid browser node selection.");
    prune();
    const previousHash = raw ? digest(raw) : "";
    const previous = previousHash
      ? db.prepare("SELECT * FROM browse_leases WHERE hash=?").get(previousHash)
      : null;
    if (previousHash && frontendAssignments.isFrontend(previousHash))
      throw connectionError(
        "This assignment requires the frontend controller protocol.",
        409,
        "RUNTIME_PROTOCOL_REQUIRED",
      );
    if (previousHash && (!previous || previous.origin !== origin))
      throw connectionError(
        "Browsing session expired. Reload Atlas before selecting a node.",
        409,
        "SESSION_EXPIRED",
      );
    if (requestedNode) {
      const selected = node(requestedNode);
      if (!available(selected))
        throw connectionError(
          "Selected browsing node is unavailable.",
          503,
          "NODE_UNAVAILABLE",
          true,
        );
      if (
        selected.id !== "local" &&
        new URL(selected.endpoint).hostname === new URL(origin).hostname
      )
        throw fail("Select a node with a separate browsing hostname.");
    }
    if (previousHash && selecting.has(previousHash))
      throw connectionError(
        "This browser is already changing connections. Try again after it finishes.",
        409,
        "SESSION_BUSY",
        true,
      );
    if (previousHash) selecting.add(previousHash);
    const replacement = token(),
      replacementHash = digest(replacement);
    try {
      // Keep the old pin usable until the new node has accepted its reservation.
      const result = await allocateLease(
        "",
        origin,
        runtimeOrigin,
        requestedNode,
        replacement,
        true,
      );
      const lease = db
        .prepare("SELECT * FROM browse_leases WHERE hash=?")
        .get(replacementHash);
      const selected = node(result.node.id);
      const host = lease?.runtime_node ? node(lease.runtime_node) : selected;
      if (
        !lease ||
        !selected ||
        selected.state === "disabled" ||
        !(lease.runtime_node
          ? available(host) && hostCapable(host)
          : available(selected))
      )
        throw connectionError(
          "Selected browsing node is unavailable.",
          503,
          "NODE_UNAVAILABLE",
          true,
        );
      if (
        previousHash &&
        db
          .prepare("SELECT origin FROM browse_leases WHERE hash=?")
          .get(previousHash)?.origin !== origin
      )
        throw connectionError(
          "This browser's connection changed. Reload Atlas before selecting a node.",
          409,
          "SESSION_REVOKED",
        );
      db.exec("BEGIN");
      try {
        if (previousHash) retire(previousHash, origin);
        audit("node.select", result.node.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return result;
    } catch (error) {
      db.prepare("DELETE FROM browse_leases WHERE hash=? AND origin=?").run(
        replacementHash,
        origin,
      );
      if (error.statusCode) throw error;
      throw connectionError(
        "Selected browsing node is unreachable. Your original connection is unchanged.",
        503,
        "CONTROL_UNAVAILABLE",
        true,
      );
    } finally {
      if (previousHash) selecting.delete(previousHash);
    }
  }
  // Staged v2 transport negotiation. This does not activate frontend-hosted
  // documents or create a second public release. Only the holder of an existing
  // origin-bound owner capability may obtain a controller relay ticket.
  async function controllerRelay(raw, origin, generation) {
    if (
      typeof raw !== "string" ||
      !raw ||
      raw.length > 100 ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw connectionError(
        "Invalid browsing assignment.",
        400,
        "INVALID_SESSION",
      );
    prune();
    const hash = digest(raw);
    const read = () =>
      db
        .prepare("SELECT * FROM browse_leases WHERE hash=? AND origin=?")
        .get(hash, origin);
    const lease = read();
    if (!lease) throw missingSession(hash, origin);
    if (lease.generation !== generation)
      throw connectionError(
        "Browsing assignment changed.",
        409,
        "SESSION_GENERATION_MISMATCH",
        true,
      );
    const selected = node(lease.node);
    if (
      !selected ||
      selected.state === "disabled" ||
      (selected.id !== "local" && Date.now() - selected.seen >= FRESH)
    )
      throw connectionError(
        "Your assigned node is unavailable.",
        503,
        "NODE_UNAVAILABLE",
        true,
      );
    if (selected.id !== "local") {
      if (
        !(store.get("nodeCapabilities") || {})[selected.id]?.includes(
          FRONTEND_CONTROLLER_RELAY_V2,
        )
      )
        throw connectionError(
          "This node requires the combined runtime update.",
          409,
          "RUNTIME_CAPABILITY_REQUIRED",
        );
      let response;
      try {
        response = await fetch(selected.endpoint + "/node/control", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + unseal(selected.credential),
          },
          body: JSON.stringify(nodeState(selected.id)),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
      } catch {}
      if (!response?.ok)
        throw connectionError(
          "Node control is temporarily unavailable.",
          503,
          "CONTROL_UNAVAILABLE",
          true,
        );
    }
    // An async control response cannot resurrect an owner revoked/reassigned
    // while the node was being checked. No alternate node is selected here.
    const current = read(),
      latestNode = node(lease.node);
    if (!current) throw missingSession(hash, origin);
    if (current.generation !== generation)
      throw connectionError(
        "Browsing assignment changed.",
        409,
        "SESSION_GENERATION_MISMATCH",
        true,
      );
    if (
      !latestNode ||
      latestNode.state === "disabled" ||
      (latestNode.id !== "local" && Date.now() - latestNode.seen >= FRESH)
    )
      throw connectionError(
        "Your assigned node is unavailable.",
        503,
        "NODE_UNAVAILABLE",
        true,
      );
    const relayOrigin = selected.id === "local" ? origin : selected.endpoint;
    const serverTime = Date.now(),
      expires = serverTime + TICKET_TTL;
    return {
      protocol: 2,
      capability: FRONTEND_CONTROLLER_RELAY_V2,
      serverTime,
      ticketExpiresAt: expires,
      leaseExpiresAt: current.seen + TTL,
      frontendOrigin: origin,
      relayOrigin,
      generation,
      sessionHash: hash,
      node: { id: selected.id, name: selected.name },
      ticket: signTicket(
        {
          role: "frontend-controller-v2",
          node: selected.id,
          lease: hash,
          generation,
          origin,
          runtimeOrigin: origin,
          relayOrigin,
          name: selected.name,
          expires,
        },
        selected.id === "local" ? localSecret : unseal(selected.credential),
      ),
    };
  }
  function resolve(
    ticket,
    runtimeOrigin,
    purpose = "runtime",
    { established = false, relayOrigin } = {},
  ) {
    const t = verifyTicket(ticket, localSecret, runtimeOrigin, {
      allowExpired: established && purpose === "relay",
    });
    if (t.role === RESOURCE_OWNER_ROLE || t.role === "frontend-runtime-v1")
      throw connectionError(
        "Invalid relay/runtime ticket purpose.",
        401,
        "INVALID_TICKET",
      );
    const controller = t.role === "frontend-controller-v2";
    if (
      controller &&
      (purpose !== "relay" ||
        t.origin !== runtimeOrigin ||
        t.node !== "local" ||
        t.relayOrigin !== relayOrigin)
    )
      throw connectionError(
        "Invalid controller relay ticket.",
        401,
        "INVALID_TICKET",
      );
    prune();
    const lease = db
      .prepare("SELECT * FROM browse_leases WHERE hash=?")
      .get(t.lease);
    if (!lease || lease.origin !== t.origin)
      throw missingSession(t.lease, t.origin);
    if ((t.generation || 1) !== lease.generation)
      throw connectionError(
        "This transport belongs to an older browsing assignment.",
        410,
        "SESSION_REVOKED",
      );
    const n = node(lease.node);
    if (
      lease.runtime_node &&
      !controller &&
      (purpose !== "relay" ||
        t.role !== "frontend-relay" ||
        t.node !== "local" ||
        node(lease.runtime_node)?.endpoint !== runtimeOrigin)
    )
      throw connectionError("Invalid relay ticket.", 401, "INVALID_TICKET");
    if (lease.runtime_node && !controller) {
      const host = node(lease.runtime_node);
      if (!host || host.state === "disabled" || Date.now() - host.seen >= FRESH)
        throw connectionError(
          "Runtime host is unavailable. Reconnect explicitly from Atlas.",
          503,
          "NODE_UNAVAILABLE",
          true,
        );
    }
    // Never fail over an existing session: its outbound IP must not silently change.
    if (
      !(
        n &&
        n.state !== "disabled" &&
        (controller ? lease.node === "local" : lease.runtime_node || online(n))
      )
    )
      throw connectionError(
        "Your browsing node is offline. Reconnect explicitly to choose another node.",
        503,
        "NODE_UNAVAILABLE",
        true,
      );
    // Periodic authorization of an already-open relay is not user activity.
    // Visible frontend renewal (or a fresh authenticated connection) maintains
    // the lease; a forgotten socket alone must not defeat the 12-hour idle rule.
    if (!established) {
      lease.seen = Date.now();
      db.prepare("UPDATE browse_leases SET seen=? WHERE hash=?").run(
        lease.seen,
        lease.hash,
      );
    }
    return {
      node: { id: n.id, name: n.name },
      appOrigin: t.origin,
      session: lease.hash,
      generation: lease.generation,
      leaseExpiresAt: lease.seen + TTL,
      ticketExpiresAt: t.expires,
    };
  }
  function release(raw, origin) {
    if (typeof raw !== "string" || raw.length > 100)
      throw fail("Invalid browsing session.");
    retire(digest(raw), origin);
  }
  function sameOriginConfig(raw, origin) {
    if (!sameOriginRuntime) throw connectionError("Runtime unavailable.", 404, "RUNTIME_PROTOCOL_REQUIRED");
    const ticket = verifyTicket(raw, localSecret, origin);
    if (ticket.role !== "frontend-runtime-v1")
      throw connectionError("Invalid runtime ticket.", 401, "INVALID_TICKET");
    prune();
    const lease = db.prepare("SELECT * FROM browse_leases WHERE hash=? AND origin=?").get(ticket.lease, origin);
    if (!lease) throw missingSession(ticket.lease, origin);
    const selected = node(lease.node);
    if (lease.generation !== ticket.generation || lease.node !== ticket.node)
      throw connectionError("Browsing assignment changed.", 410, "SESSION_REVOKED");
    if (!available(selected))
      throw connectionError("Your assigned node is unavailable.", 503, "NODE_UNAVAILABLE", true);
    const relayOrigin = selected.id === "local" ? origin : selected.endpoint;
    if (ticket.relayOrigin !== relayOrigin || !ticket.relayTicket)
      throw connectionError("Invalid runtime transport.", 401, "INVALID_TICKET");
    return {
      appOrigin: origin, runtimeOrigin: origin, runtimePath: "/browse/runtime/",
      relayOrigin, relayTicket: ticket.relayTicket,
      session: ticket.lease, generation: lease.generation,
      leaseExpiresAt: lease.seen + TTL, ticketExpiresAt: ticket.expires,
      serverTime: Date.now(), node: { id: selected.id, name: selected.name },
    };
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
      grants: db
        .prepare(
          "SELECT hash,generation,seen FROM browse_leases WHERE node=? OR runtime_node=?",
        )
        .all(id, id)
        .map(({ hash, generation, seen }) => ({
          hash,
          generation,
          expiresAt: seen + TTL,
        })),
      revoked: db
        .prepare(
          "SELECT hash FROM browse_lease_tombstones WHERE (node=? OR runtime_node=?) AND reason='revoked'",
        )
        .all(id, id)
        .map((row) => row.hash),
    };
  }
  const frontendAssignments = createFrontendAssignments(store, {
    node,
    listNodes: list,
    prune,
    grant: controllerRelay,
    localSecret,
  });
  async function resourceOwner(raw, origin, generation) {
    const owner = frontendAssignments.identity(raw, origin, generation);
    if (!owner)
      throw connectionError(
        "Invalid frontend assignment.",
        401,
        "INVALID_SESSION",
      );
    const relay = await controllerRelay(raw, origin, generation);
    if (!frontendAssignments.validate(owner))
      throw connectionError(
        "Browsing assignment changed.",
        410,
        "SESSION_REVOKED",
      );
    const selected = node(relay.node.id);
    if (
      !selected ||
      selected.state === "disabled" ||
      (selected.id !== "local" && Date.now() - selected.seen >= FRESH)
    )
      throw connectionError(
        "Your assigned node is unavailable.",
        503,
        "NODE_UNAVAILABLE",
        true,
      );
    if (
      !origin.startsWith("https://") ||
      !relay.relayOrigin.startsWith("https://")
    )
      throw connectionError(
        "Native resource owners require HTTPS.",
        409,
        "RESOURCE_HTTPS_REQUIRED",
      );
    if (
      selected.id !== "local" &&
      !(store.get("nodeCapabilities") || {})[selected.id]?.includes(
        FRONTEND_NATIVE_RESOURCES_V1,
      )
    )
      throw connectionError(
        "Selected node requires the complete resource protocol.",
        409,
        "RUNTIME_CAPABILITY_REQUIRED",
      );
    const expiresAt = Math.min(relay.ticketExpiresAt, relay.leaseExpiresAt);
    const identity = {
      nodeId: selected.id,
      frontendOrigin: origin,
      resourceOrigin: relay.relayOrigin,
      leaseHash: owner.hash,
      generation,
      expiresAt,
    };
    return {
      ...identity,
      role: RESOURCE_OWNER_ROLE,
      purpose: RESOURCE_OWNER_PURPOSE,
      ownerTicket: signTicket(
        {
          role: RESOURCE_OWNER_ROLE,
          purpose: RESOURCE_OWNER_PURPOSE,
          node: selected.id,
          origin,
          runtimeOrigin: origin,
          resourceOrigin: relay.relayOrigin,
          lease: owner.hash,
          generation,
          expires: expiresAt,
        },
        selected.id === "local" ? localSecret : unseal(selected.credential),
      ),
    };
  }
  return {
    frontendAssignments,
    resourceOwner,
    list,
    ccu,
    attach,
    add,
    update,
    remove,
    authenticate,
    heartbeat,
    allocate,
    operate,
    select,
    controllerRelay,
    sameOriginConfig,
    resolve,
    release,
    nodeState,
    setLocalConnections: (provider) => {
      localConnections = provider;
    },
    setLocalRelayStats: (provider) => {
      localRelayStats = provider;
    },
  };
}
