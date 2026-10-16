import test from "node:test";
import assert from "node:assert/strict";
import {
  cookieSchemefulSite,
  cookieDomainMatches,
  cookiePathMatches,
  parseCookieDate,
} from "../runtime/sandbox-cookies.ts";

test("cookie sites use private PSL boundaries and distinguish schemes, not ports", () => {
  assert.equal(
    cookieSchemefulSite("https://a.example.co.uk:8443/path"),
    "https://example.co.uk",
  );
  assert.equal(
    cookieSchemefulSite("https://a.tenant.github.io"),
    "https://tenant.github.io",
  );
  assert.notEqual(
    cookieSchemefulSite("https://other.github.io"),
    cookieSchemefulSite("https://tenant.github.io"),
  );
  assert.equal(
    cookieSchemefulSite("https://a.example:444"),
    cookieSchemefulSite("https://a.example:555"),
  );
  assert.notEqual(
    cookieSchemefulSite("http://a.example"),
    cookieSchemefulSite("https://a.example"),
  );
});
test("cookie site canonicalization uses URL IDNA and preserves address sites", () => {
  assert.equal(
    cookieSchemefulSite("https://éxample.com/path"),
    "https://xn--xample-9ua.com",
  );
  assert.equal(
    cookieSchemefulSite("http://127.0.0.1:9000"),
    "http://127.0.0.1",
  );
  assert.equal(cookieSchemefulSite("http://[::1]:9000"), "http://[::1]");
  assert.throws(() => cookieSchemefulSite("file:///tmp/a"), TypeError);
  assert.throws(
    () => cookieSchemefulSite("https://user:secret@a.example"),
    TypeError,
  );
});
test("domain matching uses label boundaries, not text suffixes", () => {
  assert.equal(cookieDomainMatches("sub.example.com", "example.com"), true);
  assert.equal(cookieDomainMatches("example.com", "example.com"), true);
  assert.equal(cookieDomainMatches("evil-example.com", "example.com"), false);
  assert.equal(cookieDomainMatches("example.com.evil", "example.com"), false);
  assert.equal(cookieDomainMatches("127.0.0.1", "0.0.1"), false);
  assert.equal(cookieDomainMatches("127.0.0.1", "127.0.0.1"), true);
});
test("cookie path matching distinguishes slash boundaries", () => {
  assert.equal(cookiePathMatches("/account", "/account"), true);
  assert.equal(cookiePathMatches("/account/settings", "/account"), true);
  assert.equal(cookiePathMatches("/accounting", "/account"), false);
  assert.equal(cookiePathMatches("/account/settings", "/account/"), true);
  assert.equal(cookiePathMatches("/", "/"), true);
});
test("cookie-date parser handles legacy separators and two-digit years", () => {
  const target = Date.UTC(2026, 5, 9, 10, 18, 14);
  assert.equal(parseCookieDate("Wed, 09 Jun 2026 10:18:14 GMT"), target);
  assert.equal(parseCookieDate("Wed, 09-Jun-26 10:18:14 GMT"), target);
  assert.equal(parseCookieDate("Wednesday Jun 9 10:18:14 2026"), target);
  assert.equal(parseCookieDate("Thu, 01 Jan 70 00:00:00 GMT"), 0);
  assert.equal(
    parseCookieDate("Fri, 01 Jan 69 00:00:00 GMT"),
    Date.UTC(2069, 0, 1),
  );
});
test("invalid dates do not accidentally expire or persist cookies", () => {
  for (const value of [
    "garbage",
    "Wed, 09 Jun 1599 10:18:14 GMT",
    "Wed, 32 Jun 2026 10:18:14 GMT",
    "Wed, 09 Jun 2026 24:18:14 GMT",
    "Wed, 09 Foo 2026 10:18:14 GMT",
  ])
    assert.equal(parseCookieDate(value), undefined, value);
});
