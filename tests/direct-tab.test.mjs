import test from "node:test";
import assert from "node:assert/strict";
import {
  createDirectTabUrl,
  createRuntimeFrameUrl,
  directTabTarget,
  SAME_ORIGIN_RUNTIME_PATH,
} from "../runtime/direct-tab.ts";

test("same-frontend direct tabs and iframe reloads retain the dedicated runtime path", () => {
  const frontend = "https://frontend.example";
  const ticket = "signed.boot.ticket";
  const direct = new URL(
    createDirectTabUrl(
      frontend,
      "https://website.example/article",
      ticket,
      false,
      SAME_ORIGIN_RUNTIME_PATH,
    ),
  );
  assert.equal(direct.origin, frontend);
  assert.equal(direct.pathname, "/browse/runtime/");
  assert.equal(direct.search, "");
  assert.equal(
    directTabTarget(new URLSearchParams(direct.hash.slice(1))),
    "https://website.example/article",
  );
  const embedded = new URL(
    createRuntimeFrameUrl(frontend, ticket, SAME_ORIGIN_RUNTIME_PATH, 2),
  );
  assert.equal(embedded.pathname, "/browse/runtime/");
  assert.equal(embedded.search, "?session=2");
  assert.equal(embedded.hash, "#ticket=signed.boot.ticket");
  assert.equal(
    createRuntimeFrameUrl(frontend, undefined, SAME_ORIGIN_RUNTIME_PATH),
    frontend + "/browse/runtime/",
  );
  assert.equal(
    createRuntimeFrameUrl("https://node.example", ticket),
    "https://node.example/#ticket=signed.boot.ticket",
  );
});

test("runtime routes cannot point the shell at APIs, queries or another origin", () => {
  for (const path of [
    "/api/config",
    "//different.example/",
    "https://different.example/",
    "/browse/runtime/?ticket=secret",
    "/browse/runtime/#ticket=secret",
    "/browse/runtime/../",
    "browse/runtime/",
  ]) {
    assert.throws(() =>
      createRuntimeFrameUrl("https://frontend.example", "ticket", path),
    );
    assert.throws(() =>
      createDirectTabUrl(
        "https://frontend.example",
        "https://website.example/",
        "ticket",
        true,
        path,
      ),
    );
  }
});

test("direct browsing URL uses assigned node root and keeps target/ticket only in its fragment", () => {
  const target = "https://play.example/game?q=hello world&return=%2Fhome#saved";
  const ticket = "opaque.ticket+with/characters=";
  const url = new URL(
    createDirectTabUrl("https://NODE.example:443", target, ticket),
  );
  assert.equal(url.origin, "https://node.example");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(directTabTarget(fragment), new URL(target).href);
  assert.equal(fragment.get("ticket"), ticket);
  assert.equal(url.href.split("#")[0], "https://node.example/");
});

test("direct browsing supports loopback development and optional un-ticketed runtime", () => {
  const url = new URL(
    createDirectTabUrl(
      "http://127.0.0.1:4181",
      "http://127.0.0.1:4199/fixture",
    ),
  );
  assert.equal(url.origin, "http://127.0.0.1:4181");
  assert.equal(new URLSearchParams(url.hash.slice(1)).has("ticket"), false);
});

test("direct browsing rejects non-root runtime URLs, credentials and non-web schemes", () => {
  for (const runtime of [
    "javascript:alert(1)",
    "file:///tmp/test",
    "https://user:pass@node.example",
    "https://node.example/path",
    "https://node.example/?ticket=secret",
    "https://node.example/#ticket=secret",
    "invalid",
  ])
    assert.throws(() => createDirectTabUrl(runtime, "https://site.example"));
  for (const target of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "about:blank",
    "blob:https://site.example/test",
    "https://user:pass@site.example",
    "https://node.example/internal",
    "relative/path",
  ])
    assert.throws(() => createDirectTabUrl("https://node.example", target));
});

test("direct browsing rejects empty or oversized supplied tickets and oversized targets", () => {
  for (const ticket of ["", "x".repeat(32769), 123, null])
    assert.throws(() =>
      createDirectTabUrl(
        "https://node.example",
        "https://site.example",
        ticket,
      ),
    );
  assert.throws(() =>
    createDirectTabUrl(
      "https://node.example",
      "https://site.example/" + "x".repeat(8192),
    ),
  );
});

test("direct browsing carries explicit YouTube opt-out in the fragment only", () => {
  for (const enabled of [true, false]) {
    const url = new URL(
      createDirectTabUrl(
        "https://node.example",
        "https://www.youtube.com/watch?v=fixture",
        "fixture-ticket",
        enabled,
      ),
    );
    const fragment = new URLSearchParams(url.hash.slice(1));
    assert.equal(fragment.get("adblock"), enabled ? null : "0");
    assert.equal(fragment.get("ticket"), "fixture-ticket");
    assert.equal(url.search, "");
  }
});
