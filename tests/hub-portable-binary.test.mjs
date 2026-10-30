import test from "node:test";
import assert from "node:assert/strict";
import {
  encodePortableValue,
  decodePortableValue,
  HUB_LIMITS,
} from "../runtime/hub-contracts.ts";
test("a63MiB native Blob fits the separate bounded wire allowance and restores exactly", async () => {
  const size = 63 * 1024 * 1024;
  const bytes = new Uint8Array(size);
  bytes[0] = 19;
  bytes[size - 1] = 71;
  const graph = await encodePortableValue({ blob: new Blob([bytes]) });
  const wireBytes = new TextEncoder().encode(JSON.stringify(graph)).byteLength;
  assert.ok(wireBytes > HUB_LIMITS.portableValueBytes);
  assert.ok(wireBytes < HUB_LIMITS.streamBytes);
  const restored = decodePortableValue(graph).blob;
  assert.equal(restored.size, size);
  assert.deepEqual(
    new Uint8Array(await restored.slice(0, 1).arrayBuffer()),
    new Uint8Array([19]),
  );
  assert.deepEqual(
    new Uint8Array(await restored.slice(-1).arrayBuffer()),
    new Uint8Array([71]),
  );
});
test("decoded key/value and JSON-escaped wire growth have independent finite bounds", async () => {
  await assert.rejects(
    encodePortableValue(
      new Blob([new Uint8Array(HUB_LIMITS.portableValueBytes + 1)]),
    ),
    /too large/,
  );
  const key = "x".repeat(HUB_LIMITS.portableValueBytes / 2 + 1);
  await assert.rejects(encodePortableValue({ [key]: null }), /too large/);
  assert.throws(
    () =>
      decodePortableValue({
        codec: "atlas-portable-v1",
        root: 0,
        nodes: [{ t: "object", entries: [[key, 1]] }, { t: "null" }],
      }),
    /too large/,
  );
  //44MiB decoded text can require132MiB JSON. Reject before staged uploads.
  await assert.rejects(
    encodePortableValue("\0".repeat(22 * 1024 * 1024)),
    /Encoded portable value too large/,
  );
});
test("portable binary decoding handles multi-MiB Blobs/buffers without regexp stack exhaustion", async () => {
  const bytes = new Uint8Array(5 * 1024 * 1024 + 2);
  bytes[0] = 42;
  bytes[bytes.length - 1] = 77;
  const graph = await encodePortableValue({
    buffer: bytes.buffer,
    blob: new Blob([bytes], { type: "application/octet-stream" }),
  });
  const decoded = decodePortableValue(graph),
    buffer = new Uint8Array(decoded.buffer),
    blob = new Uint8Array(await decoded.blob.arrayBuffer());
  assert.equal(buffer.length, bytes.length);
  assert.equal(buffer[0], 42);
  assert.equal(buffer.at(-1), 77);
  assert.equal(blob.length, bytes.length);
  assert.equal(blob[0], 42);
  assert.equal(blob.at(-1), 77);
  assert.equal(decoded.blob.type, "application/octet-stream");
});
test("portable binary decoder rejects noncanonical alphabet, missing padding and unused padding bits", () => {
  for (const v of ["TQ", "T Q==", "TQ==extra", "TR==", "AA=A"])
    assert.throws(() =>
      decodePortableValue({
        codec: "atlas-portable-v1",
        root: 0,
        nodes: [{ t: "buffer", v }],
      }),
    );
  assert.deepEqual(
    new Uint8Array(
      decodePortableValue({
        codec: "atlas-portable-v1",
        root: 0,
        nodes: [{ t: "buffer", v: "TQ==" }],
      }),
    ),
    new Uint8Array([77]),
  );
});
