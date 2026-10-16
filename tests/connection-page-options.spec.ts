import { test, expect } from "@playwright/test";

const fixture = "http://127.0.0.1:4199/compatibility-fixture";

for (const view of ["embedded", "popout", "standalone"] as const) {
  test(`${view} page options ignores retired structure preferences and has no isolation control`, async ({
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
      if (view === "standalone")
        await page.getByRole("button", { name: "Connection options" }).click();
      const opened = context.waitForEvent("page");
      await page
        .getByRole(view === "popout" ? "link" : "menuitem", {
          name: view === "popout" ? "Pop out tab" : "Open direct node tab",
          exact: true,
        })
        .click();
      target = await opened;
    }
    const site =
      view === "standalone"
        ? target.frameLocator('iframe[title="Proxied website"]:not([hidden])')
        : target
            .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
            .frameLocator('iframe[title="Proxied website"]:not([hidden])');
    await expect(site.locator("body")).toHaveCount(1);
    if (view === "standalone") {
      await target.getByText("Connection", { exact: true }).click();
      await target.getByText("Page options", { exact: true }).click();
    } else {
      await target.getByRole("button", { name: "Connection options" }).click();
      await target
        .getByRole("menuitem", { name: "Page options", exact: true })
        .click();
    }
    await expect(
      target.getByRole("checkbox", {
        name: "Isolate page structure (experimental)",
        exact: true,
      }),
    ).toHaveCount(0, { timeout: 1000 });
    await expect(
      site.getByRole("heading", { name: "Game fixture" }),
    ).toBeVisible();
    await expect(
      target.getByRole("checkbox", {
        name: "Adjust site metadata for this origin",
      }),
    ).toBeVisible();
    await expect(
      target.getByRole("checkbox", {
        name: "Record local diagnostics (5 minutes)",
      }),
    ).toBeVisible();
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
