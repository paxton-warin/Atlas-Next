/** Private synchronous result envelope. Keys stay on browser-local document
 * capabilities; the rendezvous sees only AEAD ciphertext, length and timing.
 * This is deliberately separate from the marker-only localStorage protocol. */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
export const COOKIE_RESULT_PROTOCOL = "atlas-cookie-result-v1";
export const MAX_COOKIE_VIEW_BYTES = 4 * 1024 * 1024;
export const MAX_COOKIE_PACKET_CHARS = 5600000;
const encode = TextEncoder.prototype.encode.bind(new TextEncoder());
const decode = TextDecoder.prototype.decode.bind(
  new TextDecoder("utf-8", { fatal: true }),
);
const parse = JSON.parse.bind(JSON),
  stringify = JSON.stringify.bind(JSON);
const toBase64 = globalThis.btoa.bind(globalThis),
  fromBase64 = globalThis.atob.bind(globalThis);
const chars = String.fromCharCode;
const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
export type CookieOperation = "get" | "set";
export type CookieViewEntry = {id: string; name: string; value: string; path: string; created: number; expiresAt: number | null};
export type CookieViewDelta = {baseVersion: number; baseRevision: number; upsert: CookieViewEntry[]; remove: string[]};
export function validateCookieViewEntries(value: unknown): value is CookieViewEntry[] {
  return Array.isArray(value) && value.length <= 180 && value.every(v => v &&
    Object.keys(v).every(k => ["id","name","value","path","created","expiresAt"].includes(k)) &&
    [v.id,v.name,v.value,v.path].every(s => typeof s === "string" && s.length <= 32768) &&
    Number.isFinite(v.created) && (v.expiresAt === null || Number.isFinite(v.expiresAt)));
}
export function cookieViewString(entries: CookieViewEntry[], now = Date.now()): string {
  return entries.filter(e => e.expiresAt === null || e.expiresAt > now)
    .slice().sort((a,b) => b.path.length-a.path.length || a.created-b.created || a.id.localeCompare(b.id))
    .map(e => e.name ? e.name+"="+e.value : e.value).join("; ");
}
export function validateCookieViewDelta(value: unknown): value is CookieViewDelta {
  const v = value as CookieViewDelta;
  return !!v && Object.keys(v).every(k => ["baseVersion","baseRevision","upsert","remove"].includes(k)) &&
    Number.isSafeInteger(v.baseVersion) && v.baseVersion >= 0 && Number.isSafeInteger(v.baseRevision) && v.baseRevision >= 0 &&
    validateCookieViewEntries(v.upsert) && v.upsert.length <= 1 && Array.isArray(v.remove) && v.remove.length <= 1 &&
    v.remove.every(s => typeof s === "string" && s.length <= 32768);
}
export function applyCookieViewDelta(entries: CookieViewEntry[], delta: CookieViewDelta): CookieViewEntry[] {
  if (!validateCookieViewEntries(entries) || !validateCookieViewDelta(delta)) throw new DOMException("Invalid cookie delta", "SecurityError");
  const now = Date.now();
  const next = new Map(entries.filter(e => e.expiresAt === null || e.expiresAt > now).map(e => [e.id,e]));
  for (const id of delta.remove) next.delete(id);
  for (const entry of delta.upsert) next.set(entry.id,entry);
  const values = [...next.values()];
  if (!validateCookieViewEntries(values)) throw new DOMException("Cookie view exceeds its local allowance", "QuotaExceededError");
  return values;
}
export type CookieResult = {
  documentId: string;
  sequence: number;
  operation: CookieOperation;
  view: string;
  viewVersion: number;
  expiresAt: number | null;
  error?: string;
  localMode?: 2;
  cookieRevision?: number;
  entries?: CookieViewEntry[];
  delta?: CookieViewDelta;
};
const aad = (
  documentId: string,
  sequence: number,
  operation: CookieOperation,
) =>
  encode(stringify([COOKIE_RESULT_PROTOCOL, documentId, sequence, operation]));
export function newCookieResultKey() {
  return random(new Uint8Array(32));
}
export function sealCookieResult(key: Uint8Array, result: CookieResult) {
  const plain = encode(stringify(result));
  if (
    encode(result.view).length > MAX_COOKIE_VIEW_BYTES ||
    plain.length > MAX_COOKIE_VIEW_BYTES + 1024
  )
    throw new DOMException(
      "Cookie view exceeds result budget",
      "QuotaExceededError",
    );
  const nonce = random(new Uint8Array(24));
  const encrypted = xchacha20poly1305(
    key,
    nonce,
    aad(result.documentId, result.sequence, result.operation),
  ).encrypt(plain);
  const packet = new Uint8Array(nonce.length + encrypted.length);
  packet.set(nonce);
  packet.set(encrypted, nonce.length);
  let binary = "";
  for (let offset = 0; offset < packet.length; offset += 8192)
    binary += chars(...packet.subarray(offset, offset + 8192));
  return toBase64(binary);
}
export function openCookieResult(
  key: Uint8Array,
  packet: string,
  expected: {
    documentId: string;
    sequence: number;
    operation: CookieOperation;
  },
): CookieResult {
  if (
    typeof packet !== "string" ||
    packet.length < 56 ||
    packet.length > MAX_COOKIE_PACKET_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(packet)
  )
    throw new DOMException("Invalid cookie result", "SecurityError");
  const binary = fromBase64(packet),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let result: CookieResult;
  try {
    result = parse(
      decode(
        xchacha20poly1305(
          key,
          bytes.subarray(0, 24),
          aad(expected.documentId, expected.sequence, expected.operation),
        ).decrypt(bytes.subarray(24)),
      ),
    );
  } catch {
    throw new DOMException(
      "Cookie result authentication failed",
      "SecurityError",
    );
  }
  if (
    !result ||
    Object.keys(result).some(
      (k) =>
        ![
          "documentId",
          "sequence",
          "operation",
          "view",
          "viewVersion",
          "expiresAt",
          "error",
          "localMode",
          "cookieRevision",
          "entries",
          "delta",
        ].includes(k),
    ) ||
    result.documentId !== expected.documentId ||
    result.sequence !== expected.sequence ||
    result.operation !== expected.operation ||
    typeof result.view !== "string" ||
    encode(result.view).length > MAX_COOKIE_VIEW_BYTES ||
    !Number.isSafeInteger(result.viewVersion) ||
    result.viewVersion < 0 ||
    !(result.expiresAt === null || Number.isFinite(result.expiresAt)) ||
    (result.error !== undefined &&
      ![
        "AbortError",
        "QuotaExceededError",
        "InvalidStateError",
        "UnknownError",
      ].includes(result.error)) ||
    (result.localMode !== undefined && result.localMode !== 2) ||
    (result.localMode === 2 && (!Number.isSafeInteger(result.cookieRevision) || result.cookieRevision! < 0 ||
      (result.operation === "get" ? !validateCookieViewEntries(result.entries) || result.delta !== undefined :
        !validateCookieViewDelta(result.delta) || result.entries !== undefined || result.view !== ""))) ||
    (result.localMode === undefined && (result.cookieRevision !== undefined || result.entries !== undefined || result.delta !== undefined))
  )
    throw new DOMException("Invalid cookie result binding", "SecurityError");
  return result;
}
