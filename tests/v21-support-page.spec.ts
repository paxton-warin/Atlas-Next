import { test, expect, type Page } from "@playwright/test";
const evidence = "evidence/iframe-layer-removal-20261021/support-page";
const ticket = "11111111-1111-4111-8111-111111111111";
const another = "22222222-2222-4222-8222-222222222222";
async function visit(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (
    (await menu.isVisible()) &&
    (await menu.getAttribute("aria-expanded")) !== "true"
  )
    await menu.click();
  await page
    .getByRole("navigation", { name: "Atlas pages" })
    .getByRole("button", { name, exact: true })
    .click();
}
for (const width of [1440, 390])
  test(`support is a dedicated page and notifications select its conversation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.addInitScript(() => {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem("atlas.sidebarCollapsed", "false");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({
          theme: "forest",
          mode: "dark",
          motion: false,
          tabs: "sidebar",
        }),
      );
      // Synthetic presentation-only session. This does not qualify authentication or SSE.
      (window as any).__supportStreams = 0;
      (window as any).EventSource = class {
        static CLOSED = 2;
        readyState = 1;
        constructor() {
          (window as any).__supportStreams++;
        }
        addEventListener() {}
        close() {
          this.readyState = 2;
        }
      };
    });
    await page.route("**/api/hub/state", (r) =>
      r.fulfill({
        json: {
          enabled: false,
          authenticated: true,
          csrf: "ui-only",
          grant: {
            userId: "ui-user",
            profileId: "ui-profile",
            contextId: "ui-context",
            sessionId: "ui-session",
          },
        },
      }),
    );
    let reads: string[] = [],
      unread = true,
      holdReply = false;
    let releaseReply!: () => void;
    const replyHeld = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const posts: { path: string; body: any }[] = [];
    await page.route("**/api/hub/support/**", async (r) => {
      const req = r.request(),
        path = new URL(req.url()).pathname.replace("/api/hub/support", "");
      if (req.method() === "POST")
        posts.push({ path, body: req.postDataJSON() });
      if (path === "/notifications")
        return r.fulfill({
          json: {
            notifications: [
              {
                id: "10",
                ticket_id: ticket,
                subject: "Your browsing issue",
                read_at: unread ? null : "2026-10-21T14:00:00Z",
              },
            ],
            unread: unread ? 1 : 0,
          },
        });
      if (path === "/tickets")
        return r.fulfill({
          json: {
            tickets: [
              {
                id: ticket,
                subject: "Your browsing issue",
                status: "open",
                unread: unread ? 1 : 0,
              },
              {
                id: another,
                subject: "A second question with a longer subject",
                status: "open",
                unread: 0,
              },
            ],
          },
        });
      if (path.endsWith("/read")) {
        reads.push(path);
        unread = false;
        return r.fulfill({ json: { acknowledged: true } });
      }
      if (path === `/tickets/${ticket}` || path === `/tickets/${another}`)
        return r.fulfill({
          json: {
            messages: [
              {
                id: "message-10",
                author: "admin",
                body: "Thanks for the details. Please retry the page and let us know if it loads.",
                created_at: "2026-10-21T13:45:00Z",
              },
            ],
          },
        });
      if (path.endsWith("/messages")) {
        if (holdReply) await replyHeld;
        return r.fulfill({
          json: {
            message: {
              id: "message-11",
              author: "user",
              body: req.postDataJSON().body,
              created_at: "2026-10-21T14:00:00Z",
            },
          },
        });
      }
      return r.fulfill({ json: {} });
    });
    await page.goto("/");
    await expect(page.getByLabel("Search the web")).toBeVisible();
    const streams = await page.evaluate(() => (window as any).__supportStreams);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Notifications", exact: true }),
    ).toBeVisible();
    expect(reads).toEqual([]);
    await expect(page.locator(".hub-support-page")).toHaveCount(0);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    if (width === 390) {
      const toast = (await page.locator(".hub-support-toast").boundingBox())!,
        bottom = (await page.locator(".mobile-bottom-nav").boundingBox())!;
      expect(toast.y + toast.height).toBeLessThanOrEqual(bottom.y);
    }
    await page.screenshot({ path: `${evidence}/notifications-${width}.png` });
    await page
      .getByRole("button", {
        name: "Your browsing issue Unread reply",
        exact: true,
      })
      .click();
    await expect(page.locator(".hub-support-page")).toBeVisible();
    const support = page.locator('.main-nav button[aria-label="Support"]');
    await expect(support).toHaveClass(/selected/);
    await expect(support).toHaveAttribute("aria-current", "page");
    if (width === 390) {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(support).toBeVisible();
      await page.screenshot({
        path: `${evidence}/support-selected-mobile-menu.png`,
      });
      await page.keyboard.press("Escape");
    }
    await expect(
      page.getByRole("dialog", { name: "Notifications", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Atlas Hub support" }),
    ).toHaveCount(0);
    await expect(page.locator(".hub-support-backdrop")).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Support conversations" })
        .getByRole("button", { name: "Your browsing issue", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => reads.length).toBe(1);
    await expect(
      page.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Your reply", exact: true })
      .fill("This reply draft survives navigation.");
    if (width === 390) {
      const list = (await page
        .getByRole("navigation", { name: "Support conversations" })
        .boundingBox())!;
      for (const item of await page
        .getByRole("navigation", { name: "Support conversations" })
        .getByRole("button")
        .all()) {
        // A bounded240px conversation scrollport need not paint every retained ticket at once.
        await item.scrollIntoViewIfNeeded();
        const bounds = (await item.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(list.y);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(
          list.y + list.height,
        );
      }
    }
    await page.screenshot({ path: `${evidence}/conversation-${width}.png` });
    const readBefore = reads.length;
    await visit(page, "Settings");
    await expect(page.locator(".hub-support-page")).toBeHidden();
    await page.evaluate(() =>
      dispatchEvent(new Event("atlas:hub-support-changed")),
    );
    await page.waitForTimeout(150);
    expect(reads.length).toBe(readBefore);
    await visit(page, "Support");
    await expect(
      page.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toHaveValue("This reply draft survives navigation.");
    await page.getByRole("button", { name: "New ticket", exact: true }).click();
    await page
      .getByLabel("Subject", { exact: true })
      .fill("A new support draft");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("This new ticket also survives page changes.");
    await visit(page, "Games");
    await visit(page, "Support");
    await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
      "A new support draft",
    );
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("This new ticket also survives page changes.");
    await page
      .getByRole("navigation", { name: "Support conversations" })
      .getByRole("button", { name: "Your browsing issue", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toHaveValue("This reply draft survives navigation.");
    holdReply = true;
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Support conversations" })
      .getByRole("button", {
        name: "A second question with a longer subject",
        exact: true,
      })
      .click();
    await page
      .getByRole("textbox", { name: "Your reply", exact: true })
      .fill("Do not erase this different conversation draft.");
    releaseReply();
    await expect(
      page.getByRole("button", { name: "Send reply", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toHaveValue("Do not erase this different conversation draft.");
    await expect(page.locator(".hub-support-messages")).not.toContainText(
      "This reply draft survives navigation.",
    );
    expect(posts.filter((p) => p.path.endsWith("/messages"))).toEqual([
      {
        path: `/tickets/${ticket}/messages`,
        body: {
          body: "This reply draft survives navigation.",
          attachments: [],
        },
      },
    ]);
    await page
      .getByRole("navigation", { name: "Support conversations" })
      .getByRole("button", { name: "Your browsing issue", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toHaveValue("");
    await page.getByRole("button", { name: "New ticket", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("This new ticket also survives page changes.");
    await page.keyboard.press("Escape");
    await expect(page.locator(".hub-support-page")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__supportStreams)).toBe(
      streams,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const controlBounds = await page
      .locator(".hub-support-page")
      .locator("input,textarea,button")
      .evaluateAll((es) =>
        es
          .filter((e) => e.checkVisibility())
          .map((e) => {
            const r = e.getBoundingClientRect();
            return { left: r.left, right: r.right, height: r.height };
          }),
      );
    for (const b of controlBounds) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(width + 1);
      expect(b.height).toBeGreaterThanOrEqual(40);
    }
    await page.screenshot({ path: `${evidence}/new-ticket-${width}.png` });
  });
test("legacy bearer-capability support stays on its dedicated page", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.route("**/api/hub/state", (r) =>
    r.fulfill({ json: { enabled: false } }),
  );
  await page.goto("/support");
  await expect(page.locator(".support-page")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "New ticket", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Atlas pages" })
      .getByRole("button", { name: "Support", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.screenshot({
    path: `evidence/iframe-layer-removal-20261021/support-page/legacy-support.png`,
  });
});
test("support page and notification navigation retain the mounted website, draft, lease and transport", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.sidebarCollapsed", "false");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({
        theme: "forest",
        mode: "dark",
        motion: false,
        tabs: "sidebar",
      }),
    );
    (window as any).EventSource = class {
      static CLOSED = 2;
      readyState = 1;
      addEventListener() {}
      close() {
        this.readyState = 2;
      }
    };
  });
  await page.route("**/api/hub/state", (r) =>
    r.fulfill({
      json: {
        enabled: false,
        authenticated: true,
        csrf: "ui-only",
        grant: {
          userId: "ui-user",
          profileId: "ui-profile",
          contextId: "ui-context",
          sessionId: "ui-session",
        },
      },
    }),
  );
  await page.route("**/api/hub/support/notifications", (r) =>
    r.fulfill({
      json: {
        notifications: [
          {
            id: "10",
            ticket_id: ticket,
            subject: "Your browsing issue",
            read_at: null,
          },
        ],
        unread: 1,
      },
    }),
  );
  await page.route("**/api/hub/support/tickets", (r) =>
    r.fulfill({
      json: {
        tickets: [
          {
            id: ticket,
            subject: "Your browsing issue",
            status: "open",
            unread: 1,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/hub/support/tickets/${ticket}`, (r) =>
    r.fulfill({
      json: {
        messages: [
          {
            id: "1",
            author: "admin",
            body: "Your reply is ready.",
            created_at: "2026-10-21T13:45:00Z",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/hub/support/tickets/${ticket}/read`, (r) =>
    r.fulfill({ json: { acknowledged: true } }),
  );
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const host = page.locator('iframe[title="Atlas isolated browsing runtime"]');
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready", exact: true }),
  ).toBeVisible();
  await site
    .locator('input[name="message"]')
    .fill("Website draft remains mounted while support opens.");
  await site
    .locator("body")
    .evaluate((el) => (el.dataset.supportLifetime = "retained"));
  await host.evaluate((el) => ((window as any).__supportHost = el));
  const src = await host.getAttribute("src"),
    lease = await page.evaluate(() =>
      localStorage.getItem("atlas.nodeSession"),
    );
  const navigations: string[] = [],
    allocations: string[] = [],
    sockets: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) navigations.push(frame.url());
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/browse\/(?:controller\/)?session$/.test(
        new URL(request.url()).pathname,
      ) &&
      request.postDataJSON()?.intent !== "renew"
    )
      allocations.push(request.url());
  });
  await visit(page, "Support");
  await expect(page.locator(".hub-support-page")).toBeVisible();
  await visit(page, "Browser");
  await expect(site.locator('input[name="message"]')).toHaveValue(
    "Website draft remains mounted while support opens.",
  );
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page
    .getByRole("button", { name: /Your browsing issue.*Unread reply/ })
    .click();
  await expect(page.locator(".hub-support-page")).toBeVisible();
  await visit(page, "Browser");
  await expect(site.locator("body")).toHaveAttribute(
    "data-support-lifetime",
    "retained",
  );
  await expect(site.locator('input[name="message"]')).toHaveValue(
    "Website draft remains mounted while support opens.",
  );
  expect(
    await host.evaluate((el) => el === (window as any).__supportHost),
  ).toBe(true);
  expect(await host.getAttribute("src")).toBe(src);
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(lease);
  expect(navigations).toEqual([]);
  expect(allocations).toEqual([]);
  expect(sockets).toEqual([]);
  await page.screenshot({ path: `${evidence}/retained-website.png` });
});
