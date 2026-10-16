import test from "node:test";
import assert from "node:assert/strict";
import { createOpaqueResourceGraph } from "../runtime/opaque-resource-graph.ts";
function setup(responses) {
  const calls = [],
    bases = [],
    maps = [];
  function get(name) {
    return this.attributes?.get(name) ?? null;
  }
  const element = (tag, attributes = {}) => ({
    localName: tag,
    attributes: new Map(Object.entries(attributes)),
    textContent: "",
    getAttribute: get,
  });
  const graph = createOpaqueResourceGraph({
    documentURL: "https://site.test/page",
    document: {
      documentElement: element("html"),
      head: {},
      createElement: (tag) => element(tag),
    },
    network: {
      fetch: async (url) => {
        calls.push(url);
        const r = responses[url];
        assert.ok(r, "Unexpected resource " + url);
        const response = new Response(r.body, {
          headers: { "content-type": r.type },
        });
        Object.defineProperties(response, {
          url: { value: r.url ?? url },
          type: { value: "basic" },
          redirected: { value: !!r.url && r.url !== url },
        });
        return response;
      },
    },
    rewriter: {
      context: { prefix: new URL("https://front.test/browse/logical/doc/") },
      restoreURL: (x) => x,
      originalCSS: (x) => x,
      module(source, url) {
        bases.push({ kind: "module", url });
        return { source };
      },
      javascript(source, url) {
        bases.push({ kind: "classic", url });
        return source;
      },
      stylesheet(source, url) {
        bases.push({ kind: "style", url });
        return {
          source: source.replace(
            /url\("([^"]+)"\)/g,
            (_m, value) =>
              'url("atlas-opaque-resource:' +
              encodeURIComponent(new URL(value, url).href) +
              '")',
          ),
          dependencies: [...source.matchAll(/url\("([^"]+)"\)/g)].map(
            (match) => new URL(match[1], url).href,
          ),
        };
      },
    },
    natives: {
      DOMParser: class {
        parseFromString() {}
      },
      Blob,
      createObjectURL: URL.createObjectURL,
      revokeObjectURL: URL.revokeObjectURL,
      importModule: () => {},
      getAttribute: get,
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      appendChild(node) {
        maps.push(node.textContent);
      },
    },
  });
  return { graph, calls, bases, maps, element };
}
test("redirected modules retain requested map identity but use FINAL URL for descendants and import metadata", async () => {
  const f = setup({
    "https://site.test/old/main.js": {
      url: "https://site.test/new/main.js",
      type: "application/javascript",
      body: "import './dep.js';export const value=1",
    },
    "https://site.test/new/dep.js": {
      type: "application/javascript",
      body: "export const dependency=1",
    },
  });
  try {
    const local = await f.graph.prepareModule("https://site.test/old/main.js");
    assert.ok(local.startsWith("blob:"));
    assert.deepEqual(f.calls, [
      "https://site.test/old/main.js",
      "https://site.test/new/dep.js",
    ]);
    assert.equal(f.bases[0].url, "https://site.test/new/main.js");
    const imports = Object.assign(
      {},
      ...f.maps.map((s) => JSON.parse(s).imports),
    );
    assert.ok(
      imports[
        "atlas-opaque-module:" +
          encodeURIComponent("https://site.test/old/main.js")
      ],
    );
    assert.ok(
      imports[
        "atlas-opaque-module:" +
          encodeURIComponent("https://site.test/new/dep.js")
      ],
    );
  } finally {
    f.graph.dispose();
  }
});
test("redirected styles resolve nested URLs from final stylesheet and preserve SVG fragment", async () => {
  const f = setup({
    "https://site.test/old/style.css": {
      url: "https://site.test/new/style.css",
      type: "text/css",
      body: 'body{background-image:url("./image.svg#tile")}',
    },
    "https://site.test/new/image.svg": {
      type: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    },
  });
  try {
    const link = f.element("link", {
      rel: "stylesheet",
      href: "https://site.test/old/style.css",
    });
    await f.graph.prepareElement(link);
    assert.deepEqual(f.calls, [
      "https://site.test/old/style.css",
      "https://site.test/new/image.svg",
    ]);
    assert.equal(f.bases[0].url, "https://site.test/new/style.css");
    const text = await (await fetch(link.attributes.get("href"))).text();
    assert.match(text, /#tile/);
  } finally {
    f.graph.dispose();
  }
});
test("redirected classic JavaScript uses final script URL for rewritten relative import context", async () => {
  const f = setup({
    "https://site.test/old/code.js": {
      url: "https://site.test/new/code.js",
      type: "application/javascript",
      body: "window.result=1",
    },
  });
  try {
    await f.graph.prepareElement(
      f.element("script", { src: "https://site.test/old/code.js" }),
    );
    assert.deepEqual(f.bases, [
      { kind: "classic", url: "https://site.test/new/code.js" },
    ]);
  } finally {
    f.graph.dispose();
  }
});
