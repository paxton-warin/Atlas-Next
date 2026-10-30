import { test, expect, type Page } from "@playwright/test";
const output = "evidence/atlas-v21/review-fixes-20261021/chrome-after";
async function start(
  page: Page,
  width: number,
  collapsed = true,
  compact = true,
) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(
    ({ collapsed, compact }) => {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.sidebarCollapsed", String(collapsed));
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({
          tabs: "sidebar",
          theme: "forest",
          mode: "dark",
          motion: false,
          compact,
        }),
      );
    },
    { collapsed, compact },
  );
  // Synthetic enabled controls qualify presentation geometry, not real account authentication.
  await page.route("**/api/hub/state", (r) =>
    r.fulfill({
      json: {
        enabled: false,
        authenticated: true,
        csrf: "ui-only",
        grant: {
          profileId: "ui-only",
          contextId: "ui-only",
          sessionId: "ui-only",
        },
      },
    }),
  );
  await page.route("**/api/hub/support/notifications", (r) =>
    r.fulfill({ json: { notifications: [], unread: 0 } }),
  );
  await page.goto("/");
  await expect(page.getByLabel("Search the web")).toBeVisible();
}
async function launch(page: Page) {
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]')
      .getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
}
for (const width of [1440, 768, 600])
  test(`rail controls and authenticated footer tools stay accessible at${width}`, async ({
    page,
  }) => {
    await start(page, width, true);
    await page.mouse.move(width - 1, 899);
    const rail = page.locator(".topbar");
    await expect(rail).toHaveCSS("width", "56px");
    const center = (await rail.boundingBox())!.x + 28;
    // Current compact chrome intentionally moves secondary tools into More; only
    // the primary rail controls should be centered in the56px track.
    for (const selector of [
      ".brand-mark",
      ".main-nav button",
      ".sidebar-toggle",
      ".new-tab",
      '.tab-tools button[aria-label="Search open tabs"]',
      ".rail-utilities-toggle",
      ".hub-support-trigger",
    ]) {
      const boxes = await page.locator(selector).evaluateAll((es) =>
        es
          .filter((e) => e.checkVisibility())
          .map((e) => {
            const r = e.getBoundingClientRect(),
              s = e.querySelector("svg")?.getBoundingClientRect();
            return {
              center: r.x + r.width / 2,
              icon: s ? s.x + s.width / 2 : null,
              left: r.left,
              right: r.right,
            };
          }),
      );
      expect(boxes.length, selector).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(Math.abs(b.center - center), selector).toBeLessThanOrEqual(0.6);
        if (b.icon !== null)
          expect(
            Math.abs(b.icon - center),
            selector + " icon",
          ).toBeLessThanOrEqual(0.6);
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(56);
      }
    }
    const more = page.getByRole("button", {
      name: "More Atlas tools",
      exact: true,
    });
    await more.click();
    const tools = page.getByRole("group", { name: "Atlas tools" });
    await expect(tools.locator(".profile-trigger")).toBeVisible();
    for (const button of await tools.getByRole("button").all()) {
      if (!(await button.isVisible())) continue;
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(36);
    }
    await page.keyboard.press("Escape");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();
    await page
      .getByRole("button", { name: "Expand tabs", exact: true })
      .click();
    await page.mouse.move(width - 1, 899);
    await expect(rail).toHaveCSS("width", "232px");
    await page
      .getByRole("button", { name: "Collapse tabs", exact: true })
      .click();
    await page.mouse.move(width - 1, 899);
    await expect(rail).toHaveCSS("width", "56px");
    await page.screenshot({ path: `${output}/centered-${width}.png` });
  });
for (const compact of [false, true])
  test(`address gutters and arrow preserve keyboard/frame behavior compact=${compact}`, async ({
    page,
  }) => {
    await start(page, 1440, true, compact);
    await launch(page);
    const host = page.locator(
      'iframe[title="Atlas isolated browsing runtime"]',
    );
    await host.evaluate((el) => ((window as any).__reviewFrame = el));
    const src = await host.getAttribute("src");
    const lease = await page.evaluate(() =>
      localStorage.getItem("atlas.nodeSession"),
    );
    const toolbar = (await page.locator(".browser-toolbar").boundingBox())!,
      field = (await page.locator(".address-bar").boundingBox())!,
      input = (await page.getByLabel("Address bar").boundingBox())!;
    expect(toolbar.height).toBe(compact ? 48 : 56);
    expect(field.height).toBe(40);
    expect(field.y - toolbar.y).toBeCloseTo(compact ? 3.5 : 7.5, 1);
    expect(toolbar.y + toolbar.height - field.y - field.height).toBeCloseTo(
      compact ? 4.5 : 8.5,
      1,
    );
    expect(
      Math.abs(input.y + input.height / 2 - field.y - field.height / 2),
    ).toBeLessThanOrEqual(0.6);
    await expect(page.locator(".address-bar kbd")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Go to address", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Address bar")).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+K Control+K",
    );
    await page
      .getByLabel("Address bar")
      .evaluate((el) => (el as HTMLInputElement).blur());
    await page.keyboard.press("Control+k");
    await expect(page.getByLabel("Address bar")).toBeFocused();
    expect(
      await host.evaluate((el) => el === (window as any).__reviewFrame),
    ).toBe(true);
    expect(await host.getAttribute("src")).toBe(src);
    expect(
      await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
    ).toBe(lease);
    await page
      .getByLabel("Address bar")
      .fill("http://127.0.0.1:4199/fixture?arrow=1");
    await page
      .getByRole("button", { name: "Go to address", exact: true })
      .click();
    await expect(page.getByLabel("Address bar")).toHaveValue(
      "http://127.0.0.1:4199/fixture?arrow=1",
    );
    await expect(
      page
        .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
        .frameLocator('iframe[title="Proxied website"]')
        .getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    await page.screenshot({
      path: `${output}/address-${compact ? "compact" : "normal"}.png`,
    });
    await page.getByRole("button", { name: "Enter focus mode" }).click();
    expect((await page.locator(".browser-toolbar").boundingBox())!.height).toBe(
      44,
    );
    expect((await page.locator(".address-bar").boundingBox())!.height).toBe(28);
  });
test("tab error is explicit text and an explanatory preview, not a red dot", async ({
  page,
}) => {
  await start(page, 1440, true);
  await launch(page);
  const id = await page
    .locator(".sidebar .tab.active")
    .getAttribute("data-tab-id");
  const runtime = page.frameLocator(
    'iframe[title="Atlas isolated browsing runtime"]',
  );
  // Feed the existing trusted runtime event to qualify the error view, not a live-network failure.
  await runtime
    .locator("body")
    .evaluate(
      (_, id) =>
        parent.postMessage(
          { atlas: 1, type: "error", id, message: "Synthetic review error" },
          "*",
        ),
      id,
    );
  const label = page.locator(".sidebar .tab-page-error");
  await expect(label).toHaveText("Page error");
  await expect(label).toBeVisible();
  await expect(page.locator(".tab-error-dot")).toHaveCount(0);
  await page.locator(".sidebar .tab-main").hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "This page could not load. Select the tab for details and retry.",
  );
  await page.screenshot({
    path: `output/error-rail.png`.replace("output", output),
  });
  await page.getByRole("button", { name: "Expand tabs", exact: true }).click();
  await expect(label).toBeVisible();
  await page.screenshot({ path: `${output}/error-expanded.png` });
});
