#!/usr/bin/env node
/** Normal old-Hub login followed by one-use automatic account carryover to the current Hub. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const out = resolve("evidence/hub-session-transfer");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  }),
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  results = [];
try {
  const discovery = await (
      await context.request.get("https://localhost:4300/__lab/discovery")
    ).json(),
    hub = discovery.hubOrigin;
  if (!/^https:\/\/[a-z0-9-]+\.atlas\.localhost:4300$/.test(hub))
    throw Error("An already-rotated local Hub is required.");
  // /signin is an ordinary SPA route; only old root/authorize transition routes redirect.
  await page.goto("https://localhost:4300/signin");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("transfer-review@atlas-lab.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const file = page.getByRole("link", { name: "Open your verification file" });
  await file.waitFor();
  const href = await file.getAttribute("href");
  if (!href?.startsWith("https://localhost:4300/__lab/verification/"))
    throw Error("External verification denied.");
  const text = await (await page.request.get(href)).text(),
    code = text.match(/Verification code: (\d{6,8})/)?.[1];
  if (!code) throw Error("Local verification code unavailable");
  await page
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const before = await (
    await page.request.get("https://localhost:4300/api/session")
  ).json();
  await page.screenshot({
    path: resolve(out, "01-old-hub-authenticated.png"),
    fullPage: true,
  });
  const transitions = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      const u = new URL(frame.url());
      if (u.protocol === "https:")
        transitions.push({ origin: u.origin, path: u.pathname });
    }
  });
  await page.goto(hub);
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .waitFor({ timeout: 45000 });
  if (new URL(page.url()).origin !== hub)
    throw Error("Did not return to the active Hub");
  const after = await (await page.request.get(hub + "/api/session")).json();
  if (
    after.user?.id !== before.user?.id ||
    after.user?.role !== before.user?.role ||
    after.user?.status !== before.user?.status ||
    !after.csrfToken ||
    after.csrfToken === before.csrfToken
  )
    throw Error("Account identity/CSRF continuity failed.");
  if (
    !transitions.some(
      (t) =>
        t.origin === "https://localhost:4300" &&
        t.path === "/hub/session-transfer/source",
    ) ||
    !transitions.some(
      (t) => t.origin === hub && t.path === "/hub/session-transfer/callback",
    )
  )
    throw Error("The trusted source/callback flow was not exercised.");
  if (page.url().includes("code="))
    throw Error("One-use code remained in the final URL");
  await page.screenshot({
    path: resolve(out, "02-new-hub-restored.png"),
    fullPage: true,
  });
  const cookies = await context.cookies(hub);
  if (cookies.some((c) => c.name === "__Host-atlas-hub-transfer"))
    throw Error("Pending transfer cookie was not cleared.");
  results.push({
    task: "Strict-cookie old-origin step and automatic one-use Hub session carryover",
    result: "PASS",
    role: after.user.role,
    status: after.user.status,
    freshCsrf: true,
    transitions,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address", { exact: true }).waitFor();
  await page.reload();
  await page.getByLabel("Email address", { exact: true }).waitFor();
  await page.waitForTimeout(2000);
  if (
    new URL(page.url()).origin !== hub ||
    (await page.getByRole("button", { name: "Sign out", exact: true }).count())
  )
    throw Error("Explicit sign-out automatically signed back in.");
  await page.screenshot({
    path: resolve(out, "03-explicit-sign-out.png"),
    fullPage: true,
  });
  results.push({
    task: "Explicit destination sign-out suppresses old-session automatic re-entry",
    result: "PASS",
  });
  await writeFile(
    resolve(out, "transfer-results.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await page
    .screenshot({ path: resolve(out, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    resolve(out, "transfer-results.json"),
    JSON.stringify({ results, error: error.message }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
