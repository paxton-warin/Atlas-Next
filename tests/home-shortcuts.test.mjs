import test from "node:test";
import assert from "node:assert/strict";
import { shortcutInitials, shortcutURL } from "../web/src/shortcuts.ts";

test("home shortcuts use letters from names, including custom and international names", () => {
  for (const [name, expected] of [
    ["Google", "G"],
    ["YouTube", "Y"],
    ["ChatGPT", "C"],
    ["Spotify", "S"],
    ["  Khan Academy ", "KA"],
    ["New York Times", "NY"],
    ["école", "É"],
    ["中文 网站", "中网"],
  ])
    assert.equal(shortcutInitials(name), expected);
});
test("bare domains get HTTPS while explicit website addresses retain their scheme, paths and parameters", () => {
  for (const [value, expected] of [
    [" example.com ", "https://example.com/"],
    ["www.example.com/a?q=1#top", "https://www.example.com/a?q=1#top"],
    ["https://example.com/a", "https://example.com/a"],
    ["http://example.com:8080/a", "http://example.com:8080/a"],
    ["example.com:8080/a", "https://example.com:8080/a"],
    ["//example.com/a", "https://example.com/a"],
    ["例え.テスト", "https://xn--r8jz45g.xn--zckzah/"],
    ["localhost:3000", "https://localhost:3000/"],
  ])
    assert.equal(shortcutURL(value), expected);
});
test("invalid domains do not silently become searches or executable shortcuts", () => {
  for (const value of [
    "",
    "just a search",
    "notadomain",
    "-bad.example",
    "bad_.example",
    "https://",
    "javascript:alert(1)",
    "data:text/html,test",
    "ftp://example.com",
    "https://user:password@example.com/",
  ])
    assert.throws(() => shortcutURL(value), Error, value);
});
