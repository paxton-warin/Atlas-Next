// Deterministic production-build probe, also runnable against the original archive.
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.mjs";
import { createRuntime } from "../server/runtime.mjs";
import { navigationFixture } from "../tests/navigation-fixture.mjs";
const built = resolve(process.argv[2] || "dist");
const dir = mkdtempSync(join(tmpdir(), "atlas-navigation-"));
const app = await createApp({
  dataDir: dir,
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
  staticDir: join(built, "web"),
});
const runtime = await createRuntime({
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
  staticDir: join(built, "runtime"),
  fixture: true,
});
const fixture = createServer(
  { shouldUpgradeCallback: () => false },
  async (req, res) => {
    try {
      if (
        !(await navigationFixture(
          req,
          res,
          new URL(req.url, "http://127.0.0.1:4199"),
        ))
      ) {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  },
);
let browser;
const results = [];
const host = (p) =>
  p.frameLocator('iframe[title="Atlas isolated browsing runtime"]');
const site = (p) =>
  host(p).frameLocator('iframe[title="Proxied website"]:not([hidden])');
async function check(name, fn) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const p = await context.newPage();
  if (process.env.PROBE_DEBUG)
    p.on("pageerror", (e) => console.log(name, e.message));
  p.setDefaultTimeout(2200);
  let ok = false;
  try {
    await p.goto("http://localhost:4380");
    await p.getByRole("button", { name: "Use defaults", exact: true }).click();
    ok = await fn(p, context);
  } catch (error) {
    if (process.env.PROBE_DEBUG)
      console.log(
        name,
        error.message,
        p.frames().map((f) => f.url().slice(0, 180)),
      );
    ok = false;
  }
  results.push([name, Boolean(ok)]);
  await context.close();
}
async function launch(p) {
  await p.getByLabel("Search the web").fill("http://127.0.0.1:4199/navigation");
  await p.getByLabel("Search the web").press("Enter");
  await site(p)
    .getByRole("heading", { name: "Navigation fixture", exact: true })
    .waitFor();
}
try {
  await new Promise((r) => fixture.listen(4199, "127.0.0.1", r));
  await runtime.listen({ port: 4381, host: "127.0.0.1" });
  await app.listen({ port: 4380, host: "127.0.0.1" });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  await check("ENTER_SEARCH", async (p) => {
    await launch(p);
    await site(p).getByLabel("Website search").fill("atlas query");
    await site(p).getByLabel("Website search").press("Enter");
    await site(p).getByRole("heading", { name: "Search results" }).waitFor();
    return (await p.getByLabel("Address bar").inputValue()).endsWith(
      "/navigation/results?q=atlas+query",
    );
  });
  await check("CALLBACK_REDIRECT", async (p) => {
    await launch(p);
    await site(p)
      .frameLocator('iframe[title="Nested callback fixture"]')
      .getByRole("button")
      .click();
    await site(p).getByRole("heading", { name: "Redirect complete" }).waitFor();
    return (
      (await site(p).locator("#cookie").innerText()) === "Cookie retained" &&
      p.url() === "http://localhost:4380/"
    );
  });
  for (const [name, button] of [
    ["INTERNAL_POPUP", "Open sign-in popup"],
    ["BLANK_POPUP", "Open blank then navigate"],
  ])
    await check(name, async (p, c) => {
      await launch(p);
      if (process.env.PROBE_DEBUG)
        console.log(
          name,
          await site(p)
            .locator("#open")
            .evaluate((el) => String(el.onclick)),
        );
      await site(p).getByRole("button", { name: button, exact: true }).click();
      await site(p).getByRole("heading", { name: "Sign-in fixture" }).waitFor();
      if (process.env.PROBE_DEBUG)
        console.log(
          name,
          "COUNTS",
          c.pages().length,
          await p.locator(".tab").count(),
          await p.getByLabel("Address bar").inputValue(),
        );
      if (c.pages().length !== 1 || (await p.locator(".tab").count()) !== 2)
        return false;
      await site(p)
        .getByRole("button", { name: "Finish sign-in fixture" })
        .click();
      await p.waitForFunction(
        () => document.querySelectorAll(".tab").length === 1,
      );
      await expect(site(p).locator("#popup-result")).toHaveText(
        "Opener message received",
        { timeout: 2200 },
      );
      await expect(site(p).locator("#closed-result")).toHaveText(
        "Popup closed",
        { timeout: 2200 },
      );
      return (
        (await site(p).locator("#popup-result").innerText()) ===
        "Opener message received"
      );
    });
  await check("POPUP_POST", async (p, c) => {
    await launch(p);
    await site(p)
      .getByRole("button", { name: "Submit popup form", exact: true })
      .click();
    await site(p).getByRole("heading", { name: "Redirect complete" }).waitFor();
    return (
      c.pages().length === 1 &&
      (await p.locator(".tab").count()) === 2 &&
      (await site(p).locator("#cookie").innerText()) === "Cookie retained"
    );
  });
  await check("NESTED_SHORTCUT", async (p) => {
    await launch(p);
    await site(p)
      .frameLocator('iframe[title="Nested callback fixture"]')
      .getByLabel("Nested input")
      .press("Meta+k");
    await p.waitForFunction(() => document.activeElement?.id === "omnibox");
    return p
      .getByLabel("Address bar")
      .evaluate(
        (el) => el.selectionEnd - el.selectionStart === el.value.length,
      );
  });
  await check("CENTERED_NAV", async (p) => {
    const b = await p.locator(".main-nav").boundingBox();
    return Math.abs(b.x + b.width / 2 - 720) < 2;
  });
  await check("SCRAMJET_ONLY", async (p) => {
    const c = await (
      await p.request.get("http://localhost:4380/api/config")
    ).json();
    if (JSON.stringify(c.engines) !== '["scramjet"]') return false;
    for (const path of [
      "/uv/sw.js",
      "/vendor/uv/uv.bundle.js",
      "/vendor/baremux/index.js",
      "/vendor/epoxy/index.mjs",
    ])
      if (
        (await p.request.get("http://127.0.0.1:4381" + path)).status() !== 404
      )
        return false;
    return true;
  });
  console.log(
    results.map(([n, ok]) => n + "=" + (ok ? "PASS" : "FAIL")).join("; "),
  );
  console.log(
    "NAVIGATION_PASS=" +
      results.filter(([, ok]) => ok).length +
      "; NAVIGATION_FAIL=" +
      results.filter(([, ok]) => !ok).length,
  );
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  await browser?.close();
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  for (const s of [app, runtime]) s.server.closeAllConnections?.();
  await Promise.all([app.close(), runtime.close()]);
  rmSync(dir, { recursive: true, force: true });
}
