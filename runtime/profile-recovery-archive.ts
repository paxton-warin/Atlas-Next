/** Bounded, self-contained recovery download. Storage records are independent
 * portable VALUE roots: a large database is not one oversized portable graph.
 * Callers retain their local saves until the normal authenticated Hub receipt.
 */
import {
  decodePortableValue,
  encodePortableValue,
  HUB_LIMITS,
  type PortableGraph,
} from "./hub-contracts.ts";

export type PackedProfileRecovery = {
  format: "atlas-recovery-packed-v1";
  archive: Blob;
  records: number;
};
export type ProfileRecovery = {
  format: "atlas-recovery-v1";
  snapshots: unknown[];
  changes: unknown[];
};
export const PROFILE_RECOVERY_ARCHIVE_BYTES =
  HUB_LIMITS.portableValueBytes - 4096;
const FORMAT = "atlas-recovery-archive-v1";
const MIME = "application/x-atlas-recovery-ndjson";
const encoder = new TextEncoder();
const BATCH_BYTES = 256 * 1024;
const BATCH_RECORDS = 128;
type RecordValue = Record<string, any>;
const own = (value: object, key: PropertyKey) => Object.hasOwn(value, key);

export class ProfileRecoveryArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProfileRecoveryArchiveError";
  }
}
function invalid(
  detail = "The recovery archive is incomplete or invalid.",
): never {
  throw new ProfileRecoveryArchiveError(
    "PROFILE_RECOVERY_ARCHIVE_INVALID",
    detail + " Keep the original recovery file and your local saves.",
  );
}
function oversized(): never {
  throw new ProfileRecoveryArchiveError(
    "PROFILE_RECOVERY_ARCHIVE_TOO_LARGE",
    "The recovery archive exceeds the 64 MiB allowance. Your local saves are unchanged. Export individual websites before retrying recovery.",
  );
}
async function yieldTask() {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (scheduler?.yield) await scheduler.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function plain(value: unknown): value is RecordValue {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (d) => !d.enumerable || own(d, "value"),
  );
}
function shape(
  value: unknown,
  allowed: string[],
  required = allowed,
): value is RecordValue {
  return (
    plain(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => own(value, key))
  );
}
function dense(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(value).length !== value.length
  )
    return false;
  for (let i = 0; i < value.length; i++)
    if (!own(Object.getOwnPropertyDescriptor(value, String(i)) || {}, "value"))
      return false;
  return true;
}
function omit(value: RecordValue, excluded: string[]): RecordValue {
  return Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([key, d]) => d.enumerable && !excluded.includes(key))
      .map(([key, d]) => [key, d.value]),
  );
}
function count(value: unknown, limit: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > limit
  )
    invalid();
  return value as number;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function updateCRC(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return crc >>> 0;
}
const checksum = (crc: number) =>
  ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
