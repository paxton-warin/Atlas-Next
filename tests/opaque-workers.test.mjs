import test from "node:test";
import assert from "node:assert/strict";
import { createOpaqueWorkerGraph } from "../runtime/opaque-workers.ts";
const documentURL = "https://worker.test/page";
const make = (resources, extra = {}) => {
  const calls = [];
  return {
    calls,
    graph: createOpaqueWorkerGraph({
      documentURL,
      network: {
        async fetch(url, options) {
          calls.push({ url, ...options });
          const source = resources[url];
          return {
            ok: source !== undefined,
            type: "basic",
            headers: new Headers({ "content-type": "application/javascript" }),
            arrayBuffer: async () =>
              new TextEncoder().encode(source ?? "").buffer,
          };
        },
      },
      rewriter: { javascript: (s) => s },
      ...extra,
    }),
  };
};
test("worker module graph uses same-origin entries and CORS-readable acyclic dependencies, not document import maps", async () => {
  const { graph, calls } = make({
    "https://worker.test/main.js":
      "import {value} from 'https://peer.test/dep.js';export default value;",
    "https://peer.test/dep.js": "export const value=42;",
  });
  const result = await graph.prepare("/main.js", "module", "omit");
  assert.match(result.entry, /^data:text\/javascript/);
  const root = decodeURIComponent(result.entry.split(",").slice(1).join(","));
  assert.ok(root.includes("data:text/javascript"));
  assert.equal(calls[0].mode, "same-origin");
  assert.equal(calls[1].mode, "cors");
  assert.equal(calls[1].credentials, "omit");
  await assert.rejects(graph.prepare("https://peer.test/dep.js", "module"), {
    name: "SecurityError",
  });
  graph.dispose();
});
test("worker module cycles and bare/attributed specifiers fail explicitly", async () => {
  for (const [resources, entry] of [
    [
      {
        "https://worker.test/a.js": "import './b.js'",
        "https://worker.test/b.js": "import './a.js'",
      },
      "/a.js",
    ],
    [{ "https://worker.test/a.js": "import 'bare-map-name'" }, "/a.js"],
    [
      {
        "https://worker.test/a.js":
          "import data from './data.json' with {type:'json'}",
      },
      "/a.js",
    ],
  ]) {
    const { graph } = make(resources);
    await assert.rejects(graph.prepare(entry, "module"), {
      name: "NotSupportedError",
    });
    graph.dispose();
  }
});
test("worker resource bodies must be broker-readable JavaScript", async () => {
  for (const reply of [
    {
      ok: true,
      type: "opaque",
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
    },
    {
      ok: true,
      type: "basic",
      headers: new Headers({ "content-type": "text/html" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    },
  ]) {
    const { graph } = make({}, { network: { fetch: async () => reply } });
    await assert.rejects(graph.prepare("/worker.js", "classic"), TypeError);
    graph.dispose();
  }
});
test("classic worker dependencies are explicitly preloaded; graph resource and byte budgets fail closed", async () => {
  const { graph, calls } = make({
    "https://worker.test/a.js": "let main=1;",
    "https://worker.test/dep.js": "let dependency=1;",
  });
  const result = await graph.prepare("/a.js", "classic", "include", [
    "./dep.js",
  ]);
  assert.deepEqual(
    result.imports.map(([url]) => url),
    ["https://worker.test/dep.js"],
  );
  assert.equal(calls[0].credentials, "same-origin");
  graph.dispose();
  const tiny = make(
    { "https://worker.test/a.js": "12345" },
    { maxBytes: 4 },
  ).graph;
  await assert.rejects(tiny.prepare("/a.js", "classic"), {
    name: "QuotaExceededError",
  });
  tiny.dispose();
  const limited = make(
    {
      "https://worker.test/a.js": "import './b.js'",
      "https://worker.test/b.js": "",
    },
    { maxResources: 1 },
  ).graph;
  await assert.rejects(limited.prepare("/a.js", "module"), {
    name: "QuotaExceededError",
  });
  limited.dispose();
});
test("worker graph disposal aborts pending broker fetch and invalid limits reject", async () => {
  let signal;
  const { graph } = make(
    {},
    {
      network: {
        fetch: async (_url, options) => {
          signal = options.signal;
          return await new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("disposed", "AbortError")),
              { once: true },
            ),
          );
        },
      },
    },
  );
  const pending = graph.prepare("/wait.js", "classic");
  await Promise.resolve();
  graph.dispose();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(signal.aborted, true);
  for (const limits of [
    { maxResources: 0 },
    { maxBytes: 0 },
    { maxResources: Infinity },
    { maxBytes: 1e10 },
  ])
    assert.throws(() => make({}, limits), TypeError);
});

