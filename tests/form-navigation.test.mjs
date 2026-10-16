import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanFormNavigation,
  FORM_NAVIGATION_BYTES,
} from "../runtime/form-navigation.ts";
import { createFrontendDocumentSource } from "../runtime/frontend-document-source.ts";
test("form wire accepts only bounded GET/POST data, never source identity, headers or capabilities", () => {
  assert.deepEqual(
    cleanFormNavigation({ url: "https://site.test/go?q=x", method: "GET" }),
    { url: "https://site.test/go?q=x", method: "GET" },
  );
  const body = new TextEncoder().encode("a=b").buffer;
  const value = cleanFormNavigation({
    url: "https://site.test/go",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body,
  });
  assert.ok(value);
  assert.notEqual(value.body, body);
  assert.equal(new TextDecoder().decode(value.body), "a=b");
  for (const v of [
    { url: "https://site.test", method: "GET", body },
    { url: "https://site.test", method: "DELETE" },
    { url: "https://site.test", method: "GET", headers: [] },
    {
      url: "https://site.test",
      method: "GET",
      initiatorURL: "https://front.test",
    },
    {
      url: "https://site.test",
      method: "POST",
      contentType: "application/json",
      body,
    },
    {
      url: "https://site.test",
      method: "POST",
      contentType: "text/plain",
      body: new ArrayBuffer(FORM_NAVIGATION_BYTES + 1),
    },
    { url: "javascript:alert(1)", method: "GET" },
    Object.defineProperty({ method: "GET" }, "url", {
      enumerable: true,
      get() {
        throw Error("must not invoke");
      },
    }),
  ])
    assert.equal(cleanFormNavigation(v), undefined);
});
class Parser {
  parseFromString() {
    return {};
  }
}
const natives = {
  DOMParser: Parser,
  parseFromString: Parser.prototype.parseFromString,
  querySelectorAll() {
    return [];
  },
  getAttribute() {},
  compareDocumentPosition() {
    return 0;
  },
};
test("trusted form source preserves POST307/308 bodies and changes301/302/303 to GET, checking every form-action hop", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [],
      checks = [],
      body = new TextEncoder().encode("field=value").buffer;
    const source = createFrontendDocumentSource({
      frontendOrigin: "https://front.test",
      selectedNodeOrigin: () => "https://node.test",
      natives,
      fetch: async (request, context) => {
        calls.push({ request, context });
        return {
          url: request.url,
          status: calls.length === 1 ? status : 200,
          statusText: "fixture",
          headers:
            calls.length === 1
              ? [["location", "https://other.test/final"]]
              : [["content-type", "text/html"]],
          body: new TextEncoder().encode("<html></html>").buffer,
        };
      },
    });
    await source.prepare({
      documentId: "form_navigation_doc_123",
      website: "https://target.test/submit",
      signal: new AbortController().signal,
      navigation: {
        url: "https://target.test/submit",
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body,
        initiatorURL: "https://source.test/page",
        authorizeURL: (url, n) => checks.push([url, n]),
      },
    });
    assert.equal(calls[0].request.method, "POST");
    assert.equal(calls[0].context.requestOrigin, "https://source.test");
    assert.equal(
      calls[0].context.navigationSourceURL,
      "https://source.test/page",
    );
    assert.deepEqual(checks, [
      ["https://target.test/submit", 0],
      ["https://other.test/final", 1],
    ]);
    assert.equal(calls[1].context.requestOrigin, "null");
    assert.equal(
      calls[1].request.method,
      [307, 308].includes(status) ? "POST" : "GET",
    );
    assert.equal(
      calls[1].request.body !== undefined,
      [307, 308].includes(status),
    );
    assert.equal(
      calls[1].request.headers.some(([k]) => k === "content-type"),
      [307, 308].includes(status),
    );
    source.dispose();
  }
});
test("a denied form redirect is rejected before its upstream request", async () => {
  let calls = 0;
  const source = createFrontendDocumentSource({
    frontendOrigin: "https://front.test",
    selectedNodeOrigin: () => "https://node.test",
    natives,
    fetch: async (request) => {
      calls++;
      return {
        url: request.url,
        status: 307,
        statusText: "fixture",
        headers: [["location", "https://denied.test/leak"]],
        body: new ArrayBuffer(0),
      };
    },
  });
  await assert.rejects(
    source.prepare({
      documentId: "form_navigation_doc_123",
      website: "https://site.test/submit",
      signal: new AbortController().signal,
      navigation: {
        url: "https://site.test/submit",
        method: "POST",
        contentType: "text/plain",
        body: new TextEncoder().encode("field=value").buffer,
        initiatorURL: "https://site.test/page",
        authorizeURL(url) {
          if (new URL(url).hostname !== "site.test")
            throw new DOMException("form-action denied", "SecurityError");
        },
      },
    }),
    { name: "SecurityError" },
  );
  assert.equal(calls, 1);
  source.dispose();
});
