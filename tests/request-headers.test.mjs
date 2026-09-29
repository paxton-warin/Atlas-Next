import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNavigationHeaders } from "../runtime/request-headers.ts";

const original = [
  ["Origin", "https://source.example"],
  ["origin", "https://source.example"],
  ["Referer", "https://source.example/page"],
  ["Cookie", "session=fixture"],
  ["Authorization", "Bearer fixture"],
  ["Sec-Fetch-Site", "cross-site"],
];
test("GET/HEAD document navigations omit Origin without changing other headers or input arrays", () => {
  for (const method of ["GET", "HEAD"])
    for (const destination of ["document", "iframe", "frame"]) {
      const init = { headers: original };
      normalizeNavigationHeaders(
        { request: { method }, parsed: { destination } },
        init,
      );
      assert.deepEqual(init.headers, original.slice(2));
      assert.equal(original.length, 6);
    }
});
test("POST and all other non-safe methods retain Origin and credentials", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const init = { headers: original };
    normalizeNavigationHeaders(
      { request: { method }, parsed: { destination: "iframe" } },
      init,
    );
    assert.equal(init.headers, original);
  }
});
test("script fetches, modules, resources and WebSocket handshakes keep their headers", () => {
  for (const destination of [
    "",
    "script",
    "style",
    "image",
    "worker",
    "websocket",
  ]) {
    const init = { headers: original };
    normalizeNavigationHeaders(
      { request: { method: "GET" }, parsed: { destination } },
      init,
    );
    assert.equal(init.headers, original);
  }
});
test("explicit non-navigation mode is left alone even on a mismatched document request", () => {
  for (const fetchMode of ["cors", "same-origin", "no-cors", "websocket"]) {
    const init = { headers: original };
    normalizeNavigationHeaders(
      {
        request: { method: "GET" },
        parsed: { destination: "document", fetchMode },
      },
      init,
    );
    assert.equal(init.headers, original);
  }
});
test("a request without outbound header pairs is not synthesized or mutated", () => {
  const init = {};
  normalizeNavigationHeaders(
    { request: { method: "GET" }, parsed: { destination: "document" } },
    init,
  );
  assert.deepEqual(init, {});
});
