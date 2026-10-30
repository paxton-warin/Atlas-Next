import test from "node:test";
import assert from "node:assert/strict";
import { createFrontendDocumentSource } from "../runtime/frontend-document-source.ts";
const encode = new TextEncoder(),
  pause = (n) => new Promise((r) => setTimeout(r, n));
class ElementFixture {
  constructor(attributes, position) {
    this.attributes = attributes;
    this.position = position;
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  compareDocumentPosition(other) {
    return other.position < this.position ? 2 : 4;
  }
}
class DocumentFixture {
  constructor(html) {
    this.elements = [];
    let index = 0;
    for (const m of html.matchAll(
      /<(meta|script|style|link|img)\b([^>]*)>/gi,
    )) {
      const a = { tag: m[1].toLowerCase() };
      for (const match of m[2].matchAll(/([\w-]+)="([^"]*)"/g))
        a[match[1]] = match[2];
      this.elements.push(new ElementFixture(a, index++));
    }
  }
  querySelectorAll(selector) {
    return this.elements.filter((e) =>
      selector.startsWith("head meta")
        ? e.attributes.tag === "meta" && e.attributes["http-equiv"]
        : e.attributes.tag !== "meta",
    );
  }
}
class ParserFixture {
  parseFromString(html) {
    return new DocumentFixture(html);
  }
}
const natives = {
  DOMParser: ParserFixture,
  parseFromString: ParserFixture.prototype.parseFromString,
  querySelectorAll: DocumentFixture.prototype.querySelectorAll,
  getAttribute: ElementFixture.prototype.getAttribute,
  compareDocumentPosition: ElementFixture.prototype.compareDocumentPosition,
};
function response(
  url,
  html = "<html><head></head><body>ok</body></html>",
  headers = [["content-type", "text/html;charset=utf-8"]],
  status = 200,
) {
  return {
    url,
    status,
    statusText: "OK",
    headers,
    body: encode.encode(html).buffer,
  };
}
function fixture(extra = {}) {
  const calls = [],
    source = createFrontendDocumentSource({
      frontendOrigin: "https://front.test",
      selectedNodeOrigin: () => "https://node.test",
      natives,
      fetch: async (r, c) => {
        calls.push({ r, c });
        return response(r.url);
      },
      ...extra,
    });
  return {
    source,
    calls,
    prepare: (website = "https://website.test/start", rest = {}) =>
      source.prepare({
        documentId: "document_source_123456",
        website,
        signal: new AbortController().signal,
        ...rest,
      }),
  };
}
test("trusted address-bar navigation uses raw assigned include/manual GET, immutable logical authority and no frontend referrer", async () => {
  const f = fixture(),
    r = await f.prepare();
  assert.equal(r.url, "https://website.test/start");
  assert.equal(r.coep, "unsafe-none");
  assert.deepEqual(r.contentPolicies, []);
  assert.equal(Object.isFrozen(r), true);
  assert.equal(Object.isFrozen(r.contentPolicies), true);
  const { r: req, c } = f.calls[0];
  assert.equal(req.mode, "no-cors");
  assert.equal(req.credentials, "include");
  assert.equal(req.redirect, "manual");
  assert.equal(req.destination, "document");
  assert.equal(c.topLevelNavigation, true);
  assert.equal(c.referrerURL, null);
  assert.equal(c.origin, "https://website.test");
  assert.equal(c.documentURL, "https://website.test/start");
  assert.equal(Object.isFrozen(c), true);
});
test("cross-origin navigation redirects do not apply Fetch readability CORS; only final headers supply policy", async () => {
  const calls = [];
  const f = fixture({
    fetch: async (r, c) => {
      calls.push({ r, c });
      return calls.length === 1
        ? response(
            r.url,
            "",
            [
              ["location", "https://final.test/page"],
              ["content-security-policy", "default-src 'none'"],
            ],
            302,
          )
        : response(r.url, "<html>final</html>", [
            ["content-type", "text/html"],
            ["content-security-policy", "img-src 'self'"],
            ["cross-origin-embedder-policy", 'require-corp; report-to="test"'],
          ]);
    },
  });
  const r = await f.prepare("https://website.test/start#frag");
  assert.equal(r.url, "https://final.test/page#frag");
  assert.deepEqual(r.contentPolicies, ["img-src 'self'"]);
  assert.equal(r.coep, "require-corp");
  assert.equal(calls[1].c.origin, "https://website.test");
  assert.equal(calls[1].c.redirectCount, 1);
  assert.equal(calls[1].r.url, "https://final.test/page");
});
for (const status of [403, 404, 429, 503])
  test(`HTML ${status} navigation remains a document with final URL and original CSP`, async () => {
    let calls = 0;
    const html = '<html><head><meta http-equiv="content-security-policy" content="img-src \'self\'"></head><body>Upstream error document</body></html>';
    const f = fixture({
      fetch: async (r) => ++calls === 1
        ? response(r.url, "", [["location", "https://final.test/error"], ["content-security-policy", "default-src 'none'"]], 302)
        : response(r.url, html, [["content-type", "text/html;charset=utf-8"], ["content-security-policy", "script-src 'none'"]], status),
    });
    const result = await f.prepare();
    assert.equal(calls, 2);
    assert.equal(result.url, "https://final.test/error");
    assert.equal(result.html, html);
    assert.deepEqual(result.contentPolicies, ["script-src 'none'", "img-src 'self'"]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.contentPolicies), true);
  });
