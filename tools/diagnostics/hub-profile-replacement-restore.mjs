/** Real account reauthentication + profile restore after local reviewed replacement. */
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const data = JSON.parse(
    await readFile(
      "evidence/hub-cloud-replacement/replacement-results.json",
      "utf8",
    ),
  ),
  replacements = data.results.find((r) => r.replacements).replacements,
  hub = replacements.find((r) => r.role === "hub").current,
  front = replacements.find((r) => r.role === "frontend").current;
if (
  ![hub, front].every((raw) =>
    new URL(raw).hostname.endsWith(".atlas.localhost"),
  )
)
  throw Error("Local fixtures only.");
const out = resolve("evidence/hub-profile-local");
await mkdir(out, { recursive: true });
const c = await chromium.launchPersistentContext(
  "/tmp/atlas-hub-profile-browser-501",
  {
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  },
);
for (const p of c.pages()) await p.close();
const p = await c.newPage(),
  results = [],
  errors = [];
p.on("pageerror", (e) => errors.push(e.message));
try {
  await p.goto(hub);
  if (await p.getByLabel("Email address", { exact: true }).count()) {
    await p
      .getByLabel("Email address", { exact: true })
      .fill("student@atlas-lab.example");
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    const file = p.getByRole("link", { name: "Open your verification file" });
    await file.waitFor();
    const href = await file.getAttribute("href"),
      u = new URL(href);
    if (
      !(
        ["localhost"].includes(u.hostname) ||
        u.hostname.endsWith(".atlas.localhost")
      ) ||
      !u.pathname.startsWith("/__lab/verification/")
    )
      throw Error("Nonlocal verification denied");
    const text = await (await p.request.get(href)).text(),
      code = text.match(/Verification code: (\d{6,8})/)?.[1];
    await p
      .getByRole("textbox", { name: /digit verification code/ })
      .fill(code);
    await p.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  }
  results.push({ task: "Normal sign-in at replacement Hub", result: "PASS" });
  await p.goto(front);
  if (await p.getByRole("button", { name: "Sign in", exact: true }).count())
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await p
    .getByRole("button", { name: "Your saves", exact: true })
    .waitFor({ timeout: 30000 });
  const input = p.locator("input[placeholder]").first();
  await input.fill("http://fixture.localhost:4299/storage");
  await input.press("Enter");
  const f = p.frameLocator('iframe[title="Website"]');
  await Promise.race([
    f.locator("#count").waitFor({ timeout: 45000 }),
    p
      .getByRole("button", { name: "Continue here", exact: true })
      .waitFor({ timeout: 45000 }),
  ]);
  if (
    await p
      .getByRole("button", { name: "Continue here", exact: true })
      .isVisible()
      .catch(() => false)
  )
    await p.getByRole("button", { name: "Continue here", exact: true }).click();
  await f.locator("#count").waitFor({ timeout: 130000 });
  const count = await f.locator("#count").innerText();
  if (count !== "Count: 7")
    throw Error("Replacement localStorage mismatch: " + count);
  await f.locator("#idb-read").click();
  await f
    .locator("#idb-result")
    .filter({ hasText: "Record 1 count 7 blob Atlas blob 7 bytes 1,2,3,7" })
    .waitFor();
  await f.locator("#cookie-read").click();
  await f.locator("#cookie-result").filter({ hasText: "Cookie 7" }).waitFor();
  results.push({
    task: "Replaced frontend restores acknowledged localStorage, IDB Blob/index/generated-key data and session cookie",
    result: "PASS",
    count,
    idb: await f.locator("#idb-result").innerText(),
    cookie: await f.locator("#cookie-result").innerText(),
  });
  await p.screenshot({
    path: resolve(out, "05-replacement-restored.png"),
    fullPage: true,
  });
  await f.locator("#idb-save").click();
  await f
    .locator("#idb-result")
    .filter({ hasText: "Saved record 2 count 7" })
    .waitFor();
  await p
    .getByRole("status")
    .filter({ hasText: "Synced" })
    .waitFor({ timeout: 35000 });
  results.push({
    task: "Restored native IDB key generator continues at2 and new changes receive remote acknowledgment",
    result: "PASS",
  });
  await p.screenshot({
    path: resolve(out, "06-replacement-generated-key.png"),
    fullPage: true,
  });
  console.log(JSON.stringify({ results, errors }, null, 2));
  await writeFile(
    resolve(out, "replacement-restore-results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
} catch (e) {
  await p
    .screenshot({
      path: resolve(out, "replacement-restore-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  console.error(e.stack);
  await writeFile(
    resolve(out, "replacement-restore-results.json"),
    JSON.stringify(
      { complete: false, results, errors, error: e.message },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await c.close();
}
