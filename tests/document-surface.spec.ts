import { test, expect, type Frame, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const referencePath =
  process.env.ATLAS_FILTER_REFERENCE ||
  "evidence/filter-surface-20261013/reference-detector.fixture.js";
const reference = existsSync(referencePath)
  ? readFileSync(referencePath, "utf8")
  : "";

async function scan(page: Page, frame: Frame) {
  let subject: Frame | Page = frame;
  let cdp: any;
  for (;;) {
    try {
      cdp = await page.context().newCDPSession(subject);
      break;
    } catch (error) {
      if (subject === page) throw error;
      subject = (subject as Frame).parentFrame() || page;
    }
  }
  const { frameTree } = await cdp.send("Page.getFrameTree");
  function find(t: any): any {
    if (
      t.frame.url === frame.url() ||
      (frame.name() && t.frame.name === frame.name())
    )
      return t.frame;
    for (const child of t.childFrames || []) {
      const v = find(child);
      if (v) return v;
    }
  }
  const target = find(frameTree);
  if (!target)
    console.log(
      "FIXTURE_CDP_FRAME_TREE=" +
        JSON.stringify({
          frame: frame.url(),
          name: frame.name(),
          tree: frameTree,
        }),
    );
  expect(target).toBeTruthy();
  const world = await cdp.send("Page.createIsolatedWorld", {
    frameId: target.id,
    worldName: "reference-filter-probe",
    grantUniveralAccess: false,
  });
  const r = await cdp.send("Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: reference
      ? `(async()=>{${reference};const d=new referenceOrchestrator({config:{bypassDetectLevel:'normal'},logger:()=>{}});const r=await d.scanPage(document,new URL("https://render.fixture.example/~/app/catalog"));return {gameDetected:r.game.detected,gameScore:r.game.score,proxyDetected:r.proxy.detected,proxyConfidence:r.proxy.confidence,parts:Object.fromEntries(Object.entries(r.game.subResults||{}).map(([k,v])=>[k,v.score])),nativeGrid:document.querySelectorAll('[class*=grid]').length,path:location.pathname.slice(0,24),bodyLength:document.body?.innerText.length||0};})()`
      : `({bodyLength:document.body?.innerText.length||0,referenceUnavailable:true})`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(r.exceptionDetails).toBeUndefined();
  await cdp.detach();
  return r.result.value;
}
async function siteFrame(page: Page) {
  await expect
    .poll(
      () =>
        page
          .frames()
          .filter(
            (f) =>
              f.url().includes("/~/app/") && !f.url().includes("surface=child"),
          ).length,
    )
    .toBeGreaterThan(0);
  return (
    page
      .frames()
      .find(
        (f) =>
          f.url().includes("/~/app/") &&
          f.parentFrame() &&
          f.parentFrame()!.parentFrame() === page.mainFrame(),
      ) || page.frames().find((f) => f.url().includes("/~/app/"))!
  );
}
test("closed document surface keeps IDs, CSS, real clicks and API bytes while the reference collector sees no game catalogue", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() =>
    localStorage.setItem("atlas.onboarded", "true"),
  );
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site.getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  const runtime = page
    .frames()
    .find((f) => f.parentFrame() === page.mainFrame())!;
  const frame = runtime.childFrames().find((f) => f.url().includes("/~/app/"))!;
  expect(frame).toBeTruthy();
  await frame.evaluate(() => {
    const catalog = document.createElement("section");
    catalog.id = "catalog";
    catalog.innerHTML =
      '<h2>Popular Games</h2><nav><a>Action</a><a>Arcade</a><a>Puzzle</a><a>Strategy</a><a>Sports</a><a>Racing</a></nav><div id="game-grid" class="game-grid" style="display:grid;grid-template-columns:repeat(4,120px)"></div>';
    document.body.append(catalog);
    const titles = [
      "2048",
      "Cookie Clicker",
      "Slope",
      "Run 3",
      "BitLife",
      "Geometry Dash",
      "Subway Surfers",
      "Minecraft",
      "Tetris",
      "Retro Bowl",
      "Among Us",
      "Happy Wheels",
      "Drift Hunters",
      "Five Nights at Freddys",
    ];
    for (let i = 0; i < 64; i++) {
      const b = document.createElement("button");
      b.style.width = "120px";
      b.dataset.title = titles[i % titles.length];
      b.textContent = b.dataset.title;
      document.querySelector("#game-grid")!.append(b);
    }
    document.addEventListener("click", (e) => {
      if ((e.target as HTMLElement)?.id === "move")
        document.body.dataset.delegated = "retained";
    });
  });
  await frame.evaluate(async () => {
    const child = document.createElement("iframe");
    child.id = "stateful-child";
    child.src = "/compatibility-renderer";
    const loaded = new Promise((resolve) =>
      child.addEventListener("load", resolve, { once: true }),
    );
    document.body.append(child);
    await loaded;
    (child.contentWindow as any).__surfaceState = "retained-context";
  });
  const before = await scan(page, frame);
  console.log("REFERENCE_SURFACE_BASELINE=" + JSON.stringify(before));
  if (reference) expect(before.gameDetected).toBe(true);
  await page
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Page options", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Isolate page structure (experimental)" })
    .check();
  await expect.poll(async () => (await scan(page, frame)).bodyLength).toBe(0);
  const after = await scan(page, frame);
  if (reference) {
    expect(after.gameDetected).toBe(false);
    expect(after.gameScore).toBe(0);
  }
  const original = await frame.evaluate(() => ({
    text: document.body.innerText.length,
    id: document.querySelector("#catalog")?.id,
    title: document
      .querySelector("#game-grid button")
      ?.getAttribute("data-title"),
    bodyMatches: document.querySelector("body") === document.body,
    childState: (
      (document.querySelector("#stateful-child") as HTMLIFrameElement)
        ?.contentWindow as any
    )?.__surfaceState,
    namedElement: (window as any).move?.id,
    listItem: document.querySelectorAll("head,body").item(1)?.tagName,
    liveCollection:
      document.getElementsByTagName("body").item(0) === document.body,
    rootMatches: document.querySelector("#catalog")?.getRootNode() === document,
    documentContains: document.contains(document.querySelector("#catalog")),
    width: (
      document.querySelector("#game-grid button") as HTMLElement
    )?.getBoundingClientRect().width,
  }));
  expect(original.text).toBeGreaterThan(100);
  expect(original.id).toBe("catalog");
  expect(original.title).toBe("2048");
  expect(original.width).toBe(120);
  expect(original.bodyMatches).toBe(true);
  expect(original.childState).toBe("retained-context");
  expect(original.namedElement).toBe("move");
  expect(original.listItem).toBe("BODY");
  expect(original.liveCollection).toBe(true);
  expect(original.rootMatches).toBe(true);
  expect(original.documentContains).toBe(true);
  await page.getByRole("button", { name: "Close page options" }).click();
  const clicked = await frame.evaluate(() => {
    const b =
      document.querySelector("button#move") ||
      [...document.querySelectorAll("button")].find(
        (x) => x.textContent === "Move",
      );
    if (!b) throw Error("Move button missing");
    b.id = "move";
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const outer = await page
    .locator('iframe[title="Atlas isolated browsing runtime"]')
    .boundingBox();
  await page.mouse.click(outer!.x + clicked.x, outer!.y + clicked.y);
  await expect
    .poll(() =>
      frame.evaluate(() => document.querySelector("#score")?.textContent),
    )
    .toBe("1");
  await expect
    .poll(() => frame.evaluate(() => document.body.dataset.delegated))
    .toBe("retained");
  const api = await frame.evaluate(
    async () =>
      await (
        await fetch(
          "/compatibility-request-echo?game=coolmathgames&gameId=Run%203",
          {
            method: "POST",
            headers: { "X-Fixture": "coolmathgames" },
            body: JSON.stringify({
              gameId: "Run 3",
              selector: "#game-grid",
              className: "game-card",
            }),
          },
        )
      ).json(),
  );
  expect(api.query).toBe("?game=coolmathgames&gameId=Run%203");
  expect(api.body).toBe(
    '{"gameId":"Run 3","selector":"#game-grid","className":"game-card"}',
  );
  expect(api.header).toBe("coolmathgames");
  await page
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Page options", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Isolate page structure (experimental)" })
    .uncheck();
  await expect(
    site.getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  expect(
    await frame.evaluate(
      () =>
        (
          (document.querySelector("#stateful-child") as HTMLIFrameElement)
            ?.contentWindow as any
        )?.__surfaceState,
    ),
  ).toBe("retained-context");
  const restored = await scan(page, frame);
  if (reference) expect(restored.gameDetected).toBe(true);
  expect(restored.bodyLength).toBeGreaterThan(100);
  mkdirSync("evidence/filter-surface-20261013", { recursive: true });
  writeFileSync(
    "evidence/filter-surface-20261013/fixture-surface-result.json",
    JSON.stringify(
      {
        referenceQualified: !!reference,
        before,
        after,
        restored,
        original,
        api,
        method:
          "reference helper scanPage in Chrome isolated world; actual proxied fixture; neutral external sampling URL because local hosts are excluded; no installed extension or authenticated content",
      },
      null,
      2,
    ),
  );
});

