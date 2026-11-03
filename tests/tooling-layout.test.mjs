import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'tools/TOOLING-MAP.json'), 'utf8'));
const read = relative => readFileSync(join(root, relative), 'utf8');
const javascript = relative => ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

test('Optional tools have one canonical categorized location and no old wrapper duplicates', () => {
  assert.equal(manifest.schema, 'atlas-tooling-layout-v1');
  assert.ok(manifest.moves.length > 100);
  assert.equal(new Set(manifest.moves.map(x => x.from)).size, manifest.moves.length);
  assert.equal(new Set(manifest.moves.map(x => x.to)).size, manifest.moves.length);
  for (const { from, to } of manifest.moves) {
    assert.equal(existsSync(join(root, from)), false, `Old optional-tool copy remains: ${from}`);
    assert.equal(existsSync(join(root, to)), true, `Missing relocated optional tool: ${to}`);
    assert.match(to, /^tools\/(diagnostics|lab|experiments|legacy)\//);
  }
});

test('Moved JavaScript tool module imports and import-relative data paths resolve inside the checkout', () => {
  let checked = 0;
  for (const { to } of manifest.moves) {
    if (!to.endsWith('.mjs')) continue;
    const source = javascript(to);
    function check(specifier) {
      if (!specifier.startsWith('.')) return;
      const path = resolve(root, dirname(to), specifier);
      assert.ok(path === resolve(root) || path.startsWith(resolve(root) + '/'), `${to}: import escapes checkout: ${specifier}`);
      assert.equal(existsSync(path), true, `${to}: missing module/data ${specifier}`);
      checked++;
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && node.arguments?.length >= 2 && node.arguments[1].getText(source) === 'import.meta.url') {
        const argument = node.arguments[0];
        if (ts.isStringLiteral(argument)) check(argument.text);
        else if (ts.isBinaryExpression(argument) && ts.isStringLiteral(argument.left)) check(argument.left.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(checked > 60, `Expected a meaningful module graph, checked ${checked}`);
});

test('Source callers use categorized entrypoints instead of former optional scripts paths', () => {
  let checked = 0;
  function scan(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (['node_modules', '__pycache__'].includes(entry.name)) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && /\.(mjs|ts|sh|py)$/.test(path)) {
        const source = read(path);
        for (const { from } of manifest.moves) assert.equal(source.includes(from), false, `${path}: stale ${from}`);
        checked++;
      }
    }
  }
  for (const path of ['scripts', 'tests', 'tools']) scan(path);
  assert.ok(checked > 400);
});

test('Module-derived laboratory roots keep their existing checkout boundaries after moving', () => {
  assert.match(read('tools/diagnostics/hub-continuity-review.mjs'), /resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\),'\.\.\/\.\.'\)/);
  assert.match(read('tools/diagnostics/hub-local-review.mjs'), /new URL\('\.\.\/\.\.', import\.meta\.url\)/);
  assert.match(read('tools/lab/perf-staging/stack.mjs'), /resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\),'\.\.\/\.\.\/\.\.'\)/);
});
