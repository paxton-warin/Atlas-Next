/** Purpose-separated native-resource upload authority. A relay upgrade ticket
 * is never a native-resource owner ticket (or vice versa). The gateway gets no
 * raw session capability, upstream website cookie or server-side fetch power. */
import { verifyTicket } from "./node-ticket.mjs";
export const RESOURCE_OWNER_ROLE = "frontend-resource-owner-v1";
export const RESOURCE_OWNER_PURPOSE = "native-resource-owner";
const httpsOrigin = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.href === u.origin + "/"
      ? u.origin
      : null;
  } catch {
    return null;
  }
};
export function createNativeResourceAuthority({
  nodeId,
  secret,
  originFor,
  liveLease,
}) {
  const validateOwner = (identity) =>
    !!identity &&
    identity.nodeId === nodeId() &&
    httpsOrigin(identity.frontendOrigin) === identity.frontendOrigin &&
    httpsOrigin(identity.resourceOrigin) === identity.resourceOrigin &&
    /^[a-f0-9]{64}$/.test(identity.leaseHash) &&
    Number.isSafeInteger(identity.generation) &&
    identity.generation >= 1 &&
    Number.isFinite(identity.expiresAt) &&
    identity.expiresAt > Date.now() &&
    liveLease(identity) === true;
  const authorizeOwner = (req) => {
    const frontend = httpsOrigin(req.headers.origin),
      resource = httpsOrigin(originFor(req));
    const authorization = req.headers.authorization;
    if (
      !frontend ||
      !resource ||
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9_.-]{1,4096}$/.test(authorization) ||
      !secret()
    )
      return null;
    try {
      const ticket = verifyTicket(authorization.slice(7), secret(), frontend);
      if (
        ticket.role !== RESOURCE_OWNER_ROLE ||
        ticket.purpose !== RESOURCE_OWNER_PURPOSE ||
        ticket.node !== nodeId() ||
        ticket.origin !== frontend ||
        ticket.runtimeOrigin !== frontend ||
        ticket.resourceOrigin !== resource ||
        ticket.relayOrigin !== undefined
      )
        return null;
      const identity = {
        nodeId: ticket.node,
        frontendOrigin: frontend,
        resourceOrigin: resource,
        leaseHash: ticket.lease,
        generation: ticket.generation,
        expiresAt: ticket.expires,
      };
      return validateOwner(identity) ? Object.freeze(identity) : null;
    } catch {
      return null;
    }
  };
  return { authorizeOwner, validateOwner };
}
