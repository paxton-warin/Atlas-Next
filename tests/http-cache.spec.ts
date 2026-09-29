import { test, expect } from "@playwright/test";

test("a cacheable login response retains both HttpOnly cookies across callback and reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const host = page.frameLocator(
    'iframe[title="Atlas isolated browsing runtime"]',
  );
  const site = host.frameLocator(
    'iframe[title="Proxied website"]:not([hidden])',
  );
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const runtime = page
    .frames()
    .find(
      (frame) =>
        frame.parentFrame() === page.mainFrame() &&
        frame.url().startsWith("http://127.0.0.1:4181"),
    )!;
  await runtime.evaluate(() => {
    const globals = window as any;
    const element = document.querySelector(
      'iframe[title="Proxied website"]',
    )! as any;
    const frame = element[Symbol.for("controller frame handle")];
    const { ManagedPlugin } = globals.$runtimekitController;
    globals.__authFixtureRequests = 0;
    const plugin = new (class extends ManagedPlugin {
      constructor() {
        super("atlas-auth-cookie-fixture", []);
      }
      install(frame: any) {
        super.install(frame);
        this.tap(
          frame.fetchHandler.hooks.fetch.request,
          ({ parsed }: any, props: any) => {
            if (parsed.url.hostname !== "auth-fixture.example") return;
            globals.__authFixtureRequests++;
            const cookie = new Headers(props.init.headers).get("cookie") || "";
            const signedIn =
              cookie.includes("fixture_session=valid") &&
              cookie.includes("fixture_state=matched");
            const headers = [
              ["Content-Type", "text/html"],
              ["Cache-Control", "no-cache"],
            ];
            let body;
            if (parsed.url.pathname === "/login") {
              headers.push(
                [
                  "Set-Cookie",
                  "fixture_session=valid; Path=/; Secure; HttpOnly; SameSite=Lax",
                ],
                [
                  "Set-Cookie",
                  "fixture_state=matched; Path=/; Secure; HttpOnly; SameSite=Lax",
                ],
              );
              body =
                '<h1>Returning from sign-in</h1><script>location.replace("/session")</script>';
            } else if (signedIn) {
              body =
                '<h1>Signed in</h1><p id="visible-cookies"></p><script>document.getElementById("visible-cookies").textContent=document.cookie||"HttpOnly cookies concealed"</script>';
            } else {
              body =
                '<h1>Missing session</h1><script>location.replace("/login")</script>';
            }
            const response = new globals.$runtimekit.ChannelResponse(body, {
              status: 200,
              headers,
            });
            // Transport supplies raw Set-Cookie separately from guarded native Headers.
            response.rawHeaders = headers;
            props.earlyResponse = response;
          },
        );
      }
    })();
    frame.plugins.push(plugin);
    plugin.install(frame);
  });
  await page
    .getByLabel("Address bar")
    .fill("https://auth-fixture.example/login");
  await page.getByLabel("Address bar").press("Enter");
  await expect(
    site.getByRole("heading", { name: "Signed in", exact: true }),
  ).toBeVisible();
  await expect(site.locator("#visible-cookies")).toHaveText(
    "HttpOnly cookies concealed",
  );
  const settled = await runtime.evaluate(
    () => (window as any).__authFixtureRequests,
  );
  await page.waitForTimeout(300);
  expect(
    await runtime.evaluate(() => (window as any).__authFixtureRequests),
  ).toBe(settled);
  await runtime.evaluate(() => {
    const element = document.querySelector(
      'iframe[title="Proxied website"]',
    )! as any;
    element[Symbol.for("controller frame handle")].reload();
  });
  await expect(
    site.getByRole("heading", { name: "Signed in", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => runtime.evaluate(() => (window as any).__authFixtureRequests))
    .toBeGreaterThan(settled);
});
