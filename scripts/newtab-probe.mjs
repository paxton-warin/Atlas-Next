// Observe the rendered new-tab layout against a selected built frontend.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import { createRuntime } from "../server/runtime.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-newtab-"));
const origins = {
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
};
const app = await createApp({
  ...origins,
  dataDir: dir,
  staticDir: resolve(process.argv[2] || "dist", "web"),
});
const runtime = await createRuntime(origins);
let browser;
try {
  await runtime.listen({ port: 4381, host: "127.0.0.1" });
  await app.listen({ port: 4380, host: "127.0.0.1" });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    timezoneId: "America/New_York",
  });
  await page.clock.install({ time: new Date("2026-09-11T16:00:00Z") });
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto(origins.appOrigin);
  await page.locator(".home-hero h1").waitFor();
  const result = await page.evaluate(() => {
    const style = (selector) =>
      getComputedStyle(document.querySelector(selector));
    return `HERO=${style(".home-hero h1").fontSize}; SIDEBAR=${style(".sidebar").width}; BORDER=${style(".main-panel").borderTopWidth}; TOOLBAR=${document.querySelectorAll(".browser-toolbar").length}`;
  });
  console.log(result);
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: process.env.SCREENSHOT });
} finally {
  await browser?.close();
  for (const server of [app, runtime]) server.server.closeAllConnections?.();
  await Promise.all([app.close(), runtime.close()]);
  rmSync(dir, { recursive: true, force: true });
}
