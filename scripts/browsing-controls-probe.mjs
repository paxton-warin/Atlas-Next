// Real Chrome against the production app; both snapshots use the same expired lease input.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-controls-"));
const app = await createApp({
  dataDir: dir,
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
  nodesEnabled: true,
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
  const page = await browser.newPage();
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("http://localhost:4380");
  await page.getByLabel("Search the web").fill("https://example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForTimeout(300);
  const row = await page.locator(".node-status").count();
  const select = await page.locator("select.engine-select").count();
  const menu = await page
    .getByRole("button", { name: "Browsing options" })
    .count();
  await page.evaluate(() =>
    localStorage.setItem(
      "atlas.nodeSession",
      JSON.stringify("expired-fixture"),
    ),
  );
  await page.reload();
  await page.waitForTimeout(600);
  const prompt = await page
    .getByRole("dialog", { name: "Browsing session expired" })
    .count();
  console.log(
    `NODE_ROW=${row}; ENGINE_SELECT=${select}; BROWSING_MENU=${menu}; EXPIRED_PROMPT=${prompt}`,
  );
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
