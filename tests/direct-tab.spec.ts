import { test, expect, type Page } from "@playwright/test";
const fixture = "http://127.0.0.1:4199/fixture";
const mainSessions = new Set<string>();
test.afterEach(async ({ request }) => {
  // Main relay tests share the fixture pool; a closed browser does not release
  // a pinned server lease. Release every lease created here, even on failure.
  for (const session of mainSessions) {
    const response = await request.delete(
      "http://localhost:4196/api/browse/session",
      {
        headers: { origin: "http://localhost:4196" },
        data: { session },
      },
    );
    expect(response.ok()).toBe(true);
    mainSessions.delete(session);
  }
});

const originalSite = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
const directSite = (page: Page) =>
  page.frameLocator('iframe[title="Proxied website"]');
const action = "Open in new browser tab";
async function launch(page: Page, origin = "/") {
  await page.goto(origin);
  await page.getByLabel("Search the web").fill(fixture);
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    originalSite(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
}
async function setup(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "top", motion: false, youtubeAdblock: false }),
    );
  });
}

test("Connection opens current website in a real assigned-node browser tab without changing the original lease", async ({
  page,
  context,
}) => {
  await setup(page);
  await launch(page);
  // The rendered website can precede its asynchronous title message to Atlas.
  // Snapshot the settled tab rather than mistaking that metadata update for
  // a mutation caused by opening the direct browser tab.
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("atlas.tabs")!)[0]?.title,
      ),
    )
    .toBe("Atlas fixture");
  const oldTabs = await page.evaluate(() => localStorage.getItem("atlas.tabs"));
  const oldSession = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  await originalSite(page)
    .locator('input[name="message"]')
    .fill("Unsent original message");
  const requests: string[] = [];
  context.on("request", (request) => {
    if (request.url().includes("/api/browse/session"))
      requests.push(request.url());
  });
  await page.getByRole("button", { name: "Connection options" }).click();
  const link = page.getByRole("menuitem", { name: action });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const expected = new URL((await link.getAttribute("href"))!);
  expect(expected.origin).toBe("http://127.0.0.1:4181");
  expect(expected.search).toBe("");
  expect(new URLSearchParams(expected.hash.slice(1)).get("goto")).toBe(fixture);
  expect(new URLSearchParams(expected.hash.slice(1)).get("adblock")).toBe("0");
  expect(
    new URLSearchParams(expected.hash.slice(1)).get("ticket"),
  ).toBeTruthy();
  // Arrow navigation now includes the native anchor after Reconnect.
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(link).toBeFocused();
  await page.keyboard.press("Escape");
  const popout = page.getByRole("link", { name: "Pop out tab", exact: true });
  await expect(popout).toHaveAttribute("href", expected.href);
  await expect(popout).toHaveAttribute("target", "_blank");
  await expect(popout).toHaveAttribute("rel", "noopener noreferrer");
  expect(
    await popout.evaluate((element) =>
      element.nextElementSibling?.getAttribute("aria-label"),
    ),
  ).toBe("Enter focus mode");
  await page.setViewportSize({ width: 320, height: 850 });
  await expect(popout).toBeVisible();
  expect(
    await page.locator(".browser-toolbar").evaluate((toolbar) => {
      const row = toolbar.getBoundingClientRect();
      return Array.from(toolbar.children).every((child) => {
        const bounds = child.getBoundingClientRect();
        return (
          !bounds.width || (bounds.x >= row.x && bounds.right <= row.right)
        );
      });
    }),
  ).toBe(true);
  const opened = context.waitForEvent("page");
  await popout.click();
  const direct = await opened;
  await expect(
    directSite(direct).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  expect(new URL(direct.url()).origin).toBe(expected.origin);
  expect(new URL(direct.url()).search).toBe("");
  expect(await direct.evaluate(() => window.opener)).toBeNull();
  await directSite(direct).getByRole("button", { name: "Test fetch" }).click();
  await expect(directSite(direct).locator("#fetch-result")).toContainText(
    "fetch works",
  );
  expect(
    JSON.parse(
      (await directSite(direct).locator("#fetch-result").textContent())!,
    ),
  ).toMatchObject({ method: "POST", body: "fetch works" });
  const returnLink = direct.getByRole("link", { name: "Return to Atlas" });
  await expect(returnLink).toBeVisible();
  const returnUrl = new URL((await returnLink.getAttribute("href"))!);
  expect(returnUrl.origin).toBe(new URL(page.url()).origin);
  expect(returnUrl.pathname).toBe("/");
  await directSite(direct)
    .getByRole("link", { name: "Next page", exact: true })
    .click();
  const nextUrl = fixture + "?next=1";
  await expect(
    direct.getByRole("textbox", { name: "Website address" }),
  ).toHaveValue(nextUrl);
  await expect
    .poll(() =>
      new URLSearchParams(new URL(direct.url()).hash.slice(1)).get("goto"),
    )
    .toBe(nextUrl);
  expect(new URL(direct.url()).search).toBe("");
  const fragmentBeforeReload = new URL(direct.url()).hash;
  await direct.reload();
  await expect(
    directSite(direct).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(
    direct.getByRole("textbox", { name: "Website address" }),
  ).toHaveValue(nextUrl);
  expect(new URL(direct.url()).hash).toBe(fragmentBeforeReload);
  expect(
    new URLSearchParams(new URL(direct.url()).hash.slice(1)).get("ticket"),
  ).toBe(new URLSearchParams(expected.hash.slice(1)).get("ticket"));
  expect(requests).toEqual([]);
  expect(context.pages()).toHaveLength(2);
  expect(await page.evaluate(() => localStorage.getItem("atlas.tabs"))).toBe(
    oldTabs,
  );
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(oldSession);
  await expect(originalSite(page).locator('input[name="message"]')).toHaveValue(
    "Unsent original message",
  );
  await expect(page.locator(".tab")).toHaveCount(1);
  await direct.screenshot({ path: "evidence/focus-tabs/direct-node-tab.png" });
});

