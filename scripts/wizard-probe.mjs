// Deterministic UI snapshot probe; no external browsing.
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-wizard-"));
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
  const page = await browser.newPage();
  await page.route("http://127.0.0.1:4381/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("http://localhost:4380");
  let engine = 0,
    panic = 0,
    appearance = 0,
    data = 0,
    presets = 0,
    upload = 0;
  for (let step = 0; step < 8; step++) {
    const wizard = page.getByRole("dialog").first();
    engine = Math.max(
      engine,
      await wizard
        .getByLabel("Default browsing engine", { exact: true })
        .count(),
    );
    panic = Math.max(
      panic,
      await wizard.getByLabel("Panic key", { exact: true }).count(),
    );
    appearance = Math.max(
      appearance,
      await wizard.getByLabel("Background dimming", { exact: true }).count(),
    );
    data = Math.max(
      data,
      await wizard
        .getByRole("button", { name: "Export settings", exact: true })
        .count(),
    );
    presets = Math.max(
      presets,
      await wizard.locator(".tab-preset:not(.custom-preset)").count(),
    );
    upload = Math.max(
      upload,
      await wizard
        .getByLabel("Upload custom tab icon", { exact: true })
        .count(),
    );
    const custom = wizard.getByRole("button", {
      name: "Tab preset Custom",
      exact: true,
    });
    if (await custom.count()) {
      await custom.click();
      upload = Math.max(
        upload,
        await wizard
          .getByLabel("Upload custom tab icon", { exact: true })
          .count(),
      );
    }
    const done = wizard.getByRole("button", {
      name: "Open Atlas",
      exact: true,
    });
    if (await done.count()) {
      await done.click();
      break;
    }
    await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const links = await page.getByRole("link", { name: /Source code/ }).count();
  console.log(
    `WIZARD_ALL_SETTINGS=${engine && panic && appearance && data ? 1 : 0}; TAB_PRESETS=${presets}; CUSTOM_ICON_UPLOAD=${upload}; SOURCE_LINKS=${links}`,
  );
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