async function portable(
  value: unknown,
  context: string,
): Promise<PortableGraph> {
  try {
    const graph = await encodePortableValue(value);
    // The existing encoder accepts sparse arrays longer than its decoder and
    // typed-array subclasses that cannot be restored. Reject before packaging.
    for (const node of graph.nodes) {
      if (node.t === "array" && node.length > HUB_LIMITS.graphNodes)
        throw new RangeError("Portable array exceeds allowance");
      if (node.t === "blob" && node.mime.length > 256)
        throw new TypeError("Unsupported Blob MIME");
      if (
        node.t === "view" &&
        ![
          "Int8Array",
          "Uint8Array",
          "Uint8ClampedArray",
          "Int16Array",
          "Uint16Array",
          "Int32Array",
          "Uint32Array",
          "Float32Array",
          "Float64Array",
          "BigInt64Array",
          "BigUint64Array",
          "DataView",
        ].includes(node.type)
      )
        throw new TypeError("Unsupported binary view");
    }
    return graph;
  } catch (error) {
    const detail =
      error instanceof RangeError
        ? "exceeds the individual value size, node or depth allowance"
        : "contains a value that is not portable";
    throw new ProfileRecoveryArchiveError(
      "PROFILE_RECOVERY_RECORD_UNSUPPORTED",
      `Recovery ${context} ${detail}. Your local saves are unchanged. Export that website separately before retrying recovery.`,
    );
  }
}
function snapshotKind(snapshot: unknown): "local" | "cookies" | "idb" | null {
  if (!shape(snapshot, ["namespace", "payload"])) return null;
  const p = snapshot.payload;
  if (
    shape(p, ["format", "revision", "entries"]) &&
    p.format === "atlas-local-snapshot-v1" &&
    dense(p.entries) &&
    p.entries.every(
      (entry) =>
        dense(entry) &&
        entry.length === 2 &&
        entry.every((value) => typeof value === "string"),
    )
  )
    return "local";
  if (
    shape(p, ["format", "revision", "cookies"]) &&
    p.format === "atlas-cookie-snapshot-v1" &&
    dense(p.cookies)
  )
    return "cookies";
  if (
    shape(
      p,
      ["format", "version", "stores", "deleted"],
      ["format", "version", "stores"],
    ) &&
    p.format === "atlas-idb-snapshot-v1" &&
    dense(p.stores) &&
    p.stores.every(
      (store) =>
        shape(store, [
          "name",
          "keyPath",
          "autoIncrement",
          "indexes",
          "records",
          "generator",
        ]) &&
        dense(store.indexes) &&
        dense(store.records) &&
        store.records.every((record) => shape(record, ["key", "value"])),
    )
  )
    return "idb";
  return null;
}
const journalKeys = [
  "id",
  "sequence",
  "profileId",
  "kind",
  "origin",
  "name",
  "createdAt",
  "payload",
  "bytes",
];
const mutationKeys = [
  "type",
  "action",
  "op",
  "store",
  "index",
  "name",
  "options",
  "keyPath",
  "args",
  "key",
  "value",
  "cookie",
];