test("worker bootstrap queue accounts for full typed-view backing buffers and File metadata", async () => {
  const { workerBootstrap } = await import("../runtime/opaque-workers.ts");
  const previous = globalThis.self;
  function run(value) {
    let receive,
      closed = false;
    globalThis.self = {
      addEventListener(_type, listener) {
        receive = listener;
      },
      removeEventListener() {},
      dispatchEvent() {},
      eval,
      importScripts() {},
      close() {
        closed = true;
      },
    };
    workerBootstrap();
    receive(new MessageEvent("message", { data: value }));
    return closed;
  }
  try {
    assert.equal(
      run(new Uint8Array(new ArrayBuffer(20 * 1024 * 1024), 0, 1)),
      true,
    );
    assert.equal(run(new Uint8Array(new ArrayBuffer(1024), 0, 1)), false);
    assert.equal(run(new File([], "n".repeat(9 * 1024 * 1024))), true);
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});

test("worker response compilation stricter than inherited parent native policy fails closed with a fixed code", async () => {
  const { assertWorkerCompilationCompatibility } = await import(
    "../runtime/opaque-workers.ts"
  );
  const { createOriginalDocumentPolicy } = await import(
    "../runtime/original-document-policy.ts"
  );
  const p = (csp) =>
    createOriginalDocumentPolicy({ documentURL, contentPolicies: [csp] });
  for (const [parent, worker] of [
    ["script-src 'self' 'unsafe-eval'", "script-src 'self'"],
    ["script-src 'self' 'wasm-unsafe-eval'", "script-src 'self'"],
  ])
    assert.throws(
      () => assertWorkerCompilationCompatibility(p(parent), p(worker)),
      {
        name: "NotSupportedError",
        code: "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
      },
    );
  assert.doesNotThrow(() =>
    assertWorkerCompilationCompatibility(
      p("script-src 'self'"),
      p("script-src 'self' 'unsafe-eval'"),
    ),
  );
  assert.throws(
    () =>
      assertWorkerCompilationCompatibility(
        p("script-src 'self';trusted-types site"),
        p("script-src 'self'"),
      ),
    { name: "NotSupportedError", code: "WORKER_TRUSTED_TYPES_UNSUPPORTED" },
  );
});
test("private entry is loaded once under worker-src while module dependencies use final URL and worker response script policy", async () => {
  const { createOriginalDocumentPolicy } = await import(
    "../runtime/original-document-policy.ts"
  );
  const calls = [],
    policy = createOriginalDocumentPolicy({
      documentURL: "https://worker.test/final/main.js",
      contentPolicies: ["script-src 'self';connect-src 'none'"],
    });
  const { graph } = make(
    {},
    {
      documentURL: "https://worker.test/final/main.js",
      entrySource: {
        url: "https://worker.test/final/main.js",
        source: "import './dep.js'",
        contentPolicies: policy.snapshot,
      },
      originalPolicy: policy,
      network: {
        async fetchResource(url, _init, metadata) {
          calls.push({ url, metadata });
          return {
            ok: true,
            type: "basic",
            url: "https://worker.test/final/dep.js",
            redirected: false,
            headers: new Headers({ "content-type": "application/javascript" }),
            arrayBuffer: async () =>
              new TextEncoder().encode("export default 1").buffer,
          };
        },
      },
    },
  );
  await graph.prepare("/final/main.js", "module");
  assert.deepEqual(calls, [
    {
      url: "https://worker.test/final/dep.js",
      metadata: { destination: "script", isModule: true },
    },
  ]);
  await assert.rejects(
    graph.importModule(documentURL, "https://peer.test/code.js"),
    { code: "original_policy_denied" },
  );
  assert.equal(calls.length, 1);
  graph.dispose();
  const tiny = make(
    {},
    {
      maxBytes: 1,
      entrySource: {
        url: "https://worker.test/main.js",
        source: "large private entry",
        contentPolicies: [],
      },
    },
  ).graph;
  await assert.rejects(tiny.prepare("/main.js", "classic"), {
    name: "QuotaExceededError",
  });
  tiny.dispose();
});
