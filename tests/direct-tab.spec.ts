import { directTabTarget } from "../runtime/direct-tab";
import { test, expect, type Page } from "@playwright/test";
import { openCurrentPopout, popoutSite, popoutRuntime } from "./popout-fixture";

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
const directSite = popoutSite;
const savedWindowTabs = (page: Page) =>
  page.evaluate(() =>
    localStorage.getItem(`atlas.windows.v1.${window.name.slice(13)}`),
  );
const action = "Open direct node tab";
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

test("Popout opens the current website in a frontend-origin browser tab without changing its assigned lease", async ({
  page,
  context,
}) => {
  await setup(page);
  await launch(page);
  // The rendered website can precede its asynchronous title message to Atlas.
  // Snapshot the settled tab rather than mistaking that metadata update for
  // a mutation caused by opening the direct browser tab.
  await expect
    .poll(
      async () =>
        JSON.parse((await savedWindowTabs(page)) || '{"tabs":[]}').tabs[0]
          ?.title,
    )
    .toBe("Atlas fixture");
  const oldTabs = await savedWindowTabs(page);
  const oldSession = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  await originalSite(page)
    .locator('input[name="message"]')
    .fill("Unsent original message");
  const requests: string[] = [];
  context.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/api/browse/session") &&
      !request.postDataJSON()?.session
    )
      requests.push(request.url());
  });
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menuitem", { name: action })).toHaveCount(0);
  // The current profileV2 wrapper keeps storage on the frontend; direct node
  // links/tickets are deliberately absent from the Main connection menu.
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
  await expect(
    page.getByRole("menuitem", { name: "Page options", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  const popout = page.getByRole("link", { name: "Pop out tab", exact: true });
  const wrapper = new URL((await popout.getAttribute("href"))!);
  const expected = wrapper;
  expect(wrapper.origin).toBe(new URL(page.url()).origin);
  expect(wrapper.pathname).toBe("/popout");
  expect(wrapper.search).toBe("");
  expect(directTabTarget(new URLSearchParams(wrapper.hash.slice(1)))).toBe(
    fixture,
  );
  expect(new URLSearchParams(wrapper.hash.slice(1)).has("ticket")).toBe(false);
  expect(new URLSearchParams(wrapper.hash.slice(1)).get("adblock")).toBe("0");
  expect(new URLSearchParams(wrapper.hash.slice(1)).get("session")).toBe(
    JSON.parse(oldSession!),
  );
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
  const direct = await openCurrentPopout(page, context);
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
  const returnUrl = new URL(
    (await returnLink.getAttribute("href"))!,
    direct.url(),
  );
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
      directTabTarget(new URLSearchParams(new URL(direct.url()).hash.slice(1))),
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
    new URLSearchParams(new URL(direct.url()).hash.slice(1)).get("session"),
  ).toBe(new URLSearchParams(expected.hash.slice(1)).get("session"));
  expect(requests).toEqual([]);
  expect(context.pages()).toHaveLength(2);
  expect(await savedWindowTabs(page)).toBe(oldTabs);
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(oldSession);
  await expect(originalSite(page).locator('input[name="message"]')).toHaveValue(
    "Unsent original message",
  );
  await expect(page.locator(".tab")).toHaveCount(1);
  await direct.screenshot({ path: "evidence/focus-tabs/direct-node-tab.png" });
});

test("retired direct action stays absent and Popout is unavailable on new tabs or expired sessions", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menuitem", { name: action })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pop out tab", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Pop out tab", exact: true }),
  ).toHaveCount(0);
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
  const runtimeElement = await page
    .locator('iframe[title="Atlas isolated browsing runtime"]')
    .elementHandle();
  const runtime = (await runtimeElement!.contentFrame())!;
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
  await expect(page.getByRole("menuitem", { name: action })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pop out tab", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitem", { name: "Reconnect node" }),
  ).toBeFocused();
});

