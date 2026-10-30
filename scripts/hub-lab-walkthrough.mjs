#!/usr/bin/env node
/** Real browser + real lab APIs. Synthetic local accounts only; no storage-state export. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] || "evidence/hub-lab-local");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const capture = async (page, name) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(output, name), fullPage: true });
};
const results = [];
let activePage;
let phase = "start";
try {
  const user = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await user.newPage();
  activePage = page;
  const login = async (page, email) => {
    await page.goto("https://localhost:4300");
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const file = page.getByRole("link", {
      name: "Open your verification file",
    });
    await file.waitFor();
    const href = await file.getAttribute("href");
    if (!href?.startsWith("https://localhost:4300/__lab/verification/"))
      throw Error(
        "Unexpected verification provider; refusing external sign-in.",
      );
    const text = await (await page.request.get(href)).text();
    const code = text.match(/Verification code: (\d{6,8})/)?.[1];
    if (!code) throw Error("Local verification code not found.");
    await page
      .getByRole("textbox", { name: /digit verification code/ })
      .fill(code);
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  };
  await page.goto("https://localhost:4300");
  await page.getByLabel("Email address", { exact: true }).waitFor();
  await capture(page, "01-hub-sign-in-desktop.png");
  await login(page, "student@atlas-lab.example");
  await capture(page, "02-hub-user-desktop.png");
  results.push({
    task: "Normal user sign-in via synthetic verification file",
    result: "PASS",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "03-hub-user-mobile.png");
  const atlas = await user.newPage();
  await atlas.goto("https://localhost:4280");
  await atlas.waitForTimeout(1000);
  await capture(atlas, "04-atlas-welcome.png");
  results.push({
    task: "Atlas welcome is served from a loopback HTTPS origin",
    result: "PASS",
  });
  await atlas.getByRole("button", { name: "Sign in", exact: true }).click();
  await atlas
    .getByRole("button", { name: "Sign out", exact: true })
    .waitFor({ timeout: 45000 });
  await capture(atlas, "09-atlas-profile-ready.png");
  const branchState = await (
    await atlas.request.get("https://localhost:4280/api/hub/state")
  ).json();
  if (
    !branchState.authenticated ||
    branchState.uiOnlyLab ||
    branchState.browsingAvailable !== true
  )
    throw Error("Unexpected branch session/runtime gate state.");
  results.push({
    task: "Normal Hub authorization handoff returns an authenticated branch session",
    result: "PASS; account profile and local opaque runtime initialized",
  });
  await atlas.getByRole("button", { name: "Sign out", exact: true }).click();
  await atlas
    .getByRole("heading", { name: "Welcome to Atlas", exact: true })
    .waitFor();
  await atlas.reload();
  await atlas
    .getByRole("heading", { name: "Welcome to Atlas", exact: true })
    .waitFor();
  results.push({
    task: "Branch sign-out survives reload without automatic SSO",
    result: "PASS",
  });
  const admin = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const panel = await admin.newPage();
  activePage = panel;
  panel.setDefaultTimeout(10000);
  await login(panel, "admin@atlas-lab.example");
  await panel.goto("https://localhost:4300/?admin");
  await panel
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  await panel
    .getByRole("heading", { name: "AWS accounts", exact: true })
    .waitFor();
  await capture(panel, "05-cloud-configurator-desktop.png");
  phase = "destination";
  console.log(phase);
  await panel
    .getByRole("combobox", { name: "Destination account", exact: true })
    .selectOption({ label: "New local fixture · 222222222222" });
  phase = "origin";
  console.log(phase);
  await panel
    .getByLabel("Origin hostname", { exact: true })
    .fill("vps.example.com");
  phase = "count";
  console.log(phase);
  await panel.getByLabel("Number of links", { exact: true }).fill("101");
  phase = "add";
  console.log(phase);
  await panel
    .getByRole("button", { name: "Add to operation", exact: true })
    .click();
  phase = "review";
  console.log(phase);
  const [previewResponse] = await Promise.all([
    panel.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/cloud/plans") &&
        r.request().method() === "POST",
    ),
    panel
      .getByRole("button", { name: "Review operation", exact: true })
      .click(),
  ]);
  const planned = await previewResponse.json();
  const approve = panel
    .getByRole("button", { name: "Approve configuration", exact: true })
    .first();
  await approve.waitFor();
  await capture(panel, "06-cloud-preview-101.png");
  await approve.click();
  await panel
    .locator(".cloud-job-" + planned.id)
    .getByText("Complete", { exact: true })
    .waitFor({ timeout: 30000 });
  await capture(panel, "07-cloud-activated-101.png");
  results.push({
    task: "UI preview, approval and local activation of 101 simulated CloudFront endpoints",
    result: "PASS; local simulated routing activated, no real AWS",
  });
  const mobile = await admin.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto("https://localhost:4300/?admin");
  await mobile.getByRole("button", { name: "Menu", exact: true }).click();
  await mobile
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  await mobile
    .getByRole("heading", { name: "AWS accounts", exact: true })
    .waitFor();
  await capture(mobile, "08-cloud-configurator-mobile.png");
  const widths = await mobile.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  results.push({
    task: "Mobile configurator has no horizontal document overflow",
    result: widths.document <= widths.viewport ? "PASS" : "FAIL",
    widths,
  });
  await writeFile(
    resolve(output, "walkthrough-results.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  if (activePage)
    await activePage.screenshot({
      path: resolve(output, "failure-" + phase + ".png"),
      fullPage: true,
    });
  throw error;
} finally {
  await browser.close();
}
