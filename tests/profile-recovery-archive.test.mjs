import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodePortableValue,
  encodePortableValue,
  HUB_LIMITS,
} from "../runtime/hub-contracts.ts";
import {
  packProfileRecovery,
  unpackProfileRecovery,
  fileBlob,
  PROFILE_RECOVERY_ARCHIVE_BYTES,
  ProfileRecoveryArchiveError,
} from "../runtime/profile-recovery-archive.ts";
const origin = "https://example.org";
const local = (entries) => ({
  namespace: { kind: "local", origin },
  payload: { format: "atlas-local-snapshot-v1", revision: 9, entries },
});
const cookies = (items) => ({
  namespace: { kind: "cookies", origin },
  payload: { format: "atlas-cookie-snapshot-v1", revision: 4, cookies: items },
});
const idb = (records, extra = {}) => ({
  namespace: { kind: "idb", origin, name: "saves" },
  payload: {
    format: "atlas-idb-snapshot-v1",
    version: 3,
    stores: [
      {
        name: "records",
        keyPath: null,
        autoIncrement: true,
        indexes: [
          { name: "label", keyPath: "label", unique: false, multiEntry: false },
        ],
        records,
        generator: { next: 27 },
      },
    ],
    ...extra,
  },
});
const entry = (payload) => ({
  id: "journal-1",
  sequence: 17,
  profileId: "11111111-2222-4333-8444-555555555555",
  kind: "idb",
  origin,
  name: "saves",
  createdAt: 1790000000000,
  payload,
  bytes: 200,
});
const roundtrip = async (input) =>
  unpackProfileRecovery(await packProfileRecovery(input));
const hash = async (blob) =>
  createHash("sha256")
    .update(new Uint8Array(await blob.arrayBuffer()))
    .digest("hex");
function deepValue(depth = 64) {
  let value = null;
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}
async function altered(p, change) {
  const lines = (await p.archive.text()).trimEnd().split("\n");
  return {
    ...p,
    archive: new Blob([change(lines).join("\n") + "\n"], {
      type: p.archive.type,
    }),
  };
}
const unsupported = (error) =>
  error instanceof ProfileRecoveryArchiveError &&
  error.code === "PROFILE_RECOVERY_RECORD_UNSUPPORTED" &&
  /local saves are unchanged/.test(error.message);

test("empty recovery is a complete deterministic self-contained archive and direct download Blob", async () => {
  const input = { snapshots: [], changes: [] };
  const first = await packProfileRecovery(input),
    second = await packProfileRecovery(input);
  assert.equal(first.format, "atlas-recovery-packed-v1");
  assert.equal(first.records, 0);
  assert.equal(first.archive.type, "application/x-atlas-recovery-ndjson");
  assert.equal(fileBlob(first), first.archive);
  assert.equal(await hash(first.archive), await hash(second.archive));
  assert.deepEqual(await unpackProfileRecovery(first), {
    format: "atlas-recovery-v1",
    ...input,
  });
  const text = await first.archive.text();
  assert.match(text, /atlas-recovery-archive-v1/);
  assert.match(text, /"crc32":"[0-9a-f]{8}"/);
  assert.ok(text.endsWith("\n"));
});

test("local/cookie/IDB snapshots, indexes, deleted flags and journal metadata retain values and order", async () => {
  const input = {
    snapshots: [
      local([
        ["first", "value"],
        ["empty", ""],
        ["unicode", "雪😀"],
      ]),
      cookies([
        {
          id: "cookie-1",
          name: "session",
          value: "synthetic",
          session: true,
          expires: null,
        },
      ]),
      idb([
        { key: 1, value: { label: "saved" } },
        { key: ["compound", new Date(0)], value: "second" },
      ]),
      {
        namespace: { kind: "idb", origin, name: "deleted" },
        payload: {
          format: "atlas-idb-snapshot-v1",
          version: 1,
          stores: [],
          deleted: true,
        },
      },
    ],
    changes: [
      entry({
        transactionId: "t1",
        version: 3,
        changes: [
          {
            type: "store",
            action: "put",
            store: "records",
            args: [{ label: "updated" }, 1],
            key: 1,
          },
          {
            type: "schema",
            action: "createIndex",
            store: "records",
            index: "i",
            name: undefined,
            options: { unique: false },
            keyPath: "label",
          },
        ],
      }),
      {
        ...entry({
          change: { op: "set", key: "draft", value: "kept" },
          revision: 2,
        }),
        kind: "local",
        name: undefined,
      },
      entry({
        changes: [
          { op: "set", cookie: { id: "c", value: "a" } },
          { op: "delete", cookie: { id: "d" } },
        ],
        revision: 5,
      }),
    ],
  };
  assert.deepEqual(await roundtrip(input), {
    format: "atlas-recovery-v1",
    ...input,
  });
  assert.equal(HUB_LIMITS.graphNodes, 40000);
  assert.equal(HUB_LIMITS.graphDepth, 64);
});

