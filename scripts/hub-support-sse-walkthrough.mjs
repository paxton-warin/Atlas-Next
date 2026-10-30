#!/usr/bin/env node
/** Normal loopback UI proof. Only the explicitly marked disposable lab is seeded.
 * Event probes retain event names/times only, never cookies, tokens or bodies. */
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
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
const hubOrigin = status.hub,
  origin = status.atlas;
for (const value of [hubOrigin, origin]) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !(u.hostname === "localhost" || u.hostname.endsWith(".atlas.localhost"))
  )
    throw Error("Loopback lab only");
}
const require = createRequire(
    resolve("../Atlas-Link-Dispenser/apps/server/package.json"),
  ),
  { Pool } = require("pg"),
  pool = new Pool({ connectionString: state.databaseUrl });
if (
  (await pool.query("SELECT id FROM atlas_lab_identity")).rows[0]?.id !==
  state.id
)
  throw Error("Disposable lab identity mismatch");
const email = "sse-probe-" + Date.now() + "@atlas-lab.example";
const user = (
  await pool.query(
    "INSERT INTO users(email,normalized_email,verified_at)VALUES($1,$1,now()) RETURNING id",
    [email],
  )
).rows[0];
await pool.query("INSERT INTO link_assignments(user_id,link_id)VALUES($1,$2)", [
  user.id,
  state.linkId,
]);
const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
  }),
  output = resolve("evidence/hub-support-sse"),
  results = [],
  errors = [];
await mkdir(output, { recursive: true });
let phase = "sign-in",
  active;
