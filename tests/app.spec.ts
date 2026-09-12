import { test, expect, type Page } from "@playwright/test";
async function home(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Use defaults" }).click();
}
async function launch(page: Page, url = "http://127.0.0.1:4199/fixture") {
  await page.getByLabel("Search the web").fill(url);
  await page.getByRole("button", { name: "Search", exact: true }).click();
}
const website = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
for (const engine of ["scramjet"]) {
  test(`${engine} tab favicon loads through the proxy, updates and falls back`, async ({
    page,
  }) => {
    const outsideRequests: string[] = [];
    page.on("request", (request) => {
      if (
        /^https?:/.test(request.url()) &&
        !["http://localhost:4180", "http://127.0.0.1:4181"].includes(
          new URL(request.url()).origin,
        )
      )
        outsideRequests.push(request.url());
    });
    await page.addInitScript((engine) => {
      if (!localStorage.getItem("atlas.settings"))
        localStorage.setItem(
          "atlas.settings",
          JSON.stringify({ engine, restore: true }),
        );
    }, engine);
    await home(page);
    await launch(page, "http://127.0.0.1:4199/favicon-fixture/nested/page");
    const icon = page.locator(".tab.active img.tab-favicon");
    await expect(icon).toBeVisible();
    await expect
      .poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(32);
    const first = await icon.getAttribute("src");
    expect(first).toMatch(/^data:image\/png;base64,/);
    await website(page).getByRole("button", { name: "Change icon" }).click();
    await expect(icon).not.toHaveAttribute("src", first!);
    await expect(icon).toBeVisible();
    // Switching to horizontal tabs must retain the same icon and page.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator(".settings-nav")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await page.getByRole("button", { name: /Top tabs/ }).click();
    await page
      .locator(".main-nav")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await expect(page.locator(".horizontal-tabs .tab-favicon")).toBeVisible();
    await page.screenshot({ path: `evidence/favicons/${engine}-tabs.png` });
    await page.reload();
    await page.locator(".tab-main").click();
    await expect(icon).toBeVisible();
    async function go(mode: string) {
      await page
        .getByLabel("Address bar")
        .fill("http://127.0.0.1:4199/favicon-fixture?mode=" + mode);
      await page.getByLabel("Address bar").press("Enter");
      await expect(
        website(page).getByRole("heading", { name: "Favicon fixture ready" }),
      ).toBeVisible();
      await expect(page.locator(".tab-main .spinner")).toHaveCount(0);
    }
    await go("session");
    await expect(icon).toBeVisible();
    await go("missing");
    await expect(icon).toHaveCount(0);
    await expect(page.locator(".tab.active .lucide-globe-2")).toBeVisible();
    await go("root");
    await expect(icon).toBeVisible();
    expect(outsideRequests).toEqual([]);
  });
}
test("welcome wizard, polished home, themes and saved preferences", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to Atlas" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Theme Iris" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button", { name: /Finish/ })
    .click();
  await page.getByRole("button", { name: "Open Atlas", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Theme Moss" }).click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /^Good (morning|afternoon|evening)\./ }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "evidence/home-desktop.png",
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: "evidence/settings-desktop.png",
  });
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("atlas.settings")!).theme,
    ),
  ).toBe("forest");
});
test("new tab keeps subtle borders and the hero without a wide sidebar", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-11T16:00:00Z") });
  await home(page);
  await expect(page.locator(".home-hero h1")).toHaveCSS("font-size", "80px");
  await expect(page.locator(".main-panel")).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(page.locator(".main-panel")).toHaveCSS(
    "border-top-left-radius",
    "12px",
  );
  for (const selector of [
    ".sidebar",
    ".main-nav",
    ".shortcut-target > span",
    ".add-shortcut > span",
  ]) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "border-top-width",
      "1px",
    );
  }
  await expect(page.locator(".shortcut-target > span").first()).toHaveCSS(
    "width",
    "52px",
  );
  await expect(page.locator(".hero-search")).toHaveCSS("min-height", "60px");
  await expect(page.locator(".main-panel")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".sidebar")).toHaveCSS("width", "44px");
  await expect(page.getByLabel("Address bar")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("Search the web")).toBeFocused();
  await page.getByRole("button", { name: "Expand tabs", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "180px");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Collapse tabs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse tabs", exact: true })
    .click();
  await launch(page);
  await expect(
    website(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const source = await page
    .locator('iframe[title="Atlas isolated browsing runtime"]')
    .getAttribute("src");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.locator(".home-hero h1")).toBeVisible();
  await expect(page.locator(".browser-toolbar")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Atlas fixture", exact: true })
    .click();
  await expect(
    website(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  expect(
    await page
      .locator('iframe[title="Atlas isolated browsing runtime"]')
      .getAttribute("src"),
  ).toBe(source);
});

test("new tab customization, light mode, small screens and reduced motion", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-11T16:00:00Z") });
  await home(page);
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.getByRole("button", { name: "Theme Dune" }).click();
  await page.getByRole("button", { name: "Mode light" }).click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "evidence/newtab/light.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByLabel("Search the web")).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Add shortcut", exact: true }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.main-nav button, [aria-label="Toggle color mode"]')
        .evaluateAll((buttons) =>
          buttons.every(
            (button) => button.getBoundingClientRect().right <= innerWidth,
          ),
        ),
    ).toBe(true);
    if (viewport.width === 390)
      await page.screenshot({ path: "evidence/newtab/mobile.png" });
    if (viewport.width === 1366)
      await page.screenshot({ path: "evidence/newtab/chromebook-layout.png" });
  }
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.getByRole("button", { name: "Minimal", exact: true }).click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(page.locator(".ambient")).toHaveClass("ambient solid");
  await expect(page.locator(".ambient")).toHaveCSS("background-image", "none");
});