test("saved isolation applies at first DOM-ready in embedded, nested, same-frontend popout and direct-node documents", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120000);
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await context.addInitScript(() => {
    // Capture the native descriptor before the runtime installs main-world traps.
    const body = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "body",
    )!.get!;
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        (window as any).__fixtureNativeAtReady = {
          bodyLength: body.call(document)?.innerText.length || 0,
        };
      },
      { once: true },
    );
    if (
      location.origin === "http://localhost:4180" ||
      location.origin === "http://127.0.0.1:4181"
    ) {
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem(
        "atlas.document-surface.v1",
        JSON.stringify({ "http://127.0.0.1:4199": true }),
      );
    }
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-fixture?surface=1");
  await page.getByLabel("Search the web").press("Enter");
  const results: any = { referenceQualified: !!reference, contexts: {} };
  async function qualify(owner: Page, label: string) {
    const frame = await siteFrame(owner);
    await expect
      .poll(() => frame.evaluate(() => (window as any).__surfaceReady?.grid))
      .toBe(true);
    const ready = await frame.evaluate(() => ({
      site: (window as any).__surfaceReady,
      native: (window as any).__fixtureNativeAtReady,
    }));
    expect(ready.site.text).toBeGreaterThan(100);
    expect(ready.site.body).toBe(true);
    expect(ready.native.bodyLength).toBe(0);
    const score = await scan(owner, frame);
    expect(score.bodyLength).toBe(0);
    if (reference) {
      expect(score.gameDetected).toBe(false);
      expect(score.gameScore).toBe(0);
    }
    await frame.evaluate(() =>
      (document.querySelector("#move") as HTMLButtonElement).click(),
    );
    expect(
      await frame.evaluate(() => document.querySelector("#score")?.textContent),
    ).toBe("1");
    results.contexts[label] = { ready, score, control: "1" };
    const child = frame.childFrames()[0];
    if (child) {
      await expect
        .poll(() => child.evaluate(() => (window as any).__surfaceReady?.grid))
        .toBe(true);
      const childScore = await scan(owner, child);
      expect(childScore.bodyLength).toBe(0);
      if (reference) expect(childScore.gameScore).toBe(0);
      results.contexts[label].child = {
        score: childScore,
        native: await child.evaluate(
          () => (window as any).__fixtureNativeAtReady,
        ),
      };
      expect(results.contexts[label].child.native.bodyLength).toBe(0);
    }
    return frame;
  }
  await qualify(page, "embedded");
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popout = await opened;
  await qualify(popout, "popout");
  await popout.close();
  await page
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  const directOpened = context.waitForEvent("page");
  await page
    .getByRole("menuitem", { name: "Open direct node tab", exact: true })
    .click();
  const direct = await directOpened;
  const directFrame = await qualify(direct, "direct");
  await direct
    .locator("summary")
    .filter({ hasText: /^Connection$/ })
    .click();
  await direct
    .locator("summary")
    .filter({ hasText: /^Page options$/ })
    .click();
  await expect(
    direct.getByRole("checkbox", {
      name: "Isolate page structure (experimental)",
    }),
  ).toBeChecked();
  await direct.getByRole("button", { name: "Restore page defaults" }).click();
  await expect
    .poll(async () => (await scan(direct, directFrame)).bodyLength)
    .toBeGreaterThan(100);
  const restored = await scan(direct, directFrame);
  if (reference) expect(restored.gameDetected).toBe(true);
  results.directRestored = restored;
  mkdirSync("evidence/filter-surface-20261013", { recursive: true });
  writeFileSync(
    "evidence/filter-surface-20261013/topology-result.json",
    JSON.stringify(results, null, 2),
  );
  console.log("REFERENCE_SURFACE_TOPOLOGIES=" + JSON.stringify(results));
});
