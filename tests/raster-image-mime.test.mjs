import test from "node:test";
import assert from "node:assert/strict";
import { imageResourceMIME } from "../runtime/raster-image-mime.ts";
const binary = (...v) => new Uint8Array(v),
  text = (s) => new TextEncoder().encode(s);
test("missing/octet raster image MIME uses WHATWG binary signatures, never extensions or text SVG/HTML", () => {
  const rows = [
    ["image/png", binary(0x89, 80, 78, 71, 13, 10, 26, 10)],
    ["image/jpeg", binary(255, 216, 255)],
    ["image/gif", text("GIF87a")],
    ["image/gif", text("GIF89a")],
    [
      "image/webp",
      binary(82, 73, 70, 70, 255, 1, 2, 3, 87, 69, 66, 80, 86, 80),
    ],
    ["image/x-icon", binary(0, 0, 1, 0)],
    ["image/x-icon", binary(0, 0, 2, 0)],
  ];
  for (const [mime, body] of rows)
    for (const supplied of [
      "",
      "application/octet-stream",
      " Application/Octet-Stream ; charset=binary ",
    ])
      assert.equal(imageResourceMIME(supplied, body), mime);
  for (const body of [
    text('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    text("<!doctype html><script>1</script>"),
    text("RIFFxxxxWEBP"),
    binary(0x89, 80, 78, 71),
    text("arbitrary.webp"),
  ])
    assert.equal(
      imageResourceMIME("application/octet-stream", body),
      undefined,
    );
  for (const supplied of [
    "text/html",
    "text/plain",
    "application/xml",
    "application/javascript",
  ])
    assert.equal(imageResourceMIME(supplied, rows[4][1]), undefined);
});
test("supplied supported image types retain existing handling; SVG is never inferred and no executable MIME is produced", () => {
  assert.equal(
    imageResourceMIME("image/svg+xml", text("<svg/>")),
    "image/svg+xml",
  );
  assert.equal(imageResourceMIME("image/avif", binary(1, 2, 3)), "image/avif");
  assert.equal(imageResourceMIME("image/png", text("<html>")), "image/png");
  assert.equal(imageResourceMIME("image/not-real", binary(1)), undefined);
});
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
test("trusted no-CORS image uses signature MIME only after CSP/CORP/CORS and never promotes executable destinations", async () => {
  const webp = new Uint8Array([
      82, 73, 70, 70, 255, 1, 2, 3, 87, 69, 66, 80, 86, 80,
    ]),
    upload = [],
    calls = [];
  const make = (extra = {}) =>
    createNativeResourcePreparer({
      documentId: "raster_document_0123456789",
      documentURL: "https://site.test/page",
      topLevelURL: "https://site.test/page",
      frontendOrigin: "https://front.test",
      selectedIdentity: () => ({
        nodeId: "selected",
        resourceOrigin: "https://node.test",
        leaseHash: "a".repeat(64),
        generation: 1,
      }),
      contentPolicies: ["img-src https://asset.test"],
      fetch: async (req) => {
        calls.push(req);
        return {
          url: req.url,
          status: 200,
          statusText: "OK",
          headers: [
            ["content-type", "application/octet-stream"],
            ["x-content-type-options", "nosniff"],
          ],
          body: webp.slice().buffer,
        };
      },
      upload: async (v) => {
        upload.push(v);
        return (
          "https://node.test/native-resource/v1/resource/" + "a".repeat(43)
        );
      },
      ...extra,
    });
  const positive = make();
  assert.match(
    await positive.prepare({
      url: "https://asset.test/no-extension",
      kind: "image",
    }),
    /^https:\/\/node/,
  );
  assert.equal(upload[0].mime, "image/webp");
  positive.dispose();
  const csp = make({ contentPolicies: ["img-src 'none'"] });
  const before = calls.length;
  await assert.rejects(
    csp.prepare({ url: "https://asset.test/file.webp", kind: "image" }),
    { code: "native_resource_csp_denied" },
  );
  assert.equal(calls.length, before);
  csp.dispose();
  const cors = make();
  await assert.rejects(
    cors.prepare({
      url: "https://asset.test/file.webp",
      kind: "image",
      crossOrigin: "anonymous",
    }),
    { code: "native_resource_cors_denied" },
  );
  cors.dispose();
  const script = make({ contentPolicies: [], transform: async (v) => v.body });
  await assert.rejects(
    script.prepare({ url: "https://asset.test/file.js", kind: "script" }),
    { code: "native_resource_mime_denied" },
  );
  script.dispose();
  const html = make({
    fetch: async (req) => ({
      url: req.url,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/octet-stream"]],
      body: new TextEncoder().encode("<html><script>1</script>").buffer,
    }),
  });
  await assert.rejects(
    html.prepare({ url: "https://asset.test/file.png", kind: "image" }),
    { code: "native_resource_mime_denied" },
  );
  html.dispose();
});
