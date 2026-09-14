import { test, expect } from "@playwright/test";
const origin = "http://localhost:4196";
const website = (page: any) =>
  page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
test("Main relay uses the current frontend URL, isolated frame, cookies and real HTTP/WebSocket traffic", async ({
  page,
  request,
}) => {
  let lease: any;
  for (let i = 0; i < 5; i++) {
    const r = await request.post(origin + "/api/browse/session", {
      headers: { origin },
      data: {},
    });
    expect(r.ok()).toBeTruthy();
    lease = await r.json();
    if (lease.node.id === "local") break;
    await request.delete(origin + "/api/browse/session", {
      headers: { origin },
      data: { session: lease.session },
    });
  }
  expect(lease.node.id).toBe("local");
  expect(lease.relayOrigin).toBe(origin);
  expect(lease.runtimeOrigin).toBe("http://127.0.0.1:4194");
  await page.addInitScript((session) => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.nodeSession", JSON.stringify(session));
  }, lease.session);
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(origin);
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  await expect(
    website(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await website(page).getByRole("button", { name: "Test fetch" }).click();
  await expect(website(page).locator("#fetch-result")).toContainText(
    "fetch works",
  );
  await website(page).getByRole("button", { name: "Test WebSocket" }).click();
  await expect(website(page).locator("#socket-result")).toContainText(
    "socket works",
  );
  expect(
    sockets.some((url) => url.startsWith("ws://localhost:4196/relay/")),
  ).toBeTruthy();
  expect(
    sockets.some((url) => url.startsWith("ws://127.0.0.1:4194/relay/")),
  ).toBeFalsy();
  await website(page).getByRole("link", { name: "Sign in fixture" }).click();
  await expect(website(page).locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  const before = await page.evaluate(() =>
    localStorage.getItem("atlas.nodeSession"),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Atlas fixture", exact: true })
    .click();
  await expect(
    website(page).getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  await expect(website(page).locator("#cookie")).toContainText(
    "atlas_fixture=persistent",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("atlas.nodeSession")),
  ).toBe(before);
  const root = await request.get(origin);
  expect(root.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(root.headers()["x-frame-options"]).toBe("DENY");
  await page.getByRole("button", { name: "Connection options" }).click();
  await expect(page.getByRole("menu")).toContainText("Main server");
  await page.screenshot({
    path: "evidence/main-runtime-routing/main-browser.png",
  });
});

test("AI renders inline and display LaTeX locally without enabling trusted HTML commands", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.chats",
      JSON.stringify([
        {
          id: "math",
          title: "Math example",
          updated: 1,
          messages: [
            {
              id: "a",
              role: "assistant",
              content:
                "Inline $E=mc^2$.\n\n$$\\frac{1}{2}+\\sqrt{x}=\\int_0^1 t^2\\,dt$$\n\n$\\href{javascript:alert(1)}{unsafe}$",
            },
          ],
        },
      ]),
    );
  });
  await page.goto("/");
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "AI", exact: true })
    .click();
  await page.locator(".chat-item").getByRole("button").first().click();
  await expect(page.locator(".katex")).toHaveCount(3);
  await expect(page.locator(".katex-display")).toHaveCount(1);
  await expect(
    page.locator('.chat-message-content a[href^="javascript:"]'),
  ).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      [...document.fonts].some(
        (f) => f.family.includes("KaTeX") && f.status === "loaded",
      ),
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "evidence/main-runtime-routing/latex.png" });
});
