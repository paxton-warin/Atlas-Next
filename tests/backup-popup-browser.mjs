import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import Popup from'./LocalFirstBackupStatus.tsx';import'./styles.css';import'./HubGate.css';import'./v21-tokens.css';
window.fixture={calls:{backup:0,list:0,latest:0,check:0},error:null,hold:false,latestURL:undefined,profile:{async retry(){fixture.calls.backup++;if(fixture.hold)await new Promise(r=>fixture.release=r);if(fixture.error)throw fixture.error},async checkLatest(){fixture.calls.check++;return null},async loadLatest(){fixture.calls.latest++;if(fixture.hold)await new Promise(r=>fixture.release=r);return fixture.latestURL},backup:{async list(){fixture.calls.list++;return{checkpoints:[{checkpointId:'22222222-2222-4222-8222-222222222222',label:'Browser at a-very-long-frontend-address-for-wrapping.example.cloudfront.net',origin:location.origin,completedAt:'2026-10-28T17:00:00Z',sequence:1}],nextCursor:null}}}}};
const root=createRoot(document.getElementById('root'));window.renderPopup=(changes={})=>{window.state={local:'ready',legacy:[],freshWorkspace:true,legacyDataNotImported:true,restoreUnavailable:true,...changes,backup:{state:'pending',message:'Internal worker status should not appear verbatim',deferred:[],...(changes.backup??{})}};root.render(<Popup status={state}/>)};renderPopup();`;
const result = await build({
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outfile: "fixture.js",
  logLevel: "silent",
  plugins: [
    {
      name: "fixture-profile",
      setup(b) {
        b.onResolve({ filter: /^\.\/profile-client$/ }, (args) =>
          args.importer.endsWith("LocalFirstBackupStatus.tsx")
            ? { path: "fixture-profile", namespace: "profile" }
            : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "profile" }, () => ({
          contents:
            "export function getLocalFirstProfile(){return window.fixture.profile}",
          loader: "js",
        }));
      },
    },
  ],
  stdin: { resolveDir: resolve("web/src"), contents: fixture, loader: "tsx" },
});
const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text,
  css = result.outputFiles.find((f) => f.path.endsWith(".css")).text;
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send(
      '<!doctype html><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/fixture.css"><body class="atlas-v21" data-v21-theme="forest" data-v21-mode="dark"><div id="root" style="position:fixed;top:24px;left:16px"></div><script type="module" src="/fixture.js"></script>',
    ),
);
app.get("/fixture.js", (_q, r) => r.type("application/javascript").send(js));
app.get("/fixture.css", (_q, r) => r.type("text/css").send(css));
app.get("/fonts.css", async (_q, r) =>
  r.type("text/css").send(await readFile("web/public/fonts.css")),
);
app.get("/fonts/*", async (q, r) => {
  const p = resolve("web/public/fonts", q.params["*"]);
  if (!p.startsWith(resolve("web/public/fonts") + "/"))
    return r.code(404).send();
  return r.type("font/woff2").send(await readFile(p));
});
const E = resolve(process.env.ATLAS_EVIDENCE_DIR || "evidence/cross-link-backup-fix-20261028/popup"),
  report = {
    command: "node tests/backup-popup-browser.mjs",
    productionChanged: false,
    checks: [],
  };
let browser;
try {
  await mkdir(E, { recursive: true });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  report.browser = browser.version();
  const page = await browser.newPage({
    viewport: { width: 1366, height: 768 },
  });
  await page.goto(base);
  await page.getByRole("button", { name: "Your saves", exact: true }).waitFor();
  const trigger = page.getByRole("button", { name: "Your saves", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Your saves" });
  await dialog.waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Close saves" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Backup versions", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Close saves" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await trigger.evaluate((el) => el === document.activeElement),
    true,
  );
  await trigger.click();
  const body = await dialog.innerText();
  assert.ok(
    !/workspace|legacy|independent|incarnation|Internal worker/.test(body),
  );
  assert.ok(
    body.includes("Saved locally") &&
      body.includes("Backup pending") &&
      body.includes("Last backup: Not yet"),
  );
  await page.evaluate(() => {
    fixture.hold = true;
  });
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Backing up…", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() => {
    fixture.hold = false;
    fixture.release();
  });
  await page
    .getByRole("button", { name: "Back up now", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => fixture.calls.backup), 1);
  assert.ok((await dialog.innerText()).includes("Backup pending"));
  await page.evaluate(() => {
    fixture.error = { code: "HUB_QUOTA", message: "private technical payload" };
  });
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByRole("alert").innerText(),
    "Backup storage is full. Contact support.",
  );
  await page.evaluate(() => {
    fixture.error = null;
  });
  await page.evaluate(() =>
    renderPopup({
      backup: {
        state: "idle",
        message: "",
        deferred: [],
        lastCompleted: {
          checkpointId: "ack",
          completedAt: "2026-10-28T18:00:00Z",
        },
      },
    }),
  );
  await page.evaluate(() => {
    fixture.hold = true;
  });
  await page.getByRole("button", { name: "Load latest", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Loading…", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() => {
    fixture.hold = false;
    fixture.release();
  });
  await page.getByText("No newer backup available.", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).search, "");
  await page.evaluate(() => {
    fixture.latestURL =
      "https://outside.example/?backupVersion=22222222-2222-4222-8222-222222222222&activateBackup=1";
  });
  await page.getByRole("button", { name: "Load latest", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(new URL(page.url()).search, "");
  await page
    .getByRole("button", { name: "Backup versions", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Completed backup versions" })
    .waitFor();
  for (const [width, height, textScale] of [
    [1366, 768, 1],
    [390, 844, 1],
    [320, 844, 1],
    [320, 844, 2],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((scale) => {
      let s = document.getElementById("text-scale");
      if (!s) {
        s = document.createElement("style");
        s.id = "text-scale";
        document.head.append(s);
      }
      s.textContent =
        scale === 2
          ? ".local-first-backup-menu,.local-first-backup-menu button,.local-first-backup-menu a{font-size:28px!important}.local-first-backup-menu h2{font-size:36px!important}.local-first-backup-menu time,.local-first-backup-menu .backup-time{font-size:24px!important}"
          : "";
    }, textScale);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    const bounds = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        controls: [...el.querySelectorAll("button,a")].map((x) => ({
          text: x.textContent,
          height: x.getBoundingClientRect().height,
        })),
      };
    });
    assert.ok(
      bounds.left >= 0 &&
        bounds.right <= width &&
        bounds.top >= 0 &&
        bounds.bottom <= height,
      JSON.stringify(bounds),
    );
    assert.ok(
      bounds.scrollWidth <= bounds.clientWidth,
      "no horizontal overflow",
    );
    assert.ok(
      bounds.controls.every((x) => x.height >= 44),
      "44px action targets",
    );
    const image = `${width}x${height}-text${textScale}.png`;
    await page.screenshot({ path: resolve(E, image), fullPage: true });
    report.checks.push({ width, height, textScale, bounds, image });
  }
  const versionLink = page.getByRole("link").first();
  await versionLink.focus();
  const focusedBounds = await versionLink.boundingBox(),
    menuBounds = await dialog.boundingBox();
  assert.ok(
    focusedBounds.y >= menuBounds.y &&
      focusedBounds.y + focusedBounds.height <=
        menuBounds.y + menuBounds.height + 1,
    "keyboard can reach internally scrolled versions",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Close saves" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.evaluate(() => {
    renderPopup({ backup: { state: "pending", message: "", deferred: [] } });
    fixture.latestURL =
      location.origin +
      "/?backupVersion=22222222-2222-4222-8222-222222222222&activateBackup=1";
  });
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Load latest", exact: true }).click();
  assert.equal(
    new URL(page.url()).search,
    "",
    "cancel leaves current workspace open",
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Load latest", exact: true }).click();
  await page.waitForURL("**/?backupVersion=*&activateBackup=1");
  report.latestNavigation = {
    origin: new URL(page.url()).origin,
    backupVersion: new URL(page.url()).searchParams.get("backupVersion"),
    activateBackup: new URL(page.url()).searchParams.get("activateBackup"),
  };
  report.result = "PASS";
  console.log(
    "BACKUP_POPUP PASS concise honest status; keyboard/focus; single backup action; latest URL validation; responsive320px/200%text/44px targets",
  );
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir(E, { recursive: true });
  await writeFile(
    resolve(E, "POPUP_BROWSER.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await app.close();
}
