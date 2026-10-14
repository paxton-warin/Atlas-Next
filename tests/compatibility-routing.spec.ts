import { test, expect } from "@playwright/test";
test.afterEach(async ({ page }, info) => {
  if (
    process.env.ATLAS_RENDERER_DEBUG !== "1" ||
    info.status === info.expectedStatus
  )
    return;
  const states = [];
  for (const frame of page.frames()) {
    try {
      states.push(
        await frame.evaluate(() => ({
          srcdoc: location.href === "about:srcdoc",
          opaqueResult: document.querySelector("#opaque-result")?.textContent,
          scripts: document.scripts.length,
          ready: document.readyState,
          frames: [...document.querySelectorAll("iframe")].map((f) => ({
            title: f.title,
            srcdoc: !!f.getAttribute("srcdoc"),
            sandbox: f.getAttribute("sandbox"),
            ownSrc: !!Object.getOwnPropertyDescriptor(f, "src"),
            sameRealm: f instanceof HTMLIFrameElement,
          })),
          runtimeSymbols: Object.getOwnPropertySymbols(window)
            .map(String)
            .filter((s) => s.includes("runtimekit")),
        })),
      );
    } catch {
      states.push({ uninspected: true });
    }
  }
  console.log("RENDERER_FIXTURE_FAILURE_STATES=" + JSON.stringify(states));
});
test("external SVG symbol references retain their native fragment and render parsed and dynamic icons", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-icons");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  for (const id of [
    "parsed-icon",
    "dynamic-icon",
    "property-icon",
    "xlink-icon",
    "local-icon",
  ]) {
    await expect
      .poll(() =>
        site
          .locator("#" + id)
          .evaluate((node: SVGGraphicsElement) => node.getBBox().width),
      )
      .toBe(24);
    const attribute = id === "xlink-icon" ? "xlink:href" : "href";
    const value =
      id === "local-icon"
        ? "#local-symbol"
        : "/compatibility-icons.svg#fixture-icon";
    // Locator inspection sees native attributes, not the website's patched
    // getter. The native renderer must resolve the original literal symbol ID.
    const raw = await site.locator("#" + id).getAttribute(attribute);
    if (id === "local-icon") expect(raw).toBe(value);
    else {
      const native = new URL(raw!);
      expect(native.origin).toBe("http://127.0.0.1:4181");
      expect(native.pathname).toContain("/~/app/");
      expect(native.hash).toBe("#fixture-icon");
    }
  }
});
test("computed root dynamic imports route through the assigned runtime in classic, module, Function and inserted scripts", async ({
  page,
  request,
}) => {
  for (const width of [1440, 940, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
    await page.addInitScript(() => {
      if (window === top) localStorage.setItem("atlas.onboarded", "true");
    });
    await page.goto("/");
    await page
      .getByLabel("Search the web")
      .fill("http://127.0.0.1:4199/compatibility-root-imports");
    await page.getByLabel("Search the web").press("Enter");
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]:not([hidden])');
    for (const id of [
      "root-classic",
      "root-module",
      "root-function",
      "root-inline",
    ])
      await expect(site.locator("#" + id)).toHaveText("prefix modules ready");
  }
});
for (const order of ["src-first", "value", "attr-first", "attr-last", "parsed"])
  test(`opaque sandbox handles ${order} setup order and releases srcdoc on navigation`, async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
    await page.addInitScript(() => {
      if (window === top) localStorage.setItem("atlas.onboarded", "true");
    });
    await page.goto("/");
    await page
      .getByLabel("Search the web")
      .fill("http://127.0.0.1:4199/compatibility-opaque-parent?order=" + order);
    await page.getByLabel("Search the web").press("Enter");
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]:not([hidden])');
    await expect(
      site.getByRole("heading", { name: "Opaque renderer parent" }),
    ).toBeVisible();
    await expect(site.locator("#opaque-result")).toHaveText("ready:null");
    await expect(site.locator("#opaque-peer")).toHaveText(
      "peer:reply:peer-ready",
    );
    await site.locator("body").evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
      frame.sandbox.add("allow-same-origin");
      frame.src = "/compatibility-renderer";
    });
    await expect(
      site
        .frameLocator("iframe")
        .getByRole("heading", { name: "Nested renderer" }),
    ).toBeVisible();
    await expect(site.locator("iframe")).not.toHaveAttribute("srcdoc", /.+/);
    const retained = await site.locator("body").evaluate(() => {
      const own = document.createElement("iframe");
      own.srcdoc = "<h1>Site-owned srcdoc</h1>";
      own.src = "/compatibility-renderer";
      const property = !!own.getAttribute("srcdoc");
      own.setAttribute("src", "/compatibility-renderer-parent");
      return property && !!own.getAttribute("srcdoc");
    });
    expect(retained).toBe(true);
  });
