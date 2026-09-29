import { test, expect } from "@playwright/test";

for (const method of ["GET", "POST"]) {
  test(`proxied ${method} navigation matches native Origin header behavior`, async ({
    page,
    context,
  }) => {
    const start = "http://127.0.0.1:4199/navigation/origin-start";
    const direct = await context.newPage();
    await direct.goto(start);
    await direct
      .getByRole(method === "GET" ? "link" : "button", {
        name: `Navigate with ${method}`,
      })
      .click();
    const nativeHeaders = JSON.parse(
      await direct.locator("#headers").innerText(),
    );
    expect(nativeHeaders.origin).toBe(
      method === "GET" ? null : "http://127.0.0.1:4199",
    );
    await direct.close();
    await page.addInitScript(() => {
      if (window === top) localStorage.setItem("atlas.onboarded", "true");
    });
    await page.goto("/");
    await page.getByLabel("Search the web").fill(start);
    await page.getByLabel("Search the web").press("Enter");
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]:not([hidden])');
    await expect(
      site.getByRole("heading", { name: "Origin fixture" }),
    ).toBeVisible();
    await site
      .getByRole(method === "GET" ? "link" : "button", {
        name: `Navigate with ${method}`,
      })
      .click();
    await expect(
      site.getByRole("heading", { name: "Request headers" }),
    ).toBeVisible();
    const proxiedHeaders = JSON.parse(
      await site.locator("#headers").innerText(),
    );
    expect(proxiedHeaders).toEqual(nativeHeaders);
  });
}
