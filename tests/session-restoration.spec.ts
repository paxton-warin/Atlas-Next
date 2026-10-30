import { test, expect, type Page } from "@playwright/test";
async function expiredLease(page: Page) {
  const response = await page.request.post("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { intent: "new", session: "" },
  });
  expect(response.ok()).toBeTruthy();
  const lease = await response.json();
  const expired = await page.request.post(
    "http://127.0.0.1:4199/__test/expire-browse-session",
    { data: { session: lease.session } },
  );
  expect(expired.ok()).toBeTruthy();
  return lease;
}

test("fresh launch renews an expired stored lease once without prompting and retains saved tabs", async ({
  page,
}) => {
  const original = await expiredLease(page);
  await page.addInitScript((session) => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ restore: true, motion: false }),
    );
    localStorage.setItem("atlas.nodeSession", JSON.stringify(session));
    localStorage.setItem(
      "atlas.tabs",
      JSON.stringify([
        {
          id: "restored",
          url: "http://127.0.0.1:4199/fixture",
          title: "Saved page",
          engine: "scramjet",
        },
      ]),
    );
  }, original.session);
  const sessions: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/browse/session") && r.method() === "POST")
      sessions.push(r.postDataJSON().session);
  });
  await page.goto("/");
  await expect
    .poll(() => sessions, { timeout: 5000 })
    .toEqual([original.session]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("atlas.nodeSession")!),
      ),
    )
    .toBe(original.session);
  await expect(
    page.getByRole("dialog", { name: "Browsing session expired" }),
  ).not.toBeVisible();
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.locator(".tab-main").click();
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]')
      .getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
});

test("two simultaneous fresh windows renew one stale lease under the origin lock", async ({
  page,
  context,
}) => {
  const original = await expiredLease(page);
  await context.addInitScript((session) => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    if (!localStorage.getItem("atlas.concurrentSeed")) {
      localStorage.setItem("atlas.concurrentSeed", "true");
      localStorage.setItem("atlas.nodeSession", JSON.stringify(session));
    }
  }, original.session);
  const sessions: string[] = [];
  context.on("request", (request) => {
    if (
      request.url().endsWith("/api/browse/session") &&
      request.method() === "POST"
    )
      sessions.push(request.postDataJSON().session);
  });
  const second = await context.newPage();
  await Promise.all([page.goto("/"), second.goto("/")]);
  for (const window of [page, second])
    await expect(
      window.locator('iframe[title="Atlas isolated browsing runtime"]'),
    ).toHaveCount(1);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  expect(saved).toBe(original.session);
  expect(sessions).toEqual([original.session, original.session]);
  for (const window of [page, second])
    await expect(
      window.getByRole("dialog", { name: "Browsing session expired" }),
    ).not.toBeVisible();
  await second.close();
});

test("reconnect releases this window's active lease, not another window's saved lease", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const own = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  const otherResponse = await page.request.post("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { session: "" },
  });
  expect(otherResponse.ok()).toBeTruthy();
  const other = (await otherResponse.json()).session;
  // Same-origin windows share storage, but not the live React/runtime session.
  await page.evaluate(
    (session) =>
      localStorage.setItem("atlas.nodeSession", JSON.stringify(session)),
    other,
  );
  const releases: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/browse/session") &&
      request.method() === "DELETE"
    )
      releases.push(request.postDataJSON().session);
  });
  await page.getByRole("button", { name: "Connection options" }).click();
  await page.getByRole("menuitem", { name: "Reconnect node" }).click();
  const dialog = page.getByRole("dialog", { name: "Reconnect browsing?" });
  await dialog.getByRole("button", { name: "Reconnect node" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  expect(releases).toEqual([]);
  const otherStillValid = await page.request.post("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { intent: "restore", session: other },
  });
  expect(otherStillValid.ok()).toBeTruthy();
  expect((await otherStillValid.json()).session).toBe(other);
});

test("corrupt stored tabs and session do not prevent a fresh launch", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.nodeSession", JSON.stringify({ broken: true }));
    localStorage.setItem("atlas.tabs", JSON.stringify({ broken: true }));
  });
  const sessions: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/browse/session") &&
      request.method() === "POST"
    )
      sessions.push(request.postDataJSON().session);
  });
  await page.goto("/");
  await expect(
    page.locator('iframe[title="Atlas isolated browsing runtime"]'),
  ).toHaveCount(1);
  await expect(page.getByLabel("Search the web")).toBeVisible();
  expect(sessions).toEqual([""]);
  expect(errors).toEqual([]);
});

