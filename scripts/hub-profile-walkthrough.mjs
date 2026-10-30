import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve("evidence/hub-profile-local");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(
    "/tmp/atlas-hub-profile-browser-501",
    {
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    },
  ),
  page = await context.newPage();
const browser = { close: () => context.close() };
const events = [];
page.on("pageerror", (e) =>
  events.push({ type: "pageerror", message: e.message }),
);
page.on("console", (m) => {
  if (m.type() === "error")
    events.push({
      type: "console",
      message: m.text().replace(/#ticket=[^ ]+/g, "#ticket=[redacted]"),
    });
});
let phase = "login";
try {
  await page.goto("https://localhost:4300");
  if (await page.getByLabel("Email address", { exact: true }).count()) {
    await page
      .getByLabel("Email address", { exact: true })
      .fill("student@atlas-lab.example");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const link = page.getByRole("link", {
      name: "Open your verification file",
    });
    await link.waitFor();
    const href = await link.getAttribute("href");
    if (!href.startsWith("https://localhost:4300/__lab/verification/"))
      throw Error("Nonlocal verification provider");
    const text = await (await page.request.get(href)).text(),
      code = text.match(/Verification code: (\d{6,8})/)?.[1];
    await page
      .getByRole("textbox", { name: /digit verification code/ })
      .fill(code);
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  }
  phase = "branch";
  await page.goto("https://localhost:4280");
  await page.waitForTimeout(700);
  if (
    await page.getByRole("button", { name: "Sign in", exact: true }).count()
  ) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("https://localhost:4280/**");
  }
  await page.waitForTimeout(4500);
  await page.screenshot({
    path: resolve(output, "01-profile-browser.png"),
    fullPage: true,
  });
  console.log("BRANCH_BODY", await page.locator("body").innerText());
  if (
    await page
      .getByRole("button", { name: "Use defaults", exact: true })
      .count()
  )
    await page
      .getByRole("button", { name: "Use defaults", exact: true })
      .click();
  phase = "fixture";
  const search = page.getByRole("textbox", { name: /Search or enter/ }).first();
  console.log(
    "TEXTBOXES",
    await page
      .getByRole("textbox")
      .evaluateAll((es) =>
        es.map((e) => ({
          label: e.getAttribute("aria-label"),
          placeholder: e.getAttribute("placeholder"),
        })),
      ),
  );
  if (await search.count()) {
    await search.fill("http://fixture.localhost:4299/storage");
    await search.press("Enter");
  } else {
    const input = page.locator("input[placeholder]").first();
    await input.fill("http://fixture.localhost:4299/storage");
    await input.press("Enter");
  }
  await page
    .frameLocator('iframe[title="Website"]')
    .getByRole("button", { name: /Count:/ })
    .waitFor({ timeout: 40000 });
  const fixture = page.frameLocator('iframe[title="Website"]');
  await fixture.getByRole("button", { name: /Count:/ }).click();
  await fixture
    .getByRole("button", { name: "Save count", exact: true })
    .click();
  await fixture
    .locator("#saved")
    .filter({ hasText: /Saved [0-9]+/ })
    .waitFor();
  const saved = await fixture.locator("#saved").innerText();
  console.log("SAVE_RECEIPT", saved);
  await page
    .getByRole("status")
    .filter({ hasText: "Synced" })
    .first()
    .waitFor({ timeout: 35000 });
  phase = "reload";
  await page.reload();
  await page
    .frameLocator('iframe[title="Website"]')
    .getByRole("button", { name: /Count:/ })
    .waitFor({ timeout: 40000 });
  console.log(
    "RELOADED_COUNT",
    await page
      .frameLocator('iframe[title="Website"]')
      .locator("#count")
      .innerText(),
  );
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: resolve(output, "02-native-fixture.png"),
    fullPage: true,
  });
  console.log("FINAL_BODY", await page.locator("body").innerText());
  console.log(
    "FRAMES",
    page.frames().map((f) => f.url()),
  );
  await writeFile(
    resolve(output, "probe.json"),
    JSON.stringify(
      {
        phase,
        events,
        frames: page.frames().map((f) => f.url()),
        body: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ phase, events }));
} catch (e) {
  await page
    .screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error("FAILED_PHASE", phase, e.message);
  console.log(await page.locator("body").innerText());
  console.log(JSON.stringify(events));
  process.exitCode = 1;
} finally {
  await browser.close();
}
