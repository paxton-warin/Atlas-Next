import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");
export const sixDigitCode = (length = 6) =>
  Array.from({ length }, () => String(randomInt(0, 10))).join("");
export const hashSecret = (value: string, secret: string) =>
  createHmac("sha256", secret).update(value).digest("hex");
export const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const key = (value: string) => {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32
    ? decoded
    : createHmac("sha256", "atlas-link-dispenser").update(value).digest();
};
export const encrypt = (plaintext: string, secret: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64url"))
    .join(".");
};
export const decrypt = (payload: string, secret: string) => {
  const [rawIv, rawTag, rawBody] = payload.split(".");
  if (!rawIv || !rawTag || !rawBody)
    throw new Error("Encrypted value is invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(secret),
    Buffer.from(rawIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(rawBody, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};
