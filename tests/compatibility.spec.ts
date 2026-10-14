import { test, expect, type Page } from "@playwright/test";
const target = "http://127.0.0.1:4199/compatibility-fixture";
const site = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
test.beforeEach(async ({ page, request }) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.settings", JSON.stringify({ motion: false }));
    }
  });
});
async function launch(page: Page) {
  await page.goto("/");
  await page.getByLabel("Search the web").fill(target);
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
}
test("metadata default off, opt-in is live, game controls and storage remain; restore preserves original title", async ({
  page,
}) => {
  await launch(page);
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Fixture game title");
  await site(page).getByLabel("Game draft").fill("unsaved");
  await page
    .getByRole("button", { name: "Page compatibility", exact: true })
    .click();
  const toggle = page.getByRole("checkbox", {
    name: "Adjust site metadata for this origin",
  });
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Website");
  await expect(site(page).locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("atlas.tabs")!)[0].title,
      ),
    )
    .toBe("Fixture game title");
  await site(page).getByRole("button", { name: "Move", exact: true }).click();
  await expect(site(page).locator("#score")).toHaveText("1");
  await site(page).getByRole("button", { name: "Run WASM" }).click();
  await expect(site(page).locator("#wasm-result")).toHaveText("WASM ready");
  await site(page).getByRole("button", { name: "Run worker" }).click();
  await expect(site(page).locator("#worker-result")).toHaveText("worker ready");
  await site(page).getByRole("button", { name: "Change metadata" }).click();
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Website");
  await page.getByRole("button", { name: "Restore page defaults" }).click();
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Dynamic game title");
  await expect(site(page).locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Dynamic description",
  );
  await expect(site(page).getByLabel("Game draft")).toHaveValue("unsaved");
  expect(
    await site(page)
      .locator("body")
      .evaluate(() => localStorage.getItem("game-progress")),
  ).toBe("retained");
  expect(
    await site(page)
      .locator("body")
      .evaluate(() => document.cookie),
  ).toContain("compat_fixture=retained");
  await expect(
    site(page).getByText(
      "Game controls and gameplay instructions stay visible.",
    ),
  ).toBeVisible();
});
test("same-frontend popout shares the opt-in; spoofed messages are ignored; diagnostics are local", async ({
  page,
  context,
}) => {
  await launch(page);
  await page
    .getByRole("button", { name: "Page compatibility", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Adjust site metadata for this origin" })
    .check();
  await page
    .getByRole("checkbox", { name: "Record local diagnostics (5 minutes)" })
    .check();
  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await expect(
    site(page).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export local diagnostics" }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toBe("atlas-local-diagnostics.json");
  const report = JSON.parse(
    await (await artifact.createReadStream())!
      .toArray()
      .then((chunks) => Buffer.concat(chunks).toString("utf8")),
  );
  expect(report.entries.length).toBeGreaterThan(0);
  expect(report.entries.length).toBeLessThanOrEqual(128);
  expect(
    report.entries.some(
      (e: any) => e.event === "worker" && /^[a-f0-9]{40}$/.test(e.revision),
    ),
  ).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(
    /ticket|authorization|compat_fixture|unsaved|description/i,
  );
  await page.evaluate(() =>
    window.postMessage(
      {
        atlas: 1,
        type: "compatibility-status",
        id: "x",
        origin: location.origin,
        rule: "game-metadata-v1",
        applied: 128,
        risk: true,
        throttled: false,
      },
      "*",
    ),
  );
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      site(popup)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Website");
  await popup
    .getByRole("button", { name: "Page compatibility", exact: true })
    .click();
  await popup.getByRole("button", { name: "Restore page defaults" }).click();
  await expect
    .poll(() =>
      site(page)
        .locator("body")
        .evaluate(() => document.title),
    )
    .toBe("Fixture game title");
});

test("compatibility notices wait through fullscreen and disabling never navigates", async ({
  page,
}) => {
  await launch(page);
  await page
    .getByRole("button", { name: "Dismiss compatibility notice" })
    .click();
  await site(page)
    .getByRole("button", { name: "Fullscreen", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  // Keep the real user fullscreen transition; toggle preference from a sibling
  // frontend context so the notification is generated while fullscreen.
  await page.evaluate(() => {
    const value = { "http://127.0.0.1:4199": true };
    localStorage.setItem("atlas.site-adjustments.v1", JSON.stringify(value));
    window.dispatchEvent(
      new StorageEvent("storage", { key: "atlas.site-adjustments.v1" }),
    );
  });
  await expect(page.locator(".site-options-notice")).toHaveCount(0);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".site-options-notice")).toContainText(
    "Compatibility adjustments applied.",
  );
  await expect(
    site(page).getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
});
