/** Exact-pin adaptation of a trusted worker COPY only. The original vendor
 * stays byte-identical; embedded Wasm gains one export of an existing function,
 * with every executable instruction/data section unchanged. No child authority.
 */
import { createHash } from "node:crypto";
import { OPAQUE_HTTPENGINE_SOURCE_SHA256 } from "../server/runtime-capabilities.mjs";
export { OPAQUE_HTTPENGINE_SOURCE_SHA256 };
export const OPAQUE_HTTPENGINE_WASM_SHA256 =
  "fe42bbcbd90b06c020ee4e0f11b86e8a671bfbb8fea3ee27200b116b7286dea9";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function uint(n) {
  const a = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    a.push(b);
  } while (n);
  return Buffer.from(a);
}
function read(bytes, p) {
  let n = 0,
    s = 0;
  for (let i = 0; i < 5; i++) {
    const b = bytes[p++];
    if (b === undefined) throw Error("Truncated Wasm");
    n += (b & 127) * 2 ** s;
    if (!(b & 128)) return [n, p];
    s += 7;
  }
  throw Error("Oversized Wasm integer");
}
/** Existing optimized curl_ws_send is function700:49 imports + definition651.
 * Its five-i32 inputs are handle,buffer,length,sentPtr,flags, result CURLcode.
 * Exact Wasm pin and native validation protect this reviewed fixed-index seam.
 */
export function addPinnedWebSocketSendExport(bytes) {
  if (hash(bytes) !== OPAQUE_HTTPENGINE_WASM_SHA256)
    throw Error("Opaque HttpEngine Wasm pin mismatch");
  const chunks = [bytes.subarray(0, 8)];
  let p = 8,
    changed = 0;
  while (p < bytes.length) {
    const start = p,
      id = bytes[p++];
    let size;
    [size, p] = read(bytes, p);
    const end = p + size;
    if (end > bytes.length) throw Error("Truncated Wasm section");
    if (id === 7) {
      let count, after;
      [count, after] = read(bytes, p);
      const name = Buffer.from("atlas_ws_send"),
        entry = Buffer.concat([
          uint(name.length),
          name,
          Buffer.from([0]),
          uint(700),
        ]),
        payload = Buffer.concat([
          uint(count + 1),
          bytes.subarray(after, end),
          entry,
        ]);
      chunks.push(
        Buffer.concat([Buffer.from([7]), uint(payload.length), payload]),
      );
      changed++;
    } else chunks.push(bytes.subarray(start, end));
    p = end;
  }
  if (changed !== 1) throw Error("Opaque HttpEngine export seam is not unique");
  const result = Buffer.concat(chunks);
  new WebAssembly.Module(result);
  return result;
}
export function adaptPinnedHttpEngine(source) {
  if (hash(source) !== OPAQUE_HTTPENGINE_SOURCE_SHA256)
    throw Error(
      "Opaque HttpEngine source hash does not match the inspected pin.",
    );
  const edits = [
    [
      "} else if (result_code === 0 && result_closed) {\n        this.cleanup();\n      } else if (result_code !== 81)",
      `} else if (result_code === 0 && result_closed) {
        let size = _get_result_size(result_ptr);
        if (typeof this.__atlasOnCloseFrame === "function") {
          this.__atlasOnCloseFrame(size >= 0 && size <= 125
            ? new Uint8Array(Module.HEAPU8.subarray(data_ptr, data_ptr + size))
            : null);
        }
        this.cleanup();
      } else if (result_code !== 81)`,
    ],
    [
      "  class FakeWebSocket extends EventTarget {",
      `  // Trusted-worker-only bridge to the existing curl_ws_send implementation.
  Object.defineProperty(CurlWebSocket.prototype, "__atlasSendClose", {
    value(bytes) {
      if (!this.connected || !(bytes instanceof Uint8Array) || bytes.length > 125) throw Error("Invalid WebSocket close");
      const ptr = allocate_array(bytes), sent = _malloc(4);
      try {
        Module.HEAPU32[sent >>> 2] = 0;
        const code = Module.asm.atlas_ws_send(this.http_handle, ptr, bytes.length, sent, 8);
        return {code, sent: Module.HEAPU32[sent >>> 2]};
      } finally { _free(ptr); _free(sent); }
    }
  });
  class FakeWebSocket extends EventTarget {`,
    ],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2)
      throw Error("Opaque HttpEngine seam is not unique.");
    source = source.replace(before, after);
  }
  const embedded = /wasmBinaryFile = (\[[^\n]+\])\.join\("\\n"\)/g,
    matches = [...source.matchAll(embedded)];
  if (matches.length !== 1)
    throw Error("Opaque HttpEngine Wasm source seam is not unique");
  const match = matches[0],
    data = JSON.parse(match[1]).join("\n");
  if (!data.startsWith("data:application/octet-stream;base64,"))
    throw Error("Unexpected HttpEngine Wasm encoding");
  const patched = addPinnedWebSocketSendExport(
    Buffer.from(data.split(",")[1], "base64"),
  );
  source = source.replace(
    match[0],
    "wasmBinaryFile = " +
      JSON.stringify([
        "data:application/octet-stream;base64," + patched.toString("base64"),
      ]) +
      '.join("\\n")',
  );
  return source;
}
