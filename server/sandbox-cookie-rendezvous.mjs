/** Encrypted synchronous cookie-result rendezvous. Only an authenticated browser
 * worker supplies bounded ciphertext; the server never gets result keys or
 * plaintext cookie views. This is NOT the marker-only storage channel.
 * Not registered in the application until the complete release is qualified.
 */
import { onlyNativeResourceEnrollmentCookies } from "./opaque-ambient-cookies.mjs";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = "/browse/cookies/";
const token = () => randomBytes(32).toString("base64url");
const ownKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const sequence = (value) => Number.isSafeInteger(value) && value > 0;
const documentID = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,96}$/.test(value);
const fail = (statusCode, code) =>
  Object.assign(new Error(code), { statusCode, code });

export function installSandboxCookieRendezvous(
  app,
  {
    originFor,
    authorizeOwner,
    validateOwner,
    documentOrigin = "opaque",
    timeoutMs = 8000,
    validationTimeoutMs = 2000,
    receiptTTL = 10000,
    idleMs = 12 * 3600000,
    disconnectedGraceMs = 30000,
    maxOwners = 256,
    maxDocuments = 32,
  } = {},
) {
  if (
    typeof originFor !== "function" ||
    typeof authorizeOwner !== "function" ||
    typeof validateOwner !== "function"
  )
    throw TypeError(
      "Cookie rendezvous requires explicit trusted owner authorization.",
    );
  if (!["opaque", "same-origin"].includes(documentOrigin))
    throw TypeError("Invalid cookie document origin mode.");
  if (
    !Number.isSafeInteger(validationTimeoutMs) ||
    validationTimeoutMs <= 0 ||
    validationTimeoutMs > 30000
  )
    throw TypeError(
      "Cookie owner validation timeout must be within 1–30000 ms.",
    );
  const owners = new Map(),
    documents = new Map();
  // An unaware client cannot invalidate a cross-task view. Scope this fallback
  // conservatively to its whole frontend origin: clearing a native session
  // cookie must not make an already-live legacy worker disappear from it.
  const legacyViews = new Map();
  const viewNames = origin => {
    const secure = new URL(origin).protocol === "https:";
    return { name: (secure ? "__Host-" : "") + "atlas-cookie-view-fence-v1", attributes: "; Path=/; SameSite=Strict; Max-Age=2592000" + (secure ? "; Secure" : "") };
  };
  const viewFence = (request, origin) => {
    const { name } = viewNames(origin);
    const values = (request.headers.cookie || "").split(";").map(v => v.trim()).filter(v => v.startsWith(name + "="));
    const value = values.length === 1 ? values[0].slice(name.length + 1) : "";
    return /^[a-f\d]{32}$/i.test(value) ? value : undefined;
  };
  const allowView = (request, reply, owner) => {
    if (documentOrigin !== "same-origin" || !owner.viewCoherent || legacyViews.has(owner.viewContext)) return;
    const fence = viewFence(request, owner.origin);
    // This echoes the request's fence, never overwrites it with a late response.
    // A newer legacy registration therefore defeats even an in-flight grant.
    if (fence) reply.header("x-atlas-cookie-view-epoch", fence);
  };
  let receiptBytes = 0;
  const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
  function discardReceipts(doc) {
    for (const item of doc.receipts.values()) receiptBytes -= item.bytes;
    doc.receipts.clear();
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 6 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const sameOrigin = (request) => {
    const origin = originFor(request);
    if (!/^https?:\/\//.test(origin) || request.headers.origin !== origin)
      throw fail(403, "cookies_owner_origin_denied");
    return origin;
  };
  const finish = (doc, number, value) => {
    const waiting = doc.pending.get(number);
    if (!waiting) return false;
    doc.pending.delete(number);
    clearTimeout(waiting.timer);
    waiting.resolve(value);
    return true;
  };
  const ownerSend = (owner, value) => {
    if (owner.socket?.readyState === WebSocket.OPEN)
      owner.socket.send(JSON.stringify(value));
  };
  function revokeDocument(doc, code = "cookies_document_revoked", failure) {
    if (!documents.delete(doc.capability)) return;
    doc.owner.documents.delete(doc.documentId);
    for (const number of [...doc.pending.keys()])
      finish(doc, number, {
        status: failure?.status || 409,
        ok: false,
        error: failure?.error || { name: "InvalidStateError", code },
      });
    discardReceipts(doc);
    ownerSend(doc.owner, { type: "revoke", documentId: doc.documentId });
  }
  function revokeOwner(owner, code = "cookies_owner_revoked", failure) {
    if (owners.get(owner.capability) !== owner) return;
    owners.delete(owner.capability);
    if (documentOrigin === "same-origin" && !owner.viewCoherent) {
      const count = (legacyViews.get(owner.viewContext) || 1) - 1;
      if (count) legacyViews.set(owner.viewContext, count);
      else legacyViews.delete(owner.viewContext);
    }
    if (failure) owner.validationFailure = failure;
    owner.cancelValidation?.();
    clearTimeout(owner.expiryTimer);
    for (const doc of [...owner.documents.values()])
      revokeDocument(doc, code, failure);
    owner.socket?.close(1008, "Cookie owner unavailable");
  }
  async function valid(owner) {
    // Concurrent HTTP markers, pings and sweep checks share one bounded lookup.
    // Neither a late validator nor an old socket may revive revoked authority.
    if (!owner || owners.get(owner.capability) !== owner) return false;
    if (Date.now() - owner.seen > idleMs) {
      revokeOwner(owner);
      return false;
    }
    if (owner.validation) return owner.validation;
    const controller = new AbortController();
    let timer, cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => {
        controller.abort();
        resolve({ kind: "revoked" });
      };
    });
    owner.cancelValidation = cancel;
    const work = (async () => {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() =>
            owners.get(owner.capability) === owner
              ? validateOwner(owner.identity, { signal: controller.signal })
              : false,
          )
          .then(
            (authorized) => ({ kind: "authorized", authorized }),
            () => ({ kind: "failed" }),
          ),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: "timeout" }),
            validationTimeoutMs,
          );
          timer.unref();
        }),
        cancelled,
      ]);
      clearTimeout(timer);
      if (owners.get(owner.capability) !== owner) return false;
      if (outcome.kind === "timeout" || outcome.kind === "failed") {
        const failure = {
          status: 503,
          error: {
            name: outcome.kind === "timeout" ? "TimeoutError" : "NetworkError",
            code:
              outcome.kind === "timeout"
                ? "cookies_owner_validation_timeout"
                : "cookies_owner_validation_failed",
          },
        };
        revokeOwner(owner, failure.error.code, failure);
        return false;
      }
      if (
        outcome.kind !== "authorized" ||
        !outcome.authorized ||
        Date.now() - owner.seen > idleMs
      ) {
        revokeOwner(owner);
        return false;
      }
      return true;
    })();
    const validation = work.finally(() => {
      clearTimeout(timer);
      if (owner.validation === validation) owner.validation = undefined;
      if (owner.cancelValidation === cancel) owner.cancelValidation = undefined;
    });
    owner.validation = validation;
    return validation;
  }
  app.post(
    "/api/browse/cookies/owners",
    { bodyLimit: 128 },
    async (request, reply) => {
      const origin = sameOrigin(request),
        identity = await authorizeOwner(request);
      if (!identity) throw fail(401, "cookies_owner_authentication_required");
      if (!ownKeys(request.body || {}, []))
        throw fail(400, "invalid_cookies_owner_request");
      if (owners.size >= maxOwners) throw fail(429, "cookies_owner_limit");
      const capability = token();
      const owner = {
        capability,
        origin,
        identity,
        viewCoherent: documentOrigin === "same-origin" && request.headers["x-atlas-cookie-view"] === "1",
        viewContext: origin,
        seen: Date.now(),
        documents: new Map(),
        socket: null,
        expiryTimer: undefined,
      };
      owners.set(capability, owner);
      if (documentOrigin === "same-origin" && !owner.viewCoherent) {
        legacyViews.set(owner.viewContext, (legacyViews.get(owner.viewContext) || 0) + 1);
        const { name, attributes } = viewNames(origin);
        const fence = name + "=" + randomBytes(16).toString("hex") + attributes;
        const prior = reply.getHeader("set-cookie");
        reply.header("set-cookie", prior ? [...(Array.isArray(prior) ? prior : [String(prior)]), fence] : fence);
      }
      allowView(request, reply, owner);
      owner.expiryTimer = setTimeout(
        () => revokeOwner(owner),
        disconnectedGraceMs,
      );
      owner.expiryTimer.unref();
      reply.header("Cache-Control", "no-store");
      return { capability, websocket: ROOT + "owner/" + capability };
    },
  );
  const authenticatedOwner = async (request) => {
    const origin = sameOrigin(request);
    const value = request.headers.authorization;
    const owner =
      typeof value === "string" && /^Bearer [A-Za-z0-9_-]{43}$/.test(value)
        ? owners.get(value.slice(7))
        : null;
    if (
      !owner ||
      owner.origin !== origin ||
      !(await valid(owner)) ||
      owners.get(owner.capability) !== owner
    )
      throw fail(
        owner?.validationFailure?.status || 401,
        owner?.validationFailure?.error.code ||
          "cookies_owner_authentication_required",
      );
    owner.seen = Date.now();
    return owner;
  };
  app.post(
    "/api/browse/cookies/documents",
    { bodyLimit: 256 },
    async (request, reply) => {
      const owner = await authenticatedOwner(request);
      if (owners.get(owner.capability) !== owner)
        throw fail(401, "cookies_owner_authentication_required");
      if (
        !ownKeys(request.body, ["documentId"]) ||
        !documentID(request.body.documentId)
      )
        throw fail(400, "invalid_cookies_document_request");
      if (owner.documents.has(request.body.documentId))
        throw fail(409, "cookies_document_already_bound");
      if (owner.documents.size >= maxDocuments)
        throw fail(429, "cookies_document_limit");
      const capability = token();
      const doc = {
        owner,
        capability,
        documentId: request.body.documentId,
        pending: new Map(),
        receipts: new Map(),
        last: 0,
      };
      owner.documents.set(doc.documentId, doc);
      documents.set(capability, doc);
      reply.header("Cache-Control", "no-store");
      return {
        documentId: doc.documentId,
        result: ROOT + "result/" + capability,
      };
    },
  );
  app.delete(
    "/api/browse/cookies/documents/:documentId",
    async (request, reply) => {
      const owner = await authenticatedOwner(request),
        doc = owner.documents.get(request.params.documentId);
      if (doc) revokeDocument(doc);
      return reply.code(204).send();
    },
  );
  app.delete("/api/browse/cookies/owners", async (request, reply) => {
    const owner = await authenticatedOwner(request);
    revokeOwner(owner);
    return reply.code(204).send();
  });
  app.post(
    ROOT + "result/:capability",
    { bodyLimit: 128 },
    async (request, reply) => {
      // Exact opaque-document result endpoint only. The request contains a
      // sequence, never an operation, URL, cookie value or frontend credential.
      reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store, no-transform")
        .header("Access-Control-Allow-Origin", "*")
        .header("Vary", "Origin");
      if (
        request.headers.origin !== (documentOrigin === "same-origin" ? originFor(request) : "null") ||
        request.headers.authorization ||
        (documentOrigin === "opaque" && !onlyNativeResourceEnrollmentCookies(request.headers.cookie))
      )
        return reply.code(403).send({
          ok: false,
          error: {
            name: "SecurityError",
            code: "cookies_marker_origin_denied",
          },
        });
      const doc = documents.get(request.params.capability);
      if (
        !doc ||
        originFor(request) !== doc.owner.origin ||
        !(await valid(doc.owner)) ||
        documents.get(doc.capability) !== doc ||
        owners.get(doc.owner.capability) !== doc.owner
      )
        return reply.code(doc?.owner.validationFailure?.status || 409).send({
          ok: false,
          error: doc?.owner.validationFailure?.error || {
            name: "InvalidStateError",
            code: "cookies_document_revoked",
          },
        });
      let body;
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : request.body;
      } catch {}
      if (
        !ownKeys(body, ["sequence"]) ||
        !sequence(body.sequence) ||
        body.sequence !== doc.last + 1
      )
        return reply.code(409).send({
          ok: false,
          error: {
            name: "InvalidStateError",
            code: "invalid_cookies_sequence",
          },
        });
      const number = body.sequence;
      doc.last = number;
      doc.owner.seen = Date.now();
      if (doc.owner.socket?.readyState !== WebSocket.OPEN)
        return reply.code(503).send({
          ok: false,
          error: {
            name: "NetworkError",
            code: "cookies_worker_disconnected",
          },
        });
      const early = doc.receipts.get(number);
      doc.receipts.delete(number);
      if (early) receiptBytes -= early.bytes;
      if (early && Date.now() - early.created <= receiptTTL) {
        allowView(request, reply, doc.owner);
        return reply.send(early.value);
      }
      if (doc.pending.size >= 8)
        return reply.code(429).send({
          ok: false,
          error: {
            name: "QuotaExceededError",
            code: "cookies_marker_backpressure",
          },
        });
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          finish(doc, number, {
            status: 504,
            ok: false,
            error: { name: "TimeoutError", code: "cookies_result_timeout" },
          });
          ownerSend(doc.owner, {
            type: "cancel",
            documentId: doc.documentId,
            sequence: number,
          });
        }, timeoutMs);
        doc.pending.set(number, { resolve, timer });
        reply.raw.once("close", () => {
          if (
            !reply.raw.writableFinished &&
            finish(doc, number, {
              status: 499,
              ok: false,
              error: {
                name: "AbortError",
                code: "cookies_document_disconnected",
              },
            })
          )
            ownerSend(doc.owner, {
              type: "cancel",
              documentId: doc.documentId,
              sequence: number,
            });
        });
        // The HTTP wait is informational, never a cookie read/write command.
        // Only the original document's browser-local operation port can act.
        ownerSend(doc.owner, {
          type: "wait",
          documentId: doc.documentId,
          sequence: number,
        });
      });
      if (result.ok && (!result.status || result.status === 200)) allowView(request, reply, doc.owner);
      return reply.code(result.status || 200).send(result);
    },
  );
  const upgrade = async (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://cookies").pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith(ROOT + "owner/")) return;
    try {
      const match = pathname.match(
        /^\/browse\/cookies\/owner\/([A-Za-z0-9_-]{43})$/,
      );
      const owner = match && owners.get(match[1]);
      if (
        !owner ||
        request.headers.origin !== owner.origin ||
        originFor(request) !== owner.origin ||
        !(await valid(owner)) ||
        owners.get(owner.capability) !== owner
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const previous = owner.socket;
        clearTimeout(owner.expiryTimer);
        owner.socket = ws;
        owner.seen = Date.now();
        ws.on("error", () => {});
        ws.on("message", (data, isBinary) => {
          if (owner.socket !== ws || owners.get(owner.capability) !== owner)
            return;
          try {
            if (isBinary) throw Error();
            const value = JSON.parse(data.toString());
            if (ownKeys(value, ["type"]) && value.type === "ping") {
              // Ignore extra pings while the bounded coordinator lookup is
              // pending: one peer cannot accumulate promises or refresh its
              // idle age without a still-live lease.
              if (!owner.heartbeatPending) {
                owner.heartbeatPending = true;
                void valid(owner)
                  .then((authorized) => {
                    if (
                      authorized &&
                      owners.get(owner.capability) === owner &&
                      owner.socket === ws &&
                      ws.readyState === WebSocket.OPEN
                    ) {
                      owner.seen = Date.now();
                      ownerSend(owner, { type: "pong" });
                    }
                  })
                  .catch(() => revokeOwner(owner))
                  .finally(() => {
                    owner.heartbeatPending = false;
                  });
              }
              return;
            }
            if (
              !ownKeys(value, ["type", "documentId", "sequence", "packet"]) ||
              value.type !== "result" ||
              !documentID(value.documentId) ||
              !sequence(value.sequence) ||
              typeof value.packet !== "string" ||
              value.packet.length < 56 ||
              value.packet.length > 5600000 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(value.packet)
            )
              throw Error();
            const doc = owner.documents.get(value.documentId);
            if (!doc) return;
            const result = { ok: true, packet: value.packet };
            if (finish(doc, value.sequence, result)) return;
            if (
              value.sequence <= doc.last ||
              value.sequence !== doc.last + 1 ||
              doc.receipts.size >= 1 ||
              receiptBytes + value.packet.length > MAX_RECEIPT_BYTES
            )
              return;
            receiptBytes += value.packet.length;
            doc.receipts.set(value.sequence, {
              bytes: value.packet.length,
              value: result,
              created: Date.now(),
            });
          } catch {
            ws.close(1008, "Invalid cookies receipt");
          }
        });
        ws.on("close", () => {
          if (owner.socket !== ws || owners.get(owner.capability) !== owner)
            return;
          owner.socket = null;
          clearTimeout(owner.expiryTimer);
          owner.expiryTimer = setTimeout(
            () => revokeOwner(owner),
            disconnectedGraceMs,
          );
          owner.expiryTimer.unref();
          for (const doc of owner.documents.values()) {
            discardReceipts(doc);
            for (const number of [...doc.pending.keys()])
              finish(doc, number, {
                status: 503,
                ok: false,
                error: {
                  name: "NetworkError",
                  code: "cookies_worker_disconnected",
                },
              });
          }
        });
        ownerSend(owner, { type: "ready" });
        previous?.close(1000, "Cookie owner replaced");
      });
    } catch {
      socket.destroy();
    }
  };
  app.server.on("upgrade", upgrade);
  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const owner of owners.values()) {
        if (now - owner.seen > idleMs) revokeOwner(owner);
        else {
          // Check authority even if a connected but otherwise idle worker is
          // sending heartbeat traffic. Pings alone are never lease renewal.
          void valid(owner).catch(() => revokeOwner(owner));
          for (const doc of owner.documents.values())
            for (const [key, receipt] of doc.receipts)
              if (now - receipt.created > receiptTTL) {
                doc.receipts.delete(key);
                receiptBytes -= receipt.bytes;
              }
        }
      }
    },
    Math.min(idleMs, 30000),
  );
  sweep.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    app.server.removeListener("upgrade", upgrade);
    for (const owner of [...owners.values()]) revokeOwner(owner);
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  return {
    revokeOwner: (capability) => {
      const owner = owners.get(capability);
      if (owner) revokeOwner(owner);
    },
    get ownerCount() {
      return owners.size;
    },
    get documentCount() {
      return documents.size;
    },
  };
}
