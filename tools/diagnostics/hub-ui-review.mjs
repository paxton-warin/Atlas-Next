#!/usr/bin/env node
/** Independent task-led local UX review. No hidden application-state mutation. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const out = resolve("evidence/hub-ui-review");
await mkdir(out, { recursive: true });
const context = await chromium.launchPersistentContext(
    "/tmp/atlas-hub-ux-review-501",
    {
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    },
  ),
  results = [],
  errors = [];
context.on("page", (p) =>
  p.on("pageerror", (e) =>
    errors.push(e.message.replace(/https?:\/\/\S+/g, "[URL]")),
  ),
);
const page = await context.newPage();
let activePage = page;
async function shot(p, name) {
  await p.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  await p.screenshot({ path: resolve(out, name), fullPage: true });
}
let phase = "hub-sign-in";
try {
  await page.goto("https://localhost:4300");
  if (await page.getByLabel("Email address", { exact: true }).count()) {
    await page
      .getByLabel("Email address", { exact: true })
      .fill("ux-review@atlas-lab.example");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const file = page.getByRole("link", {
      name: "Open your verification file",
    });
    await file.waitFor();
    const href = await file.getAttribute("href");
    if (!href?.startsWith("https://localhost:4300/__lab/verification/"))
      throw Error("External provider denied");
    const text = await (await page.request.get(href)).text(),
      code = text.match(/Verification code: (\d{6,8})/)?.[1];
    if (!code) throw Error("No local code");
    await page
      .getByRole("textbox", { name: /digit verification code/ })
      .fill(code);
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  }
  await shot(page, "01-hub-user-desktop.png");
  console.log("HUB_BODY", await page.locator("body").innerText());
  console.log(
    "HUB_LINKS",
    await page
      .getByRole("link")
      .evaluateAll((es) =>
        es.map((e) => ({ text: e.textContent, url: e.getAttribute("href") })),
      ),
  );
  results.push({ task: "Sign in normally", result: "PASS" });
  phase = "open-atlas";
  if (await page.getByRole("button", { name: "Get Link", exact: true }).count())
    await page.getByRole("button", { name: "Get Link", exact: true }).click();
  await page.waitForTimeout(500);
  await shot(page, "02-hub-assigned-link.png");
  console.log("ASSIGNED_BODY", await page.locator("body").innerText());
  const links = await page
    .getByRole("link")
    .evaluateAll((es) => es.map((e) => ({ text: e.textContent, url: e.href })));
  console.log("ASSIGNED_LINKS", links);
  const link = links.find((l) => new URL(l.url).port === "4280");
  if (!link) throw Error("No visible Atlas link after allocation");
  const atlas = await context.newPage();
  activePage = atlas;
  await atlas.goto(link.url);
  await atlas
    .getByRole("button", { name: "Sign in", exact: true })
    .or(atlas.getByRole("button", { name: "New tab", exact: true }))
    .or(atlas.getByRole("button", { name: "Use defaults", exact: true }))
    .first()
    .waitFor({ timeout: 45000 });
  if (await atlas.getByRole("button", { name: "Sign in", exact: true }).count())
    await atlas.getByRole("button", { name: "Sign in", exact: true }).click();
  await atlas
    .getByRole("button", { name: "Use defaults", exact: true })
    .or(atlas.getByRole("button", { name: "New tab", exact: true }))
    .first()
    .waitFor({ timeout: 45000 });
  if (
    await atlas
      .getByRole("button", { name: "Use defaults", exact: true })
      .count()
  )
    await atlas
      .getByRole("button", { name: "Use defaults", exact: true })
      .click();
  await shot(atlas, "03-atlas-desktop.png");
  console.log("ATLAS_BODY", await atlas.locator("body").innerText());
  console.log(
    "ATLAS_ARIA",
    (await atlas.locator("body").ariaSnapshot()).replace(
      /session=[^ \n]+/g,
      "session=[redacted]",
    ),
  );
  results.push({ task: "Open allocated Atlas link", result: "PASS" });
  phase = "search-and-tabs";
  const search = atlas.getByRole("combobox", {
    name: "Search the web",
    exact: true,
  });
  await search.fill("http://fixture.localhost:4299/storage");
  await search.press("Enter");
  const fixture = atlas.frameLocator('iframe[title="Website"]').first();
  await fixture
    .getByRole("heading", { name: "Local storage fixture", exact: true })
    .waitFor({ timeout: 45000 });
  await fixture.getByLabel("Draft", { exact: true }).fill("UX review draft");
  await fixture.getByRole("button", { name: /Count:/ }).click();
  await fixture
    .getByRole("button", { name: "Save count", exact: true })
    .click();
  await fixture.locator("#saved").filter({ hasText: /Saved/ }).waitFor();
  await shot(atlas, "04-storage-desktop.png");
  results.push({
    task: "Search field opens the deterministic storage page and explicit save works",
    result: "PASS",
  });
  for (let i = 2; i <= 3; i++) {
    await atlas.getByRole("button", { name: "New tab", exact: true }).click();
    const input = atlas.getByRole("combobox", {
      name: "Search the web",
      exact: true,
    });
    await input.fill("http://fixture.localhost:4299/storage?tab=" + i);
    await input.press("Enter");
    await atlas
      .getByRole("tab")
      .nth(i - 1)
      .waitFor();
  }
  console.log(
    "TABS_ARIA",
    (await atlas.locator("body").ariaSnapshot()).replace(
      /session=[^ \n]+/g,
      "session=[redacted]",
    ),
  );
  await shot(atlas, "05-three-tabs-desktop.png");
  results.push({ task: "Open and identify three tabs", result: "PASS" });
  await atlas.getByRole("tab").first().click();
  await atlas
    .frameLocator('iframe[title="Website"]')
    .first()
    .getByLabel("Draft", { exact: true })
    .fill("Keep this draft while moving tabs");
  await atlas
    .getByRole("button", { name: /^Tab actions for/ })
    .first()
    .click();
  await shot(atlas, "06-tab-actions.png");
  await atlas.getByRole("menuitem", { name: "Pin tab", exact: true }).click();
  await atlas
    .getByRole("button", { name: /^Tab actions for/ })
    .first()
    .click();
  await atlas.getByRole("menuitem", { name: "Unpin tab", exact: true }).click();
  await atlas
    .getByRole("button", { name: /^Tab actions for/ })
    .first()
    .click();
  await atlas.getByRole("menuitem", { name: "Move down", exact: true }).click();
  const preserved = await atlas
    .frameLocator('iframe[title="Website"]')
    .first()
    .getByLabel("Draft", { exact: true })
    .inputValue();
  if (preserved !== "Keep this draft while moving tabs")
    throw Error("Tab movement lost draft");
  results.push({
    task: "Pin/unpin and reorder through tab menu without losing draft",
    result: "PASS",
  });
  await atlas
    .getByRole("button", { name: "Search open tabs", exact: true })
    .click();
  await atlas.getByRole("textbox").fill("fixture");
  await shot(atlas, "07-tab-search.png");
  await atlas.keyboard.press("Escape");
  const beforeClose = await atlas.getByRole("tab").count();
  await atlas
    .getByRole("tab", { selected: true })
    .locator("..")
    .getByRole("button", { name: /^Tab actions for/ })
    .click();
  await atlas.getByRole("menuitem", { name: "Close tab", exact: true }).click();
  if ((await atlas.getByRole("tab").count()) !== beforeClose - 1)
    throw Error("Close tab count mismatch");
  await atlas
    .getByRole("button", { name: "Reopen closed tab", exact: true })
    .click();
  if ((await atlas.getByRole("tab").count()) !== beforeClose)
    throw Error("Undo tab count mismatch");
  results.push({ task: "Search, close and undo a tab", result: "PASS" });
  await atlas.getByRole("button", { name: "Support", exact: true }).click();
  await shot(atlas, "08-support.png");
  console.log(
    "SUPPORT_ARIA",
    (await atlas.locator("body").ariaSnapshot()).replace(
      /session=[^ \n]+/g,
      "session=[redacted]",
    ),
  );
  if (
    await atlas
      .getByRole("button", { name: "Close support", exact: true })
      .count()
  )
    await atlas
      .getByRole("button", { name: "Close support", exact: true })
      .click();
  await atlas.getByRole("button", { name: "Your saves", exact: true }).click();
  await shot(atlas, "09-your-saves.png");
  console.log(
    "SAVES_ARIA",
    (await atlas.locator("body").ariaSnapshot()).replace(
      /session=[^ \n]+/g,
      "session=[redacted]",
    ),
  );
  results.push({ task: "Find unified Support and Your saves", result: "PASS" });
  await atlas.keyboard.press("Escape");
  phase = "responsive-matrix";
  for (const [name, width, height] of [
    ["10-desktop-1440", 1440, 1000],
    ["11-laptop-1366", 1366, 768],
    ["12-tablet-768", 768, 1024],
    ["13-mobile-390", 390, 844],
    ["14-minimum-320", 320, 844],
  ]) {
    await atlas.setViewportSize({ width, height });
    await atlas.waitForTimeout(250);
    await shot(atlas, name + ".png");
    if (width === 390) {
      const tabsButton = atlas.getByRole("button", { name: /tabs/i }).first();
      await tabsButton.click();
      await atlas
        .getByRole("button", { name: "New tab", exact: true })
        .waitFor();
      await shot(atlas, "13a-mobile-tab-drawer.png");
      await atlas.keyboard.press("Escape");
      await atlas.getByRole("button", { name: "Menu", exact: true }).click();
      await shot(atlas, "13b-mobile-navigation.png");
      await atlas.keyboard.press("Escape");
      results.push({
        task: "Mobile tab drawer and Menu controls",
        result: "PASS",
      });
    }
    const dimensions = await atlas.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    const clipped = [],
      boxes = [];
    for (const button of await atlas
      .getByRole("banner")
      .first()
      .getByRole("button")
      .all()) {
      if (!(await button.isVisible())) continue;
      const rect = await button.boundingBox(),
        label =
          (await button.getAttribute("aria-label")) ||
          (await button.innerText());
      if (rect) {
        boxes.push({ ...rect, label });
        if (rect.x < 0 || rect.x + rect.width > width + 1) clipped.push(label);
      }
    }
    const overlaps = [];
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const x =
            Math.min(boxes[a].x + boxes[a].width, boxes[b].x + boxes[b].width) -
            Math.max(boxes[a].x, boxes[b].x),
          y =
            Math.min(
              boxes[a].y + boxes[a].height,
              boxes[b].y + boxes[b].height,
            ) - Math.max(boxes[a].y, boxes[b].y);
        if (x > 2 && y > 2) overlaps.push([boxes[a].label, boxes[b].label]);
      }
    results.push({
      task: name,
      result:
        dimensions.document <= width && !clipped.length && !overlaps.length
          ? "PASS"
          : "FINDING",
      ...dimensions,
      clipped,
      overlaps,
    });
  }
  await atlas.setViewportSize({ width: 1366, height: 768 });
  await atlas.evaluate(() => {
    const elements = [...document.body.querySelectorAll("*")];
    window.__uxReviewFontSizes = elements.map((element) => [
      element,
      element.style.fontSize,
    ]);
    const sizes = elements.map(
      (element) => parseFloat(getComputedStyle(element).fontSize) * 2,
    );
    elements.forEach(
      (element, i) => (element.style.fontSize = sizes[i] + "px"),
    );
  });
  await shot(atlas, "15-text-200-percent.png");
  const scaled = await atlas.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  results.push({
    task: "200 percent text sizing",
    result: scaled.document <= scaled.viewport ? "PASS" : "FINDING",
    ...scaled,
  });
  await atlas.evaluate(() => {
    for (const [element, size] of window.__uxReviewFontSizes || [])
      element.style.fontSize = size;
    delete window.__uxReviewFontSizes;
  });
  await atlas.setViewportSize({ width: 390, height: 844 });
  await atlas.emulateMedia({ reducedMotion: "reduce" });
  await shot(atlas, "16-reduced-motion-mobile.png");
  results.push({ task: "Reduced-motion mobile rendering", result: "CAPTURED" });
  await atlas.setViewportSize({ width: 1440, height: 1000 });
  await atlas
    .getByRole("button", { name: "Toggle color mode", exact: true })
    .click();
  await shot(atlas, "17-light-theme.png");
  await atlas
    .getByRole("button", { name: "Toggle color mode", exact: true })
    .click();
  phase = "sign-out";
  await atlas.getByRole("button", { name: "Your saves", exact: true }).click();
  await atlas.getByRole("button", { name: "Sign out", exact: true }).click();
  await atlas
    .getByRole("heading", { name: "Welcome to Atlas", exact: true })
    .waitFor({ timeout: 45000 });
  await atlas.reload();
  await atlas
    .getByRole("heading", { name: "Welcome to Atlas", exact: true })
    .waitFor();
  await shot(atlas, "18-signed-out.png");
  results.push({
    task: "Sign out and reload without automatic sign-in",
    result: "PASS",
  });

  await writeFile(
    resolve(out, "review-results.json"),
    JSON.stringify({ phase, results, errors }, null, 2),
  );
  console.log(JSON.stringify({ phase, results, errors }, null, 2));
} catch (e) {
  await shot(activePage, "failure-" + phase + ".png").catch(() => {});
  await writeFile(
    resolve(out, "review-results.json"),
    JSON.stringify({ phase, results, errors, error: e.message }, null, 2),
  );
  console.log("FAIL", phase, e.message);
  console.log(await activePage.locator("body").innerText());
  throw e;
} finally {
  await context.close();
}
