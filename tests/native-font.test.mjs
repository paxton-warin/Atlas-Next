import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
const encoder = new TextEncoder(),
  font = encoder.encode("deterministic-font-snapshot");
const selected = {
  nodeId: "selected",
  resourceOrigin: "https://node.test",
  leaseHash: "a".repeat(64),
  generation: 1,
};
const native =
    "https://node.test/native-resource/v1/resource/" + "a".repeat(43),
  blob = "blob:null/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function fixture(extra = {}) {
  const calls = [],
    uploads = [],
    snapshots = [];
  let current = { ...selected };
  const p = createNativeResourcePreparer({
    documentId: "native_font_document_0123456",
    documentURL: "https://site.test/page",
    topLevelURL: "https://site.test/page",
    frontendOrigin: "https://front.test",
    selectedIdentity: () => current,
    contentPolicies: [
      "style-src https://styles.test;font-src https://fonts.test",
    ],
    fetch: async (req, context) => {
      calls.push({ req, context });
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers: [
          [
            "content-type",
            req.destination === "font" ? "font/woff2" : "text/css",
          ],
          ...(req.destination === "font"
            ? [["access-control-allow-origin", "https://site.test"]]
            : []),
        ],
        body: (req.destination === "font"
          ? font
          : encoder.encode("body{}")
        ).slice().buffer,
      };
    },
    transform: async (value) => {
      await value.prepareDependency({
        kind: "font",
        url: "https://fonts.test/a.woff2",
      });
      return value.body;
    },
    upload: async (value, identity) => {
      uploads.push({ value, identity });
      return native;
    },
    ...extra,
  });
  return {
    p,
    calls,
    uploads,
    snapshots,
    setIdentity: (v) => (current = v),
    bind: async (value, identity, signal) => {
      snapshots.push({ value, identity, signal });
      return blob;
    },
  };
}
test("native no-CORS stylesheet font uses original font-src + anonymous CORS and only authorized snapshot, not gateway upload", async () => {
  const s = fixture();
  assert.equal(
    await s.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      s.bind,
    ),
    native,
  );
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].req.destination, "font");
  assert.equal(s.calls[1].req.mode, "cors");
  assert.equal(s.calls[1].req.credentials, "omit");
  assert.equal(s.calls[1].context.documentURL, "https://site.test/page");
  assert.equal(s.calls[1].context.referrerURL, "https://styles.test/a.css");
  assert.deepEqual(s.snapshots[0].value, { mime: "font/woff2", body: font });
  assert.equal(s.uploads.length, 1);
  assert.equal(s.uploads[0].value.kind, "style");
  s.p.dispose();
});
test("font original CSP denial happens before fetch; crossorigin font CORS failure never transfers bytes", async () => {
  const denied = fixture({
    contentPolicies: ["style-src https://styles.test;font-src 'none'"],
  });
  await assert.rejects(
    denied.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      denied.bind,
    ),
    { code: "native_resource_csp_denied" },
  );
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.snapshots.length, 0);
  assert.equal(denied.uploads.length, 0);
  denied.p.dispose();
  const cors = fixture({
    fetch: async (req) => ({
      url: req.url,
      status: 200,
      statusText: "OK",
      headers: [
        [
          "content-type",
          req.destination === "font" ? "font/woff2" : "text/css",
        ],
      ],
      body: font.slice().buffer,
    }),
  });
  await assert.rejects(
    cors.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      cors.bind,
    ),
    { code: "native_resource_cors_denied" },
  );
  assert.equal(cors.snapshots.length, 0);
  assert.equal(cors.uploads.length, 0);
  cors.p.dispose();
});
test("font SRI and MIME, selected-node identity and public descriptor boundary stay checked", async () => {
  const sri = fixture({
    transform: async (value) => {
      await value.prepareDependency({
        kind: "font",
        url: "https://fonts.test/a.woff2",
        integrity:
          "sha256-" + createHash("sha256").update("wrong").digest("base64"),
      });
      return value.body;
    },
  });
  await assert.rejects(
    sri.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      sri.bind,
    ),
    { name: "SecurityError" },
  );
  assert.equal(sri.snapshots.length, 0);
  sri.p.dispose();
  const mime = fixture({
    fetch: async (req) => ({
      url: req.url,
      status: 200,
      statusText: "OK",
      headers: [
        ["content-type", req.destination === "font" ? "text/html" : "text/css"],
        ["access-control-allow-origin", "https://site.test"],
      ],
      body: font.slice().buffer,
    }),
  });
  await assert.rejects(
    mime.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      mime.bind,
    ),
    { code: "native_resource_mime_denied" },
  );
  assert.equal(mime.snapshots.length, 0);
  mime.p.dispose();
  const pin = fixture();
  await assert.rejects(
    pin.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      async () => {
        pin.setIdentity({ ...selected, nodeId: "changed" });
        return blob;
      },
    ),
    { code: "native_resource_assignment_changed" },
  );
  assert.equal(pin.uploads.length, 0);
  await assert.rejects(
    pin.p.prepare({ kind: "font", url: "https://fonts.test/a.woff2" }),
    { code: "native_resource_invalid_descriptor" },
  );
  pin.p.dispose();
});
test("font snapshot channel is mandatory, validates opaque blob URL and remains cancellation bounded", async () => {
  const s = fixture();
  await assert.rejects(
    s.p.prepare({ kind: "style", url: "https://styles.test/a.css" }),
    { code: "native_resource_font_bridge_required" },
  );
  s.p.dispose();
  const wrong = fixture();
  await assert.rejects(
    wrong.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      async () => "https://other.test/protected",
    ),
    { code: "native_resource_invalid_font_blob" },
  );
  wrong.p.dispose();
  const abort = new AbortController(),
    bounded = fixture();
  await assert.rejects(
    bounded.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      abort.signal,
      undefined,
      async () => {
        abort.abort();
        return blob;
      },
    ),
    { code: "native_resource_aborted" },
  );
  assert.equal(bounded.uploads.length, 0);
  bounded.p.dispose();
});
test("same-origin font includes only its logical credentials; cross-origin redirect uses anonymous CORS and rechecks CSP", async () => {
  const calls = [];
  const s = fixture({
    contentPolicies: [
      "style-src https://styles.test;font-src 'self' https://fonts.test",
    ],
    fetch: async (req, ctx) => {
      calls.push({ req, ctx });
      const headers =
        req.destination === "font"
          ? [["content-type", "font/woff2"]]
          : [["content-type", "text/css"]];
      if (req.url === "https://site.test/start.woff2")
        return {
          url: req.url,
          status: 302,
          statusText: "Found",
          headers: [...headers, ["location", "https://fonts.test/final.woff2"]],
          body: new ArrayBuffer(0),
        };
      if (req.url.includes("fonts.test"))
        headers.push(["access-control-allow-origin", "https://site.test"]);
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers,
        body: font.slice().buffer,
      };
    },
    transform: async (value) => {
      await value.prepareDependency({
        url: "https://site.test/start.woff2",
        kind: "font",
      });
      return value.body;
    },
  });
  await s.p.prepare(
    { kind: "style", url: "https://styles.test/a.css" },
    undefined,
    undefined,
    s.bind,
  );
  assert.deepEqual(
    calls
      .filter((c) => c.req.destination === "font")
      .map((c) => [c.req.mode, c.req.credentials]),
    [
      ["cors", "include"],
      ["cors", "omit"],
    ],
  );
  s.p.dispose();
  const blocked = fixture({
    contentPolicies: [
      "style-src https://styles.test;font-src https://fonts.test/allowed/",
    ],
    transform: async (value) => {
      await value.prepareDependency({
        url: "https://fonts.test/denied/a.woff2",
        kind: "font",
      });
      return value.body;
    },
  });
  await assert.rejects(
    blocked.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      blocked.bind,
    ),
    { code: "native_resource_csp_denied" },
  );
  assert.equal(blocked.calls.length, 1);
  blocked.p.dispose();
});
test("font byte/count deadlines are bounded before private snapshot publication", async () => {
  const body = fixture({ maxBodyBytes: 8 });
  await assert.rejects(
    body.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      body.bind,
    ),
    { code: "native_resource_invalid_response" },
  );
  assert.equal(body.snapshots.length, 0);
  body.p.dispose();
  const count = fixture({ maxResources: 1 });
  await assert.rejects(
    count.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      count.bind,
    ),
    { code: "native_resource_count_limit" },
  );
  assert.equal(count.snapshots.length, 0);
  count.p.dispose();
  const timeout = fixture({ timeoutMs: 10 });
  await assert.rejects(
    timeout.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      () => new Promise(() => {}),
    ),
    { code: "native_resource_timeout" },
  );
  assert.equal(timeout.uploads.length, 0);
  timeout.p.dispose();
});