const record = (task, detail = {}) => {
  results.push({ task, result: "PASS", ...detail });
  console.log(task + ": PASS");
};
async function login(page, address) {
  await page.goto(hubOrigin);
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const link = page.getByRole("link", { name: "Open your verification file" });
  await link.waitFor();
  const href = await link.getAttribute("href"),
    u = new URL(href);
  if (
    !u.hostname.endsWith("localhost") ||
    !u.pathname.startsWith("/__lab/verification/")
  )
    throw Error("Nonlocal provider");
  const code = (await (await page.request.get(href)).text()).match(
    /Verification code: (\d{6,8})/,
  )?.[1];
  if (!code) throw Error("No fixture verification");
  await page
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
async function probe(page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.__sseEvents = [];
    window.__sseStreams = [];
    window.EventSource = class extends Native {
      constructor(url, options) {
        super(url, options);
        const path = new URL(String(url), location.href).pathname;
        if (!path.endsWith("/events")) return;
        window.__sseStreams.push(this);
        for (const name of ["ready", "support", "error", "authorization"])
          this.addEventListener(name, () =>
            window.__sseEvents.push({ path, name, at: performance.now() }),
          );
      }
    };
  });
  page.on("pageerror", (e) =>
    errors.push(e.message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 300)),
  );
  page.setDefaultTimeout(20000);
}
async function ready(page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__sseEvents?.filter((e) => e.name === "ready").length || 0,
        ),
      { timeout: 12000 },
    )
    .toBeGreaterThan(0);
}
async function events(page, name) {
  return page.evaluate(
    (n) => (window.__sseEvents || []).filter((e) => e.name === n).length,
    name,
  );
}
async function capture(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  await page.screenshot({ path: join(output, name), fullPage: true });
}
try {
  const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    hub = await context.newPage();
  active = hub;
  await probe(hub);
  await login(hub, email);
  await ready(hub);
  const peer = await context.newPage();
  await probe(peer);
  await peer.goto(hubOrigin);
  await ready(peer);
  const atlas = await context.newPage();
  active = atlas;
  await probe(atlas);
  await atlas.goto(origin);
  await atlas.getByRole("button", { name: "Sign in", exact: true }).click();
  await atlas.locator(".atlas").waitFor({ timeout: 45000 });
  const defaults = atlas.getByRole("button", {
    name: "Use defaults",
    exact: true,
  });
  if (await defaults.isVisible().catch(() => false)) await defaults.click();
  await ready(atlas);
  record(
    "Real authenticated SSE connects on Hub, second Hub window and Atlas branch",
  );
  phase = "create-ticket";
  await atlas.getByRole("button", { name: "Hub support", exact: true }).click();
  const dialog = atlas.getByRole("dialog", { name: "Atlas Hub support" }),
    subject = "Live support verification " + Date.now();
  await dialog.getByLabel("Subject", { exact: true }).fill(subject);
  await dialog
    .getByLabel("Message", { exact: true })
    .fill("Synthetic local SSE request.");
  const created = atlas.waitForResponse(
    (r) =>
      r.url().endsWith("/api/hub/support/tickets") &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create ticket", exact: true })
    .click();
  const ticket = (await (await created).json()).ticket.id;
  await dialog
    .getByText("Synthetic local SSE request.", { exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "Close support" }).click();
  const adminContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    panel = await adminContext.newPage();
  active = panel;
  panel.setDefaultTimeout(20000);
  await login(panel, "admin@atlas-lab.example");
  await panel.goto(hubOrigin + "/?admin");
  await panel.getByRole("button", { name: "Support", exact: true }).click();
  await panel.getByRole("button", { name: new RegExp(subject) }).click();
  const send = async (text) => {
    await panel.getByLabel("Reply", { exact: true }).fill(text);
    await panel
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await panel.getByText(text, { exact: true }).waitFor();
  };
  const sources = [hub, peer, atlas],
    before = await Promise.all(sources.map((p) => events(p, "support"))),
    start = Date.now();
  phase = "public-reply";
  await send("SSE public reply one.");
  for (let i = 0; i < sources.length; i++)
    await expect
      .poll(() => events(sources[i], "support"), { timeout: 5000 })
      .toBeGreaterThan(before[i]);
  for (const page of sources)
    await expect(
      page.getByRole("button", {
        name: "Support, 1 unread replies",
        exact: true,
      }),
    ).toBeVisible({ timeout: 5000 });
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(10000);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM hub_notifications WHERE user_id=$1 AND read_at IS NULL",
        [user.id],
      )
    ).rows[0].n,
  ).toBe(1);
  record(
    "One committed public reply triggers real SSE and unread badges in all three windows without marking read",
    { elapsedMs: elapsed },
  );
  active = atlas;
  await atlas.bringToFront();
  await atlas.setViewportSize({ width: 390, height: 844 });
  await capture(atlas, "01-mobile-live-notification.png");
  await atlas.getByRole("button", { name: "Read reply", exact: true }).click();
  await dialog.getByText("SSE public reply one.", { exact: true }).waitFor();
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_notifications WHERE user_id=$1 AND read_at IS NULL",
            [user.id],
          )
        ).rows[0].n,
    )
    .toBe(0);
  for (const page of [hub, peer])
    await expect(
      page.getByRole("button", { name: "Support", exact: true }),
    ).toBeVisible({ timeout: 5000 });
  await capture(atlas, "02-mobile-read-conversation.png");
  await atlas.getByRole("button", { name: "Close support" }).click();
  record(
    "Opening the rendered mobile conversation clears both other windows by SSE",
  );
  phase = "offline-reconnect";
  const reconnectBefore = await events(atlas, "ready");
  await context.setOffline(true);
  await send("Durable reply during offline interval.");
  await context.setOffline(false);
  await expect
    .poll(() => events(atlas, "ready"), { timeout: 12000 })
    .toBeGreaterThan(reconnectBefore);
  await expect(
    atlas.getByRole("button", {
      name: "Support, 1 unread replies",
      exact: true,
    }),
  ).toBeVisible({ timeout: 12000 });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM hub_notifications WHERE user_id=$1 AND read_at IS NULL",
        [user.id],
      )
    ).rows[0].n,
  ).toBe(1);
  record(
    "Offline disconnect then EventSource reconnect recovers the durable unread reply once",
  );
  await atlas.bringToFront();
  await atlas.getByRole("button", { name: "Read reply", exact: true }).click();
  await dialog
    .getByText("Durable reply during offline interval.", { exact: true })
    .waitFor();
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_notifications WHERE user_id=$1 AND read_at IS NULL",
            [user.id],
          )
        ).rows[0].n,
    )
    .toBe(0);
  await atlas.getByRole("button", { name: "Close support" }).click();
  phase = "polling-fallback";
  for (const page of sources)
    await page.evaluate(() => window.__sseStreams.forEach((s) => s.close()));
  const noEvents = await events(atlas, "support");
  await context.route("**/api/hub/**events", (r) =>
    r.abort("connectionrefused"),
  );
  await send("Durable reply with SSE unavailable.");
  await atlas.bringToFront();
  await expect(
    atlas.getByRole("button", {
      name: "Support, 1 unread replies",
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  expect(await events(atlas, "support")).toBe(noEvents);
  record(
    "15-second durable polling recovers a reply when all SSE streams are closed",
  );
  phase = "policy-ui";
  active = panel;
  await panel.getByRole("button", { name: "Settings", exact: true }).click();
  await panel
    .getByRole("heading", { name: "Browser storage limits", exact: true })
    .waitFor();
  await panel.getByLabel("Account email", { exact: true }).fill(email);
  await panel
    .getByRole("button", { name: "Find account", exact: true })
    .click();
  const policy = panel.getByRole("form", {
    name: "Account browser storage limits",
  });
  await policy.waitFor();
  await policy
    .getByLabel("Override Account backup allowance (MiB)", { exact: true })
    .fill("300");
  await policy
    .getByRole("button", { name: "Save account limits", exact: true })
    .click();
  await panel
    .getByText("Account storage limits saved. Existing data was not removed.", {
      exact: true,
    })
    .waitFor();
  expect(
    (
      await pool.query(
        "SELECT profile_bytes FROM hub_profile_policy_overrides WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].profile_bytes,
  ).toBe(String(300 * 1024 * 1024));
  await capture(panel, "03-admin-storage-policy.png");
  await policy
    .getByLabel("Override Account backup allowance (MiB)", { exact: true })
    .fill("");
  await policy
    .getByRole("button", { name: "Save account limits", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT profile_bytes FROM hub_profile_policy_overrides WHERE user_id=$1",
            [user.id],
          )
        ).rows[0]?.profile_bytes ?? null,
    )
    .toBeNull();
  record(
    "Admin adjusts only the synthetic account backup allowance then restores inheritance without deleting saves",
  );
  const report = {
    result: "PASS",
    production: false,
    results,
    pageErrors: errors,
    sse: await Promise.all(
      sources.map(async (page) => ({
        events: await page.evaluate(() =>
          window.__sseEvents.map(({ path, name }) => ({ path, name })),
        ),
      })),
    ),
  };
  expect(errors).toEqual([]);
  await writeFile(
    join(output, "browser-results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
} catch (e) {
  await writeFile(
    join(output, "browser-results.json"),
    JSON.stringify(
      {
        result: "FAIL",
        phase,
        results,
        error: String(e.message).replace(/https?:\/\/\S+/g, "[URL]"),
        pageErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  if (active)
    await active
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  throw e;
} finally {
  await browser.close();
  await pool.end();
}
