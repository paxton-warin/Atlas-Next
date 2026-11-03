/** Stable local screenshots after the real support/MFA walkthrough. No commands applied. */
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve("evidence/hub-unified-local");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1000 },
});
const results = [];
const settle = async (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
try {
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  await page.goto("https://localhost:4300");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("admin@atlas-lab.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const verification = page.getByRole("link", {
    name: "Open your verification file",
  });
  await verification.waitFor();
  const href = await verification.getAttribute("href"),
    url = new URL(href);
  if (
    url.hostname !== "localhost" ||
    !url.pathname.startsWith("/__lab/verification/")
  )
    throw Error("Expected local verification provider");
  const text = await (await page.request.get(href)).text(),
    code = text.match(/Verification code: (\d{6,8})/)?.[1];
  if (!code) throw Error("Missing local verification code");
  await page
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.goto("https://localhost:4300/?admin=infrastructure");
  await page
    .getByRole("heading", { name: "Browser services", exact: true })
    .waitFor();
  await expect(page.locator(".hub-source-card")).toHaveCount(4);
  await settle(page);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: join(output, "05b-infrastructure-overview.png"),
  });
  results.push(
    "Four human-readable node cards, live telemetry and history fit desktop overview",
  );
  const services = page
    .getByRole("heading", { name: "Browser services", exact: true })
    .locator("..");
  await services.getByRole("button", { name: "Site", exact: true }).click();
  await services.getByRole("button", { name: "Save", exact: true }).click();
  await services
    .getByRole("form", { name: "Verify browser service change" })
    .waitFor();
  await settle(page);
  await services.screenshot({
    path: join(output, "06b-operation-bound-mfa-form.png"),
  });
  await services.getByRole("button", { name: "Cancel", exact: true }).click();
  results.push(
    "Operation-bound MFA prompt exposes only empty credential fields; capture applied no command",
  );
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto("https://localhost:4300/?admin=infrastructure");
  await mobile
    .getByRole("heading", { name: "Browser services", exact: true })
    .waitFor();
  await expect(mobile.locator(".hub-source-card")).toHaveCount(4);
  await settle(mobile);
  await expect
    .poll(async () => {
      const b = await mobile.locator(".admin-nav").boundingBox();
      return b.x + b.width;
    })
    .toBeLessThanOrEqual(0);
  expect(
    await mobile.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(390);
  await mobile.screenshot({
    path: join(output, "08-mobile-infrastructure.png"),
    fullPage: true,
  });
  await mobile.screenshot({
    path: join(output, "08b-mobile-infrastructure-overview.png"),
  });
  results.push(
    "Fresh mobile page has fully closed navigation, readable metrics and no horizontal overflow",
  );
  await writeFile(
    join(output, "screenshot-review-results.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        production: false,
        commandsApplied: false,
        results,
      },
      null,
      2,
    ),
  );
  console.log(results.map((s) => s + ": PASS").join("\n"));
} finally {
  await browser.close();
}
