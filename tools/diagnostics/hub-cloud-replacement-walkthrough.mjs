#!/usr/bin/env node
/** Explicit local-only reviewed frontend/Hub/node replacement. Run only after profile sync proof. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
if (
  process.env.NODE_ENV === "production" ||
  !process.argv.includes("--execute-local-replacements")
)
  throw Error(
    "Pass --execute-local-replacements after the local profile walkthrough; this changes local endpoint routing.",
  );
const hub = "https://localhost:4300",
  out = resolve("evidence/hub-cloud-replacement");
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
let observerContext, observer;
try {
  if (process.argv.includes("--observe-profile-browser")) {
    observerContext = await chromium.launchPersistentContext(
      "/tmp/atlas-hub-profile-browser-501",
      {
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      },
    );
    observer = await observerContext.newPage();
    await observer.goto("https://localhost:4280");
    await observer
      .getByRole("button", { name: "Your saves", exact: true })
      .waitFor({ timeout: 45000 });
    await observer
      .getByRole("status")
      .filter({ hasText: "Synced" })
      .first()
      .waitFor({ timeout: 45000 });
    await observer.screenshot({
      path: resolve(out, "00-old-frontend-synced.png"),
      fullPage: true,
    });
  }

  await page.goto(hub);
  await page
    .getByLabel("Email address", { exact: true })
    .fill("admin@atlas-lab.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const file = page.getByRole("link", { name: "Open your verification file" });
  await file.waitFor();
  const href = await file.getAttribute("href");
  if (!href?.startsWith(hub + "/__lab/verification/"))
    throw Error("External verification denied");
  const text = await (await page.request.get(href)).text(),
    code = text.match(/Verification code: (\d{6,8})/)?.[1];
  if (!code) throw Error("Local verification code missing");
  await page
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.goto(hub + "/?admin");
  await page
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "AWS accounts", exact: true })
    .waitFor();
  const mode = await (
    await page.request.get(hub + "/api/admin/cloud/accounts")
  ).json();
  if (mode.provider !== "local_simulator" || !mode.simulationActivation)
    throw Error("Complete local simulator required");
  const before = await (
    await page.request.get(hub + "/api/admin/cloud/endpoints")
  ).json();
  const targets = [
    "https://localhost:4280",
    "https://localhost:4300",
    "https://127.0.0.1:4282",
  ].map((url) =>
    before.endpoints.find((e) => e.url === url && e.state === "active"),
  );
  if (targets.some((v) => !v))
    throw Error(
      "Original local endpoints are no longer active; inspect before another replacement.",
    );
  await page
    .getByRole("combobox", { name: "Destination account", exact: true })
    .selectOption({ label: "New local fixture · 222222222222" });
  for (const e of targets)
    await page
      .locator(".cloud-config__endpoint")
      .filter({ has: page.getByText(e.url, { exact: true }) })
      .getByRole("checkbox")
      .check();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/cloud/plans") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Review operation", exact: true }).click(),
  ]);
  if (!response.ok()) throw Error("Preview failed");
  const planned = await response.json();
  if (planned.plan.resources.length !== 3)
    throw Error("Expected exactly three replacements");
  const job = page.locator(".cloud-job-" + planned.id);
  await job.screenshot({ path: resolve(out, "01-reviewed-operation.png") });
  await job
    .getByRole("button", { name: "Approve configuration", exact: true })
    .click();
  await job.getByText("Complete", { exact: true }).waitFor({ timeout: 60000 });
  await job.screenshot({ path: resolve(out, "02-complete-operation.png") });
  const after = await (
      await page.request.get(hub + "/api/admin/cloud/endpoints")
    ).json(),
    replacements = [];
  for (const old of targets) {
    const retired = after.endpoints.find((e) => e.id === old.id),
      next = after.endpoints.find(
        (e) =>
          e.role === old.role &&
          e.logicalId === old.logicalId &&
          e.state === "active",
      );
    if (
      retired?.state !== "transition" ||
      !next ||
      next.id === old.id ||
      next.revision !== old.revision + 1 ||
      next.linkId !== old.linkId
    )
      throw Error("Logical identity/revision transition mismatch");
    replacements.push({
      role: old.role,
      logicalId: old.logicalId,
      previous: old.url,
      current: next.url,
      revision: next.revision,
    });
  }
  for (const old of before.endpoints.filter(
    (e) => e.state === "active" && !targets.some((t) => t.id === e.id),
  )) {
    const next = after.endpoints.find((e) => e.id === old.id);
    if (
      !next ||
      next.state !== old.state ||
      next.url !== old.url ||
      next.revision !== old.revision
    )
      throw Error("Untargeted peer endpoint changed");
  }
  const frontend = replacements.find((r) => r.role === "frontend"),
    newHub = replacements.find((r) => r.role === "hub"),
    node = replacements.find((r) => r.role === "node");
  const oldState = await (
    await context.request.get(frontend.previous + "/api/hub/state")
  ).json();
  if (
    oldState.endpointTransition?.hubOrigin !== newHub.current ||
    oldState.endpointTransition?.destination !== frontend.current
  )
    throw Error("Old frontend transition state missing");
  const discovery = await (
    await context.request.get(frontend.current + "/__lab/discovery")
  ).json();
  if (discovery.hubOrigin !== newHub.current)
    throw Error("Current Hub discovery not updated");
  const oldHub = await context.request.get(newHub.previous + "/", {
    maxRedirects: 0,
  });
  if (
    oldHub.status() !== 302 ||
    new URL(oldHub.headers().location).origin !== newHub.current
  )
    throw Error("Old Hub did not route to current Hub");
  for (const endpoint of [node.previous, node.current])
    for (const path of [
      "/node/health",
      "/relay/invalid/",
      "/browse/resource/invalid",
    ]) {
      const response = await context.request.get(endpoint + path, {
        maxRedirects: 0,
      });
      if (
        (response.status() >= 300 && response.status() < 400) ||
        response.headers().location ||
        response.headers()["content-type"]?.includes("text/html")
      )
        throw Error("Node traffic redirected to an HTML Hub page");
    }
  if (observer) {
    await observer.waitForURL((url) => url.origin === newHub.current, {
      timeout: 45000,
    });
    await observer.screenshot({
      path: resolve(out, "03-old-browser-returned-hub.png"),
      fullPage: true,
    });
    results.push({
      task: "Live old frontend quiesces and acknowledges profile sync before returning to Hub",
      result: "PASS",
      hubOrigin: newHub.current,
      requiresHubSignIn:
        (await observer.getByLabel("Email address", { exact: true }).count()) >
        0,
    });
  }
  results.push(
    {
      task: "Reviewed three-endpoint simulation activation",
      result: "PASS",
      jobId: planned.id,
      replacements,
    },
    {
      task: "Untargeted active peers preserve endpoint identity and revision",
      result: "PASS",
      count: before.endpoints.filter((e) => e.state === "active").length - 3,
    },
    {
      task: "Old frontend advertises sync/handoff and new frontend discovers current Hub",
      result: "PASS",
    },
    {
      task: "Hub redirect never applies to node APIs/resources/relay requests",
      result: "PASS",
    },
  );
  await writeFile(
    resolve(out, "replacement-results.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await page
    .screenshot({ path: resolve(out, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    resolve(out, "replacement-results.json"),
    JSON.stringify({ results, error: error.message }, null, 2),
  );
  throw error;
} finally {
  if (observerContext) await observerContext.close();
  await browser.close();
}
