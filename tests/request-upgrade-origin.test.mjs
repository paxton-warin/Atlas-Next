import test from "node:test";
import assert from "node:assert/strict";
import { createUpgradeOrigin } from "../server/request-origin.mjs";
const req = (address = "172.30.81.3", headers = {}) => ({
  headers: {
    host: "origin.internal",
    "x-forwarded-host": "selected.cloudfront.net",
    "x-forwarded-proto": "https",
    ...headers,
  },
  socket: { remoteAddress: address },
});
test("raw upgrade preserves trusted CloudFront viewer host and HTTPS, not internal HTTP/origin host", () => {
  const origin = createUpgradeOrigin("http://localhost:4183", ["172.30.81.3"]);
  assert.equal(origin(req()), "https://selected.cloudfront.net");
  assert.equal(
    origin(req("::ffff:172.30.81.3")),
    "https://selected.cloudfront.net",
  );
  assert.equal(
    origin(
      req("172.30.81.3", {
        "x-forwarded-host": "untrusted.invalid, selected.cloudfront.net",
      }),
    ),
    "https://selected.cloudfront.net",
  );
});
test("untrusted direct peers cannot use forwarded headers to forge WSS target or frontend aliases", () => {
  const origin = createUpgradeOrigin("https://configured.example", [
    "172.30.81.3",
  ]);
  assert.equal(origin(req("203.0.113.9")), "http://origin.internal");
  assert.equal(
    origin({
      ...req("203.0.113.9"),
      socket: { remoteAddress: "203.0.113.9", encrypted: true },
    }),
    "https://origin.internal",
  );
  assert.equal(
    createUpgradeOrigin("https://configured.example")(req()),
    "http://origin.internal",
  );
});
test("raw upgrade accepts only normalized HTTP(S) origins, while wrapped HTTP requests keep Fastify trust decisions", () => {
  const origin = createUpgradeOrigin("http://localhost:4183", [
    "172.30.81.0/24",
  ]);
  for (const host of [
    "name:secret@example.com",
    "example.com/path",
    "example.com?query",
  ])
    assert.throws(() =>
      origin(req("172.30.81.3", { "x-forwarded-host": host })),
    );
  assert.throws(() =>
    origin(req("172.30.81.3", { "x-forwarded-proto": "file" })),
  );
  assert.equal(
    origin({
      raw: {},
      headers: { host: "internal" },
      host: "trusted-http.example",
      protocol: "https",
    }),
    "https://trusted-http.example",
  );
});
