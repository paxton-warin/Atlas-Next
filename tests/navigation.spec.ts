import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
const runtime = (page: Page) =>
  page.frameLocator('iframe[title="Atlas isolated browsing runtime"]');
const site = (page: Page) =>
  runtime(page).frameLocator('iframe[title="Proxied website"]:not([hidden])');
async function launch(page: Page) {
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/navigation");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    site(page).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  // An expanded sidebar animates when leaving the new-tab page. Wait for its
  // layout transition before clicking inside the nested browsing iframe.
  await page.locator(".sidebar").evaluate(async (sidebar) => {
    await Promise.all(
      sidebar.getAnimations().map((animation) => animation.finished),
    );
  });
}
test.beforeEach(async ({ page, request }) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  page.on("pageerror", (error) => console.log("PAGE_ERROR", error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Use defaults", exact: true }).click();
});
test("website Enter search updates the address bar; callback POST/303 retains cookies inside Atlas", async ({
  page,
}) => {
  await launch(page);
  await site(page).getByLabel("Website search").fill("atlas query");
  await site(page).getByLabel("Website search").press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "Search results" }),
  ).toBeVisible();
  await expect(page.getByLabel("Address bar")).toHaveValue(
    "http://127.0.0.1:4199/navigation/results?q=atlas+query",
  );
  await page.getByLabel("Address bar").fill("http://127.0.0.1:4199/navigation");
  await page.getByLabel("Address bar").press("Enter");
  await site(page)
    .frameLocator('iframe[title="Nested callback fixture"]')
    .getByRole("button", { name: "Complete callback fixture" })
    .click();
  await expect(
    site(page).getByRole("heading", { name: "Redirect complete" }),
  ).toBeVisible();
  await expect(site(page).locator("#cookie")).toHaveText("Cookie retained");
  await expect(page).toHaveURL("http://localhost:4180/");
  await expect(page.getByLabel("Address bar")).toHaveValue(
    "http://127.0.0.1:4199/navigation/done?q=kept",
  );
});
for (const action of [
  "Open sign-in popup",
  "Open blank then navigate",
  "Open blank then assign",
  "Open blank then replace",
]) {
  test(`${action} stays in Atlas with opener messaging and close semantics`, async ({
    page,
    context,
  }) => {
    await launch(page);
    const session = await page.evaluate(() =>
      localStorage.getItem("atlas.nodeSession"),
    );
    await site(page).getByRole("button", { name: action, exact: true }).click();
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(
      site(page).getByRole("heading", { name: "Sign-in fixture" }),
    ).toBeVisible();
    expect(context.pages()).toHaveLength(1);
    await site(page)
      .getByRole("button", { name: "Finish sign-in fixture" })
      .click();
    await expect(page.locator(".tab")).toHaveCount(1);
    await expect(site(page).locator("#popup-result")).toHaveText(
      "Opener message received",
    );
    await expect(site(page).locator("#closed-result")).toHaveText(
      "Popup closed",
    );
    expect(
      await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
    ).toBe(session);
  });
}
test("named popups reuse an Atlas tab; popup forms preserve POST and noopener stays detached", async ({
  page,
  context,
}) => {
  await page.getByRole("button", { name: "Expand tabs", exact: true }).click();
  await launch(page);
  await site(page)
    .getByRole("button", { name: "Open sign-in popup", exact: true })
    .click();
  await expect(
    site(page).getByRole("heading", { name: "Sign-in fixture" }),
  ).toBeVisible();
  await page.locator(".tab-main").first().click();
  await site(page).getByRole("button", { name: "Reuse named popup" }).click();
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(
    site(page).getByRole("heading", { name: "Sign-in fixture" }),
  ).toBeVisible();
  await page.locator(".tab.active .close-tab").click();
  await site(page).getByRole("button", { name: "Submit popup form" }).click();
  await expect(
    site(page).getByRole("heading", { name: "Redirect complete" }),
  ).toBeVisible();
  await expect(site(page).locator("#cookie")).toHaveText("Cookie retained");
  await page.locator(".tab.active .close-tab").click();
  await site(page)
    .getByLabel("Popup attachment")
    .setInputFiles({
      name: "fixture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fixture upload contents"),
    });
  await site(page).getByRole("button", { name: "Upload popup form" }).click();
  await expect(
    site(page).getByRole("heading", { name: "Upload retained" }),
  ).toBeVisible();
  await page.locator(".tab.active .close-tab").click();
  await site(page).getByRole("button", { name: "No-opener popup" }).click();
  await expect(
    site(page).getByRole("heading", { name: "Sign-in fixture" }),
  ).toBeVisible();
  expect(
    await site(page)
      .locator("body")
      .evaluate(() => window.opener === null),
  ).toBe(true);
  expect(context.pages()).toHaveLength(1);
});
test("Cmd/Ctrl K focuses and selects the address from a nested website; suggestions are clickable above it", async ({
  page,
}) => {
  await page.route("**/api/search/suggestions", (r) =>
    r.fulfill({
      json: { suggestions: ["atlas search results", "atlas browser"] },
    }),
  );
  await launch(page);
  for (const modifier of ["Meta", "Control"]) {
    await site(page)
      .frameLocator('iframe[title="Nested callback fixture"]')
      .getByLabel("Nested input")
      .press(`${modifier}+k`);
    const bar = page.getByLabel("Address bar");
    await expect(bar).toBeFocused();
    expect(
      await bar.evaluate(
        (el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!,
      ),
    ).toBe((await bar.inputValue()).length);
  }
  await page.getByLabel("Address bar").fill("atlas");
  const option = page.getByRole("option", { name: "atlas search results" });
  await expect(option).toBeVisible();
  await page.screenshot({
    path: "evidence/google-navigation/address-suggestions.png",
    animations: "disabled",
  });
  expect(
    await option.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await option.click();
  await expect(page.getByLabel("Address bar")).toHaveValue(
    "https://www.google.com/search?q=atlas%20search%20results",
  );
});
test("top navigation is centered without overlap and shortcut labels match each platform", async ({
  page,
}) => {
  for (const width of [1920, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.locator(".main-nav").boundingBox();
    expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(2);
    const brand = await page.locator(".brand").boundingBox();
    const end = await page.locator(".topbar-end").boundingBox();
    expect(brand!.x + brand!.width).toBeLessThanOrEqual(box!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(end!.x);
    if (width === 1920 || width === 390)
      await page.screenshot({
        path: `evidence/google-navigation/navigation-${width}.png`,
        animations: "disabled",
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await launch(page);
  for (const [platform, label] of [
    ["MacIntel", "Cmd + K"],
    ["Win32", "Ctrl + K"],
    ["Linux x86_64", "Ctrl + K"],
  ]) {
    await page.evaluate((p) => {
      Object.defineProperty(navigator, "platform", {
        value: p,
        configurable: true,
      });
      Object.defineProperty(navigator, "userAgentData", {
        value: undefined,
        configurable: true,
      });
    }, platform);
    await page.getByLabel("Address bar").fill(platform);
    await expect(page.locator(".address-bar kbd")).toHaveText(label);
  }
});
test("Scramjet-only configuration migrates legacy tabs and never serves the removed engine", async ({
  page,
  request,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ engine: "ultraviolet", restore: true }),
    );
    localStorage.setItem(
      "atlas.tabs",
      JSON.stringify([
        {
          id: "legacy",
          title: "Saved tab",
          url: "http://127.0.0.1:4199/navigation",
          engine: "ultraviolet",
        },
      ]),
    );
  });
  await page.reload();
  await page.locator(".tab-main").click();
  await expect(
    site(page).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connection options" }),
  ).toContainText("Connection");
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menu")).not.toContainText("Ultraviolet");
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  expect((await (await request.get("/api/config")).json()).engines).toEqual([
    "scramjet",
  ]);
  for (const path of [
    "/uv/sw.js",
    "/uv/uv.config.js",
    "/vendor/uv/uv.bundle.js",
    "/vendor/baremux/index.js",
    "/vendor/epoxy/index.mjs",
  ])
    expect((await request.get("http://127.0.0.1:4181" + path)).status()).toBe(
      404,
    );
});

test("Google textarea Enter submits before site scripts initialize, without stealing Shift, IME or handled Enter", async ({
  page,
}) => {
  // Isolated, explicitly mocked Google-shaped form. No real CAPTCHA interaction.
  await page.route("https://www.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/search"
          ? "<h1>Mock search results</h1>"
          : '<form action="/search"><textarea aria-label="Mock Google search" name="q"></textarea><button>Search</button></form>',
    }),
  );
  await page.goto("https://www.google.com/");
  const source = ["runtime/browser-shortcuts.ts", "runtime/page-bridge.ts"]
    .map((path) =>
      readFileSync(path, "utf8")
        .replace(/^import .*;\n/gm, "")
        .replaceAll("export ", ""),
    )
    .join("\n");
  await page.addScriptTag({
    content:
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
        },
      }).outputText +
      '\ninstallPageBridge(window,{pageUrl:()=>location.href,topName:"mock",focusSearch(){},open(){throw Error("Unexpected popup")}});',
  });
  const input = page.getByLabel("Mock Google search");
  await input.fill("atlas");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("atlas\n");
  await input.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  await expect(page).toHaveURL("https://www.google.com/");
  await page.evaluate(() =>
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") e.preventDefault();
      },
      { once: true },
    ),
  );
  await input.press("Enter");
  await expect(page).toHaveURL("https://www.google.com/");
  await input.fill("atlas");
  await input.press("Enter");
  await expect(page).toHaveURL("https://www.google.com/search?q=atlas");
  await expect(
    page.getByRole("heading", { name: "Mock search results" }),
  ).toBeVisible();
});
