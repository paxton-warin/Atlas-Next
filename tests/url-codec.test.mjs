import test from "node:test";
import assert from "node:assert/strict";
import { encodeTarget, decodeTarget } from "../runtime/url-codec.ts";
import { directTabTarget, createDirectTabUrl } from "../runtime/direct-tab.ts";

test("compact codec round-trips URLs, query strings, fragments, Unicode and reserved bytes", () => {
  for (const value of [
    "",
    "https://www.coolmathgames.com/games?q=café 😀&next=%2F#saved",
    "https://chatgpt.com/api/auth/callback?state=abc+def%26x",
    "http://127.0.0.1:4199/fixture",
  ]) {
    assert.equal(decodeTarget(encodeTarget(value)), value);
    if (value) assert.match(encodeTarget(value), /^v1\.[\w-]+$/);
  }
  assert.ok(
    !encodeTarget("https://www.coolmathgames.com/games").includes(
      "coolmathgames",
    ),
  );
});
test("codec functions serialize without dependencies for injected realms", () => {
  const encode = (0, eval)("(" + encodeTarget.toString() + ")");
  const decode = (0, eval)("(" + decodeTarget.toString() + ")");
  const url = "https://example.test/日本語?x=😀";
  assert.equal(decode(encode(url)), url);
});
test("legacy escaped routes/direct bookmarks remain readable, invalid compact inputs fail", () => {
  assert.equal(
    decodeTarget(encodeURIComponent("https://example.test/path?q=1")),
    "https://example.test/path?q=1",
  );
  assert.equal(
    directTabTarget(new URLSearchParams("goto=https%3A%2F%2Fexample.test%2F")),
    "https://example.test/",
  );
  for (const value of ["v1.!", "v1.a", "v1._w"])
    assert.throws(() => decodeTarget(value));
  assert.throws(() =>
    directTabTarget(new URLSearchParams({ page: "x".repeat(12001) })),
  );
  const url = new URL(
    createDirectTabUrl(
      "https://node.test",
      "https://www.coolmathgames.com/games",
    ),
  );
  assert.equal(
    directTabTarget(new URLSearchParams(url.hash.slice(1))),
    "https://www.coolmathgames.com/games",
  );
  assert.equal(new URLSearchParams(url.hash.slice(1)).has("goto"), false);
});
