import {
  chromium,
  expect,
  test,
  type Browser,
  type Frame,
  type Route,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createPopoutUrl } from "../web/src/popout-link";

const frontend = "https://frontend-partition-fixture.cloudfront.net";
const runtime = "https://runtime-partition-fixture.cloudfront.net";
const destination = "https://website.example.test/article";
const session = "partition-fixture-pinned-session";
const ticket = "partition-fixture-transport-ticket";
const runtimeTitle = "Atlas isolated browsing runtime";
let nativeBrowser: Browser;
let nativeArguments: string[];

// Playwright disables partitioning by default. Keep its other defaults intact,
// removing only this feature override to exercise Chromium's native behavior.
test.beforeAll(async ({}, info) => {
  const executablePath =
    info.project.use.launchOptions?.executablePath || process.env.CHROME_PATH;
  const probe = await chromium.launch({
    executablePath,
    args: ["--enable-automation"],
  });
  let disabled: string | undefined;
  try {
    const cdp = await probe.newBrowserCDPSession();
    const command = await cdp.send("Browser.getBrowserCommandLine");
    disabled = command.arguments.find((value: string) =>
      value.startsWith("--disable-features="),
    );
    await cdp.detach();
  } finally {
    await probe.close();
  }
  const retained = disabled
    ?.slice("--disable-features=".length)
    .split(",")
    .filter((feature) => feature !== "ThirdPartyStoragePartitioning");
  nativeBrowser = await chromium.launch({
    executablePath,
    ...(disabled ? { ignoreDefaultArgs: [disabled] } : {}),
    args: [
      "--enable-automation",
      ...(retained?.length ? [`--disable-features=${retained.join(",")}`] : []),
    ],
  });
  const cdp = await nativeBrowser.newBrowserCDPSession();
  nativeArguments = (await cdp.send("Browser.getBrowserCommandLine")).arguments;
  await cdp.detach();
  expect(
    nativeArguments
      .filter((arg) => arg.startsWith("--disable-features="))
      .join(","),
  ).not.toContain("ThirdPartyStoragePartitioning");
});

test.afterAll(async () => {
  await nativeBrowser?.close();
});

const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
};

const fixtureRuntime = `<!doctype html><meta charset="utf-8"><title>Runtime fixture</title>
<h1>Runtime storage fixture</h1><script>
window.fixtureCommands=[];
addEventListener('message',e=>{
 if(e.source!==parent||e.origin!==${JSON.stringify(frontend)}||e.data?.atlas!==1)return;
 const d=e.data;fixtureCommands.push(d);
 const reply=(type,extra={})=>parent.postMessage({atlas:1,type,id:d.id,...extra},${JSON.stringify(frontend)});
 if(d.type==='ping')reply('ready');
 if(d.type==='navigate'){
  reply('navigation',{url:d.url});reply('title',{title:'Partition fixture'});reply('loaded');
 }
});
</script>`;

type RecordedRequest = { url: string; method: string; data: any };
async function fixtureContext(expired = false) {
  const context = await nativeBrowser.newContext();
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({
      url: request.url(),
      method: request.method(),
      data: request.postData() ? request.postDataJSON() : undefined,
    });
    if (url.origin === runtime) {
      await route.fulfill({ contentType: "text/html", body: fixtureRuntime });
      return;
    }
    if (url.origin !== frontend) {
      unexpected.push(request.url());
      await route.abort();
      return;
    }
    if (url.pathname === "/api/config") {
      await route.fulfill({
        json: {
          name: "Atlas",
          runtimeOrigin: runtime,
          engines: ["scramjet"],
          nodeRouting: true,
        },
      });
      return;
    }
    if (url.pathname === "/api/browse/session") {
      const data = request.postDataJSON();
      if (expired || request.method() !== "POST" || data.session !== session) {
        await route.fulfill({
          status: 409,
          json: {
            error:
              "This browsing session expired. Return to Atlas and reconnect.",
          },
        });
      } else {
        await route.fulfill({
          json: {
            session,
            ticket,
            runtimeOrigin: runtime,
            serverTime: Date.now(),
            expiresAt: Date.now() + 3600000,
            node: { id: "node-fixture", name: "Node fixture", online: true },
          },
        });
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await route.fulfill({ json: url.pathname === "/api/catalog" ? [] : {} });
      return;
    }
    const pathname =
      url.pathname === "/" || url.pathname === "/popout"
        ? "/index.html"
        : url.pathname;
    const root = resolve("dist/web");
    const file = resolve(root, "." + pathname);
    if (!file.startsWith(root + "/")) {
      unexpected.push(request.url());
      await route.abort();
      return;
    }
    try {
      await route.fulfill({
        contentType: contentTypes[extname(file)] || "application/octet-stream",
        body: await readFile(file),
      });
    } catch {
      unexpected.push(request.url());
      await route.fulfill({ status: 404, body: "Missing fixture asset" });
    }
  });
  return { context, requests, unexpected };
}

