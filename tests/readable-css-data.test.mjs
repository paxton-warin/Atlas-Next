import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeLocalCSSDataResource as decode } from "../runtime/local-css-data-resource.ts";
import { createOpaqueResourceGraph } from "../runtime/opaque-resource-graph.ts";
import { createOriginalDocumentPolicy } from "../runtime/original-document-policy.ts";
const font = "data:font/woff2;base64,d09GMg==",
  image =
    "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E";
function fixture(extra = {}) {
  const allocated = [],
    revoked = [],
    calls = [];
  const el = (tag, attrs = {}) => ({
    localName: tag,
    attributes: new Map(Object.entries(attrs)),
    textContent: "",
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
  });
  const graph = createOpaqueResourceGraph({
    documentURL: "https://site.test/page",
    document: {
      documentElement: el("html"),
      head: {},
      createElement: (tag) => el(tag),
    },
    originalPolicy: createOriginalDocumentPolicy({
      documentURL: "https://site.test/page",
      contentPolicies: ["style-src 'self';font-src data:;img-src data:"],
    }),
    network: {
      fetch: async (url) => {
        calls.push(url);
        const response = new Response(
          `@font-face{font-family:local;src:url("${font}")}body{background:url("${image}")}`,
          { headers: { "content-type": "text/css" } },
        );
        Object.defineProperties(response, {
          url: { value: url },
          type: { value: "basic" },
        });
        return response;
      },
    },
    rewriter: {
      context: { prefix: new URL("https://front.test/browse/logical/doc/") },
      restoreURL: (v) => v,
      originalCSS: (v) => v,
      stylesheet(source) {
        return {
          source: source.replace(
            /url\("([^"\n]+)"\)/g,
            (_m, url) =>
              'url("atlas-opaque-resource:' + encodeURIComponent(url) + '")',
          ),
          dependencies: [],
        };
      },
    },
    natives: {
      DOMParser: class {},
      Blob,
      createObjectURL: (blob) => {
        const url = URL.createObjectURL(blob);
        allocated.push({ blob, url });
        return url;
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
        URL.revokeObjectURL(url);
      },
      importModule: () => {},
      getAttribute: el("x").getAttribute,
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      appendChild() {},
    },
    ...extra,
  });
  return { graph, allocated, revoked, calls, el };
}
test("readable CSS data image/font resolves under original destination policy, never HTTP fetch, with document Blob cleanup", async () => {
  const f = fixture();
  try {
    const sheet = f.el("link", {
      rel: "stylesheet",
      href: "https://site.test/s.css",
    });
    await f.graph.prepareElement(sheet);
    assert.equal(f.calls.length, 1);
    const css = f.allocated.find((v) => v.blob.type === "text/css");
    assert.ok(css);
    const source = await css.blob.text();
    assert.equal(source.includes("atlas-opaque-resource:"), false);
    assert.match(source, /data:image\/svg\+xml/);
    assert.match(source, /blob:nodedata:/);
    assert.equal(
      f.allocated.filter((v) => v.blob.type === "font/woff2").length,
      1,
    );
  } finally {
    f.graph.dispose();
    assert.equal(f.revoked.length, f.allocated.length);
  }
});
test("data source denied by original font/img policy before local-byte rendering; generic executable import stays HTTP-only", async () => {
  for (const policy of [
    "style-src 'self';font-src 'none';img-src data:",
    "style-src 'self';font-src data:;img-src 'none'",
  ]) {
    const f = fixture({
      originalPolicy: createOriginalDocumentPolicy({
        documentURL: "https://site.test/page",
        contentPolicies: [policy],
      }),
    });
    try {
      await assert.rejects(
        f.graph.prepareElement(
          f.el("link", { rel: "stylesheet", href: "https://site.test/s.css" }),
        ),
        { code: "original_policy_denied" },
      );
      assert.throws(
        () =>
          f.graph.prepareModule("data:application/javascript,export default 1"),
        { name: "SecurityError" },
      );
    } finally {
      f.graph.dispose();
    }
  }
});
test("local CSS parser enforces binary byte/encoding/MIME bounds, preserves fragments only in CSS caller, no executable destination", () => {
  assert.deepEqual([...decode(font, "font").body], [119, 79, 70, 50]);
  assert.deepEqual(
    [...decode("data:font/woff2,w%4FF2#face", "font").body],
    [119, 79, 70, 50],
  );
  assert.equal(decode(image + "#tile", "image").url.includes("#"), false);
  for (const [url, kind, code] of [
    ["data:application/javascript,1", "font", "local_css_mime_denied"],
    ["data:font/woff2;base64,!!!!", "font", "local_css_invalid_data"],
    ["data:font/woff2;base64,", "font", "local_css_invalid_data"],
    ["https://site.test/font", "font", "local_css_destination_denied"],
  ])
    assert.throws(() => decode(url, kind), { code });
  assert.throws(() => decode(font, "font", 3), {
    code: "local_css_byte_limit",
  });
});
test("local CSS resources share graph count/decoded byte budgets and cannot allocate after disposal", async () => {
  for (const extra of [{ maxResources: 1 }, { maxTotalBytes: 8 }]) {
    const f = fixture(extra);
    try {
      await assert.rejects(
        f.graph.prepareElement(
          f.el("link", { rel: "stylesheet", href: "https://site.test/s.css" }),
        ),
        { name: "QuotaExceededError" },
      );
    } finally {
      f.graph.dispose();
    }
  }
  const f = fixture();
  f.graph.dispose();
  await assert.rejects(
    f.graph.prepareElement(
      f.el("link", { rel: "stylesheet", href: "https://site.test/s.css" }),
    ),
    { name: "AbortError" },
  );
  assert.equal(f.allocated.length, 0);
});
test("only original-authorized data image/font gets encoded local-byte bound; generic URLs/schemes keep16KiB", () => {
  const p = createOriginalDocumentPolicy({
    documentURL: "https://site.test/page",
    contentPolicies: [
      "img-src data:;font-src data:;connect-src data:;script-src data:",
    ],
  });
  const longImage = "data:image/png;base64," + "A".repeat(17000),
    longFont = "data:font/woff2;base64," + "A".repeat(17000);
  assert.equal(p.checkURL({ kind: "image", url: longImage }).url, longImage);
  assert.equal(p.checkURL({ kind: "font", url: longFont }).url, longFont);
  for (const kind of ["script", "connect", "worker", "media"])
    assert.throws(() => p.checkURL({ kind, url: longFont }));
  assert.throws(() => p.upgradeURL(longImage), {
    code: "original_policy_invalid_url",
  });
  for (const kind of ["image", "font"]) {
    assert.throws(
      () => p.checkURL({ kind, url: "https://site.test/" + "a".repeat(17000) }),
      { code: "original_policy_invalid_url" },
    );
    for (const source of ["*", "'self'", "https:"]) {
      const denied = createOriginalDocumentPolicy({
        documentURL: "https://site.test/page",
        contentPolicies: [
          (kind === "image" ? "img-src " : "font-src ") + source,
        ],
      });
      assert.throws(
        () =>
          denied.checkURL({
            kind,
            url: kind === "image" ? longImage : longFont,
          }),
        { code: "original_policy_denied" },
      );
    }
  }
  assert.throws(
    () =>
      p.checkURL({
        kind: "image",
        url: "data:image/png," + "A".repeat(8 * 1024 * 1024 * 4 + 65536),
      }),
    { code: "original_policy_invalid_url" },
  );
});
