import { test, expect, type Page } from "@playwright/test";
const target = "http://127.0.0.1:4199/compatibility-fixture";
const site = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
test.beforeEach(async ({ page, request }) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.settings", JSON.stringify({ motion: false }));
    }
  });
});
async function launch(page: Page) {
  await page.goto("/");
  await page.getByLabel("Search the web").fill(target);
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
}
test("retired Page options stays absent while ordinary metadata, controls and saves remain functional", async ({
  page,
}) => {
  await launch(page);
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Fixture game title");
  await site(page).getByLabel("Game draft").fill("unsaved");
  await page
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Page options", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await site(page).getByRole("button", { name: "Move", exact: true }).click();
  await expect(site(page).locator("#score")).toHaveText("1");
  await site(page).getByRole("button", { name: "Run WASM" }).click();
  await expect(site(page).locator("#wasm-result")).toHaveText("WASM ready");
  await site(page).getByRole("button", { name: "Run worker" }).click();
  await expect(site(page).locator("#worker-result")).toHaveText("worker ready");
  await site(page).getByRole("button", { name: "Change metadata" }).click();
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Dynamic game title");
  await expect(site(page).locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Dynamic description",
  );
  await expect(site(page).getByLabel("Game draft")).toHaveValue("unsaved");
  expect(
    await site(page)
      .locator("body")
      .evaluate(() => localStorage.getItem("game-progress")),
  ).toBe("retained");
  expect(
    await site(page)
      .locator("body")
      .evaluate(() => document.cookie),
  ).toContain("compat_fixture=retained");
  await expect(
    site(page).getByText(
      "Game controls and gameplay instructions stay visible.",
    ),
  ).toBeVisible();
});
test("same-frontend popout retains normal metadata and ignores spoofed compatibility messages without Page options", async ({
  page,
  context,
}) => {
  await launch(page);
  await page.evaluate(() =>
    window.postMessage(
      {
        atlas: 1,
        type: "compatibility-status",
        id: "x",
        origin: location.origin,
        rule: "game-metadata-v1",
        applied: 128,
        risk: true,
        throttled: false,
      },
      "*",
    ),
  );
  await expect(page.locator(".site-options-notice")).toHaveCount(0);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      site(popup)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Fixture game title");
  await popup
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  await expect(
    popup.getByRole("menuitem", { name: "Page options", exact: true }),
  ).toHaveCount(0);
  await popup.keyboard.press("Escape");
  await popup.close();
  await expect(
    site(page).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
});
test("fullscreen keeps page state without reintroducing retired compatibility notices", async ({
  page,
}) => {
  await launch(page);
  await site(page).getByLabel("Game draft").fill("Keep fullscreen draft");
  await site(page)
    .getByRole("button", { name: "Fullscreen", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await expect(page.locator(".site-options-notice")).toHaveCount(0);
  await page.evaluate(() => document.exitFullscreen());
  await expect(site(page).getByLabel("Game draft")).toHaveValue(
    "Keep fullscreen draft",
  );
  await expect(
    site(page).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
});
