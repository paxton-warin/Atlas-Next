import test from "node:test";
import assert from "node:assert/strict";
import { createHttpCachePlugin } from "../runtime/http-cache.ts";
function fixture() {
  class ManagedPlugin {
    install(frame) {
      this.frame = frame;
    }
    tap(hook, fn) {
      hook.push(fn);
    }
  }
  const hooks = { request: [], preresponse: [] };
  const frame = { controller: {}, fetchHandler: { hooks: { fetch: hooks } } };
  createHttpCachePlugin({
    $runtimekitController: { ManagedPlugin },
    $runtimekit: {
      ChannelResponse: { fromNativeResponse: (response) => response },
    },
  }).install(frame);
  const run = (name, context, props) =>
    Promise.all(hooks[name].map((fn) => fn(context, props)));
  return {
    async request({
      destination = "script",
      method = "GET",
      cache = "default",
      headers = [],
      url = "https://cdn.example/static.js",
    } = {}) {
      const context = {
        request: { method, cache },
        parsed: { destination, url: new URL(url) },
      };
      const props = { init: { headers } };
      await run("request", context, props);
      return { context, props };
    },
    async response(context, response) {
      const props = { response };
      await run("preresponse", context, props);
      return props.response;
    },
  };
}
function response(body = "/* static */", { headers = [], status = 200 } = {}) {
  const names = new Set(headers.map(([name]) => name.toLowerCase()));
  const raw = [
    ...[
      ["Content-Type", "text/javascript"],
      ["Cache-Control", "public, max-age=60"],
    ].filter(([name]) => !names.has(name.toLowerCase())),
    ...headers,
  ];
  const res = new Response(body, { status, headers: raw });
  res.rawHeaders = raw;
  return res;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
test("parallel background copies are bounded without blocking network responses", async () => {
  const f = fixture();
  const streams = [];
  let copies = 0;
  for (let index = 0; index < 12; index++) {
    const first = await f.request({
      url: `https://cdn.example/pending-${index}.js`,
    });
    const original = response(
      new ReadableStream({
        start(controller) {
          streams.push(controller);
        },
      }),
    );
    const clone = original.clone.bind(original);
    original.clone = () => {
      copies++;
      return clone();
    };
    assert.equal(await f.response(first.context, original), original);
  }
  assert.equal(copies, 8);
  for (const stream of streams) stream.close();
  await settle();
  const next = await f.request({ url: "https://cdn.example/after.js" });
  await f.response(next.context, response("after"));
  await settle();
  assert.equal(
    await (
      await f.request({ url: "https://cdn.example/after.js" })
    ).props.earlyResponse.text(),
    "after",
  );
});
test("public static assets cache without replacing or draining the network response", async () => {
  const f = fixture(),
    first = await f.request(),
    original = response();
  assert.equal(await f.response(first.context, original), original);
  assert.equal(original.bodyUsed, false);
  await settle();
  assert.equal(
    await (await f.request()).props.earlyResponse.text(),
    "/* static */",
  );
});
test("authentication responses retain every raw cookie and never enter the cache", async () => {
  const f = fixture(),
    first = await f.request();
  const original = response("auth", {
    headers: [
      ["Set-Cookie", "first=one; HttpOnly"],
      ["Set-Cookie", "second=two; HttpOnly"],
    ],
  });
  original.clone = () => {
    throw Error("Must not copy cookies");
  };
  assert.equal(await f.response(first.context, original), original);
  assert.equal(
    original.rawHeaders.filter(([key]) => key === "Set-Cookie").length,
    2,
  );
  assert.equal((await f.request()).props.earlyResponse, undefined);
});
test("documents, APIs, event streams, video, HEAD and POST bypass caching", async () => {
  for (const options of [
    { destination: "document" },
    { destination: "iframe" },
    { destination: "" },
    { destination: "video" },
    { destination: "audio" },
    { method: "HEAD" },
    { method: "POST" },
  ]) {
    const f = fixture(),
      first = await f.request(options),
      original = response();
    original.clone = () => {
      throw Error("Must not copy dynamic response");
    };
    assert.equal(await f.response(first.context, original), original);
    assert.equal((await f.request(options)).props.earlyResponse, undefined);
  }
});
test("credentialed, ranged and forced-fresh requests bypass an existing entry", async () => {
  const f = fixture(),
    first = await f.request();
  await f.response(first.context, response());
  await settle();
  for (const options of [
    { headers: [["Cookie", "session=1"]] },
    { headers: [["Authorization", "Bearer fixture"]] },
    { headers: [["Range", "bytes=0-5"]] },
    { cache: "reload" },
    { cache: "no-store" },
    { cache: "no-cache" },
    { headers: [["Cache-Control", "no-cache"]] },
  ]) {
    assert.equal((await f.request(options)).props.earlyResponse, undefined);
  }
});
test("private, no-store, no-cache, varied, expired and dynamic MIME responses bypass storage", async () => {
  for (const headers of [
    [["Cache-Control", "private, max-age=60"]],
    [["Cache-Control", "no-store"]],
    [["Cache-Control", "no-cache"]],
    [["Vary", "Cookie"]],
    [["Age", "60"]],
    [["Content-Type", "text/event-stream"]],
    [["Content-Type", "text/html"]],
    [["Content-Type", "application/json"]],
    [["Content-Type", "video/mp4"]],
  ]) {
    const f = fixture(),
      first = await f.request();
    const original = response("body", { headers });
    await f.response(first.context, original);
    await settle();
    assert.equal(
      (await f.request()).props.earlyResponse,
      undefined,
      JSON.stringify(headers),
    );
  }
});
test("redirects do not become cached authentication transitions", async () => {
  const f = fixture(),
    first = await f.request();
  await f.response(
    first.context,
    response("redirect", {
      status: 301,
      headers: [["Location", "/signed-in"]],
    }),
  );
  await settle();
  assert.equal((await f.request()).props.earlyResponse, undefined);
});
test("oversized static resources are not retained", async () => {
  const f = fixture(),
    first = await f.request();
  const original = response(new Uint8Array(1024 * 1024 + 1));
  assert.equal(await f.response(first.context, original), original);
  await original.arrayBuffer();
  await settle();
  assert.equal((await f.request()).props.earlyResponse, undefined);
});
test("cache copies do not hold up the first byte of an unfinished static response", async () => {
  const f = fixture(),
    first = await f.request();
  let stream;
  const original = response(
    new ReadableStream({
      start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    }),
  );
  const result = await Promise.race([
    f.response(first.context, original),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.equal(result, original);
  assert.equal(
    new TextDecoder().decode((await original.body.getReader().read()).value),
    "first",
  );
  stream.close();
  await settle();
});
test("public immutable entries still expire and s-maxage never overrides private max-age", async () => {
  const f = fixture(),
    first = await f.request();
  await f.response(
    first.context,
    response("stale", {
      headers: [["Cache-Control", "immutable, max-age=0, s-maxage=300"]],
    }),
  );
  await settle();
  assert.equal((await f.request()).props.earlyResponse, undefined);
});
test("the entry count is bounded and oldest static assets are evicted", async () => {
  const f = fixture();
  for (let index = 0; index < 65; index++) {
    const first = await f.request({ url: `https://cdn.example/${index}.js` });
    await f.response(first.context, response(String(index)));
    await settle();
  }
  assert.equal(
    (await f.request({ url: "https://cdn.example/0.js" })).props.earlyResponse,
    undefined,
  );
  assert.equal(
    await (
      await f.request({ url: "https://cdn.example/64.js" })
    ).props.earlyResponse.text(),
    "64",
  );
});
