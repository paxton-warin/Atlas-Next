import { expect, type BrowserContext, type Page } from "@playwright/test";

/** Current profileV2 standalone UX is a frontend-origin Popout, not the retired
 * direct-node menu action. Keep the native website in its owning runtime realm. */
export const popoutSite = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
export const popoutRuntime = (page: Page) =>
  page.frameLocator('iframe[title="Atlas isolated browsing runtime"]');
export async function openCurrentPopout(page: Page, context: BrowserContext) {
  await expect(
    page.getByRole("menuitem", { name: "Open direct node tab", exact: true }),
  ).toHaveCount(0);
  const link = page.getByRole("link", { name: "Pop out tab", exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const opened = context.waitForEvent("page");
  await link.click();
  const popout = await opened;
  await expect(
    popout.getByRole("link", { name: "Return to Atlas", exact: true }),
  ).toBeVisible();
  await expect(popoutSite(popout).locator("body")).toHaveCount(1);
  return popout;
}

/** Anonymous compatibility fixtures retain a direct-node link on their Popout
 * toolbar. ProfileV2 does not expose it; those flows stay on openCurrentPopout.
 * Native standalone/fullscreen regressions deliberately qualify this exact
 * advertised legacy capability instead of reintroducing a Main menu action. */
export async function openLegacyStandalone(
  page: Page,
  context: BrowserContext,
) {
  const wrapper = await openCurrentPopout(page, context);
  const link = wrapper.getByRole("link", {
    name: "Open direct node tab",
    exact: true,
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const opened = context.waitForEvent("page");
  await link.click();
  const direct = await opened;
  await expect(
    direct
      .frameLocator('iframe[title="Proxied website"]:not([hidden])')
      .locator("body"),
  ).toHaveCount(1);
  await wrapper.close();
  return direct;
}
