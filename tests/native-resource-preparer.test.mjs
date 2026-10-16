import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
import { createSandboxRelayFetch } from "../runtime/sandbox-relay.ts";
const text = new TextEncoder(),
  source = text.encode("body { color:red }"),
  png = new Uint8Array([137, 80, 78, 71]);
const selected = {
  nodeId: "selected-4",
  resourceOrigin: "https://selected.test",
  leaseHash: "a".repeat(64),
  generation: 1,
};
const native =
  "https://selected.test/native-resource/v1/resource/" + "a".repeat(43);
const response = (
  url,
  body = source,
  headers = [["content-type", "text/css"]],
  status = 200,
) => ({ url, status, statusText: "OK", headers, body: body.slice().buffer });
function setup(overrides = {}) {
  const calls = [],
    uploads = [];
  let current = { ...selected };
  const options = {
    documentId: "document-test-123456",
    documentURL: "https://website.test/path/index.html",
    topLevelURL: "https://website.test/",
    frontendOrigin: "https://front.test",
    forbiddenOrigins: ["https://other-node.test"],
    contentPolicies: [],
    selectedIdentity: () => current,
    fetch: async (req, ctx) => {
      calls.push({ req, ctx });
      return response(req.url);
    },
    transform: async (resource) => resource.body,
    upload: async (value, identity) => {
      uploads.push({ value, identity });
      return native;
    },
    ...overrides,
  };
  const preparer = createNativeResourcePreparer(options);
  return { preparer, calls, uploads, setIdentity: (v) => (current = v) };
}
test("trusted relay cookie adapter receives fixed document authority and commits Set-Cookie before native upload", async () => {
  const sequence = [],
    upstream = [];
  const relay = {
    assignment: { origin: "https://selected.test" },
    request: async (req) => {
      upstream.push(req);
      return response(req.url, png, [
        ["content-type", "image/png"],
        ["set-cookie", "private=updated; HttpOnly; Secure"],
      ]);
    },
  };
  const fetch = createSandboxRelayFetch({
    documentId: "document-test-123456",
    documentURL: "https://website.test/path/index.html",
    topLevelURL: "https://website.test/",
    frontendOrigin: "https://front.test",
    relay,
    cookies: {
      getRequestHeader: async (ctx) => {
        sequence.push(["get", ctx]);
        return "private=secret";
      },
      storeResponseCookies: async (values, ctx) => {
        await new Promise((r) => setTimeout(r, 1));
        sequence.push(["commit", ctx, values]);
      },
    },
  });
  const s = setup({
    fetch,
    upload: async (value) => {
      sequence.push(["upload", value]);
      return native;
    },
  });
  assert.equal(
    await s.preparer.prepare({
      url: "https://private.test/image.png",
      kind: "image",
    }),
    native,
  );
  assert.deepEqual(upstream[0].headers, [
    ["referer", "https://website.test/"],
    ["cookie", "private=secret"],
  ]);
  assert.equal(
    sequence[0][1].documentURL,
    "https://website.test/path/index.html",
  );
  assert.equal(sequence[1][0], "commit");
  assert.equal(sequence[2][0], "upload");
  assert.equal(sequence[2][1].body.length, 4);
  assert.equal(Object.hasOwn(sequence[2][1], "headers"), false);
});
test("returns only native URL; upload gets private bytes after original policy checks", async () => {
  const s = setup();
  const result = await s.preparer.prepare({ url: "/site.css", kind: "style" });
  assert.equal(result, native);
  assert.equal(
    s.calls[0].ctx.documentURL,
    "https://website.test/path/index.html",
  );
  assert.equal(s.calls[0].req.credentials, "include");
  assert.equal(s.calls[0].req.mode, "no-cors");
  assert.equal(s.uploads[0].value.documentId, "document-test-123456");
  assert.deepEqual(s.uploads[0].value.policy, {
    originalAllowed: true,
    mixedContentChecked: true,
    integrityChecked: true,
    contentPolicyChecked: true,
  });
});
test("child claims cannot replace document or transport authority", async () => {
  const s = setup();
  for (const value of [
    { url: "https://front.test/a", kind: "image" },
    { url: "https://selected.test/a", kind: "image" },
    { url: "https://other-node.test/a", kind: "image" },
    { url: "http://website.test/a", kind: "image" },
    { url: "https://user:password@website.test/a", kind: "image" },
    { url: "/a", kind: "document" },
    { url: "/a", kind: "image", documentURL: "https://attacker.test/" },
  ])
    await assert.rejects(s.preparer.prepare(value));
  assert.equal(s.calls.length, 0);
});
test("original CSP directives intersect; first duplicate wins and default-src falls back", async () => {
  for (const [contentPolicies, url, pass] of [
    [["default-src 'none'"], "/site.css", false],
    [["default-src 'self'"], "/site.css", true],
    [["style-src https:;style-src 'none'"], "https://cdn.test/site.css", true],
    [
      ["style-src https:", "style-src 'self'"],
      "https://cdn.test/site.css",
      false,
    ],
    [
      ["style-src 'none' https://cdn.test/a/"],
      "https://cdn.test/a/site.css",
      true,
    ],
    [["style-src https://cdn.test/a/"], "https://cdn.test/ab/site.css", false],
  ]) {
    const s = setup({ contentPolicies });
    if (pass)
      assert.equal(await s.preparer.prepare({ url, kind: "style" }), native);
    else
      await assert.rejects(s.preparer.prepare({ url, kind: "style" }), {
        code: "native_resource_csp_denied",
      });
  }
});
test("CSP nonce/strict-dynamic never falls back to host allowlist without initiator proof", async () => {
  const s = setup({
    contentPolicies: ["script-src 'nonce-secret' 'strict-dynamic' https:"],
    fetch: async (req) =>
      response(req.url, source, [["content-type", "text/javascript"]]),
  });
  await assert.rejects(
    s.preparer.prepare({ url: "https://cdn.test/a.js", kind: "script" }),
    { code: "native_resource_csp_initiator_required" },
  );
  assert.equal(
    await s.preparer.prepare({
      url: "https://cdn.test/a.js",
      kind: "script",
      nonce: "secret",
    }),
    native,
  );
  const sandbox = setup({
    contentPolicies: ["sandbox allow-forms;script-src https:"],
  });
  await assert.rejects(
    sandbox.preparer.prepare({ url: "/a.js", kind: "script" }),
    { code: "native_resource_csp_denied" },
  );
});
test("CSP path matching decodes individual segments; redirected paths follow CSP redirect rules", async () => {
  const s = setup({
    contentPolicies: ["style-src https://cdn.test/allowed/"],
    fetch: async (req) =>
      response(
        req.url,
        source,
        req.url.endsWith("/start")
          ? [
              ["location", "/elsewhere/final"],
              ["content-type", "text/css"],
            ]
          : [["content-type", "text/css"]],
        req.url.endsWith("/start") ? 302 : 200,
      ),
  });
  assert.equal(
    await s.preparer.prepare({
      url: "https://cdn.test/allowed/start",
      kind: "style",
    }),
    native,
  );
  assert.equal(
    s.uploads[0].value.sourceURL,
    "https://cdn.test/elsewhere/final",
  );
  const p = setup({ contentPolicies: ["style-src https://cdn.test/a%2Fb/"] });
  assert.equal(
    await p.preparer.prepare({
      url: "https://cdn.test/a%2Fb/c",
      kind: "style",
    }),
    native,
  );
  await assert.rejects(
    p.preparer.prepare({ url: "https://cdn.test/a/b/c", kind: "style" }),
  );
});
test("CORS is checked before every redirect with permanent null Origin taint", async () => {
  const seen = [];
  const s = setup({
    fetch: async (req, ctx) => {
      seen.push({ req, ctx });
      if (req.url === "https://b.test/start")
        return response(
          req.url,
          source,
          [
            ["location", "https://c.test/final"],
            ["access-control-allow-origin", "https://website.test"],
          ],
          302,
        );
      return response(req.url, source, [
        ["content-type", "text/css"],
        ["access-control-allow-origin", "null"],
      ]);
    },
  });
  assert.equal(
    await s.preparer.prepare({
      url: "https://b.test/start",
      kind: "style",
      crossOrigin: "anonymous",
    }),
    native,
  );
  assert.deepEqual(
    seen.map((v) => [v.ctx.requestOrigin, v.req.credentials]),
    [
      ["https://website.test", "omit"],
      ["null", "omit"],
    ],
  );
  const denied = setup({
    fetch: async (req) =>
      response(
        req.url,
        source,
        [
          ["location", "https://c.test/"],
          ["content-type", "text/css"],
        ],
        302,
      ),
  });
  await assert.rejects(
    denied.preparer.prepare({
      url: "https://b.test/start",
      kind: "style",
      crossOrigin: "anonymous",
    }),
    { code: "native_resource_cors_denied" },
  );
  assert.equal(denied.uploads.length, 0);
});
test("credentialed CORS refuses wildcard and requires ACAC", async () => {
  for (const headers of [
    [
      ["access-control-allow-origin", "*"],
      ["access-control-allow-credentials", "true"],
    ],
    [["access-control-allow-origin", "https://website.test"]],
  ]) {
    const s = setup({
      fetch: async (req) =>
        response(req.url, source, [["content-type", "text/css"], ...headers]),
    });
    await assert.rejects(
      s.preparer.prepare({
        url: "https://cdn.test/a",
        kind: "style",
        crossOrigin: "use-credentials",
      }),
      { code: "native_resource_cors_denied" },
    );
  }
  const s = setup({
    fetch: async (req) =>
      response(req.url, source, [
        ["content-type", "text/css"],
        ["access-control-allow-origin", "https://website.test"],
        ["access-control-allow-credentials", "true"],
      ]),
  });
  assert.equal(
    await s.preparer.prepare({
      url: "https://cdn.test/a",
      kind: "style",
      crossOrigin: "use-credentials",
    }),
    native,
  );
});
test("CORP and COEP obey logical origin/site rather than physical frontend origin", async () => {
  for (const [url, corp, coep, pass] of [
    ["https://other.test/a", "same-origin", "unsafe-none", false],
    ["https://sub.website.test/a", "same-site", "unsafe-none", true],
    ["https://other.test/a", "same-site", "unsafe-none", false],
    ["https://other.test/a", "cross-origin", "require-corp", true],
    ["https://other.test/a", null, "require-corp", false],
    ["https://other.test/a", null, "credentialless", true],
  ]) {
    const s = setup({
      coep,
      fetch: async (req) =>
        response(req.url, source, [
          ["content-type", "text/css"],
          ...(corp ? [["cross-origin-resource-policy", corp]] : []),
        ]),
    });
    if (pass)
      assert.equal(await s.preparer.prepare({ url, kind: "style" }), native);
    else
      await assert.rejects(s.preparer.prepare({ url, kind: "style" }), {
        code: "native_resource_corp_denied",
      });
  }
  const privatePSL = setup({
    documentURL: "https://one.github.io/",
    topLevelURL: "https://one.github.io/",
    fetch: async (req) =>
      response(req.url, source, [
        ["content-type", "text/css"],
        ["cross-origin-resource-policy", "same-site"],
      ]),
  });
  await assert.rejects(
    privatePSL.preparer.prepare({
      url: "https://two.github.io/a",
      kind: "style",
    }),
    { code: "native_resource_corp_denied" },
  );
});
test("SRI hashes original bytes before trusted transform; opaque SRI does not grant readability", async () => {
  const integrity =
    "sha384-" + createHash("sha384").update(source).digest("base64");
  const s = setup({ transform: async () => text.encode("/* transformed */") });
  assert.equal(
    await s.preparer.prepare({ url: "/a.css", kind: "style", integrity }),
    native,
  );
  assert.equal(
    new TextDecoder().decode(s.uploads[0].value.body),
    "/* transformed */",
  );
  await assert.rejects(
    s.preparer.prepare({
      url: "/a.css",
      kind: "style",
      integrity: "sha384-invalid",
    }),
    { name: "SecurityError" },
  );
  const opaque = setup();
  await assert.rejects(
    opaque.preparer.prepare({
      url: "https://other.test/a.css",
      kind: "style",
      integrity,
    }),
    { code: "native_resource_integrity_requires_cors" },
  );
  assert.equal(opaque.uploads.length, 0);
});
test("MIME, HTTP failures, automatic redirects, and raw Set-Cookie fail closed", async () => {
  for (const tweak of [
    { status: 404 },
    { status: 204 },
    { headers: [["content-type", "text/html"]] },
    { redirected: true },
    {
      headers: [
        ["content-type", "text/css"],
        ["set-cookie", "secret=value"],
      ],
    },
    { url: "https://other.test/final" },
  ]) {
    const s = setup({
      fetch: async (req) => ({ ...response(req.url), ...tweak }),
    });
    await assert.rejects(s.preparer.prepare({ url: "/a.css", kind: "style" }));
    assert.equal(s.uploads.length, 0);
  }
});
test("executable, CSS, and SVG require trusted transformation before publication", async () => {
  for (const [kind, mime] of [
    ["script", "text/javascript"],
    ["style", "text/css"],
    ["image", "image/svg+xml"],
  ]) {
    const s = setup({
      transform: undefined,
      fetch: async (req) => response(req.url, source, [["content-type", mime]]),
    });
    await assert.rejects(s.preparer.prepare({ url: "/resource", kind }), {
      code: "native_resource_transform_required",
    });
  }
});
test("same selected identity remains pinned across fetch and upload, including generation", async () => {
  const s = setup({
    fetch: async (req) => {
      s.setIdentity({ ...selected, generation: 2 });
      return response(req.url);
    },
  });
  await assert.rejects(s.preparer.prepare({ url: "/a.css", kind: "style" }), {
    code: "native_resource_assignment_changed",
  });
  assert.equal(s.uploads.length, 0);
  const other = setup({
    upload: async () =>
      "https://other-node.test/native-resource/v1/resource/" + "a".repeat(43),
  });
  await assert.rejects(
    other.preparer.prepare({ url: "/a.css", kind: "style" }),
    { code: "native_resource_wrong_selected_node" },
  );
});
test("body, aggregate, redirect and request-count budgets fail without publishing excess bytes", async () => {
  const s = setup({ maxBodyBytes: 4 });
  await assert.rejects(s.preparer.prepare({ url: "/a.css", kind: "style" }), {
    code: "native_resource_invalid_response",
  });
  const total = setup({ maxTotalBytes: source.length });
  await total.preparer.prepare({ url: "/a.css", kind: "style" });
  await assert.rejects(
    total.preparer.prepare({ url: "/b.css", kind: "style" }),
    { code: "native_resource_byte_limit" },
  );
  const count = setup({ maxResources: 1 });
  await count.preparer.prepare({ url: "/a.css", kind: "style" });
  await assert.rejects(
    count.preparer.prepare({ url: "/b.css", kind: "style" }),
    { code: "native_resource_count_limit" },
  );
  const redirect = setup({
    fetch: async (req) =>
      response(req.url, new Uint8Array(), [["location", "/again"]], 302),
  });
  await assert.rejects(
    redirect.preparer.prepare({ url: "/a.css", kind: "style" }),
    { code: "native_resource_redirect_limit" },
  );
});
test("deadline disposes document authority; caller cancellation retains bounded orphan slots", async () => {
  const timeout = setup({ timeoutMs: 10, fetch: () => new Promise(() => {}) });
  await assert.rejects(
    timeout.preparer.prepare({ url: "/a.css", kind: "style" }),
    { code: "native_resource_timeout" },
  );
  assert.equal(timeout.preparer.stats().live, false);
  const blocked = setup({ fetch: () => new Promise(() => {}) });
  for (let i = 0; i < 4; i++) {
    const signal = new AbortController();
    const task = blocked.preparer.prepare(
      { url: "/a.css", kind: "style" },
      signal.signal,
    );
    signal.abort();
    await assert.rejects(task, { code: "native_resource_aborted" });
  }
  assert.equal(blocked.preparer.stats().pending, 4);
  await assert.rejects(
    blocked.preparer.prepare({ url: "/next.css", kind: "style" }),
    { code: "native_resource_count_limit" },
  );
  blocked.preparer.dispose();
});