test("online renewal keeps the mounted runtime and live website intact", async ({
  page,
}) => {
  const relayUrls: string[] = [];
  page.on("websocket", (socket) => relayUrls.push(socket.url()));
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
    // Observe only actual native transport sockets in the trusted runtime.
    // Website WebSockets remain the normal rewritten, brokered implementation.
    if (
      location.origin !== "http://127.0.0.1:4181" ||
      location.pathname !== "/"
    )
      return;
    const Native = WebSocket;
    const sockets: WebSocket[] = [];
    (window as any).__atlasTestRelaySockets = sockets;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        if (new URL(String(url), location.href).pathname.startsWith("/relay/"))
          sockets.push(this);
      }
    };
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const runtime = page.locator(
    'iframe[title="Atlas isolated browsing runtime"]',
  );
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const before = await runtime.getAttribute("src");
  await site.locator("body").evaluate((body) => {
    body.dataset.retainedDuringRenewal = "yes";
  });
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeLease.v2")!),
  );
  const runtimeFrame = page
    .frames()
    .find(
      (frame) =>
        frame.parentFrame() === page.mainFrame() &&
        frame.url().startsWith("http://127.0.0.1:4181"),
    )!;
  await runtimeFrame.evaluate(() => {
    addEventListener("message", (event) => {
      if (event.data?.atlas === 1 && event.data.type === "session-update")
        document.body.dataset.ownerCapabilityPrivate = String(
          !Object.hasOwn(event.data, "session") &&
            /^[a-f0-9]{64}$/.test(event.data.sessionHash || ""),
        );
    });
  });
  await page.evaluate(() =>
    window.addEventListener("message", (event) => {
      if (
        event.source ===
          document.querySelector<HTMLIFrameElement>(
            'iframe[title="Atlas isolated browsing runtime"]',
          )?.contentWindow &&
        event.data?.type === "session-updated"
      )
        document.body.dataset.leaseUpdateAcknowledged = "yes";
    }),
  );
  const renewal = page.waitForResponse(
    async (response) =>
      response.url().endsWith("/api/browse/session") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().intent === "renew",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const lease = await (await renewal).json();
  expect(lease.session).toBe(original.session);
  expect(lease.generation).toBe(original.generation);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("atlas.nodeLease.v2")!).serverTime,
      ),
    )
    .toBe(lease.serverTime);
  expect(await runtime.getAttribute("src")).toBe(before);
  await expect(site.locator("body")).toHaveAttribute(
    "data-retained-during-renewal",
    "yes",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-lease-update-acknowledged",
    "yes",
  );
  await expect(runtimeFrame.locator("body")).toHaveAttribute(
    "data-owner-capability-private",
    "true",
  );
  await site.getByRole("button", { name: "Test fetch" }).click();
  await expect(site.locator("#fetch-result")).toContainText(
    '"body":"fetch works"',
  );
  await site.getByRole("button", { name: "Test WebSocket" }).click();
  await expect(site.locator("#socket-result")).toHaveText("socket works");
  const fresh = encodeURIComponent(lease.relayTicket || lease.ticket);
  // Renewal must not replace a healthy multiplexed relay or native HTTP pool.
  // The fresh upgrade credential is for the NEXT connection, not a forced one.
  expect(relayUrls.some((url) => new URL(url).pathname.includes(fresh))).toBe(
    false,
  );
  const closed = await runtimeFrame.evaluate(async () => {
    const sockets = ((window as any).__atlasTestRelaySockets ||
      []) as WebSocket[];
    const active = sockets.filter(
      (socket) => socket.readyState === WebSocket.OPEN,
    );
    await Promise.all(
      active.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true });
            socket.close(1000, "Fixture relay reconnect");
          }),
      ),
    );
    return active.length;
  });
  expect(closed).toBeGreaterThan(0);
  await site.locator("#socket-result").evaluate((output) => {
    output.textContent = "";
  });
  await site.getByRole("button", { name: "Test WebSocket" }).click();
  await expect(site.locator("#socket-result")).toHaveText("socket works");
  await expect
    .poll(() => relayUrls.some((url) => new URL(url).pathname.includes(fresh)))
    .toBe(true);
  expect(await runtime.getAttribute("src")).toBe(before);
  await expect(site.locator("body")).toHaveAttribute(
    "data-retained-during-renewal",
    "yes",
  );
});

