import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const cssPath = process.env.ATLAS_HISTORY_CSS || new URL('../web/src/sidebar-responsive.css', import.meta.url);
test('horizontal tabs explicitly expose the existing 44px history control after the shared hide rule', async () => {
  const css = await readFile(cssPath, 'utf8');
  const selector = 'body.atlas-v21 .atlas.sidebar-adaptive.top-tabs .compact-history';
  const start = css.indexOf(selector + ' {');
  assert.ok(start > css.indexOf(':is(.rail-utilities-toggle,.compact-history,.rail-tool-label)'), 'horizontal override must follow shared hidden rule');
  const rule = css.slice(start, css.indexOf('}', start));
  for (const declaration of ['display:inline-flex', 'flex:none', 'width:44px', 'min-width:44px', 'height:44px', 'min-height:44px']) assert.ok(rule.includes(declaration), declaration);
  assert.ok(css.includes(selector + '>span { display:none; }'), 'keep the icon compact with the existing accessible name');
});
test('history still uses the existing dialog, saved entries and click handler', async () => {
  const app = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /className="icon-button compact-history"[^>]+aria-label="Recently visited"[^>]+onClick=\{\(\) => setHistoryOpen\(true\)\}/);
  assert.match(app, /aria-label="Browsing history"/);
  assert.match(app, /readLocal<any\[\]>\("atlas.history", \[\]\)/);
});
