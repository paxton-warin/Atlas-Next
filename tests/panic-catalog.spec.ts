import { test, expect, type Page } from "@playwright/test";
test.beforeEach(async ({ request }) => {
  const response = await request.post(
    "http://127.0.0.1:4199/__test/reset-browser-limits",
  );
  expect(await response.text()).toBe("FIXTURE_BROWSER_LIMITS_RESET");
});
const confirmDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Use this panic shortcut?", exact: true });
async function start(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Use defaults", exact: true }).click();
}
async function privacy(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Privacy & data", exact: true })
    .click();
}
const stored = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.settings") || "{}"),
  );

test("compound recording, easy-key confirmation, cancellation and persistence work in settings and wizard", async ({
  page,
}) => {
  await start(page);
  await privacy(page);
  const input = page.getByLabel("Panic key", { exact: true });
  await input.press("Meta+Escape");
  await expect(input).toHaveValue("Cmd + Esc");
  expect((await stored(page)).exitKey).toBe("Meta+Escape");
  await input.press("i");
  await expect(confirmDialog(page)).toContainText("accidentally");
  expect((await stored(page)).exitKey).toBe("Meta+Escape");
  await expect(
    confirmDialog(page).getByRole("button", { name: "Choose another" }),
  ).toBeFocused();
  await confirmDialog(page)
    .getByRole("button", { name: "Choose another" })
    .click();
  await expect(input).toHaveValue("Cmd + Esc");
  await input.press("j");
  await confirmDialog(page).getByRole("button", { name: "Use anyway" }).click();
  await expect(input).toHaveValue("J");
  await input.press("Backspace");
  await expect(input).toHaveValue("");
  await input.press("Control+Shift+k");
  await expect(input).toHaveValue("Ctrl + Shift + K");
  await page.reload();
  await privacy(page);
  await expect(page.getByLabel("Panic key", { exact: true })).toHaveValue(
    "Ctrl + Shift + K",
  );
  await page.getByRole("button", { name: "Reopen welcome wizard" }).click();
  const wizard = page
    .getByRole("dialog")
    .filter({ has: page.locator("#wizard-title") });
  await wizard
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button", { name: /Privacy & data$/ })
    .click();
  await wizard.getByLabel("Panic key", { exact: true }).press("i");
  await expect(confirmDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).not.toBeVisible();
  await expect(wizard.getByLabel("Panic key", { exact: true })).toHaveValue(
    "Ctrl + Shift + K",
  );
});

