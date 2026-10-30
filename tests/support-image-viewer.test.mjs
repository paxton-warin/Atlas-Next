import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
async function helpers() {
  const source = await readFile(process.env.ATLAS_SUPPORT_MEDIA_SOURCE || new URL('../web/src/SupportMedia.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function supportImageFit('), end = source.indexOf('const visibilitySubscribers', start);
  assert.ok(start >= 0 && end > start, 'inline image viewer helpers must exist');
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; runInNewContext(compiled, { exports }); return exports;
}
test('viewer fits camera images on narrow screens without forced upscaling', async () => {
  const { supportImageFit: fit } = await helpers();
  const scale = fit(5712, 4284, 288, 480);
  assert.ok(scale < 0.1 && scale > 0);
  assert.ok(5712 * scale <= 288 && 4284 * scale <= 480);
  assert.equal(fit(32, 32, 1200, 800), 1);
  assert.equal(fit(0, 100, 300, 300), 1);
});
test('viewer zoom bounds retain small fit scales and cap explicit enlargement', async () => {
  const { supportImageZoom: zoom } = await helpers();
  assert.equal(zoom(10), 4);
  assert.equal(zoom(-1), 0.1);
  assert.equal(zoom(0.03, 0.02), 0.03);
  assert.equal(zoom(-1, 0.02), 0.02);
  assert.equal(zoom(NaN), 1);
});
