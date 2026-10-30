import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
const legacy = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8');
const presentation = await readFile(new URL('../web/src/atlas-v21.css', import.meta.url), 'utf8');
const rule = (css, selector) => css.split(`\n${selector} {`)[1]?.split('}')[0] || '';

test('new-tab background is inside its isolated page, not behind the opaque workspace', () => {
  assert.match(source, /\{page === "home" && \(\s*<div className="home-page">\s*<div className=\{"ambient " \+ settings\.background\} aria-hidden="true" \/>/);
  assert.equal((source.match(/className=\{"ambient " \+ settings\.background\}/g) || []).length, 1);
  assert.match(rule(legacy, '.home-page'), /isolation:\s*isolate/);
  assert.match(rule(legacy, '.ambient'), /z-index:\s*-1/);
  assert.match(rule(legacy, '.ambient'), /pointer-events:\s*none/);
});

test('background dimming survives the presentation and light-mode cascade', () => {
  assert.match(rule(legacy, '.ambient'), /opacity:\s*calc\(1 - var\(--dim\)\)/);
  assert.doesNotMatch(legacy, /:root\[data-mode="light"\] \.atlas \.ambient\s*\{[^}]*opacity:/);
  assert.doesNotMatch(presentation, /\.ambient\s*\{[^}]*opacity:/);
});

test('static gradients use the active accent and blur applies only to the uploaded wallpaper', () => {
  for (const selector of ['.ambient.aurora', '.ambient.contour', '.home-section .ambient.aurora']) {
    const body = rule(legacy, selector);
    assert.match(body, /gradient\(/);
    assert.match(body, /var\(--accent\)/);
    assert.doesNotMatch(body, /(?:animation|filter):/);
  }
  assert.doesNotMatch(rule(legacy, '.ambient'), /filter:/);
  assert.match(rule(legacy, '.ambient.wallpaper'), /filter:\s*blur\(var\(--wallpaper-blur\)\)/);
  assert.match(rule(legacy, '.ambient.wallpaper'), /background-image:\s*var\(--wallpaper\)/);
  assert.match(presentation, /@media\(prefers-reduced-motion:reduce\)/);
});
