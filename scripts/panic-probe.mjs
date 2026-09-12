// Fresh browser, built app, no external browsing; also runs against the original build.
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-panic-"));
const app = await createApp({
  dataDir: dir,
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
  staticDir: resolve(process.argv[2] || "dist", "web"),
});
let browser;
try {
  await app.listen({ host: "127.0.0.1", port: 4380 });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.route("http://127.0.0.1:4381/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("http://localhost:4380");
  await page.getByRole("button", { name: "Use defaults", exact: true }).click();
  const saved = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("atlas.settings")));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  const restore = Number(
    (await page
      .getByRole("switch", { name: "Restore tabs", exact: true })
      .getAttribute("aria-checked")) === "true",
  );
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Privacy & data", exact: true })
    .click();
  const centered = await page.locator(".settings-page").evaluate((el) => {
    const box = el.getBoundingClientRect(),
      parent = el.parentElement.getBoundingClientRect();
    return Number(
      Math.abs((box.left + box.right) / 2 - (parent.left + parent.right) / 2) <
        2,
    );
  });
  const input = page.getByLabel("Panic key", { exact: true });
  await input.press("Meta+Escape");
  const compound = Number((await saved()).exitKey === "Meta+Escape");
  await input.press("i");
  const confirmation = page.getByRole("dialog", {
    name: "Use this panic shortcut?",
    exact: true,
  });
  const easy = Number(await confirmation.isVisible());
  if (easy)
    await confirmation.getByRole("button", { name: "Choose another" }).click();
  let reserved = 0;
  if (await page.getByText("Choose keys manually", { exact: true }).count()) {
    await page.getByText("Choose keys manually", { exact: true }).click();
    await page
      .getByRole("button", { name: "Modifier Cmd", exact: true })
      .click();
    await page
      .getByLabel("Shortcut main key", { exact: true })
      .selectOption("t");
    await page
      .getByRole("button", { name: "Use shortcut", exact: true })
      .click();
    reserved = Number(
      (await confirmation.isVisible()) &&
        (await confirmation.textContent()).includes("new browser tab"),
    );
    if (await confirmation.isVisible())
      await confirmation
        .getByRole("button", { name: "Choose another" })
        .click();
  }
  console.log(
    `COMPOUND=${compound}; EASY_KEY_CONFIRM=${easy}; RESERVED_KEY_CONFIRM=${reserved}; RESTORE_DEFAULT=${restore}; SYSTEM_PAGES_CENTERED=${centered}`,
  );
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
