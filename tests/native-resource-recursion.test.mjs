import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
const enc = new TextEncoder(),
  identity = {
    nodeId: "selected",
    resourceOrigin: "https://node.test",
    leaseHash: "a".repeat(64),
    generation: 1,
  };
function fixture(extra = {}) {
  const calls = [],
    uploads = [];
  let current = { ...identity };
  const prepare = createNativeResourcePreparer({
    documentId: "recursive_document_0123456789",
    documentURL: "https://site.test/page",
    topLevelURL: "https://site.test/page",
    frontendOrigin: "https://front.test",
    selectedIdentity: () => current,
    contentPolicies: [],
    fetch: async (req, context) => {
      calls.push({ req, context });
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers: [
          [
            "content-type",
            req.destination === "image" ? "image/png" : "text/css",
          ],
        ],
        body: enc.encode("body{}").buffer,
      };
    },
    upload: async (data) => {
      uploads.push(data);
      return (
        "https://node.test/native-resource/v1/resource/" +
        String(uploads.length).padStart(43, "a")
      );
    },
    ...extra,
  });
  return { prepare, calls, uploads, identity: (v) => (current = v) };
}
test("trusted recursion rechecks each destination and binds relative URL/referrer to parent final sheet", async () => {
  let s;
  s = fixture({
    transform: async (value) => {
      if (value.kind === "style" && value.url.endsWith("/root.css"))
        await value.prepareDependency({ url: "nested.css", kind: "style" });
      else if (value.kind === "style")
        await value.prepareDependency({
          url: "https://images.test/picture.png",
          kind: "image",
        });
      return value.body;
    },
  });
  await s.prepare.prepare({
    url: "https://styles.test/css/root.css",
    kind: "style",
  });
  assert.deepEqual(
    s.calls.map((v) => [v.req.url, v.req.destination, v.context.referrerURL]),
    [
      ["https://styles.test/css/root.css", "style", undefined],
      [
        "https://styles.test/css/nested.css",
        "style",
        "https://styles.test/css/root.css",
      ],
      [
        "https://images.test/picture.png",
        "image",
        "https://styles.test/css/nested.css",
      ],
    ],
  );
  assert.deepEqual(
    s.uploads.map((v) => v.kind),
    ["image", "style", "style"],
  );
  assert.equal(s.prepare.stats().totalResources, 3);
  s.prepare.dispose();
});
test("nested original CSP/CORP and SRI do not inherit parent nonce or bypass cross-origin constraints", async () => {
  const s = fixture({
    contentPolicies: ["style-src 'nonce-parent';img-src 'none'"],
    transform: async (value) => {
      await value.prepareDependency({
        url: "https://images.test/denied.png",
        kind: "image",
      });
      return value.body;
    },
  });
  await assert.rejects(
    s.prepare.prepare({
      url: "https://styles.test/root.css",
      kind: "style",
      nonce: "parent",
    }),
    { code: "native_resource_csp_denied" },
  );
  assert.equal(s.calls.length, 1);
  assert.equal(s.uploads.length, 0);
  const sri =
    "sha256-" + createHash("sha256").update("body{}").digest("base64");
  const t = fixture({
    transform: async (value) => {
      if (value.url.endsWith("root.css"))
        await value.prepareDependency({
          url: "https://images.test/denied.png",
          kind: "image",
          integrity: sri,
        });
      return value.body;
    },
  });
  await assert.rejects(
    t.prepare.prepare({ url: "https://styles.test/root.css", kind: "style" }),
    { code: "native_resource_integrity_requires_cors" },
  );
  assert.equal(t.uploads.length, 0);
});
test("stylesheet cycles, redirects to ancestor, depth and aggregate counters are bounded", async () => {
  let s;
  s = fixture({
    transform: async (value) => {
      await value.prepareDependency({
        url: value.url.endsWith("a.css") ? "b.css" : "a.css",
        kind: "style",
      });
      return value.body;
    },
  });
  await assert.rejects(
    s.prepare.prepare({ url: "https://styles.test/a.css", kind: "style" }),
    { code: "native_resource_dependency_cycle" },
  );
  assert.equal(s.calls.length, 2);
  assert.equal(s.uploads.length, 0);
  const d = fixture({
    transform: async (value) => {
      await value.prepareDependency({ url: value.url + "x", kind: "style" });
      return value.body;
    },
  });
  await assert.rejects(
    d.prepare.prepare({ url: "https://styles.test/deep", kind: "style" }),
    { code: "native_resource_dependency_depth_limit" },
  );
  assert.equal(d.calls.length, 8);
  const count = fixture({
    maxResources: 2,
    transform: async (value) => {
      await value.prepareDependency({ url: value.url + "x", kind: "style" });
      return value.body;
    },
  });
  await assert.rejects(
    count.prepare.prepare({ url: "https://styles.test/count", kind: "style" }),
    { code: "native_resource_count_limit" },
  );
  assert.equal(count.calls.length, 2);
});
test("nested operation shares parent cancellation and never publishes a canceled parent", async () => {
  let observed, begin;
  const started = new Promise((r) => (begin = r)),
    controller = new AbortController();
  const s = fixture({
    fetch: async (req, ctx) => {
      if (req.url.endsWith("/child")) {
        observed = ctx.signal;
        begin();
        return new Promise(() => {});
      }
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/css"]],
        body: enc.encode("body{}").buffer,
      };
    },
    transform: async (value) => {
      await value.prepareDependency({ url: "/child", kind: "style" });
      return value.body;
    },
  });
  const pending = s.prepare.prepare(
    { url: "https://styles.test/root", kind: "style" },
    controller.signal,
  );
  await started;
  controller.abort();
  await assert.rejects(pending, { code: "native_resource_aborted" });
  assert.equal(observed.aborted, true);
  assert.equal(s.uploads.length, 0);
  s.prepare.dispose();
});
test("same identity checks and dependency scope closure prevent stale or late requests", async () => {
  let dependency;
  const s = fixture({
    transform: async (value) => {
      dependency = value.prepareDependency;
      return value.body;
    },
  });
  await s.prepare.prepare({ url: "https://styles.test/root", kind: "style" });
  await assert.rejects(dependency({ url: "/late", kind: "image" }), {
    code: "native_resource_dependency_scope_closed",
  });
  assert.equal(s.calls.length, 1);
  let release, started;
  const waiting = new Promise((r) => (started = r));
  const t = fixture({
    fetch: async (req, ctx) => {
      if (req.url.endsWith("/child")) {
        started();
        await new Promise((r) => (release = r));
      }
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/css"]],
        body: enc.encode("body{}").buffer,
      };
    },
    transform: async (value) => {
      if (!value.url.endsWith("/child"))
        await value.prepareDependency({ url: "/child", kind: "style" });
      return value.body;
    },
  });
  const pending = t.prepare.prepare({
    url: "https://styles.test/root",
    kind: "style",
  });
  await waiting;
  t.identity({ ...identity, generation: 2 });
  release();
  await assert.rejects(pending, { code: "native_resource_assignment_changed" });
  assert.equal(t.uploads.length, 0);
});
test("parent stylesheet Referrer-Policy must be implemented before inherited dependency fetch", async () => {
  const s = fixture({
    fetch: async (req) => ({
      url: req.url,
      status: 200,
      statusText: "OK",
      headers: [
        ["content-type", "text/css"],
        ["referrer-policy", "no-referrer"],
      ],
      body: enc.encode("body{}").buffer,
    }),
    transform: async (value) => {
      await value.prepareDependency({ url: "/image", kind: "image" });
      return value.body;
    },
  });
  await assert.rejects(
    s.prepare.prepare({ url: "https://styles.test/root", kind: "style" }),
    { code: "native_resource_dependency_referrer_policy_required" },
  );
  assert.equal(s.uploads.length, 0);
});
test("a nested redirect to an ancestor is denied before fetching the ancestor again", async () => {
  const urls = [];
  const s = fixture({
    fetch: async (req) => {
      urls.push(req.url);
      return {
        url: req.url,
        status: req.url.endsWith("/b") ? 302 : 200,
        statusText: "OK",
        headers: req.url.endsWith("/b")
          ? [["location", "/a"]]
          : [["content-type", "text/css"]],
        body: enc.encode("body{}").buffer,
      };
    },
    transform: async (value) => {
      await value.prepareDependency({ url: "/b", kind: "style" });
      return value.body;
    },
  });
  await assert.rejects(
    s.prepare.prepare({ url: "https://styles.test/a", kind: "style" }),
    { code: "native_resource_dependency_cycle" },
  );
  assert.deepEqual(urls, ["https://styles.test/a", "https://styles.test/b"]);
  assert.equal(s.uploads.length, 0);
});
