import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  adaptPinnedHttpEngine,
  addPinnedWebSocketSendExport,
  OPAQUE_HTTPENGINE_SOURCE_SHA256,
  OPAQUE_HTTPENGINE_WASM_SHA256,
} from "../scripts/opaque-httpengine.mjs";
const source = fs.readFileSync(
    "runtime/public/clients/httpengine-client.js",
    "utf8",
  ),
  hash = (x) => createHash("sha256").update(x).digest("hex");
function wasm(s) {
  return Buffer.from(
    JSON.parse(s.match(/wasmBinaryFile = (\[[^\n]+\])\.join\("\\n"\)/)[1])
      .join("\n")
      .split(",")[1],
    "base64",
  );
}
function uint(b, p) {
  let n = 0,
    s = 0;
  while (true) {
    const x = b[p++];
    n += (x & 127) * 2 ** s;
    if (!(x & 128)) return [n, p];
    s += 7;
  }
}
function sections(b) {
  let p = 8;
  const a = [];
  while (p < b.length) {
    const start = p,
      id = b[p++];
    let size;
    [size, p] = uint(b, p);
    const end = p + size;
    a.push({ id, bytes: b.subarray(start, end) });
    p = end;
  }
  return a;
}
test("copied HttpEngine fails closed on any upstream source or embedded Wasm change", () => {
  assert.equal(hash(source), OPAQUE_HTTPENGINE_SOURCE_SHA256);
  assert.equal(hash(wasm(source)), OPAQUE_HTTPENGINE_WASM_SHA256);
  assert.throws(() => adaptPinnedHttpEngine(source + "\n"), /hash/);
  const changed = wasm(source);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => addPinnedWebSocketSendExport(changed), /pin/);
});
test("copied Wasm adds exactly one existing function export and changes no instruction/data/type/import section bytes", () => {
  const original = wasm(source),
    adapted = wasm(adaptPinnedHttpEngine(source));
  const before = sections(original),
    after = sections(adapted);
  assert.equal(before.length, after.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(before[i].id, after[i].id);
    if (before[i].id !== 7) assert.deepEqual(before[i].bytes, after[i].bytes);
  }
  const originalExports = WebAssembly.Module.exports(
      new WebAssembly.Module(original),
    ),
    adaptedExports = WebAssembly.Module.exports(
      new WebAssembly.Module(adapted),
    );
  assert.deepEqual(
    adaptedExports.filter((e) => e.name !== "atlas_ws_send"),
    originalExports,
  );
  assert.deepEqual(
    adaptedExports.filter((e) => e.name === "atlas_ws_send"),
    [{ name: "atlas_ws_send", kind: "function" }],
  );
  assert.equal(
    hash(source),
    OPAQUE_HTTPENGINE_SOURCE_SHA256,
    "original remains byte-identical",
  );
});
