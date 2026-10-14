// Reproducible, local-only analysis fixture. Do not install the extension or run
// its browser entrypoint. No proprietary helper code is bundled into Atlas.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
const [
  source,
  output = "evidence/filter-surface-20261013/reference-detector.fixture.js",
] = process.argv.slice(2);
if (!source)
  throw Error(
    "Usage: node scripts/prepare-filter-reference-fixture.mjs CONTENT_JS [OUTPUT_JS]",
  );
const expected =
  "5439c9e4270da5dcf8f7866e3a78455f6e8530447fc154d3029ffac130550a5d";
const raw = readFileSync(source, "utf8");
if (createHash("sha256").update(raw).digest("hex") !== expected)
  throw Error("Reference source differs from the inspected pinned helper");
let tree = ts.createSourceFile(
  "content.js",
  raw,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
if (tree.parseDiagnostics.length) throw Error("Reference parse failed");
const unwrap = (n) =>
  ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;
let rotation = unwrap(
  tree.statements.find((n) => ts.isExpressionStatement(n)).expression,
);
while (
  ts.isBinaryExpression(rotation) &&
  rotation.operatorToken.kind === ts.SyntaxKind.CommaToken
)
  rotation = unwrap(rotation.left);
if (!ts.isCallExpression(rotation)) throw Error("Unexpected decoder bootstrap");
const functions = tree.statements.filter((n) => ts.isFunctionDeclaration(n));
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
vm.runInContext(
  functions.map((n) => n.getText(tree)).join("\n") +
    "\n(" +
    rotation.getText(tree) +
    ");",
  context,
  { timeout: 1500 },
);
const nodes = [];
function walk(n) {
  nodes.push(n);
  ts.forEachChild(n, walk);
}
walk(tree);
const aliases = new Set(["a0_0x2e08"]);
let changed = true;
while (changed) {
  changed = false;
  for (const n of nodes)
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      aliases.has(n.initializer.text) &&
      !aliases.has(n.name.text)
    ) {
      aliases.add(n.name.text);
      changed = true;
    }
}
const edits = [];
for (const n of nodes)
  if (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    aliases.has(n.expression.text) &&
    n.arguments.length &&
    ts.isNumericLiteral(n.arguments[0])
  ) {
    const value = context.a0_0x2e08(Number(n.arguments[0].getText(tree)));
    if (typeof value !== "string") throw Error("Unresolved reference lookup");
    edits.push({
      start: n.getStart(tree),
      end: n.end,
      text: JSON.stringify(value),
    });
  }
let decoded = raw;
for (const e of edits.sort((a, b) => b.start - a.start))
  decoded = decoded.slice(0, e.start) + e.text + decoded.slice(e.end);
tree = ts.createSourceFile(
  "decoded.js",
  decoded,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const parts = [];
function modules(n) {
  if (ts.isMethodDeclaration(n) && ts.isNumericLiteral(n.name)) {
    parts.push(
      n.name.text +
        ":function(" +
        n.parameters.map((p) => p.name.text).join(",") +
        ")" +
        n.body.getText(tree),
    );
    return;
  }
  ts.forEachChild(n, modules);
}
modules(tree);
const code = `(()=>{const a0_0x2e08=()=>{throw Error('Unresolved lookup')};const factories={${parts.join(",")}};const cache={};function load(id){if(cache[id])return cache[id].exports;if(!factories[id])throw Error('Missing module '+id);const m={exports:{}};cache[id]=m;factories[id](m,m.exports,load);return m.exports;}load.d=(target,props)=>Object.entries(props).forEach(([k,get])=>Object.defineProperty(target,k,{get,enumerable:true}));load.r=o=>Object.defineProperty(o,'__esModule',{value:true});load.n=o=>()=>o;const m=load(0x257f);globalThis.referenceOrchestrator=m.DetectionOrchestrator;globalThis.referenceExports=Object.keys(m);})();`;
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, code);
console.log(
  "REFERENCE_SOURCE_SHA256=" +
    expected +
    "; FACTORY_MODULES=" +
    parts.length +
    "; EXTENSION_ENTRYPOINT=NOT_RUN; OUTPUT=" +
    output,
);
