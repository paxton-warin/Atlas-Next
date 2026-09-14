import { test, expect, type Page, type BrowserContext } from "@playwright/test";
const site = (page: Page) =>
  page.frameLocator('iframe[title="Proxied website"]');
async function popout(page: Page, context: BrowserContext) {
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.settings", JSON.stringify({ motion: false }));
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]')
      .getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const direct = await opened;
  await expect(
    site(direct).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  return direct;
}

test("popped-out runtime keeps native fullscreen Escape capture on its own top-level page", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (window !== top) return;
    const keyboard = (navigator as any).keyboard;
    (window as any).__lockKeys = [];
    (window as any).__lockResolved = 0;
    const nativeLock = keyboard.lock.bind(keyboard);
    keyboard.lock = async (keys: string[]) => {
      (window as any).__lockKeys.push(keys);
      await nativeLock(keys);
      (window as any).__lockResolved++;
    };
  });
  const direct = await popout(page, context);
  await site(direct)
    .locator("body")
    .evaluate((body) => {
      const doc = body.ownerDocument;
      body.dataset.escape = "0";
      const enter = doc.createElement("button"),
        exit = doc.createElement("button");
      enter.textContent = "Fullscreen fixture";
      exit.textContent = "Exit fullscreen fixture";
      enter.onclick = () => {
        void doc.documentElement.requestFullscreen();
      };
      exit.onclick = () => {
        void doc.exitFullscreen();
      };
      doc.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
          body.dataset.escape = String(Number(body.dataset.escape) + 1);
      });
      body.prepend(enter, exit);
    });
  await site(direct)
    .getByRole("button", { name: "Fullscreen fixture", exact: true })
    .click();
  await expect
    .poll(() => direct.evaluate(() => (window as any).__lockResolved))
    .toBe(1);
  expect(await direct.evaluate(() => (window as any).__lockKeys)).toEqual([
    ["Escape"],
  ]);
  await direct.keyboard.press("Escape");
  await expect(site(direct).locator("body")).toHaveAttribute(
    "data-escape",
    "1",
  );
  expect(await direct.evaluate(() => !!document.fullscreenElement)).toBe(true);
  const exit = site(direct).getByRole("button", {
    name: "Exit fullscreen fixture",
    exact: true,
  });
  await exit.focus();
  await exit.press("Enter");
  await expect
    .poll(() => direct.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(
    direct.getByRole("link", { name: "Return to Atlas" }),
  ).toBeVisible();
});

test("popped-out node session expiry gives a return action and stale-link boot shows an explanation", async ({
  page,
  context,
}) => {
  const direct = await popout(page, context);
  const currentUrl = direct.url();
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  await page.request.delete("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { session },
  });
  await direct.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(direct.getByRole("status")).toHaveText(
    "Session expired. Return to Atlas and reconnect.",
  );
  await expect(direct.getByLabel("Website address")).toBeDisabled();
  await expect(
    direct.getByRole("link", { name: "Return to Atlas" }),
  ).toHaveAttribute("href", "http://localhost:4180");
  // A stale fragment must not allocate a different session behind the user.
  const allocations: string[] = [];
  context.on("request", (request) => {
    if (request.url().includes("/api/browse/session"))
      allocations.push(request.url());
  });
  expect(direct.url()).toBe(currentUrl);
  // goto() of the identical fragment is a same-document navigation. Reload
  // exercises an actual fresh bootstrap of this now-stale private link.
  await direct.reload();
  await expect(
    direct.getByRole("heading", { name: "Connection unavailable" }),
  ).toBeVisible();
  await expect(
    direct.getByText("Return to Atlas, reconnect, and open this page again."),
  ).toBeVisible();
  expect(allocations).toEqual([]);
});
