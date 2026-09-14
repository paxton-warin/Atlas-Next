import { test, expect, type Page } from "@playwright/test";

const fixture = "http://127.0.0.1:4199/fixture";
const stage = process.env.UI_STAGE || "modified";
async function launch(page: Page, width: number) {
  await page.setViewportSize({ width, height: 850 });
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.settings", JSON.stringify({ motion: false }));
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill(fixture);
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]')
      .getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`popout and focus controls share their size and surface at ${width}px`, async ({
    page,
  }) => {
    await launch(page, width);
    const popout = page.getByRole("link", { name: "Pop out tab", exact: true });
    const focus = page.getByRole("button", { name: "Enter focus mode" });
    await page
      .locator(".browser-toolbar")
      .screenshot({
        path: `evidence/popout-style/${stage}-buttons-${width}.png`,
      });
    const styles = await Promise.all(
      [popout, focus].map((control) =>
        control.evaluate((element) => {
          const css = getComputedStyle(element),
            box = element.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            border: css.border,
            radius: css.borderRadius,
            color: css.color,
            background: css.backgroundColor,
          };
        }),
      ),
    );
    expect(styles[0]).toEqual(styles[1]);
    expect(styles[0].height).toBeLessThanOrEqual(32);
    await focus.focus();
    expect(
      await focus.evaluate((element) => getComputedStyle(element).outlineStyle),
    ).not.toBe("none");
    await focus.press("Enter");
    const exit = page.getByRole("button", { name: "Exit focus mode" });
    await expect(exit).toHaveAttribute("aria-pressed", "true", {
      timeout: 1500,
    });
    await expect(popout).toBeVisible();
    await exit.click();
    await expect(
      page.getByRole("button", { name: "Enter focus mode" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test(`standalone popout is compact and navigable at ${width}px`, async ({
    page,
    context,
  }) => {
    await launch(page, width);
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
    const direct = await opened;
    await direct.setViewportSize({ width, height: 850 });
    const site = direct.frameLocator('iframe[title="Proxied website"]');
    await expect(
      site.getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    const bar = direct.locator("#popup-toolbar");
    await bar.screenshot({
      path: `evidence/popout-style/${stage}-popout-${width}.png`,
    });
    const bounds = (await bar.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(40);
    const frames = (await direct.locator("#frames").boundingBox())!;
    expect(frames.y).toBe(bounds.y + bounds.height);
    expect(frames.height + frames.y).toBe(850);
    expect(
      await bar.evaluate((element) =>
        [...element.children].every((child) => {
          const rect = child.getBoundingClientRect();
          return !rect.width || (rect.left >= 0 && rect.right <= innerWidth);
        }),
      ),
    ).toBe(true);
    await expect(
      direct.getByRole("link", { name: "Return to Atlas" }),
    ).toHaveAttribute("href", "http://localhost:4180");
    const input = direct.getByLabel("Website address");
    await input.fill(fixture + "?compact=1");
    await input.press("Enter");
    await expect(
      site.getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    await expect(input).toHaveValue(fixture + "?compact=1");
    await direct.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(
      site.getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    await direct.locator("#popup-status").evaluate((element) => {
      element.textContent = "Session expired. Return to Atlas and reconnect.";
    });
    const notice = (await direct.getByRole("status").boundingBox())!;
    expect(notice.y).toBeGreaterThan(bounds.height);
    expect((await bar.boundingBox())!.height).toBe(bounds.height);
    expect(
      await direct.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await direct.close();
  });
}