test("enforced duplicate/header-list policies are intersection; report-only is never enforced; early real meta directives retained selectively", async () => {
  const f = fixture({
    fetch: async (r) =>
      response(
        r.url,
        '<html><head><meta http-equiv="Content-Security-Policy" content="img-src https://images.test; frame-ancestors none; sandbox; report-uri /report"><script src="https://cdn.test/a.js"></script></head></html>',
        [
          ["content-type", "text/html"],
          ["content-security-policy", "script-src 'self', style-src 'none'"],
          ["content-security-policy", "connect-src https://api.test"],
          ["content-security-policy-report-only", "default-src 'none'"],
        ],
      ),
  });
  assert.deepEqual((await f.prepare()).contentPolicies, [
    "script-src 'self'",
    "style-src 'none'",
    "connect-src https://api.test",
    "img-src https://images.test",
  ]);
});
test("late meta policy fails explicitly instead of retroactively authorizing or blocking already-parsed resources", async () => {
  const f = fixture({
    fetch: async (r) =>
      response(
        r.url,
        '<head><script src="/first.js"></script><meta http-equiv="Content-Security-Policy" content="default-src none"></head>',
      ),
  });
  await assert.rejects(
    f.prepare(),
    (e) => e.code === "document_source_late_meta_policy",
  );
});
test("frontend/current node, credentials, protocols, every redirect hop and HTTPS downgrade are denied before target transport", async () => {
  for (const url of [
    "https://front.test/",
    "https://node.test/",
    "https://name:pass@website.test/",
    "data:text/html,x",
    "file:///tmp/x",
  ]) {
    const f = fixture();
    await assert.rejects(
      f.prepare(url),
      (e) => e.code === "document_source_destination_denied",
    );
    assert.equal(f.calls.length, 0);
  }
  for (const target of [
    "https://front.test/",
    "https://node.test/",
    "http://website.test/",
  ]) {
    let n = 0;
    const f = fixture({
      fetch: async (r) => {
        n++;
        return response(r.url, "", [["location", target]], 302);
      },
    });
    await assert.rejects(
      f.prepare(),
      (e) => e.code === "document_source_destination_denied",
    );
    assert.equal(n, 1);
  }
});
test("redirect count, conflicting Location and assignment changes are bounded and terminal", async () => {
  let n = 0;
  const loop = fixture({
    fetch: async (r) => {
      n++;
      return response(r.url, "", [["location", "/next"]], 302);
    },
  });
  await assert.rejects(
    loop.prepare(),
    (e) => e.code === "document_source_redirect_limit",
  );
  assert.equal(n, 21);
  const ambiguous = fixture({
    fetch: async (r) =>
      response(
        r.url,
        "",
        [
          ["location", "/one"],
          ["location", "/two"],
        ],
        302,
      ),
  });
  await assert.rejects(
    ambiguous.prepare(),
    (e) => e.code === "document_source_ambiguous_redirect",
  );
  let node = "https://node.test";
  const moving = fixture({
    selectedNodeOrigin: () => node,
    fetch: async (r) => {
      node = "https://next-node.test";
      return response(r.url);
    },
  });
  await assert.rejects(
    moving.prepare(),
    (e) => e.code === "document_source_assignment_changed",
  );
});
test("non-HTML, duplicate MIME, XHTML parser mismatch, raw cookies and excessive response/body/policy sizes fail closed", async () => {
  for (const [headers, status, code] of [
    [
      [["content-type", "application/json"]],
      200,
      "document_source_html_required",
    ],
    [
      [
        ["content-type", "text/html"],
        ["content-type", "text/html"],
      ],
      200,
      "document_source_html_required",
    ],
    [
      [["content-type", "application/xhtml+xml"]],
      200,
      "document_source_xhtml_parser_required",
    ],
    [[["content-type", "text/html"]], 204, "document_source_html_required"],
    [[["content-type", "text/html"]], 205, "document_source_html_required"],
    [[["content-type", "text/html"]], 304, "document_source_html_required"],
    [[], 429, "document_source_html_required"],
    [[["content-type", "application/json"]], 429, "document_source_html_required"],
    [[["content-type", "text/plain"]], 503, "document_source_html_required"],
    [[["content-type", "application/xhtml+xml"]], 403, "document_source_xhtml_parser_required"],
    [[["content-type", "text/html"], ["content-type", "text/html"]], 404, "document_source_html_required"],
    [
      [
        ["content-type", "text/html"],
        ["set-cookie", "private=1"],
      ],
      200,
      "document_source_invalid_headers",
    ],
    [
      [
        ["content-type", "text/html"],
        ["content-security-policy", "x".repeat(65537)],
      ],
      200,
      "document_source_invalid_headers",
    ],
    [
      [
        ["content-type", "text/html"],
        ["cross-origin-embedder-policy", "unrecognized"],
      ],
      200,
      "document_source_invalid_coep",
    ],
  ]) {
    const f = fixture({
      fetch: async (r) => response(r.url, "ok", headers, status),
    });
    await assert.rejects(f.prepare(), (e) => e.code === code);
  }
  const f = fixture({
    maxBodyBytes: 4,
    fetch: async (r) => response(r.url, "oversized"),
  });
  await assert.rejects(
    f.prepare(),
    (e) => e.code === "document_source_invalid_response",
  );
});
test("abort/timeout rejects promptly, ignores late results and retains four orphan slots for abort-ignoring transport", async () => {
  const pending = [];
  const f = fixture({
    timeoutMs: 10,
    fetch: async (r) =>
      new Promise((resolve) => pending.push(() => resolve(response(r.url)))),
  });
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      f.prepare("https://website.test/", {
        documentId: "different_document_" + i,
      }),
      (e) => e.code === "document_source_timeout",
    );
  await assert.rejects(
    f.prepare("https://website.test/", { documentId: "different_document_5" }),
    (e) => e.code === "document_source_limit",
  );
  for (const end of pending) end();
  await pause(0);
  assert.equal((await fixture().prepare()).html.includes("ok"), true);
  const controller = new AbortController(),
    g = fixture({ fetch: async () => new Promise(() => {}) });
  const loading = g.prepare("https://website.test/", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(loading, (e) => e.code === "document_source_aborted");
  g.source.dispose();
});

