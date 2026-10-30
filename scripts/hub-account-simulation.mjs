#!/usr/bin/env node
/** Normal-UI account switching, native outbox recovery and metadata isolation.
 * Seeds only the marked disposable lab; never imports or exports auth state. */
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateLabDatabase } from "./hub-lab.mjs";

const state = JSON.parse(
  await readFile(
    join(tmpdir(), `atlas-hub-lab-${process.getuid()}`, "state.json"),
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
for (const raw of [hubOrigin, origin]) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    !(u.hostname === "localhost" || u.hostname.endsWith(".atlas.localhost"))
  )
    throw Error("Local lab only.");
}
const require = createRequire(
  resolve("../Atlas-Link-Dispenser/apps/server/package.json"),
);
const { Pool } = require("pg"),
  pool = new Pool({ connectionString: state.databaseUrl });
const marker = await pool.query("SELECT id FROM atlas_lab_identity");
if (marker.rows[0]?.id !== state.id)
  throw Error("Disposable database marker mismatch.");
const savedCount = process.argv.includes("--integrated-probe")
  ? 2
  : process.argv.includes("--long-outage")
    ? 4
    : 3;
const run = Date.now(),
  emails = [
    `account-a-${run}@atlas-lab.example`,
    `account-b-${run}@atlas-lab.example`,
  ];
for (const email of emails) {
  const user = (
    await pool.query(
      "INSERT INTO users(email,normalized_email,verified_at) VALUES($1,$1,now()) RETURNING id",
      [email],
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)",
    [user.id, state.linkId],
  );
}
await pool.end();
const output = resolve(
  process.env.ATLAS_ACCOUNT_OUTPUT_DIR || "evidence/hub-account-local",
);
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
});
await context.addInitScript(() => {
  const trace = [];
  Object.defineProperty(window, "__atlasLabFixtureMessages", { value: trace });
  const ports = [];
  Object.defineProperty(window, "__atlasLabPortStages", { value: ports });
  const data = Object.getOwnPropertyDescriptor(
    MessageEvent.prototype,
    "data",
  ).get;
  const add = EventTarget.prototype.addEventListener;
  const offers = [];
  Object.defineProperty(window, "__atlasLabOffers", { value: offers });
  add.call(window, "message", (event) => {
    const value = data.call(event);
    if (value?.protocol !== 2 || value?.type !== "sandbox-ready") return;
    let depth = 0;
    try {
      for (let i = 0; i < Math.min(window.length, 32); i++) {
        if (window.frames[i] === event.source) depth = 1;
        for (let j = 0; j < Math.min(window.frames[i].length, 32); j++)
          if (window.frames[i].frames[j] === event.source) depth = 2;
      }
    } catch {}
    offers.push({
      documentId: value.documentId,
      nonce: value.nonce,
      origin: event.origin,
      depth,
    });
  });
  const record = (direction, value) => {
    if (
      ports.length >= 120 ||
      typeof value?.type !== "string" ||
      !/^[a-z-]{1,40}$/.test(value.type)
    )
      return;
    ports.push({
      direction,
      type: value.type,
      ...(["start", "ready", "loaded", "error"].includes(value.phase)
        ? { phase: value.phase }
        : {}),
      ...(typeof value.code === "string" && /^[a-z_-]{1,80}$/.test(value.code)
        ? { code: value.code }
        : {}),
    });
  };
  const start = MessagePort.prototype.start;
  const post = MessagePort.prototype.postMessage;
  const attached = new WeakSet();
  MessagePort.prototype.start = function (...args) {
    if (!attached.has(this)) {
      attached.add(this);
      add.call(this, "message", (event) => record("in", data.call(event)));
    }
    return Reflect.apply(start, this, args);
  };
  MessagePort.prototype.postMessage = function (...args) {
    record("out", args[0]);
    return Reflect.apply(post, this, args);
  };
  add.call(window, "message", (event) => {
    const value = data.call(event);
    const fixture = value?.fixture ?? value?.$runtimekit$data?.fixture;
    if (fixture !== "nested-ready" && fixture !== "popup-ready") return;
    const entry = {
      fixture,
      readyState: document.readyState,
      before: document.querySelector("#frame-result")?.textContent ?? null,
    };
    trace.push(entry);
    queueMicrotask(() => {
      entry.after =
        document.querySelector("#frame-result")?.textContent ?? null;
    });
  });
});
const hub = await context.newPage(),
  atlas = await context.newPage(),
  results = [],
  errors = [];
