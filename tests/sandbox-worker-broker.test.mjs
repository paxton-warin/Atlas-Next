import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { createSandboxWorkerBroker } from "../runtime/sandbox-worker-broker.ts";
import { createOriginalDocumentPolicy } from "../runtime/original-document-policy.ts";
import { SANDBOX_NETWORK_PROTOCOL } from "../runtime/sandbox-network.ts";
const parentId = "doc_" + "a".repeat(32),
  id = (n) => "worker_" + n.toString(16).padStart(48, "0");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (
  url,
  headers = [],
  source = "postMessage('worker')",
  status = 200,
) => ({
  url,
  status,
  statusText: "OK",
  headers: [["content-type", "text/javascript;charset=utf-8"], ...headers],
  body: new TextEncoder().encode(source).buffer,
});
function fixture(extra = {}) {
  const calls = [],
    messages = [];
  const broker = createSandboxWorkerBroker({
    documentId: parentId,
    documentURL: "https://site.test/page",
    frontendOrigin: "https://front.test",
    forbiddenOrigins: ["https://node.test"],
    factory: {},
    channel: () => new MessageChannel(),
    originalPolicy: createOriginalDocumentPolicy({
      documentURL: "https://site.test/page",
      contentPolicies: [
        "worker-src 'self';connect-src 'none';script-src 'self'",
      ],
    }),
    fetch: async (request, context) => {
      calls.push({ request, context });
      return response(request.url);
    },
    post: (message, ports) => messages.push({ message, ports }),
    ...extra,
  });
  return {
    broker,
    calls,
    messages,
    grant: (
      n = 1,
      url = "/worker.js",
      kind = "classic",
      credentials = "same-origin",
    ) => broker.grant({ workerId: id(n), url, kind, credentials }),
    close: () => broker.dispose(),
  };
}
function network(port, documentId, request) {
  return new Promise((resolve) => {
    port.on("message", resolve);
    port.postMessage({
      protocol: SANDBOX_NETWORK_PROTOCOL,
      documentId,
      sequence: 1,
      type: "fetch",
      request: {
        url: "/api",
        method: "GET",
        headers: [],
        mode: "same-origin",
        credentials: "same-origin",
        ...request,
      },
    });
  });
}
test("worker source bypasses parent connect denial only after worker-src; worker ports use response CSP and final URL", async () => {
  const f = fixture({
    fetch: async (request, context) => {
      f.calls.push({ request, context });
      if (request.url.endsWith("/worker.js"))
        return response(
          request.url,
          [["location", "/scripts/final.js"]],
          "",
          302,
        );
      return response(request.url, [
        ["content-security-policy", "connect-src 'self';script-src 'self'"],
      ]);
    },
  });
  try {
    const grant = await f.grant();
    assert.equal(grant.source.url, "https://site.test/scripts/final.js");
    assert.deepEqual(grant.source.contentPolicies, [
      "connect-src 'self';script-src 'self'",
    ]);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].request.destination, "worker");
    assert.equal(f.calls[0].request.credentials, "same-origin");
    const result = await network(grant.network, id(1), { url: "/api" });
    assert.equal(result.type, "response", JSON.stringify(result));
    assert.equal(
      f.calls.at(-1).context.documentURL,
      "https://site.test/scripts/final.js",
    );
    assert.equal(f.calls.at(-1).context.documentId, id(1));
    grant.dispose();
    assert.equal(f.broker.stats().workers, 0);
    assert.equal(f.broker.stats().retainedSourceBytes, 0);
  } finally {
    f.close();
  }
});
test("parent worker-src, logical same-origin and forbidden frontend/node URLs deny before transport", async () => {
  const f = fixture({
    originalPolicy: createOriginalDocumentPolicy({
      documentURL: "https://site.test/page",
      contentPolicies: ["worker-src 'none';connect-src *"],
    }),
  });
  try {
    for (const [i, url] of [
      "/worker.js",
      "https://peer.test/code.js",
      "https://front.test/api/admin",
      "https://node.test/code",
      "data:text/javascript,1",
      "https://u:p@site.test/code",
    ].entries())
      await assert.rejects(f.grant(i + 1, url));
    assert.equal(f.calls.length, 0);
    assert.equal(f.broker.stats().workers, 0);
  } finally {
    f.close();
  }
});
test("every worker redirect is authorized before transport; off-origin response cannot choose its authority", async () => {
  for (const destination of [
    "https://peer.test/worker.js",
    "https://front.test/api/admin",
    "http://site.test/insecure.js",
  ]) {
    const f = fixture({
      fetch: async (request) => {
        f.calls.push({ request });
        return response(request.url, [["location", destination]], "", 302);
      },
    });
    try {
      await assert.rejects(f.grant());
      assert.equal(f.calls.length, 1);
    } finally {
      f.close();
    }
  }
  const f = fixture({
    fetch: async (request) => response("https://peer.test/forged"),
  });
  try {
    await assert.rejects(
      f.grant(),
      (e) => e.code === "worker_source_invalid_response",
    );
  } finally {
    f.close();
  }
});
test("response connect-src denies worker network even when parent policy would allow it", async () => {
  const f = fixture({
    fetch: async (request) => {
      f.calls.push({ request });
      return response(request.url, [
        ["content-security-policy", "connect-src 'none'"],
      ]);
    },
  });
  try {
    const grant = await f.grant();
    const result = await network(grant.network, id(1), {});
    assert.equal(result.code, "original_policy_denied");
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});
test("source MIME, charset, raw cookie headers, ambiguous redirects and unsupported policy are rejected before granting ports", async () => {
  const variants = [
    (r) => ({ ...response(r.url), headers: [["content-type", "text/html"]] }),
    (r) => ({
      ...response(r.url),
      headers: [["content-type", "text/javascript;charset=windows-1252"]],
    }),
    (r) => response(r.url, [["set-cookie", "secret=DO_NOT_FORWARD"]]),
    (r) =>
      response(
        r.url,
        [
          ["location", "/a"],
          ["location", "/b"],
        ],
        "",
        302,
      ),
    (r) =>
      response(r.url, [["content-security-policy", "sandbox allow-scripts"]]),
  ];
  for (const variant of variants) {
    const f = fixture({ fetch: async (r) => variant(r) });
    try {
      await assert.rejects(f.grant());
      assert.equal(f.broker.stats().workers, 0);
      assert.equal(f.messages.length, 0);
    } finally {
      f.close();
    }
  }
});
test("module worker source respects omit credentials; classic constructor credentials are native same-origin", async () => {
  const f = fixture();
  try {
    const a = await f.grant(1, "/a.js", "module", "omit"),
      b = await f.grant(2, "/b.js", "classic", "omit");
    assert.deepEqual(
      f.calls.map((x) => x.request.credentials),
      ["omit", "same-origin"],
    );
    a.dispose();
    b.dispose();
  } finally {
    f.close();
  }
});
test("strict private protocol rejects extra fields, replay/order, foreign parent and transferred ports", async () => {
  const f = fixture();
  const create = {
    protocol: 2,
    documentId: parentId,
    type: "worker-create",
    requestId: 1,
    workerId: id(1),
    url: "/worker.js",
    kind: "classic",
    credentials: "same-origin",
  };
  try {
    for (const m of [
      { ...create, namespace: "atlas-admin" },
      { ...create, requestId: 2 },
      { ...create, documentId: parentId + "x" },
    ])
      assert.equal(f.broker.receive(m), true);
    f.broker.receive(create, 1);
    await pause(5);
    assert.equal(f.calls.length, 0);
    f.broker.receive(create);
    await pause(10);
    assert.equal(f.calls.length, 1);
    assert.equal(f.messages[0].message.ok, true);
    assert.equal(f.messages[0].ports.length, 2);
    f.broker.receive(create);
    await pause(5);
    assert.equal(f.calls.length, 1);
    f.broker.receive({
      protocol: 2,
      documentId: parentId,
      type: "worker-release",
      workerId: id(1),
    });
    assert.equal(f.broker.stats().workers, 0);
  } finally {
    f.close();
  }
});
test("wire failure uses fixed enum only and never exception text or source URL", async () => {
  const f = fixture({
    fetch: async () => {
      throw Error("SECRET_COOKIE https://secret.test/path?token=PRIVATE");
    },
  });
  try {
    f.broker.receive({
      protocol: 2,
      documentId: parentId,
      type: "worker-create",
      requestId: 1,
      workerId: id(1),
      url: "/worker.js",
      kind: "classic",
      credentials: "same-origin",
    });
    await pause(10);
    assert.deepEqual(f.messages, [
      {
        message: {
          protocol: 2,
          documentId: parentId,
          type: "worker-grant",
          requestId: 1,
          workerId: id(1),
          ok: false,
          code: "WORKER_SOURCE_FAILED",
        },
        ports: [],
      },
    ]);
    assert.equal(f.broker.stats().workers, 0);
  } finally {
    f.close();
  }
});
test("timeouts retain ignored-cancellation slots until actual transport settles; parent disposal revokes and rejects late grants", async () => {
  let resolve;
  const f = fixture({
    timeoutMs: 5,
    fetch: () => new Promise((r) => (resolve = r)),
  });
  try {
    await assert.rejects(f.grant(), (e) => e.code === "worker_source_timeout");
    assert.equal(f.broker.stats().workers, 1);
    resolve(response("https://site.test/worker.js"));
    await pause(5);
    assert.equal(f.broker.stats().workers, 0);
    const pending = f.grant(2);
    f.close();
    resolve(response("https://site.test/worker.js"));
    await assert.rejects(pending);
    assert.equal(f.broker.stats().workers, 0);
  } finally {
    f.close();
  }
});
test("parent worker count is bounded and release/disposal close exact worker grants", async () => {
  const f = fixture();
  try {
    const grants = [];
    for (let n = 1; n <= 16; n++) grants.push(await f.grant(n));
    assert.equal(f.broker.stats().workers, 16);
    await assert.rejects(f.grant(17), (e) => e.code === "worker_grant_denied");
    assert.equal(f.calls.length, 16);
    grants[5].dispose();
    assert.equal(f.broker.stats().workers, 15);
    const replacement = await f.grant(17);
    assert.equal(f.broker.stats().workers, 16);
    replacement.dispose();
    f.close();
    assert.deepEqual(f.broker.stats(), {
      live: false,
      workers: 0,
      retainedSourceBytes: 0,
    });
  } finally {
    f.close();
  }
});
test("trusted grant rejects stricter worker compilation and Trusted Types before ports/source can enter a website realm", async () => {
  for (const [parent, responsePolicy, expected] of [
    [
      "worker-src 'self';script-src 'unsafe-eval'",
      "script-src 'self'",
      "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
    ],
    [
      "worker-src 'self';script-src 'wasm-unsafe-eval'",
      "script-src 'self'",
      "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
    ],
    [
      "worker-src 'self'",
      "require-trusted-types-for 'script'",
      "WORKER_TRUSTED_TYPES_UNSUPPORTED",
    ],
    [
      "worker-src 'self';trusted-types private",
      "",
      "WORKER_TRUSTED_TYPES_UNSUPPORTED",
    ],
  ]) {
    const f = fixture({
      originalPolicy: createOriginalDocumentPolicy({
        documentURL: "https://site.test/page",
        contentPolicies: [parent],
      }),
      fetch: async (r) =>
        response(r.url, [["content-security-policy", responsePolicy]]),
    });
    try {
      await assert.rejects(f.grant(), (e) => e.code === expected);
      assert.equal(f.broker.stats().workers, 0);
      f.broker.receive({
        protocol: 2,
        documentId: parentId,
        type: "worker-create",
        requestId: 1,
        workerId: id(2),
        url: "/worker.js",
        kind: "classic",
        credentials: "same-origin",
      });
      await pause(5);
      assert.equal(f.messages[0].message.code, expected);
      assert.equal(f.messages[0].ports.length, 0);
    } finally {
      f.close();
    }
  }
});
