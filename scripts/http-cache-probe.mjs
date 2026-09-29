// Actual Chrome + pinned vendor helper. No external website or account involved.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import ts from "typescript";
const mode = process.argv[2] || "modified";
if (!["baseline", "modified"].includes(mode))
  throw Error("Use baseline or modified");
const implementation = ts.transpileModule(
  await readFile(new URL("../runtime/http-cache.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
).outputText;
const server = createServer(async (req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Cache regression</title>");
    return;
  }
  if (req.url === "/implementation.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(implementation);
    return;
  }
  if (
    !["/runtimekit.js", "/controller.api.js", "/runtimekit-utils.js"].includes(
      req.url,
    )
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/javascript");
  res.end(
    await readFile(
      new URL(
        "../upstream/scramjet-ls-bypass/app/vendor" + req.url,
        import.meta.url,
      ),
    ),
  );
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const src of [
    "runtimekit.js",
    "controller.api.js",
    "runtimekit-utils.js",
  ])
    await page.addScriptTag({ url: "/" + src });
  const results = await page.evaluate(async (mode) => {
    const { createHttpCachePlugin } = await import("/implementation.js");
    const { Tap, ChannelResponse, RuntimeKitHeaders, CookieJar } =
      window.$runtimekit;
    function fixture() {
      const frame = {
        controller: {},
        fetchHandler: { hooks: { fetch: Tap.create() } },
      };
      const plugin =
        mode === "baseline"
          ? new window.$runtimekitUtils.HttpCachePlugin({
              cacheName: "atlas-cache-regression-" + crypto.randomUUID(),
            })
          : createHttpCachePlugin(window);
      plugin.install(frame);
      const context = (path, destination = "document") => ({
        request: {
          method: "GET",
          cache: "default",
          initialHeaders: RuntimeKitHeaders.fromRawHeaders([]),
        },
        parsed: {
          destination,
          url: new URL("https://fixture.example/" + path),
        },
      });
      const request = async (ctx) => {
        const props = { init: { headers: [] } };
        await Tap.dispatch(frame.fetchHandler.hooks.fetch.request, ctx, props);
        return props;
      };
      const response = async (ctx, response) => {
        const props = { response };
        await Tap.dispatch(
          frame.fetchHandler.hooks.fetch.preresponse,
          ctx,
          props,
        );
        return props.response;
      };
      return { context, request, response };
    }
    function upstream(body, headers) {
      const response = new ChannelResponse(body, { status: 200, headers });
      response.rawHeaders = headers;
      return response;
    }
    const f = fixture();
    const login = f.context("login");
    await f.request(login);
    const original = upstream("signed in", [
      ["Content-Type", "text/html"],
      ["Cache-Control", "no-cache"],
      ["Set-Cookie", "session=fixture; Path=/; HttpOnly"],
      ["Set-Cookie", "state=fixture; Path=/; HttpOnly"],
    ]);
    const loginResponse = await f.response(login, original);
    const jar = new CookieJar();
    for (const [key, value] of loginResponse.rawHeaders)
      if (key.toLowerCase() === "set-cookie")
        jar.setCookies(value, login.parsed.url);
    const cookies = jar.getCookies(login.parsed.url, false);
    let source;
    const streamContext = f.context("live", "video");
    await f.request(streamContext);
    const streamed = upstream(
      new ReadableStream({
        start(controller) {
          source = controller;
          controller.enqueue(new TextEncoder().encode("first byte"));
        },
      }),
      [
        ["Content-Type", "video/mp4"],
        ["Cache-Control", "no-cache"],
      ],
    );
    const pending = f.response(streamContext, streamed);
    const firstByteBlocked = await Promise.race([
      pending.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 120)),
    ]);
    source.close();
    await pending;
    const session = f.context("session");
    await f.request(session);
    await f.response(
      session,
      upstream("signed out", [
        ["Content-Type", "application/json"],
        ["Cache-Control", "public, max-age=300"],
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cached = await f.request(f.context("session"));
    return {
      mode,
      cookies,
      rawCookieCount: loginResponse.rawHeaders.filter(
        ([key]) => key.toLowerCase() === "set-cookie",
      ).length,
      firstByteBlocked,
      dynamicSessionCached: !!cached.earlyResponse,
    };
  }, mode);
  if (mode === "baseline") {
    assert.equal(results.rawCookieCount, 0);
    assert.equal(results.cookies, "");
    assert.equal(results.firstByteBlocked, true);
    assert.equal(results.dynamicSessionCached, true);
  } else {
    assert.equal(results.rawCookieCount, 2);
    assert.equal(results.cookies, "session=fixture; state=fixture");
    assert.equal(results.firstByteBlocked, false);
    assert.equal(results.dynamicSessionCached, false);
  }
  console.log(JSON.stringify(results));
  console.log(
    `${mode.toUpperCase()}: PASS; ${mode === "baseline" ? "reproduced lost auth cookies, buffered live stream and cached dynamic session" : "two auth cookies retained, first byte unblocked, dynamic session uncached"}`,
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