test("transient renewal outage preserves the pin and retries instead of prompting", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await expect(
    page.locator('iframe[title="Atlas isolated browsing runtime"]'),
  ).toHaveCount(1);
  const saved = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  let failed = false,
    renewed = false;
  await page.route("**/api/browse/session", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().intent === "renew"
    ) {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: { "Retry-After": "1" },
          body: JSON.stringify({
            error: "Temporary node outage",
            code: "NODE_UNAVAILABLE",
            retryable: true,
          }),
        });
        return;
      }
      renewed = true;
    }
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => renewed, { timeout: 7000 }).toBe(true);
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(saved);
  await expect(
    page.getByRole("dialog", { name: "Browsing session expired" }),
  ).not.toBeVisible();
});

test("a mounted older window joins its peer's authoritative restored generation without an expiry prompt", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await site.getByRole("button", { name: "Save storage" }).click();
  await expect(site.locator("#stored")).toHaveText("persisted");
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeLease.v2")!),
  );
  const originalSource = await page
    .locator('iframe[title="Atlas isolated browsing runtime"]')
    .getAttribute("src");
  const expired = await page.request.post(
    "http://127.0.0.1:4199/__test/expire-browse-session",
    { data: { session: original.session } },
  );
  expect(expired.ok()).toBeTruthy();
  const peer = await context.newPage();
  await peer.goto("/");
  await expect(
    peer.locator('iframe[title="Atlas isolated browsing runtime"]'),
  ).toHaveCount(1);
  const restored = await peer.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeLease.v2")!),
  );
  expect(restored.session).toBe(original.session);
  expect(restored.generation).toBe(original.generation + 1);
  const sameCapability = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/browse/session") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().intent === "restore" &&
      response.request().postDataJSON().session === original.session &&
      response.request().postDataJSON().generation === undefined,
  );
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect((await (await sameCapability).json()).generation).toBe(
    restored.generation,
  );
  await expect(
    page.locator('iframe[title="Atlas isolated browsing runtime"]'),
  ).not.toHaveAttribute("src", originalSource!);
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(site.locator("#stored")).toHaveText("persisted");
  await expect(
    page.getByRole("dialog", { name: "Browsing session expired" }),
  ).not.toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("atlas.nodeSession")!),
    ),
  ).toBe(original.session);
  await peer.close();
});

test("popout generation recovery retains its latest URL and other managed pages", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  const base = "http://127.0.0.1:4199";
  await page.getByLabel("Search the web").fill(base + "/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = (target: Page) =>
    target
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await popup.getByLabel("Website address").fill(base + "/fixture?next=1");
  await popup.getByLabel("Website address").press("Enter");
  await expect(popup.getByLabel("Website address")).toHaveValue(
    base + "/fixture?next=1",
  );
  await expect(
    site(popup).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await site(popup).getByRole("button", { name: "Save storage" }).click();
  await site(popup)
    .getByRole("link", { name: "Open popup", exact: true })
    .click();
  await expect(popup.getByLabel("Website address")).toHaveValue(
    base + "/fixture?popup=1",
  );
  await expect(
    site(popup).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const runtime = popup.locator(
    'iframe[title="Atlas isolated browsing runtime"]',
  );
  const source = await runtime.getAttribute("src");
  const original = await popup.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeLease.v2")!),
  );
  const expired = await popup.request.post(
    base + "/__test/expire-browse-session",
    { data: { session: original.session } },
  );
  expect(expired.ok()).toBeTruthy();
  const restore = popup.waitForResponse(
    (response) =>
      response.url().endsWith("/api/browse/session") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().intent === "restore",
  );
  await popup.evaluate(() => window.dispatchEvent(new Event("online")));
  expect((await (await restore).json()).generation).toBe(
    original.generation + 1,
  );
  await expect(runtime).not.toHaveAttribute("src", source!);
  await expect(
    site(popup).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(popup.getByLabel("Website address")).toHaveValue(
    base + "/fixture?popup=1",
  );
  await expect(
    popup
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .locator('iframe[title="Proxied website"]'),
  ).toHaveCount(2);
  await popup.getByRole("button", { name: "Close sign-in popup" }).click();
  await expect(popup.getByLabel("Website address")).toHaveValue(
    base + "/fixture?next=1",
  );
  await expect(site(popup).locator("#stored")).toHaveText("persisted");
  await expect(popup.locator(".popout-state")).not.toBeVisible();
  await popup.close();
});
