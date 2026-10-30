/** Chromium-local result transport. Cookie packets are already authenticated
 * and encrypted by sandbox-cookie-result; neither HTTP nor cloud state appears
 * in this module. Receipt absence never constitutes successful persistence. */
export const COOKIE_LOCAL_RECEIPT_PROTOCOL = "atlas-cookie-local-receipt-v2";
export const COOKIE_SPLIT_RECEIPT_PROTOCOL = "atlas-cookie-local-receipt-v3";
export const COOKIE_LOCAL_RECEIPT_PROBE = "atlas-local-receipt-probe";
type ReceiptOperation = "get" | "set";
const ROOT = "atlas-cookie-receipts-v2",
  SLOTS = 2;
const MAX_PACKET = 1024 * 1024,
  MAX_BYTES = MAX_PACKET + 512;
export type CookieLocalReceiptGrant = {
  protocol: typeof COOKIE_LOCAL_RECEIPT_PROTOCOL | typeof COOKIE_SPLIT_RECEIPT_PROTOCOL;
  documentId: string;
  binding: string;
  origin: string;
  directory: string;
};
const validSequence = (n: number) => Number.isSafeInteger(n) && n >= 0;
const validId = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9_-]{16,96}$/.test(s);
export function createCookieLocalReceiptWriter(
  scope: any,
  documentId: string,
  options: { splitOperations?: boolean } = {},
): null | {
  grant: CookieLocalReceiptGrant;
  write(sequence: number, packet: string, operation?: ReceiptOperation): void;
  dispose(): void;
} {
  let directory: any, pending: any;
  const files: any[] = [];
  const split = options.splitOperations === true;
  const names = split ? ["g0", "g1", "s0", "s1"] : ["r0", "r1"];
  const publishedBytes = Array<number>(names.length).fill(1);
  const slotIndex = (sequence: number, operation: ReceiptOperation) =>
    sequence % SLOTS + (split && operation === "set" ? SLOTS : 0);
  try {
    if (
      !validId(documentId) ||
      typeof scope.webkitRequestFileSystemSync !== "function" ||
      !/^https?:\/\//.test(scope.location?.origin) ||
      !scope.crypto?.getRandomValues ||
      !scope.crypto?.randomUUID
    )
      return null;
    const capability = scope
      .btoa(
        String.fromCharCode(
          ...scope.crypto.getRandomValues(new Uint8Array(32)),
        ),
      )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const root = scope
      // TEMPORARY size is an admission hint, not an origin quota or physical
      // reservation. Describe all published lanes plus the one pending file;
      // a request or write can still fail truthfully under browser pressure.
      .webkitRequestFileSystemSync(
        scope.TEMPORARY ?? 0,
        Math.max(4 * 1024 * 1024, (names.length + 1) * MAX_BYTES),
      )
      .root.getDirectory(ROOT, { create: true });
    directory = root.getDirectory(capability, {
      create: true,
      exclusive: true,
    });
    const grant: CookieLocalReceiptGrant = {
      protocol: split ? COOKIE_SPLIT_RECEIPT_PROTOCOL : COOKIE_LOCAL_RECEIPT_PROTOCOL,
      documentId,
      binding: scope.crypto.randomUUID(),
      origin: scope.location.origin,
      directory: capability,
    };
    for (const name of names) {
      const file = directory.getFile(name, {
        create: true,
        exclusive: true,
      });
      file.createWriter().write(new scope.Blob([" "], { type: "text/plain" }));
      files.push(file);
    }
    let live = true,
      last = -1;
    const dispose = () => {
      if (!live) return;
      live = false;
      try {
        pending?.remove();
        pending = undefined;
      } catch {}
      for (const file of files)
        try {
          file.remove();
        } catch {}
      try {
        directory.remove();
      } catch {}
    };
    const write = (sequence: number, packet: string, operation: ReceiptOperation = "get") => {
      if (
        !live ||
        !validSequence(sequence) ||
        !["get", "set"].includes(operation) ||
        sequence < last ||
        typeof packet !== "string" ||
        packet.length > MAX_PACKET
      )
        throw new DOMException(
          "Invalid local cookie receipt",
          "InvalidStateError",
        );
      const text = JSON.stringify({
        binding: grant.binding,
        documentId,
        sequence,
        packet,
      });
      if (text.length > MAX_BYTES)
        throw new RangeError("Cookie receipt exceeds local allowance");
      // A filesystem URL reader can capture a slot's old size before opening
      // its replacement. Never shrink the published path: a smaller replacement
      // can produce Chromium ERR_REQUEST_RANGE even after an atomic rename.
      // High-water padding is bounded and grows only to actual receipt sizes.
      const body = new scope.Blob([text], { type: "text/plain" });
      if (!Number.isSafeInteger(body.size) || body.size > MAX_BYTES)
        throw new RangeError("Cookie receipt exceeds local byte allowance");
      // Snapshots and mutations have separate high-water paths. A large getter
      // must not make every later tiny setter read the snapshot's padded bytes.
      // The packet ceiling is unchanged; this is not weaker acknowledgement.
      const slot = slotIndex(sequence, operation);
      const size = Math.max(publishedBytes[slot], body.size);
      const published = size === body.size
        ? body
        : new scope.Blob([text, " ".repeat(size - body.size)], {
            type: "text/plain",
          });
      // Publish an immutable file rather than editing an open reader's file.
      // One private pending name bounds scratch work if cleanup itself fails.
      if (pending)
        throw new DOMException(
          "Local cookie receipt cleanup is incomplete",
          "InvalidStateError",
        );
      try {
        pending = directory.getFile("pending", {
          create: true,
          exclusive: true,
        });
        if (typeof pending.moveTo !== "function")
          throw new DOMException(
            "Atomic local cookie receipt publication is unsupported",
            "NotSupportedError",
          );
        const writer = pending.createWriter();
        writer.write(published);
        // moveTo replaces the published file only after its full write finishes.
        // The existing write(0) capability probe exercises this before READY.
        pending.moveTo(directory, names[slot]);
        pending = undefined;
        publishedBytes[slot] = size;
        last = sequence;
      } catch (error) {
        try {
          pending?.remove();
          pending = undefined;
        } catch {}
        throw error;
      }
    };
    write(0, COOKIE_LOCAL_RECEIPT_PROBE);
    if (split) write(0, COOKIE_LOCAL_RECEIPT_PROBE, "set");
    return { grant, write, dispose };
  } catch {
    try {
      pending?.remove();
      pending = undefined;
    } catch {}
    for (const file of files)
      try {
        file.remove();
      } catch {}
    try {
      directory?.remove();
    } catch {}
    return null;
  }
}
export function createCookieLocalReceiptReader(options: {
  host: Window & typeof globalThis;
  documentId: string;
  grant: unknown;
}): null | { readonly splitOperations: boolean; read(sequence: number, operation?: ReceiptOperation): string | undefined; dispose(): void } {
  const { host, documentId } = options,
    g = options.grant as CookieLocalReceiptGrant;
  if (
    !g ||
    ![COOKIE_LOCAL_RECEIPT_PROTOCOL, COOKIE_SPLIT_RECEIPT_PROTOCOL].includes(g.protocol) ||
    !validId(documentId) ||
    g.documentId !== documentId ||
    g.origin !== host.location.origin ||
    !/^[A-Za-z0-9_-]{43}$/.test(g.directory) ||
    !/^[a-f0-9-]{36}$/i.test(g.binding) ||
    typeof host.XMLHttpRequest !== "function"
  )
    return null;
  const XHR = host.XMLHttpRequest,
    apply = Reflect.apply;
  const open = XHR.prototype.open,
    send = XHR.prototype.send,
    header = XHR.prototype.setRequestHeader;
  const status = Object.getOwnPropertyDescriptor(XHR.prototype, "status")!.get!;
  const response = Object.getOwnPropertyDescriptor(
    XHR.prototype,
    "responseText",
  )!.get!;
  const now = host.performance.now.bind(host.performance),
    parse = JSON.parse.bind(JSON);
  let live = true;
  const split = g.protocol === COOKIE_SPLIT_RECEIPT_PROTOCOL;
  return {
    splitOperations: split,
    read(sequence, operation = "get") {
      if (!live || !validSequence(sequence) || !["get", "set"].includes(operation)) return;
      const deadline = now() + 20;
      for (let poll = 0; poll < 128 && now() < deadline; poll++) {
        try {
          const xhr = new XHR();
          apply(open, xhr, [
            "GET",
            `filesystem:${g.origin}/temporary/${ROOT}/${g.directory}/${split ? operation === "set" ? "s" : "g" : "r"}${sequence % SLOTS}`,
            false,
          ]);
          // The trusted writer bounds the file. A Range extending beyond a
          // variable-size filesystem file yields416 in Chromium, unlike HTTP.
          // Read this one bounded packet, not a preallocated1MiB slot.
          apply(send, xhr, []);
          if (![200, 206].includes(apply(status, xhr, []))) continue;
          const text = apply(response, xhr, []);
          if (typeof text !== "string" || text.length > MAX_BYTES) continue;
          const value = parse(text);
          if (
            value?.binding === g.binding &&
            value.documentId === documentId &&
            value.sequence === sequence &&
            typeof value.packet === "string" &&
            value.packet.length <= MAX_PACKET
          )
            return value.packet;
        } catch {
          /* A missing or in-progress local file is not a cloud error. */
        }
      }
    },
    dispose() {
      live = false;
    },
  };
}
