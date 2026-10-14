import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { auditSurfaces } from "../scripts/fingerprint-audit.mjs";
async function capture(page: Page, phase: string) {
  const surfaces: any[] = [];
  let index = 0;
  for (const frame of page.frames()) {
    const values = await frame.evaluate(() => {
      const attributes: string[] = [];
      for (const element of [...document.querySelectorAll("*")].slice(0, 512))
        for (const attribute of element.attributes) {
          let value = attribute.value || "";
          if (["src", "href", "action"].includes(attribute.name)) {
            try {
              const url = new URL(value, location.href);
              value = url.origin + url.pathname;
            } catch {
              value = "non-http resource";
            }
          }
          if (attribute.name.toLowerCase().includes("ticket")) continue;
          attributes.push(attribute.name + "=" + value.slice(0, 512));
        }
      const paths = performance
        .getEntriesByType("resource")
        .slice(-128)
        .map((entry) => {
          try {
            const u = new URL(entry.name);
            return u.origin + u.pathname;
          } catch {
            return "non-http resource";
          }
        });
      return {
        "document-text": (document.body?.innerText || "").slice(0, 32000),
        "dom-attributes": attributes.join("\n"),
        "global-names": [
          ...Object.getOwnPropertyNames(window),
          ...Object.getOwnPropertySymbols(window).map(String),
        ].join("\n"),
        "constructor-name": Uint32Array.name,
        "script-text": [...document.scripts]
          .map((script) => script.textContent || "")
          .join("\n")
          .slice(0, 256000),
        "resource-path": paths.join("\n"),
      };
    });
    for (const [surface, text] of Object.entries(values))
      surfaces.push({ file: phase + "/frame-" + index, surface, text });
    index++;
  }
  return auditSurfaces(surfaces);
}
test("all 345 patterns inspect real dynamic documents, with content and utility negative controls", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site.getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  const before = await capture(page, "default-off");
  await page
    .getByRole("button", { name: "Page compatibility", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Adjust site metadata for this origin" })
    .check();
  await expect
    .poll(() => site.locator("body").evaluate(() => document.title))
    .toBe("Website");
  await site.getByRole("button", { name: "Change metadata" }).click();
  await site.locator("body").evaluate(() => {
    const frame = document.createElement("iframe");
    frame.title = "Audit nested frame";
    frame.src = "/compatibility-renderer";
    document.body.append(frame);
    history.pushState(null, "", "?soft=1");
  });
  await expect(
    site.frameLocator('iframe[title="Audit nested frame"]').locator("#reply"),
  ).toHaveText("stream complete");
  const after = await capture(page, "spa-and-nested");
  await site.locator("body").evaluate(() => {
    document.body.dataset.functional = "$scramjet";
    const span = document.createElement("span");
    span.textContent = "Uint32Array";
    document.body.append(span);
  });
  const negative = await capture(page, "site-owned-controls");
  for (const report of [before, after, negative]) {
    expect(report.inventory).toBe(345);
    expect(report.rules.filter((r: any) => r.status !== "scanned")).toEqual([]);
  }
  expect(after.rules.find((r: any) => r.id === "C255").hits).toEqual([]);
  expect(
    negative.rules
      .find((r: any) => r.id === "C012")
      .hits.some((hit: any) => hit.surface === "dom-attributes"),
  ).toBe(true);
  expect(
    negative.rules.find((r: any) => r.id === "C001").hits.length,
  ).toBeGreaterThan(0);
  await expect(site.locator("body")).toHaveAttribute(
    "data-functional",
    "$scramjet",
  );
  await expect(
    site.getByText("Game controls and gameplay instructions stay visible."),
  ).toBeVisible();
  mkdirSync("evidence/goal-compatibility-20261013", { recursive: true });
  writeFileSync(
    "evidence/goal-compatibility-20261013/dynamic-audit.json",
    JSON.stringify(
      {
        method:
          "actual fixture DOM/attributes/global names/scripts/resource paths; not installed-filter qualification",
        snapshots: { before, after, negative },
      },
      null,
      2,
    ),
  );
});
