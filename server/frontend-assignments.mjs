/** Versioned frontend-document assignments coexist with legacy leases. Native
 * website storage has no node/lease namespace. Reservations never retire the
 * previous assignment until the trusted controller has probed its replacement
 * and explicitly commits it. No alternate node is chosen during restore/renew. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { token, digest } from "./store.mjs";
import { connectionError } from "./node-ticket.mjs";
import { OPAQUE_RUNTIME_PROTOCOL } from "./runtime-capabilities.mjs";
const TTL = 12 * 3600000,
  FRESH = 45000,
  RESERVATION_TTL = 60000,
  INITIAL_REQUEST_TTL = 30 * 60_000;
const INITIAL_REQUEST =
  /^v1\.([1-9][0-9]{9,15})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const bad = (code, message, status = 409, retryable = false) =>
  connectionError(message, status, code, retryable);
export function createFrontendAssignments(
  store,
  { node, listNodes, prune, grant, localSecret, bindLease, preferredNode = () => "", nodeForBinding = n => n },
) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS frontend_assignments (
  hash TEXT PRIMARY KEY, previous_hash TEXT, reservation_nonce TEXT, reservation_expires INTEGER,
  created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS frontend_assignments_previous ON frontend_assignments(previous_hash);
  CREATE INDEX IF NOT EXISTS frontend_assignments_reservation_expires ON frontend_assignments(reservation_expires) WHERE reservation_expires IS NOT NULL;`);
  const row = (hash) =>
    db.prepare("SELECT * FROM browse_leases WHERE hash=?").get(hash);
  const mode = (hash) =>
    db.prepare("SELECT * FROM frontend_assignments WHERE hash=?").get(hash);
  const tombstone = (hash, origin) =>
    db
      .prepare(
        "SELECT * FROM browse_lease_tombstones WHERE hash=? AND origin=?",
      )
      .get(hash, origin);
  const derive = (raw, nonce) =>
    createHmac("sha256", localSecret)
      .update("atlas.frontend.assignment.v2\0" + raw + "\0" + nonce)
      .digest("base64url");
  // A bootstrap is not an allocation. Its bounded signed request survives lost
  // responses without an unbounded request-id table or storing raw capabilities.
  const requestSignature = (origin, browserSession, unsigned) =>
    createHmac("sha256", localSecret)
      .update(
        "atlas.frontend.initial-request.v1\0" +
          origin +
          "\0" +
          browserSession +
          "\0" +
          unsigned,
      )
      .digest("base64url");
  function bootstrap(origin, browserSession) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(browserSession))
      throw bad(
        "INITIAL_BROWSER_SESSION_REQUIRED",
        "Browser session required.",
        403,
      );
    const serverTime = Date.now(),
      requestExpiresAt = serverTime + INITIAL_REQUEST_TTL;
    const unsigned = "v1." + requestExpiresAt + "." + token();
    return {
      requestId:
        unsigned + "." + requestSignature(origin, browserSession, unsigned),
      requestExpiresAt,
      serverTime,
      browserSessionId: browserSession,
    };
  }
  function initialCapability(
    requestId,
    origin,
    browserSession,
    allowExpired = false,
  ) {
    const match =
      typeof requestId === "string" && INITIAL_REQUEST.exec(requestId);
    if (!match || !/^[A-Za-z0-9_-]{43}$/.test(browserSession ?? ""))
      throw bad(
        "INVALID_INITIAL_REQUEST",
        "Invalid initial browsing request.",
        400,
      );
    const unsigned = requestId.slice(0, requestId.lastIndexOf(".")),
      expected = requestSignature(origin, browserSession, unsigned);
    if (!timingSafeEqual(Buffer.from(match[3]), Buffer.from(expected)))
      throw bad(
        "INITIAL_REQUEST_BINDING_MISMATCH",
        "Initial browsing request belongs to another frontend or browser session.",
        403,
      );
    const expires = Number(match[1]);
    if (
      !Number.isSafeInteger(expires) ||
      (!allowExpired && expires <= Date.now()) ||
      expires > Date.now() + INITIAL_REQUEST_TTL
    )
      throw bad(
        "INITIAL_REQUEST_EXPIRED",
        "Initial browsing recovery window expired.",
      );
    return createHmac("sha256", localSecret)
      .update(
        "atlas.frontend.initial-capability.v1\0" +
          origin +
          "\0" +
          browserSession +
          "\0" +
          requestId,
      )
      .digest("base64url");
  }
  function retireInitial(requestId, origin, browserSession) {
    const raw = initialCapability(requestId, origin, browserSession, true);
    if (Number(INITIAL_REQUEST.exec(requestId)[1]) > Date.now())
      throw bad(
        "INITIAL_REQUEST_ACTIVE",
        "Initial browsing recovery is still active.",
      );
    cleanup();
    const hash = digest(raw),
      lease = row(hash),
      record = mode(hash),
      old = tombstone(hash, origin),
      marker = "initial-retired-v1";
    if (lease && (lease.origin !== origin || !record)) missing(hash, origin);
    // Do not convert an administrator/user revocation into automatic new access.
    // A prior retirement's explicit marker makes lost retirement replies retryable.
    if (old?.reason === "revoked" && record?.reservation_nonce !== marker)
      missing(hash, origin);
    const now = Date.now();
    db.exec("BEGIN");
    try {
      if (lease) {
        db.prepare(
          "INSERT OR REPLACE INTO browse_lease_tombstones VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          hash,
          lease.node,
          origin,
          lease.runtime_node,
          lease.generation,
          "revoked",
          now,
          now + 7 * 86400000,
        );
        db.prepare("DELETE FROM browse_leases WHERE hash=? AND origin=?").run(
          hash,
          origin,
        );
      } else if (old) {
        db.prepare(
          "UPDATE browse_lease_tombstones SET reason='revoked',removed=?,expires=? WHERE hash=? AND origin=?",
        ).run(now, now + 7 * 86400000, hash, origin);
      }
      if (record)
        db.prepare(
          "UPDATE frontend_assignments SET reservation_nonce=?,reservation_expires=NULL WHERE hash=?",
        ).run(marker, hash);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, retiredRequestId: requestId, serverTime: now };
  }
  const available = (n) =>
    n &&
    n.state !== "disabled" &&
    (n.id === "local" ||
      (Date.now() - n.seen < FRESH &&
        OPAQUE_RUNTIME_PROTOCOL.requiredNodeCapabilities.every((capability) =>
          (n.qualificationCapabilities || (store.get("nodeCapabilities") || {})[n.id])?.includes(capability),
        )));
  function cleanup() {
    prune();
    const now = Date.now();
    for (const r of db
      .prepare(
        "SELECT hash FROM frontend_assignments WHERE reservation_expires IS NOT NULL AND reservation_expires<=?",
      )
      .all(now)) {
      db.prepare("DELETE FROM browse_leases WHERE hash=?").run(r.hash);
      db.prepare("DELETE FROM frontend_assignments WHERE hash=?").run(r.hash);
    }
    db.prepare(
      `DELETE FROM frontend_assignments WHERE reservation_expires IS NULL
   AND hash NOT IN (SELECT hash FROM browse_leases) AND hash NOT IN (SELECT hash FROM browse_lease_tombstones)`,
    ).run();
  }
  function identity(raw, origin, generation) {
    if (
      typeof raw !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(raw) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      return null;
    cleanup();
    const hash = digest(raw),
      lease = row(hash),
      record = mode(hash);
    return lease &&
      record &&
      lease.origin === origin &&
      lease.generation === generation
      ? { hash, origin, generation }
      : null;
  }
  function validate(owner) {
    if (!owner || typeof owner.hash !== "string") return false;
    // Cookie/storage markers are a hot path. Validate this live row directly;
    // global expiration sweeps remain on assignment allocation/identity paths.
    // Never run full-table DELETE/cleanup on every synchronous cookie read.
    const lease = row(owner.hash), record = mode(owner.hash);
    return !!(
      lease &&
      record &&
      (record.reservation_expires == null || record.reservation_expires > Date.now()) &&
      lease.origin === owner.origin &&
      lease.generation === owner.generation &&
      lease.seen > Date.now() - TTL
    );
  }
  function missing(hash, origin) {
    const t = tombstone(hash, origin);
    throw bad(
      t?.reason === "revoked"
        ? "SESSION_REVOKED"
        : t
          ? "SESSION_EXPIRED"
          : "INVALID_SESSION",
      "Browsing session is no longer current.",
    );
  }
  function choose(preferred = "", binding) {
    const candidates = listNodes().filter(
      (n) =>
        available(nodeForBinding(node(n.id), binding)) &&
        (preferred ? n.id === preferred : n.state === "active"),
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
      throw bad(
        "NODE_UNAVAILABLE",
        preferred
          ? "Your previous node is unavailable. Choose a node change explicitly."
          : "No compatible browsing nodes are available.",
        503,
        true,
      );
    return nodeForBinding(node(candidates[0].id), binding);
  }
  async function describe(raw, origin, binding) {
    const hash = digest(raw),
      lease = row(hash),
      record = mode(hash);
    if (!lease || !record || lease.origin !== origin) missing(hash, origin);
    if (binding) bindLease?.(hash, binding);
    const result = await grant(raw, origin, lease.generation);
    const current = row(hash),
      currentMode = mode(hash);
    if (
      !current ||
      !currentMode ||
      current.origin !== origin ||
      current.generation !== lease.generation
    )
      throw bad(
        "SESSION_REVOKED",
        "Browsing assignment changed during negotiation.",
      );
    return {
      ...result,
      session: raw,
      runtimeOrigin: origin,
      relayTicket: result.ticket,
      node: { ...result.node, online: true },
      pendingCommit: currentMode.reservation_expires !== null,
      replaces:
        currentMode.reservation_expires !== null
          ? currentMode.previous_hash
          : undefined,
      reservationExpiresAt: currentMode.reservation_expires || undefined,
    };
  }
  async function reserve(
    previousRaw,
    origin,
    preferred = "",
    initialRaw,
    binding,
  ) {
    cleanup();
    const previousHash = previousRaw ? digest(previousRaw) : null;
    if (previousHash) {
      const previous = row(previousHash),
        old = tombstone(previousHash, origin);
      if (
        previous ? previous.origin !== origin : !old || old.reason !== "expired"
      )
        missing(previousHash, origin);
      // A repeated/concurrent restore reuses a private pending reservation; its raw
      // capability is derived from the existing owner and a nonce, never stored.
      const pending = db
        .prepare(
          "SELECT * FROM frontend_assignments WHERE previous_hash=? AND reservation_expires>?",
        )
        .get(previousHash, Date.now());
      if (pending) {
        const raw = derive(previousRaw, pending.reservation_nonce);
        if (digest(raw) !== pending.hash)
          throw bad("INVALID_SESSION", "Invalid reservation.");
        const next = row(pending.hash);
        if (!preferred || next?.node === preferred)
          return describe(raw, origin, binding);
        throw bad(
          "SESSION_BUSY",
          "A replacement is already awaiting confirmation.",
          409,
          true,
        );
      }
    }
    const selected = choose(preferred || preferredNode(binding), binding),
      nonce = previousHash ? randomUUID() : null,
      raw = previousHash ? derive(previousRaw, nonce) : (initialRaw ?? token()),
      hash = digest(raw),
      now = Date.now();
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO browse_leases(hash,node,origin,created,seen,runtime_node,generation) VALUES (?,?,?,?,?,NULL,1)",
      ).run(hash, selected.id, origin, now, now);
      db.prepare("INSERT INTO frontend_assignments VALUES (?,?,?,?,?)").run(
        hash,
        previousHash,
        nonce,
        previousHash ? now + RESERVATION_TTL : null,
        now,
      );
      const order = store.get("nodeAssignmentOrder") || {};
      order[selected.id] =
        Math.max(0, ...Object.values(order).map((n) => Number(n) || 0)) + 1;
      store.set("nodeAssignmentOrder", order);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      return await describe(raw, origin, binding);
    } catch (error) {
      // The initial assignment may have committed even if its reply/remote grant
      // failed. Keep its deterministic pin so the same request cannot allocate
      // elsewhere. Replacement behavior remains its existing reservation path.
      if (!initialRaw) {
        db.prepare("DELETE FROM browse_leases WHERE hash=?").run(hash);
        db.prepare("DELETE FROM frontend_assignments WHERE hash=?").run(hash);
      }
      throw error;
    }
  }
  const operations = new Map();
  async function operate(
    input = {},
    origin,
    { browserSessionId, hubGrant, hubValidatedAt } = {},
  ) {
    const binding = hubGrant
      ? { grant: hubGrant, validatedAt: hubValidatedAt }
      : undefined;
    const {
      intent = input.session ? "restore" : "new",
      session: raw = "",
      generation,
      requestId,
    } = input;
    if (
      !["new", "restore", "renew"].includes(intent) ||
      typeof raw !== "string" ||
      raw.length > 100 ||
      (generation !== undefined &&
        (!Number.isSafeInteger(generation) || generation < 1)) ||
      (intent === "renew" && !raw) ||
      (requestId !== undefined &&
        (intent !== "new" || !!raw || typeof requestId !== "string")) ||
      Object.keys(input).some(
        (k) => !["intent", "session", "generation", "requestId"].includes(k),
      )
    )
      throw bad(
        "INVALID_SESSION",
        "Invalid controller session operation.",
        400,
      );
    const initialRaw =
      requestId === undefined
        ? undefined
        : initialCapability(requestId, origin, browserSessionId);
    const key =
      origin +
      ":" +
      (raw ? digest(raw) : initialRaw ? digest(initialRaw) : randomUUID());
    if (operations.has(key)) {
      const pending = operations.get(key);
      if (pending.intent !== intent || pending.generation !== generation)
        throw bad(
          "SESSION_BUSY",
          "Browsing session is already updating.",
          409,
          true,
        );
      return pending.promise;
    }
    const promise = Promise.resolve()
      .then(async () => {
        cleanup();
        if (!raw) {
          if (initialRaw) {
            const hash = digest(initialRaw),
              existing = row(hash);
            if (existing) {
              if (existing.origin !== origin || !mode(hash))
                missing(hash, origin);
              return describe(initialRaw, origin, binding);
            }
            if (mode(hash) || tombstone(hash, origin)) missing(hash, origin);
          }
          // Unkeyed calls remain an internal compatibility seam. The production
          // controller route requires a signed request for every initial new.
          return reserve("", origin, "", initialRaw, binding);
        }
        const hash = digest(raw),
          lease = row(hash),
          record = mode(hash),
          old = tombstone(hash, origin);
        if (lease && lease.origin !== origin) missing(hash, origin);
        if (
          generation !== undefined &&
          lease &&
          lease.generation !== generation
        )
          throw bad(
            "SESSION_GENERATION_MISMATCH",
            "Browsing assignment changed.",
            409,
            true,
          );
        if (intent === "new") {
          if (!lease && !old) missing(hash, origin);
          if (old?.reason === "revoked" && !lease) missing(hash, origin);
          return reserve(raw, origin, "", undefined, binding);
        }
        if (!lease) {
          if (!old || old.reason !== "expired" || intent !== "restore")
            missing(hash, origin);
          if (generation !== undefined && generation !== old.generation)
            throw bad(
              "SESSION_GENERATION_MISMATCH",
              "Browsing assignment changed.",
              409,
              true,
            );
          return reserve(raw, origin, old.node, undefined, binding);
        }
        if (!record) {
          // New frontend adopts a legacy owner without changing its traffic pin.
          // Legacy frame/socket remains authorized until explicit controller commit.
          return reserve(raw, origin, lease.node, undefined, binding);
        }
        if (!available(nodeForBinding(node(lease.node), binding, lease)))
          throw bad(
            "NODE_UNAVAILABLE",
            "Your selected node is unavailable. Retry it or choose a node change explicitly.",
            503,
            true,
          );
        db.prepare("UPDATE browse_leases SET seen=? WHERE hash=?").run(
          Date.now(),
          hash,
        );
        return describe(raw, origin, binding);
      })
      .finally(() => operations.delete(key));
    operations.set(key, { intent, generation, promise });
    return promise;
  }
  async function commit(previousRaw, candidateRaw, origin, generation) {
    cleanup();
    if (
      typeof previousRaw !== "string" ||
      typeof candidateRaw !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(previousRaw) ||
      !/^[A-Za-z0-9_-]{43}$/.test(candidateRaw) ||
      previousRaw === candidateRaw ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw bad("INVALID_SESSION", "Invalid replacement confirmation.", 400);
    const previousHash = digest(previousRaw),
      hash = digest(candidateRaw),
      record = mode(hash),
      candidate = row(hash);
    // A lost response or another window may repeat a successful confirmation.
    // Retain only the committed predecessor HASH so that exact confirmation is
    // idempotent; it cannot confirm a different owner or resurrect a dead lease.
    if (
      record?.previous_hash === previousHash &&
      record.reservation_expires === null &&
      record.reservation_nonce === null &&
      candidate?.origin === origin &&
      candidate.generation === generation
    )
      return describe(candidateRaw, origin);
    if (
      !record ||
      record.previous_hash !== previousHash ||
      record.reservation_expires <= Date.now() ||
      !candidate ||
      candidate.origin !== origin ||
      candidate.generation !== generation
    )
      throw bad(
        "INVALID_SESSION",
        "Replacement reservation is no longer current.",
      );
    const result = await describe(candidateRaw, origin);
    const current = row(hash),
      pending = mode(hash),
      previous = row(previousHash),
      old = tombstone(previousHash, origin);
    if (
      !current ||
      !pending ||
      pending.previous_hash !== previousHash ||
      pending.reservation_expires <= Date.now() ||
      current.generation !== generation ||
      current.origin !== origin ||
      (previous
        ? previous.origin !== origin
        : !old || old.reason !== "expired") ||
      !available(nodeForBinding(node(current.node), undefined, current))
    )
      throw bad(
        "SESSION_REVOKED",
        "Replacement or previous assignment changed before confirmation.",
      );
    db.exec("BEGIN");
    try {
      if (previous) {
        db.prepare(
          "INSERT OR REPLACE INTO browse_lease_tombstones VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          previousHash,
          previous.node,
          origin,
          previous.runtime_node,
          previous.generation,
          "revoked",
          Date.now(),
          Date.now() + 7 * 86400000,
        );
        db.prepare("DELETE FROM browse_leases WHERE hash=?").run(previousHash);
      } else
        db.prepare(
          "UPDATE browse_lease_tombstones SET reason='revoked' WHERE hash=? AND origin=?",
        ).run(previousHash, origin);
      db.prepare(
        "UPDATE frontend_assignments SET reservation_nonce=NULL,reservation_expires=NULL WHERE hash=?",
      ).run(hash);
      store.audit("node.select", current.node);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      ...result,
      pendingCommit: false,
      replaces: undefined,
      reservationExpiresAt: undefined,
    };
  }
  async function select(raw, origin, requestedNode) {
    if (
      typeof raw !== "string" ||
      typeof requestedNode !== "string" ||
      !requestedNode
    )
      throw bad("INVALID_SESSION", "Invalid explicit selection.", 400);
    cleanup();
    const previous = row(digest(raw));
    if (!previous || previous.origin !== origin) missing(digest(raw), origin);
    return reserve(raw, origin, requestedNode);
  }
  return {
    bootstrap,
    retireInitial,
    operate,
    select,
    commit,
    identity,
    validate,
    isFrontend: (hash) => !!mode(hash),
    cleanup,
  };
}
