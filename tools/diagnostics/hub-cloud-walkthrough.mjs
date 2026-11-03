#!/usr/bin/env node
/** Real panel/queue against the explicitly local simulator. Does not replace existing endpoints. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const origin = "https://localhost:4300",
  output = resolve(
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
      "evidence/hub-cloud-local",
  ),
  captureOnly = process.argv.includes("--capture-only");
if (process.env.NODE_ENV === "production")
  throw Error("Local walkthrough only.");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  results = [];
page.setDefaultTimeout(15000);
const shot = async (name) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: resolve(output, name), fullPage: true });
};
async function login() {
  await page.goto(origin);
  await page
    .getByLabel("Email address", { exact: true })
    .fill("admin@atlas-lab.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const link = page.getByRole("link", { name: "Open your verification file" });
  await link.waitFor();
  const href = await link.getAttribute("href");
  if (!href?.startsWith(origin + "/__lab/verification/"))
    throw Error("External verification provider denied.");
  const body = await (await page.request.get(href)).text(),
    code = body.match(/Verification code: (\d{6,8})/)?.[1];
  if (!code) throw Error("Local verification code unavailable.");
  await page
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.goto(origin + "/?admin");
  await page
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "AWS accounts", exact: true })
    .waitFor();
  const provider = await (
    await page.request.get(origin + "/api/admin/cloud/accounts")
  ).json();
  if (provider.provider !== "local_simulator" || !provider.simulationActivation)
    throw Error("Explicit local activation simulator required.");
}
async function create() {
  await page
    .getByRole("combobox", { name: "Destination account", exact: true })
    .selectOption({ label: "New local fixture · 222222222222" });
  await page
    .getByLabel("Origin hostname", { exact: true })
    .fill("atlas.lab.example");
  await page.getByLabel("Number of links", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Add to operation", exact: true })
    .click();
  const [r] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/cloud/plans") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Review operation", exact: true }).click(),
  ]);
  if (!r.ok()) throw Error("Preview failed");
  const job = await r.json();
  const card = page.locator(".cloud-job-" + job.id);
  await card
    .getByRole("button", { name: "Approve configuration", exact: true })
    .click();
  return { card, id: job.id };
}
try {
  await login();
  const baseline = await (
    await page.request.get(origin + "/api/admin/cloud/endpoints")
  ).json();
  const protectedEndpoints = baseline.endpoints
    .filter((e) => e.state === "active")
    .map((e) => ({ id: e.id, url: e.url, revision: e.revision }));
  await page.getByText("Local failure testing", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Failure account", exact: true })
    .selectOption({ label: "New local fixture" });
  for (const scenario of captureOnly
    ? []
    : [
        "expired",
        "wrong_account",
        "throttled",
        "lost_ack",
        "revision",
        "deployment_delay",
      ]) {
    await page
      .getByRole("combobox", { name: "Simulate", exact: true })
      .selectOption(scenario);
    await page
      .getByRole("button", { name: "Apply local scenario", exact: true })
      .click();
    await page
      .getByText(
        "The next matching simulator request will use this scenario.",
        { exact: true },
      )
      .waitFor();
    const { card, id } = await create();
    const state =
      scenario === "expired"
        ? "Sign-in required"
        : ["wrong_account", "revision"].includes(scenario)
          ? "Needs attention"
          : "Waiting for AWS";
    await card.getByText(state, { exact: true }).waitFor({ timeout: 20000 });
    if (scenario === "expired" || scenario === "wrong_account") {
      const account = page
        .locator(".cloud-config__account")
        .filter({ hasText: "New local fixture" });
      await account
        .getByRole("button", { name: "Sign in again", exact: true })
        .click();
      await account
        .getByText(/Verifying account|Waiting for configurator worker/)
        .waitFor();
      await account
        .getByRole("button", { name: "Sign in again", exact: true })
        .waitFor({ state: "visible" });
      await page.waitForFunction(
        async () => {
          const r = await fetch("/api/admin/cloud/accounts"),
            a = await r.json();
          return !a.logins.some((l) =>
            ["queued", "waiting_code", "code_submitted"].includes(l.status),
          );
        },
        {},
        { timeout: 20000 },
      );
    }
    if (scenario === "expired") await shot("01-expired-sign-in.png");
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await card
      .getByText("Complete", { exact: true })
      .waitFor({ timeout: 45000 });
    results.push({ scenario, jobId: id, result: "PASS", observedState: state });
  }
  const after = await (
    await page.request.get(origin + "/api/admin/cloud/endpoints")
  ).json();
  for (const before of protectedEndpoints) {
    const value = after.endpoints.find((e) => e.id === before.id);
    if (
      !value ||
      value.url !== before.url ||
      value.revision !== before.revision ||
      value.state !== "active"
    )
      throw Error(
        "Existing endpoint changed during create-only fault walkthrough.",
      );
  }
  if (!captureOnly) await shot("02-failure-recovery-complete.png");
  await page
    .locator(".cloud-config .card")
    .first()
    .screenshot({ path: resolve(output, "04-account-controls-desktop.png") });
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(origin + "/?admin");
  await mobile.getByRole("button", { name: "Menu", exact: true }).click();
  await mobile
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  await mobile
    .getByRole("heading", { name: "AWS accounts", exact: true })
    .waitFor();
  await mobile.getByText("Local failure testing", { exact: true }).click();
  await mobile.screenshot({
    path: resolve(output, "03-failure-controls-mobile.png"),
    fullPage: true,
  });
  await mobile
    .locator(".cloud-config .card")
    .first()
    .screenshot({ path: resolve(output, "05-account-controls-mobile.png") });
  await mobile
    .locator(".cloud-config .card")
    .filter({ has: mobile.getByText("Local failure testing", { exact: true }) })
    .screenshot({
      path: resolve(output, "06-failure-controls-mobile-detail.png"),
    });
  const width = await mobile.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  if (width.document > width.viewport)
    throw Error("Mobile document overflows.");
  results.push(
    {
      task: "Existing active endpoints unchanged",
      result: "PASS",
      count: protectedEndpoints.length,
    },
    { task: "Mobile panel width", result: "PASS", ...width },
  );
  await writeFile(
    resolve(
      output,
      captureOnly ? "capture-results.json" : "cloud-results.json",
    ),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await shot("failure.png").catch(() => {});
  await writeFile(
    resolve(
      output,
      captureOnly ? "capture-results.json" : "cloud-results.json",
    ),
    JSON.stringify({ results, error: error.message }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
