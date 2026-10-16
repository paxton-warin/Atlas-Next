// No hostname allowlist. Fastify only accepts forwarded headers from TRUST_PROXY.
import proxyAddress from "@fastify/proxy-addr";
export function requestOrigin(req, fallback) {
  const authority = req.headers.host || new URL(fallback).host;
  const host = req.hostname || authority;
  // req.host retains the port; req.hostname may not on some Fastify versions.
  const forwarded = req.host || authority;
  const value = new URL(
    `${req.protocol || new URL(fallback).protocol.slice(0, -1)}://${forwarded}`,
  );
  if (
    value.username ||
    value.password ||
    value.pathname !== "/" ||
    value.search ||
    value.hash ||
    !host
  )
    throw Object.assign(Error("Invalid request origin."), { statusCode: 400 });
  return value.origin;
}

/** HTTP upgrade events contain raw IncomingMessage, not Fastify's trusted
 * protocol/host getters. Reuse the explicit proxy-address policy; otherwise a
 * CloudFront/Caddy WSS upgrade is mistakenly verified as internal plain HTTP.
 * Untrusted peers never get to select their origin through forwarded headers. */
export function createUpgradeOrigin(fallback, trustedProxies = []) {
  const trusted = proxyAddress.compile(trustedProxies);
  const last = (value) =>
    typeof value === "string"
      ? value.slice(value.lastIndexOf(",") + 1).trim()
      : undefined;
  return (req) => {
    if (req.raw) return requestOrigin(req, fallback);
    const allowed =
      !!req.socket?.remoteAddress && trusted(req.socket.remoteAddress, 0);
    const host =
      (allowed && last(req.headers["x-forwarded-host"])) ||
      req.headers.host ||
      new URL(fallback).host;
    const protocol =
      (allowed && last(req.headers["x-forwarded-proto"])) ||
      (req.socket?.encrypted ? "https" : "http");
    if (!["http", "https"].includes(protocol))
      throw Object.assign(Error("Invalid request origin."), {
        statusCode: 400,
      });
    return requestOrigin({ headers: { host }, host, protocol }, fallback);
  };
}