test("Main-assigned Popout retains the current-frontend relay and selected lease", async ({
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
    if (
      request.method() === "POST" &&
      request.url().includes("/api/browse/session") &&
      !request.postDataJSON()?.session
    )
      requests.push(request.url());
  });
  const sockets: string[] = [];
  context.on("page", (popup) =>
    popup.on("websocket", (socket) => sockets.push(socket.url())),
  );
  const direct = await openCurrentPopout(page, context);
  expect(new URL(direct.url()).origin).toBe(origin);
  expect(new URL(direct.url()).pathname).toBe("/popout");

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

test("standalone sign-in popup reload and close keep the opener and restore its address", async ({
  page,
  context,
}) => {
  await setup(page);
  await launch(page);
  await page.getByLabel("Address bar").fill("http://127.0.0.1:4199/navigation");
  await page.getByLabel("Address bar").press("Enter");
  await expect(
    originalSite(page).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Pop out tab", exact: true }),
  ).toHaveAttribute("href", /page=/);
  const direct = await openCurrentPopout(page, context);
  const activeSite = () => popoutSite(direct);
  await expect(
    activeSite().getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await activeSite().getByLabel("Website search").fill("Unsaved opener draft");
  await activeSite()
    .getByRole("button", { name: "Open sign-in popup", exact: true })
    .click();
  await expect(
    activeSite().getByRole("heading", { name: "Sign-in fixture", exact: true }),
  ).toBeVisible();
  await expect(direct.getByLabel("Website address")).toHaveValue(
    "http://127.0.0.1:4199/navigation/popup",
  );
  const activeElement = await popoutRuntime(direct)
    .locator('iframe[title="Proxied website"]:not([hidden])')
    .elementHandle();
  const activeFrame = await activeElement!.contentFrame();
  const reloaded = direct.waitForEvent("framenavigated", {
    predicate: (frame) => frame.parentFrame() === activeFrame!.parentFrame(),
  });
  await direct.getByRole("button", { name: "Reload", exact: true }).click();
  expect(await reloaded).toBe(activeFrame);
  await expect(
    activeSite().getByRole("heading", { name: "Sign-in fixture", exact: true }),
  ).toBeVisible();
  // Reload belongs to the visible popup, not its hidden parent with unsaved input.
  await expect(
    popoutRuntime(direct)
      .frameLocator('iframe[title="Proxied website"][hidden]')
      .getByLabel("Website search"),
  ).toHaveValue("Unsaved opener draft");
  // Address entry and Back also operate on the visible child, not the opener.
  await direct
    .getByLabel("Website address")
    .fill("http://127.0.0.1:4199/navigation/results?q=popup");
  await direct.getByLabel("Website address").press("Enter");
  await expect(
    activeSite().getByRole("heading", { name: "Search results", exact: true }),
  ).toBeVisible();
  await expect(
    popoutRuntime(direct)
      .frameLocator('iframe[title="Proxied website"][hidden]')
      .getByLabel("Website search"),
  ).toHaveValue("Unsaved opener draft");
  await direct.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    activeSite().getByRole("heading", { name: "Sign-in fixture", exact: true }),
  ).toBeVisible();
  await activeSite()
    .getByRole("button", { name: "Finish sign-in fixture", exact: true })
    .click();
  await expect(
    activeSite().getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible({ timeout: 3000 });
  await expect(activeSite().locator("#popup-result")).toHaveText(
    "Opener message received",
  );
  await expect(activeSite().locator("#closed-result")).toHaveText(
    "Popup closed",
  );
  await expect(activeSite().getByLabel("Website search")).toHaveValue(
    "Unsaved opener draft",
  );
  await expect(direct.getByLabel("Website address")).toHaveValue(
    "http://127.0.0.1:4199/navigation",
  );
  await expect(
    popoutRuntime(direct).locator('iframe[title="Proxied website"]'),
  ).toHaveCount(1);
  expect(
    directTabTarget(new URLSearchParams(new URL(direct.url()).hash.slice(1))),
  ).toBe("http://127.0.0.1:4199/navigation");
});