async function runtimeFrame(page: import("@playwright/test").Page) {
  const element = page.locator(`iframe[title="${runtimeTitle}"]`);
  await expect(element).toBeVisible();
  const frame = await (await element.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  await expect(
    frame!.getByRole("heading", { name: "Runtime storage fixture" }),
  ).toBeVisible();
  return frame!;
}

async function storage(frame: Frame, value: string | null = null) {
  return frame.evaluate(async (value) => {
    const key = "atlas-partition-fixture";
    if (value !== null) {
      localStorage.setItem(key, value);
      document.cookie = `atlas_partitioned_fixture=${value}; Path=/; Secure; SameSite=None; Partitioned`;
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("__runtimekit_controller", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const indexed = await new Promise<string | null>((resolve, reject) => {
      const transaction = database.transaction(
        "state",
        value === null ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore("state");
      const request =
        value === null
          ? store.get("cookies")
          : store.put({ cookies: value }, "cookies");
      transaction.oncomplete = () =>
        resolve(value === null ? (request.result?.cookies ?? null) : value);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return {
      localStorage: localStorage.getItem(key),
      indexedDB: indexed,
      cookies: document.cookie,
      secureContext: isSecureContext,
    };
  }, value);
}

function sessionRequests(requests: RecordedRequest[]) {
  return requests.filter(
    (r) => new URL(r.url).pathname === "/api/browse/session",
  );
}

// This uses the actual built App and Popout components. Only the API/transport
// bridge is synthetic; storage partitioning is the real browser implementation.
test("same-frontend popout preserves runtime storage partition and exact lease; direct-node control does not", async ({}, info) => {
  const { context, requests, unexpected } = await fixtureContext();
  try {
    await context.addInitScript(
      ({ frontend, session }) => {
        if (location.origin !== frontend || window !== top) return;
        if (localStorage.getItem("atlas.partitionSeed")) return;
        localStorage.setItem("atlas.partitionSeed", "true");
        localStorage.setItem("atlas.onboarded", "true");
        localStorage.setItem("atlas.nodeSession", JSON.stringify(session));
        localStorage.setItem(
          "atlas.settings",
          JSON.stringify({ tabs: "top", restore: true, motion: false }),
        );
      },
      { frontend, session },
    );
    const app = await context.newPage();
    await app.goto(frontend);
    await app.getByLabel("Search the web").fill(destination);
    await app.getByLabel("Search the web").press("Enter");
    const originalFrame = await runtimeFrame(app);
    await expect
      .poll(() =>
        app.evaluate(
          () => JSON.parse(localStorage.getItem("atlas.tabs")!)[0]?.title,
        ),
      )
      .toBe("Partition fixture");
    const tabsBefore = await app.evaluate(() =>
      localStorage.getItem("atlas.tabs"),
    );
    const written = await storage(originalFrame, "embedded");
    expect(written.secureContext).toBe(true);
    const popoutLink = app.getByRole("link", {
      name: "Pop out tab",
      exact: true,
    });
    const href = new URL((await popoutLink.getAttribute("href"))!);
    expect(href.origin).toBe(frontend);
    expect(href.pathname).toBe("/popout");
    expect(href.search).toBe("");
    expect(href.hash).not.toContain(ticket);
    expect(href.hash).not.toContain(runtime);
    const opened = context.waitForEvent("page");
    await popoutLink.click();
    const popout = await opened;
    const popoutFrame = await runtimeFrame(popout);
    const shared = await storage(popoutFrame);
    expect(shared).toEqual(written);
    expect(new URL(popout.url()).origin).toBe(frontend);
    expect(new URL(popout.url()).search).toBe("");
    expect(await popout.title()).toBe("Atlas");
    expect(await popout.evaluate(() => window.opener)).toBeNull();
    expect(sessionRequests(requests).map((r) => [r.method, r.data])).toEqual([
      ["POST", { session }],
      ["POST", { session }],
    ]);
    expect(await app.evaluate(() => localStorage.getItem("atlas.tabs"))).toBe(
      tabsBefore,
    );
    expect(
      await app.evaluate(() =>
        JSON.parse(localStorage.getItem("atlas.nodeSession")!),
      ),
    ).toBe(session);

    const direct = await context.newPage();
    await direct.goto(runtime);
    const isolated = await storage(direct.mainFrame());
    expect(isolated.localStorage).toBeNull();
    expect(isolated.indexedDB).toBeNull();
    expect(isolated.cookies).not.toContain(
      "atlas_partitioned_fixture=embedded",
    );
    await storage(direct.mainFrame(), "standalone");
    expect(await storage(originalFrame)).toEqual(written);
    expect(await storage(popoutFrame)).toEqual(written);
    await storage(popoutFrame, "popout");
    expect((await storage(originalFrame)).indexedDB).toBe("popout");
    expect((await storage(originalFrame)).localStorage).toBe("popout");
    expect((await storage(direct.mainFrame())).indexedDB).toBe("standalone");
    expect(
      requests.every(
        (r) => !r.url.includes(ticket) && !r.url.includes(session),
      ),
    ).toBe(true);
    expect(unexpected).toEqual([]);
    await info.attach("native-partition-proof", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify(
          {
            browser: nativeBrowser.version(),
            nativeArguments,
            frontend,
            runtime,
            written,
            shared,
            isolated,
            sessionRequests: sessionRequests(requests),
          },
          null,
          2,
        ),
      ),
    });
  } finally {
    await context.close();
  }
});

test("expired popout lease reports failure without allocating, deleting, or mutating saved tabs", async () => {
  const { context, requests, unexpected } = await fixtureContext(true);
  try {
    const savedTabs = JSON.stringify([
      {
        id: "original",
        url: destination,
        title: "Original",
        engine: "scramjet",
      },
    ]);
    await context.addInitScript(
      ({ savedTabs, frontend }) => {
        if (location.origin !== frontend || window !== top) return;
        localStorage.setItem("atlas.tabs", savedTabs);
        localStorage.setItem(
          "atlas.nodeSession",
          JSON.stringify("another-window-session"),
        );
      },
      { savedTabs, frontend },
    );
    const page = await context.newPage();
    await page.goto(createPopoutUrl(frontend, destination, session));
    await expect(
      page
        .getByText(/session expired|connection unavailable|connection expired/i)
        .first(),
    ).toBeVisible();
    await expect(page.locator(`iframe[title="${runtimeTitle}"]`)).toHaveCount(
      0,
    );
    expect(sessionRequests(requests).map((r) => [r.method, r.data])).toEqual([
      ["POST", { session }],
    ]);
    expect(await page.evaluate(() => localStorage.getItem("atlas.tabs"))).toBe(
      savedTabs,
    );
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("atlas.nodeSession")!),
      ),
    ).toBe("another-window-session");
    expect(unexpected).toEqual([]);
  } finally {
    await context.close();
  }
});
