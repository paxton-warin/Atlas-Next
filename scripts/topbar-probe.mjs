// Layout regression probe: no external website traffic. Run against either built snapshot.
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.mjs";
const data = mkdtempSync(join(tmpdir(), "atlas-topbar-"));
const app = await createApp({
  dataDir: data,
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
  staticDir: resolve(process.argv[2] || "dist", "web"),
});
let browser;
try {
  await app.listen({ port: 4380, host: "127.0.0.1" });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 800 },
  });
  await page.route("http://127.0.0.1:4381/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Layout fixture</title>",
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.sidebarCollapsed", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "top", restore: true }),
    );
  });
  await page.goto("http://localhost:4380");
  const baseline = await page.locator(".horizontal-tabs").evaluate((strip) => {
    const button = strip.querySelector(".new-tab"),
      label = button.querySelector("span");
    const b = button.getBoundingClientRect(),
      p = strip.getBoundingClientRect();
    const left = b.x - p.x < 20 ? 1 : 0;
    const single = label.getBoundingClientRect().height < 20 ? 1 : 0;
    return { left, single };
  });
  if (process.env.SHOT_PREFIX)
    await page.screenshot({ path: process.env.SHOT_PREFIX + "-home.png" });
  await page.evaluate(() =>
    localStorage.setItem(
      "atlas.tabs",
      JSON.stringify(
        Array.from({ length: 7 }, (_, i) => ({
          id: String(i),
          url: "https://example.test/" + i,
          title: "Long tab title " + i,
          engine: "scramjet",
        })),
      ),
    ),
  );
  await page.reload();
  const normal = await page
    .locator(".horizontal-tabs .close-tab")
    .first()
    .evaluate((el) =>
      getComputedStyle(el).display !== "none" &&
      getComputedStyle(el).position !== "absolute"
        ? 1
        : 0,
    );
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator(".tab-main").first().click();
  const fits = await page.locator(".browser-toolbar").evaluate((el) => {
    const row = el.getBoundingClientRect();
    return Array.from(el.children).every((child) => {
      const b = child.getBoundingClientRect();
      return !b.width || (b.x >= row.x && b.right <= row.right);
    })
      ? 1
      : 0;
  });
  if (process.env.SHOT_PREFIX)
    await page.screenshot({ path: process.env.SHOT_PREFIX + "-mobile.png" });
  console.log(
    `NEW_TAB_LEFT=${baseline.left}; LABEL_SINGLE_LINE=${baseline.single}; INLINE_CLOSE=${normal}; TOOLBAR_FITS_320=${fits}`,
  );
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await app.close();
  rmSync(data, { recursive: true, force: true });
}
