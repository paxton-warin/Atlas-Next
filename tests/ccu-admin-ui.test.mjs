import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = readFileSync(
  new URL("../web/src/AdminCcuMetrics.tsx", import.meta.url),
  "utf8",
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replace(
    /import \{ api \} from "\.\/model";/,
    "const api = async () => { throw new Error('SSR does not fetch'); };",
  )
  .replace(
    /from "(react(?:\/jsx-runtime)?)"/g,
    (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`,
  );
const { CcuSummary, NodeCcuCount } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const render = (component, props) =>
  renderToStaticMarkup(createElement(component, props));
const snapshot = {
  activeSessions: 91,
  complete: true,
  reportingNodes: 4,
  totalNodes: 4,
  updatedAt: Date.parse("2026-10-16T14:00:00Z"),
  freshnessMs: 45000,
};

test("CCU renders only its concise heading and count without redundant explanatory labels", () => {
  const html = render(CcuSummary, { snapshot });
  assert.match(html, /<h2>CCU<\/h2>/);
  assert.match(html, /aria-live="polite">91</);
  assert.doesNotMatch(
    html,
    /Live|Connected browser|Tabs|popouts|people|profiles|frontend URLs|reporting|Updated|Refreshes|<time|role="status"/,
  );
});

test("unknown nodes make fleet CCU an explicit lower bound, not a complete total", () => {
  const html = render(CcuSummary, {
    snapshot: { ...snapshot, complete: false, reportingNodes: 2 },
  });
  assert.match(html, /aria-live="polite">≥ 91</);
  assert.match(html, /role="status">2\/4 nodes</);
  assert.doesNotMatch(
    html,
    /Partial count|Unavailable nodes|Updated|Refreshes/,
  );
});

test("real zero, loading, and failed refresh are visibly distinct", () => {
  assert.match(
    render(CcuSummary, { snapshot: { ...snapshot, activeSessions: 0 } }),
    /aria-live="polite">0</,
  );
  assert.match(render(CcuSummary, { snapshot: null }), />Loading…</);
  const failed = render(CcuSummary, { snapshot, unavailable: true });
  assert.match(failed, /aria-live="polite">—</);
  assert.match(failed, />Unavailable</);
  assert.doesNotMatch(failed, /aria-live="polite">91</);
});

test("node CCU displays valid session counts independently from relay connections", () => {
  const html = render(NodeCcuCount, {
    node: { online: true, activeSessions: 12, connections: 100, sessions: 300 },
  });
  assert.match(html, />12 CCU</);
  assert.doesNotMatch(html, /connected browser sessions|100|300|<span/);
  assert.match(
    render(NodeCcuCount, { node: { online: true, activeSessions: 0 } }),
    />0 CCU</,
  );
});

test("offline, stale, unsupported, and failed-node refreshes never display cached CCU as live", () => {
  for (const node of [
    { online: false, activeSessions: 90 },
    { online: true, activeSessions: null },
    { online: true },
    { online: true, activeSessions: -1 },
    { online: true, activeSessions: 1.1 },
  ]) {
    const html = render(NodeCcuCount, { node });
    assert.match(html, />— CCU</);
    assert.match(html, /Unavailable/);
  }
  assert.match(
    render(NodeCcuCount, {
      node: { online: true, activeSessions: 90 },
      unavailable: true,
    }),
    />— CCU</,
  );
});

test("actual admin overview and node cards mount the live authenticated metrics", () => {
  const read = (name) =>
    readFileSync(new URL("../web/src/" + name, import.meta.url), "utf8");
  assert.match(read("Admin.tsx"), /<AdminCcuMetrics csrf=\{csrf\}/);
  assert.match(read("NodeSettings.tsx"), /<AdminCcuMetrics csrf=\{csrf\}/);
  assert.match(
    read("NodeSettings.tsx"),
    /<NodeCcuCount node=\{node\} unavailable=\{nodesUnavailable\}/,
  );
  assert.match(read("NodeSettings.tsx"), /relay connections/);
  assert.match(source, /"\/admin\/ccu"/);
  assert.match(source, /"x-atlas-csrf": csrf/);
  assert.match(source, /setInterval\(refresh, 15000\)/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /setTimeout\(abort, 10000\)/);
  assert.match(
    read("NodeSettings.tsx"),
    /setTimeout\(\(\) => controller\.abort\(\), 10000\)/,
  );
});
