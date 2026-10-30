import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const atlas = new URL("../web/", import.meta.url);
const hub = new URL("../../Atlas-Link-Dispenser/apps/web/", import.meta.url);
const apps = [
  { name: "Atlas", root: atlas, file: "AtlasEntryFrame", pending: "pending", message: "message", copy: "hub-gate-copy" },
  { name: "Hub", root: hub, file: "HubEntry", pending: "busy", message: "stage", copy: "hub-entry-copy" },
];

// Execute the actual hook/component with deterministic React hook slots and timers.
// No browser clock, network request, auth callback, or motion preference owns the delay.
function fixture(app, reducedMotion = false) {
  let now = 0, nextTimer = 0, cursor = 0, effectCursor = 0, dirty = false;
  const state = [], effects = [], queued = [], timers = new Map();
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = initial;
      return [state[slot], (value) => {
        if (state[slot] !== value) { state[slot] = value; dirty = true; }
      }];
    },
    useEffect(effect, dependencies) {
      const slot = effectCursor++, prior = effects[slot];
      if (!prior || dependencies.some((value, i) => value !== prior.dependencies[i])) {
        queued.push(() => {
          prior?.cleanup?.();
          effects[slot] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  function load(file, imports = {}) {
    const exports = {};
    const source = ts.transpileModule(readFileSync(new URL(`src/${file}`, app.root), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    runInNewContext(source, {
      exports,
      require: (name) => name in imports ? imports[name] : name.endsWith(".css") ? {} : require(name),
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      matchMedia: () => ({ matches: reducedMotion }),
    });
    return exports;
  }
  const hook = load("use-entry-copy.ts", { react });
  const imports = { "./use-entry-copy": hook };
  if (app.name === "Hub") imports["./AtlasBrandMark"] = load("AtlasBrandMark.tsx");
  const component = load(`${app.file}.tsx`, imports)[app.file];
  return {
    render(props = {}) {
      let element, passes = 0;
      do {
        dirty = false; cursor = 0; effectCursor = 0;
        element = component(props);
        while (queued.length) queued.shift()();
        assert.ok(++passes < 5, "hook settles without a render loop");
      } while (dirty);
      return renderToStaticMarkup(element);
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].callback();
      }
      now = end;
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
    get timers() { return timers.size; },
  };
}

for (const app of apps) {
  for (const reducedMotion of [false, true]) {
    test(`${app.name}: fast resolution reveals its result immediately, with motion reduced=${reducedMotion}`, () => {
      const f = fixture(app, reducedMotion);
      const initial = f.render();
      assert.match(initial, /style="visibility:hidden" aria-hidden="true"/);
      assert.doesNotMatch(initial, /role="status"|aria-live=|aria-labelledby=/);
      assert.match(initial, /data-entry-card="true"/);
      f.advance(140);
      const ready = f.render({ [app.pending]: false, title: "Welcome to Atlas", [app.message]: "Sign in to continue.", children: createElement("button", null, "Sign in") });
      assert.doesNotMatch(ready, /visibility:hidden|entry-spinner/);
      assert.match(ready, /Welcome to Atlas/);
      assert.match(ready, /<button>Sign in<\/button>/);
      assert.equal(f.timers, 0);
      f.advance(500);
      f.unmount();
    });
    test(`${app.name}: one continuous wait reveals the latest stage at 200ms, with motion reduced=${reducedMotion}`, () => {
      const f = fixture(app, reducedMotion);
      f.render();
      f.advance(100);
      assert.match(f.render({ [app.message]: "Verifying your session…" }), /visibility:hidden/);
      f.advance(99);
      assert.match(f.render({ [app.message]: "Restoring your browser…" }), /visibility:hidden/);
      f.advance(1);
      const waiting = f.render({ [app.message]: "Restoring your browser…" });
      assert.doesNotMatch(waiting, /visibility:hidden/);
      assert.match(waiting, /role="status" aria-live="polite"/);
      assert.match(waiting, /Restoring your browser…/);
      assert.doesNotMatch(waiting, /Verifying your session…/);
      assert.equal(f.timers, 0);
      f.unmount();
    });
  }
  test(`${app.name}: failure and recovery controls are immediate; unmount cancels busy timers`, () => {
    const f = fixture(app);
    f.render(); f.advance(25);
    const failed = f.render({ [app.pending]: false, error: "Connection lost.", title: "Atlas could not open", [app.message]: "Sign-in needs attention.", children: createElement("button", null, "Retry") });
    assert.doesNotMatch(failed, /visibility:hidden/);
    assert.match(failed, /Atlas could not open/);
    assert.match(failed, /<button>Retry<\/button>/);
    assert.equal(f.timers, 0);
    const retried = f.render();
    assert.match(retried, /visibility:hidden/);
    assert.equal(f.timers, 1);
    f.unmount();
    assert.equal(f.timers, 0);
    f.advance(500);
  });
  test(`${app.name}: initial document conceals only reserved copy before React and CSS arrive`, () => {
    const html = readFileSync(new URL("index.html", app.root), "utf8");
    assert.ok(html.includes(`<div class="${app.copy}" style="visibility:hidden" aria-hidden="true">`));
    assert.match(html, /data-entry-card/);
    assert.doesNotMatch(html, /role="status"|aria-live=|aria-labelledby=/);
    const css = readFileSync(new URL("src/entry-v21.css", app.root), "utf8");
    assert.match(css, /min-height:288px/);
    assert.doesNotMatch(css, /(?:animation-delay|transition|backdrop-filter)/);
  });
}

test("Atlas: an error bypasses busy concealment without hiding alerts or import cancellation", () => {
  const f = fixture(apps[0]);
  f.render(); f.advance(25);
  const failed = f.render({ error: "Connection lost.", children: createElement("button", null, "Skip import") });
  assert.doesNotMatch(failed, /visibility:hidden/);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Connection lost\./);
  assert.match(failed, /<button>Skip import<\/button>/);
  assert.equal(f.timers, 0);
  f.unmount();
});

test("Atlas and Hub keep the same small presentation-only hook", () => {
  const source = (app) => readFileSync(new URL("src/use-entry-copy.ts", app.root), "utf8");
  assert.equal(source(apps[0]), source(apps[1]));
  assert.match(source(apps[0]), /setTimeout\(\(\) => setVisible\(true\), 200\)/);
  assert.doesNotMatch(source(apps[0]), /fetch|location|navigate|matchMedia|requestAnimationFrame/);
});
