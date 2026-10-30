import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { validateLabDatabase } from "./hub-lab.mjs";
const state = JSON.parse(
  await readFile(
    join(tmpdir(), "atlas-hub-lab-" + process.getuid(), "state.json"),
    "utf8",
  ),
);
validateLabDatabase(state.databaseUrl);
const status = JSON.parse(
  execFileSync(process.execPath, ["scripts/hub-lab.mjs", "status"], {
    encoding: "utf8",
  }),
);
for (const raw of [status.atlas, status.hub])
  if (!new URL(raw).hostname.endsWith("localhost"))
    throw Error("Loopback only");
const require = createRequire(
    resolve("../Atlas-Link-Dispenser/apps/server/package.json"),
  ),
  { Pool } = require("pg"),
  pool = new Pool({ connectionString: state.databaseUrl });
if (
  (await pool.query("SELECT id FROM atlas_lab_identity")).rows[0]?.id !==
  state.id
)
  throw Error("Lab marker");
const email = "nested-diag-" + Date.now() + "@atlas-lab.example",
  u = (
    await pool.query(
      "INSERT INTO users(email,normalized_email,verified_at)VALUES($1,$1,now())RETURNING id",
      [email],
    )
  ).rows[0];
await pool.query("INSERT INTO link_assignments(user_id,link_id)VALUES($1,$2)", [
  u.id,
  state.linkId,
]);
await pool.end();
const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
  }),
  context = await browser.newContext({ ignoreHTTPSErrors: true }),
  events = [],
  errors = [];
await mkdir("evidence/hub-nested-gate", { recursive: true });
const delayMs = Number(
  process.argv.find((v) => v.startsWith("--delay-ms="))?.split("=")[1] || 0,
);
if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 180000)
  throw Error("Invalid delay");
const storageFirst = process.argv.includes("--storage-first");
const prefix =
  (delayMs ? "delayed-" : "") + (storageFirst ? "navigation-" : "");
const path = (raw) =>
  new URL(raw).pathname
    .replace(/doc_[a-f0-9]{32}/g, "[document]")
    .replace(/[a-f0-9]{64}/g, "[hash]");
try {
  const hub = await context.newPage();
  await hub.goto(status.hub);
  await hub.getByLabel("Email address", { exact: true }).fill(email);
  await hub.getByRole("button", { name: "Continue", exact: true }).click();
  const f = hub.getByRole("link", { name: "Open your verification file" });
  await f.waitFor();
  const href = await f.getAttribute("href");
  if (!new URL(href).pathname.startsWith("/__lab/verification/"))
    throw Error("Local verifier only");
  const code = (await (await hub.request.get(href)).text()).match(
    /Verification code: (\d{6,8})/,
  )?.[1];
  await hub
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await hub.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const page = await context.newPage();
  page.on("pageerror", (e) =>
    errors.push(e.message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 200)),
  );
  page.on("console", (m) => {
    if (m.type() === "error")
      errors.push(
        m
          .text()
          .replace(/https?:\/\/\S+/g, "[URL]")
          .slice(0, 250),
      );
  });
  const tasks = [];
  page.on("response", (r) => {
    if (
      !new URL(r.url()).pathname.startsWith("/browse/frame/") &&
      !new URL(r.url()).pathname.startsWith("/api/browse/controller/document")
    )
      return;
    tasks.push(
      (async () => {
        const h = await r.request().allHeaders(),
          entry = {
            path: path(r.url()),
            method: r.request().method(),
            status: r.status(),
            cookiePresent: !!h.cookie,
            cookieNames: (h.cookie || "")
              .split(";")
              .map((v) => v.trim().split("=")[0])
              .filter(Boolean),
            origin: h.origin ?? null,
            fetchSite: h["sec-fetch-site"] ?? null,
          };
        if (r.status() >= 400) {
          const body = await r.json().catch(() => null);
          entry.errorCode = body?.error?.code ?? body?.code ?? null;
        }
        events.push(entry);
      })(),
    );
  });
  await page.goto(status.atlas);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".atlas").waitFor({ timeout: 45000 });
  const d = page.getByRole("button", { name: "Use defaults", exact: true });
  if (await d.isVisible().catch(() => false)) await d.click();
  if (delayMs) await page.waitForTimeout(delayMs);
  const input = page.locator("input[placeholder]").first();
  if (storageFirst) {
    await input.fill("http://fixture.localhost:4299/storage");
    await input.press("Enter");
    await page
      .frameLocator('iframe[title="Website"]')
      .locator("#count")
      .waitFor({ timeout: 30000 });
    await page
      .frameLocator('iframe[title="Website"]')
      .locator("#count")
      .click();
    await page.frameLocator('iframe[title="Website"]').locator("#save").click();
    await page
      .frameLocator('iframe[title="Website"]')
      .locator("#saved")
      .waitFor();
  }
  await input.fill("http://fixture.localhost:4299/frames");
  await input.press("Enter");
  await page.waitForTimeout(10000);
  await Promise.all(tasks);
  const frameResult = await page
    .frameLocator('iframe[title="Website"]')
    .locator("#frame-result")
    .innerText({ timeout: 1000 })
    .catch(() => null);
  const frames = page.frames().map((f) => ({
    path: f.url().startsWith("http") ? path(f.url()) : f.url(),
    depth: (() => {
      let n = 0,
        p = f.parentFrame();
      while (p) {
        n++;
        p = p.parentFrame();
      }
      return n;
    })(),
  }));
  await writeFile(
    "evidence/hub-nested-gate/" + prefix + "diagnostic.json",
    JSON.stringify({ events, errors, frames, frameResult }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ events, errors, frames, frameResult }, null, 2));
  await page.screenshot({
    path: "evidence/hub-nested-gate/" + prefix + "diagnostic.png",
    fullPage: true,
  });
} finally {
  await browser.close();
}
