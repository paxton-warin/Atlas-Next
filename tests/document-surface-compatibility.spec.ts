import { test, expect, type Page, type Frame } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
const referencePath =
  process.env.ATLAS_FILTER_REFERENCE ||
  "evidence/filter-surface-20261013/reference-detector.fixture.js";
const reference = existsSync(referencePath)
  ? readFileSync(referencePath, "utf8")
  : "";
async function launch(page: Page, request: any) {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]:not([hidden])')
      .getByRole("heading", { name: "Game fixture" }),
  ).toBeVisible();
  return page.frames().find((f) => f.url().includes("/~/app/"))!;
}
async function setMode(page: Page, enabled: boolean) {
  await page
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Page options", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Isolate page structure (experimental)" })
    .setChecked(enabled);
  await page.getByRole("button", { name: "Close page options" }).click();
}
async function nativeMetadata(page: Page, frame: Frame) {
  let subject: Frame | Page = frame,
    cdp: any;
  for (;;) {
    try {
      cdp = await page.context().newCDPSession(subject);
      break;
    } catch (e) {
      if (subject === page) throw e;
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
      const found = find(child);
      if (found) return found;
    }
  }
  const target = find(frameTree);
  expect(target).toBeTruthy();
  const world = await cdp.send("Page.createIsolatedWorld", {
    frameId: target.id,
    worldName: "reference-metadata-probe",
    grantUniveralAccess: false,
  });
  const result = await cdp.send("Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: `(async()=>{const view={canonicalCount:document.querySelectorAll('link[rel="canonical"]').length,ogCount:document.querySelectorAll('meta[property="og:url"]').length};${reference};${reference ? "const detector=new referenceOrchestrator({config:{bypassDetectLevel:'normal'},logger:()=>{}});const r=await detector.scanPage(document,new URL('https://render.fixture.example/catalog'));view.proxyConfidence=r.proxy.confidence;view.proxyDetected=r.proxy.detected;" : ""}return view;})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(result.exceptionDetails).toBeUndefined();
  await cdp.detach();
  return result.result.value;
}
test("URL metadata retains original node, href and head API semantics without native cross-host classification", async ({
  page,
  request,
}) => {
  const frame = await launch(page, request);
  const original = await frame.evaluate(() => {
    const canonical = document.createElement("link");
    canonical.id = "fixture-canonical";
    canonical.rel = "canonical";
    canonical.href = "http://127.0.0.1:4199/compatibility-fixture";
    document.head.append(canonical);
    const og = document.createElement("meta");
    og.id = "fixture-og";
    og.setAttribute("property", "og:url");
    og.content = "https://original.fixture.example/catalog?gameId=Run%203";
    document.head.append(og);
    (window as any).__originalCanonical = canonical;
    (window as any).__originalOG = og;
    const catalogue = document.createElement("div");
    for (let i = 0; i < 600; i++) {
      const span = document.createElement("span");
      span.textContent = "Item";
      catalogue.append(span);
    }
    for (let i = 0; i < 100; i++) {
      const a = document.createElement("a");
      a.href = "/item/" + i;
      a.textContent = "Item " + i;
      catalogue.append(a);
    }
    document.body.append(catalogue);
    return { canonical: canonical.href, og: og.content };
  });
  const before = await nativeMetadata(page, frame);
  await setMode(page, true);
  const after = await nativeMetadata(page, frame);
  const site = await frame.evaluate(() => ({
    same:
      document.getElementById("fixture-canonical") ===
      (window as any).__originalCanonical,
    canonical: (
      document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement
    )?.href,
    og: (
      document.querySelector(
        'head > meta[property="og:url"]',
      ) as HTMLMetaElement
    )?.content,
    headParent:
      document.getElementById("fixture-canonical")?.parentNode ===
      document.head,
    headContains: document.head.contains(
      document.getElementById("fixture-canonical"),
    ),
    headChildren: [...document.head.children].some(
      (x) => x.id === "fixture-canonical",
    ),
    headTags:
      document.head
        .getElementsByTagName("link")
        .namedItem("fixture-canonical") === (window as any).__originalCanonical,
  }));
  expect(site.same).toBe(true);
  expect(site.canonical).toBe(original.canonical);
  expect(site.og).toBe(original.og);
  expect(site.headParent).toBe(true);
  expect(site.headContains).toBe(true);
  expect(site.headChildren).toBe(true);
  expect(site.headTags).toBe(true);
  expect(after.canonicalCount).toBe(0);
  expect(after.ogCount).toBe(0);
  if (reference) expect(after.proxyConfidence).toBe(0);
  await frame.evaluate(() => {
    const node = document.head.querySelector('link[rel="canonical"]')!;
    const replacement = document.createElement("link");
    replacement.id = "fixture-canonical";
    replacement.rel = "canonical";
    replacement.setAttribute("href", "/compatibility-fixture?gameId=Run%203");
    document.head.replaceChild(replacement, node);
    const og = document.head.querySelector('meta[property="og:url"]')!;
    document.head.removeChild(og);
    (window as any).__replacementCanonical = replacement;
  });
  expect(
    await frame.evaluate(
      () =>
        document.getElementById("fixture-canonical") ===
        (window as any).__replacementCanonical,
    ),
  ).toBe(true);
  await setMode(page, false);
  const restored = await nativeMetadata(page, frame);
  expect(restored.canonicalCount).toBe(1);
  expect(restored.ogCount).toBe(0);
  expect(
    await frame.evaluate(
      () =>
        document.getElementById("fixture-canonical")?.parentNode ===
        document.head,
    ),
  ).toBe(true);
  mkdirSync("evidence/filter-surface-20261013", { recursive: true });
  writeFileSync(
    "evidence/filter-surface-20261013/metadata-pocket-result.json",
    JSON.stringify(
      {
        referenceQualified: !!reference,
        before,
        after,
        restored,
        original,
        site,
      },
      null,
      2,
    ),
  );
});
test("document delegation retains currentTarget, callback receiver, once and abort across isolate/restore", async ({
  page,
  request,
}) => {
  const frame = await launch(page, request);
  await frame.evaluate(() => {
    const report: any = {
      onceBefore: 0,
      onceEnabled: 0,
      abort: 0,
      delegate: [],
      objects: 0,
    };
    (window as any).__listenerReport = report;
    document.addEventListener("click", () => report.onceBefore++, {
      once: true,
    });
    document.addEventListener("click", function (e) {
      report.delegate.push({
        currentTarget: e.currentTarget === document,
        receiver: this === document,
        target: (e.target as Element).id,
      });
    });
    document.addEventListener("click", {
      handleEvent(e) {
        report.objects++;
        report.objectReceiver = this.handleEvent instanceof Function;
      },
    });
    (document.getElementById("move") as HTMLButtonElement).click();
  });
  await setMode(page, true);
  await frame.evaluate(() => {
    const report = (window as any).__listenerReport;
    document.addEventListener("click", () => report.onceEnabled++, {
      once: true,
    });
    const controller = new AbortController();
    document.addEventListener("click", () => report.abort++, {
      signal: controller.signal,
    });
    controller.abort();
    (document.getElementById("move") as HTMLButtonElement).click();
  });
  let report = await frame.evaluate(() => (window as any).__listenerReport);
  expect(report.onceBefore).toBe(1);
  expect(report.onceEnabled).toBe(1);
  expect(report.abort).toBe(0);
  expect(report.delegate[1]).toEqual({
    currentTarget: true,
    receiver: true,
    target: "move",
  });
  await setMode(page, false);
  await frame.evaluate(() =>
    (document.getElementById("move") as HTMLButtonElement).click(),
  );
  await setMode(page, true);
  await frame.evaluate(() =>
    (document.getElementById("move") as HTMLButtonElement).click(),
  );
  report = await frame.evaluate(() => (window as any).__listenerReport);
  expect(report.onceBefore).toBe(1);
  expect(report.onceEnabled).toBe(1);
  expect(report.abort).toBe(0);
  expect(
    report.delegate.every(
      (x: any) => x.currentTarget && x.receiver && x.target === "move",
    ),
  ).toBe(true);
  expect(report.objects).toBe(4);
  expect(report.objectReceiver).toBe(true);
  mkdirSync("evidence/filter-surface-20261013", { recursive: true });
  writeFileSync(
    "evidence/filter-surface-20261013/listener-result.json",
    JSON.stringify(report, null, 2),
  );
});
