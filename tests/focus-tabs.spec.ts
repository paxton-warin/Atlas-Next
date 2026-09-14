import { test, expect, type Page } from "@playwright/test";

const fixtureUrl = "http://127.0.0.1:4199/fixture";
const website = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');

for (const tabs of ["top", "sidebar"] as const) {
  for (const width of [1440, 390]) {
    test(`focus mode hides ${tabs} tabs and preserves the active website at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((tabs) => {
        localStorage.setItem("atlas.onboarded", "true");
        localStorage.setItem(
          "atlas.settings",
          JSON.stringify({ tabs, motion: false }),
        );
      }, tabs);
      await page.goto("/");
      await page.getByLabel("Search the web").fill(fixtureUrl);
      await page.getByLabel("Search the web").press("Enter");
      await expect(
        website(page).getByRole("heading", { name: "Proxy fixture ready" }),
      ).toBeVisible();
      await expect(page.locator(".tab.active .spinner")).toHaveCount(0);

      const strip = page.locator(
        tabs === "top" ? ".horizontal-tabs" : ".sidebar",
      );
      const normallyVisible = tabs === "top" || width > 600;
      await expect(strip).toBeVisible({ visible: normallyVisible });
      await expect(page.locator(".topbar")).toBeVisible();
      await expect(strip.locator(".tab.active")).toHaveCount(1);
      const savedTabs = await page.evaluate(() =>
        localStorage.getItem("atlas.tabs"),
      );
      const savedSession = await page.evaluate(() =>
        localStorage.getItem("atlas.nodeSession"),
      );

      // A live DOM edit plus the navigation listener catches a recreated/reloaded
      // iframe even when it happens to retain the same address and tab title.
      const input = website(page).locator('input[name="message"]');
      await input.fill("Keep this unsent form while minimized");
      const navigations: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) navigations.push(frame.url());
      });
      await page.getByRole("button", { name: "Enter focus mode" }).click();
      await expect(page.locator(".atlas")).toHaveClass(/focus-mode/);
      await expect(strip).toBeHidden();
      await expect(page.locator(".horizontal-tabs, .sidebar")).toBeHidden();
      await expect(page.locator(".topbar")).toBeHidden();
      await expect(page.locator(".main-nav")).toBeHidden();
      await expect(page.locator(".browser-toolbar")).toBeVisible();
      await expect(page.getByLabel("Address bar")).toBeVisible();
      await expect(page.getByLabel("Address bar")).toHaveValue(fixtureUrl);
      const exit = page.getByRole("button", { name: "Exit focus mode" });
      await expect(exit).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Connection options" }),
      ).toBeVisible();
      await expect(input).toHaveValue("Keep this unsent form while minimized");
      const toolbar = (await page.locator(".browser-toolbar").boundingBox())!;
      expect(toolbar.y).toBeLessThanOrEqual(1);
      const exitBox = (await exit.boundingBox())!;
      expect(exitBox.x).toBeGreaterThanOrEqual(0);
      expect(exitBox.x + exitBox.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `evidence/focus-tabs/${tabs}-${width}-focused.png`,
      });

      // The toolbar must remain functional, not just visually present.
      await page.getByLabel("Address bar").focus();
      await expect(page.getByLabel("Address bar")).toBeFocused();
      await input.fill("Still interactive in focus mode");
      await exit.click();
      await expect(page.locator(".atlas")).not.toHaveClass(/focus-mode/);
      await expect(strip).toBeVisible({ visible: normallyVisible });
      await expect(strip.locator(".tab.active")).toHaveCount(1);
      await expect(page.locator(".topbar")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Enter focus mode" }),
      ).toBeVisible();
      await expect(page.getByLabel("Address bar")).toHaveValue(fixtureUrl);
      await expect(input).toHaveValue("Still interactive in focus mode");
      expect(navigations).toEqual([]);
      expect(
        await page.evaluate(() => localStorage.getItem("atlas.tabs")),
      ).toBe(savedTabs);
      expect(
        await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
      ).toBe(savedSession);
      expect(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("atlas.settings")!).tabs,
        ),
      ).toBe(tabs);
    });
  }
}