export async function packProfileRecovery(input: {
  snapshots: readonly unknown[];
  changes: readonly unknown[];
}): Promise<PackedProfileRecovery> {
  if (!input || !dense(input.snapshots) || !dense(input.changes))
    throw new ProfileRecoveryArchiveError(
      "PROFILE_RECOVERY_INPUT_INVALID",
      "Recovery snapshots and changes must be complete ordered arrays. Your local saves are unchanged.",
    );
  const parts: Uint8Array[] = [];
  let bytes = 0,
    crc = 0xffffffff,
    records = 0,
    batchBytes = 0;
  async function line(value: unknown, checked = true) {
    const text = JSON.stringify(value) + "\n";
    if (text.length > PROFILE_RECOVERY_ARCHIVE_BYTES - bytes) oversized();
    const data = encoder.encode(text);
    if (data.byteLength > PROFILE_RECOVERY_ARCHIVE_BYTES - bytes) oversized();
    parts.push(data);
    bytes += data.byteLength;
    if (checked)
      for (let offset = 0; offset < data.length; offset += BATCH_BYTES) {
        crc = updateCRC(crc, data.subarray(offset, offset + BATCH_BYTES));
        if (offset) await yieldTask();
      }
    batchBytes += data.byteLength;
    if (
      batchBytes >= BATCH_BYTES ||
      (records && records % BATCH_RECORDS === 0)
    ) {
      batchBytes = 0;
      await yieldTask();
    }
  }
  async function emit(tag: string, ...values: unknown[]) {
    await line([records++, tag, ...values]);
  }
  await line({
    format: FORMAT,
    snapshots: input.snapshots.length,
    changes: input.changes.length,
  });
  for (let i = 0; i < input.snapshots.length; i++) {
    const s = input.snapshots[i],
      kind = snapshotKind(s),
      context = `snapshot ${i + 1}`;
    if (!kind) {
      await emit("snapshot-whole", i, await portable(s, context));
      continue;
    }
    const snapshot = s as RecordValue,
      payload = snapshot.payload;
    const outer = await portable(
      omit(snapshot, ["payload"]),
      `${context} metadata`,
    );
    if (kind === "local") {
      await emit(
        "snapshot-local",
        i,
        outer,
        await portable(omit(payload, ["entries"]), `${context} metadata`),
        payload.entries.length,
      );
      for (let j = 0; j < payload.entries.length; j++)
        await emit(
          "local-entry",
          i,
          j,
          await portable(payload.entries[j][0], `${context} key ${j + 1}`),
          await portable(payload.entries[j][1], `${context} value ${j + 1}`),
        );
    } else if (kind === "cookies") {
      await emit(
        "snapshot-cookies",
        i,
        outer,
        await portable(omit(payload, ["cookies"]), `${context} metadata`),
        payload.cookies.length,
      );
      for (let j = 0; j < payload.cookies.length; j++)
        await emit(
          "cookie",
          i,
          j,
          await portable(payload.cookies[j], `${context} cookie ${j + 1}`),
        );
    } else {
      await emit(
        "snapshot-idb",
        i,
        outer,
        await portable(omit(payload, ["stores"]), `${context} metadata`),
        payload.stores.length,
      );
      for (let j = 0; j < payload.stores.length; j++) {
        const store = payload.stores[j];
        await emit(
          "idb-store",
          i,
          j,
          await portable(
            omit(store, ["indexes", "records"]),
            `${context} store ${j + 1} metadata`,
          ),
          store.indexes.length,
          store.records.length,
        );
        for (let k = 0; k < store.indexes.length; k++)
          await emit(
            "idb-index",
            i,
            j,
            k,
            await portable(store.indexes[k], `${context} index ${k + 1}`),
          );
        for (let k = 0; k < store.records.length; k++)
          await emit(
            "idb-record",
            i,
            j,
            k,
            await portable(store.records[k].key, `${context} key ${k + 1}`),
            await portable(store.records[k].value, `${context} value ${k + 1}`),
          );
      }
    }
  }
  async function mutation(value: unknown, change: number, index: number) {
    if (
      !shape(value, mutationKeys, []) ||
      (own(value, "args") && !dense(value.args))
    ) {
      await emit(
        "mutation-whole",
        change,
        index,
        await portable(value, `journal ${change + 1} mutation ${index + 1}`),
      );
      return;
    }
    await emit(
      "mutation",
      change,
      index,
      await portable(
        omit(value, ["args", "key", "value", "cookie"]),
        `journal ${change + 1} mutation metadata`,
      ),
      own(value, "key")
        ? await portable(value.key, `journal ${change + 1} mutation key`)
        : null,
      own(value, "value")
        ? await portable(value.value, `journal ${change + 1} mutation value`)
        : null,
      own(value, "cookie")
        ? await portable(value.cookie, `journal ${change + 1} mutation cookie`)
        : null,
      own(value, "args") ? value.args.length : -1,
    );
    if (own(value, "args"))
      for (let k = 0; k < value.args.length; k++)
        await emit(
          "argument",
          change,
          index,
          k,
          await portable(
            value.args[k],
            `journal ${change + 1} argument ${k + 1}`,
          ),
        );
  }
  for (let i = 0; i < input.changes.length; i++) {
    const entry = input.changes[i];
    if (!shape(entry, journalKeys, ["payload"])) {
      await emit("journal-whole", i, await portable(entry, `journal ${i + 1}`));
      continue;
    }
    const metadata = await portable(
        omit(entry, ["payload"]),
        `journal ${i + 1} metadata`,
      ),
      payload = entry.payload;
    if (
      shape(
        payload,
        ["changes", "revision", "transactionId", "version"],
        ["changes"],
      ) &&
      dense(payload.changes)
    ) {
      await emit(
        "journal-batch",
        i,
        metadata,
        await portable(omit(payload, ["changes"]), `journal ${i + 1} metadata`),
        payload.changes.length,
      );
      for (let j = 0; j < payload.changes.length; j++)
        await mutation(payload.changes[j], i, j);
    } else if (shape(payload, ["change", "revision"], ["change"])) {
      await emit(
        "journal-single",
        i,
        metadata,
        await portable(omit(payload, ["change"]), `journal ${i + 1} metadata`),
      );
      await mutation(payload.change, i, 0);
    } else
      await emit(
        "journal-value",
        i,
        metadata,
        await portable(payload, `journal ${i + 1} payload`),
      );
  }
  await line(
    {
      end: FORMAT,
      records,
      snapshots: input.snapshots.length,
      changes: input.changes.length,
      crc32: checksum(crc),
    },
    false,
  );
  return {
    format: "atlas-recovery-packed-v1",
    archive: new Blob(parts as BlobPart[], { type: MIME }),
    records,
  };
}

