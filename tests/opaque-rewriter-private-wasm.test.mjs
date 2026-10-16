import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  adaptPinnedRuntimeBundle,
  OPAQUE_CORE_SOURCE_HASH,
} from "../scripts/opaque-runtime-core.mjs";
import { createHash } from "node:crypto";
import { createPinnedOpaqueRewriter } from "../runtime/opaque-runtime-adapter.ts";
const source = fs.readFileSync("runtime/public/runtime/runtimekit.js", "utf8"),
  bytes = fs.readFileSync("runtime/public/runtime/runtimekit.wasm");
test("only the exact inspected copied pin receives three unique private module-cache seams", () => {
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    OPAQUE_CORE_SOURCE_HASH,
  );
  for (const token of [
    "3430(e,t,r){let i;",
    "function A(e){i=e instanceof Uint8Array?e:new Uint8Array(e)}",
    "(0,n.QR)({module:new WebAssembly.Module(i)});",
  ])
    assert.equal(source.split(token).length, 2);
  const adapted = adaptPinnedRuntimeBundle(source);
  assert.equal(adapted.split("opaqueCompiledRewriterModule??=").length, 2);
  assert.equal(adapted.includes("self.opaqueCompiledRewriterModule"), false);
  assert.throws(() => adaptPinnedRuntimeBundle(source + "\n"), /hash/);
  assert.throws(() => adaptPinnedRuntimeBundle(adapted), /hash/);
});
test("trusted pre-site rewrite compiles once; later rewrites do not borrow website Wasm compilation permission", () => {
  let compilingAllowed = true,
    compilations = 0;
  const wasmAPI = Object.create(WebAssembly);
  const Module = new Proxy(WebAssembly.Module, {
    construct(target, args) {
      compilations++;
      if (!compilingAllowed)
        throw new WebAssembly.CompileError(
          "native compilation denied by original CSP",
        );
      return Reflect.construct(target, args);
    },
  });
  Object.defineProperty(wasmAPI, "Module", { value: Module });
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance,
    Uint8Array,
    ArrayBuffer,
    Blob,
    atob,
    btoa,
    WebAssembly: wasmAPI,
    Headers,
    Request,
    Response,
    crypto,
    setTimeout,
    clearTimeout,
    MessageChannel,
    WebSocket,
    EventTarget,
    Event,
    MessageEvent,
    ReadableStream,
    WritableStream,
    TransformStream,
    fetch,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(adaptPinnedRuntimeBundle(source), sandbox);
  const rewriter = createPinnedOpaqueRewriter({
    core: sandbox.$runtimekit,
    wasm: bytes,
    documentURL: "https://site.test/page",
    prefix: "https://front.test/browse/logical/doc/",
  });
  assert.match(
    rewriter.javascript("window.initial=location.origin"),
    /runtimekit/,
  );
  assert.equal(compilations, 1);
  compilingAllowed = false;
  assert.match(
    rewriter.module(
      "export const later=location.origin",
      "https://site.test/later.js",
    ).source,
    /runtimekit/,
  );
  // Real boot creates another rewriter and calls setWasm with the same pin.
  const boot = createPinnedOpaqueRewriter({
    core: sandbox.$runtimekit,
    wasm: bytes,
    documentURL: "https://site.test/page",
    prefix: "https://front.test/browse/logical/doc/",
  });
  boot.javascript("window.second=1");
  assert.equal(compilations, 1);
  assert.throws(() => new wasmAPI.Module(bytes), { name: "CompileError" });
  assert.equal(Object.hasOwn(sandbox, "opaqueCompiledRewriterModule"), false);
});
