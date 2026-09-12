import { createHmac, timingSafeEqual } from "node:crypto";
export function signTicket(value, secret) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function verifyTicket(raw, secret, runtimeOrigin) {
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
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      !Number.isFinite(value.expires) ||
      value.expires < Date.now() ||
      value.runtimeOrigin !== runtimeOrigin ||
      !/^[a-f0-9]{64}$/.test(value.lease) ||
      !["http:", "https:"].includes(new URL(value.origin).protocol)
    )
      throw Error();
    return value;
  } catch {
    throw Object.assign(
      Error("Browsing connection expired. Reconnect from Atlas."),
      { statusCode: 401 },
    );
  }
}
