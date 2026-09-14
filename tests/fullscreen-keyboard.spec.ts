import { test, expect, type Page } from "@playwright/test";

const website = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');

async function launchFullscreenFixture(page: Page) {
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    website(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enter focus mode" }).click();
  // Install controls in the real proxied document, not a mocked iframe. Native
  // fullscreen is requested by the trusted click below, retaining activation.
  await website(page)
    .locator("body")
    .evaluate((body) => {
      const doc = body.ownerDocument;
      const enter = doc.createElement("button");
      enter.textContent = "Enter game fullscreen";
      const exit = doc.createElement("button");
      exit.textContent = "Exit game fullscreen";
      const result = doc.createElement("p");
      result.id = "fullscreen-result";
      result.textContent = "Ready";
      body.dataset.escapeCount = "0";
      body.dataset.exitClicks = "0";
      doc.addEventListener("keydown", (event) => {
        if (event.key === "Escape")
          body.dataset.escapeCount = String(
            Number(body.dataset.escapeCount) + 1,
          );
      });
      enter.addEventListener("click", () => {
        doc.documentElement.requestFullscreen().then(
          () => {
            result.textContent = "Fullscreen entered";
          },
          (error) => {
            result.textContent = `Fullscreen failed: ${error.name}`;
          },
        );
      });
      exit.addEventListener("click", () => {
        body.dataset.exitClicks = String(Number(body.dataset.exitClicks) + 1);
        doc.exitFullscreen().then(() => {
          result.textContent = "Fullscreen exited";
        });
      });
      body.prepend(enter, exit, result);
    });
}

async function enterFullscreen(page: Page) {
  await website(page)
    .getByRole("button", { name: "Enter game fullscreen", exact: true })
    .click();
  await expect(website(page).locator("#fullscreen-result")).toHaveText(
    "Fullscreen entered",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement ===
          document.querySelector(
            'iframe[title="Atlas isolated browsing runtime"]',
          ),
      ),
    )
    .toBe(true);
}

async function exitFullscreen(page: Page) {
  const exit = website(page).getByRole("button", {
    name: "Exit game fullscreen",
    exact: true,
  });
  // The native fullscreen transition can drop an immediate mouse click while
  // cross-frame coordinates settle. Use the control's real keyboard activation
  // instead; do not call exitFullscreen directly from test automation.
  await exit.focus();
  await expect(exit).toBeFocused();
  await exit.press("Enter");
  await expect(website(page).locator("body")).toHaveAttribute(
    "data-exit-clicks",
    "1",
  );
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(website(page).locator("#fullscreen-result")).toHaveText(
    "Fullscreen exited",
  );
}

test("game fullscreen acquires real top-level Escape lock, delivers Escape to the game, and releases on exit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "top", motion: false }),
    );
    const keyboard = (navigator as any).keyboard;
    const probe = ((window as any).__atlasKeyboardProbe = {
      supported: !!keyboard?.lock && !!keyboard?.unlock,
      calls: [] as string[][],
      resolved: 0,
      errors: [] as string[],
      unlocks: 0,
    });
    if (!probe.supported) return;
    const nativeLock = keyboard.lock.bind(keyboard);
    const nativeUnlock = keyboard.unlock.bind(keyboard);
    Object.defineProperty(keyboard, "lock", {
      configurable: true,
      value: async (keys?: string[]) => {
        probe.calls.push(keys ? [...keys] : []);
        try {
          // Instrumentation delegates to Chromium's actual Keyboard Lock API.
          // A rejected native request remains rejected; success is never faked.
          await nativeLock(keys);
          probe.resolved++;
        } catch (error) {
          probe.errors.push((error as Error).name);
          throw error;
        }
      },
    });
    Object.defineProperty(keyboard, "unlock", {
      configurable: true,
      value: () => {
        probe.unlocks++;
        return nativeUnlock();
      },
    });
  });
  await launchFullscreenFixture(page);
  expect(
    await page.evaluate(() => (window as any).__atlasKeyboardProbe.supported),
  ).toBe(true);
  await enterFullscreen(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__atlasKeyboardProbe.resolved),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => (window as any).__atlasKeyboardProbe.calls),
  ).toEqual([["Escape"]]);
  expect(
    await page.evaluate(() => (window as any).__atlasKeyboardProbe.errors),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(website(page).locator("body")).toHaveAttribute(
    "data-escape-count",
    "1",
  );
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.screenshot({ path: "evidence/focus-tabs/fullscreen-escape.png" });
  await exitFullscreen(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__atlasKeyboardProbe.unlocks),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".atlas")).toHaveClass(/focus-mode/);
  // Keyboard events inside an iframe do not bubble into Atlas. Exercise the
  // separate outer-window Escape handler after exiting real fullscreen, too.
  await page.locator("body").evaluate((body) => {
    body.tabIndex = -1;
    body.focus();
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".atlas")).toHaveClass(/focus-mode/);
  await page.getByRole("button", { name: "Exit focus mode" }).click();
  await expect(page.locator(".horizontal-tabs")).toBeVisible();
});

test("denied keyboard lock preserves native fullscreen and an explicit way out without uncaught errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "top", motion: false }),
    );
    const probe = ((window as any).__atlasKeyboardProbe = {
      calls: [] as string[][],
    });
    Object.defineProperty(navigator, "keyboard", {
      configurable: true,
      value: {
        lock: (keys: string[]) => {
          probe.calls.push([...keys]);
          return Promise.reject(
            new DOMException("Permission denied in fixture", "NotAllowedError"),
          );
        },
        unlock() {},
      },
    });
  });
  await launchFullscreenFixture(page);
  await enterFullscreen(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__atlasKeyboardProbe.calls))
    .toEqual([["Escape"]]);
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await exitFullscreen(page);
  expect(errors).toEqual([]);
  await expect(page.getByRole("status")).toContainText(
    "Fullscreen keyboard capture was not enabled.",
  );
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.locator(".atlas")).toHaveClass(/focus-mode/);
  await page.getByRole("button", { name: "Exit focus mode" }).click();
  await expect(page.locator(".horizontal-tabs")).toBeVisible();
});
