/** Optional browser-local durability receipts. Only the trusted storage worker
 * writes after native IDB completion. Files contain authenticated metadata, never
 * website keys/values; the legacy server acknowledgement remains the fallback. */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

export const STORAGE_LOCAL_RECEIPT_PROTOCOL = "atlas-storage-local-receipt-v1";
export const STORAGE_LOCAL_RECEIPT_BYTES = 4096;
const ROOT = "atlas-storage-receipts";
const SLOTS = 8;
const MAX_POLLS = 128;
const BUDGET_MS = 20;
const MAX_MISSES = 3;
const encode = TextEncoder.prototype.encode.bind(new TextEncoder());
const decode = TextDecoder.prototype.decode.bind(
  new TextDecoder("utf-8", { fatal: true }),
);
const parse = JSON.parse.bind(JSON),
  stringify = JSON.stringify.bind(JSON);
const toBase64 = globalThis.btoa.bind(globalThis),
  fromBase64 = globalThis.atob.bind(globalThis);
const apply = Reflect.apply;
const ownDescriptors = Object.getOwnPropertyDescriptors;
const getDescriptor = Object.getOwnPropertyDescriptor;
const arrayFill = Uint8Array.prototype.fill;

export type StorageLocalReceiptResult = {
  ok: boolean;
  revision?: number;
  error?: { name: string; code: string };
};
export type StorageLocalReceiptGrant = {
  protocol: typeof STORAGE_LOCAL_RECEIPT_PROTOCOL;
  documentId: string;
  binding: string;
  origin: string;
  directory: string;
  key: Uint8Array;
};

function record(
  value: unknown,
  allowed: string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = ownDescriptors(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key) || !("value" in descriptor)) return null;
    out[key] = descriptor.value;
  }
  return out;
}
function result(value: unknown): StorageLocalReceiptResult | null {
  const r = record(value, ["ok", "revision", "error"]);
  if (
    !r ||
    typeof r.ok !== "boolean" ||
    (r.revision !== undefined &&
      (!Number.isSafeInteger(r.revision) || (r.revision as number) < 0))
  )
    return null;
  if (r.ok)
    return r.error === undefined
      ? {
          ok: true,
          ...(r.revision === undefined
            ? {}
            : { revision: r.revision as number }),
        }
      : null;
  const error = record(r.error, ["name", "code"]);
  if (
    !error ||
    typeof error.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ||
    typeof error.code !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)
  )
    return null;
  return {
    ok: false,
    ...(r.revision === undefined ? {} : { revision: r.revision as number }),
    error: { name: error.name, code: error.code },
  };
}
function sequence(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}
function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      /^https?:$/.test(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function aad(grant: StorageLocalReceiptGrant, seq: number) {
  return encode(
    stringify([
      STORAGE_LOCAL_RECEIPT_PROTOCOL,
      grant.documentId,
      grant.binding,
      grant.origin,
      grant.directory,
      seq,
    ]),
  );
}
function packet(
  grant: StorageLocalReceiptGrant,
  seq: number,
  value: StorageLocalReceiptResult,
  random: (a: Uint8Array) => Uint8Array,
) {
  const plain = encode(stringify(value));
  try {
    const nonce = random(new Uint8Array(24));
    const encrypted = xchacha20poly1305(
      grant.key,
      nonce,
      aad(grant, seq),
    ).encrypt(plain);
    const bytes = new Uint8Array(nonce.length + encrypted.length);
    bytes.set(nonce);
    bytes.set(encrypted, nonce.length);
    const text = toBase64(String.fromCharCode(...bytes));
    if (text.length > STORAGE_LOCAL_RECEIPT_BYTES)
      throw new RangeError("Local receipt exceeds allowance");
    return text.padEnd(STORAGE_LOCAL_RECEIPT_BYTES, " ");
  } finally {
    apply(arrayFill, plain, [0]);
  }
}
function open(
  grant: StorageLocalReceiptGrant,
  seq: number,
  text: string,
): StorageLocalReceiptResult | null {
  if (typeof text !== "string" || text.length > STORAGE_LOCAL_RECEIPT_BYTES)
    return null;
  const compact = text.trim();
  if (compact.length < 56 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact))
    return null;
  let plain: Uint8Array | undefined;
  try {
    const binary = fromBase64(compact);
    if (toBase64(binary) !== compact) return null;
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    plain = xchacha20poly1305(
      grant.key,
      bytes.subarray(0, 24),
      aad(grant, seq),
    ).decrypt(bytes.subarray(24));
    return result(parse(decode(plain)));
  } catch {
    return null;
  } finally {
    if (plain) apply(arrayFill, plain, [0]);
  }
}

