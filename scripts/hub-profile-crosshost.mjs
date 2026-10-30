/** Actual UI/opaque-runtime/Hub-PostgreSQL cross-host save walkthrough. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const out = resolve("evidence/hub-profile-local");
await mkdir(out, { recursive: true });
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
  a = await context.newPage(),
  results = [],
  errors = [];
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
a.on("pageerror", (e) => errors.push(e.message));
const shot = async (p, n) => {
  await p.screenshot({ path: resolve(out, n), fullPage: true });
};
const fixture = (p) => p.frameLocator('iframe[title="Website"]');
async function navigate(p) {
  const input = p.locator("input[placeholder]").first();
  await input.fill("http://fixture.localhost:4299/storage");
  await input.press("Enter");
}
try {
  await a.goto("https://localhost:4280");
  await a.getByRole("button", { name: "Your saves", exact: true }).waitFor();
  if (
    await a.getByRole("button", { name: "Use defaults", exact: true }).count()
  )
    await a.getByRole("button", { name: "Use defaults", exact: true }).click();
  await navigate(a);
  await Promise.race([
    fixture(a).locator("#count").waitFor({ timeout: 45000 }),
    a
      .getByRole("button", { name: "Continue here", exact: true })
      .waitFor({ timeout: 45000 }),
  ]);
  if (
    await a
      .getByRole("button", { name: "Continue here", exact: true })
      .isVisible()
      .catch(() => false)
  )
    await a.getByRole("button", { name: "Continue here", exact: true }).click();
  await fixture(a).locator("#count").waitFor({ timeout: 130000 });
  await fixture(a).locator("#count").click();
  await fixture(a).locator("#save").click();
  await fixture(a).locator("#saved").filter({ hasText: /Saved/ }).waitFor();
  const count = await fixture(a).locator("#count").innerText();
  await fixture(a).locator("#idb-save").click();
  await fixture(a)
    .locator("#idb-result")
    .filter({ hasText: /Saved record/ })
    .waitFor({ timeout: 15000 });
  const idbSaved = await fixture(a).locator("#idb-result").innerText();
  await fixture(a).locator("#cookie-save").click();
  await fixture(a)
    .locator("#cookie-result")
    .filter({ hasText: /Cookie saved/ })
    .waitFor();
  results.push({
    task: "Native IndexedDB Blob and session cookie saves acknowledged",
    result: "PASS",
    idbSaved,
  });
  await a
    .getByRole("status")
    .filter({ hasText: "Synced" })
    .waitFor({ timeout: 35000 });
  results.push({
    task: "Native localStorage acknowledged and uploaded",
    result: "PASS",
    count,
  });
  const hub = await context.newPage();
  await hub.goto("https://localhost:4300");
  if (!(await hub.locator('a[href*=".atlas.localhost"]').count())) {
    await hub
      .getByRole("button", { name: "Generate another link", exact: true })
      .click();
    await hub.waitForTimeout(1000);
  }
  const links = await hub
    .locator('a[href*=".atlas.localhost"]')
    .evaluateAll((es) => es.map((a) => a.href));
  if (!links.length)
    throw Error(
      "No generated local branch was allocated: " +
        (await hub.locator("body").innerText()),
    );
  const target = links[0];
  if (!new URL(target).hostname.endsWith(".atlas.localhost"))
    throw Error("Nonlocal branch denied");
  const b = await context.newPage();
  await b.goto(target);
  if (await b.getByRole("button", { name: "Sign in", exact: true }).count())
    await b.getByRole("button", { name: "Sign in", exact: true }).click();
  await b.waitForURL(new URL(target).origin + "/**");
  await b
    .getByRole("button", { name: "Your saves", exact: true })
    .waitFor({ timeout: 25000 });
  await navigate(b);
  await Promise.race([
    fixture(b).locator("#count").waitFor({ timeout: 45000 }),
    b
      .getByRole("button", { name: "Continue here", exact: true })
      .waitFor({ timeout: 45000 }),
  ]);
  await shot(b, "03-crosshost-ownership.png");
  if (
    await b
      .getByRole("button", { name: "Continue here", exact: true })
      .isVisible()
      .catch(() => false)
  )
    await b.getByRole("button", { name: "Continue here", exact: true }).click();
  await fixture(b).locator("#count").waitFor({ timeout: 125000 });
  const restored = await fixture(b).locator("#count").innerText();
  if (restored !== count)
    throw Error("Cross-host count mismatch " + restored + " vs " + count);
  await fixture(b).locator("#idb-read").click();
  await fixture(b)
    .locator("#idb-result")
    .filter({ hasText: /Record [0-9]+ count [0-9]+ blob Atlas blob/ })
    .waitFor({ timeout: 15000 });
  const idbRestored = await fixture(b).locator("#idb-result").innerText();
  await fixture(b).locator("#cookie-read").click();
  await fixture(b)
    .locator("#cookie-result")
    .filter({ hasText: /Cookie [0-9]+/ })
    .waitFor();
  const cookieRestored = await fixture(b).locator("#cookie-result").innerText();
  results.push({
    task: "Cross-host IndexedDB Blob/schema/generated-key and rewritten session cookie restore",
    result: "PASS",
    idbRestored,
    cookieRestored,
  });
  results.push({
    task: "Browser-bound Hub handoff and flush-before-takeover across frontend hosts",
    result: "PASS",
    restored,
  });
  await shot(b, "04-crosshost-restored.png");
  const websiteFrame = b
    .frames()
    .find((f) => f.url().includes("/browse/frame/"));
  const cdp = await context.newCDPSession(websiteFrame);
  const tree = await cdp.send("Page.getFrameTree");
  const child = tree.frameTree;
  const isolated = await cdp.send("Page.createIsolatedWorld", {
    frameId: child.frame.id,
    worldName: "native-isolation-proof",
    grantUniveralAccess: false,
  });
  const native = await cdp.send("Runtime.evaluate", {
    contextId: isolated.executionContextId,
    returnByValue: true,
    expression: `(()=>{let parentDenied=false;try{void parent.document.body;}catch{parentDenied=true;}let storageDenied=false;try{void localStorage.length;}catch{storageDenied=true;}let idbDenied=false;try{indexedDB.open('atlas.profile.control.v1');}catch{idbDenied=true;}return {origin:globalThis.origin,parentDenied,storageDenied,idbDenied};})()`,
  });
  const access = native.result.value;
  console.log("NATIVE_ISOLATION", access);
  if (
    access.origin !== "null" ||
    !access.parentDenied ||
    !access.storageDenied ||
    !access.idbDenied
  )
    throw Error("Native opaque isolation failed");
  results.push({
    task: "Frontend URL with browser-enforced opaque native DOM/storage/IDB denial",
    result: "PASS",
    ...access,
  });

  console.log(JSON.stringify({ results, errors }, null, 2));
  await writeFile(
    resolve(out, "crosshost-results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
} catch (e) {
  await shot(context.pages().at(-1), "crosshost-failure.png").catch(() => {});
  console.error(e.stack);
  console.log(JSON.stringify({ results, errors }));
  await writeFile(
    resolve(out, "crosshost-results.json"),
    JSON.stringify(
      { complete: false, results, errors, error: e.message },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await context.close();
}
