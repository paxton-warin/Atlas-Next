import test from "node:test";
import assert from "node:assert/strict";
import { compileRuntimeFixture } from "./runtime-fixture.mjs";
test("transpile-only real controller fixture recursively serves current static dependencies without a manual allowlist", () => {
  const modules = compileRuntimeFixture([
    "sandbox-controller",
    "sandbox-storage-owner",
    "sandbox-storage-worker",
    "sandbox-local-storage",
  ]);
  for (const name of [
    "sandbox-controller",
    "original-document-policy",
    "original-document-plan",
    "inline-svg",
    "native-srcset",
    "page-controls-protocol",
    "sandbox-broker",
    "sandbox-idb",
    "sandbox-network",
  ])
    assert.ok(modules.has(name), name);
  for (const source of modules.values())
    for (const match of source.matchAll(
      /(?:from\s*|import\s*)["']\.\/([a-z0-9-]+)\.js["']/g,
    ))
      assert.ok(modules.has(match[1]), match[1]);
  assert.equal(
    compileRuntimeFixture(["sandbox-controller", "sandbox-controller"]).size,
    compileRuntimeFixture(["sandbox-controller"]).size,
  );
});
test("runtime fixture names never permit paths or external module traversal", () => {
  for (const name of [
    "../server/app",
    "https://host/script",
    "sandbox-controller.ts",
    "",
    "a/b",
    null,
  ])
    assert.throws(() => compileRuntimeFixture([name]), TypeError);
});
test("worker fixture can explicitly bind its pinned JavaScript lexer, but never silently allow other external imports", () => {
  assert.throws(
    () => compileRuntimeFixture(["opaque-workers"]),
    /Unsupported fixture dependency/,
  );
  const modules = compileRuntimeFixture(["opaque-workers"], {
    externalSpecifiers: ["es-module-lexer/minimal/js"],
  });
  assert.ok(modules.has("opaque-xhr"));
  assert.ok(modules.has("resource-response-budget"));
  assert.ok(modules.has("original-document-policy"));
  assert.match(
    modules.get("opaque-runtime-adapter"),
    /["']\.\/dom\/storage\.ts["']/,
    "preserve ABI keys outside true import/export literals",
  );
  for (const externalSpecifiers of [
    ["../server"],
    ["https://host/file"],
    ["a/../b"],
    ["a//b"],
    [null],
  ])
    assert.throws(
      () => compileRuntimeFixture(["opaque-workers"], { externalSpecifiers }),
      TypeError,
    );
});
