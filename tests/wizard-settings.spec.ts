import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const presets = [
  "Atlas",
  "Google",
  "Gmail",
  "Google Drive",
  "Google Docs",
  "Google Sheets",
  "Google Classroom",
];
const wizard = (page: Page) =>
  page.getByRole("dialog").filter({ has: page.locator("#wizard-title") });
const step = async (page: Page, name: string) =>
  wizard(page)
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button", { name: new RegExp(name + "$") })
    .click();
const finish = async (page: Page) => {
  await step(page, "Finish");
  await wizard(page)
    .getByRole("button", { name: "Open Atlas", exact: true })
    .click();
};
async function settingsTab(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Tab & icon", exact: true })
    .click();
}

test("full wizard shares appearance, browser, tab presets, panic and data settings, with persistence", async ({
  page,
}) => {
  await page.goto("/");
  await step(page, "Appearance");
  await wizard(page).getByRole("button", { name: "Theme Dune" }).click();
  await wizard(page).getByRole("button", { name: "Mode light" }).click();
  for (const label of ["Custom accent", "Background dimming", "Wallpaper blur"])
    await expect(wizard(page).getByLabel(label, { exact: true })).toBeVisible();
  await wizard(page)
    .getByRole("button", { name: "Your photo", exact: true })
    .click();
  await wizard(page)
    .getByLabel("Upload an image")
    .setInputFiles("web/public/tab-icons/drive.png");
  await wizard(page).getByRole("switch", { name: "Animations" }).click();
  await step(page, "Browser");
  await wizard(page)
    .getByRole("button", { name: /Top tabs/ })
    .click();
  await wizard(page).getByRole("switch", { name: "Compact spacing" }).click();
  await expect(
    wizard(page).getByRole("switch", { name: "Restore tabs" }),
  ).toHaveAttribute("aria-checked", "true");
  await wizard(page)
    .getByRole("switch", { name: "Search autocomplete" })
    .click();
  await expect(wizard(page)).toContainText(
    "Websites open through your assigned browsing connection.",
  );
  await wizard(page)
    .getByRole("combobox", { name: "Search engine", exact: true })
    .selectOption("https://duckduckgo.com/?q=%s");
  await step(page, "Tab & icon");
  await expect(
    wizard(page).locator(".tab-preset:not(.custom-preset)"),
  ).toHaveCount(7);
  for (const name of presets) {
    const button = wizard(page).getByRole("button", {
      name: "Tab preset " + name,
      exact: true,
    });
    await expect
      .poll(() =>
        button
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await button.click();
    await expect(page).toHaveTitle(name);
  }
  await page.screenshot({
    path: "evidence/wizard-settings/presets-wizard.png",
  });
  await wizard(page)
    .getByRole("button", { name: "Tab preset Custom", exact: true })
    .click();
  await wizard(page)
    .getByLabel("Custom tab title", { exact: true })
    .fill("Study desk");
  await wizard(page)
    .getByLabel("Upload custom tab icon", { exact: true })
    .setInputFiles("web/public/tab-icons/drive.png");
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    /^data:image\/png;base64,/,
  );
  await expect
    .poll(() =>
      wizard(page)
        .locator(".tab-appearance-preview img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(64);
  const icon = await page.locator('head link[rel="icon"]').getAttribute("href");
  await wizard(page)
    .getByRole("button", { name: "Tab preset Atlas", exact: true })
    .click();
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
  await wizard(page)
    .getByRole("button", { name: "Tab preset Custom", exact: true })
    .click();
  await expect(page).toHaveTitle("Study desk");
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    icon!,
  );
  await step(page, "Privacy & data");
  await wizard(page).getByLabel("Panic key", { exact: true }).press("F8");
  await wizard(page)
    .getByLabel("Panic destination", { exact: true })
    .fill("https://example.test/panic");
  await wizard(page)
    .getByLabel("Panic destination", { exact: true })
    .press("Tab");
  await wizard(page).getByRole("switch", { name: "Remember history" }).click();
  for (const name of [
    "Export settings",
    "Clear history",
    "Clear website data",
    "Reset settings",
  ])
    await expect(
      wizard(page).getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(wizard(page).getByLabel("Import settings")).toBeAttached();
  await page.screenshot({
    path: "evidence/wizard-settings/privacy-wizard.png",
  });
  await step(page, "Finish");
  await expect(wizard(page)).toContainText("Atlas");
  await page.keyboard.press("F8");
  await expect(wizard(page)).toBeVisible();
  await wizard(page)
    .getByRole("button", { name: "Open Atlas", exact: true })
    .click();
  await page.reload();
  await expect(page).toHaveTitle("Study desk");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.settings")!),
  );
  expect(saved).toMatchObject({
    theme: "sand",
    mode: "light",
    background: "wallpaper",
    motion: false,
    tabs: "top",
    compact: false,
    restore: true,
    autocomplete: false,
    engine: "scramjet",
    search: "https://duckduckgo.com/?q=%s",
    tabPreset: "custom",
    title: "Study desk",
    exitKey: "F8",
    exitUrl: "https://example.test/panic",
    history: false,
  });
  expect(saved.tabIcon).toBe(icon);
  expect(saved.wallpaper).toMatch(/^data:image\/png;/);
  await settingsTab(page);
  await expect(page.getByLabel("Custom tab title")).toHaveValue("Study desk");
  await expect(page.getByRole("link", { name: /Source code/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen welcome wizard" }).click();
  await step(page, "Browser");
  await expect(wizard(page)).toContainText(
    "Websites open through your assigned browsing connection.",
  );
  await step(page, "Tab & icon");
  await expect(wizard(page).getByLabel("Custom tab title")).toHaveValue(
    "Study desk",
  );
});

test("preset logos and tab favicon load locally, settings mirror wizard, and export/import retains the custom identity", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (req) => {
    if (
      /^https?:/.test(req.url()) &&
      !["localhost", "127.0.0.1"].includes(new URL(req.url()).hostname)
    )
      external.push(req.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Use defaults" }).click();
  await settingsTab(page);
  for (const name of presets) {
    await page
      .getByRole("button", { name: "Tab preset " + name, exact: true })
      .click();
    await expect(page).toHaveTitle(name);
  }
  expect(external).toEqual([]);
  await page
    .getByRole("button", { name: "Tab preset Custom", exact: true })
    .click();
  await page.getByLabel("Custom tab title").fill("My custom title");
  await page
    .getByLabel("Upload custom tab icon")
    .setInputFiles("web/public/tab-icons/google.ico");
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    /^data:image\/png;base64,/,
  );
  await page.screenshot({
    path: "evidence/wizard-settings/custom-settings.png",
  });
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.settings")!),
  );
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Privacy & data" })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export settings", exact: true })
    .click();
  const file = await download;
  const payload = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(payload.settings.tabIcon).toBe(original.tabIcon);
  await page.getByLabel("Import settings").setInputFiles({
    name: "settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.getByRole("status")).toContainText("Settings imported.");
  await page.reload();
  await expect(page).toHaveTitle("My custom title");
  await settingsTab(page);
  await page.getByRole("button", { name: "Reset icon", exact: true }).click();
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
  await page
    .getByRole("button", { name: "Tab preset Atlas", exact: true })
    .click();
  await expect(page).toHaveTitle("Atlas");
});

test("icon uploader rejects invalid and oversized files without replacing the saved icon", async ({
  page,
}) => {
  await page.goto("/");
  await step(page, "Tab & icon");
  await wizard(page)
    .getByRole("button", { name: "Tab preset Custom", exact: true })
    .click();
  const uploader = wizard(page).getByLabel("Upload custom tab icon");
  await uploader.setInputFiles("web/public/tab-icons/drive.png");
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    /^data:image\/png;base64,/,
  );
  const before = await page
    .locator('head link[rel="icon"]')
    .getAttribute("href");
  await uploader.setInputFiles({
    name: "fake.png",
    mimeType: "image/png",
    buffer: Buffer.from("<svg><script>alert(1)</script></svg>"),
  });
  await expect(wizard(page).getByRole("status")).toContainText(
    "Choose a PNG, JPEG, WebP, GIF, or ICO image.",
  );
  await uploader.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(1_000_001),
  });
  await expect(wizard(page).getByRole("status")).toContainText(
    "smaller than 1 MB",
  );
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    before!,
  );
});

