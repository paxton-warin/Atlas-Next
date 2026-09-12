// Logged-out observations only. No account credentials, traces, or cookie exports.
// Run while `node tests/serve.mjs` is serving the disposable baseline and Atlas.
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const results = [];
try {
  for (const [name, url] of [
    ["Google", "https://www.google.com/"],
    ["ChatGPT", "https://chatgpt.com/"],
    ["Spotify", "https://open.spotify.com/"],
  ]) {
    await Promise.all(
      ["demo", "Atlas"].map(async (target) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const start = Date.now();
        const row = {
          site: name,
          target,
          url,
          observation: "NO_VISIBLE_CONTENT",
          authenticated: "NOT_TESTED",
          elapsedMs: 0,
          title: "",
          excerpt: "",
        };
        try {
          let site;
          if (target === "demo") {
            await page.goto(
              "http://127.0.0.1:4182/?goto=" + encodeURIComponent(url),
            );
            site = page.frameLocator(".browser-view iframe");
          } else {
            await page.goto("http://localhost:4180");
            await page.getByRole("button", { name: "Use defaults" }).click();
            await page.getByLabel("Search the web").fill(url);
            await page
              .getByRole("button", { name: "Search", exact: true })
              .click();
            site = page
              .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
              .frameLocator('iframe[title="Proxied website"]');
          }
          for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(2000);
            let body = await site
              .locator("body")
              .innerText({ timeout: 2000 })
              .catch(() => "");
            row.title = await site
              .locator("title")
              .textContent({ timeout: 1000 })
              .catch(() => "");
            if (/just a moment/i.test(row.title || "")) {
              row.observation = "PROVIDER_CHALLENGE";
              row.excerpt =
                "Challenge interstitial; no automated interaction attempted.";
              break;
            }
            if (body.trim().length > 70) {
              row.title = await site
                .locator("title")
                .innerText({ timeout: 1000 })
                .catch(() => "");
              row.excerpt = body.trim().slice(0, 500);
              row.observation =
                /verify you are human|checking your browser|just a moment|unusual traffic/i.test(
                  body,
                )
                  ? "PROVIDER_CHALLENGE"
                  : /502 bad gateway|proxy error|failed to fetch|ERR_/i.test(
                        body,
                      )
                    ? "VISIBLE_ERROR"
                    : "LOGGED_OUT_CONTENT_RENDERED";
              break;
            }
          }
          await page.screenshot({
            path:
              "evidence/public-" +
              name.toLowerCase() +
              "-" +
              target.toLowerCase() +
              ".png",
          });
        } catch (e) {
          row.observation = "ERROR";
          row.excerpt = e.message.slice(0, 300);
        }
        row.elapsedMs = Date.now() - start;
        results.push(row);
        console.log(name + " " + target + ": " + row.observation);
        await context.close();
      }),
    );
  }
} finally {
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    source: "4f452feec4d6804730b903294d0f9bec8002a635",
    baseline: "e9ff92d1ec98ba140cb4bca840fb40c2b9b52ebf",
    purpose:
      "Logged-out rendering observation. Not sign-in, streaming, playback, or ChromeOS qualification.",
    results,
  };
  await writeFile(
    "evidence/public-smoke.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
