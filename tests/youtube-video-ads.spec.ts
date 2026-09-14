import { test, expect, type Page } from "@playwright/test";

const payload = {
  playerAds: [{ kind: "video-ad" }],
  adPlacements: [{ kind: "placement" }],
  adSlots: [{ kind: "slot" }],
  videoDetails: { videoId: "fixture", title: "Original video" },
  streamingData: {
    formats: [
      { url: "https://video.googlevideo.com/videoplayback?id=fixture" },
    ],
  },
  captions: { text: "Original captions" },
};
const envelope = [
  {
    playerResponse: payload,
    response: { contents: [{ title: "Original recommendation" }] },
  },
];
const site = (page: Page) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');

const html = `<!doctype html><html><head><title>YouTube video-ad fixture</title>
<style>body{font:16px sans-serif}button{padding:10px;margin:8px}video{width:320px;height:180px}.html5-video-player{min-height:60px;border:1px solid #aaa;padding:12px}.hidden{display:none}</style>
</head><body><h1>YouTube video-ad fixture</h1>
<pre id="initial"></pre><pre id="json"></pre><pre id="state">ready</pre>
<button id="metadata">Populate late player metadata</button>
<button id="json-fetch">Fetch navigation envelopes</button>
<button id="start-ad">Start delayed skip ad</button>
<button id="replace-player">Replace player during SPA navigation</button>
<button id="controls">Add out-of-scope controls</button>
<button id="ssap">Start recognized stitched ad</button>
<button id="normal">Start normal video with stale ad class</button>
<div id="movie_player" class="html5-video-player"><video id="original-media" controls preload="none"></video></div>
<div id="outside"></div><div id="additional"></div>
<script>
const fixturePayload=${JSON.stringify(payload)};
const initial={videoDetails:fixturePayload.videoDetails,streamingData:fixturePayload.streamingData,captions:fixturePayload.captions};
window.ytInitialPlayerResponse=initial;
window.__playerFixture={clicks:0,invalidClicks:0,seekCalls:[],initialSameReference:window.ytInitialPlayerResponse===initial};
const state=()=>document.getElementById('state').textContent=JSON.stringify(window.__playerFixture);
const installApi=player=>{
  player.getStatsForNerds=()=>({debug_info:player.dataset.debug||'SSAP, VIDEO'});
  player.getProgressState=()=>({current:3,duration:20});
  player.seekTo=seconds=>{window.__playerFixture.seekCalls.push(seconds);player.classList.remove('ad-showing','ad-interrupting');player.dataset.debug='SSAP, VIDEO';state()};
};
installApi(document.getElementById('movie_player'));
const skipButton=(player,selector='ytp-skip-ad-button')=>{
 const button=document.createElement('button');button.className=selector;button.textContent='Skip ad';
 button.onclick=()=>{window.__playerFixture.clicks++;player.classList.remove('ad-showing','ad-interrupting');button.remove();state()};
 player.append(button);
};
document.getElementById('metadata').onclick=()=>{
 initial.playerAds=fixturePayload.playerAds;initial.adPlacements=fixturePayload.adPlacements;initial.adSlots=fixturePayload.adSlots;
 document.getElementById('initial').textContent=JSON.stringify({player:window.ytInitialPlayerResponse,held:initial,same:window.ytInitialPlayerResponse===initial});
};
document.getElementById('json-fetch').onclick=async()=>{
 const responses=[];for(const url of ['/youtubei/v1/get_watch?video_id=fixture','/watch?pbj=1&v=fixture','/playlist?pbj=1&list=fixture']) responses.push(await fetch(url).then(r=>r.json()));
 document.getElementById('json').textContent=JSON.stringify(responses);
};
document.getElementById('start-ad').onclick=()=>{
 const player=document.getElementById('movie_player');player.classList.add('ad-showing');
 setTimeout(()=>skipButton(player),40);
};
document.getElementById('replace-player').onclick=()=>{
 const old=document.getElementById('movie_player');const player=document.createElement('div');player.id='movie_player';player.className='html5-video-player ad-interrupting';
 player.innerHTML='<video controls preload="none"></video>';installApi(player);old.replaceWith(player);
 setTimeout(()=>skipButton(player,'ytp-ad-skip-button-modern'),40);
};
document.getElementById('controls').onclick=()=>{
 const invalid=(parent,style,disabled=false)=>{const b=document.createElement('button');b.className='ytp-skip-ad-button';b.textContent='Not an eligible skip';b.style.cssText=style;b.disabled=disabled;b.onclick=()=>{window.__playerFixture.invalidClicks++;state()};parent.append(b)};
 const player=document.getElementById('movie_player');invalid(player,'');
 invalid(document.getElementById('outside'),'');
 const ad=document.createElement('div');ad.className='html5-video-player ad-showing';document.getElementById('additional').append(ad);
 invalid(ad,'display:none');invalid(ad,'',true);invalid(ad,'visibility:hidden');
 // One legitimate delayed skip proves the observer is processing this document.
 setTimeout(()=>skipButton(ad,'ytp-ad-skip-button'),40);
};
document.getElementById('ssap').onclick=()=>{const player=document.getElementById('movie_player');player.dataset.debug='SSAP, AD';player.classList.add('ad-showing');state()};
document.getElementById('normal').onclick=()=>{const player=document.getElementById('movie_player');player.dataset.debug='SSAP, VIDEO';player.classList.add('ad-showing');state()};
state();
</script></body></html>`;

