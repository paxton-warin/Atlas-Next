import { test, expect } from "@playwright/test";
import { decodeTarget } from "../runtime/url-codec";
test.beforeEach(async ({ page }) => {
  if (process.env.ATLAS_RENDERER_DEBUG !== "1") return;
  await page.addInitScript(() => {
    const events: any[] = [];
    Object.defineProperty(window, "__atlasNativeRendererTrace", {
      value: events,
    });
    const get = Element.prototype.getAttribute;
    const summarize = (
      node: Element,
      name: string,
      value: unknown,
      kind: string,
    ) => {
      if (
        node.localName !== "iframe" ||
        !get.call(node, "title")?.includes("renderer") ||
        events.length >= 64
      )
        return;
      events.push({
        kind,
        name,
        length: value === null ? null : String(value).length,
        connected: node.isConnected,
        nativeSrcdocLength: get.call(node, "srcdoc")?.length ?? null,
        nativeSourceLength: get.call(node, "src")?.length ?? null,
        time: Math.round(performance.now()),
      });
    };
    for (const name of ["src", "srcdoc"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        name,
      )!;
      Object.defineProperty(HTMLIFrameElement.prototype, name, {
        ...descriptor,
        set(value) {
          summarize(this, name, value, "property");
          return descriptor.set!.call(this, value);
        },
      });
    }
    for (const name of ["setAttribute", "removeAttribute"] as const) {
      const native = Element.prototype[name];
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value: function (this: Element, ...args: any[]) {
          if (
            ["src", "srcdoc", "sandbox"].includes(String(args[0]).toLowerCase())
          )
            summarize(
              this,
              String(args[0]),
              name === "removeAttribute" ? null : args[1],
              name,
            );
          return Reflect.apply(native, this, args);
        },
      });
    }
    addEventListener(
      "load",
      (event) => {
        const node = event.target;
        if (node instanceof HTMLIFrameElement)
          summarize(node, "load", null, "event");
      },
      true,
    );
  });
});
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
          url: location.protocol + "//" + location.host + location.pathname,
          title: document.title,
          heading: document.querySelector("h1")?.textContent?.slice(0, 80),
          opaqueResult: document.querySelector("#opaque-result")?.textContent,
          scripts: document.scripts.length,
          ready: document.readyState,
          emptyScriptBody:
            document.scripts.length === 0
              ? document.body?.textContent?.slice(0, 100)
              : undefined,
          fixturePhase: document.documentElement?.dataset.fixturePhase,
          fixtureEvents: (window as any).__opaqueFixtureEvents,
          nativeTrace: (window as any).__atlasNativeRendererTrace,
          policy: document.querySelector<HTMLMetaElement>(
            'meta[http-equiv="Content-Security-Policy"]',
          )?.content,
          frames: [...document.querySelectorAll("iframe")].map((f) => ({
            title: f.title,
            srcdoc: !!f.getAttribute("srcdoc"),
            srcdocLength: f.getAttribute("srcdoc")?.length,
            nativeSrcdocLength: (window as any)[
              Symbol.for("runtimekit client global")
            ]?.natives.call("Element.prototype.getAttribute", f, "srcdoc")
              ?.length,
            nativeSource: (window as any)[
              Symbol.for("runtimekit client global")
            ]?.natives
              .call("Element.prototype.getAttribute", f, "src")
              ?.split(/[?#]/)[0]
              ?.slice(-120),
            source: f.getAttribute("src")?.split(/[?#]/)[0]?.slice(-120),
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
for (const order of ["src-first", "value", "attr-last"])
  test(`opaque detached ${order} declaration avoids an obsolete native renderer navigation`, async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
    await page.addInitScript(() => {
      if (window === top) localStorage.setItem("atlas.onboarded", "true");
    });
    const nativeRendererNavigations: string[] = [];
    page.on("request", (request) => {
      if (!request.isNavigationRequest()) return;
      const url = new URL(request.url());
      let logical = url.href;
      try {
        if (url.pathname.includes("/~/app/"))
          logical = decodeTarget(url.pathname.split("/").at(-1)!);
      } catch {}
      if (logical.includes("compatibility-opaque-child"))
        nativeRendererNavigations.push(url.pathname);
    });
    await page.goto("/");
    await page
      .getByLabel("Search the web")
      .fill(
        `http://127.0.0.1:4199/compatibility-opaque-parent?order=${order}&delay=200`,
      );
    await page.getByLabel("Search the web").press("Enter");
    const site = page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]:not([hidden])');
    await expect(site.locator("#opaque-result")).toHaveText("ready:null");
    await expect(site.locator("#opaque-peer")).toHaveText(
      "peer:reply:peer-ready",
    );
    await expect(
      site.locator('iframe[title="Opaque renderer fixture"]'),
    ).toHaveAttribute("sandbox", "allow-scripts");
    console.log(
      "OBSOLETE_RENDERER_NATIVE_NAVIGATIONS=" +
        JSON.stringify({ order, count: nativeRendererNavigations.length }),
    );
    expect(
      nativeRendererNavigations,
      "approved opaque document must not start an obsolete native /~/ request while its assigned-node fetch is pending",
    ).toEqual([]);
    const reflection = await site.locator("body").evaluate(async () => {
      const removed = document.createElement("iframe");
      removed.src = "/compatibility-opaque-child";
      const immediate = {
        property: removed.src.endsWith("/compatibility-opaque-child"),
        attribute: removed.getAttribute("src"),
        present: removed.hasAttribute("src"),
      };
      removed.removeAttribute("src");
      const replaced = document.createElement("iframe");
      replaced.setAttribute("src", "/compatibility-opaque-child");
      replaced.src = "/compatibility-renderer";
      await Promise.resolve();
      return {
        immediate,
        removed: removed.hasAttribute("src"),
        replacement: replaced.src.endsWith("/compatibility-renderer"),
        srcdoc: replaced.hasAttribute("srcdoc"),
      };
    });
    expect(reflection).toEqual({
      immediate: {
        property: true,
        attribute: "/compatibility-opaque-child",
        present: true,
      },
      removed: false,
      replacement: true,
      srcdoc: false,
    });
  });
test("detached reviewed iframe without opaque sandbox retains its normal native engine navigation", async ({
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
  await expect(site.locator("#opaque-result")).toHaveText("ready:null");
  await site.locator("body").evaluate(() => {
    const frame = document.createElement("iframe");
    frame.title = "Unsandboxed reviewed source";
    frame.src = "/compatibility-opaque-child";
    document.body.append(frame);
  });
  const fallback = site.locator('iframe[title="Unsandboxed reviewed source"]');
  await expect(
    fallback
      .contentFrame()
      .getByRole("heading", { name: "Opaque renderer child" }),
  ).toBeVisible();
  await expect(fallback).not.toHaveAttribute("srcdoc", /.+/);
  await expect(fallback).not.toHaveAttribute("sandbox", /.+/);
});
test("opaque parsed renderer settles its pending native navigation before isolated commit", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:4199/__test/reset-browser-limits");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]:not([hidden])');
  const beforeRelease: boolean[] = [];
  let held: any,
    prepared = false;
  let resolveHeld!: () => void;
  const nativeHeld = new Promise<void>((resolve) => (resolveHeld = resolve));
  const release = () => {
    if (held && prepared) {
      const route = held;
      held = undefined;
      void route
        .fulfill({
          status: 503,
          contentType: "text/plain",
          body: "Proxy worker is not controlling this page. Return home and retry.",
        })
        .catch(() => {});
    }
  };
  await page.exposeBinding("__opaqueResourcePrepared", async () => {
    prepared = true;
    beforeRelease.push(
      await site
        .locator('iframe[title="Opaque renderer fixture"]')
        .evaluate((frame) => {
          frame.dispatchEvent(new Event("load"));
          return frame.hasAttribute("srcdoc");
        }),
    );
    release();
  });
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    let target = url.href;
    try {
      if (url.pathname.includes("/~/app/"))
        target = decodeTarget(url.pathname.split("/").at(-1)!);
    } catch {}
    if (
      req.isNavigationRequest() &&
      target.includes("compatibility-opaque-child")
    ) {
      held = route;
      resolveHeld();
      release();
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
    const order: string[] = [];
    Object.defineProperty(window, "__rendererNativeSettlement", {
      value: order,
    });
    const get = Element.prototype.getAttribute,
      relevant = (node: Element) =>
        node.localName === "iframe" &&
        get.call(node, "title") === "Opaque renderer fixture";
    const add = EventTarget.prototype.addEventListener,
      remove = EventTarget.prototype.removeEventListener,
      watched = new WeakSet<Element>();
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      const node = this as Element;
      if (type === "load" && relevant(node) && !watched.has(node)) {
        watched.add(node);
        const firstLoad = function (this: Element, event: Event) {
          if (!event.isTrusted) return;
          remove.call(this, "load", firstLoad);
          if (get.call(this, "srcdoc") === null)
            order.push("initial-native-load");
        };
        add.call(this, "load", firstLoad);
      }
      return add.call(this, type, listener, options);
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "srcdoc",
    )!;
    Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
      ...descriptor,
      set(value) {
        if (relevant(this)) order.push("install-srcdoc");
        return descriptor.set!.call(this, value);
      },
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle),
      decode = TextDecoder.prototype.decode.bind(new TextDecoder());
    crypto.subtle.digest = (algorithm, data) => {
      let module = false;
      try {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        if (bytes.byteLength < 1024000)
          module = decode(bytes).includes("opaque fixture ready");
      } catch {}
      return digest(algorithm, data).then((result) => {
        if (module) void (window as any).__opaqueResourcePrepared();
        return result;
      });
    };
  });
  await page.goto("/");
  await page
    .getByLabel("Search the web")
    .fill(
      "http://127.0.0.1:4199/compatibility-opaque-parent?order=parsed&delay=200",
    );
  await page.getByLabel("Search the web").press("Enter");
  await nativeHeld;

  await expect(site.locator("#opaque-result")).toHaveText("ready:null");
  await expect(site.locator("#opaque-peer")).toHaveText(
    "peer:reply:peer-ready",
  );
  const order = await site
    .locator("body")
    .evaluate(() => (window as any).__rendererNativeSettlement as string[]);
  console.log("OPAQUE_NATIVE_SETTLEMENT_ORDER=" + JSON.stringify(order));
  console.log("OPAQUE_PRE_RELEASE_SRCDOC=" + JSON.stringify(beforeRelease));
  expect(beforeRelease).toEqual([false]);
  expect(order.indexOf("initial-native-load")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("install-srcdoc")).toBeGreaterThan(
    order.indexOf("initial-native-load"),
  );
  const child = site.frameLocator('iframe[title="Opaque renderer fixture"]');
  expect(await child.locator("body").evaluate(() => location.href)).toBe(
    "about:srcdoc",
  );
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