/** Best-effort bounded removal of old marker-only directories, never user data.
 * Unknown files, subdirectories, missing metadata or recent files prevent removal. */
function sweep(root: any, now: number) {
  try {
    const directories = root.createReader().readEntries().slice(0, 8);
    let removed = 0;
    for (const directory of directories) {
      if (
        removed >= 2 ||
        !directory.isDirectory ||
        !/^[A-Za-z0-9_-]{43}$/.test(directory.name)
      )
        continue;
      const reader = directory.createReader(),
        files = reader.readEntries();
      if (
        !files.length ||
        files.length > SLOTS ||
        reader.readEntries().length ||
        files.some(
          (file: any) =>
            !file.isFile ||
            !/^r[0-7]$/.test(file.name) ||
            !(file.getMetadata().modificationTime instanceof Date) ||
            file.getMetadata().modificationTime.getTime() > now - 7 * 86400000,
        )
      )
        continue;
      for (const file of files) file.remove();
      directory.remove();
      removed++;
    }
  } catch {
    /* Optional scratch cleanup never changes saving semantics. */
  }
}

export function createStorageLocalReceiptWriter(
  scope: any,
  documentId: string,
  options: {localOnly?: boolean} = {},
): null | {
  grant: StorageLocalReceiptGrant;
  write(sequence: number, result: StorageLocalReceiptResult): void;
  dispose(): void;
} {
  let grant: StorageLocalReceiptGrant | undefined, directory: any;
  let allocatedKey: Uint8Array | undefined;
  try {
    if (
      !/^[A-Za-z0-9_-]{16,96}$/.test(documentId) ||
      typeof scope.webkitRequestFileSystemSync !== "function" ||
      !validOrigin(scope.location?.origin) ||
      !scope.crypto?.getRandomValues ||
      !scope.crypto?.randomUUID ||
      typeof scope.Blob !== "function"
    )
      return null;
    const random = scope.crypto.getRandomValues.bind(scope.crypto);
    const key = (allocatedKey = random(new Uint8Array(32)));
    const capability = toBase64(
      String.fromCharCode(...random(new Uint8Array(32))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    grant = {
      protocol: STORAGE_LOCAL_RECEIPT_PROTOCOL,
      documentId,
      binding: scope.crypto.randomUUID(),
      origin: scope.location.origin,
      directory: capability,
      key,
    };
    const filesystem = scope.webkitRequestFileSystemSync(
      scope.TEMPORARY ?? 0,
      1024 * 1024,
    );
    const root = filesystem.root.getDirectory(ROOT, { create: true });
    sweep(root, Date.now());
    directory = root.getDirectory(capability, {
      create: true,
      exclusive: true,
    });
    const files = Array.from({ length: SLOTS }, (_, i) =>
      directory.getFile("r" + i, { create: true, exclusive: true }),
    );
    // Range reads of a zero-length filesystem slot can throw before the first
    // commit completes. Preallocate non-authenticating padding before READY;
    // an empty slot is a bounded poll miss, never a false acknowledgement.
    for (const file of files) {
      const initial = file.createWriter();
      initial.seek(0);
      initial.write(
        new scope.Blob([" ".repeat(STORAGE_LOCAL_RECEIPT_BYTES)], {
          type: "text/plain",
        }),
      );
    }
    const binding = grant;
    let live = true,
      lastWritten = -1;
    const dispose = () => {
      if (!live) return;
      live = false;
      apply(arrayFill, binding.key, [0]);
      for (const file of files)
        try {
          file.remove();
        } catch {}
      try {
        directory.remove();
      } catch {}
    };
    return {
      grant: binding,
      write(seq, value) {
        if (!live) return;
        if (!sequence(seq) || seq < lastWritten || (seq === lastWritten && !options.localOnly))
          throw new TypeError("Invalid local receipt sequence");
        const checked = result(value);
        if (!checked) throw new TypeError("Invalid local receipt metadata");
        try {
          const text = packet(binding, seq, checked, random);
          const writer = files[seq % SLOTS].createWriter();
          writer.seek(0);
          writer.write(new scope.Blob([text], { type: "text/plain" }));
          if (writer.length > STORAGE_LOCAL_RECEIPT_BYTES)
            writer.truncate(STORAGE_LOCAL_RECEIPT_BYTES);
          lastWritten = seq;
        } catch (error) {
          dispose();
          throw error;
        }
      },
      dispose,
    };
  } catch {
    if (allocatedKey) apply(arrayFill, allocatedKey, [0]);
    // Initialization can fail between slot creation steps. Remove only our slots.
    if (directory) {
      for (let i = 0; i < SLOTS; i++)
        try {
          directory.getFile("r" + i, { create: false }).remove();
        } catch {}
      try {
        directory.remove();
      } catch {}
    }
    return null;
  }
}

export function createStorageLocalReceiptReader(options: {
  host: Window;
  documentId: string;
  grant: unknown;
}): null | {
  read(sequence: number): StorageLocalReceiptResult | undefined;
  dispose(): void;
} {
  let key: Uint8Array | undefined;
  try {
    const host = options.host as Window & typeof globalThis;
    const g = record(options.grant, [
      "protocol",
      "documentId",
      "binding",
      "origin",
      "directory",
      "key",
    ]);
    if (
      !g ||
      g.protocol !== STORAGE_LOCAL_RECEIPT_PROTOCOL ||
      g.documentId !== options.documentId ||
      !/^[A-Za-z0-9_-]{16,96}$/.test(options.documentId) ||
      typeof g.binding !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        g.binding,
      ) ||
      !validOrigin(g.origin) ||
      g.origin !== host.location.origin ||
      typeof g.directory !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(g.directory) ||
      !(g.key instanceof host.Uint8Array) ||
      g.key.length !== 32 ||
      typeof host.XMLHttpRequest !== "function" ||
      typeof host.performance?.now !== "function"
    )
      return null;
    key = new Uint8Array(32);
    key.set(g.key);
    const grant: StorageLocalReceiptGrant = {
      protocol: STORAGE_LOCAL_RECEIPT_PROTOCOL,
      documentId: options.documentId,
      binding: g.binding,
      origin: g.origin,
      directory: g.directory,
      key,
    };
    const XHR = host.XMLHttpRequest,
      proto = XHR.prototype;
    const openXHR = proto.open,
      send = proto.send,
      setHeader = proto.setRequestHeader;
    const responseText = getDescriptor(proto, "responseText")?.get,
      status = getDescriptor(proto, "status")?.get;
    const getHeader = proto.getResponseHeader;
    const now = host.performance.now.bind(host.performance);
    if (
      !responseText ||
      !status ||
      !openXHR ||
      !send ||
      !setHeader ||
      !getHeader
    ) {
      apply(arrayFill, key, [0]);
      return null;
    }
    let live = true,
      misses = 0,
      lastAccepted = -1;
    const dispose = () => {
      live = false;
      apply(arrayFill, grant.key, [0]);
    };
    return {
      read(seq) {
        if (!live || !sequence(seq) || seq <= lastAccepted) return;
        const deadline = now() + BUDGET_MS;
        for (let polls = 0; polls < MAX_POLLS && now() < deadline; polls++) {
          try {
            const xhr = new XHR();
            const url =
              "filesystem:" +
              grant.origin +
              "/temporary/" +
              ROOT +
              "/" +
              grant.directory +
              "/r" +
              (seq % SLOTS);
            apply(openXHR, xhr, ["GET", url, false]);
            apply(setHeader, xhr, ["Range", "bytes=0-4095"]);
            apply(send, xhr, []);
            const code = apply(status, xhr, []);
            if (code !== 200 && code !== 206) continue;
            if (code === 206) {
              const range = apply(getHeader, xhr, ["Content-Range"]);
              const total =
                typeof range === "string" ? /\/(\d+)$/.exec(range) : null;
              if (!total || Number(total[1]) > STORAGE_LOCAL_RECEIPT_BYTES)
                continue;
            }
            const value = open(grant, seq, apply(responseText, xhr, []));
            if (value) {
              lastAccepted = seq;
              misses = 0;
              return value;
            }
          } catch {
            break;
          }
        }
        if (++misses >= MAX_MISSES) dispose();
        return;
      },
      dispose,
    };
  } catch {
    if (key) apply(arrayFill, key, [0]);
    return null;
  }
}
