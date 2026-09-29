import { test, expect } from "@playwright/test";

test("fresh launch renews an expired stored lease once without prompting and retains saved tabs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem(
      "atlas.settings",
      JSON.stringify({ restore: true, motion: false }),
    );
    localStorage.setItem(
      "atlas.nodeSession",
      JSON.stringify("expired-fixture-session"),
    );
    localStorage.setItem(
      "atlas.tabs",
      JSON.stringify([
        {
          id: "restored",
          url: "http://127.0.0.1:4199/fixture",
          title: "Saved page",
          engine: "scramjet",
        },
      ]),
    );
  });
  const sessions: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/browse/session") && r.method() === "POST")
      sessions.push(r.postDataJSON().session);
  });
  await page.goto("/");
  await expect
    .poll(() => sessions, { timeout: 5000 })
    .toEqual(["expired-fixture-session", ""]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("atlas.nodeSession")!),
      ),
    )
    .not.toBe("expired-fixture-session");
  await expect(
    page.getByRole("dialog", { name: "Browsing session expired" }),
  ).not.toBeVisible();
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.locator(".tab-main").click();
  await expect(
    page
      .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
      .frameLocator('iframe[title="Proxied website"]')
      .getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
});

test("two simultaneous fresh windows renew one stale lease under the origin lock", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    if (!localStorage.getItem("atlas.concurrentSeed")) {
      localStorage.setItem("atlas.concurrentSeed", "true");
      localStorage.setItem(
        "atlas.nodeSession",
        JSON.stringify("expired-concurrent-fixture"),
      );
    }
  });
  const sessions: string[] = [];
  context.on("request", (request) => {
    if (
      request.url().endsWith("/api/browse/session") &&
      request.method() === "POST"
    )
      sessions.push(request.postDataJSON().session);
  });
  const second = await context.newPage();
  await Promise.all([page.goto("/"), second.goto("/")]);
  for (const window of [page, second])
    await expect(
      window.locator('iframe[title="Atlas isolated browsing runtime"]'),
    ).toHaveCount(1);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  expect(saved).not.toBe("expired-concurrent-fixture");
  expect(sessions).toEqual(["expired-concurrent-fixture", "", saved]);
  for (const window of [page, second])
    await expect(
      window.getByRole("dialog", { name: "Browsing session expired" }),
    ).not.toBeVisible();
  await second.close();
});

test("reconnect releases this window's active lease, not another window's saved lease", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === top) localStorage.setItem("atlas.onboarded", "true");
  });
  await page.goto("/");
  await page.getByLabel("Search the web").fill("http://127.0.0.1:4199/fixture");
  await page.getByLabel("Search the web").press("Enter");
  const site = page
    .frameLocator('iframe[title="Atlas isolated browsing runtime"]')
    .frameLocator('iframe[title="Proxied website"]');
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  const own = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas.nodeSession")!),
  );
  const otherResponse = await page.request.post("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { session: "" },
  });
  expect(otherResponse.ok()).toBeTruthy();
  const other = (await otherResponse.json()).session;
  // Same-origin windows share storage, but not the live React/runtime session.
  await page.evaluate(
    (session) =>
      localStorage.setItem("atlas.nodeSession", JSON.stringify(session)),
    other,
  );
  const releases: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/browse/session") &&
      request.method() === "DELETE"
    )
      releases.push(request.postDataJSON().session);
  });
  await page.getByRole("button", { name: "Connection options" }).click();
  await page.getByRole("menuitem", { name: "Reconnect node" }).click();
  const dialog = page.getByRole("dialog", { name: "Reconnect browsing?" });
  await dialog.getByRole("button", { name: "Reconnect node" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    site.getByRole("heading", { name: "Proxy fixture ready" }),
  ).toBeVisible();
  expect(releases).toEqual([own]);
  const otherStillValid = await page.request.post("/api/browse/session", {
    headers: { origin: "http://localhost:4180" },
    data: { session: other },
  });
  expect(otherStillValid.ok()).toBeTruthy();
  expect((await otherStillValid.json()).session).toBe(other);
});

test("corrupt stored tabs and session do not prevent a fresh launch", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.nodeSession", JSON.stringify({ broken: true }));
    localStorage.setItem("atlas.tabs", JSON.stringify({ broken: true }));
  });
  const sessions: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/browse/session") &&
      request.method() === "POST"
    )
      sessions.push(request.postDataJSON().session);
  });
  await page.goto("/");
  await expect(
    page.locator('iframe[title="Atlas isolated browsing runtime"]'),
  ).toHaveCount(1);
  await expect(page.getByLabel("Search the web")).toBeVisible();
  expect(sessions).toEqual([""]);
  expect(errors).toEqual([]);
});
