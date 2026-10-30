import { test, expect } from "@playwright/test";

async function seed(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "sidebar", compact: true, restore: true }),
    );
    localStorage.setItem(
      "atlas.tabs",
      JSON.stringify(
        ["First", "Second", "Third"].map((title, i) => ({
          id: `hub-tab-${i}`,
          url: `http://127.0.0.1:4199/fixture?tab=${i}`,
          title,
          engine: "runtime",
        })),
      ),
    );
  });
  await page.goto("/");
  await expect(
    page.locator(".sidebar-heading").getByTitle("3 open tabs"),
  ).toBeVisible();
}
test("condensed tabs can be moved and pinned without remounting browsing frames", async ({
  page,
}) => {
  await seed(page);
  await expect(page.locator(".topbar")).toHaveCSS("width", "56px");
  await page.getByRole("tab", { name: "First", exact: true }).click();
  const frame = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    frame.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await frame.locator('input[name="message"]').fill("Do not lose this draft");
  const before = await page
    .locator('iframe[title="Atlas isolated browsing runtime"]')
    .getAttribute("src");
  await page
    .getByRole("tab", { name: "Third", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move up" }).click();
  expect(
    await page
      .locator(".sidebar .tab")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-tab-id")),
      ),
  ).toEqual(["hub-tab-0", "hub-tab-2", "hub-tab-1"]);
  await expect(frame.locator('input[name="message"]')).toHaveValue(
    "Do not lose this draft",
  );
  expect(
    await page
      .locator('iframe[title="Atlas isolated browsing runtime"]')
      .getAttribute("src"),
  ).toBe(before);
  await page
    .getByRole("tab", { name: "Third", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin tab" }).click();
  expect(
    await page
      .locator(".sidebar .tab")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-tab-id")),
      ),
  ).toEqual(["hub-tab-2", "hub-tab-0", "hub-tab-1"]);
  await page.screenshot({
    path: "evidence/hub-combined-20261020/screenshots/tabs-desktop.png",
  });
});
test("tab search, close/undo and mobile drawer are usable", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByRole("button", { name: "Search open tabs", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Find an open tab" }).fill("Second");
  await page
    .getByRole("dialog", { name: "Search open tabs" })
    .getByRole("button", { name: /Second/ })
    .click();
  await page
    .getByRole("tab", { name: "Second", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close tab" }).click();
  await expect(page.locator('.sidebar [role="tab"]')).toHaveCount(2);
  // Compact chrome keeps undo in the accessible Search tabs panel.
  await page
    .getByRole("button", { name: "Search open tabs", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Search open tabs" })
    .getByRole("button", { name: "Reopen last closed tab", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Search open tabs" })
    .getByRole("button", { name: "Close tab list", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search open tabs" }),
  ).toHaveCount(0);
  await expect(page.locator('.sidebar [role="tab"]')).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Tabs (3)", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Open tabs" })).toBeVisible();
  await page.locator(".tab-drawer .tab-actions").first().click();
  await expect(page.getByRole("menu", { name: "Tab actions" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Open tabs" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Pin tab" }).click();
  await page.getByRole("button", { name: "Tabs (3)", exact: true }).click();
  await page.screenshot({
    path: "evidence/hub-combined-20261020/screenshots/tabs-mobile.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("dragging to the final insertion target changes display order only", async ({
  page,
}) => {
  await seed(page);
  const from = page.locator('.sidebar [data-tab-id="hub-tab-0"]'),
    to = page.locator('.sidebar [data-tab-id="hub-tab-2"]');
  await from.dragTo(to, { targetPosition: { x: 20, y: 35 } });
  expect(
    await page
      .locator(".sidebar .tab")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-tab-id")),
      ),
  ).toEqual(["hub-tab-1", "hub-tab-2", "hub-tab-0"]);
});
test("desktop and narrow welcome screens get deliberate success captures", async ({
  page,
}) => {
  await seed(page);
  for (const [width, height] of [
    [1440, 1000],
    [1366, 768],
    [768, 1024],
    [390, 844],
    [320, 700],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: `evidence/hub-combined-20261020/screenshots/browser-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
