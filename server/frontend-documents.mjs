/** A short-lived trusted reservation only determines the PHYSICAL frame CSP.
 * It grants no readable upstream bytes or site authority. Opaque documents still
 * need their original-document MessagePorts and gateway enrollment cookie.
 */
import { connectionError } from "./node-ticket.mjs";
const PATH = "/api/browse/controller/document";
const invalid = (code, status = 400) => connectionError(code, status, code);
const idPattern = /^doc_[a-f0-9]{32}$/;
export function installFrontendDocumentReservations(
  app,
  {
    pool,
    originFor,
    limitBrowse,
    ttlMs = 120000,
    maxEntries = 4096,
    maxPerLease = 64,
  },
) {
  const entries = new Map();
  let nextSweep = 0;
  const key = (origin, id) => origin + "\0" + id;
  function valid(record) {
    if (
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= Date.now() ||
      pool.frontendAssignments.validate(record.owner) !== true
    )
      return false;
    const node = pool
      .list()
      .find((candidate) => candidate.id === record.nodeId);
    return (
      !!node &&
      node.state !== "disabled" &&
      (node.id === "local" ? record.frontendOrigin : node.endpoint) ===
        record.resourceOrigin
    );
  }
  function prune() {
    const now = Date.now();
    if (now < nextSweep) return;
    nextSweep = now + 1000;
    // Never run global lease cleanup/SQLite validation once per entry. Every
    // requested record is authoritatively checked below; unrequested revoked
    // records are inert and leave this bounded map by their short TTL.
    for (const [id, record] of entries)
      if (record.expiresAt <= now) entries.delete(id);
  }
  app.post(PATH, async (req) => {
    const frontendOrigin = originFor(req);
    if (req.headers.origin !== frontendOrigin)
      throw invalid("CONTROLLER_ORIGIN_REQUIRED", 403);
    limitBrowse(req);
    const input = req.body;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (name) => !["session", "generation", "documentId"].includes(name),
      ) ||
      !idPattern.test(input.documentId)
    )
      throw invalid("INVALID_DOCUMENT_RESERVATION");
    const owner = pool.frontendAssignments.identity(
      input.session,
      frontendOrigin,
      input.generation,
    );
    if (!owner) throw invalid("INVALID_SESSION", 403);
    prune();
    const existing = entries.get(key(frontendOrigin, input.documentId));
    if (
      existing &&
      (existing.owner.hash !== owner.hash ||
        existing.owner.generation !== owner.generation)
    )
      throw invalid("DOCUMENT_ALREADY_BOUND", 409);
    const grant = await pool.resourceOwner(
      input.session,
      frontendOrigin,
      input.generation,
    );
    // Minting the selected-node grant may await its control plane. Never let a
    // revoked/replaced assignment or an overlapping reservation win that await.
    if (
      pool.frontendAssignments.validate(owner) !== true ||
      grant.frontendOrigin !== frontendOrigin ||
      grant.leaseHash !== owner.hash ||
      grant.generation !== owner.generation ||
      grant.role !== "frontend-resource-owner-v1" ||
      grant.purpose !== "native-resource-owner" ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now()
    )
      throw invalid("SESSION_REVOKED", 409);
    const resource = new URL(grant.resourceOrigin);
    if (
      resource.protocol !== "https:" ||
      resource.origin !== grant.resourceOrigin ||
      resource.href !== resource.origin + "/"
    )
      throw invalid("INVALID_RESOURCE_ORIGIN", 409);
    prune();
    const concurrent = entries.get(key(frontendOrigin, input.documentId));
    if (
      concurrent &&
      (concurrent.owner.hash !== owner.hash ||
        concurrent.owner.generation !== owner.generation ||
        concurrent.resourceOrigin !== resource.origin ||
        concurrent.nodeId !== grant.nodeId)
    )
      throw invalid("DOCUMENT_ALREADY_BOUND", 409);
    if (
      !concurrent &&
      (entries.size >= maxEntries ||
        [...entries.values()].filter(
          (value) =>
            value.owner.hash === owner.hash &&
            value.frontendOrigin === frontendOrigin,
        ).length >= maxPerLease)
    )
      throw invalid("DOCUMENT_LIMIT", 429);
    const record = {
      owner: Object.freeze({ ...owner }),
      frontendOrigin,
      nodeId: grant.nodeId,
      resourceOrigin: resource.origin,
      expiresAt: Math.min(Date.now() + ttlMs, grant.expiresAt),
    };
    if (!valid(record)) throw invalid("SESSION_REVOKED", 409);
    entries.set(key(frontendOrigin, input.documentId), record);
    return {
      documentId: input.documentId,
      frameURL: frontendOrigin + "/browse/frame/" + input.documentId,
      resourceOrigin: record.resourceOrigin,
      expiresAt: record.expiresAt,
    };
  });
  app.delete(PATH, (req) => {
    const origin = originFor(req);
    if (req.headers.origin !== origin)
      throw invalid("CONTROLLER_ORIGIN_REQUIRED", 403);
    const input = req.body;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (name) => !["session", "generation", "documentId"].includes(name),
      ) ||
      !idPattern.test(input.documentId)
    )
      throw invalid("INVALID_DOCUMENT_RESERVATION");
    const owner = pool.frontendAssignments.identity(
      input.session,
      origin,
      input.generation,
    );
    const record = entries.get(key(origin, input.documentId));
    if (
      !owner ||
      (record &&
        (record.owner.hash !== owner.hash ||
          record.owner.generation !== owner.generation))
    )
      throw invalid("INVALID_SESSION", 403);
    entries.delete(key(origin, input.documentId));
    return { ok: true };
  });
  app.addHook("onClose", () => entries.clear());
  return Object.freeze({
    resourceOrigin(req, documentId) {
      prune();
      const id = key(originFor(req), documentId),
        record = entries.get(id);
      if (!record) return undefined;
      if (valid(record)) return record.resourceOrigin;
      entries.delete(id);
      return undefined;
    },
    rendererOwner(req, documentId) {
      const origin = originFor(req), raw = req.headers["x-atlas-browse-session"], generation = req.headers["x-atlas-browse-generation"];
      if (req.headers.origin !== origin || typeof raw !== "string" || typeof generation !== "string" || !/^[1-9][0-9]*$/.test(generation)) return undefined;
      const owner = pool.frontendAssignments.identity(raw, origin, Number(generation));
      const record = entries.get(key(origin, documentId));
      if (!owner || !record || !valid(record) || record.owner.hash !== owner.hash || record.owner.generation !== owner.generation) return undefined;
      return Object.freeze({ documentId, origin, hash: owner.hash, generation: owner.generation });
    },
    rendererOwnerValid(binding) {
      if (!binding || !idPattern.test(binding.documentId)) return false;
      const record = entries.get(key(binding.origin, binding.documentId));
      return !!record && valid(record) && record.owner.hash === binding.hash && record.owner.generation === binding.generation;
    },
    rendererPrefix(req, documentId) {
      const origin = originFor(req), record = entries.get(key(origin, documentId));
      return record && valid(record) ? origin + "/browse/renderer/v1/" + documentId + "/" : undefined;
    },
    get size() {
      prune();
      return entries.size;
    },
  });
}
