import { test, expect, type Page } from "@playwright/test";

const target = "https://www.youtube.com/watch?v=fixture";
const website = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
const playerPayload = {
  playerAds: [{ kind: "player-ad" }],
  adPlacements: [{ kind: "placement" }],
  adSlots: [{ kind: "slot" }],
  videoDetails: { title: "Normal video", videoId: "fixture" },
  streamingData: {
    formats: [
      { url: "https://video.googlevideo.com/videoplayback?id=fixture" },
    ],
  },
  captions: { text: "Preserved captions" },
};
const html = `<!doctype html><html><head><title>YouTube filter fixture</title></head><body>
<h1>YouTube filter fixture</h1>
<ytd-display-ad-renderer id="ad-card">Advertisement card</ytd-display-ad-renderer>
<div id="real-video">Normal video player</div>
<pre id="initial"></pre><pre id="fetch-result"></pre><pre id="xhr-result"></pre><pre id="network-result"></pre>
<button id="fetch">Fetch player</button><button id="xhr">XHR player</button><button id="network">Test resource routing</button>
<script>
window.ytInitialPlayerResponse=${JSON.stringify(playerPayload)};
window.ytInitialData={playerResponse:${JSON.stringify(playerPayload)},contents:[{title:"Ordinary recommendation"}]};
document.getElementById('initial').textContent=JSON.stringify({player:window.ytInitialPlayerResponse,data:window.ytInitialData});
document.getElementById('fetch').onclick=async()=>{document.getElementById('fetch-result').textContent=JSON.stringify(await fetch('/youtubei/v1/player?mode=fetch',{method:'POST',body:'{}'}).then(r=>r.json()))};
document.getElementById('xhr').onclick=()=>{const xhr=new XMLHttpRequest();xhr.open('POST','/youtubei/v1/player?mode=xhr');xhr.onload=()=>{document.getElementById('xhr-result').textContent=xhr.responseText};xhr.send('{}')};
document.getElementById('network').onclick=async()=>{const urls=['https://googleads.g.doubleclick.net/pagead/fixture','https://www.youtube.com/api/stats/ads','https://video.googlevideo.com/videoplayback?id=fixture'];const results=await Promise.all(urls.map(async url=>{const r=await fetch(url);return{url,status:r.status,text:await r.text()}}));document.getElementById('network-result').textContent=JSON.stringify(results)};
</script></body></html>`;

