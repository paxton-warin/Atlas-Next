// Inspect the real built catalog with a fresh database and browser.
// No external game launch or provider connection is required.
import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.mjs";

const dir = mkdtempSync(join(tmpdir(), "atlas-overlay-"));
const output = process.argv[3];
if (output) mkdirSync(output, { recursive: true });
const app = await createApp({
  dataDir: dir,
  appOrigin: "http://localhost:4380",
  runtimeOrigin: "http://127.0.0.1:4381",
  staticDir: resolve(process.argv[2] || "dist", "web"),
});
let browser;
const results = [];
try {
  await app.listen({ host: "127.0.0.1", port: 4380 });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.route("http://127.0.0.1:4381/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>Fixture</title>" }),
  );
  await page.goto("http://localhost:4380");
  await page.getByRole("button", { name: "Use defaults", exact: true }).click();
  for (const [section, names] of [
    [
      "Games",
      [
        "Minecraft Classic",
        "Tic Tac Toe",
        "Snake",
        "Hextris",
        "Little Alchemy 2",
        "Lichess",
        "2048",
      ],
    ],
    ["Apps", ["Spotify"]],
  ]) {
    await page
      .locator(".main-nav")
      .getByRole("button", { name: section, exact: true })
      .click();
    for (const name of names) {
      await page
        .getByLabel(`Search ${section.toLowerCase()}`, { exact: true })
        .fill(name);
      const card = page.getByRole("button", {
        name: `${section === "Games" ? "Play" : "Open"} ${name}`,
        exact: true,
      });
      await card.hover();
      await card.locator(".play-overlay").waitFor({ state: "visible" });
      await card
        .locator("img")
        .evaluateAll((images) =>
          Promise.all(images.map((img) => img.decode().catch(() => {}))),
        );
      const computed = await card.locator(".play-overlay").evaluate((el) => {
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect(),
          parent = el.parentElement.getBoundingClientRect();
        return {
          fontSize: s.fontSize,
          fontFamily: s.fontFamily,
          letterSpacing: s.letterSpacing,
          transform: s.transform,
          textShadow: s.textShadow,
          filter: s.filter,
          centered:
            Math.abs(box.x - parent.x) < 1 &&
            Math.abs(box.y - parent.y) < 1 &&
            Math.abs(box.width - parent.width) < 1 &&
            Math.abs(box.height - parent.height) < 1,
        };
      });
      const passed =
        computed.fontSize === "14px" &&
        computed.fontFamily === "Inter, sans-serif" &&
        computed.letterSpacing === "normal" &&
        computed.transform === "none" &&
        computed.textShadow === "none" &&
        computed.filter === "none" &&
        computed.centered;
      results.push({ name, passed, ...computed });
      if (output)
        await card
          .locator("..")
          .screenshot({
            path: join(
              output,
              name.toLowerCase().replaceAll(" ", "-") + ".png",
            ),
            animations: "disabled",
          });
    }
  }
  if (output)
    writeFileSync(
      join(output, "computed.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
  console.log(
    results
      .map(
        ({ name, passed }) =>
          `${name.toUpperCase().replaceAll(" ", "_")}=${passed ? "PASS" : "FAIL"}`,
      )
      .join("; "),
  );
  console.log(
    `OVERLAY_PASS=${results.filter((r) => r.passed).length}; OVERLAY_FAIL=${results.filter((r) => !r.passed).length}`,
  );
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
