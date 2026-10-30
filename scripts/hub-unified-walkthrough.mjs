/** Real loopback browser verification; synthetic lab identity only, no endpoint rotation. */
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { validateLabDatabase } from "./hub-lab.mjs";
const directory = join(tmpdir(), "atlas-hub-lab-" + process.getuid()),
  state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
validateLabDatabase(state.databaseUrl);
const require = createRequire(
    resolve("../Atlas-Link-Dispenser/apps/server/package.json"),
  ),
  { Pool } = require("pg"),
  pool = new Pool({ connectionString: state.databaseUrl });
const freshProfile = process.argv.includes("--fresh-profile"),
  email = freshProfile
    ? "support-probe-" + Date.now() + "@atlas-lab.example"
    : "support-probe@atlas-lab.example",
  output = resolve("evidence/hub-unified-local");
await mkdir(output, { recursive: true });
const account = (
  await pool.query(
    "INSERT INTO users(email,normalized_email,verified_at) VALUES($1,$1,now()) ON CONFLICT(normalized_email) DO UPDATE SET verified_at=COALESCE(users.verified_at,now()) RETURNING id",
    [email],
  )
).rows[0];
await pool.query(
  "INSERT INTO link_assignments(user_id,link_id) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=$2)",
  [account.id, state.linkId],
);
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
});
const results = [],
  errors = [];
let phase = "login",
  active;
