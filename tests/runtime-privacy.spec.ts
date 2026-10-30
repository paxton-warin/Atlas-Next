import { test, expect } from "@playwright/test";

import { openLegacyStandalone } from "./popout-fixture";

test("generic popout title and compact routes keep literal site names out of wrapper URLs", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    if (window === top) {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.settings", JSON.stringify({ motion: false }));
    }
  });
  await page.goto("/");
  const target = "http://127.0.0.1:4199/fixture?games=coolmathgames";
  await page.getByLabel("Search the web", { exact: true }).fill(target);
  await page.getByLabel("Search the web", { exact: true }).press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  // Main exposes only the frontend Popout. The anonymous compatibility
  // wrapper advertises its explicitly separate direct-node link.
  const direct = await openLegacyStandalone(page, context);
  expect(direct.url()).not.toMatch(/coolmathgames|games=/i);
  const directSite = direct.frameLocator('iframe[title="Proxied website"]');
  await expect(
    directSite.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(direct).toHaveTitle("Atlas");
  expect(direct.url()).not.toContain("coolmathgames");
  const frame = direct
    .frames()
    .find((f) => f.parentFrame() === direct.mainFrame())!;
  expect(frame.url()).not.toMatch(/coolmathgames|games=/i);
  await expect(direct.getByLabel("Website address")).toHaveValue(target);
  await directSite.getByRole("button", { name: "Test fetch" }).click();
  await expect(directSite.locator("#fetch-result")).toContainText(
    "fetch works",
  );
  await direct.reload();
  await expect(
    directSite.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(direct).toHaveTitle("Atlas");
});