async function launch(
  page: Page,
  enabled = true,
  hostname = "www.youtube.com",
) {
  await page.addInitScript((enabled) => {
    if (window !== window.top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ tabs: "top", motion: false, youtubeAdblock: enabled }),
    );
  }, enabled);
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const runtime = page
    .frames()
    .find(
      (frame) =>
        frame.parentFrame() === page.mainFrame() &&
        frame.url().startsWith("http://127.0.0.1:4181"),
    )!;
  await runtime.evaluate(
    ({ html, envelope, hostname }) => {
      const globals = window as any;
      const element = document.querySelector(
        'iframe[title="Proxied website"]',
      )! as any;
      const frame = element[Symbol.for("controller frame handle")];
      if (!frame) throw Error("Missing actual controller frame");
      const { ManagedPlugin } = globals.$runtimekitController;
      const plugin = new (class extends ManagedPlugin {
        constructor() {
          super("youtube-video-ad-fixture", []);
        }
        install(frame: any) {
          super.install(frame);
          this.tap(frame.hooks.fetch.request, ({ parsed }: any, props: any) => {
            const url = new URL(String(parsed.url));
            const navigationJSON =
              url.pathname === "/youtubei/v1/get_watch" ||
              url.searchParams.get("pbj") === "1";
            const known =
              url.hostname === hostname &&
              (url.pathname === "/watch" || navigationJSON);
            props.earlyResponse =
              globals.$runtimekit.ChannelResponse.fromNativeResponse(
                new Response(
                  known
                    ? navigationJSON
                      ? JSON.stringify(envelope)
                      : html
                    : "Fixture request not found",
                  {
                    status: known ? 200 : 404,
                    headers: {
                      "Content-Type": navigationJSON
                        ? "application/json"
                        : "text/html",
                      "Cache-Control": "no-store",
                    },
                  },
                ),
              );
          });
        }
      })();
      frame.plugins.push(plugin);
      plugin.install(frame);
    },
    { html, envelope, hostname },
  );
  await page
    .getByLabel("Address bar")
    .fill(`https://${hostname}/watch?v=fixture`);
  await page.getByLabel("Address bar").press("Enter");
  await expect(
    site(page).getByRole("heading", { name: "YouTube video-ad fixture" }),
  ).toBeVisible();
}

async function state(page: Page) {
  return site(page)
    .locator("#state")
    .evaluate((el) => JSON.parse(el.textContent!));
}
async function expectNativeMediaUntouched(page: Page) {
  const media = await site(page)
    .locator("video")
    .first()
    .evaluate((video: HTMLVideoElement) => ({
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      muted: video.muted,
    }));
  expect(media).toEqual({ currentTime: 0, playbackRate: 1, muted: false });
}
function expectPreservedPlayer(player: any, enabled = true) {
  for (const key of ["playerAds", "adPlacements", "adSlots"])
    if (enabled) expect(player[key] ?? []).toEqual([]);
    else expect(player[key]).toEqual(payload[key as keyof typeof payload]);
  expect(player.videoDetails).toEqual(payload.videoDetails);
  expect(player.streamingData).toEqual(payload.streamingData);
  expect(player.captions).toEqual(payload.captions);
}

