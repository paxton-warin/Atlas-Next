import { test, expect } from "@playwright/test";

for (const compact of [true, false]) {
  test(`horizontal New tab stays left aligned with collapsed sidebar preference, compact=${compact}`, async ({
    page,
  }) => {
    await page.addInitScript((compact) => {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.sidebarCollapsed", "true");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({ tabs: "top", compact }),
      );
    }, compact);
    await page.goto("/");
    for (const width of [320, 390, 601, 768, 1366]) {
      await page.setViewportSize({ width, height: 850 });
      const strip = page.locator(".horizontal-tabs");
      const button = strip.getByRole("button", {
        name: "New tab",
        exact: true,
      });
      await expect(button).toBeVisible();
      const row = (await strip.boundingBox())!,
        box = (await button.boundingBox())!;
      expect(box.x - row.x).toBeLessThan(20);
      expect(box.y).toBeGreaterThanOrEqual(row.y);
      expect(row.height).toBeLessThanOrEqual(42);
      expect(box.width).toBeLessThanOrEqual(32);
      expect(box.height).toBeLessThanOrEqual(30);
      await expect(button.locator("span")).toBeHidden();
      await expect(button).toHaveCSS("white-space", "nowrap");
    }
    await page.screenshot({
      path: `evidence/topbar-fix/top-tabs-${compact ? "compact" : "comfortable"}.png`,
    });
  });
}

test("top tabs keep inline close buttons, scroll without clipping controls, and preserve the collapsed rail on switch", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.sidebarCollapsed", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "top", restore: true }),
    );
    localStorage.setItem(
      "atlas.tabs",
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          url: "http://127.0.0.1:4199/fixture?tab=" + i,
          title: "A long title for tab " + i,
          engine: "scramjet",
        })),
      ),
    );
  });
  await page.goto("/");
  const tabs = page.locator(".horizontal-tabs .tab");
  await expect(tabs).toHaveCount(10);
  for (const width of [320, 601, 1366]) {
    await page.setViewportSize({ width, height: 850 });
    const close = tabs.first().getByRole("button", { name: /Close/ });
    await expect(close).toBeVisible();
    await expect(close).toHaveCSS("position", "static");
    const tab = (await tabs.first().boundingBox())!,
      button = (await close.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(tab.y);
    expect(button.y + button.height).toBeLessThanOrEqual(tab.y + tab.height);
  }
  await tabs.last().getByRole("button", { name: /Close/ }).click();
  await expect(tabs).toHaveCount(9);
  await tabs.first().locator(".tab-main").click();
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]')
      .getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 850 });
  const fits = await page.locator(".browser-toolbar").evaluate((el) => {
    const row = el.getBoundingClientRect();
    return Array.from(el.children).every((child) => {
      const b = child.getBoundingClientRect();
      return !b.width || (b.x >= row.x && b.right <= row.right);
    });
  });
  expect(fits).toBe(true);
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Enter focus mode" }).click();
  await expect(
    page.getByRole("button", { name: "Exit focus mode" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Exit focus mode" }).click();
  await page.setViewportSize({ width: 1366, height: 850 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await page.getByRole("button", { name: /Sidebar tabs/ }).click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "44px");
  await expect(page.locator(".sidebar .new-tab")).toHaveCSS("width", "36px");
  await expect(page.locator(".horizontal-tabs")).toHaveCount(0);
});