test("manual shortcut picker explains Mac and Ctrl browser conflicts before saving", async ({
  page,
}) => {
  await start(page);
  await privacy(page);
  await page.getByText("Choose keys manually", { exact: true }).click();
  for (const modifier of ["Cmd", "Ctrl"]) {
    await page
      .getByRole("button", { name: `Modifier ${modifier}`, exact: true })
      .click();
    for (const [key, reason] of [
      ["t", "new browser tab"],
      ["f", "Find on page"],
    ]) {
      await page.getByLabel("Shortcut main key").selectOption(key);
      await page
        .getByRole("button", { name: "Use shortcut", exact: true })
        .click();
      await expect(confirmDialog(page)).toContainText(reason);
      await expect(confirmDialog(page)).toContainText(
        modifier === "Cmd" ? "macOS" : "ChromeOS",
      );
      await expect(confirmDialog(page)).toContainText("before Atlas receives");
      if (modifier === "Cmd" && key === "t")
        await page.screenshot({
          animations: "disabled",
          path: "evidence/panic-shortcuts/shortcut-warning.png",
        });
      await confirmDialog(page)
        .getByRole("button", { name: "Choose another" })
        .click();
    }
    await page
      .getByRole("button", { name: `Modifier ${modifier}`, exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Modifier Cmd", exact: true }).click();
  await page.getByLabel("Shortcut main key").selectOption("f");
  await page.getByRole("button", { name: "Use shortcut", exact: true }).click();
  await confirmDialog(page).getByRole("button", { name: "Use anyway" }).click();
  expect((await stored(page)).exitKey).toBe("Meta+f");
});

for (const engine of ["scramjet"])
  test(`${engine} requires the whole compound shortcut in the actual proxied fixture`, async ({
    page,
  }) => {
    await page.route("https://example.test/panic", (r) =>
      r.fulfill({ contentType: "text/html", body: "<h1>Exited</h1>" }),
    );
    await page.addInitScript((engine) => {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({
          engine,
          exitKey: "Meta+Escape",
          exitUrl: "https://example.test/panic",
        }),
      );
    }, engine);
    await page.goto("/");
    await page
      .getByLabel("Search the web")
      .fill("http://127.0.0.1:4199/fixture");
    await page.getByLabel("Search the web").press("Enter");
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]');
    await expect(
      site.getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    await site.locator('input[name="message"]').press("Meta+Escape");
    await expect(page).toHaveURL("http://localhost:4180/");
    await site.getByRole("heading", { name: "Proxy fixture ready" }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Escape");
    await expect(page).toHaveURL("http://localhost:4180/");
    await page.keyboard.press("Meta+Escape");
    await expect(page).toHaveURL("https://example.test/panic");
  });

test("restore defaults on without overwriting a saved opt-out, and compound keys work in the shell", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Restore tabs", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("switch", { name: "Restore tabs", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Restore tabs", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await privacy(page);
  await page.getByLabel("Panic key", { exact: true }).press("Meta+Escape");
  await page.getByLabel("Panic destination").fill("https://example.test/panic");
  await page.getByLabel("Panic destination").press("Tab");
  await page.route("https://example.test/panic", (r) =>
    r.fulfill({ contentType: "text/html", body: "Exited" }),
  );
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await page.locator(".home-hero h1").click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("http://localhost:4180/");
  await page.keyboard.press("Meta+Escape");
  await expect(page).toHaveURL("https://example.test/panic");
});

test("large games/apps catalog searches, filters, paginates, favorites and launches through the runtime", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Games", exact: true }).click();
  await expect(page.locator(".game-card")).toHaveCount(48);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator(".game-card")).toHaveCount(96);
  await page.getByLabel("Search games", { exact: true }).fill("Cookie Clicker");
  await expect(page.locator(".game-card")).toHaveCount(1);
  const cover = page.locator(".catalog-cover img");
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Favorite Cookie Clicker", exact: true })
    .click();
  await page.getByLabel("Search games", { exact: true }).fill("");
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".game-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByLabel("Search apps", { exact: true }).fill("Spotify");
  await expect(page.locator(".game-card")).toHaveCount(1);
  await page.getByLabel("Search apps", { exact: true }).fill("");
  await page.getByLabel("Filter apps by category").selectOption("Productivity");
  await expect(page.locator(".game-info .eyebrow").first()).toHaveText(
    "Productivity",
  );
  await page
    .getByLabel("Filter apps by category")
    .selectOption("All categories");
  await page.screenshot({
    animations: "disabled",
    path: "evidence/panic-shortcuts/apps-desktop.png",
  });
  // Keep the real app navigation/transport path while targeting a deterministic local web app.
  await page.route("**/api/catalog", async (route) => {
    const response = await route.fetch();
    const items = await response.json();
    items.find((r: any) => r.name === "Spotify" && r.kind === "app").url =
      "http://127.0.0.1:4199/fixture";
    await route.fulfill({ json: items });
  });
  await page.reload();
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByLabel("Search apps", { exact: true }).fill("Spotify");
  await page.getByRole("button", { name: "Open Spotify", exact: true }).click();
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
});

test("system pages stay centered and thin bordered on desktop and fit mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await start(page);
  for (const name of ["Settings", "Support", "Games", "Apps"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const content = page.locator(".page-scroll > .page");
    await expect(content).toBeVisible();
    const offsets = await content.evaluate((el) => {
      const box = el.getBoundingClientRect(),
        parent = el.parentElement!.getBoundingClientRect();
      return {
        delta: Math.abs(
          (box.left + box.right - parent.left - parent.right) / 2,
        ),
        width: box.width,
      };
    });
    expect(offsets.delta).toBeLessThan(2);
    expect(offsets.width).toBeLessThanOrEqual(1280);
    await expect(page.locator(".main-nav")).toHaveCSS(
      "border-top-width",
      "1px",
    );
    await expect(page.locator(".main-panel")).toHaveCSS(
      "border-top-width",
      "1px",
    );
    if (name === "Games")
      await page.screenshot({
        animations: "disabled",
        path: "evidence/panic-shortcuts/games-desktop.png",
      });
    if (name === "Settings")
      await page.screenshot({
        animations: "disabled",
        path: "evidence/panic-shortcuts/settings-centered.png",
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Settings", "Support", "Games", "Apps"]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
  await page.screenshot({
    animations: "disabled",
    path: "evidence/panic-shortcuts/apps-mobile.png",
  });
  await privacy(page);
  await page.getByLabel("Panic key", { exact: true }).press("j");
  await expect(
    confirmDialog(page).getByRole("button", { name: "Use anyway" }),
  ).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: "evidence/panic-shortcuts/panic-mobile.png",
  });
});