/** Download the original self-contained bytes; do not re-encode on the UI agent. */
export function fileBlob(envelope: unknown): Blob {
  if (
    !shape(envelope, ["format", "archive", "records"]) ||
    envelope.format !== "atlas-recovery-packed-v1" ||
    !(envelope.archive instanceof Blob)
  )
    invalid();
  if (envelope.archive.size > PROFILE_RECOVERY_ARCHIVE_BYTES) oversized();
  count(envelope.records, envelope.archive.size);
  return envelope.archive;
}
async function* lines(blob: Blob): AsyncGenerator<string> {
  const reader = blob.stream().getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "",
    searched = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        carry += decoder.decode();
        break;
      }
      carry += decoder.decode(next.value, { stream: true });
      let start = 0,
        end: number;
      while ((end = carry.indexOf("\n", searched)) !== -1) {
        yield carry.slice(start, end);
        start = end + 1;
        searched = start;
      }
      carry = carry.slice(start);
      // A large individual value can span many Blob stream chunks. Never
      // rescan the already-inspected prefix of an unfinished NDJSON line.
      searched = carry.length;
    }
    if (carry) invalid("The recovery archive ended before its final record.");
  } catch (error) {
    if (error instanceof ProfileRecoveryArchiveError) throw error;
    invalid();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function decode(graph: unknown): any {
  try {
    return decodePortableValue(graph as PortableGraph);
  } catch {
    invalid("A recovery record failed portable-value validation.");
  }
}
function metadata(graph: unknown, forbidden: string[]): RecordValue {
  const value = decode(graph);
  if (!plain(value) || forbidden.some((key) => own(value, key))) invalid();
  return value;
}

export async function unpackProfileRecovery(
  envelope: PackedProfileRecovery,
): Promise<ProfileRecovery> {
  const archive = fileBlob(envelope),
    iterator = lines(archive)[Symbol.asyncIterator]();
  let crc = 0xffffffff,
    sequence = 0,
    batchBytes = 0;
  async function next(checked = true): Promise<any> {
    const line = await iterator.next();
    if (line.done || !line.value) invalid();
    if (checked) {
      const data = encoder.encode(line.value + "\n");
      for (let offset = 0; offset < data.length; offset += BATCH_BYTES) {
        crc = updateCRC(crc, data.subarray(offset, offset + BATCH_BYTES));
        if (offset) await yieldTask();
      }
      batchBytes += data.length;
      if (
        batchBytes >= BATCH_BYTES ||
        (sequence && sequence % BATCH_RECORDS === 0)
      ) {
        batchBytes = 0;
        await yieldTask();
      }
    }
    try {
      return JSON.parse(line.value);
    } catch {
      invalid();
    }
  }
  function record(value: unknown, tag: string, fields: number): any[] {
    if (
      !Array.isArray(value) ||
      value.length !== fields + 2 ||
      value[0] !== sequence ||
      value[1] !== tag
    )
      invalid("Recovery record order or count did not match.");
    sequence++;
    return value.slice(2);
  }
  const limit = archive.size;
  try {
    const header = await next();
    if (
      !shape(header, ["format", "snapshots", "changes"]) ||
      header.format !== FORMAT
    )
      invalid();
    const snapshotsCount = count(header.snapshots, limit),
      changesCount = count(header.changes, limit);
    const snapshots: unknown[] = [],
      changes: unknown[] = [];
    for (let i = 0; i < snapshotsCount; i++) {
      const raw = await next(),
        tag = raw?.[1];
      if (tag === "snapshot-whole") {
        const [index, graph] = record(raw, tag, 2);
        if (index !== i) invalid();
        snapshots.push(decode(graph));
        continue;
      }
      if (!["snapshot-local", "snapshot-cookies", "snapshot-idb"].includes(tag))
        invalid();
      const [index, outerGraph, payloadGraph, length] = record(raw, tag, 4);
      if (index !== i) invalid();
      const outer = metadata(outerGraph, ["payload"]),
        payload = metadata(payloadGraph, ["entries", "cookies", "stores"]),
        size = count(length, limit);
      if (tag === "snapshot-local") {
        if (payload.format !== "atlas-local-snapshot-v1") invalid();
        const entries = [];
        for (let j = 0; j < size; j++) {
          const [a, b, key, value] = record(await next(), "local-entry", 4);
          if (a !== i || b !== j) invalid();
          entries.push([decode(key), decode(value)]);
        }
        payload.entries = entries;
      } else if (tag === "snapshot-cookies") {
        if (payload.format !== "atlas-cookie-snapshot-v1") invalid();
        const cookies = [];
        for (let j = 0; j < size; j++) {
          const [a, b, value] = record(await next(), "cookie", 3);
          if (a !== i || b !== j) invalid();
          cookies.push(decode(value));
        }
        payload.cookies = cookies;
      } else {
        if (payload.format !== "atlas-idb-snapshot-v1") invalid();
        const stores = [];
        for (let j = 0; j < size; j++) {
          const [a, b, graph, indexCount, recordCount] = record(
            await next(),
            "idb-store",
            5,
          );
          if (a !== i || b !== j) invalid();
          const store = metadata(graph, ["indexes", "records"]),
            indexes = [],
            records = [];
          for (let k = 0, end = count(indexCount, limit); k < end; k++) {
            const [a, b, c, value] = record(await next(), "idb-index", 4);
            if (a !== i || b !== j || c !== k) invalid();
            indexes.push(decode(value));
          }
          for (let k = 0, end = count(recordCount, limit); k < end; k++) {
            const [a, b, c, key, value] = record(await next(), "idb-record", 5);
            if (a !== i || b !== j || c !== k) invalid();
            records.push({ key: decode(key), value: decode(value) });
          }
          store.indexes = indexes;
          store.records = records;
          stores.push(store);
        }
        payload.stores = stores;
      }
      outer.payload = payload;
      snapshots.push(outer);
    }
    async function mutation(change: number, index: number) {
      const raw = await next(),
        tag = raw?.[1];
      if (tag === "mutation-whole") {
        const [a, b, value] = record(raw, tag, 3);
        if (a !== change || b !== index) invalid();
        return decode(value);
      }
      const [a, b, graph, key, value, cookie, argsLength] = record(
        raw,
        "mutation",
        7,
      );
      if (a !== change || b !== index) invalid();
      const result = metadata(graph, ["args", "key", "value", "cookie"]);
      if (key !== null) result.key = decode(key);
      if (value !== null) result.value = decode(value);
      if (cookie !== null) result.cookie = decode(cookie);
      if (argsLength !== -1) {
        const args = [];
        for (let k = 0, end = count(argsLength, limit); k < end; k++) {
          const [a, b, c, graph] = record(await next(), "argument", 4);
          if (a !== change || b !== index || c !== k) invalid();
          args.push(decode(graph));
        }
        result.args = args;
      }
      return result;
    }
    for (let i = 0; i < changesCount; i++) {
      const raw = await next(),
        tag = raw?.[1];
      if (tag === "journal-whole") {
        const [index, graph] = record(raw, tag, 2);
        if (index !== i) invalid();
        changes.push(decode(graph));
        continue;
      }
      if (tag === "journal-value") {
        const [index, outer, value] = record(raw, tag, 3);
        if (index !== i) invalid();
        const entry = metadata(outer, ["payload"]);
        entry.payload = decode(value);
        changes.push(entry);
        continue;
      }
      if (!["journal-batch", "journal-single"].includes(tag)) invalid();
      const values = record(raw, tag, tag === "journal-batch" ? 4 : 3),
        [index, outer, inner] = values;
      if (index !== i) invalid();
      const entry = metadata(outer, ["payload"]),
        payload = metadata(inner, ["changes", "change"]);
      if (tag === "journal-single") payload.change = await mutation(i, 0);
      else {
        const items = [];
        for (let j = 0, end = count(values[3], limit); j < end; j++)
          items.push(await mutation(i, j));
        payload.changes = items;
      }
      entry.payload = payload;
      changes.push(entry);
    }
    const footer = await next(false);
    if (
      !shape(footer, ["end", "records", "snapshots", "changes", "crc32"]) ||
      footer.end !== FORMAT ||
      footer.records !== sequence ||
      sequence !== envelope.records ||
      footer.snapshots !== snapshotsCount ||
      footer.changes !== changesCount ||
      footer.crc32 !== checksum(crc)
    )
      invalid("Recovery archive integrity or record count did not match.");
    if (!(await iterator.next()).done)
      invalid("The recovery archive contains unexpected trailing records.");
    return { format: "atlas-recovery-v1", snapshots, changes };
  } finally {
    await iterator.return?.(undefined);
  }
}
