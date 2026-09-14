import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const label = "YouTube ad blocker";
const toggle = (page: Page) =>
  page.getByRole("switch", { name: label, exact: true });
async function browserSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
}
async function privacy(page: Page) {
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Privacy & data", exact: true })
    .click();
}

test("YouTube ad blocking defaults on in the shared setup wizard and retains an explicit opt-out", async ({
  page,
}) => {
  await page.goto("/");
  const wizard = page
    .getByRole("dialog")
    .filter({ has: page.locator("#wizard-title") });
  await wizard
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button", { name: /Browser$/ })
    .click();
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(wizard).toContainText(
    "Block supported YouTube ads. Reload YouTube tabs after changing this.",
  );
  await toggle(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "evidence/focus-tabs/youtube-wizard-default.png",
  });
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await wizard
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button", { name: /Finish$/ })
    .click();
  await wizard.getByRole("button", { name: "Open Atlas", exact: true }).click();
  await browserSettings(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await browserSettings(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("atlas.settings")!).youtubeAdblock,
    ),
  ).toBe(false);
  for (const query of ["youtube", "adblock", "ads", "ad blocker"]) {
    await page.getByRole("textbox", { name: "Search settings" }).fill(query);
    await expect(toggle(page)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No settings found" }),
    ).toHaveCount(0);
  }
});

test("older settings migrate to enabled, while export/import preserves false and rejects non-booleans", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    if (!localStorage.getItem("atlas.settings"))
      localStorage.setItem("atlas.settings", JSON.stringify({ theme: "sand" }));
  });
  await page.goto("/");
  await browserSettings(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await toggle(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "evidence/focus-tabs/youtube-settings-default.png",
  });
  await toggle(page).click();
  await privacy(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export settings", exact: true })
    .click();
  const file = await downloaded;
  const payload = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(payload.settings.youtubeAdblock).toBe(false);
  for (const value of [false, true, "false", 0, null]) {
    await page.getByLabel("Import settings").setInputFiles({
      name: "settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          ...payload,
          settings: { ...payload.settings, youtubeAdblock: value },
        }),
      ),
    });
    await expect(page.getByRole("status")).toContainText("Settings imported.");
    await page
      .locator(".settings-nav")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await expect(toggle(page)).toHaveAttribute(
      "aria-checked",
      String(typeof value === "boolean" ? value : true),
    );
    await privacy(page);
  }
});