test("games, favorites and built-in playable game", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "Games", exact: true }).click();
  await page
    .getByRole("button", { name: "Favorite 2048", exact: true })
    .click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".game-card")).toHaveCount(1);
  await page.getByRole("button", { name: "All games", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: "evidence/games-desktop.png",
  });
  await page.getByRole("button", { name: "Play 2048", exact: true }).click();
  const game = page.frameLocator('iframe[title="2048"]');
  await expect(game.getByRole("heading", { name: "2048" })).toBeVisible();
  await expect(game.locator(".cell")).toHaveCount(16);
});
test("anonymous support ticket and reply", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Chromebook browsing question");
  await page
    .getByLabel("Message", { exact: true })
    .fill("I would like to report a browsing issue with a page.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Chromebook browsing question" }),
  ).toBeVisible();
  await page.getByLabel("Your reply").fill("Here is some more information.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    page.getByText("Here is some more information.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "evidence/support-desktop.png",
  });
  const access = await page.evaluate(
    () => JSON.parse(localStorage.getItem("atlas.tickets")!)[0],
  );
  await page.goto("/support#ticket=" + access.id + "." + access.token);
  await expect(
    page.getByRole("heading", { name: "Chromebook browsing question" }),
  ).toBeVisible();
});
test("Scramjet actual HTTP, cookies, storage, fetch, WebSocket and stable frame", async ({
  page,
}) => {
  await home(page);
  await launch(page);
  const site = website(page);
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await site
    .getByRole("link", { name: "Sign in fixture", exact: true })
    .click();
  await expect(site.locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  await site.getByRole("button", { name: "Save storage" }).click();
  await expect(site.locator("#stored")).toHaveText("persisted");
  await site.getByRole("button", { name: "Test fetch" }).click();
  await expect(site.locator("#fetch-result")).toContainText("fetch works");
  await site.getByRole("button", { name: "Test WebSocket" }).click();
  await expect(site.locator("#socket-result")).toHaveText("socket works");
  const before = await page
    .locator('iframe[title="Atlas isolated browsing runtime"]')
    .getAttribute("src");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Theme Dune" }).click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(site.locator("#stored")).toHaveText("persisted");
  expect(
    await page
      .locator('iframe[title="Atlas isolated browsing runtime"]')
      .getAttribute("src"),
  ).toBe(before);
  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await expect(site.locator("#cookie")).toContainText(
    "atlas_http_only=present",
  );
  await site
    .getByRole("link", { name: "Sign out fixture", exact: true })
    .click();
  await expect(site.locator("#cookie")).toHaveText("no-cookie");
});
test("stock demo baseline HTTP/cookies/fetch/WebSocket", async ({ page }) => {
  await page.goto(
    "http://127.0.0.1:4182/?goto=" +
      encodeURIComponent("http://127.0.0.1:4199/fixture"),
  );
  const site = page.frameLocator(".browser-view iframe");
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await site
    .getByRole("link", { name: "Sign in fixture", exact: true })
    .click();
  await expect(site.locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  await site.getByRole("button", { name: "Test fetch" }).click();
  await expect(site.locator("#fetch-result")).toContainText("fetch works");
  await site.getByRole("button", { name: "Test WebSocket" }).click();
  await expect(site.locator("#socket-result")).toHaveText("socket works");
});
test("mobile layout has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await home(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: "evidence/home-mobile.png",
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Scramjet session survives app reload, layout changes, and a second tab", async ({
  page,
}) => {
  await home(page);
  await launch(page);
  let site = website(page);
  await site
    .getByRole("link", { name: "Sign in fixture", exact: true })
    .click();
  await site.getByRole("button", { name: "Save storage" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Restore tabs", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Top tabs", exact: false }).click();
  await page.reload();
  await page.locator(".tab-main").first().click();
  await expect(site.locator("#cookie")).toContainText(
    "atlas_http_only=present",
  );
  await expect(site.locator("#stored")).toHaveText("persisted");
  await page.getByRole("button", { name: "New tab", exact: false }).click();
  await launch(page);
  site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(site.locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  await expect(site.locator("#stored")).toHaveText("persisted");
});

test("clear website data removes Scramjet cookies and storage but keeps Atlas preferences", async ({
  page,
}) => {
  await home(page);
  await launch(page);
  let site = website(page);
  await site
    .getByRole("link", { name: "Sign in fixture", exact: true })
    .click();
  await site.getByRole("button", { name: "Save storage" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Privacy & data", exact: true })
    .click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Clear website data", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Website data cleared.");
  await launch(page);
  site = website(page);
  await expect(site.locator("#cookie")).toHaveText("no-cookie");
  await expect(site.locator("#stored")).toHaveText("");
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.onboarded")),
  ).toBe("true");
});

for (const target of ["Atlas", "demo"])
  test(`${target} form POST and popup shell`, async ({ page, context }) => {
    let site;
    if (target === "Atlas") {
      await home(page);
      await launch(page);
      site = website(page);
    } else {
      await page.goto(
        "http://127.0.0.1:4182/?goto=" +
          encodeURIComponent("http://127.0.0.1:4199/fixture"),
      );
      site = page.frameLocator(".browser-view iframe");
    }
    await expect(
      site.getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    if (target === "Atlas") {
      await site.getByRole("link", { name: "Open popup", exact: true }).click();
      await expect(page.locator(".tab")).toHaveCount(2);
      const popupSite = page
        .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
        .frameLocator('iframe[title="Proxied website"]:not([hidden])');
      await expect(
        popupSite.getByRole("heading", { name: "Proxy fixture ready" }),
      ).toBeVisible();
      expect(context.pages()).toHaveLength(1);
      await page
        .getByRole("button", { name: "Expand tabs", exact: true })
        .click();
      await page.locator(".tab.active .close-tab").click();
    } else {
      const popupPromise = context.waitForEvent("page");
      await site.getByRole("link", { name: "Open popup", exact: true }).click();
      const popup = await popupPromise;
      await expect(
        popup
          .frameLocator(".browser-view iframe")
          .getByRole("heading", { name: "Proxy fixture ready" }),
      ).toBeVisible();
      await popup.close();
    }
    await site
      .getByRole("button", { name: "Submit form", exact: true })
      .click();
    await expect(site.locator("body")).toContainText("message=Atlas+form");
  });

test("single admin enrollment, verified ticket reply, catalog, logout and recovery", async ({
  page,
}) => {
  const { TOTP, Secret } = await import("otpauth");
  const ticket = await page.request.post("/api/tickets", {
    headers: { origin: "http://localhost:4180" },
    data: {
      subject: "Admin browser test",
      category: "Other",
      body: "Please test this ticket conversation.",
    },
  });
  expect(ticket.ok()).toBeTruthy();
  const access = await ticket.json();
  await page.goto("/_control/atlas-owner");
  await page.getByLabel("One-time setup token").fill("e2e-fixture-bootstrap");
  await page
    .getByLabel("Administrator password")
    .fill("atlas-e2e-password-only");
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const secret = await page.locator(".secret-key").innerText();
  const totp = new TOTP({
    issuer: "Atlas",
    label: "Owner",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  await page.getByLabel("Authenticator or recovery code").fill(totp.generate());
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery codes" }),
  ).toBeVisible();
  const recovery = (await page.locator("pre").innerText()).split("\n");
  expect(recovery).toHaveLength(8);
  await page.getByRole("button", { name: "I've saved them" }).click();
  await page.getByRole("button", { name: /Admin browser test/ }).click();
  await page
    .getByLabel("Reply", { exact: true })
    .fill("Your ticket reached the administrator.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    page
      .locator(".message.admin")
      .getByText("Your ticket reached the administrator.", { exact: true }),
  ).toBeVisible();
  const read = await page.request.get("/api/tickets/" + access.id, {
    headers: { authorization: "Bearer " + access.token },
  });
  expect((await read.json()).messages.at(-1).body).toBe(
    "Your ticket reached the administrator.",
  );
  await page.screenshot({
    animations: "disabled",
    path: "evidence/admin-desktop.png",
  });
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page
    .locator(".ticket-row")
    .filter({ has: page.locator("strong").getByText("2048", { exact: true }) })
    .click();
  await page.getByLabel("Visible in catalog").uncheck();
  await page.getByRole("button", { name: "Save game", exact: true }).click();
  await expect(
    page.getByText("Puzzle · Hidden", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter owner catalog").selectOption("app");
  await page.getByLabel("Search owner catalog").fill("Spotify");
  await page
    .locator(".ticket-row")
    .filter({ has: page.getByText("Spotify", { exact: true }) })
    .click();
  await expect(page.getByLabel("Catalog type")).toHaveValue("app");
  await page.getByRole("button", { name: "Save game", exact: true }).click();
  await page.getByRole("button", { name: "Lock panel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page
    .getByLabel("Administrator password")
    .fill("atlas-e2e-password-only");
  await page.getByLabel("Authenticator or recovery code").fill(recovery[0]);
  await page
    .getByRole("button", { name: "Unlock control room", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock panel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "AI provider", exact: true }).click();
  await page
    .getByRole("combobox", { name: "API protocol", exact: true })
    .selectOption("chat-completions");
  await page
    .getByRole("button", { name: "Save AI settings", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Browsing nodes", exact: true })
    .click();
  await page.getByLabel("Node name", { exact: true }).fill("Fixture node");
  await page
    .getByLabel("Node endpoint", { exact: true })
    .fill("http://127.0.0.1:4195");
  await page
    .getByLabel("Node pairing code", { exact: true })
    .fill("AABBCCDDEEFF");
  await page.getByRole("button", { name: "Attach node", exact: true }).click();
  const nodeCard = page
    .locator(".node-card")
    .filter({ hasText: "Fixture node" });
  await expect(nodeCard.getByText("Online", { exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/node-pool/owner-nodes.png" });
  const state = await (await page.request.get("/api/admin/state")).json();
  const nodeRows = await (await page.request.get("/api/admin/nodes")).json();
  const attached = nodeRows.find((n: any) => n.name === "Fixture node");
  const updateNode = (id: string, stateName: string) =>
    page.request.put("/api/admin/nodes/" + id, {
      headers: { origin: "http://localhost:4180", "x-atlas-csrf": state.csrf },
      data: { state: stateName, weight: 1 },
    });
  expect((await updateNode("local", "disabled")).ok()).toBeTruthy();
  await page.evaluate(() => localStorage.removeItem("atlas.nodeSession"));
  const sockets: string[] = [],
    apiOrigins: string[] = [];
  page.on("websocket", (socket) => sockets.push(new URL(socket.url()).origin));
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/"))
      apiOrigins.push(new URL(req.url()).origin);
  });
  await home(page);
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menu")).toContainText("Fixture node");
  await page.keyboard.press("Escape");
  await launch(page);
  const nodeSite = website(page);
  await expect(
    nodeSite.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await nodeSite
    .getByRole("link", { name: "Sign in fixture", exact: true })
    .click();
  await expect(nodeSite.locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  await nodeSite
    .getByRole("button", { name: "Test WebSocket", exact: true })
    .click();
  await expect(nodeSite.locator("#socket-result")).toHaveText("socket works");
  expect(sockets).toContain("ws://127.0.0.1:4195");
  expect(sockets).not.toContain("ws://127.0.0.1:4181");
  expect(
    apiOrigins.every((origin) => origin === "http://localhost:4180"),
  ).toBeTruthy();
  await page.reload();
  await launch(page);
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menu")).toContainText("Fixture node");
  await page.keyboard.press("Escape");
  await expect(website(page).locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  await page.screenshot({ path: "evidence/node-pool/direct-node-browser.png" });
  // Restore the default pool for subsequent independent browser journeys.
  expect((await updateNode("local", "active")).ok()).toBeTruthy();
  expect((await updateNode(attached.id, "disabled")).ok()).toBeTruthy();
});

for (const target of ["Atlas", "demo"])
  test(`${target} download attribute filename and bytes — known upstream failure`, async ({
    page,
  }) => {
    let site;
    if (target === "Atlas") {
      await home(page);
      await launch(page);
      site = website(page);
    } else {
      await page.goto(
        "http://127.0.0.1:4182/?goto=" +
          encodeURIComponent("http://127.0.0.1:4199/fixture"),
      );
      site = page.frameLocator(".browser-view iframe");
    }
    await expect(
      site.getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    const waiting = page.waitForEvent("download");
    await site
      .getByRole("link", { name: "Download file", exact: true })
      .click();
    const download = await waiting;
    test.fail(
      true,
      "Pinned stock demo loses the Content-Disposition filename and the download is canceled; this remains a tracked upstream failure, not a passing download workflow.",
    );
    expect(download.suggestedFilename()).toBe("atlas-fixture.txt");
    let content = "";
    for await (const chunk of (await download.createReadStream())!)
      content += chunk.toString();
    expect(content).toBe("Atlas download works");
  });

test("production entrypoint serves separate runtime assets", async ({
  request,
}) => {
  const runtime = await request.get("http://127.0.0.1:4181/");
  const html = await runtime.text();
  expect(html).toContain('id="frames"');
  expect(html).toContain("/assets/");
  expect(html).not.toContain('id="root"');
  const asset = await request.get(
    "http://127.0.0.1:4181/controller/controller.api.js",
  );
  expect(asset.status()).toBe(200);
});

test("compact browser, plain labels and focus mode preserve the loaded website", async ({
  page,
}) => {
  await home(page);
  await expect(
    page.getByText("No account. Just you.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Your own little internet", { exact: true }),
  ).toHaveCount(0);
  await launch(page);
  const site = website(page);
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const bar = await page.locator(".browser-toolbar").boundingBox();
  expect(bar!.height).toBeLessThanOrEqual(45);
  await page.getByRole("button", { name: "Enter focus mode" }).click();
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await page.screenshot({ path: "evidence/ui-refinement/browser-focus.png" });
  await page.getByRole("button", { name: "Exit focus mode" }).click();
  await expect(page.locator(".topbar")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".browser-toolbar")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(0);
});

test("runtime handshake recovers when the initial ready message is missed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== top) return;
    let dropped = false;
    window.addEventListener(
      "message",
      (e) => {
        if (!dropped && e.data?.atlas === 1 && e.data.type === "ready") {
          dropped = true;
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  });
  await home(page);
  await launch(page);
  await expect(
    website(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
});

test("native AI chat streams, retains history, switches pages and handles provider errors", async ({
  page,
}) => {
  await home(page);
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await expect(page.getByText("Atlas AI", { exact: true })).toBeVisible();
  await page.getByLabel("Message Atlas AI").fill("Hello from the browser test");
  await page.getByRole("button", { name: "Send AI message" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText(
    "Streaming complete.",
  );
  await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0);
  await page.screenshot({ path: "evidence/ui-refinement/ai-chat.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText(
    "Hello from the browser test",
  );
  await page.reload();
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.locator(".chat-item").first().locator("button").first().click();
  await expect(page.locator(".chat-message.assistant")).toContainText(
    "Hello from the browser test",
  );
  await page.getByLabel("Message Atlas AI").fill("provider error");
  await page.getByRole("button", { name: "Send AI message" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "AI provider request failed",
  );
  await expect(page.getByRole("alert")).not.toContainText("fixture-only-key");
});

test("native AI stop button cancels a streaming reply", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByLabel("Message Atlas AI").fill("slow response");
  await page.getByRole("button", { name: "Send AI message" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText(
    "Test reply:",
  );
  await page.getByRole("button", { name: "Stop reply" }).click();
  await expect(page.getByRole("alert")).toHaveText("Reply stopped.");
  await expect(
    page.getByRole("button", { name: "Send AI message" }),
  ).toBeVisible();
});

test("native AI setup is explicit when no provider is connected", async ({
  page,
}) => {
  await page.route("**/api/ai/config", (route) =>
    route.fulfill({ json: { configured: false, model: null } }),
  );
  await home(page);
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await expect(
    page.getByText("Connect an AI provider", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Message Atlas AI").fill("test");
  await expect(
    page.getByRole("button", { name: "Send AI message" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "evidence/ui-refinement/ai-mobile.png" });
});
