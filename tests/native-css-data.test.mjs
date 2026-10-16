import test from "node:test";
import assert from "node:assert/strict";
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
import { createOriginalDocumentPolicy } from "../runtime/original-document-policy.ts";
import { scanNativeCSSDependencies } from "../runtime/native-css-dependencies.ts";
const fontURL = "data:font/woff2;base64,d09GMg==",
  imageURL =
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E",
  blob = "blob:null/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const native =
  "https://node.test/native-resource/v1/resource/" + "a".repeat(43);
function fixture(
  policies = ["style-src https://styles.test;font-src data:;img-src data:"],
  extra = {},
) {
  const calls = [],
    fonts = [],
    uploads = [];
  const p = createNativeResourcePreparer({
    documentId: "css_data_document_01234567",
    documentURL: "https://site.test/page",
    topLevelURL: "https://site.test/page",
    frontendOrigin: "https://front.test",
    selectedIdentity: () => ({
      nodeId: "selected",
      resourceOrigin: "https://node.test",
      leaseHash: "a".repeat(64),
      generation: 1,
    }),
    contentPolicies: policies,
    fetch: async (req) => {
      calls.push(req);
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/css"]],
        body: new TextEncoder().encode("body{}").buffer,
      };
    },
    upload: async (value) => {
      uploads.push(value);
      return native;
    },
    ...extra,
  });
  return {
    p,
    calls,
    fonts,
    uploads,
    bind: async (value) => {
      fonts.push(value);
      return blob;
    },
  };
}
test("local CSS data fonts/images require each original policy, use no network and do not upload local bytes", async () => {
  const s = fixture(undefined, {
    transform: async (value) => {
      assert.equal(
        await value.prepareDependency({ kind: "font", url: fontURL }),
        blob,
      );
      assert.equal(
        await value.prepareDependency({ kind: "image", url: imageURL }),
        new URL(imageURL).href,
      );
      return value.body;
    },
  });
  assert.equal(
    await s.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      s.bind,
    ),
    native,
  );
  assert.equal(s.calls.length, 1);
  assert.equal(s.uploads.length, 1);
  assert.deepEqual([...s.fonts[0].body], [119, 79, 70, 50]);
  s.p.dispose();
});
test("data scheme is not granted by star/self or a different policy; executable data remains unsupported", async () => {
  for (const [kind, url, directive] of [
    ["font", fontURL, "font-src"],
    ["image", imageURL, "img-src"],
  ])
    for (const sources of ["'none'", "*", "'self'", "https:"]) {
      const s = fixture(
        [`style-src https://styles.test;${directive} ${sources}`],
        {
          transform: async (value) => {
            await value.prepareDependency({ kind, url });
            return value.body;
          },
        },
      );
      await assert.rejects(
        s.p.prepare(
          { kind: "style", url: "https://styles.test/a.css" },
          undefined,
          undefined,
          s.bind,
        ),
        { code: "native_resource_csp_denied" },
      );
      assert.equal(s.calls.length, 1);
      assert.equal(s.fonts.length, 0);
      s.p.dispose();
    }
  const executable = fixture(undefined, {
    transform: async (value) => {
      await value.prepareDependency({
        kind: "script",
        url: "data:application/javascript,1",
      });
      return value.body;
    },
  });
  await assert.rejects(
    executable.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      executable.bind,
    ),
    { code: "native_resource_destination_denied" },
  );
  executable.p.dispose();
});
test("bounded data decoding validates MIME/base64/bytes before font transfer", async () => {
  for (const [url, code] of [
    [
      "data:application/javascript;base64,d09GMg==",
      "native_resource_mime_denied",
    ],
    ["data:font/woff2;base64,!!!!", "native_resource_invalid_data"],
    ["data:font/woff2;base64,a", "native_resource_invalid_data"],
    ["data:font/woff2;base64,", "native_resource_invalid_data"],
  ]) {
    const s = fixture(undefined, {
      transform: async (value) => {
        await value.prepareDependency({ kind: "font", url });
        return value.body;
      },
    });
    await assert.rejects(
      s.p.prepare(
        { kind: "style", url: "https://styles.test/a.css" },
        undefined,
        undefined,
        s.bind,
      ),
      { code },
    );
    assert.equal(s.fonts.length, 0);
    s.p.dispose();
  }
  const quota = fixture(undefined, {
    maxBodyBytes: 6,
    transform: async (value) => {
      await value.prepareDependency({
        kind: "font",
        url: "data:font/woff2;base64,d09GMmZvbnQ=",
      });
      return value.body;
    },
  });
  await assert.rejects(
    quota.p.prepare(
      { kind: "style", url: "https://styles.test/a.css" },
      undefined,
      undefined,
      quota.bind,
    ),
    { code: "native_resource_byte_limit" },
  );
  quota.p.dispose();
});
test("trusted original data: authorization is image/font only, not generic script/worker/connect/media", () => {
  const p = createOriginalDocumentPolicy({
    documentURL: "https://site.test/page",
    contentPolicies: ["default-src data:"],
  });
  for (const kind of ["image", "font"])
    assert.equal(
      p
        .checkURL({ kind, url: kind === "font" ? fontURL : imageURL })
        .url.startsWith("data:"),
      true,
    );
  for (const kind of ["script", "style", "worker", "connect", "media", "frame"])
    assert.throws(() => p.checkURL({ kind, url: fontURL }), {
      code: "original_policy_destination_denied",
    });
  const denied = createOriginalDocumentPolicy({
    documentURL: "https://site.test/page",
    contentPolicies: ["font-src *"],
  });
  assert.throws(() => denied.checkURL({ kind: "font", url: fontURL }), {
    code: "original_policy_denied",
  });
});
test("CSS scanner accepts finite 1024 references and rejects 1025 without unbounded compatibility claims", () => {
  const style = (count) =>
    Array.from(
      { length: count },
      (_, n) => `.a${n}{background:url(https://images.test/${n}.png)}`,
    ).join("");
  assert.equal(scanNativeCSSDependencies(style(1024)).length, 1024);
  assert.throws(() => scanNativeCSSDependencies(style(1025)), {
    name: "QuotaExceededError",
  });
  assert.equal(
    scanNativeCSSDependencies(
      "a{background:url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E)}",
    )[0].kind,
    "image",
  );
});
