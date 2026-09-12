import { test, expect, type Locator } from "@playwright/test";

async function expectNormalOverlay(card: Locator) {
  const overlay = card.locator(".play-overlay");
  await expect(overlay).toBeVisible();
  for (const [property, value] of Object.entries({
    "font-size": "14px",
    "font-family": "Inter, sans-serif",
    "letter-spacing": "normal",
    transform: "none",
    "text-shadow": "none",
    filter: "none",
    "align-items": "center",
    "justify-content": "center",
  }))
    await expect(overlay).toHaveCSS(property, value);
  const delta = await overlay.evaluate((el) => {
    const a = el.getBoundingClientRect(),
      b = el.parentElement!.getBoundingClientRect();
    return Math.max(
      Math.abs(a.x - b.x),
      Math.abs(a.y - b.y),
      Math.abs(a.width - b.width),
      Math.abs(a.height - b.height),
    );
  });
  expect(delta).toBeLessThan(1);
  await expect(overlay.locator("svg")).toHaveAttribute("width", "18");
}

test.beforeEach(async ({ page, request }) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.goto("/");
  await page.getByRole("button", { name: "Use defaults", exact: true }).click();
});

for (const width of [1440, 390]) {
  test(`catalog overlays stay small, centered and unrotated at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .locator(".main-nav")
      .getByRole("button", { name: "Games", exact: true })
      .click();
    // All decorative artwork variants plus the original working Snake card.
    for (const name of [
      "Minecraft Classic",
      "Tic Tac Toe",
      "Snake",
      "Hextris",
      "Little Alchemy 2",
      "Lichess",
    ]) {
      await page.getByLabel("Search games", { exact: true }).fill(name);
      const card = page.getByRole("button", {
        name: `Play ${name}`,
        exact: true,
      });
      await card.hover();
      await expectNormalOverlay(card);
      // Pointer out, then real keyboard navigation from the preceding select.
      await page.mouse.move(0, 0);
      await page.getByLabel("Sort games").focus();
      await expect(card.locator(".play-overlay")).not.toBeVisible();
      await page.keyboard.press("Tab");
      await expect(card).toBeFocused();
      await expectNormalOverlay(card);
      await page.keyboard.press("Tab");
      await expect(card.locator(".play-overlay")).not.toBeVisible();
    }
    await page
      .locator(".main-nav")
      .getByRole("button", { name: "Apps", exact: true })
      .click();
    await page.getByLabel("Search apps", { exact: true }).fill("Spotify");
    const app = page.getByRole("button", { name: "Open Spotify", exact: true });
    await app.hover();
    await expectNormalOverlay(app);
    await expect(app.locator(".play-overlay")).toHaveText("Open");
    await expect
      .poll(() =>
        app
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(app.locator(".catalog-monogram")).not.toBeVisible();
    await page
      .getByRole("button", { name: "Favorite Spotify", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Favorite Spotify", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });
}