test("Request input credentials overrides preserve body, headers and native promise failures", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-request-credentials");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(site.locator("#request-omit")).toHaveText("no cookie");
  await expect(site.locator("#request-include")).toHaveText("cookie present");
  await expect(site.locator("#clone-omit")).toHaveText("no cookie");
  await expect(site.locator("#request-post")).toHaveText(
    '{"method":"POST","body":"fixture-payload","header":"retained","cookie":false}',
  );
  await expect(site.locator("#request-used")).toHaveText("promise rejection");
  await expect(site.locator("#request-getter")).toHaveText("1:no cookie");
});
test("explicit omitted credentials neither send nor accept cookies", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-credentials");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(site.locator("#omit")).toHaveText("no cookie");
  await expect(site.locator("#include")).toHaveText("cookie present");
  await expect(site.locator("#stored")).toHaveText("not stored");
});
test("opaque sandbox renderer preserves native null origin and loads through the assigned runtime", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-opaque-parent");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site.getByRole("heading", { name: "Opaque renderer parent" }),
  ).toBeVisible();
  await expect(site.locator("#opaque-result")).toHaveText("ready:null");
  await expect(site.locator("#opaque-port")).toHaveText(
    "port:reply:host-ready",
  );
  await expect(site.locator("#opaque-peer")).toHaveText(
    "peer:reply:peer-ready",
  );
  await expect(
    site.locator('iframe[title="Opaque renderer fixture"]'),
  ).toHaveAttribute("sandbox", "allow-scripts");
  const child = site.frameLocator('iframe[title="Opaque renderer fixture"]');
  expect(
    await child.locator("body").evaluate(() => {
      try {
        void parent.document;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await child.locator("body").evaluate(() => {
      try {
        void localStorage;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await child.locator("body").evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "document.body.dataset.unauthorized='executed'";
    document.head.append(script);
  });
  await expect(child.locator("body")).not.toHaveAttribute(
    "data-unauthorized",
    "executed",
  );
  await expect(
    child.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute("content", /default-src 'none'.*sha256-/);
});
test("public OpenAI v14 renderer emits its native ready port inside the opaque sandbox", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.ATLAS_TEST_PUBLIC_RENDERER !== "1",
    "Explicit logged-out live CDN qualification",
  );
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-opaque-parent?real=1");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(site.locator("#opaque-result")).toHaveText("ready:null");
  await expect(
    site.locator('iframe[title="Opaque renderer fixture"]'),
  ).toHaveAttribute("sandbox", "allow-scripts");
});
test("prefix import maps support both static and dynamic modules through the actual runtime", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-importmap");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  await expect(
    site.getByRole("heading", { name: "Module fixture" }),
  ).toBeVisible();
  await expect(site.locator("#module-result")).toHaveText(
    "prefix modules ready",
  );
  await expect(site.locator("#dynamic-result")).toHaveText(
    "prefix modules ready",
  );
});
test("nested document routing preserves streamed replies and range requests without changing the node", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill("http://127.0.0.1:4199/compatibility-renderer-parent");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  const renderer = site.frameLocator('iframe[title="Nested renderer fixture"]');
  await expect(
    renderer.getByRole("heading", { name: "Nested renderer" }),
  ).toBeVisible();
  await expect(renderer.locator("#reply")).toHaveText("stream complete");
  await expect(renderer.locator("#range")).toHaveText("206:2345");
  await expect
    .poll(() => site.locator("body").evaluate(() => document.title))
    .toBe("Ordinary page");
});
