import { test, expect } from "@playwright/test";

test("Page options stays inside Connection on desktop and narrow screens", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site.getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  const lease = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(
      page.getByRole("button", { name: "Page compatibility", exact: true }),
    ).toHaveCount(0);
    const connection = page.getByRole("button", {
      name: "Connection options",
      exact: true,
    });
    await connection.click();
    const item = page.getByRole("menuitem", {
      name: "Page options",
      exact: true,
    });
    await expect(item).toBeVisible();
    await item.click();
    const panel = page.getByRole("dialog", {
      name: "Page options",
      exact: true,
    });
    await expect(panel).toBeVisible();
    await expect(
      page.getByRole("menu", { name: "Connection options" }),
    ).toHaveCount(0);
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await panel
      .getByRole("checkbox", { name: "Adjust site metadata for this origin" })
      .focus();
    await page.keyboard.press("Tab");
    await expect(
      panel.getByRole("button", { name: "Restore page defaults" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(connection).toBeFocused();
    expect(
      await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
    ).toBe(lease);
    await expect(
      site.getByRole("heading", { name: "Game fixture" }),
    ).toBeVisible();
  }
});
