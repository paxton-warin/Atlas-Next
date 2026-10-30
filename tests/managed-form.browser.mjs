/** Focused real-Chrome tests. Only synthetic localhost forms; no real accounts. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
const sourceRoot = resolve(process.env.ATLAS_MANAGED_FORM_SOURCE_ROOT || ".");
const helperPresent = existsSync(
  resolve(sourceRoot, "runtime/managed-form.ts"),
);
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
let server, browser, origin;
const requests = [];
before(async () => {
  const bridge = (
    await build({
      entryPoints: [resolve(sourceRoot, "runtime/page-bridge.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const helper = helperPresent
    ? (
        await build({
          entryPoints: [resolve(sourceRoot, "runtime/managed-form.ts")],
          bundle: true,
          write: false,
          format: "esm",
          platform: "browser",
          logLevel: "silent",
        })
      ).outputFiles[0].text
    : "";
  server = Fastify({ logger: false });
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_q, b, done) => done(null, b),
  );
  server.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer" },
    (_q, b, done) => done(null, b),
  );
  server.get("/bridge.js", (_q, r) =>
    r.type("application/javascript").send(bridge),
  );
  server.get("/helper.js", (_q, r) =>
    r.type("application/javascript").send(helper),
  );
  server.get("/shell", (_q, r) =>
    r.type("text/html")
      .send(`<!doctype html><iframe id="root" name="view-root" src="/document"></iframe><script type="module">
    ${helperPresent ? `import {createManagedFormSubmitter} from '/helper.js';window.managedSubmit=createManagedFormSubmitter(window);` : ""}
    window.submitToRoot=(form,submitter)=>managedSubmit(form,submitter,{window:document.querySelector('#root').contentWindow,pageUrl:location.origin+'/document',encode:x=>x});
    window.openManaged=(url,name)=>{let frame=document.querySelector('#popup');if(!frame){frame=document.createElement('iframe');frame.id='popup';frame.name='view-popup';frame.src=url;document.body.append(frame)}return{window:frame.contentWindow,name:frame.name,submit:(form,submitter)=>managedSubmit(form,submitter,{window:frame.contentWindow,pageUrl:location.origin+'/document',encode:x=>x})}};
  </script>`),
  );
  server.get("/document", (_q, r) =>
    r.type("text/html")
      .send(`<!doctype html><form id="form" action="/result" method="POST" target="_top"><input name="proof" value="synthetic"><button id="submitter" name="choice" value="selected" formaction="/selected" formmethod="post" formenctype="multipart/form-data">Send</button><input type="file" name="attachment"></form><script type="module">
    import{installPageBridge}from'/bridge.js';
    installPageBridge(window,{pageUrl:()=>location.href,topName:'view-root',isRoot:window===top.document.querySelector('#root').contentWindow,submitToRoot:(form,button)=>top.submitToRoot(form,button),focusSearch(){},open:(url,name)=>top.openManaged(url,name)});
    window.fixtureReady=true;
  </script>`),
  );
  server.get("/blank", (_q, r) =>
    r.type("text/html").send("<h1>Managed target</h1>"),
  );
  for (const path of ["/result", "/selected"])
    server.post(path, (q, r) => {
      const body = String(q.body);
      requests.push({
        path: q.url,
        method: q.method,
        body,
        contentType: q.headers["content-type"],
        cookie: q.headers.cookie || "",
      });
      r.type("text/html").send(
        '<h1 id="received">Synthetic POST received</h1>',
      );
    });
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
  const context = await browser.newContext();
  await context.addCookies([
    { name: "fixture_session", value: "synthetic-session", url: origin },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(origin + "/shell");
    const root = page.frames()[1];
    await root.waitForFunction(() => window.fixtureReady);
    await fn({ context, page, root });
  } finally {
    await context.close();
  }
}
for (const target of ["_top", "_parent", "view-root"])
  for (const changedName of ["", "foreign-auth-context"])
    test(`root ${target} retains POST in the exact Atlas frame with native name ${JSON.stringify(changedName)}`, () =>
      fixture(async ({ context, page, root }) => {
        const before = requests.length;
        await root.evaluate(
          ({ target, changedName }) => {
            window.name = changedName;
            const f = document.querySelector("#form");
            f.target = target;
            f.submit();
          },
          { target, changedName },
        );
        await root.waitForSelector("#received", { timeout: 1500 });
        assert.equal(context.pages().length, 1);
        assert.equal(page.url(), origin + "/shell");
        assert.equal(requests.length, before + 1);
        const row = requests.at(-1);
        assert.equal(row.method, "POST");
        assert.equal(row.body, "proof=synthetic&attachment=");
        assert.match(row.cookie, /fixture_session=synthetic-session/);
      }));
for (const target of ["_top", "_parent"])
  test(
    `nested ${target} reaches the owning root despite cleared root name`,
    { skip: target === "_top" && !helperPresent },
    () =>
      fixture(async ({ context, page, root }) => {
        await root.evaluate(() => {
          window.name = "";
          const child = document.createElement("iframe");
          child.src = "/document";
          child.id = "nested";
          document.body.append(child);
        });
        let child;
        for (let i = 0; i < 50; i++) {
          child = root.childFrames()[0];
          if (
            child &&
            (await child
              .evaluate(() => !!window.fixtureReady)
              .catch(() => false))
          )
            break;
          await page.waitForTimeout(20);
        }
        const before = requests.length;
        await child.evaluate((target) => {
          const form = document.querySelector("#form");
          form.target = target;
          form.submit();
        }, target);
        await root.waitForSelector("#received", { timeout: 1500 });
        assert.equal(context.pages().length, 1);
        assert.equal(page.url(), origin + "/shell");
        assert.equal(requests.length, before + 1);
        assert.equal(requests.at(-1).body, "proof=synthetic&attachment=");
      }),
  );
for (const changedName of ["", "foreign-popup-context"])
  test(
    `managed named popup ${JSON.stringify(changedName)} preserves submitter, file, cookie and name`,
    { skip: !helperPresent },
    () =>
      fixture(async ({ context, page, root }) => {
        await root.locator("input[type=file]").setInputFiles({
          name: "fixture.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("synthetic file contents"),
        });
        const before = requests.length;
        const state = await root.evaluate((changedName) => {
          const popup = top.openManaged("/blank", "auth");
          popup.window.name = changedName;
          const form = document.querySelector("#form");
          form.target = "auth";
          form.requestSubmit(document.querySelector("#submitter"));
          return { name: popup.window.name, target: form.target };
        }, changedName);
        await page
          .locator("#popup")
          .contentFrame()
          .locator("#received")
          .waitFor();
        assert.equal(context.pages().length, 1);
        assert.deepEqual(state, { name: changedName, target: "auth" });
        assert.equal(requests.length, before + 1);
        const row = requests.at(-1);
        assert.equal(row.path, "/selected");
        assert.equal(row.method, "POST");
        assert.match(row.contentType, /^multipart\/form-data; boundary=/);
        assert.match(row.body, /name="proof"\r\n\r\nsynthetic/);
        assert.match(row.body, /name="choice"\r\n\r\nselected/);
        assert.match(row.body, /filename="fixture.txt"/);
        assert.match(row.body, /synthetic file contents/);
        assert.match(row.cookie, /fixture_session=synthetic-session/);
      }),
  );
test(
  "temporary native target alias survives site name clobbering and formdata listeners",
  { skip: !helperPresent },
  () =>
    fixture(async ({ context, page, root }) => {
      await root.evaluate(() => {
        const popup = top.openManaged("/blank", "auth");
        window.testPopup = popup;
        Object.defineProperty(popup.window, "name", {
          configurable: true,
          value: "site-visible-name",
          writable: true,
        });
        const form = document.querySelector("#form");
        form.target = "auth";
        form.addEventListener(
          "formdata",
          () => {
            popup.window.name = "changed-by-formdata";
          },
          { once: true },
        );
      });
      await root.evaluate(() => document.querySelector("#form").submit());
      await page
        .locator("#popup")
        .contentFrame()
        .locator("#received")
        .waitFor();
      assert.equal(context.pages().length, 1);
      assert.equal(requests.at(-1).body, "proof=synthetic&attachment=");
    }),
);

test(
  "successful controls named target and submit cannot redirect the trusted clone",
  { skip: !helperPresent },
  () =>
    fixture(async ({ context, page, root }) => {
      await root.evaluate(() => {
        const form = document.querySelector("#form");
        form.target = "auth";
        for (const name of ["target", "submit"]) {
          const input = document.createElement("input");
          input.name = name;
          input.value = "synthetic-control";
          form.append(input);
        }
        HTMLFormElement.prototype.submit.call(form);
      });
      await page
        .locator("#popup")
        .contentFrame()
        .locator("#received")
        .waitFor();
      assert.equal(context.pages().length, 1);
      const body = new URLSearchParams(requests.at(-1).body);
      assert.equal(body.get("proof"), "synthetic");
      assert.equal(body.get("target"), "synthetic-control");
      assert.equal(body.get("submit"), "synthetic-control");
    }),
);
