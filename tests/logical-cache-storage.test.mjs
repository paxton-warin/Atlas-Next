import test from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_CACHE_DATABASE,
  cacheMatches,
  checkedCacheRequest,
  checkedCacheResponse,
  cacheStateBytes,
  emptyCacheState,
} from "../runtime/sandbox-cache-protocol.ts";
import { bindSandboxCaches } from "../runtime/sandbox-caches.ts";
const request = (url = "https://site.test/file?q=1#one", headers = []) => ({
  url,
  method: "GET",
  headers,
  mode: "cors",
  credentials: "same-origin",
  redirect: "follow",
  referrer: "about:client",
  referrerPolicy: "",
  integrity: "",
});
const response = (body = null, headers = []) => ({
  type: "default",
  url: "",
  status: 200,
  statusText: "",
  headers,
  body,
  redirected: false,
});
const options = { ignoreSearch: false, ignoreMethod: false, ignoreVary: false };
test("Cache database is fresh, fixed frontend-owned and independent of traffic node/lease", () => {
  assert.equal(SANDBOX_CACHE_DATABASE, "atlas.browsing.cache.v2");
  assert.deepEqual(emptyCacheState(), {
    version: 1,
    nextId: 1,
    names: [],
    caches: [],
  });
});
test("Cache query ignores fragment, optionally search/method and honors stored Vary", () => {
  const entry = {
    request: request(undefined, [["accept-language", "en"]]),
    response: response(null, [["vary", "accept-language"]]),
  };
  assert.equal(
    cacheMatches(
      entry,
      request("https://site.test/file?q=1#two", [["accept-language", "en"]]),
      options,
    ),
    true,
  );
  assert.equal(
    cacheMatches(
      entry,
      request(undefined, [["accept-language", "fr"]]),
      options,
    ),
    false,
  );
  assert.equal(
    cacheMatches(entry, request(undefined, [["accept-language", "fr"]]), {
      ...options,
      ignoreVary: true,
    }),
    true,
  );
  assert.equal(
    cacheMatches(
      entry,
      request("https://site.test/file?q=2", [["accept-language", "en"]]),
      options,
    ),
    false,
  );
  assert.equal(
    cacheMatches(
      entry,
      request("https://site.test/file?q=2", [["accept-language", "en"]]),
      { ...options, ignoreSearch: true },
    ),
    true,
  );
  assert.equal(
    cacheMatches(entry, { ...entry.request, method: "POST" }, options),
    false,
  );
  assert.equal(
    cacheMatches(
      entry,
      { ...entry.request, method: "POST" },
      { ...options, ignoreMethod: true },
    ),
    true,
  );
});
test("Wire validation rejects malformed/nonHTTP keys and unsupported opaque payload representation", () => {
  for (const value of [
    "file:///private",
    "data:text/plain,x",
    "https://user:password@site.test/x",
  ])
    assert.throws(() => checkedCacheRequest(request(value)), {
      name: "TypeError",
    });
  for (const value of [
    { ...response(), type: "opaque" },
    { ...response(), status: 206 },
    response(null, [["vary", "*"]]),
    { ...response(), headers: [["x", "bad\r\nvalue"]] },
    response("not-bytes"),
  ])
    assert.throws(() => checkedCacheResponse(value), { name: "TypeError" });
  assert.equal(
    checkedCacheResponse({ ...response(), type: "error", status: 0 }).type,
    "error",
  );
});
test("Logical quota charges names, metadata and body bytes, not only record count", () => {
  const state = emptyCacheState(),
    before = cacheStateBytes(state);
  state.names.push({ name: "cache", id: 1 });
  state.caches.push({
    id: 1,
    entries: [
      { request: request(), response: response(new ArrayBuffer(2048)) },
    ],
  });
  assert.ok(cacheStateBytes(state) > before + 2048);
});
test("Trusted cache owner denies frontend/credentials/nonHTTP before attaching a port", () => {
  const port = {
    addEventListener() {
      assert.fail("must not bind");
    },
  };
  for (const website of [
    "https://frontend.test/x",
    "https://frontend.test:444/x",
    "https://u:p@site.test",
    "file:///private",
    "data:text/html,x",
  ])
    assert.throws(
      () =>
        bindSandboxCaches({
          port,
          documentId: "doc",
          website,
          frontendOrigin: "https://frontend.test",
          factory: {},
        }),
      { name: "TypeError" },
    );
});
