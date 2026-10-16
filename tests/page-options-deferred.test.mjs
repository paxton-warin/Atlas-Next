import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as runtimeLinks from "../runtime/direct-tab.ts";

const read = (name) =>
  readFileSync(new URL("../web/src/" + name, import.meta.url), "utf8");

test("deferred Page options has no menu entry, panel mount or menu state wiring", () => {
  for (const name of ["App.tsx", "Popout.tsx", "BrowsingOptions.tsx"]) {
    const source = read(name);
    assert.doesNotMatch(
      source,
      /CompatibilityPanel|pageOptions|pageOptionsAvailable|pageOpen|setPageOpen|Page options/,
      name,
    );
  }
  const menu = read("BrowsingOptions.tsx");
  assert.match(menu, /Connection options/);
  assert.match(menu, /Session pinned/);
  assert.match(menu, /Reconnect node/);
  assert.match(menu, /Open direct node tab/);
  assert.match(read("App.tsx"), /<BrowsingOptions/);
  assert.match(read("Popout.tsx"), /<BrowsingOptions/);
});

test("same-origin compatibility mode omits the outer sandbox only when explicitly activated", () => {
  assert.equal(typeof runtimeLinks.runtimeFrameSandbox, "function");
  assert.equal(
    runtimeLinks.runtimeFrameSandbox({
      runtimeProtocols: { sameOrigin: { activated: true } },
    }),
    undefined,
  );
  for (const config of [
    undefined,
    {},
    { runtimeProtocols: { sameOrigin: { activated: false } } },
    { runtimeProtocols: { sameOrigin: { activated: "true" } } },
    { runtimeProtocols: { opaque: { activated: true } } },
  ])
    assert.match(
      runtimeLinks.runtimeFrameSandbox(config),
      /^allow-scripts allow-same-origin .*allow-presentation$/,
    );
});

test("both actual outer iframe mounts use the mode-specific sandbox helper", () => {
  for (const name of ["App.tsx", "Popout.tsx"]) {
    const source = read(name);
    const tree = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let found = 0;
    function visit(node) {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText(tree) === "iframe"
      ) {
        const attributes = node.attributes.properties;
        const title = attributes.find(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(tree) === "title",
        );
        if (
          title?.initializer &&
          ts.isStringLiteral(title.initializer) &&
          title.initializer.text === "Atlas isolated browsing runtime"
        ) {
          const sandbox = attributes.find(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(tree) === "sandbox",
          );
          assert.ok(
            sandbox?.initializer && ts.isJsxExpression(sandbox.initializer),
            name,
          );
          assert.match(
            sandbox.initializer.expression.getText(tree),
            /^runtimeFrameSandbox\(/,
            name,
          );
          found++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.equal(found, 1, name);
  }
});
