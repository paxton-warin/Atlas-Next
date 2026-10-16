/** Marker-only synchronous storage rendezvous. Website keys/values and database
 * snapshots never reach this server: a trusted browser worker commits them in
 * frontend-owned IndexedDB, then acknowledges an opaque document's sequence.
 * Not registered in the application until the complete release is qualified.
 */
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = "/browse/storage/";
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

export function installSandboxStorageRendezvous(
  app,
  {
    originFor,
    authorizeOwner,
    validateOwner,
    timeoutMs = 8000,
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
      "Storage rendezvous requires explicit trusted owner authorization.",
    );
  const owners = new Map(),
    documents = new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const sameOrigin = (request) => {
    const origin = originFor(request);
    if (!/^https?:\/\//.test(origin) || request.headers.origin !== origin)
      throw fail(403, "storage_owner_origin_denied");
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
  function revokeDocument(doc, code = "storage_document_revoked") {
    if (!documents.delete(doc.capability)) return;
    doc.owner.documents.delete(doc.documentId);
    for (const number of [...doc.pending.keys()])
      finish(doc, number, {
        status: 409,
        ok: false,
        error: { name: "InvalidStateError", code },
      });
    doc.receipts.clear();
    ownerSend(doc.owner, { type: "revoke", documentId: doc.documentId });
  }
  function revokeOwner(owner, code = "storage_owner_revoked") {
    if (!owners.delete(owner.capability)) return;
    clearTimeout(owner.expiryTimer);
    for (const doc of [...owner.documents.values()]) revokeDocument(doc, code);
    owner.socket?.close(1008, "Storage owner unavailable");
  }
  async function valid(owner) {
    // Authorization may await coordinator I/O. A revoked owner is terminal even
    // if an older validator subsequently resolves successfully.
    if (!owner || owners.get(owner.capability) !== owner) return false;
    const authorized = await validateOwner(owner.identity);
    if (
      owners.get(owner.capability) !== owner ||
      Date.now() - owner.seen > idleMs ||
      !authorized
    ) {
      if (owner) revokeOwner(owner);
      return false;
    }
    return true;
  }
  app.post(
    "/api/browse/storage/owners",
    { bodyLimit: 128 },
    async (request, reply) => {
      const origin = sameOrigin(request),
        identity = await authorizeOwner(request);
      if (!identity) throw fail(401, "storage_owner_authentication_required");
      if (!ownKeys(request.body || {}, []))
        throw fail(400, "invalid_storage_owner_request");
      if (owners.size >= maxOwners) throw fail(429, "storage_owner_limit");
      const capability = token();
      const owner = {
        capability,
        origin,
        identity,
        seen: Date.now(),
        documents: new Map(),
        socket: null,
        expiryTimer: undefined,
      };
      owners.set(capability, owner);
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
      throw fail(401, "storage_owner_authentication_required");
    owner.seen = Date.now();
    return owner;
  };
  app.post(
    "/api/browse/storage/documents",
    { bodyLimit: 256 },
    async (request, reply) => {
      const owner = await authenticatedOwner(request);
      if (owners.get(owner.capability) !== owner)
        throw fail(401, "storage_owner_authentication_required");
      if (
        !ownKeys(request.body, ["documentId"]) ||
        !documentID(request.body.documentId)
      )
        throw fail(400, "invalid_storage_document_request");
      if (owner.documents.has(request.body.documentId))
        throw fail(409, "storage_document_already_bound");
      if (owner.documents.size >= maxDocuments)
        throw fail(429, "storage_document_limit");
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
        commit: ROOT + "commit/" + capability,
      };
    },
  );
  app.delete(
    "/api/browse/storage/documents/:documentId",
    async (request, reply) => {
      const owner = await authenticatedOwner(request),
        doc = owner.documents.get(request.params.documentId);
      if (doc) revokeDocument(doc);
      return reply.code(204).send();
    },
  );
  app.delete("/api/browse/storage/owners", async (request, reply) => {
    const owner = await authenticatedOwner(request);
    revokeOwner(owner);
    return reply.code(204).send();
  });
  app.post(
    ROOT + "commit/:capability",
    { bodyLimit: 128 },
    async (request, reply) => {
      // The only Origin:null exception. It carries no authority beyond this exact
      // document's commit marker, never authorizes cookies or any frontend API.
      reply
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header("Vary", "Origin");
      if (
        request.headers.origin !== "null" ||
        request.headers.authorization ||
        request.headers.cookie
      )
        return reply.code(403).send({
          ok: false,
          error: {
            name: "SecurityError",
            code: "storage_marker_origin_denied",
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
        return reply.code(409).send({
          ok: false,
          error: {
            name: "InvalidStateError",
            code: "storage_document_revoked",
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
            code: "invalid_storage_sequence",
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
            code: "storage_worker_disconnected",
          },
        });
      const early = doc.receipts.get(number);
      doc.receipts.delete(number);
      if (early && Date.now() - early.created <= receiptTTL)
        return reply.send(early.value);
      if (doc.pending.size >= 8)
        return reply.code(429).send({
          ok: false,
          error: {
            name: "QuotaExceededError",
            code: "storage_marker_backpressure",
          },
        });
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          finish(doc, number, {
            status: 504,
            ok: false,
            error: { name: "TimeoutError", code: "storage_commit_timeout" },
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
                code: "storage_document_disconnected",
              },
            })
          )
            ownerSend(doc.owner, {
              type: "cancel",
              documentId: doc.documentId,
              sequence: number,
            });
        });
        // A marker is informational. It must never make the worker create or
        // mutate website storage; only the bound browser-local MessagePort can.
        ownerSend(doc.owner, {
          type: "wait",
          documentId: doc.documentId,
          sequence: number,
        });
      });
      return reply.code(result.status || 200).send(result);
    },
  );
  const upgrade = async (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://storage").pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith(ROOT + "owner/")) return;
    try {
      const match = pathname.match(
        /^\/browse\/storage\/owner\/([A-Za-z0-9_-]{43})$/,
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
          if (owner.socket !== ws) return;
          try {
            if (isBinary) throw Error();
            const value = JSON.parse(data.toString());
            if (ownKeys(value, ["type"]) && value.type === "ping") {
              owner.seen = Date.now();
              ownerSend(owner, { type: "pong" });
              return;
            }
            if (
              !ownKeys(value, [
                "type",
                "documentId",
                "sequence",
                "ok",
                "error",
                "revision",
              ]) ||
              value.type !== "result" ||
              !documentID(value.documentId) ||
              !sequence(value.sequence) ||
              typeof value.ok !== "boolean" ||
              (value.revision !== undefined &&
                (!Number.isSafeInteger(value.revision) ||
                  value.revision < 0)) ||
              (value.error !== undefined &&
                (!ownKeys(value.error, ["name", "code"]) ||
                  typeof value.error.name !== "string" ||
                  value.error.name.length > 64 ||
                  typeof value.error.code !== "string" ||
                  value.error.code.length > 128))
            )
              throw Error();
            const doc = owner.documents.get(value.documentId);
            if (!doc) return;
            const result = {
              ok: value.ok,
              ...(value.ok
                ? { revision: value.revision }
                : {
                    error: value.error || {
                      name: "UnknownError",
                      code: "storage_commit_failed",
                    },
                  }),
            };
            if (finish(doc, value.sequence, result)) return;
            if (
              value.sequence <= doc.last ||
              value.sequence > doc.last + 64 ||
              doc.receipts.size >= 64
            )
              return;
            doc.receipts.set(value.sequence, {
              value: result,
              created: Date.now(),
            });
          } catch {
            ws.close(1008, "Invalid storage receipt");
          }
        });
        ws.on("close", () => {
          if (owner.socket !== ws) return;
          owner.socket = null;
          clearTimeout(owner.expiryTimer);
          owner.expiryTimer = setTimeout(
            () => revokeOwner(owner),
            disconnectedGraceMs,
          );
          owner.expiryTimer.unref();
          for (const doc of owner.documents.values()) {
            doc.receipts.clear();
            for (const number of [...doc.pending.keys()])
              finish(doc, number, {
                status: 503,
                ok: false,
                error: {
                  name: "NetworkError",
                  code: "storage_worker_disconnected",
                },
              });
          }
        });
        ownerSend(owner, { type: "ready" });
        previous?.close(1000, "Storage owner replaced");
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
        else
          for (const doc of owner.documents.values())
            for (const [key, receipt] of doc.receipts)
              if (now - receipt.created > receiptTTL) doc.receipts.delete(key);
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
