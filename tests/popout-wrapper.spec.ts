import { test, expect, type Page } from "@playwright/test";
import { createPopoutUrl, parsePopoutLaunch } from "../web/src/popout-link";

const fixture = "http://127.0.0.1:4199/navigation";
const site = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');

test.beforeEach(async ({ page, request }) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.settings", JSON.stringify({ motion: false }));
  });
});

async function launch(page: Page) {
  await page.goto("/");
  await page.getByLabel("Search the web").fill(fixture);
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    site(page).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("atlas.tabs")!)[0]?.title,
      ),
    )
    .toBe("Navigation fixture");
}

test("toolbar popout keeps the frontend, pinned node and original tabs through navigation and reload", async ({
  page,
  context,
}) => {
  await launch(page);
  const link = page.getByRole("link", { name: "Pop out tab", exact: true });
  const href = new URL((await link.getAttribute("href"))!);
  expect(href.origin).toBe(new URL(page.url()).origin);
  expect(href.pathname).toBe("/popout");
  expect(href.search).toBe("");
  expect(href.hash).not.toContain("ticket=");
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  expect(parsePopoutLaunch(href.href).session).toBe(session);
  const oldTabs = await page.evaluate(() => localStorage.getItem("atlas.tabs"));
  await site(page).getByLabel("Website search").fill("Original unsent draft");
  const sessionRequests: unknown[] = [];
  context.on("request", (r) => {
    if (r.url().endsWith("/api/browse/session"))
      sessionRequests.push(r.postDataJSON());
  });
  const opened = context.waitForEvent("page");
  await link.click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(popup.locator(".sidebar, .main-nav")).toHaveCount(0);
  await expect(
    popup.getByRole("link", { name: "Open direct node tab" }),
  ).toHaveAttribute("href", /^http:\/\/127\.0\.0\.1:4181\/#/);
  await popup.getByLabel("Website address").fill(fixture + "?popout=1");
  await popup.getByLabel("Website address").press("Enter");
  await expect
    .poll(() => parsePopoutLaunch(popup.url()).target)
    .toBe(fixture + "?popout=1");
  await popup.reload();
  await expect(
    site(popup).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  expect(sessionRequests).toEqual([{ session }, { session }]);
  expect(await page.evaluate(() => localStorage.getItem("atlas.tabs"))).toBe(
    oldTabs,
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("atlas.nodeSession")!),
    ),
  ).toBe(session);
  await expect(site(page).getByLabel("Website search")).toHaveValue(
    "Original unsent draft",
  );
  for (const width of [1440, 390, 320]) {
    await popup.setViewportSize({ width, height: 850 });
    expect(
      await popup.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bar = popup.getByRole("form", { name: "Popout browser controls" });
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(44);
    await popup.screenshot({
      path: `evidence/compatibility-followup-20260928/wrapper-${width}.png`,
    });
  }
});

test("wrapper sign-in popups close back to their opener without discarding its draft", async ({
  page,
  context,
}) => {
  await launch(page);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await site(popup).getByLabel("Website search").fill("Keep this draft");
  await site(popup)
    .getByRole("button", { name: "Open sign-in popup", exact: true })
    .click();
  await expect(
    site(popup).getByRole("heading", { name: "Sign-in fixture", exact: true }),
  ).toBeVisible();
  await expect(popup.getByLabel("Website address")).toHaveValue(
    fixture + "/popup",
  );
  await popup.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(
    site(popup).getByRole("heading", { name: "Sign-in fixture", exact: true }),
  ).toBeVisible();
  await site(popup)
    .getByRole("button", { name: "Finish sign-in fixture" })
    .click();
  await expect(site(popup).getByLabel("Website search")).toHaveValue(
    "Keep this draft",
  );
  await expect(site(popup).locator("#popup-result")).toHaveText(
    "Opener message received",
  );
  await expect(popup.getByLabel("Website address")).toHaveValue(fixture);
  expect(context.pages()).toHaveLength(2);
});

test("wrapper reuses virtual HttpOnly website cookies from the embedded runtime", async ({
  page,
  context,
}) => {
  await launch(page);
  await site(page)
    .frameLocator('iframe[title="Nested callback fixture"]')
    .getByRole("button", { name: "Complete callback fixture" })
    .click();
  await expect(site(page).locator("#cookie")).toHaveText("Cookie retained");
  await expect
    .poll(async () => {
      const href = await page
        .getByRole("link", { name: "Pop out tab", exact: true })
        .getAttribute("href");
      return href ? parsePopoutLaunch(href).target : "";
    })
    .toBe(fixture + "/done?q=kept");
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(site(popup).locator("#cookie")).toHaveText("Cookie retained");
  await popup.reload();
  await expect(site(popup).locator("#cookie")).toHaveText("Cookie retained");
});

test("expired popout handoff does not allocate another node or overwrite main storage", async ({
  page,
}) => {
  await launch(page);
  const href = (await page
    .getByRole("link", { name: "Pop out tab", exact: true })
    .getAttribute("href"))!;
  const saved = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  await page.request.delete("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { session: JSON.parse(saved!) },
  });
  const requests: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/browse/session"))
      requests.push(r.postDataJSON());
  });
  await page.goto(href);
  await expect(
    page.getByRole("heading", { name: "Connection unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to Atlas" }).last(),
  ).toHaveAttribute("href", "/");
  expect(requests).toEqual([{ session: JSON.parse(saved!) }]);
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(saved);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("missing lease never falls back to an unrelated stored lease", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "atlas.nodeSession",
      JSON.stringify("unrelated_lease"),
    ),
  );
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/browse/session")) requests.push(r.url());
  });
  await page.goto(createPopoutUrl("http://localhost:4180", fixture));
  await expect(
    page.getByRole("heading", { name: "Connection unavailable" }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("wrapper handles fullscreen Escape at the top level and ignores forged child navigation", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (window !== top) return;
    const keyboard = (navigator as any).keyboard;
    const lock = keyboard.lock.bind(keyboard);
    (window as any).__locked = 0;
    keyboard.lock = async (keys: string[]) => {
      await lock(keys);
      (window as any).__locked++;
    };
  });
  await launch(page);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await site(popup)
    .locator("body")
    .evaluate((body) => {
      window.top!.postMessage(
        {
          atlas: 1,
          type: "navigation",
          id: "popup",
          url: "https://forged.example",
        },
        "*",
      );
      const doc = body.ownerDocument;
      body.dataset.escape = "0";
      const enter = doc.createElement("button");
      enter.textContent = "Enter fixture fullscreen";
      enter.onclick = () => void doc.documentElement.requestFullscreen();
      const exit = doc.createElement("button");
      exit.textContent = "Exit fixture fullscreen";
      exit.onclick = () => void doc.exitFullscreen();
      doc.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
          body.dataset.escape = String(Number(body.dataset.escape) + 1);
      });
      body.prepend(enter, exit);
    });
  await expect(popup.getByLabel("Website address")).toHaveValue(fixture);
  await site(popup)
    .getByRole("button", { name: "Enter fixture fullscreen" })
    .click();
  await expect
    .poll(() => popup.evaluate(() => (window as any).__locked))
    .toBe(1);
  await popup.keyboard.press("Escape");
  await expect(site(popup).locator("body")).toHaveAttribute("data-escape", "1");
  expect(await popup.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await site(popup)
    .getByRole("button", { name: "Exit fixture fullscreen" })
    .focus();
  await site(popup)
    .getByRole("button", { name: "Exit fixture fullscreen" })
    .press("Enter");
  await expect
    .poll(() => popup.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
});

test("wrapper panic key ignores address typing but works outside editable controls", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    if (window === top)
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({
          motion: false,
          exitKey: "i",
          exitUrl: "https://panic.fixture.test/",
        }),
      );
  });
  await context.route("https://panic.fixture.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Exit fixture</h1>" }),
  );
  await launch(page);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  await expect(
    site(popup).getByRole("heading", {
      name: "Navigation fixture",
      exact: true,
    }),
  ).toBeVisible();
  await popup.getByLabel("Website address").fill("");
  await popup.getByLabel("Website address").press("i");
  await expect(popup.getByLabel("Website address")).toHaveValue("i");
  expect(new URL(popup.url()).pathname).toBe("/popout");
  await popup.getByRole("link", { name: "Atlas home", exact: true }).focus();
  await popup.keyboard.press("i");
  await expect(
    popup.getByRole("heading", { name: "Exit fixture" }),
  ).toBeVisible();
});