const capture = async (page, name) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
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
  await page.screenshot({ path: join(output, name), fullPage: true });
};
const record = (task, detail) => {
  results.push({ task, result: "PASS", ...detail });
  console.log(task + ": PASS");
};
async function login(page, address) {
  await page.goto("https://localhost:4300");
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const file = page.getByRole("link", { name: "Open your verification file" });
  await file.waitFor();
  const href = await file.getAttribute("href"),
    url = new URL(href);
  if (
    !url.hostname.endsWith("localhost") ||
    !url.pathname.startsWith("/__lab/verification/")
  )
    throw Error("Nonlocal verification provider");
  const text = await (await page.request.get(href)).text(),
    code = text.match(/Verification code: (\d{6,8})/)?.[1];
  if (!code) throw Error("Fixture verification unavailable");
  await page
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
try {
  const user = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    hub = await user.newPage();
  active = hub;
  hub.setDefaultTimeout(20000);
  await login(hub, email);
  const branches = (
    await (
      await hub.request.get(new URL("/api/hub/branches", hub.url()).href)
    ).json()
  ).branches;
  if (!branches?.length)
    throw Error("Synthetic fixture has no assigned branch");
  const branch =
      branches.find((b) => b.origin === "https://localhost:4280") ||
      branches[0],
    atlas = await user.newPage();
  active = atlas;
  atlas.setDefaultTimeout(25000);
  atlas.on("pageerror", (e) =>
    errors.push(
      e.message.replace(/#ticket=[^\s]+/g, "#ticket=[redacted]").slice(0, 300),
    ),
  );
  phase = "branch";
  await atlas.goto(branch.origin);
  await atlas.getByRole("button", { name: "Sign in", exact: true }).click();
  await atlas.waitForURL(branch.origin + "/**");
  await atlas.locator(".atlas").waitFor({ timeout: 45000 });
  if (
    await atlas
      .getByRole("button", { name: "Use defaults", exact: true })
      .isVisible()
  )
    await atlas
      .getByRole("button", { name: "Use defaults", exact: true })
      .click();
  record("Normal synthetic Hub sign-in and account-bound branch handoff");
  phase = "legacy-claim";
  const legacy = {
    id: randomBytes(6).toString("hex"),
    token: randomBytes(32).toString("base64url"),
    subject: "Synthetic legacy capability " + new Date().toISOString(),
  };
  const legacyDB = new DatabaseSync(join(directory, "atlas", "atlas.sqlite"));
  legacyDB.exec("PRAGMA busy_timeout=5000");
  const legacyNow = Date.now();
  legacyDB
    .prepare(
      "INSERT INTO tickets(id,secret,subject,category,status,created,updated) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      legacy.id,
      createHash("sha256").update(legacy.token).digest("hex"),
      legacy.subject,
      "Browsing",
      "open",
      legacyNow,
      legacyNow,
    );
  legacyDB
    .prepare("INSERT INTO messages(ticket,author,body,created) VALUES(?,?,?,?)")
    .run(
      legacy.id,
      "user",
      "Synthetic pre-Hub request retained through its original bearer capability.",
      legacyNow,
    );
  legacyDB.close();
  await atlas.evaluate(
    (value) => localStorage.setItem("atlas.tickets", JSON.stringify([value])),
    legacy,
  );
  await atlas.reload();
  await atlas.locator(".atlas").waitFor({ timeout: 45000 });
  await expect
    .poll(async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_tickets WHERE legacy_source=$1 AND legacy_id=$2 AND user_id=$3",
            ["atlas", legacy.id, account.id],
          )
        ).rows[0].n,
      ),
    )
    .toBe(1);
  await atlas.getByRole("button", { name: "Hub support", exact: true }).click();
  await atlas
    .getByRole("dialog", { name: "Atlas Hub support" })
    .getByRole("button", {
      name: new RegExp(legacy.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    })
    .click();
  await expect(
    atlas.getByText(
      "Synthetic pre-Hub request retained through its original bearer capability.",
      { exact: true },
    ),
  ).toBeVisible();
  await atlas.getByRole("button", { name: "Close support" }).click();
  record(
    "Existing legacy ticket is claimed through its real bearer capability and bound to the current account",
  );
  phase = "native-save";
  const hero = atlas.getByLabel("Search the web"),
    address = atlas.getByLabel("Address bar");
  await expect(hero.or(address)).toBeVisible();
  const input = (await hero.isVisible()) ? hero : address;
  await input.fill("http://fixture.localhost:4299/storage");
  await input.press("Enter");
  const site = atlas.frameLocator('iframe[title="Website"]');
  await site
    .getByRole("button", { name: /Count:/ })
    .waitFor({ timeout: 45000 });
  const nextCount =
    Number((await site.locator("#count").innerText()).match(/\d+/)?.[0] || 0) +
    1;
  await site.getByRole("button", { name: /Count:/ }).click();
  await site.getByRole("button", { name: "Save count", exact: true }).click();
  await expect(site.locator("#saved")).toHaveText("Saved " + nextCount);
  record(
    "Native localStorage setter visibly acknowledges save, not merely underlying commit",
  );
  await capture(atlas, "01-live-browser-save.png");
  phase = "create-ticket";
  await atlas.getByRole("button", { name: "Hub support", exact: true }).click();
  const dialog = atlas.getByRole("dialog", { name: "Atlas Hub support" }),
    subject = "Local browser support probe " + new Date().toISOString();
  await dialog.getByLabel("Subject", { exact: true }).fill(subject);
  await dialog
    .getByLabel("Message", { exact: true })
    .fill(
      "Synthetic local verification: test a durable public reply notification.",
    );
  const created = atlas.waitForResponse(
    (r) =>
      r.url().endsWith("/api/hub/support/tickets") &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create ticket", exact: true })
    .click();
  const ticket = (await (await created).json()).ticket.id;
  await expect(
    dialog.getByText(
      "Synthetic local verification: test a durable public reply notification.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close support" }).click();
  record("Account-owned ticket created from the Atlas browsing interface");
  const admin = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    panel = await admin.newPage();
  active = panel;
  panel.setDefaultTimeout(20000);
  await login(panel, "admin@atlas-lab.example");
  await panel.goto(new URL("/?admin", panel.url()).href);
  await panel.getByRole("button", { name: "Support", exact: true }).click();
  await panel
    .getByRole("button", {
      name: new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    })
    .click();
  await panel
    .getByLabel("Reply", { exact: true })
    .fill(
      "Public fixture reply: your browser support request reached the Hub.",
    );
  await panel.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    panel.getByText(
      "Public fixture reply: your browser support request reached the Hub.",
      { exact: true },
    ),
  ).toBeVisible();
  record("Administrator sends a public reply through unified Hub support");
  phase = "notification";
  active = atlas;
  await atlas.bringToFront();
  await expect(
    atlas.getByRole("button", {
      name: "Support, 1 unread replies",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    atlas.getByRole("status").filter({ hasText: "Atlas support replied:" }),
  ).toBeVisible();
  const notificationURL = branch.origin + "/api/hub/support/notifications";
  expect((await (await atlas.request.get(notificationURL)).json()).unread).toBe(
    1,
  );
  await capture(atlas, "02-desktop-reply-notification.png");
  await atlas.reload();
  await atlas.locator(".atlas").waitFor({ timeout: 45000 });
  await expect(
    atlas.getByRole("button", {
      name: "Support, 1 unread replies",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    atlas.frameLocator('iframe[title="Website"]').locator("#count"),
  ).toHaveText("Count: " + nextCount, { timeout: 45000 });
  expect((await (await atlas.request.get(notificationURL)).json()).unread).toBe(
    1,
  );
  record(
    "Unread reply survives browser reload; notification polling does not acknowledge conversation",
  );
  await atlas.setViewportSize({ width: 390, height: 844 });
  await expect(
    atlas.getByRole("button", {
      name: "Support, 1 unread replies",
      exact: true,
    }),
  ).toBeInViewport();
  expect(
    await atlas.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(atlas, "03-mobile-reply-notification.png");
  await atlas.getByRole("button", { name: "Read reply", exact: true }).click();
  await expect(
    dialog.getByText(
      "Public fixture reply: your browser support request reached the Hub.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await atlas.request.get(notificationURL)).json()).unread,
    )
    .toBe(0);
  await capture(atlas, "04-mobile-conversation.png");
  record(
    "Mobile notification opens the actual conversation and only then marks reply read",
  );
  await atlas.keyboard.press("Escape");
  phase = "internal-note";
  active = panel;
  await panel.getByLabel("Internal note — not sent to user").check();
  await panel
    .getByLabel("Reply", { exact: true })
    .fill("Internal synthetic note is not a user reply.");
  await panel.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    panel.getByText("Internal synthetic note is not a user reply.", {
      exact: true,
    }),
  ).toBeVisible();
  const publicThread = await (
    await atlas.request.get(
      branch.origin + "/api/hub/support/tickets/" + ticket,
    )
  ).json();
  expect(
    publicThread.messages.some((m) =>
      m.body.includes("Internal synthetic note"),
    ),
  ).toBe(false);
  expect((await (await atlas.request.get(notificationURL)).json()).unread).toBe(
    0,
  );
  record(
    "Internal notes neither leak to Atlas nor generate user notifications",
  );
  phase = "metrics";
  await panel
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  const metricsURL = new URL("/api/admin/hub/metrics", panel.url()).href;
  await expect
    .poll(
      async () => {
        await panel.request.get(
          new URL("/api/admin/hub/atlas", panel.url()).href,
        );
        return Number(
          (
            await pool.query(
              "SELECT count(*)::int n FROM hub_metric_sources WHERE presence_verified AND observed_at>now()-interval '45 seconds' AND $1=ANY(account_ids)",
              [account.id],
            )
          ).rows[0].n,
        );
      },
      { timeout: 45000 },
    )
    .toBeGreaterThan(0);
  const metrics = await (await panel.request.get(metricsURL)).json();
  expect(metrics.onlineUsers).toBeGreaterThanOrEqual(1);
  await expect(
    panel.getByRole("heading", { name: "Browser services", exact: true }),
  ).toBeVisible();
  await expect(
    panel.locator(".metric-grid").first().locator("h2").first(),
  ).toHaveText(/^(≥ )?[1-9]\d*$/, { timeout: 25000 });
  await capture(panel, "05-infrastructure-live-account-metrics.png");
  record(
    "Real live relay proof is joined to the synthetic account and collected in Hub metrics",
    { onlineUsers: metrics.onlineUsers, complete: metrics.complete },
  );
  phase = "mfa";
  const services = panel
    .getByRole("heading", { name: "Browser services", exact: true })
    .locator("..");
  await services.getByRole("button", { name: "Site", exact: true }).click();
  const name = services.getByLabel("Site name", { exact: true }),
    original = await name.inputValue(),
    fixture = JSON.parse(
      await readFile(join(directory, "coordinator-admin.json"), "utf8"),
    );
  const database = new DatabaseSync(join(directory, "atlas", "atlas.sqlite"), {
    readOnly: true,
  });
  const saved = JSON.parse(
    database.prepare("SELECT value FROM settings WHERE key='admin'").get()
      .value,
  );
  database.close();
  const codes = fixture.recovery.filter((c) =>
    saved.recovery.includes(createHash("sha256").update(c).digest("hex")),
  );
  if (codes.length < 2)
    throw Error("Two unused fixture recovery credentials required");
  async function apply(value, code, captureForm = false) {
    await name.fill(value);
    await services.getByRole("button", { name: "Save", exact: true }).click();
    const verify = services.getByRole("form", {
      name: "Verify browser service change",
    });
    await verify.waitFor();
    if (captureForm) await capture(panel, "06-operation-bound-mfa-prompt.png");
    await verify
      .getByLabel("Coordinator administrator password", { exact: true })
      .fill(fixture.password);
    await verify
      .getByLabel("Authenticator or recovery code", { exact: true })
      .fill(code);
    const done = panel.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/hub/atlas/command") &&
        r.request().method() === "POST",
    );
    await verify
      .getByRole("button", { name: "Verify and apply", exact: true })
      .click();
    const result = await done;
    if (!result.ok())
      throw Error(
        "Coordinator MFA command did not complete: " + result.status(),
      );
    expect((await result.json()).name).toBe(value);
  }
  await apply("Atlas local MFA verified", codes[0], true);
  await apply(original, codes[1]);
  record(
    "Central admin UI performs real coordinator password/recovery MFA and restores the original site setting",
  );
  await capture(panel, "07-central-controls-restored.png");
  phase = "mobile-admin";
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.reload();
  await panel.getByRole("button", { name: "Menu", exact: true }).click();
  await panel
    .getByRole("button", { name: "Infrastructure", exact: true })
    .click();
  await panel
    .getByRole("heading", { name: "Browser services", exact: true })
    .waitFor();
  expect(
    await panel.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(panel, "08-mobile-infrastructure.png");
  record("Mobile unified infrastructure interface fits the viewport");
  if (errors.length)
    throw Error("Browser page errors observed: " + errors.join("; "));
} catch (error) {
  results.push({
    task: phase,
    result: "FAIL",
    message: error.message.slice(0, 500),
  });
  if (active)
    await capture(active, "failure-" + phase + ".png").catch(() => {});
  process.exitCode = 1;
  console.error("FAILED", phase, error.message.slice(0, 500));
} finally {
  await writeFile(
    join(output, "walkthrough-results.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        production: false,
        realAWS: false,
        freshProfile,
        results,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await pool.end();
}