test("YouTube late initial metadata keeps held object identity and filters navigation JSON arrays", async ({
  page,
}) => {
  await launch(page);
  await site(page)
    .getByRole("button", { name: "Populate late player metadata" })
    .click();
  const initial = JSON.parse(
    (await site(page).locator("#initial").textContent())!,
  );
  expect(initial.same).toBe(true);
  expectPreservedPlayer(initial.player);
  expectPreservedPlayer(initial.held);
  await site(page)
    .getByRole("button", { name: "Fetch navigation envelopes" })
    .click();
  await expect(site(page).locator("#json")).not.toBeEmpty();
  const responses = JSON.parse(
    (await site(page).locator("#json").textContent())!,
  );
  expect(responses).toHaveLength(3);
  for (const response of responses) {
    expectPreservedPlayer(response[0].playerResponse);
    expect(response[0].response.contents).toEqual(
      envelope[0].response.contents,
    );
  }
});

test("YouTube skips eligible delayed controls and follows SPA player replacement without changing media", async ({
  page,
}) => {
  await launch(page);
  await site(page)
    .getByRole("button", { name: "Start delayed skip ad" })
    .click();
  await expect.poll(async () => (await state(page)).clicks).toBe(1);
  await expect(site(page).locator("#movie_player")).not.toHaveClass(
    /ad-showing/,
  );
  await expectNativeMediaUntouched(page);
  await site(page)
    .getByRole("button", { name: "Replace player during SPA navigation" })
    .click();
  await expect.poll(async () => (await state(page)).clicks).toBe(2);
  await expect(site(page).locator("#movie_player")).not.toHaveClass(
    /ad-interrupting/,
  );
  expect((await state(page)).seekCalls).toEqual([]);
  await expectNativeMediaUntouched(page);
});

test("YouTube leaves normal-player, outside-player, hidden and disabled skip controls alone", async ({
  page,
}) => {
  await launch(page);
  await site(page)
    .getByRole("button", { name: "Add out-of-scope controls" })
    .click();
  await expect.poll(async () => (await state(page)).clicks).toBe(1);
  expect((await state(page)).invalidClicks).toBe(0);
  expect((await state(page)).seekCalls).toEqual([]);
  await expectNativeMediaUntouched(page);
});

test("YouTube player API seeks only an explicitly tagged stitched ad and preserves native video", async ({
  page,
}) => {
  await launch(page);
  await site(page)
    .getByRole("button", { name: "Start normal video with stale ad class" })
    .click();
  // Let a full delayed control appearance/observer turn complete as a negative control.
  await site(page)
    .getByRole("button", { name: "Add out-of-scope controls" })
    .click();
  // The main fixture now has a stale ad class, so its otherwise normal-looking
  // button is intentionally eligible for skipping; API seeking must still be zero.
  await expect.poll(async () => (await state(page)).clicks).toBe(1);
  expect((await state(page)).seekCalls).toEqual([]);
  await site(page)
    .locator("#movie_player .ytp-skip-ad-button")
    .evaluateAll((elements) => elements.forEach((el) => el.remove()));
  await site(page)
    .getByRole("button", { name: "Start recognized stitched ad" })
    .click();
  await expect.poll(async () => (await state(page)).seekCalls).toEqual([20]);
  await expect(site(page).locator("#movie_player")).not.toHaveClass(
    /ad-showing/,
  );
  await expectNativeMediaUntouched(page);
});

for (const mode of ["opt-out", "other website"]) {
  test(`YouTube player handling does nothing for ${mode}`, async ({ page }) => {
    await launch(
      page,
      mode !== "opt-out",
      mode === "other website" ? "example.org" : "www.youtube.com",
    );
    await site(page)
      .getByRole("button", { name: "Populate late player metadata" })
      .click();
    const initial = JSON.parse(
      (await site(page).locator("#initial").textContent())!,
    );
    expect(initial.same).toBe(true);
    expectPreservedPlayer(initial.player, false);
    await site(page)
      .getByRole("button", { name: "Start delayed skip ad" })
      .click();
    await expect(
      site(page).locator("#movie_player .ytp-skip-ad-button"),
    ).toBeVisible();
    await site(page)
      .getByRole("button", { name: "Start recognized stitched ad" })
      .click();
    await page.waitForTimeout(900);
    expect((await state(page)).clicks).toBe(0);
    expect((await state(page)).seekCalls).toEqual([]);
    await expectNativeMediaUntouched(page);
  });
}