const reservationNonces = new Map();
context.on("request", (request) => {
  try {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/browse/controller/document"
    ) {
      const value = request.postDataJSON();
      if (value.documentId && value.bootstrapNonce)
        reservationNonces.set(value.documentId, {
          nonce: value.bootstrapNonce,
          nested: !!value.parentDocumentId,
        });
    }
  } catch {}
});
atlas.on("console", (message) => {
  const text = message.text();
  const code = text.match(/(?:error code|error:|code)\s+(\d{1,3})/i)?.[1];
  if (code)
    console.log(
      "TRANSPORT_ERROR_CODE",
      JSON.stringify({ level: message.type(), code: Number(code) }),
    );
  if (/DATA packet for a stream which doesn.t exist/.test(text))
    console.log("TRANSPORT_WARNING:unknown-stream-data");
  if (message.type() === "error")
    console.log(
      "BROWSER_CONSOLE_ERROR",
      text.replace(/(?:https?|wss?):\/\/\S+/g, "[URL]").slice(0, 350),
    );
});
let socketSerial = 0;
atlas.on("websocket", (socket) => {
  const id = ++socketSerial,
    u = new URL(socket.url());
  console.log(
    "RELAY_SOCKET",
    JSON.stringify({
      event: "created",
      id,
      kind: u.pathname.startsWith("/relay/")
        ? "relay"
        : u.pathname.startsWith("/browse/storage/owner/")
          ? "storage-owner"
          : u.pathname.startsWith("/browse/cookies/owner/")
            ? "cookie-owner"
            : u.pathname.startsWith("/native-resource/v1/owner/")
              ? "resource-owner"
              : "other",
      selectedPort: u.port,
    }),
  );
  socket.on("socketerror", () =>
    console.log("RELAY_SOCKET", JSON.stringify({ event: "error", id })),
  );
  socket.on("close", () =>
    console.log("RELAY_SOCKET", JSON.stringify({ event: "closed", id })),
  );
  let first = true;
  socket.on("framereceived", (event) => {
    if (first) {
      first = false;
      console.log(
        "RELAY_SOCKET",
        JSON.stringify({
          event: "first-frame",
          id,
          bytes: event.payload.length,
        }),
      );
    }
    if (
      Buffer.isBuffer(event.payload) &&
      event.payload[0] === 4 &&
      event.payload.length >= 6
    )
      console.log(
        "RELAY_STREAM_CLOSED",
        JSON.stringify({ id, reason: event.payload[5] }),
      );
  });
});
context.on("response", async (response) => {
  const u = new URL(response.url());
  if (response.ok() && u.pathname === "/api/browse/controller/session") {
    const value = await response.json().catch(() => null);
    if (value?.node)
      console.log(
        "ASSIGNMENT_DEADLINES",
        JSON.stringify({
          node: value.node.name,
          generation: value.generation,
          ticketRemainingMs: value.ticketExpiresAt - Date.now(),
          leaseRemainingMs: value.leaseExpiresAt - Date.now(),
        }),
      );
  }
  if (response.status() >= 400 && u.pathname.startsWith("/api/browse/")) {
    const body = await response.json().catch(() => ({}));
    console.log(
      "BROWSE_HTTP_FAILURE",
      JSON.stringify({
        path: u.pathname.replace(/doc_[a-f0-9]{32}/g, "[document]"),
        method: response.request().method(),
        status: response.status(),
        code: body?.error?.code ?? body?.code ?? null,
      }),
    );
  }
  if (
    response.status() >= 400 &&
    /^\/browse\/(frame|popup)\//.test(u.pathname)
  ) {
    const headers = await response.request().allHeaders();
    const body = await response.json().catch(() => ({}));
    console.log(
      "DOCUMENT_HTTP_FAILURE",
      JSON.stringify({
        kind: u.pathname.split("/")[2],
        status: response.status(),
        cookieNames: (headers.cookie || "")
          .split(";")
          .map((v) =>
            v
              .trim()
              .split("=")[0]
              .replace(/^(__Host-atlas-native-).+$/, "$1[id]"),
          )
          .filter(Boolean),
        origin: headers.origin ?? null,
        fetchSite: headers["sec-fetch-site"] ?? null,
        errorCode: body?.error?.code ?? body?.code ?? null,
      }),
    );
  }
});
atlas.setDefaultTimeout(25000);
atlas.on("pageerror", (e) =>
  errors.push(e.message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 300)),
);
let phase = "sign-in-a";
function record(task, detail = {}) {
  results.push({ task, result: "PASS", ...detail });
  console.log(task + ": PASS");
}
async function login(email) {
  await hub.goto(hubOrigin);
  const signout = hub.getByRole("button", { name: "Sign out", exact: true });
  await signout
    .or(hub.getByLabel("Email address", { exact: true }))
    .first()
    .waitFor();
  if (await signout.isVisible().catch(() => false)) await signout.click();
  await hub.getByLabel("Email address", { exact: true }).fill(email);
  await hub.getByRole("button", { name: "Continue", exact: true }).click();
  const file = hub.getByRole("link", { name: "Open your verification file" });
  await file.waitFor();
  const href = await file.getAttribute("href"),
    url = new URL(href);
  if (
    !(
      url.hostname === "localhost" || url.hostname.endsWith(".atlas.localhost")
    ) ||
    url.protocol !== "https:" ||
    url.port !== "4300" ||
    !url.pathname.startsWith("/__lab/verification/")
  )
    throw Error("Nonlocal verification denied.");
  const body = await (await hub.request.get(href)).text(),
    code = body.match(/Verification code: (\d{6,8})/)?.[1];
  if (!code) throw Error("Missing local verification code.");
  await hub
    .getByRole("textbox", { name: /digit verification code/ })
    .fill(code);
  await hub.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
async function openAtlas() {
  await atlas.goto(origin);
  const signin = atlas.getByRole("button", { name: "Sign in", exact: true });
  await signin
    .or(atlas.getByRole("button", { name: "Your saves", exact: true }))
    .first()
    .waitFor({ timeout: 45000 });
  if (await signin.isVisible()) await signin.click();
  await atlas
    .getByRole("button", { name: "Your saves", exact: true })
    .waitFor({ timeout: 45000 });
  const defaults = atlas.getByRole("button", {
    name: "Use defaults",
    exact: true,
  });
  if (await defaults.isVisible().catch(() => false)) await defaults.click();
}
async function site(path = "storage") {
  await atlas.getByRole("button", { name: "Browser", exact: true }).click();
  const search = atlas
    .getByRole("combobox", { name: "Search the web", exact: true })
    .or(atlas.getByRole("combobox", { name: "Address", exact: true }));
  const input = (await search.count())
    ? search.first()
    : atlas.locator("input[placeholder]").first();
  await input.fill("http://fixture.localhost:4299/" + path);
  await input.press("Enter");
  const f = atlas.frameLocator('iframe[title="Website"]').first();
  await Promise.race([
    f.locator("#count").waitFor({ timeout: 45000 }),
    atlas
      .getByRole("button", { name: "Continue here", exact: true })
      .waitFor({ timeout: 45000 }),
  ]);
  if (
    await atlas
      .getByRole("button", { name: "Continue here", exact: true })
      .isVisible()
      .catch(() => false)
  )
    await atlas
      .getByRole("button", { name: "Continue here", exact: true })
      .click();
  await f.locator("#count").waitFor({ timeout: 130000 });
  return f;
}
async function synced() {
  await expect(
    atlas.getByRole("button", { name: "Your saves", exact: true }),
  ).toHaveText("Synced", { timeout: 45000 });
}
async function signout() {
  await atlas.getByRole("button", { name: "Your saves", exact: true }).click();
  await atlas
    .getByRole("dialog", { name: "Your saves", exact: true })
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await atlas.getByRole("button", { name: "Sign in", exact: true }).waitFor();
}
try {
  await login(emails[0]);
  await openAtlas();
  let f = await site();
  await expect(f.locator("#count")).toHaveText("Count: 0");
  for (let i = 0; i < 2; i++) await f.locator("#count").click();
  await f.locator("#save").click();
  await expect(f.locator("#saved")).toHaveText("Saved 2");
  await synced();
  record("Account A native save receives remote acknowledgement");
  if (process.argv.includes("--cookie-reload-probe")) {
    phase = "cookie-reload-probe";
    await f.locator("#cookie-save").click();
    await expect(f.locator("#cookie-result")).toHaveText("Cookie saved 2");
    await synced();
    console.log("INTEGRATED_STAGE:cookie-probe-native-save-acknowledged");
    await atlas.reload();
    f = await site("storage");
    await expect(f.locator("#count")).toHaveText("Count: 2");
    await f.locator("#cookie-read").click();
    await expect(f.locator("#cookie-result")).toHaveText("Cookie 2");
    record(
      "Native cookie+LS acknowledged save survives actual frontend reload",
    );
  } else {
    if (!process.argv.includes("--integrated-probe")) {
      phase = "profile-sync-api-outage";
      await atlas.route("**/api/hub/profile**", (r) => r.abort("failed"));
      await atlas.route("**/api/hub/branch/profile**", (r) =>
        r.abort("failed"),
      );
      // The browser/frontend and native owners remain reachable; this is explicitly
      // a cloud-profile outage, NOT a full browser-network-offline guarantee.
      await f.locator("#count").click();
      await f.locator("#save").click();
      await expect(f.locator("#saved")).toHaveText("Saved 3");
      await expect(
        atlas.getByRole("button", { name: "Your saves", exact: true }),
      ).not.toHaveText("Synced");
      if (process.argv.includes("--long-outage")) {
        await atlas.waitForTimeout(95000);
        await f.locator("#count").click();
        await f.locator("#save").click();
        await expect(f.locator("#saved")).toHaveText("Saved 4");
      }
      await atlas.screenshot({
        path: join(output, "01-cloud-outage-local-save.png"),
        fullPage: true,
      });
      await atlas.unroute("**/api/hub/profile**");
      await atlas.unroute("**/api/hub/branch/profile**");
      await atlas.evaluate(() => dispatchEvent(new Event("online")));
      await synced();
      await atlas.reload();
      f = await site();
      await expect(f.locator("#count")).toHaveText("Count: " + savedCount);
      record(
        "Profile-sync API outage retains durable local save/outbox; reconnect acknowledgement and reload preserve Count" +
          savedCount,
      );
      phase = "clear-history";
      await atlas
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await atlas
        .getByRole("button", { name: "Privacy & data", exact: true })
        .click();
      await atlas
        .getByRole("button", { name: "Clear history", exact: true })
        .click();
      await synced();
      await atlas.reload();
      // Read only the normal account state through the public UI; no localStorage
      // setup is used to manufacture profile restoration or history assertions.
      await atlas
        .getByRole("button", { name: "Browser", exact: true })
        .waitFor();
      await atlas.getByRole("button", { name: "Browser", exact: true }).click();
      await atlas
        .getByRole("button", { name: "Recently visited", exact: true })
        .click();
      await expect(
        atlas.getByRole("dialog", { name: "Browsing history" }),
      ).toContainText("No browsing history yet.");
      await atlas
        .getByRole("button", { name: "Close history", exact: true })
        .click();
      record(
        "Account-scoped Clear history is remotely acknowledged and remains empty after reload",
      );
      phase = "switch-b";
      await signout();
      await atlas.reload();
      await expect(
        atlas.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await login(emails[1]);
      await openAtlas();
      f = await site();
      await expect(f.locator("#count")).toHaveText("Count: 0");
      await f.locator("#cookie-read").click();
      await expect(f.locator("#cookie-result")).toHaveText("No cookie");
      await f.locator("#idb-read").click();
      await expect(f.locator("#idb-result")).toHaveText("No records");
      await f.locator("#count").click();
      await f.locator("#save").click();
      await expect(f.locator("#saved")).toHaveText("Saved 1");
      await synced();
      await atlas.screenshot({
        path: join(output, "02-account-b-independent.png"),
        fullPage: true,
      });
      record(
        "Same browser/frontend Account B receives no Account A website data; new save independently succeeds",
      );
      phase = "return-a";
      await signout();
      await login(emails[0]);
      await openAtlas();
      f = await site();
      await expect(f.locator("#count")).toHaveText("Count: " + savedCount);
      await synced();
      await atlas.screenshot({
        path: join(output, "03-account-a-restored.png"),
        fullPage: true,
      });
      record(
        "A→B→A preserves separate native profiles and replaces account-bound transport without mismatch",
      );
    }
    if (
      process.argv.includes("--features") ||
      process.argv.includes("--integrated-probe")
    ) {
      // This synthetic loopback journey compresses several sign-ins, reloads and
      // documents into seconds. Preserve the real60/min browsing policy: let its
      // fixed window settle with the current account/frame alive before testing
      // the next workload. This is not a runtime retry or an assertion delay.
      if (!process.argv.includes("--integrated-probe")) {
        console.log(
          "WORKLOAD_PACING:65s between account-switch and integrated-feature workloads; production browsing limits unchanged",
        );
        await atlas.waitForTimeout(65000);
      }
      phase = "integrated-runtime";
      f = await site("frames");
      await expect(f.locator("#count")).toHaveText("Count: " + savedCount);
      await expect(f.locator("#frame-result")).toHaveText("Nested frame ready");
      await expect(f.locator("#module-result")).toHaveText("Module ready");
      await f.locator("#worker").click();
      await expect(f.locator("#worker-result")).toHaveText(
        "Worker ready " + savedCount,
      );
      await f.locator("#module-worker").click();
      await expect(f.locator("#module-worker-result")).toHaveText(
        "Module ready worker " + savedCount,
      );
      await f.locator("#fetch").click();
      await expect(f.locator("#fetch-result")).toHaveText("Fetch ready");
      await f.locator("#idb-save").click();
      await expect(f.locator("#idb-result")).toHaveText(
        "Saved record 1 count " + savedCount,
      );
      await f.locator("#idb-abort").click();
      await expect(f.locator("#idb-result")).toHaveText("Record aborted");
      await f.locator("#idb-read").click();
      await expect(f.locator("#idb-result")).toHaveText(
        `Record 1 count ${savedCount} blob Atlas blob ${savedCount} bytes 1,2,3,${savedCount}`,
      );
      await f.locator("#media").click();
      await expect(f.locator("#media-result")).toHaveText("Media ended");
      record(
        "Actual account runtime renders nested HTTP frame, modules/classic+module workers, fetch, IDB Blob/abort and WAV playback",
      );
      console.log("INTEGRATED_STAGE:popup-open");
      const opened = context.waitForEvent("page", { timeout: 20000 });
      await f.locator("#popup").click();
      const popup = await opened;
      await expect(
        popup.getByRole("heading", { name: "Popup fixture", exact: true }),
      ).toBeVisible();
      await expect(f.locator("#popup-result")).toHaveText("Popup ready");
      const physical = new URL(popup.url());
      if (
        physical.origin !== origin ||
        !physical.pathname.startsWith("/browse/popup/") ||
        physical.hash
      )
        throw Error("Popup physical URL is not reserved on current frontend.");
      await popup.close();
      console.log("INTEGRATED_STAGE:popup-message-close-passed");
      await expect(f.locator("#count")).toHaveText("Count: " + savedCount);
      // A native-resource enrollment on Main leaves a partitioned HttpOnly
      // cookie on this frontend. It must not break opaque commit receipts.
      await f.locator("#count").click();
      await f.locator("#save").click();
      await expect(f.locator("#saved")).toHaveText("Saved " + (savedCount + 1));
      await f.locator("#cookie-save").click();
      await expect(f.locator("#cookie-result")).toHaveText(
        "Cookie saved " + (savedCount + 1),
      );
      await synced();
      console.log("INTEGRATED_STAGE:post-popup-native-save-acknowledged");
      await atlas.reload();
      console.log("INTEGRATED_STAGE:post-popup-main-reloaded");
      f = await site("frames");
      await expect(f.locator("#count")).toHaveText(
        "Count: " + (savedCount + 1),
      );
      await expect(f.locator("#frame-result")).toHaveText("Nested frame ready");
      await f.locator("#cookie-read").click();
      await expect(f.locator("#cookie-result")).toHaveText(
        "Cookie " + (savedCount + 1),
      );
      await atlas.screenshot({
        path: join(output, "05-integrated-runtime.png"),
        fullPage: true,
      });
      record(
        "User-activated opaque same-frontend popup exchanges logical opener message and closes without reloading parent",
      );
    }
    phase = "text-scale";
    await atlas.setViewportSize({ width: 1366, height: 768 });
    await atlas.evaluate(() => {
      // Root-font alone misses Atlas's explicit px typography. Double every
      // computed text size from one pre-mutation snapshot, like text-only zoom.
      const fonts = [document.body, ...document.body.querySelectorAll("*")]
        .filter((element) => element instanceof HTMLElement)
        .map((element) => [
          element,
          parseFloat(getComputedStyle(element).fontSize),
        ]);
      for (const [element, size] of fonts)
        if (Number.isFinite(size))
          element.style.setProperty("font-size", `${size * 2}px`, "important");
    });
    await expect(atlas.locator(".sidebar-heading")).toContainText(/\d+ tabs?/);
    await atlas.screenshot({
      path: join(output, "04-condensed-count-200-percent.png"),
      fullPage: true,
    });
    record("Condensed rail keeps a readable count at200% text scaling");
  }
  await writeFile(
    join(output, "account-results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (e) {
  const offers = await atlas
    .evaluate(() => window.__atlasLabOffers ?? [])
    .catch(() => []);
  console.log(
    "BOOTSTRAP_OFFER_DIAGNOSTIC",
    JSON.stringify(
      offers.map((value) => ({
        depth: value.depth,
        origin: value.origin,
        known: reservationNonces.has(value.documentId),
        nonceMatches:
          reservationNonces.get(value.documentId)?.nonce === value.nonce,
        nested: reservationNonces.get(value.documentId)?.nested,
      })),
    ),
  );
  console.log(
    "LOGICAL_FRAME_DIAGNOSTIC",
    JSON.stringify(
      await Promise.all(
        atlas
          .frames()
          .filter((frame) => {
            try {
              return new URL(frame.url()).pathname.startsWith("/browse/frame/");
            } catch {
              return false;
            }
          })
          .map(async (frame) => ({
            depth: (() => {
              let n = 0,
                p = frame.parentFrame();
              while (p) {
                n++;
                p = p.parentFrame();
              }
              return n;
            })(),
            state: await frame
              .evaluate(() => ({
                title: document.title,
                readyState: document.readyState,
                heading: document.querySelector("h1")?.textContent ?? null,
                body: document.body?.innerText?.slice(0, 100) ?? null,
                frameResult:
                  document.querySelector("#frame-result")?.textContent ?? null,
                messages: window.__atlasLabFixtureMessages ?? null,
                ports: window.__atlasLabPortStages ?? null,
                logicalPath: location.pathname.startsWith("/browse/")
                  ? "reserved-bootstrap"
                  : location.pathname,
                children: Array.from(document.querySelectorAll("iframe")).map(
                  (f) => ({ title: f.title, connected: f.isConnected }),
                ),
                scriptCount: document.scripts.length,
                assetLoaded: performance
                  .getEntriesByType("resource")
                  .filter((e) => e.name.includes("/browse/assets/document-"))
                  .length,
              }))
              .catch((error) => ({ error: error.name })),
          })),
      ),
    ),
  );
  console.log(
    "VISIBLE_FRAME_DIAGNOSTIC",
    JSON.stringify(
      await atlas
        .locator('iframe[title="Website"]')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              hidden: element.closest("[hidden]") !== null,
              width: rect.width,
              height: rect.height,
            };
          }),
        )
        .catch(() => []),
    ),
  );
  await hub
    .screenshot({ path: join(output, "hub-failure.png"), fullPage: true })
    .catch(() => {});
  await atlas
    .screenshot({ path: join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    join(output, "account-results.json"),
    JSON.stringify(
      { complete: false, phase, results, errors, error: e.message },
      null,
      2,
    ),
  );
  console.error(phase + ": " + e.stack);
  process.exitCode = 1;
} finally {
  await browser.close();
}
