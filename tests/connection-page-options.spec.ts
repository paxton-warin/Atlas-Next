import { test, expect } from "@playwright/test";

import {
  openCurrentPopout,
  openLegacyStandalone,
  popoutSite,
} from "./popout-fixture";

const fixture = "http://127.0.0.1:4199/compatibility-fixture";

for (const view of ["embedded", "popout", "standalone"] as const) {
  test(`${view} has no Page options and ignores retired structure preferences`, async ({
    page,
    context,
    request,
  }) => {
    await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
    await context.addInitScript(() => {
      try {
        localStorage.setItem("atlas.onboarded", "true");
        localStorage.setItem(
          "atlas.document-surface.v1",
          JSON.stringify({ "http://127.0.0.1:4199": true }),
        );
      } catch {
        // A site-owned opaque document need not expose native storage.
      }
    });
    await page.goto("/");
    await page.getByLabel("Search the web").fill(fixture);
    await page.getByLabel("Search the web").press("Enter");
    await expect(
      page
        .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
        .frameLocator('iframe[title="Proxied website"]:not([hidden])')
        .locator("body"),
    ).toHaveCount(1);
    let target = page;
    if (view !== "embedded") {
      target =
        view === "standalone"
          ? await openLegacyStandalone(page, context)
          : await openCurrentPopout(page, context);
    }
    const site =
      view === "embedded"
        ? page
            .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
            .frameLocator('iframe[title="Proxied website"]:not([hidden])')
        : view === "standalone"
          ? target.frameLocator('iframe[title="Proxied website"]:not([hidden])')
          : popoutSite(target);
    await expect(site.locator("body")).toHaveCount(1);
    for (const width of [1440, 390]) {
      await target.setViewportSize({ width, height: 1000 });
      const connection =
        view === "standalone"
          ? target.getByText("Connection", { exact: true })
          : target.getByRole("button", {
              name: "Connection options",
              exact: true,
            });
      await connection.click();
      await expect(
        target.getByText("Page options", { exact: true }),
      ).toHaveCount(0);
      await expect(
        target.getByRole("button", { name: "Page compatibility", exact: true }),
      ).toHaveCount(0);
      await expect(
        target.getByRole("dialog", { name: "Page options", exact: true }),
      ).toHaveCount(0);
      await expect(
        target.getByRole("checkbox", {
          name: "Isolate page structure (experimental)",
          exact: true,
        }),
      ).toHaveCount(0);
      if (view === "standalone") {
        await expect(target.getByText(/Traffic node:/)).toBeVisible();
        await connection.click();
      } else {
        await expect(
          target.getByRole("menu", { name: "Connection options" }),
        ).toBeVisible();
        await target.keyboard.press("Escape");
        await expect(
          target.getByRole("menu", { name: "Connection options" }),
        ).toHaveCount(0);
        await expect(connection).toBeFocused();
      }
      await expect(
        site.getByRole("heading", { name: "Game fixture" }),
      ).toBeVisible();
    }
    const runtime =
      view === "standalone"
        ? target.mainFrame()
        : target
            .frames()
            .find(
              (frame) =>
                frame.parentFrame() === target.mainFrame() &&
                frame.url().startsWith("http://127.0.0.1:4181"),
            )!;
    // Read from the trusted controller realm, not the website's virtual DOM.
    const nativeText = await runtime.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>(
        'iframe[title="Proxied website"]:not([hidden])',
      )!;
      const body = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "body",
      )!.get!.call(frame.contentDocument);
      return Object.getOwnPropertyDescriptor(
        Node.prototype,
        "textContent",
      )!.get!.call(body) as string;
    });
    expect(nativeText).toContain("Game controls and gameplay instructions");
    await site.getByRole("button", { name: "Move", exact: true }).click();
    await expect(site.locator("#score")).toHaveText("1");
  });
}

test("removed Page options cannot be reactivated and Connection preserves the running page", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("/");
  await page.getByLabel("Search the web").fill(fixture);
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site.getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  await site.getByRole("button", { name: "Move", exact: true }).click();
  await expect(site.locator("#score")).toHaveText("1");
  const lease = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  // Retained preferences from an older release must remain inert, even if
  // another browser context announces a legacy preference change at runtime.
  await page.evaluate(() => {
    const key = "atlas.document-surface.v1";
    const value = JSON.stringify({ "http://127.0.0.1:4199": true });
    localStorage.setItem(key, value);
    dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: value,
        storageArea: localStorage,
      }),
    );
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const connection = page.getByRole("button", {
      name: "Connection options",
      exact: true,
    });
    await connection.click();
    const menu = page.getByRole("menu", {
      name: "Connection options",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Page options", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Page options", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("checkbox", {
        name: "Isolate page structure (experimental)",
        exact: true,
      }),
    ).toHaveCount(0);
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(connection).toBeFocused();
    expect(
      await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
    ).toBe(lease);
    await expect(site.locator("#score")).toHaveText("1");
  }
  await site.getByRole("button", { name: "Move", exact: true }).click();
  await expect(site.locator("#score")).toHaveText("2");
});
