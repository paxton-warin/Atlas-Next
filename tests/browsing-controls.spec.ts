import { test, expect, type Page } from "@playwright/test";
const site = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
async function home(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("/");
}
async function launch(page: Page) {
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
}

test("Connection menu keeps the pinned node and reconnects without losing tabs", async ({
  page,
}) => {
  await home(page);
  await launch(page);
  const token = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  await expect(page.locator(".node-status, select.engine-select")).toHaveCount(
    0,
  );
  const menu = page.getByRole("button", { name: "Connection options" });
  await menu.focus();
  await menu.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(menu).toContainText("Connection");
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(token);
  await expect(page.getByRole("menu")).toContainText("Main server");
  await expect(page.getByRole("menu")).toContainText("Connected");
  await expect(page.getByRole("menu")).not.toContainText("Browsing engine");
  await page.screenshot({ path: "evidence/browsing-menu/menu-desktop.png" });
  await page.getByRole("menuitem", { name: "Reconnect node" }).click();
  const dialog = page.getByRole("dialog", { name: "Reconnect browsing?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reconnect node" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    site(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).not.toBe(token);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(menu).toContainText("Connection");
});

test("expired startup lease prompts immediately and reconnect failure stays actionable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("atlas.nodeSession"))
      localStorage.setItem(
        "atlas.nodeSession",
        JSON.stringify("expired-fixture"),
      );
  });
  await home(page);
  const dialog = page.getByRole("dialog", { name: "Browsing session expired" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Reconnect node" }),
  ).toBeFocused();
  let allocations = 0;
  await page.route("**/api/browse/session", async (route) => {
    if (route.request().method() === "POST" && allocations++ === 0)
      return route.fulfill({
        status: 503,
        json: { error: "No browsing nodes are available." },
      });
    return route.continue();
  });
  await dialog.getByRole("button", { name: "Reconnect node" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "No browsing nodes are available.",
  );
  await dialog.getByRole("button", { name: "Reconnect node" }).click();
  await expect(dialog).not.toBeVisible();
  await launch(page);
});

test("open session detects revocation, never silently reallocates, and can reconnect after dismissal", async ({
  page,
}) => {
  await home(page);
  await launch(page);
  let allocations = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/browse/session") && req.method() === "POST")
      allocations++;
  });
  const token = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  await page.request.delete("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { session: token },
  });
  const runtime = page
    .frames()
    .find(
      (f) =>
        f.parentFrame() === page.mainFrame() &&
        f.url().startsWith("http://127.0.0.1:4181"),
    )!;
  await runtime.evaluate(() => window.dispatchEvent(new Event("online")));
  const dialog = page.getByRole("dialog", { name: "Browsing session expired" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "evidence/browsing-menu/expired.png" });
  expect(allocations).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menu")).toContainText("Reconnect needed");
  await page.getByRole("menuitem", { name: "Reconnect node" }).click();
  await dialog.getByRole("button", { name: "Reconnect node" }).click();
  await expect(
    site(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  expect(allocations).toBe(1);
});

test("expired runtime ticket at boot reports directly instead of timing out", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:4181/runtime-config", (route) =>
    route.fulfill({ status: 401, json: { error: "Expired ticket" } }),
  );
  await home(page);
  await expect(
    page.getByRole("dialog", { name: "Browsing session expired" }),
  ).toBeVisible();
});

test("lease deadline prompts with clock skew accounted for", async ({
  page,
}) => {
  await page.route("**/api/browse/session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, serverTime: 100, expiresAt: 1100 },
    });
  });
  await home(page);
  await expect(
    page.getByRole("dialog", { name: "Browsing session expired" }),
  ).toBeVisible();
});

test("autocomplete defaults on, debounces, supports keyboard and mouse in both search bars", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route("**/api/search/suggestions", (route) => {
    const q = route.request().postDataJSON().q;
    calls.push(q);
    return route.fulfill({
      json: { suggestions: [q + " docs", q + " browser"] },
    });
  });
  await home(page);
  const input = page.getByRole("combobox", { name: "Search the web" });
  await input.fill("at");
  await input.fill("atlas");
  await expect(page.getByRole("option", { name: "atlas docs" })).toBeVisible();
  expect(calls).toEqual(["atlas"]);
  const option = page.getByRole("option", { name: "atlas browser" });
  expect(
    await option.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: "evidence/browsing-menu/autocomplete-desktop.png",
  });
  await input.press("ArrowUp");
  await expect(
    page.getByRole("option", { name: "atlas browser" }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.fill("http://127.0.0.1:4199/fixture");
  await input.press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const address = page.getByRole("combobox", { name: "Address bar" });
  await address.fill("atlas");
  await expect(page.getByRole("option", { name: "atlas docs" })).toBeVisible();
  await page.getByRole("option", { name: "atlas docs" }).click();
  await expect(address).toHaveValue(
    "https://www.google.com/search?q=atlas%20docs",
  );
});

test("wizard opt-out persists, settings can re-enable, and address-like text is not sent", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/search/suggestions", (route) => {
    calls++;
    return route.fulfill({ json: { suggestions: ["atlas docs"] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Search autocomplete" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button", { name: /Finish/ })
    .click();
  await page.getByRole("button", { name: "Open Atlas", exact: true }).click();
  await page.reload();
  await page.getByLabel("Search the web").fill("atlas");
  await page.waitForTimeout(350);
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  const setting = page.getByRole("switch", { name: "Search autocomplete" });
  await expect(setting).toHaveAttribute("aria-checked", "false");
  await setting.click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  for (const value of [
    "https://example.com/login?token=private",
    "user:password@example.com",
    "example.com",
  ]) {
    await page.getByLabel("Search the web").fill(value);
    await page.waitForTimeout(220);
  }
  expect(calls).toBe(0);
  await page.getByLabel("Search the web").fill("atlas");
  await expect(page.getByRole("option", { name: "atlas docs" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await setting.click();
  await page.reload();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("atlas.settings")!).autocomplete,
    ),
  ).toBe(false);
});

test("stale responses and IME composition do not navigate or reopen suggestions", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route("**/api/search/suggestions", async (route) => {
    const q = route.request().postDataJSON().q;
    calls.push(q);
    if (q === "old") await new Promise((r) => setTimeout(r, 600));
    await route
      .fulfill({ json: { suggestions: [q + " docs"] } })
      .catch(() => {});
  });
  await home(page);
  const input = page.getByLabel("Search the web");
  await input.fill("old");
  await expect.poll(() => calls.length).toBe(1);
  await input.fill("new");
  await expect(page.getByRole("option", { name: "new docs" })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole("option", { name: "old docs" })).toHaveCount(0);
  await input.dispatchEvent("compositionstart");
  await input.fill("日本");
  await input.press("Enter");
  await page.waitForTimeout(250);
  expect(calls).not.toContain("日本");
  await expect(input).toBeVisible();
  await input.dispatchEvent("compositionend");
  await expect(page.getByRole("option", { name: "日本 docs" })).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.getByLabel("Address bar")).toHaveValue(
    "https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%20docs",
  );
});

test("mobile menu and autocomplete remain inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/search/suggestions", (route) =>
    route.fulfill({ json: { suggestions: ["atlas docs", "atlas browser"] } }),
  );
  await home(page);
  await page.getByLabel("Search the web").fill("atlas");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.screenshot({
    path: "evidence/browsing-menu/autocomplete-mobile.png",
  });
  await page.getByLabel("Search the web").press("Escape");
  await launch(page);
  await page.getByRole("button", { name: "Connection options" }).click();
  const box = await page.getByRole("menu").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "evidence/browsing-menu/menu-mobile.png" });
});
