/** Exact IndexedDB key encoding; never JSON-stringify native keys directly. */
export type BackupKey =
  | { t: "number" | "date" | "string" | "binary"; v: string }
  | { t: "array"; v: BackupKey[] };
function base64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.byteLength; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
export function measureBackupNativeKey(
  key: IDBValidKey,
  limit = 256 * 1024,
): number {
  let bytes = 0,
    nodes = 0;
  const seen = new Set<object>();
  const visit = (v: IDBValidKey, depth = 0) => {
    if (++nodes > 4096 || depth > 64)
      throw new DOMException(
        "IndexedDB key exceeds automatic backup complexity",
        "DataError",
      );
    if (typeof v === "string") bytes += 32 + v.length * 2;
    else if (typeof v === "number" || v instanceof Date) bytes += 16;
    else if (v instanceof ArrayBuffer) bytes += v.byteLength;
    else if (ArrayBuffer.isView(v)) bytes += v.byteLength;
    else if (Array.isArray(v)) {
      if (seen.has(v))
        throw new DOMException("Invalid cyclic IndexedDB key", "DataError");
      seen.add(v);
      bytes += 64;
      for (const item of v) {
        visit(item, depth + 1);
        if (bytes > limit) break;
      }
      seen.delete(v);
    } else throw new DOMException("Invalid IndexedDB key", "DataError");
    if (bytes > limit)
      throw new DOMException(
        "IndexedDB key exceeds automatic backup memory budget",
        "DataError",
      );
  };
  visit(key);
  return bytes;
}
export function encodeBackupKey(key: IDBValidKey): BackupKey {
  measureBackupNativeKey(key);
  let nodes = 0;
  const seen = new Set<object>();
  const encode = (key: IDBValidKey, depth = 0): BackupKey => {
    if (++nodes > 4096 || depth > 64)
      throw new DOMException(
        "IndexedDB key exceeds the backup budget",
        "DataError",
      );
    if (typeof key === "number") {
      if (Number.isNaN(key))
        throw new DOMException("Invalid IndexedDB key", "DataError");
      return { t: "number", v: Object.is(key, -0) ? "0" : String(key) };
    }
    if (typeof key === "string") return { t: "string", v: key };
    if (key instanceof Date) {
      if (!Number.isFinite(key.getTime()))
        throw new DOMException("Invalid IndexedDB date key", "DataError");
      return { t: "date", v: String(key.getTime()) };
    }
    if (key instanceof ArrayBuffer)
      return { t: "binary", v: base64(new Uint8Array(key)) };
    if (ArrayBuffer.isView(key))
      return {
        t: "binary",
        v: base64(new Uint8Array(key.buffer, key.byteOffset, key.byteLength)),
      };
    if (Array.isArray(key)) {
      if (seen.has(key))
        throw new DOMException("Invalid cyclic IndexedDB key", "DataError");
      seen.add(key);
      const value = {
        t: "array" as const,
        v: key.map((v) => encode(v, depth + 1)),
      };
      seen.delete(key);
      return value;
    }
    throw new DOMException("Invalid IndexedDB key", "DataError");
  };
  return encode(key);
}
export function decodeBackupKey(value: BackupKey): IDBValidKey {
  let nodes = 0;
  const seen = new Set<object>();
  const decode = (value: BackupKey, depth = 0): IDBValidKey => {
    if (++nodes > 4096 || depth > 64) throw Error("BACKUP_KEY_INVALID");
    if (!value || typeof value !== "object") throw Error("BACKUP_KEY_INVALID");
    if (value.t === "array") {
      if (!Array.isArray(value.v)) throw Error("BACKUP_KEY_INVALID");
      if (seen.has(value)) throw Error("BACKUP_KEY_INVALID");
      seen.add(value);
      const keys = value.v.map((v) => decode(v, depth + 1));
      seen.delete(value);
      return keys;
    }
    if (typeof value.v !== "string") throw Error("BACKUP_KEY_INVALID");
    if (value.t === "string") return value.v;
    if (value.t === "number") {
      const n = Number(value.v);
      if (Number.isNaN(n) || String(n) !== value.v || Object.is(n, -0))
        throw Error("BACKUP_KEY_INVALID");
      return n;
    }
    if (value.t === "date") {
      const n = Number(value.v),
        d = new Date(n);
      if (!Number.isFinite(n) || String(n) !== value.v || d.getTime() !== n)
        throw Error("BACKUP_KEY_INVALID");
      return d;
    }
    if (value.t === "binary") {
      const raw = atob(value.v);
      if (btoa(raw) !== value.v) throw Error("BACKUP_KEY_INVALID");
      return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
    }
    throw Error("BACKUP_KEY_INVALID");
  };
  return decode(value);
}
