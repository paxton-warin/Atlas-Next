/** Native browser download assertions; synthetic local data only. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
const root = resolve(process.env.ATLAS_LOCAL_DOWNLOAD_SOURCE_ROOT || ".");
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
let server, browser, origin;
before(async () => {
  const code = (
    await build({
      entryPoints: [resolve(root, "runtime/local-download.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
  server = Fastify({ logger: false });
  server.get("/bridge.js", (_q, r) =>
    r.type("application/javascript").send(code),
  );
  server.get("/", (_q, r) =>
    r
      .type("text/html")
      .send(
        `<!doctype html><button id="download">Save synthetic file</button><script type="module">import{createLocalDownloadInstaller}from'/bridge.js';const href=Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype,'href');const set=Element.prototype.setAttribute;const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);const logicalOrigin='https://website.test';const nativeBlob=x=>'blob:'+location.origin+new URL(x.slice(5)).pathname;URL.createObjectURL=x=>{const url=create(x);return 'blob:'+logicalOrigin+new URL(url.slice(5)).pathname};URL.revokeObjectURL=x=>revoke(nativeBlob(x));Object.defineProperty(HTMLAnchorElement.prototype,'href',{configurable:true,get(){const raw=href.get.call(this);return raw.startsWith(location.origin+'/virtual/')?decodeURIComponent(raw.slice((location.origin+'/virtual/').length)):raw},set(value){value=String(value);if(value.startsWith('blob:')||value.startsWith('data:'))set.call(this,'href',location.origin+'/virtual/'+encodeURIComponent(value));else href.set.call(this,value)}});const install=createLocalDownloadInstaller(window);install(window,{pageURL:()=>logicalOrigin+'/',nativeBlobURL:nativeBlob});window.ready=true;</script>`,
      ),
  );
  server.get("/http", (_q, r) =>
    r
      .header("content-disposition", "attachment; filename=http.txt")
      .type("text/plain")
      .send("http-unchanged"),
  );
  origin = await server.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
async function fixture(fn) {
  const c = await browser.newContext({ acceptDownloads: true });
  const p = await c.newPage();
  await p.goto(origin);
  await p.waitForFunction(() => window.ready);
  try {
    await fn(p, c);
  } finally {
    await c.close();
  }
}
const readDownload = async (d) => {
  assert.equal(await d.failure(), null);
  return readFile(await d.path(), "utf8");
};
for (const mode of [
  "detached-dispatch",
  "detached-click",
  "appended-dispatch",
  "pointer",
])
  test(`${mode} preserves exact local bytes and filename`, () =>
    fixture(async (p) => {
      await p.evaluate((mode) => {
        const blob = new Blob(["synthetic-save\nαβ"], { type: "text/plain" });
        window.nativeURL = URL.createObjectURL(blob);
        const a = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
        a.href = nativeURL;
        a.download = "synthetic save.txt";
        a.textContent = "Download synthetic file";
        window.anchor = a;
        window.before = a.href;
        window.seen = [];
        a.addEventListener("click", () => seen.push(a.href));
        if (mode.startsWith("appended") || mode === "pointer")
          document.body.append(a);
      }, mode);
      const flight = p.waitForEvent("download");
      if (mode === "pointer") await p.locator("a").click();
      else
        await p.evaluate(
          (mode) =>
            mode.endsWith("click")
              ? anchor.click()
              : anchor.dispatchEvent(new MouseEvent("click")),
          mode,
        );
      const d = await flight;
      assert.equal(d.suggestedFilename(), "synthetic save.txt");
      assert.equal(await readDownload(d), "synthetic-save\nαβ");
      await p.waitForTimeout(30);
      assert.deepEqual(
        await p.evaluate(() => ({ same: anchor.href === before, seen })),
        { same: true, seen: [await p.evaluate(() => before)] },
      );
    }));
test("detached FileSaver immediate revoke retains bytes", () =>
  fixture(async (p) => {
    const f = p.waitForEvent("download");
    await p.evaluate(() => {
      const u = URL.createObjectURL(new Blob(["revoke-proof"]));
      const a = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
      a.href = u;
      a.download = "revoked.txt";
      a.dispatchEvent(new MouseEvent("click"));
      URL.revokeObjectURL(u);
    });
    assert.equal(await readDownload(await f), "revoke-proof");
  }));
test("preventDefault remains authoritative", () =>
  fixture(async (p) => {
    let n = 0;
    p.on("download", () => n++);
    await p.evaluate(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["cancelled"]));
      a.download = "cancelled.txt";
      a.addEventListener("click", (e) => e.preventDefault());
      a.dispatchEvent(new MouseEvent("click", { cancelable: true }));
    });
    await p.waitForTimeout(80);
    assert.equal(n, 0);
  }));
test("target and ancestor handlers can replace href without being overwritten", () =>
  fixture(async (p) => {
    for (const ancestor of [false, true]) {
      const f = p.waitForEvent("download");
      await p.evaluate((ancestor) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(["old"]));
        a.download = "changed.txt";
        const second = URL.createObjectURL(new Blob(["new"]));
        window.changed = second;
        window.anchor = a;
        (ancestor ? window : a).addEventListener(
          "click",
          () => (a.href = second),
          { once: true },
        );
        if (ancestor) document.body.append(a);
        a.dispatchEvent(new MouseEvent("click", { bubbles: ancestor }));
      }, ancestor);
      assert.equal(await readDownload(await f), "new");
      await p.waitForTimeout(20);
      assert.equal(await p.evaluate(() => anchor.href === changed), true);
    }
  }));
test("data URL download retains exact payload and HTTP download is unchanged", () =>
  fixture(async (p) => {
    for (const kind of ["data", "http"]) {
      const f = p.waitForEvent("download");
      await p.evaluate((kind) => {
        const a = document.createElement("a");
        a.href =
          kind === "data"
            ? "data:text/plain;charset=utf-8,local%20data%20%CE%B1"
            : "/http";
        a.download = kind + ".txt";
        a.dispatchEvent(new MouseEvent("click"));
      }, kind);
      assert.equal(
        await readDownload(await f),
        kind === "data" ? "local data α" : "http-unchanged",
      );
    }
  }));
test("non-download click is not rewritten and generic dispatch return is preserved", () =>
  fixture(async (p) => {
    assert.deepEqual(
      await p.evaluate(() => {
        const a = document.createElement("a");
        a.href = "#not-a-download";
        const before = a.getAttribute("href");
        a.addEventListener("click", (e) => e.preventDefault());
        const click = a.dispatchEvent(
          new MouseEvent("click", { cancelable: true }),
        );
        const other = a.dispatchEvent(new Event("custom"));
        return { click, other, same: a.getAttribute("href") === before };
      }),
      { click: false, other: true, same: true },
    );
  }));

test("connected target stopPropagation does not lose local default download", () =>
  fixture(async (p) => {
    const f = p.waitForEvent("download");
    await p.evaluate(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["stopped-bubble"]));
      a.download = "stopped.txt";
      a.addEventListener("click", (e) => e.stopPropagation());
      document.body.append(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(await readDownload(await f), "stopped-bubble");
  }));
test("ancestor cancellation restores the original logical href without a download", () =>
  fixture(async (p) => {
    let n = 0;
    p.on("download", () => n++);
    const state = await p.evaluate(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["cancelled-parent"]));
      a.download = "cancelled.txt";
      document.body.append(a);
      const href = a.href;
      window.addEventListener("click", (e) => e.preventDefault(), {
        once: true,
      });
      const result = a.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      return { result, same: a.href === href };
    });
    await p.waitForTimeout(40);
    assert.deepEqual(state, { result: false, same: true });
    assert.equal(n, 0);
  }));

test("ancestor handlers still read the original logical URL", () =>
  fixture(async (p) => {
    const f = p.waitForEvent("download");
    const state = await p.evaluate(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["logical-proof"]));
      a.download = "logical.txt";
      window.expected = a.href;
      window.observed = [];
      a.addEventListener("click", () => observed.push(a.href));
      window.addEventListener("click", () => observed.push(a.href), {
        once: true,
      });
      document.body.append(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return { observed, expected, restored: a.href === expected };
    });
    assert.equal(await readDownload(await f), "logical-proof");
    assert.deepEqual(state, {
      observed: [state.expected, state.expected],
      expected: state.expected,
      restored: true,
    });
  }));
