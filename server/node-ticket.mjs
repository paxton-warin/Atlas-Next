import { createHmac, timingSafeEqual } from "node:crypto";
export function signTicket(value, secret) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function connectionError(message, statusCode, code, retryable = false) {
  return Object.assign(Error(message), { statusCode, code, retryable });
}
export function connectionErrorBody(error) {
  const status = error.statusCode || 500;
  return {
    error: error.statusCode
      ? error.message
      : "The connection could not be checked.",
    code:
      error.code ||
      (status === 429
        ? "RATE_LIMITED"
        : status >= 500
          ? "CONTROL_UNAVAILABLE"
          : "INVALID_SESSION"),
    retryable: error.retryable ?? (status === 429 || status >= 500),
    serverTime: Date.now(),
  };
}
export function verifyTicket(
  raw,
  secret,
  runtimeOrigin,
  { allowExpired = false } = {},
) {
  let value;
  try {
    if (typeof raw !== "string" || raw.length > 4096) throw Error();
    const [body, sig, ...extra] = raw.split(".");
    const expected = createHmac("sha256", secret).update(body).digest();
    const actual = Buffer.from(sig, "base64url");
    if (
      extra.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw Error();
    value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      !Number.isFinite(value.expires) ||
      value.runtimeOrigin !== runtimeOrigin ||
      (value.generation != null &&
        (!Number.isSafeInteger(value.generation) || value.generation < 1)) ||
      !/^[a-f0-9]{64}$/.test(value.lease) ||
      !["http:", "https:"].includes(new URL(value.origin).protocol)
    )
      throw Error();
  } catch {
    throw connectionError("Invalid browsing ticket.", 401, "INVALID_TICKET");
  }
  if (!allowExpired && value.expires <= Date.now())
    throw connectionError(
      "Browsing credential expired. Renew the connection from Atlas.",
      401,
      "TICKET_EXPIRED",
      true,
    );
  return value;
}