test("direct action is disabled on new tab and expired sessions; arrow keys skip it", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menuitem", { name: action })).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: action }),
  ).not.toHaveAttribute("href");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByLabel("Search the web").fill(fixture);
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    originalSite(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
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
      (frame) =>
        frame.parentFrame() === page.mainFrame() &&
        frame.url().startsWith("http://127.0.0.1:4181"),
    )!;
  await runtime.evaluate(() => window.dispatchEvent(new Event("online")));
  const dialog = page.getByRole("dialog", { name: "Browsing session expired" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(
    page.getByRole("button", { name: "Pop out tab", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Pop out tab", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menuitem", { name: action })).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: action }),
  ).not.toHaveAttribute("href");
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
});

test("Main assignment opens its isolated node directly but retains the current-frontend Main relay", async ({
  page,
  context,
  request,
}) => {
  const origin = "http://localhost:4196";
  let lease: any;
  for (let i = 0; i < 5; i++) {
    const response = await request.post(origin + "/api/browse/session", {
      headers: { origin },
      data: {},
    });
    expect(response.ok()).toBeTruthy();
    lease = await response.json();
    mainSessions.add(lease.session);
    if (lease.node.id === "local") break;
    await request.delete(origin + "/api/browse/session", {
      headers: { origin },
      data: { session: lease.session },
    });
  }
  expect(lease.node.id).toBe("local");
  await setup(page);
  await page.addInitScript(
    (session) =>
      localStorage.setItem("atlas.nodeSession", JSON.stringify(session)),
    lease.session,
  );
  await launch(page, origin);
  const requests: string[] = [];
  context.on("request", (request) => {
    if (request.url().includes("/api/browse/session"))
      requests.push(request.url());
  });
  await page.getByRole("button", { name: "Connection options" }).click();
  const link = page.getByRole("menuitem", { name: action });
  expect(new URL((await link.getAttribute("href"))!).origin).toBe(
    lease.runtimeOrigin,
  );
  const opened = context.waitForEvent("page");
  await link.click();
  const direct = await opened;
  const sockets: string[] = [];
  direct.on("websocket", (socket) => sockets.push(socket.url()));
  await expect(
    directSite(direct).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await directSite(direct)
    .getByRole("button", { name: "Test WebSocket" })
    .click();
  await expect(directSite(direct).locator("#socket-result")).toHaveText(
    "socket works",
  );
  expect(
    sockets.some((url) => url.startsWith("ws://localhost:4196/relay/")),
  ).toBe(true);
  expect(
    sockets.some((url) => url.startsWith("ws://127.0.0.1:4194/relay/")),
  ).toBe(false);
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("atlas.nodeSession")!),
    ),
  ).toBe(lease.session);
});