test("legacy custom titles migrate and imported remote icons are discarded", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    if (!localStorage.getItem("atlas.settings"))
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({ title: "Existing title" }),
      );
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Existing title");
  await settingsTab(page);
  await expect(
    page.getByRole("button", { name: "Tab preset Custom", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Privacy & data" })
    .click();
  await page.getByLabel("Import settings").setInputFiles({
    name: "settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        settings: {
          tabPreset: "custom",
          title: "Imported",
          tabIcon: "https://tracker.example/icon.png",
        },
      }),
    ),
  });
  await expect(page).toHaveTitle("Imported");
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
});

for (const engine of ["scramjet"]) {
  test(`${engine} panic key exits the proxied page but not while typing`, async ({
    page,
  }) => {
    await page.route("https://example.test/panic", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Panic destination</h1>",
      }),
    );
    await page.addInitScript((engine) => {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({
          engine,
          exitKey: "F8",
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
    await site.locator('input[name="message"]').press("F8");
    await expect(page).toHaveURL("http://localhost:4180/");
    await site.getByRole("heading", { name: "Proxy fixture ready" }).click();
    await page.keyboard.press("F8");
    await expect(page).toHaveURL("https://example.test/panic");
  });
}

test("wizard panels and persistent navigation fit mobile screens in both color modes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const mode of ["light", "dark"]) {
    await step(page, "Appearance");
    await wizard(page)
      .getByRole("button", { name: "Mode " + mode })
      .click();
    for (const name of [
      "Appearance",
      "Browser",
      "Tab & icon",
      "Privacy & data",
      "Finish",
    ]) {
      await step(page, name);
      await expect(
        wizard(page).locator(".setup-actions .primary"),
      ).toBeInViewport();
      expect(
        await wizard(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    }
    await step(page, "Tab & icon");
    await page.screenshot({
      path: `evidence/wizard-settings/wizard-mobile-${mode}.png`,
    });
  }
  await finish(page);
  await settingsTab(page);
  await page.getByLabel("Search settings").fill("panic");
  await expect(page.getByLabel("Panic key", { exact: true })).toBeVisible();
  await page.getByLabel("Search settings").fill("gmail");
  await expect(
    page.getByRole("button", { name: "Tab preset Gmail", exact: true }),
  ).toBeVisible();
});
