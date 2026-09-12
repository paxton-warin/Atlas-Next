// Observes logged-out public pages through the actual running startup process.
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const observations = [];
try {
  for (const [name, url] of [
    ["DuckDuckGo", "https://duckduckgo.com/?q=hello"],
    ["Google", "https://www.google.com/"],
    ["Spotify", "https://open.spotify.com/"],
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("http://localhost:4180");
    await page.getByRole("button", { name: "Use defaults" }).click();
    await page.getByLabel("Search the web").fill(url);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]');
    let text = "",
      title = "";
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1000);
      text = await site
        .locator("body")
        .innerText({ timeout: 1500 })
        .catch(() => "");
      title = await site
        .locator("title")
        .textContent({ timeout: 1000 })
        .catch(() => "");
      if (text.trim().length > 80) break;
    }
    const status =
      text.trim().length > 80
        ? "PUBLIC_PAGE_RENDERED"
        : /moment|verify|challenge/i.test(title)
          ? "PROVIDER_CHALLENGE"
          : "NO_VISIBLE_CONTENT";
    observations.push({
      site: name,
      url,
      status,
      title,
      excerpt: text.slice(0, 350),
      authenticated: "NOT_TESTED",
    });
    console.log(name + ": " + status);
    await page.screenshot({
      path: "evidence/ui-refinement/live-" + name.toLowerCase() + ".png",
    });
    await context.close();
  }
} finally {
  await writeFile(
    "evidence/ui-refinement/live-browsing.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: browser.version(),
        observations,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
