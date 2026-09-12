import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("new-tab footer has tight edge spacing, clear credit and the package version", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("/");
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = (await page.locator(".main-panel").boundingBox())!;
    const credit = page.locator(".newtab-credit");
    const customize = page.getByRole("button", {
      name: "Customize",
      exact: true,
    });
    await expect(credit).toContainText("Made by Paxton Warin");
    await expect(page.locator(".newtab-version")).toHaveText(`v${version}`);
    const left = (await credit.boundingBox())!,
      right = (await customize.boundingBox())!;
    expect(left.x - panel.x).toBeGreaterThanOrEqual(8);
    expect(left.x - panel.x).toBeLessThanOrEqual(22);
    expect(panel.x + panel.width - right.x - right.width).toBeLessThanOrEqual(
      22,
    );
    await expect(credit.locator("strong")).toHaveCSS("font-weight", "600");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if ([1440, 390].includes(width))
      await page.screenshot({
        path: `evidence/node-ui-cleanup/newtab-${width}.png`,
      });
  }
});

test("compact plus is the only new-tab action and preserves open website tabs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.settings", JSON.stringify({ tabs: "top" }));
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go to homepage" }),
  ).toHaveCount(0);
  const plus = page.getByRole("button", { name: "New tab", exact: true });
  await expect(plus).toHaveCount(1);
  expect((await plus.boundingBox())!.width).toBeLessThanOrEqual(32);
  await plus.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Search the web")).toBeVisible();
  await expect(page.locator(".horizontal-tabs .tab")).toHaveCount(1);
  await page.locator(".tab-main").click();
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await page.screenshot({ path: "evidence/node-ui-cleanup/top-tabs.png" });
});

test("Support starts at a straightforward form and uses the interface font at all sizes", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "New ticket", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create ticket", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".support-page")).not.toContainText(
    "Without an account",
  );
  await expect(page.locator(".support-page")).not.toContainText("Let's talk");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const fonts = await page.locator(".support-page").evaluate((el) => ({
      page: getComputedStyle(el).fontFamily,
      heading: getComputedStyle(el.querySelector(".ticket-body h2")!)
        .fontFamily,
    }));
    expect(fonts.heading).toBe(fonts.page);
    expect(fonts.heading).not.toMatch(/Lora|Georgia/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if ([1440, 390].includes(width))
      await page.screenshot({
        path: `evidence/node-ui-cleanup/support-${width}.png`,
      });
  }
});