test("explicit same-origin composition ignores upstream CSP including late meta without changing website bytes or assigned transport", async () => {
  const html = '<html><head><script>window.first=true</script><meta http-equiv="content-security-policy" content="sandbox; frame-ancestors none"></head><body>same-origin profile</body></html>';
  const f = fixture({enforceOriginalPolicy:false,fetch:async r=>response(r.url,html,[["content-type","text/html"],["content-security-policy","sandbox; frame-ancestors none"],["cross-origin-embedder-policy","require-corp"]])});
  const result = await f.prepare();
  assert.deepEqual(result.contentPolicies, []);
  assert.equal(result.coep,"unsafe-none");
  assert.equal(result.html, html);
  assert.equal(result.url,"https://website.test/start");
  f.source.dispose();
});

test("same-origin profile mode discards unsupported and repeated COEP without adding policy failures", async () => {
  for (const headers of [[["cross-origin-embedder-policy","unsupported-token"]],[["cross-origin-embedder-policy","require-corp"],["cross-origin-embedder-policy","credentialless"]]]) {
    const f=fixture({enforceOriginalPolicy:false,fetch:async r=>response(r.url,"<html><body>ok</body></html>",[["content-type","text/html"],...headers])});
    assert.equal((await f.prepare()).coep,"unsafe-none");f.source.dispose();
  }
});
