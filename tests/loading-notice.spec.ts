import { test, expect } from "@playwright/test";

for (const [width, height] of [[1366, 768], [390, 844]]) {
  test(`slow notice keeps the same website usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      if (window !== top) return;
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.settings", JSON.stringify({ motion: false, restore: true }));
    });
    await page.goto("/");
    await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
    await page.getByLabel("Search the web").press("Enter");
    const host = page.locator('iframe[title="Atlas isolated browsing runtime"]');
    const runtime = page.frameLocator('iframe[title="Atlas isolated browsing runtime"]');
    const site = runtime.frameLocator('iframe[title="Proxied website"]');
    await expect(site.getByRole("heading", { name: "Proxy fixture ready" })).toBeVisible();
    await site.locator('input[name="message"]').fill("draft before notice");
    await host.evaluate(el => { (window as any).__loadingNoticeHost = el; });
    const previousSource = await host.getAttribute("src");
    const previousLease = await page.evaluate(() => localStorage.getItem("atlas.nodeSession"));
    // Exercise the genuine trusted runtime message route, not a shell state setter.
    await runtime.locator("body").evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Proxied website"]')!;
      parent.postMessage({ atlas: 1, type: "slow", id: frame.name.slice("view-".length), message: "Delayed fixture load" }, "http://localhost:4180");
    });
    await expect(page.getByRole("status").filter({ hasText: "Still loading. You can keep using this page." })).toBeVisible();
    await expect(page.locator(".runtime-error")).toHaveCount(0);
    await site.locator('input[name="message"]').fill("draft remains editable during notice");
    await expect(site.locator('input[name="message"]')).toHaveValue("draft remains editable during notice");
    expect(await host.evaluate(el => el === (window as any).__loadingNoticeHost)).toBe(true);
    expect(await host.getAttribute("src")).toBe(previousSource);
    expect(await page.evaluate(() => localStorage.getItem("atlas.nodeSession"))).toBe(previousLease);
    await page.getByRole("button", { name: "Dismiss loading notice", exact: true }).click();
    await expect(page.locator(".runtime-slow")).toHaveCount(0);
    await expect(site.locator('input[name="message"]')).toHaveValue("draft remains editable during notice");
    await runtime.locator("body").evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Proxied website"]')!;
      parent.postMessage({ atlas: 1, type: "loaded", id: frame.name.slice("view-".length) }, "http://localhost:4180");
    });
    await expect(page.locator(".runtime-error,.runtime-slow")).toHaveCount(0);
  });
}
