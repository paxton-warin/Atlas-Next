import test from "node:test";
import assert from "node:assert/strict";
import { createPopoutUrl, parsePopoutLaunch } from "../web/src/popout-link.ts";

test("popout handoff uses the exact frontend origin and pinned lease in a fragment, not a ticket or node URL", () => {
  const target = "https://example.com/path?search=hello#section";
  const link = createPopoutUrl(
    "https://frontend.example",
    target,
    "lease_fixture-123",
    false,
  );
  const url = new URL(link);
  assert.equal(url.origin, "https://frontend.example");
  assert.equal(url.pathname, "/popout");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).has("ticket"), false);
  assert.deepEqual(parsePopoutLaunch(link), {
    target,
    session: "lease_fixture-123",
    youtubeAdblock: false,
  });
});

test("non-routed popouts work without a lease and enable filtering by default", () => {
  assert.deepEqual(
    parsePopoutLaunch(
      createPopoutUrl("http://localhost:4180", "https://example.com"),
    ),
    {
      target: "https://example.com/",
      session: undefined,
      youtubeAdblock: true,
    },
  );
});

test("popout handoff rejects missing, non-web, same-frontend and malformed target/session values", () => {
  assert.throws(() => parsePopoutLaunch("https://frontend.example/popout"));
  for (const target of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://frontend.example/api/admin",
    "https://user:pass@example.com/",
    "https://example.com/" + "a".repeat(8192),
  ])
    assert.throws(() => createPopoutUrl("https://frontend.example", target));
  for (const session of ["", "hello world", "a".repeat(4097), "../runtime"])
    assert.throws(() =>
      createPopoutUrl(
        "https://frontend.example",
        "https://example.com",
        session,
      ),
    );
  assert.throws(() =>
    parsePopoutLaunch("https://frontend.example/popout#page=v1.%25bad"),
  );
});

test("a supplied runtime URL or ticket cannot redirect the wrapper's connection selection", () => {
  const link = createPopoutUrl(
    "https://frontend.example",
    "https://example.com",
    "pinned",
  );
  assert.deepEqual(
    parsePopoutLaunch(
      link + "&runtimeOrigin=https://other.example&ticket=untrusted",
    ),
    {
      target: "https://example.com/",
      session: "pinned",
      youtubeAdblock: true,
    },
  );
});
