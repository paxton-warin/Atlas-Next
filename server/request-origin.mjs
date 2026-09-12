// No hostname allowlist. Fastify only accepts forwarded headers from TRUST_PROXY.
export function requestOrigin(req, fallback) {
  const authority = req.headers.host || new URL(fallback).host;
  const host = req.hostname || authority;
  // req.host retains the port; req.hostname may not on some Fastify versions.
  const forwarded = req.host || authority;
  const value = new URL(
    `${req.protocol || new URL(fallback).protocol.slice(0, -1)}://${forwarded}`,
  );
  if (value.username || value.password || value.pathname !== "/" || !host)
    throw Object.assign(Error("Invalid request origin."), { statusCode: 400 });
  return value.origin;
}