for (const enabled of [true, false]) {
  test(`YouTube filtering ${enabled ? "defaults on" : "respects explicit opt-out"} in the real engine: initial data, fetch, XHR, cards and stream routing`, async ({
    page,
  }) => {
    await page.addInitScript((enabled) => {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({
          tabs: "top",
          motion: false,
          ...(enabled ? {} : { youtubeAdblock: false }),
        }),
      );
    }, enabled);
    await page.goto("/");
    await page
      .getByLabel("Search the web")
      .fill("http://127.0.0.1:4199/fixture");
    await page.getByLabel("Search the web").press("Enter");
    await expect(
      website(page).getByRole("heading", { name: "Proxy fixture ready" }),
    ).toBeVisible();
    const runtime = page
      .frames()
      .find(
        (frame) =>
          frame.parentFrame() === page.mainFrame() &&
          frame.url().startsWith("http://127.0.0.1:4181"),
      )!;
    await runtime.evaluate(
      ({ html, payload }) => {
        const globals = window as any;
        const element = document.querySelector(
          'iframe[title="Proxied website"]',
        )! as any;
        const frame = element[Symbol.for("controller frame handle")];
        if (!frame) throw Error("Missing actual controller frame");
        globals.__youtubeFixtureRequests = [];
        const { ManagedPlugin } = globals.$runtimekitController;
        const plugin = new (class extends ManagedPlugin {
          constructor() {
            super("youtube-browser-fixture", []);
          }
          install(frame: any) {
            super.install(frame);
            this.tap(
              frame.hooks.fetch.request,
              ({ parsed }: any, props: any) => {
                const url = new URL(String(parsed.url));
                globals.__youtubeFixtureRequests.push(url.href);
                let body = "not found",
                  status = 404,
                  type = "text/plain";
                if (
                  url.hostname === "www.youtube.com" &&
                  url.pathname === "/watch"
                ) {
                  body = html;
                  status = 200;
                  type = "text/html";
                } else if (
                  url.hostname === "www.youtube.com" &&
                  url.pathname === "/youtubei/v1/player"
                ) {
                  body = JSON.stringify(payload);
                  status = 200;
                  type = "application/json";
                } else if (url.hostname === "video.googlevideo.com") {
                  body = "original stream bytes";
                  status = 200;
                } else if (
                  url.hostname === "googleads.g.doubleclick.net" ||
                  url.pathname === "/api/stats/ads"
                ) {
                  body = "ad request reached fixture";
                  status = 200;
                }
                props.earlyResponse =
                  globals.$runtimekit.ChannelResponse.fromNativeResponse(
                    new Response(body, {
                      status,
                      headers: {
                        "Content-Type": type,
                        "Cache-Control": "no-store",
                        "Access-Control-Allow-Origin": "*",
                      },
                    }),
                  );
              },
            );
          }
        })();
        frame.plugins.push(plugin);
        plugin.install(frame);
      },
      { html, payload: playerPayload },
    );
    await page.getByLabel("Address bar").fill(target);
    await page.getByLabel("Address bar").press("Enter");
    await expect(
      website(page).getByRole("heading", { name: "YouTube filter fixture" }),
    ).toBeVisible();
    await expect(website(page).locator("#initial")).not.toBeEmpty();
    const initial = JSON.parse(
      (await website(page).locator("#initial").textContent())!,
    );
    const checkPlayer = (payload: any, filtered = enabled) => {
      for (const key of ["playerAds", "adPlacements", "adSlots"])
        if (filtered) expect(payload).not.toHaveProperty(key);
        else
          expect(payload).toHaveProperty(
            key,
            playerPayload[key as keyof typeof playerPayload],
          );
      expect(payload.videoDetails).toEqual(playerPayload.videoDetails);
      expect(payload.streamingData).toEqual(playerPayload.streamingData);
      expect(payload.captions).toEqual(playerPayload.captions);
    };
    checkPlayer(initial.player);
    checkPlayer(initial.data.playerResponse);
    expect(initial.data.contents).toEqual([
      { title: "Ordinary recommendation" },
    ]);
    await expect(website(page).locator("#ad-card")).toBeVisible({
      visible: !enabled,
    });
    await expect(website(page).locator("#real-video")).toBeVisible();
    await website(page)
      .getByRole("button", { name: "Fetch player", exact: true })
      .click();
    await expect(website(page).locator("#fetch-result")).not.toBeEmpty();
    checkPlayer(
      JSON.parse((await website(page).locator("#fetch-result").textContent())!),
    );
    await website(page)
      .getByRole("button", { name: "XHR player", exact: true })
      .click();
    await expect(website(page).locator("#xhr-result")).not.toBeEmpty();
    checkPlayer(
      JSON.parse((await website(page).locator("#xhr-result").textContent())!),
    );
    await website(page)
      .getByRole("button", { name: "Test resource routing", exact: true })
      .click();
    await expect(website(page).locator("#network-result")).not.toBeEmpty();
    const results = JSON.parse(
      (await website(page).locator("#network-result").textContent())!,
    );
    expect(results.map((r: any) => r.status)).toEqual(
      enabled ? [204, 204, 200] : [200, 200, 200],
    );
    expect(results[2].text).toBe("original stream bytes");
    const requests: string[] = await runtime.evaluate(
      () => (window as any).__youtubeFixtureRequests,
    );
    expect(requests).toContain(
      "https://video.googlevideo.com/videoplayback?id=fixture",
    );
    for (const ad of [
      "https://googleads.g.doubleclick.net/pagead/fixture",
      "https://www.youtube.com/api/stats/ads",
    ])
      expect(requests.includes(ad)).toBe(!enabled);
    await page.screenshot({
      path: `evidence/focus-tabs/youtube-${enabled ? "on" : "off"}.png`,
    });
    const sessionBefore = await page.evaluate(() =>
      localStorage.getItem("atlas.nodeSession"),
    );
    await runtime.evaluate(() => {
      (window as any).__youtubeOriginalFrame = document.querySelector(
        'iframe[title="Proxied website"]',
      );
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator(".settings-nav")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    const toggle = page.getByRole("switch", {
      name: "YouTube ad blocker",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", String(!enabled));
    await page
      .locator(".main-nav")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    const reload = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame.parentFrame() === runtime,
    });
    await page
      .getByRole("button", { name: "Reload page", exact: true })
      .click();
    await reload;
    await expect(
      website(page).getByRole("heading", { name: "YouTube filter fixture" }),
    ).toBeVisible();
    await expect(website(page).locator("#initial")).not.toBeEmpty();
    const changed = JSON.parse(
      (await website(page).locator("#initial").textContent())!,
    );
    checkPlayer(changed.player, !enabled);
    checkPlayer(changed.data.playerResponse, !enabled);
    await expect(website(page).locator("#ad-card")).toBeVisible({
      visible: enabled,
    });
    await expect(website(page).locator("#real-video")).toBeVisible();
    await website(page)
      .getByRole("button", { name: "Fetch player", exact: true })
      .click();
    await expect(website(page).locator("#fetch-result")).not.toBeEmpty();
    checkPlayer(
      JSON.parse((await website(page).locator("#fetch-result").textContent())!),
      !enabled,
    );
    expect(
      await runtime.evaluate(
        () =>
          (window as any).__youtubeOriginalFrame ===
          document.querySelector('iframe[title="Proxied website"]'),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
    ).toBe(sessionBefore);
  });
}
