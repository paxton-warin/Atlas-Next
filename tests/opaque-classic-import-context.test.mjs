import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createPinnedOpaqueRewriter } from "../runtime/opaque-runtime-adapter.ts";
import { createOpaqueResourceGraph } from "../runtime/opaque-resource-graph.ts";
import { createOriginalDocumentPolicy } from "../runtime/original-document-policy.ts";
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
import { createFrontendResourceRewriter } from "../runtime/frontend-rewriter.ts";

function pinnedCore() {
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
    WebAssembly,
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
  vm.runInNewContext(
    fs.readFileSync("runtime/public/runtime/runtimekit.js", "utf8"),
    sandbox,
  );
  return sandbox.$runtimekit;
}
const core = pinnedCore(),
  wasm = fs.readFileSync("runtime/public/runtime/runtimekit.wasm");
function setup({
  maxResources,
  policies = ["script-src 'self' 'nonce-dGVzdA=='"],
  source = 'globalThis.later = () => import("https://peer.test/private.js")',
} = {}) {
  const calls = [],
    imported = [],
    maps = [];
  const get = function (name) {
    return this.attributes.get(name) ?? null;
  };
  const element = (tag, attrs = {}, text = "") => ({
    localName: tag,
    attributes: new Map(Object.entries(attrs)),
    textContent: text,
    getAttribute: get,
  });
  const graph = createOpaqueResourceGraph({
    documentURL: "https://site.test/path/page",
    originalPolicy: createOriginalDocumentPolicy({
      documentURL: "https://site.test/path/page",
      contentPolicies: policies,
    }),
    maxResources,
    rewriter: createPinnedOpaqueRewriter({
      core,
      wasm,
      documentURL: "https://site.test/path/page",
      prefix: "https://front.test/browse/logical/doc/",
    }),
    network: {
      async fetchResource(url, _init, metadata) {
        calls.push({ url, nonce: metadata.nonce });
        const response = new Response(
          url.includes("private.js") ? "export const value=1" : source,
          { headers: { "content-type": "application/javascript" } },
        );
        Object.defineProperties(response, {
          url: { value: url },
          type: { value: "basic" },
        });
        return response;
      },
    },
    document: {
      documentElement: element("html"),
      head: {},
      createElement: (tag) => element(tag),
    },
    natives: {
      DOMParser: class {},
      Blob,
      createObjectURL: URL.createObjectURL,
      revokeObjectURL: URL.revokeObjectURL,
      getAttribute: get,
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
      appendChild(node) {
        maps.push(node.textContent);
      },
      importModule(url) {
        imported.push(url);
        return Promise.resolve({ value: 1 });
      },
    },
  });
  const context = (source) =>
    source.match(
      /\$runtimekit\$import\("(atlas-script-context:[a-f0-9]{32})",/,
    )[1];
  const code = async (e) => (await fetch(e.attributes.get("src"))).text();
  return { graph, calls, imported, maps, element, context, code };
}
test("actual pinned ABI separates classic execution identity from logical relative resolution", () => {
  const rewriter = createPinnedOpaqueRewriter({
    core,
    wasm,
    documentURL: "https://site.test/path/page",
    prefix: "https://front.test/browse/logical/doc/",
  });
  const identity = "atlas-script-context:" + "a".repeat(32);
  const output = rewriter.javascript(
    'import("./private.js");globalThis.logical=location.origin',
    "https://site.test/redirected/code.js",
    false,
    identity,
  );
  assert.ok(
    output.includes('$runtimekit$import("' + identity + '","./private.js")'),
  );
  assert.match(output, /\$runtimekit\$wrap\(location\)/);
  for (const invalid of [
    "https://site.test/script.js",
    "atlas-script-context:bad",
  ])
    assert.throws(
      () => rewriter.javascript("", undefined, false, invalid),
      TypeError,
    );
  assert.throws(
    () => rewriter.javascript("", undefined, true, identity),
    TypeError,
  );
});
test("same URL, different nonce contexts never lend module-fetch authorization, even after module caching", async () => {
  const f = setup();
  try {
    const allowed = f.element("script", {
        src: "/path/shared.js",
        nonce: "dGVzdA==",
      }),
      denied = f.element("script", { src: "/path/shared.js" });
    await f.graph.prepareElement(allowed);
    await f.graph.prepareElement(denied);
    const a = f.context(await f.code(allowed)),
      b = f.context(await f.code(denied));
    assert.notEqual(a, b);
    await f.graph.importModule(a, "https://peer.test/private.js");
    await assert.rejects(
      f.graph.importModule(b, "https://peer.test/private.js"),
      (e) => e.code === "original_policy_denied",
    );
    assert.deepEqual(
      f.calls.filter((c) => c.url.includes("private.js")),
      [{ url: "https://peer.test/private.js", nonce: "dGVzdA==" }],
    );
    assert.equal(f.imported.length, 1);
    await assert.rejects(
      f.graph.importModule("atlas-script-context:" + "0".repeat(32), "./x.js"),
      { name: "SecurityError" },
    );
    f.graph.dispose();
    await assert.rejects(f.graph.importModule(a, "./x.js"), {
      name: "SecurityError",
    });
  } finally {
    f.graph.dispose();
  }
});
test("same URL and nonce still receive separate execution slots while raw response bytes are cached", async () => {
  const f = setup();
  try {
    const a = f.element("script", { src: "/same.js", nonce: "dGVzdA==" }),
      b = f.element("script", { src: "/same.js", nonce: "dGVzdA==" });
    await f.graph.prepareElement(a);
    await f.graph.prepareElement(b);
    assert.notEqual(f.context(await f.code(a)), f.context(await f.code(b)));
    assert.equal(f.calls.length, 1);
  } finally {
    f.graph.dispose();
  }
});
test("original inline classic bytes receive a context only after nonce authorization", async () => {
  const f = setup();
  try {
    const source =
        'globalThis.later=()=>import("https://peer.test/private.js")',
      allowed = f.element("script", { nonce: "dGVzdA==" }, source),
      denied = f.element("script", {}, source);
    await f.graph.prepareElement(allowed);
    await f.graph.prepareElement(denied);
    assert.equal(denied.textContent, "");
    assert.equal(
      denied.attributes.get("type"),
      "application/x-atlas-csp-blocked",
    );
    await f.graph.importModule(
      f.context(allowed.textContent),
      "https://peer.test/private.js",
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.graph.dispose();
  }
});
test("execution-context slots are bounded independently of a cached script URL", async () => {
  const f = setup({ maxResources: 2 });
  try {
    for (let n = 0; n < 2; n++)
      await f.graph.prepareElement(f.element("script", { src: "/same.js" }));
    await assert.rejects(
      f.graph.prepareElement(f.element("script", { src: "/same.js" })),
      { name: "QuotaExceededError" },
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.graph.dispose();
  }
});

test("IMG data bytes keep original src only when original image policy allows; no transport or module fallback", async () => {
  const url =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  for (const [policy, allowed] of [
    ["img-src data:", true],
    ["img-src 'none'", false],
  ]) {
    const f = setup({ policies: [policy] });
    try {
      const image = f.element("img", { src: url });
      await f.graph.prepareElement(image);
      assert.equal(image.attributes.get("src"), allowed ? url : undefined);
      assert.equal(f.calls.length, 0);
      assert.throws(() => f.graph.prepareModule(url), {
        name: "SecurityError",
      });
    } finally {
      f.graph.dispose();
    }
  }
});

test("trusted native preparer carries the exact per-request context and final redirect base without returning bodies", async () => {
  const context = "atlas-script-context:" + "a".repeat(32),
    bindings = [],
    uploads = [],
    calls = [];
  const transform = createFrontendResourceRewriter({
    core,
    wasm,
    documentId: "doc_" + "b".repeat(32),
    documentURL: "https://site.test/page",
    frontendOrigin: "https://front.test",
  });
  const preparer = createNativeResourcePreparer({
    documentId: "document-context-test",
    documentURL: "https://site.test/page",
    topLevelURL: "https://site.test/page",
    frontendOrigin: "https://front.test",
    contentPolicies: ["script-src https://assets.test/entry/ 'nonce-dGVzdA=='"],
    selectedIdentity: () => ({
      nodeId: "selected",
      resourceOrigin: "https://node.test",
      leaseHash: "c".repeat(64),
      generation: 1,
    }),
    fetch: async (req) => {
      calls.push(req.url);
      const redirect = req.url.endsWith("/entry/code.js");
      return {
        url: req.url,
        status: redirect ? 302 : 200,
        statusText: "OK",
        headers: [
          ["content-type", "application/javascript"],
          ...(redirect ? [["location", "/final/code.js"]] : []),
        ],
        body: new TextEncoder().encode(
          redirect ? "" : 'globalThis.later=()=>import("./private.js")',
        ).buffer,
      };
    },
    transform,
    upload: async (data) => {
      uploads.push(data);
      return "https://node.test/native-resource/v1/resource/" + "z".repeat(43);
    },
  });
  try {
    const url = await preparer.prepare(
      {
        url: "https://assets.test/entry/code.js",
        kind: "script",
        nonce: "dGVzdA==",
        scriptContext: context,
      },
      undefined,
      (b) => bindings.push(b),
    );
    assert.equal(typeof url, "string");
    assert.equal(uploads.length, 1);
    assert.deepEqual(bindings, [
      { identity: context, baseURL: "https://assets.test/final/code.js" },
    ]);
    assert.match(
      new TextDecoder().decode(uploads[0].body),
      new RegExp('\\$runtimekit\\$import\\("' + context + '",'),
    );
    for (const descriptor of [
      { kind: "image", scriptContext: context },
      { kind: "script", scriptContext: "https://assets.test/code.js" },
    ])
      await assert.rejects(
        preparer.prepare({ url: "https://assets.test/code.js", ...descriptor }),
        { code: "native_resource_invalid_descriptor" },
      );
    assert.equal(calls.length, 2);
  } finally {
    preparer.dispose();
  }
});
