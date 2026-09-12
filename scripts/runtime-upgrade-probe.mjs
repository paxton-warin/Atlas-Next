// Upgrade the real old build in the SAME Chrome context, keeping origin and storage.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
import { createRuntime } from "../server/runtime.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-upgrade-"));
const fixture = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/signin")
    res.setHeader(
      "Set-Cookie",
      "upgrade_fixture=present; Path=/; HttpOnly; Max-Age=3600",
    );
  if (req.url === "/signout")
    res.setHeader("Set-Cookie", "upgrade_fixture=; Path=/; Max-Age=0");
  res.end(
    '<html><head><title>Upgrade fixture</title></head><body><h1>Upgrade fixture ready</h1><p id="cookie">' +
      (req.headers.cookie || "none") +
      '</p><p id="storage"></p><script>if(location.pathname==="/signin")localStorage.setItem("upgrade-fixture","retained");document.querySelector("#storage").textContent=localStorage.getItem("upgrade-fixture")||"none";</script></body></html>',
  );
});
let browser, app, runtime;
async function stop() {
  for (const s of [app, runtime]) s?.server.closeAllConnections?.();
  await Promise.all([app?.close(), runtime?.close()]);
}
async function start(built) {
  app = await createApp({
    dataDir: dir,
    appOrigin: "http://localhost:4480",
    runtimeOrigin: "http://127.0.0.1:4481",
    staticDir: resolve(built, "web"),
  });
  runtime = await createRuntime({
    appOrigin: "http://localhost:4480",
    runtimeOrigin: "http://127.0.0.1:4481",
    staticDir: resolve(built, "runtime"),
    fixture: true,
  });
  await runtime.listen({ port: 4481, host: "127.0.0.1" });
  await app.listen({ port: 4480, host: "127.0.0.1" });
}
try {
  await new Promise((r) => fixture.listen(4199, "127.0.0.1", r));
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  async function visit(path) {
    await page.goto("http://localhost:4480");
    await page
      .getByLabel("Search the web")
      .fill("http://127.0.0.1:4199" + path);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]');
    await site
      .getByRole("heading", { name: "Upgrade fixture ready" })
      .waitFor();
    return site;
  }
  await start(process.argv[2] || "evidence/fork-migration/baseline-dist");
  let site = await visit("/signin");
  await site.locator("#storage").filter({ hasText: "retained" }).waitFor();
  await page.goto("about:blank");
  await stop();
  await start("dist");
  site = await visit("/fixture");
  assert.match(
    await site.locator("#cookie").innerText(),
    /upgrade_fixture=present/,
  );
  assert.equal(await site.locator("#storage").innerText(), "retained");
  const host = page
    .frames()
    .find(
      (f) =>
        f.url().startsWith("http://127.0.0.1:4481/") &&
        f.parentFrame() === page.mainFrame(),
    );
  assert.equal(
    await host.evaluate(
      () => new URL(navigator.serviceWorker.controller.scriptURL).pathname,
    ),
    "/worker.js",
  );
  const databases = await host.evaluate(() => indexedDB.databases());
  assert.ok(databases.some((d) => d.name === "__scramjet_controller"));
  assert.ok(databases.some((d) => d.name === "__runtimekit_controller"));
  site = await visit("/signout");
  site = await visit("/fixture");
  assert.equal(await site.locator("#cookie").innerText(), "none");
  console.log(
    "UPGRADE=PASS; COOKIE=RESTORED; STORAGE=RESTORED; WORKER=/worker.js; LEGACY_DB=PRESERVED; LOGOUT_RELOAD=PASS",
  );
} finally {
  await browser?.close();
  await stop();
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  rmSync(dir, { recursive: true, force: true });
}
