/** Unregistered selected-node native HTTPS resource cache. The trusted browser
 * uploads validated bytes; this module NEVER fetches an upstream URL or holds a
 * website cookie jar. A visible resource cap is insufficient without the
 * browser's separately enrolled HttpOnly cookie. */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
export const NATIVE_RESOURCE_GATEWAY_CAPABILITY = "native-resource-gateway-v1";
const ROOT = "/native-resource/v1/",
  token = () => randomBytes(32).toString("base64url");
const keys = (v, allowed) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k));
const ID = /^[A-Za-z0-9_-]{16,96}$/,
  CAP = /^[A-Za-z0-9_-]{43}$/,
  HASH = /^[a-f0-9]{64}$/;
const error = (statusCode, code) =>
  Object.assign(Error(code), { statusCode, code });
const safeURL = (value) => {
  const u = new URL(value);
  if (
    !/^https?:$/.test(u.protocol) ||
    u.username ||
    u.password ||
    u.href.length > 16384
  )
    throw error(400, "native_resource_invalid_url");
  u.hash = "";
  return u;
};
const httpsOrigin = (value) => {
  const u = safeURL(value);
  if (u.protocol !== "https:" || u.href !== u.origin + "/")
    throw error(400, "native_resource_https_required");
  return u.origin;
};
const digest = (value) => createHash("sha256").update(value).digest();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
  "base64",
);
const MIME = {
  image:
    /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i,
  audio: /^audio\/(?:mpeg|mp4|webm|ogg|wav|x-wav|wave)$/i,
  video: /^video\/(?:mp4|webm|ogg)$/i,
  style: /^text\/css$/i,
  script: /^(?:text|application)\/(?:java|ecma)script$/i,
};
export function installNativeResourceGateway(
  app,
  {
    originFor,
    authorizeOwner,
    validateOwner,
    blockedHosts = [],
    limits = {},
  } = {},
) {
  if (
    [originFor, authorizeOwner, validateOwner].some(
      (f) => typeof f !== "function",
    )
  )
    throw TypeError("Native resources require dedicated owner authorization.");
  const bound = {
    owners: 128,
    documents: 32,
    resources: 128,
    uploads: 4,
    bodyBytes: 8 * 1024 * 1024,
    documentBytes: 32 * 1024 * 1024,
    ownerBytes: 64 * 1024 * 1024,
    totalBytes: 256 * 1024 * 1024,
    globalResources: 4096,
    enrollmentMs: 15000,
    uploadMs: 15000,
    connectMs: 15000,
    validationMs: 3000,
    validations: 64,
    queuedMessages: 64,
    queuedMessageBytes: 64 * 4096,
    outboundBytes: 64 * 1024,
    ...limits,
  };
  for (const value of Object.values(bound))
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024)
      throw TypeError("Invalid native-resource limits.");
  const owners = new Map(),
    documents = new Map(),
    resources = new Map(),
    enrollments = new Map();
  let bytes = 0,
    uploads = 0,
    validationCount = 0,
    live = true;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65568,
    perMessageDeflate: false,
  });
  const cache = (reply) =>
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
  const actualOrigin = (req) => httpsOrigin(originFor(req));
  const send = (owner, message) => {
    if (owner.socket?.readyState !== WebSocket.OPEN) return;
    const body = JSON.stringify(message);
    if (
      owner.socket.bufferedAmount + Buffer.byteLength(body) >
      bound.outboundBytes
    )
      return revokeOwner(owner);
    owner.socket.send(body);
  };
  const releaseUpload = (owner, id) => {
    const upload = owner.uploads.get(id);
    if (!upload) return;
    owner.uploads.delete(id);
    uploads--;
    clearTimeout(upload.timer);
    bytes -= upload.bodyBytes;
    owner.bytes -= upload.bodyBytes;
    upload.doc.bytes -= upload.bodyBytes;
    upload.chunks.length = 0;
  };
  const revokeDocument = (doc) => {
    if (!documents.delete(doc.key)) return;
    doc.owner.documents.delete(doc.documentId);
    for (const [id, u] of doc.owner.uploads)
      if (u.doc === doc) releaseUpload(doc.owner, id);
    for (const id of doc.resources) {
      const resource = resources.get(id);
      if (resource) {
        resources.delete(id);
        bytes -= resource.body.length;
        doc.owner.bytes -= resource.body.length;
        doc.bytes -= resource.body.length;
      }
    }
    for (const [cap, grant] of enrollments)
      if (grant.doc === doc) enrollments.delete(cap);
  };
  const revokeOwner = (owner) => {
    if (owners.get(owner.capability) !== owner) return;
    owners.delete(owner.capability);
    clearTimeout(owner.connectTimer);
    for (const doc of [...owner.documents.values()]) revokeDocument(doc);
    for (const id of [...owner.uploads.keys()]) releaseUpload(owner, id);
    owner.socket?.close(1008, "Native resource owner unavailable");
  };
  async function checked(callback, fallback = false) {
    if (!live || validationCount >= bound.validations) return fallback;
    validationCount++;
    let timer;
    try {
      const validation = Promise.resolve().then(callback);
      validation.finally(() => validationCount--).catch(() => {});
      return await Promise.race([
        validation,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), bound.validationMs);
          timer.unref();
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
  async function valid(owner) {
    if (
      !live ||
      !owner ||
      owners.get(owner.capability) !== owner ||
      Date.now() >= owner.identity.expiresAt
    )
      return false;
    const ok = await checked(() => validateOwner(owner.identity));
    return (
      !!ok &&
      live &&
      owners.get(owner.capability) === owner &&
      Date.now() < owner.identity.expiresAt
    );
  }
  const cors = (req, reply, origin) => {
    if (req.headers.origin !== origin || origin === "null")
      throw error(403, "native_resource_owner_origin_denied");
    reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Vary", "Origin");
  };
  const authorize = async (req, reply) => {
    const match = req.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]{43})$/,
      ),
      owner = match && owners.get(match[1]);
    if (
      !owner ||
      actualOrigin(req) !== owner.identity.resourceOrigin ||
      !(await valid(owner))
    )
      throw error(401, "native_resource_owner_required");
    cors(req, reply, owner.identity.frontendOrigin);
    return owner;
  };
  for (const path of ["owners", "owners/renew", "documents"])
    app.options(ROOT + path, (req, reply) => {
      cache(reply);
      let origin;
      try {
        origin = httpsOrigin(req.headers.origin);
      } catch {
        return reply.code(403).send();
      }
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header("Access-Control-Allow-Methods", "POST, DELETE")
        .header("Access-Control-Allow-Headers", "authorization, content-type");
      return reply.code(204).send();
    });
  async function readIdentity(req, reply) {
    const identity = { ...(await checked(() => authorizeOwner(req), null)) };
    if (
      !keys(identity, [
        "nodeId",
        "frontendOrigin",
        "resourceOrigin",
        "leaseHash",
        "generation",
        "expiresAt",
      ]) ||
      typeof identity.nodeId !== "string" ||
      !identity.nodeId ||
      identity.nodeId.length > 96 ||
      !HASH.test(identity.leaseHash) ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1 ||
      !Number.isFinite(identity.expiresAt) ||
      identity.expiresAt <= Date.now()
    )
      throw error(401, "native_resource_owner_required");
    identity.frontendOrigin = httpsOrigin(identity.frontendOrigin);
    identity.resourceOrigin = httpsOrigin(identity.resourceOrigin);
    if (actualOrigin(req) !== identity.resourceOrigin)
      throw error(403, "native_resource_wrong_selected_node");
    cors(req, reply, identity.frontendOrigin);
    return identity;
  }
  const mintEnrollment = (doc) => {
    for (const [cap, grant] of enrollments)
      if (grant.doc === doc) enrollments.delete(cap);
    const capability = token();
    enrollments.set(capability, {
      doc,
      expires: Math.min(
        doc.owner.identity.expiresAt,
        Date.now() + bound.enrollmentMs,
      ),
    });
    return ROOT + "enroll/" + capability;
  };
  app.post(ROOT + "owners", { bodyLimit: 128 }, async (req, reply) => {
    cache(reply);
    if (
      !keys(req.body || {}, []) ||
      req.headers.origin === "null" ||
      !req.headers.authorization
    )
      throw error(403, "native_resource_owner_required");
    const identity = await readIdentity(req, reply);
    if (owners.size >= bound.owners)
      throw error(429, "native_resource_owner_limit");
    const capability = token(),
      secret = token(),
      owner = {
        capability,
        identity: Object.freeze({ ...identity }),
        cookieName: "__Host-atlas-native-" + token().slice(0, 16),
        secret,
        secretHash: digest(secret),
        socket: null,
        documents: new Map(),
        uploads: new Map(),
        bytes: 0,
      };
    owners.set(capability, owner);
    owner.connectTimer = setTimeout(() => revokeOwner(owner), bound.connectMs);
    owner.connectTimer.unref();
    return {
      capability,
      websocket: ROOT + "owner/" + capability,
      resourceOrigin: identity.resourceOrigin,
      expiresAt: identity.expiresAt,
    };
  });
  app.post(ROOT + "owners/renew", { bodyLimit: 128 }, async (req, reply) => {
    cache(reply);
    if (
      !keys(req.body, ["capability"]) ||
      !CAP.test(req.body.capability) ||
      !req.headers.authorization ||
      req.headers.origin === "null"
    )
      throw error(403, "native_resource_owner_required");
    const owner = owners.get(req.body.capability);
    if (
      !owner ||
      actualOrigin(req) !== owner.identity.resourceOrigin ||
      !(await valid(owner))
    )
      throw error(401, "native_resource_owner_required");
    cors(req, reply, owner.identity.frontendOrigin);
    const renewed = await readIdentity(req, reply);
    if (!(await valid(owner)))
      throw error(401, "native_resource_owner_required");
    if (
      ![
        "nodeId",
        "frontendOrigin",
        "resourceOrigin",
        "leaseHash",
        "generation",
      ].every((key) => renewed[key] === owner.identity[key])
    )
      throw error(403, "native_resource_renewal_scope_denied");
    if (renewed.expiresAt <= owner.identity.expiresAt)
      throw error(409, "native_resource_renewal_stale");
    owner.identity = Object.freeze({ ...renewed });
    return {
      expiresAt: renewed.expiresAt,
      enrollments: [...owner.documents.values()].map((doc) => ({
        documentId: doc.documentId,
        enrollment: mintEnrollment(doc),
      })),
    };
  });
  app.delete(ROOT + "owners", async (req, reply) => {
    cache(reply);
    const owner = await authorize(req, reply);
    revokeOwner(owner);
    return reply.code(204).send();
  });
  app.post(ROOT + "documents", { bodyLimit: 2048 }, async (req, reply) => {
    cache(reply);
    const owner = await authorize(req, reply),
      body = req.body;
    if (!owner.socket || owner.socket.readyState !== WebSocket.OPEN)
      throw error(409, "native_resource_owner_disconnected");
    if (
      !keys(body, ["documentId", "documentURL", "topLevelURL"]) ||
      !ID.test(body.documentId)
    )
      throw error(400, "native_resource_invalid_document");
    const documentURL = safeURL(body.documentURL),
      top = safeURL(body.topLevelURL),
      forbidden = new Set(
        [
          new URL(owner.identity.frontendOrigin).hostname,
          new URL(owner.identity.resourceOrigin).hostname,
          ...blockedHosts,
        ].map((v) => v.toLowerCase()),
      );
    if (forbidden.has(documentURL.hostname) || forbidden.has(top.hostname))
      throw error(403, "native_resource_document_denied");
    if (owner.documents.has(body.documentId))
      throw error(409, "native_resource_document_exists");
    if (owner.documents.size >= bound.documents)
      throw error(429, "native_resource_document_limit");
    const doc = {
      owner,
      key: owner.capability + "|" + body.documentId,
      documentId: body.documentId,
      documentURL: documentURL.href,
      topLevelURL: top.href,
      resources: new Set(),
      bytes: 0,
    };
    owner.documents.set(doc.documentId, doc);
    documents.set(doc.key, doc);
    return {
      documentId: doc.documentId,
      enrollment: mintEnrollment(doc),
    };
  });
  app.get(ROOT + "enroll/:capability", async (req, reply) => {
    cache(reply);
    const grant = enrollments.get(req.params.capability),
      owner = grant?.doc.owner;
    if (
      !grant ||
      grant.expires <= Date.now() ||
      req.headers["sec-fetch-dest"] !== "image" ||
      req.headers["sec-fetch-mode"] !== "no-cors" ||
      Object.keys(req.query || {}).length ||
      actualOrigin(req) !== owner.identity.resourceOrigin ||
      !(await valid(owner)) ||
      enrollments.get(req.params.capability) !== grant
    )
      return reply
        .code(403)
        .type("text/plain")
        .send("Native resource unavailable");
    enrollments.delete(req.params.capability);
    reply
      .header(
        "Set-Cookie",
        `${owner.cookieName}=${owner.secret}; Secure; HttpOnly; SameSite=None; Partitioned; Path=/; Max-Age=${Math.max(1, Math.ceil((owner.identity.expiresAt - Date.now()) / 1000))}`,
      )
      .type("image/png");
    return reply.send(PNG);
  });
  const resource = async (req, reply) => {
    cache(reply);
    const stored = resources.get(req.params.capability),
      owner = stored?.doc.owner;
    const cookie =
      owner && typeof req.headers.cookie === "string"
        ? req.headers.cookie
            .split(/;\s*/)
            .filter((x) => x.startsWith(owner?.cookieName + "="))
        : [];
    const secret =
      cookie.length === 1 ? cookie[0].slice(owner.cookieName.length + 1) : "";
    const proof =
      CAP.test(secret) &&
      owner &&
      timingSafeEqual(digest(secret), owner.secretHash);
    if (
      !stored ||
      !proof ||
      req.headers["sec-fetch-dest"] !== stored.kind ||
      req.headers["sec-fetch-mode"] !== "no-cors" ||
      req.headers["sec-fetch-site"] === "none" ||
      Object.keys(req.query || {}).length ||
      actualOrigin(req) !== owner.identity.resourceOrigin ||
      !(await valid(owner)) ||
      resources.get(req.params.capability) !== stored
    )
      return reply
        .code(403)
        .type("text/plain")
        .send("Native resource unavailable");
    let body = stored.body;
    if (["audio", "video"].includes(stored.kind)) {
      const etag = stored.etag;
      reply.header("Accept-Ranges", "bytes").header("ETag", etag);
      const range = req.headers.range;
      if (
        range !== undefined &&
        (!req.headers["if-range"] || req.headers["if-range"] === etag)
      ) {
        const match =
          typeof range === "string" &&
          range.length <= 128 &&
          /^bytes=(\d*)-(\d*)$/.exec(range);
        let start, end;
        if (match && (match[1] || match[2])) {
          const a = match[1] ? Number(match[1]) : undefined,
            b = match[2] ? Number(match[2]) : undefined;
          if (
            (a === undefined || Number.isSafeInteger(a)) &&
            (b === undefined || Number.isSafeInteger(b))
          ) {
            if (a === undefined && b > 0) {
              start = Math.max(0, body.length - b);
              end = body.length - 1;
            } else if (a !== undefined) {
              start = a;
              end =
                b === undefined
                  ? body.length - 1
                  : Math.min(b, body.length - 1);
            }
          }
        }
        if (
          start === undefined ||
          start >= body.length ||
          end === undefined ||
          end < start
        )
          return reply
            .code(416)
            .header("Content-Range", "bytes */" + body.length)
            .header("Content-Length", 0)
            .send();
        reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${body.length}`);
        body = body.subarray(start, end + 1);
      }
    }
    reply.type(stored.mime).header("Content-Length", body.length);
    return req.method === "HEAD" ? reply.send() : reply.send(body);
  };
  app.route({
    method: ["GET", "HEAD"],
    url: ROOT + "resource/:capability",
    handler: resource,
  });
  function begin(owner, value) {
    if (
      !keys(value, [
        "type",
        "uploadId",
        "documentId",
        "sourceURL",
        "kind",
        "mime",
        "bodyBytes",
        "sha256",
        "policy",
      ]) ||
      !/^[a-f0-9]{32}$/.test(value.uploadId) ||
      owner.uploads.has(value.uploadId) ||
      !ID.test(value.documentId) ||
      !MIME[value.kind] ||
      typeof value.mime !== "string" ||
      value.mime.length > 128 ||
      !MIME[value.kind].test(value.mime) ||
      !Number.isSafeInteger(value.bodyBytes) ||
      value.bodyBytes < 1 ||
      value.bodyBytes > bound.bodyBytes ||
      !HASH.test(value.sha256) ||
      !keys(value.policy, [
        "originalAllowed",
        "mixedContentChecked",
        "integrityChecked",
        "contentPolicyChecked",
      ]) ||
      ![
        "originalAllowed",
        "mixedContentChecked",
        "integrityChecked",
        "contentPolicyChecked",
      ].every((k) => value.policy[k] === true)
    )
      throw error(400, "native_resource_invalid_upload");
    const doc = owner.documents.get(value.documentId),
      source = safeURL(value.sourceURL);
    if (
      !doc ||
      [
        new URL(owner.identity.frontendOrigin).hostname,
        new URL(owner.identity.resourceOrigin).hostname,
        ...blockedHosts,
      ].some((value) => value.toLowerCase() === source.hostname) ||
      (new URL(doc.documentURL).protocol === "https:" &&
        source.protocol !== "https:")
    )
      throw error(403, "native_resource_source_denied");
    if (
      owner.uploads.size >= bound.uploads ||
      doc.resources.size + owner.uploads.size >= bound.resources ||
      resources.size + uploads >= bound.globalResources ||
      bytes + value.bodyBytes > bound.totalBytes ||
      owner.bytes + value.bodyBytes > bound.ownerBytes ||
      doc.bytes + value.bodyBytes > bound.documentBytes
    )
      throw error(429, "native_resource_cache_limit");
    const upload = {
      doc,
      ...value,
      chunks: [],
      received: 0,
      timer: setTimeout(() => {
        releaseUpload(owner, value.uploadId);
        send(owner, {
          type: "error",
          uploadId: value.uploadId,
          code: "native_resource_upload_timeout",
        });
      }, bound.uploadMs),
    };
    upload.timer.unref();
    owner.uploads.set(value.uploadId, upload);
    uploads++;
    bytes += value.bodyBytes;
    owner.bytes += value.bodyBytes;
    doc.bytes += value.bodyBytes;
    send(owner, { type: "upload-ready", uploadId: value.uploadId });
  }
  const upgrade = async (req, socket, head) => {
    let path;
    try {
      path = new URL(req.url, "https://native").pathname;
    } catch {
      return;
    }
    if (!path.startsWith(ROOT + "owner/")) return;
    const match = path.match(
        /^\/native-resource\/v1\/owner\/([A-Za-z0-9_-]{43})$/,
      ),
      owner = match && owners.get(match[1]);
    try {
      if (new URL(req.url, "https://native").search)
        throw error(403, "native_resource_owner_required");
      if (
        !owner ||
        owner.socket ||
        req.headers.origin !== owner.identity.frontendOrigin ||
        actualOrigin(req) !== owner.identity.resourceOrigin ||
        !(await valid(owner)) ||
        owner.socket ||
        owners.get(owner.capability) !== owner
      )
        throw error(403, "native_resource_owner_required");
      wss.handleUpgrade(req, socket, head, (ws) => {
        owner.socket = ws;
        clearTimeout(owner.connectTimer);
        let chain = Promise.resolve(),
          queuedMessages = 0,
          queuedMessageBytes = 0;
        ws.on("error", () => {});
        ws.on("message", (data, binary) => {
          if (
            owners.get(owner.capability) !== owner ||
            owner.socket !== ws ||
            ws.readyState !== WebSocket.OPEN
          )
            return;
          if (binary) {
            if (data.length < 33 || data.length > 65568)
              return revokeOwner(owner);
            const id = data.subarray(0, 32).toString("ascii"),
              upload = owner.uploads.get(id);
            if (
              !upload ||
              data.length - 32 + upload.received > upload.bodyBytes
            )
              return revokeOwner(owner);
            upload.chunks.push(Buffer.from(data.subarray(32)));
            upload.received += data.length - 32;
            return;
          }
          if (data.length > 4096) return revokeOwner(owner);
          let value;
          try {
            value = JSON.parse(data.toString());
          } catch {
            return revokeOwner(owner);
          }
          if (
            ++queuedMessages > bound.queuedMessages ||
            (queuedMessageBytes += data.length) > bound.queuedMessageBytes
          )
            return revokeOwner(owner);
          chain = chain
            .then(async () => {
              if (!(await valid(owner)) || owner.socket !== ws)
                return revokeOwner(owner);
              if (keys(value, ["type"]) && value.type === "ping") {
                send(owner, { type: "pong" });
                return;
              }
              if (value.type === "begin") {
                begin(owner, value);
                return;
              }
              if (
                keys(value, ["type", "uploadId"]) &&
                value.type === "commit"
              ) {
                const upload = owner.uploads.get(value.uploadId);
                if (!upload || upload.received !== upload.bodyBytes)
                  throw error(400, "native_resource_incomplete_upload");
                const body = Buffer.concat(upload.chunks, upload.bodyBytes);
                if (
                  createHash("sha256").update(body).digest("hex") !==
                  upload.sha256
                )
                  throw error(400, "native_resource_digest_mismatch");
                owner.uploads.delete(value.uploadId);
                uploads--;
                clearTimeout(upload.timer);
                const capability = token();
                resources.set(capability, {
                  doc: upload.doc,
                  uploadId: value.uploadId,
                  body,
                  kind: upload.kind,
                  mime: upload.mime,
                  etag: '"' + upload.sha256 + '"',
                });
                upload.doc.resources.add(capability);
                upload.chunks.length = 0;
                send(owner, {
                  type: "resource-ready",
                  uploadId: value.uploadId,
                  url:
                    owner.identity.resourceOrigin +
                    ROOT +
                    "resource/" +
                    capability,
                });
                return;
              }
              if (
                keys(value, ["type", "uploadId"]) &&
                value.type === "abort-upload" &&
                /^[a-f0-9]{32}$/.test(value.uploadId)
              ) {
                releaseUpload(owner, value.uploadId);
                for (const doc of owner.documents.values())
                  for (const capability of [...doc.resources]) {
                    const stored = resources.get(capability);
                    if (stored?.uploadId === value.uploadId) {
                      resources.delete(capability);
                      doc.resources.delete(capability);
                      bytes -= stored.body.length;
                      owner.bytes -= stored.body.length;
                      doc.bytes -= stored.body.length;
                    }
                  }
                send(owner, {
                  type: "upload-aborted",
                  uploadId: value.uploadId,
                });
                return;
              }
              if (
                keys(value, ["type", "documentId"]) &&
                value.type === "revoke-document"
              ) {
                const doc = owner.documents.get(value.documentId);
                if (doc) revokeDocument(doc);
                return;
              }
              throw error(400, "native_resource_invalid_operation");
            })
            .catch((err) => {
              send(owner, {
                type: "error",
                code:
                  typeof err.code === "string"
                    ? err.code
                    : "native_resource_failed",
              });
              revokeOwner(owner);
            })
            .finally(() => {
              queuedMessages--;
              queuedMessageBytes -= data.length;
            });
        });
        ws.on("close", () => revokeOwner(owner));
        send(owner, {
          type: "ready",
          capability: NATIVE_RESOURCE_GATEWAY_CAPABILITY,
        });
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  };
  app.server.on("upgrade", upgrade);
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [cap, grant] of enrollments)
      if (grant.expires <= now) enrollments.delete(cap);
    for (const owner of owners.values())
      if (owner.identity.expiresAt <= now) revokeOwner(owner);
  }, 1000);
  sweep.unref();
  app.addHook("onClose", async () => {
    live = false;
    clearInterval(sweep);
    app.server.removeListener("upgrade", upgrade);
    for (const owner of [...owners.values()]) revokeOwner(owner);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  return {
    revokeSession(leaseHash) {
      for (const owner of [...owners.values()])
        if (owner.identity.leaseHash === leaseHash) revokeOwner(owner);
    },
    stats() {
      return {
        owners: owners.size,
        documents: documents.size,
        resources: resources.size,
        bytes,
        validations: validationCount,
      };
    },
  };
}