test("individual values preserve cycles, sparse arrays, maps, sets, binary identity, dates, bigint and platform values", async () => {
  const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
    sparse = new Array(7);
  sparse[2] = undefined;
  sparse[5] = "kept";
  sparse.extra = "extra";
  const value = {
    buffer,
    bytes: new Uint8Array(buffer, 2, 3),
    view: new DataView(buffer, 1, 4),
    when: new Date(1700000000000),
    invalidDate: new Date(NaN),
    big: 12345678901234567890n,
    regexp: /saved/giu,
    sparse,
    minusZero: -0,
    nan: NaN,
    infinity: Infinity,
    undef: undefined,
    blob: new Blob(["saved bytes"], { type: "text/plain" }),
    file: new File(["file body"], "save.bin", {
      type: "application/octet-stream",
      lastModified: 17,
    }),
    map: new Map(),
    set: new Set(),
    nullObject: Object.assign(Object.create(null), { item: "null-prototype" }),
  };
  value.self = value;
  value.map.set(value, "self");
  value.set.add(value);
  Object.defineProperty(value, "__proto__", {
    value: "plain-property",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const result = await roundtrip({
      snapshots: [idb([{ key: 4, value }])],
      changes: [],
    }),
    restored = result.snapshots[0].payload.stores[0].records[0].value;
  assert.equal(restored.self, restored);
  assert.equal(restored.map.get(restored), "self");
  assert.ok(restored.set.has(restored));
  assert.equal(restored.bytes.buffer, restored.buffer);
  assert.equal(restored.view.buffer, restored.buffer);
  assert.deepEqual([...restored.bytes], [3, 4, 5]);
  assert.equal(restored.view.byteLength, 4);
  assert.equal(restored.when.getTime(), value.when.getTime());
  assert.ok(Number.isNaN(restored.invalidDate.getTime()));
  assert.equal(restored.big, value.big);
  assert.equal(restored.regexp.source, value.regexp.source);
  assert.equal(restored.regexp.flags, value.regexp.flags);
  assert.equal(restored.sparse.length, 7);
  assert.equal(0 in restored.sparse, false);
  assert.equal(2 in restored.sparse, true);
  assert.equal(restored.sparse.extra, "extra");
  assert.ok(Object.is(restored.minusZero, -0));
  assert.ok(Number.isNaN(restored.nan));
  assert.equal(restored.infinity, Infinity);
  assert.ok(Object.hasOwn(restored, "undef"));
  assert.equal(Object.getPrototypeOf(restored.nullObject), null);
  assert.equal(restored.__proto__, "plain-property");
  assert.equal(await restored.blob.text(), "saved bytes");
  assert.equal(restored.blob.type, "text/plain");
  assert.equal(restored.file.name, "save.bin");
  assert.equal(restored.file.lastModified, 17);
  assert.equal(await restored.file.text(), "file body");
});

test("native depth64 IDB values and journal argument values are codec roots, not nested archive wrappers", async () => {
  const value = deepValue();
  await encodePortableValue(value);
  const input = {
    snapshots: [idb([{ key: 1, value }])],
    changes: [
      entry({
        transactionId: "t",
        version: 3,
        changes: [
          {
            type: "store",
            action: "put",
            store: "records",
            args: [value, 1],
            key: 1,
          },
        ],
      }),
      entry({ change: { op: "set", key: "deep", value }, revision: 1 }),
      entry(value),
    ],
  };
  const restored = await roundtrip(input);
  assert.deepEqual(restored, { format: "atlas-recovery-v1", ...input });
  await assert.rejects(
    encodePortableValue({ format: "atlas-recovery-v1", ...input }),
    /Portable graph exceeds allowance/,
  );
});

test("10000-record recovery exceeds old aggregate graph allowance but packs/restores without raising limits", async () => {
  const input = {
    snapshots: [
      idb(
        Array.from({ length: 10000 }, (_, key) => ({
          key,
          value: { counter: key, label: "saved" },
        })),
      ),
    ],
    changes: [],
  };
  await assert.rejects(
    encodePortableValue({ format: "atlas-recovery-v1", ...input }),
    /Portable graph exceeds allowance/,
  );
  let yielded = false;
  setTimeout(() => {
    yielded = true;
  }, 0);
  const started = performance.now(),
    packed = await packProfileRecovery(input);
  assert.equal(yielded, true);
  assert.equal(packed.records, 10003);
  assert.ok(packed.archive.size < PROFILE_RECOVERY_ARCHIVE_BYTES);
  assert.ok((await encodePortableValue(packed)).nodes.length < 20);
  yielded = false;
  setTimeout(() => {
    yielded = true;
  }, 0);
  const restored = await unpackProfileRecovery(packed);
  assert.equal(yielded, true);
  assert.deepEqual(restored, { format: "atlas-recovery-v1", ...input });
  console.log(
    "BULK_RECOVERY_RECORDS=10000; ARCHIVE_BYTES=" +
      packed.archive.size +
      "; OUTER_GRAPH_NODES=" +
      (await encodePortableValue(packed)).nodes.length +
      "; PACK_AND_UNPACK_MS=" +
      Math.round(performance.now() - started),
  );
});

test("large journal transactions split mutation arguments instead of one aggregate payload graph", async () => {
  const input = {
    snapshots: [],
    changes: [
      entry({
        transactionId: "bulk",
        version: 3,
        changes: Array.from({ length: 5000 }, (_, key) => ({
          type: "store",
          action: "put",
          store: "records",
          args: [{ counter: key, label: "saved" }, key],
          key,
        })),
      }),
    ],
  };
  await assert.rejects(
    encodePortableValue({ format: "atlas-recovery-v1", ...input }),
    /Portable graph exceeds allowance/,
  );
  const packed = await packProfileRecovery(input);
  assert.equal(packed.records, 15001);
  assert.deepEqual(await unpackProfileRecovery(packed), {
    format: "atlas-recovery-v1",
    ...input,
  });
});

test("unknown and noncanonical formats use a lossless independently bounded fallback", async () => {
  const extra = {
    namespace: { kind: "local", origin },
    payload: {
      format: "atlas-local-snapshot-v1",
      revision: 1,
      entries: [["x", "y"]],
    },
    future: { kind: "preserved" },
  };
  extra.future.parent = extra;
  const array = [1, 2];
  array.extra = "keep";
  const nullRecord = Object.assign(Object.create(null), {
    future: new Map([[1, "yes"]]),
  });
  const input = {
    snapshots: [
      extra,
      { format: "future-snapshot-v2", items: array, unknown: undefined },
      nullRecord,
    ],
    changes: [
      { ...entry({ changed: true }), future: "preserved" },
      "future-journal",
    ],
  };
  const result = await roundtrip(input);
  assert.deepEqual(result, { format: "atlas-recovery-v1", ...input });
  assert.equal(result.snapshots[0].future.parent, result.snapshots[0]);
});

test("unknown individual mutation fields and noncanonical argument arrays are not silently dropped", async () => {
  const args = [1];
  args.extra = "saved";
  const input = {
    snapshots: [],
    changes: [
      entry({
        changes: [
          { action: "future", unknown: { data: "kept" } },
          { type: "store", action: "put", args, key: undefined },
        ],
        revision: 1,
      }),
    ],
  };
  assert.deepEqual(await roundtrip(input), {
    format: "atlas-recovery-v1",
    ...input,
  });
});

test("packing never mutates or deletes caller snapshots, values or journal entries", async () => {
  const input = {
    snapshots: [
      local([["x", "saved"]]),
      idb([{ key: 1, value: { saved: true } }]),
    ],
    changes: [
      entry({
        changes: [{ action: "put", args: [{ saved: "yes" }, 1] }],
        version: 3,
      }),
    ],
  };
  const original = structuredClone(input);
  function freeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  freeze(input);
  await packProfileRecovery(input);
  assert.deepEqual(input, original);
});

test("unsupported, too-deep and individually excessive records reject actionably with inputs intact", async () => {
  const nodeHeavy = Array.from({ length: 20001 }, () => ({ saved: true }));
  const values = [
    () => {},
    Symbol("unsupported"),
    deepValue(65),
    nodeHeavy,
    new Array(HUB_LIMITS.graphNodes + 1),
    new Blob(["x"], { type: "a".repeat(257) }),
  ];
  class CustomView extends Uint8Array {}
  values.push(new CustomView([1, 2]));
  for (const value of values) {
    const record = { key: 1, value },
      input = { snapshots: [idb([record])], changes: [] };
    await assert.rejects(packProfileRecovery(input), unsupported);
    assert.equal(input.snapshots[0].payload.stores[0].records[0], record);
    assert.equal(record.value, value);
  }
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "saved", {
    enumerable: true,
    get() {
      getterCalls++;
      return "unsafe";
    },
  });
  await assert.rejects(
    packProfileRecovery({
      snapshots: [idb([{ key: 1, value: accessor }])],
      changes: [],
    }),
    unsupported,
  );
  assert.equal(getterCalls, 0);
});

test("outer collections reject incomplete sparse arrays rather than dropping holes", async () => {
  await assert.rejects(
    packProfileRecovery({ snapshots: new Array(2), changes: [] }),
    (error) => error.code === "PROFILE_RECOVERY_INPUT_INVALID",
  );
});

test("raw archive is capped below64MiB with4096bytes for the outer envelope", async () => {
  assert.equal(
    PROFILE_RECOVERY_ARCHIVE_BYTES,
    HUB_LIMITS.portableValueBytes - 4096,
  );
  const value = "s".repeat(17 * 1024 * 1024),
    records = Array.from({ length: 4 }, (_, key) => ({ key, value })),
    input = { snapshots: [idb(records)], changes: [] };
  await assert.rejects(
    packProfileRecovery(input),
    (error) =>
      error.code === "PROFILE_RECOVERY_ARCHIVE_TOO_LARGE" &&
      /individual websites/.test(error.message),
  );
  assert.equal(records.length, 4);
  assert.equal(records[0].value, value);
});

test("wrong envelope, invalidUTF8 and truncated/header/footer/count/order corruption reject", async () => {
  const packed = await packProfileRecovery({
    snapshots: [
      local([
        ["a", "saved"],
        ["b", "saved"],
      ]),
    ],
    changes: [],
  });
  for (const envelope of [
    { ...packed, format: "future" },
    { ...packed, records: packed.records + 1 },
    { ...packed, archive: new Blob([]) },
    { ...packed, archive: new Blob([new Uint8Array([255])]) },
  ])
    await assert.rejects(
      unpackProfileRecovery(envelope),
      (error) => error.code === "PROFILE_RECOVERY_ARCHIVE_INVALID",
    );
  const edits = [
    (lines) => lines.slice(0, -1),
    (lines) => [lines[0], lines[2], lines[1], ...lines.slice(3)],
    (lines) => [...lines.slice(0, 2), lines[1], ...lines.slice(2)],
    (lines) => {
      const header = JSON.parse(lines[0]);
      header.format = "future";
      lines[0] = JSON.stringify(header);
      return lines;
    },
    (lines) => {
      const footer = JSON.parse(lines.at(-1));
      footer.records++;
      lines[lines.length - 1] = JSON.stringify(footer);
      return lines;
    },
    (lines) => [...lines, "[]"],
    (lines) => lines.map((line) => line + "\r"),
  ];
  for (const edit of edits)
    await assert.rejects(
      unpackProfileRecovery(await altered(packed, edit)),
      (error) => error.code === "PROFILE_RECOVERY_ARCHIVE_INVALID",
    );
  await assert.rejects(
    unpackProfileRecovery({
      ...packed,
      archive: new Blob([(await packed.archive.text()).slice(0, -1)]),
    }),
    (error) => error.code === "PROFILE_RECOVERY_ARCHIVE_INVALID",
  );
});

test("checksum rejects otherwise valid altered data before publishing any restored recovery", async () => {
  const packed = await packProfileRecovery({
    snapshots: [local([["key", "before"]])],
    changes: [],
  });
  const changed = await altered(packed, (lines) =>
    lines.map((line) => line.replace("before", "after")),
  );
  await assert.rejects(
    unpackProfileRecovery(changed),
    (error) =>
      error.code === "PROFILE_RECOVERY_ARCHIVE_INVALID" &&
      /integrity/.test(error.message),
  );
  assert.match(await packed.archive.text(), /before/);
});

test("packed graph survives the existing codec and returns the exact self-contained file bytes", async () => {
  const packed = await packProfileRecovery({
    snapshots: [local([["x", "saved"]])],
    changes: [],
  });
  const decoded = decodePortableValue(await encodePortableValue(packed));
  assert.equal(await hash(fileBlob(decoded)), await hash(packed.archive));
  assert.deepEqual(await unpackProfileRecovery(decoded), {
    format: "atlas-recovery-v1",
    snapshots: [local([["x", "saved"]])],
    changes: [],
  });
});
