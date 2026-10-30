#!/usr/bin/env node
/** Native baseline of the deterministic fixture, not a proxy/runtime qualification. */
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { serveLabFixture } from "./hub-lab-fixture.mjs";
const server = createServer(serveLabFixture);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage(),
    origin = "http://127.0.0.1:" + server.address().port;
  await page.goto(origin);
  await page.locator("#count").click();
  await page.locator("#count").click();
  await page.locator("#save").click();
  await page.locator("#idb-save").click();
  await page
    .locator("#idb-result")
    .filter({ hasText: "Saved record 1 count 2" })
    .waitFor();
  await page.locator("#cookie-save").click();
  await page.locator("#idb-abort").click();
  await page
    .locator("#idb-result")
    .filter({ hasText: "Record aborted" })
    .waitFor();
  await page.reload();
  await page.locator("#count").filter({ hasText: "Count: 2" }).waitFor();
  await page.locator("#idb-read").click();
  await page
    .locator("#idb-result")
    .filter({ hasText: "Record 1 count 2 blob Atlas blob 2 bytes 1,2,3,2" })
    .waitFor();
  await page.locator("#cookie-read").click();
  await page
    .locator("#cookie-result")
    .filter({ hasText: "Cookie 2" })
    .waitFor();
  await page.locator("#worker").click();
  await page
    .locator("#worker-result")
    .filter({ hasText: "Worker ready 2" })
    .waitFor();
  await page.locator("#module-worker").click();
  await page
    .locator("#module-worker-result")
    .filter({ hasText: "Module ready worker 2" })
    .waitFor();
  await page
    .locator("#frame-result")
    .filter({ hasText: "Nested frame ready" })
    .waitFor();
  const popupPromise = page.waitForEvent("popup");
  await page.locator("#popup").click();
  const popup = await popupPromise;
  await popup.getByRole("heading", { name: "Popup fixture" }).waitFor();
  await page
    .locator("#popup-result")
    .filter({ hasText: "Popup ready" })
    .waitFor();
  await page.locator("#fetch").click();
  await page
    .locator("#fetch-result")
    .filter({ hasText: "Fetch ready" })
    .waitFor();
  await page.locator("#media").click();
  await page
    .locator("#media-result")
    .filter({ hasText: /Media (playing|ended)/ })
    .waitFor();
  console.log(
    "NATIVE_FIXTURE_LS_IDB_BLOB_ABORT_COOKIE_MODULE_WORKERS_FRAME_POPUP_FETCH_MEDIA_PASS",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
