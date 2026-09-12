// Real Chrome + both production servers, temporary storage and a proxied icon fixture.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import { createRuntime } from "../server/runtime.mjs";
const built = resolve(process.argv[2] || "dist");
const dir = mkdtempSync(join(tmpdir(), "atlas-favicon-probe-"));
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
const fixture = createServer((req, res) => {
  if (req.url === "/icon.svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#4285f4"/><text x="16" y="24" text-anchor="middle" font-size="24" fill="white">A</text></svg>',
    );
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html><head><title>Favicon fixture</title><link rel="icon" href="/icon.svg"></head><body><h1>Favicon fixture ready</h1></body></html>',
    );
  }
});
let browser;
try {
  await new Promise((r) => fixture.listen(4199, "127.0.0.1", r));
  await runtime.listen({ port: 4381, host: "127.0.0.1" });
  await app.listen({ port: 4380, host: "127.0.0.1" });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("http://localhost:4380");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/favicon-fixture");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]')
    .getByRole("heading", { name: "Favicon fixture ready" })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".tab-main .spinner"),
  );
  await page
    .waitForFunction(
      () => (document.querySelector(".tab-main img")?.naturalWidth || 0) > 0,
      null,
      { timeout: 6000 },
    )
    .catch(() => {});
  const width = await page
    .locator(".tab-main")
    .evaluate((tab) => tab.querySelector("img")?.naturalWidth || 0);
  const host=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:4381/') && f.parentFrame()===page.mainFrame());
  const engine=await host.evaluate(()=>window.$runtimekit ? 'runtimekit' : window.$scramjet ? 'scramjet' : 'unknown');
  const prefix=await host.locator('iframe[title="Proxied website"]').getAttribute('src');
  const path=prefix.includes('/~/app/')?'/~/app/':prefix.includes('/~/sj/')?'/~/sj/':'unknown';
  if(width!==32 || engine==='unknown' || path==='unknown') throw Error('Runtime probe failed');
  const nodeApi=(await fetch("http://localhost:4380/api/admin/nodes")).status;
  console.log(`ENGINE=${engine}; PREFIX=${path}; ICON_WIDTH=${width}; NODE_API_HTTP=${nodeApi}`);
  if (process.env.SCREENSHOT) {
    mkdirSync(resolve("evidence/favicons"), { recursive: true });
    await page.screenshot({ path: process.env.SCREENSHOT });
  }
} finally {
  await browser?.close();
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  for (const server of [app, runtime]) server.server.closeAllConnections?.();
  await Promise.all([app.close(), runtime.close()]);
  rmSync(dir, { recursive: true, force: true });
}
