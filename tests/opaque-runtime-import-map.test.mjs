import test from "node:test";
import assert from "node:assert/strict";
import { OpaqueImportMap } from "../runtime/opaque-import-map.ts";
test("logical import maps resolve bare, normalized URL, longest prefix and strongest matching scope", () => {
  const map = new OpaqueImportMap("https://site.test/index.html");
  map.add({
    imports: { bare: "/global.js", "pkg/": "/package/", "/old.js": "/new.js" },
    scopes: {
      "/app/": { bare: "/app.js" },
      "/app/deep/": { bare: "/deep.js" },
    },
  });
  assert.equal(
    map.resolve("bare", "https://site.test/other.js"),
    "https://site.test/global.js",
  );
  assert.equal(
    map.resolve("bare", "https://site.test/app/entry.js"),
    "https://site.test/app.js",
  );
  assert.equal(
    map.resolve("bare", "https://site.test/app/deep/entry.js"),
    "https://site.test/deep.js",
  );
  assert.equal(
    map.resolve("pkg/sub/file.js"),
    "https://site.test/package/sub/file.js",
  );
  assert.equal(map.resolve("./x/../old.js"), "https://site.test/new.js");
});
test("prefix slash mismatches, null entries and backtracking fail closed", () => {
  const map = new OpaqueImportMap("https://site.test/");
  map.add({
    imports: { denied: null, "broken/": "/not-prefix", "pkg/": "/package/" },
  });
  assert.throws(() => map.resolve("denied"), TypeError);
  assert.throws(() => map.resolve("broken/x"), TypeError);
  assert.throws(() => map.resolve("pkg/../escape.js"), TypeError);
  assert.throws(() => map.resolve("unknown"), TypeError);
});
test("maps merge first definitions before resolution, integrity is bound to logical absolute URLs", () => {
  const map = new OpaqueImportMap("https://site.test/app/");
  map.add({
    imports: { bare: "one.js" },
    integrity: { "one.js": "sha384-original" },
  });
  map.add({ imports: { bare: "two.js", other: "other.js" } });
  assert.equal(map.resolve("bare"), "https://site.test/app/one.js");
  assert.equal(
    map.integrityFor("https://site.test/app/one.js"),
    "sha384-original",
  );
  assert.equal(map.resolve("other"), "https://site.test/app/other.js");
  assert.throws(() => map.add({ imports: { late: "late.js" } }), {
    name: "NotSupportedError",
  });
});
