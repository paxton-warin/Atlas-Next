import { expect, test, type Page } from "@playwright/test";

async function openCatalog(page: Page, label: "Games" | "Apps") {
  await page.locator(".main-nav").waitFor({ state: "attached" });
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation", { name: "Atlas pages", exact: true })
    .getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator(".game-art").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function centeredGlyph(page: Page, name: string) {
  const cover = page.getByRole("button", { name: `Play ${name}`, exact: true });
  const delta = await cover.evaluate((element) => {
    const art = element.getBoundingClientRect();
    const glyph = element.querySelector(".catalog-monogram")!;
    const range = document.createRange();
    range.selectNodeContents(glyph);
    const ink = range.getBoundingClientRect();
    return {
      x: ink.x + ink.width / 2 - art.x - art.width / 2,
      y: ink.y + ink.height / 2 - art.y - art.height / 2,
      tracks: getComputedStyle(element).gridTemplateColumns.split(" ").length,
    };
  });
  expect(Math.abs(delta.x), `${name} horizontal glyph center`).toBeLessThanOrEqual(6);
  expect(Math.abs(delta.y), `${name} vertical glyph center`).toBeLessThanOrEqual(6);
  expect(delta.tracks, `${name} one artwork column`).toBe(1);
}

async function containedImage(page: Page) {
  const image = page.locator(".catalog-cover img").first();
  await expect.poll(() => image.evaluate((el) => {
    const img = el as HTMLImageElement;
    return img.complete && img.naturalWidth > 0;
  })).toBe(true);
  const data = await image.evaluate((element) => {
    const img = element as HTMLImageElement;
    const style = getComputedStyle(img);
    const bounds = img.getBoundingClientRect();
    const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const vertical = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const w = bounds.width - horizontal, h = bounds.height - vertical;
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    return {
      fit: style.objectFit, position: style.objectPosition,
      padding: parseFloat(style.paddingLeft), verticalPadding: parseFloat(style.paddingTop),
      content: { w, h }, drawn: { w: img.naturalWidth * scale, h: img.naturalHeight * scale },
    };
  });
  expect(data.fit).toBe("contain");
  expect(data.position).toBe("50% 50%");
  expect(data.padding).toBeGreaterThanOrEqual(12);
  expect(data.padding).toBeLessThanOrEqual(22);
  expect(data.verticalPadding).toBe(data.padding);
  expect(data.drawn.w).toBeLessThanOrEqual(data.content.w + 0.1);
  expect(data.drawn.h).toBeLessThanOrEqual(data.content.h + 0.1);
  await expect(image.locator("..").locator(".catalog-monogram")).not.toBeVisible();
  return image;
}

for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
  test.describe(`catalog artwork ${label}`, () => {
    test.use({ viewport: { width, height }, hasTouch: label === "mobile", isMobile: label === "mobile" });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("atlas.onboarded", "true");
        localStorage.setItem("atlas.settings", JSON.stringify({ theme: "forest", mode: "dark", tabs: "sidebar", compact: false }));
      });
      await page.goto("/");
    });

    test("builtin glyphs share one centered panel and preserve hover, focus and favorite controls", async ({ page }) => {
      await openCatalog(page, "Games");
      for (const name of ["2048", "Snake", "Tic Tac Toe", "Hextris", "Little Alchemy 2", "Lichess"]) {
        await centeredGlyph(page, name);
      }
      const art = page.getByRole("button", { name: "Play 2048", exact: true });
      await page.mouse.move(width - 1, height - 1);
      await expect(art.locator(".play-overlay")).not.toBeVisible();
      await art.hover();
      await expect(art.locator(".play-overlay")).toBeVisible();
      await page.mouse.move(width - 1, height - 1);
      await art.focus();
      // Programmatic focus after pointer use is not keyboard :focus-visible.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(art).toBeFocused();
      await expect(art.locator(".play-overlay")).toBeVisible();
      const tabs = await page.locator(".tab").count();
      const favorite = page.getByRole("button", { name: "Favorite 2048", exact: true });
      await expect(favorite).toHaveAttribute("aria-pressed", "false");
      await favorite.click();
      await expect(favorite).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".tab")).toHaveCount(tabs);
    });

    test("real app/game thumbnails contain their full intrinsic image and retain error fallback", async ({ page }) => {
      await openCatalog(page, "Apps");
      const image = await containedImage(page);
      // A labeled image-error UI fixture invokes the existing handler; no catalog record changes.
      await image.dispatchEvent("error");
      await expect(image).toBeHidden();
      await expect(image.locator("..").locator(".catalog-monogram")).toBeVisible();
      await openCatalog(page, "Games");
      await page.getByLabel("Search games", { exact: true }).fill("Cookie Clicker");
      await containedImage(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });
  });
}
