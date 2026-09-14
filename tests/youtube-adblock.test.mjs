import test from "node:test";
import assert from "node:assert/strict";
import {
  isYouTubeUrl,
  shouldBlockYouTubeRequest,
  pruneYouTubePayload,
  createYouTubeAdblockPlugin,
} from "../runtime/youtube-adblock.ts";

const youtube = "https://www.youtube.com/watch?v=fixture";
const playerUrl =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const player = () => ({
  videoDetails: { videoId: "fixture", title: "Ordinary video" },
  streamingData: {
    adaptiveFormats: [
      { url: "https://rr1.googlevideo.com/videoplayback?id=content" },
    ],
  },
  playabilityStatus: { status: "OK" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [{ baseUrl: "/api/timedtext" }],
    },
  },
  responseContext: { mainAppWebResponseContext: { loggedOut: false } },
  playerAds: [{ ad: 1 }],
  adPlacements: [{ ad: 2 }],
  adSlots: [{ ad: 3 }],
});

function fixture() {
  class ManagedPlugin {
    install(frame) {
      this.frame = frame;
    }
    tap(hook, callback) {
      hook.push(callback);
    }
  }
  class RuntimeKitHeaders extends Headers {
    static fromRawHeaders(headers) {
      return new this(headers);
    }
  }
  const frame = {
    hooks: { init: { post: [] }, fetch: { intercept: [], response: [] } },
  };
  let active = true;
  const plugin = createYouTubeAdblockPlugin(
    {
      $runtimekitController: { ManagedPlugin },
      $runtimekit: { RuntimeKitHeaders },
    },
    () => active,
  );
  plugin.install(frame);
  return {
    frame,
    enable(value) {
      active = value;
    },
    async run(name, context, props = {}) {
      const hook =
        name === "post" ? frame.hooks.init.post : frame.hooks.fetch[name];
      await Promise.all(hook.map((callback) => callback(context, props)));
      return props;
    },
  };
}
function response(body, headers = {}, status = 200) {
  return {
    response: {
      body,
      status,
      statusText: "OK",
      headers: new Headers({
        "content-type": "application/json; charset=utf-8",
        ...headers,
      }),
    },
  };
}
async function bodyText(props) {
  return new Response(props.response.body).text();
}

// No real YouTube requests: this suite asserts the independent policy and real
// native stream behavior. Browser tests cover the actual pinned engine hooks.
test("YouTube URL identity has protocol and hostname boundaries", () => {
  for (const value of [
    youtube,
    "https://youtube.com/",
    "https://m.youtube.com/",
    "https://www.youtube-nocookie.com/embed/id",
  ])
    assert.equal(isYouTubeUrl(value), true, value);
  for (const value of [
    "https://youtube.com.evil.test/",
    "https://notyoutube.com/",
    "https://www.youtube-nocookie.com.evil/",
    "data:text/html,youtube.com",
    "file://youtube.com/",
    "not a url",
    null,
  ])
    assert.equal(isYouTubeUrl(value), false, String(value));
});

test("ad-only network rules are YouTube-scoped and preserve video, assets, and sign-in", () => {
  for (const url of [
    "https://googleads.g.doubleclick.net/pagead/id",
    "https://tpc.googlesyndication.com/simgad/123",
    "https://www.youtube.com/pagead/interaction/",
    "https://www.google.com/pagead/1p-user-list/",
    "https://www.youtube.com/api/stats/ads",
  ])
    assert.equal(shouldBlockYouTubeRequest(youtube, url), true, url);
  for (const url of [
    "https://rr1.googlevideo.com/videoplayback?id=fixture",
    "https://i.ytimg.com/vi/id/hqdefault.jpg",
    "https://accounts.google.com/o/oauth2/auth",
    playerUrl,
    "https://www.youtube.com/youtubei/v1/next",
    "https://www.youtube.com/api/stats/playback",
    "https://www.google.com/search?q=video",
    "https://doubleclick.net.evil.test/pagead/a",
    "https://googlesyndication.com.evil.test/foo",
    "https://accounts.google.com/pagead/unrelated",
  ])
    assert.equal(shouldBlockYouTubeRequest(youtube, url), false, url);
  for (const page of [
    "https://accounts.google.com/",
    "https://example.com/",
    "https://youtube.com.evil.test/",
    undefined,
  ])
    assert.equal(
      shouldBlockYouTubeRequest(
        page,
        "https://googleads.g.doubleclick.net/pagead/id",
      ),
      false,
    );
});

test("pruning copies only known root/playerResponse ad arrays and preserves actual player data", () => {
  const original = player();
  const cleaned = pruneYouTubePayload(original);
  assert.notEqual(cleaned, original);
  for (const key of ["playerAds", "adPlacements", "adSlots"]) {
    assert.equal(Object.hasOwn(cleaned, key), false);
    assert.equal(original[key].length, 1);
  }
  for (const key of [
    "videoDetails",
    "streamingData",
    "playabilityStatus",
    "captions",
    "responseContext",
  ])
    assert.equal(cleaned[key], original[key], key);
  const envelope = {
    playerResponse: original,
    contents: { playerAds: ["not a player"] },
    account: { loggedIn: true },
  };
  const filtered = pruneYouTubePayload(envelope);
  assert.equal(Object.hasOwn(filtered.playerResponse, "adSlots"), false);
  assert.equal(filtered.contents, envelope.contents);
  assert.equal(filtered.account, envelope.account);
});

test("unrecognized payloads, immutable properties, and getters remain untouched", () => {
  for (const value of [
    null,
    undefined,
    [],
    42,
    "malformed",
    { message: "login required" },
    { adSlots: "schema changed" },
    { playerResponse: "encoded unknown" },
    { contents: { playerAds: [] } },
  ])
    assert.equal(pruneYouTubePayload(value), value);
  const immutable = Object.freeze({ playerAds: [] });
  assert.equal(pruneYouTubePayload(immutable), immutable);
  const accessor = {
    get adSlots() {
      throw Error("Do not read arbitrary getter");
    },
  };
  assert.equal(pruneYouTubePayload(accessor), accessor);
  const cyclic = {};
  cyclic.playerResponse = cyclic;
  assert.equal(pruneYouTubePayload(cyclic), cyclic);
});

test("plugin intercept returns a bodyless uncached 204 and respects disabled/navigation state", async () => {
  const f = fixture();
  const context = {
    parsed: {
      clientUrl: new URL(youtube),
      url: new URL("https://googleads.g.doubleclick.net/pagead/id"),
      destination: "script",
    },
  };
  const props = await f.run("intercept", context);
  assert.equal(props.response.status, 204);
  assert.equal(props.response.body, null);
  assert.equal(props.response.headers.get("cache-control"), "no-store");
  f.enable(false);
  assert.equal((await f.run("intercept", context)).response, undefined);
  f.enable(true);
  assert.equal(
    (
      await f.run("intercept", {
        parsed: { ...context.parsed, destination: "document" },
      })
    ).response,
    undefined,
  );
  const existing = { status: 403 };
  assert.equal(
    (await f.run("intercept", context, { response: existing })).response,
    existing,
  );
});

test("player JSON changes preserve content and remove stale representation headers", async () => {
  const f = fixture();
  const original = JSON.stringify(player());
  const props = response(original, {
    "content-length": String(original.length),
    etag: "fixture",
    "content-md5": "fixture",
    "content-encoding": "gzip",
  });
  await f.run("response", { parsed: { url: new URL(playerUrl) } }, props);
  assert.equal(
    Object.hasOwn(JSON.parse(props.response.body), "playerAds"),
    false,
  );
  for (const key of [
    "content-length",
    "etag",
    "content-md5",
    "content-encoding",
  ])
    assert.equal(props.response.headers.has(key), false);
  assert.equal(JSON.parse(props.response.body).playabilityStatus.status, "OK");
});

test("malformed, unchanged, non-JSON, non-player, and disabled responses retain exact bytes", async () => {
  const f = fixture();
  for (const original of [
    '  {"videoDetails":{"videoId":"x"}} \n',
    "{bad JSON",
    "[1,2,3]",
    '{"adSlots":"new representation"}',
  ]) {
    const props = response(original);
    await f.run("response", { parsed: { url: new URL(playerUrl) } }, props);
    assert.equal(props.response.body, original);
  }
  for (const [url, headers, status, enabled] of [
    ["https://example.com/youtubei/v1/player", {}, 200, true],
    ["https://www.youtube.com/api/timedtext", {}, 200, true],
    [playerUrl, { "content-type": "text/html" }, 200, true],
    [playerUrl, {}, 403, true],
    [playerUrl, {}, 200, false],
  ]) {
    f.enable(enabled);
    const original = JSON.stringify(player());
    const props = response(original, headers, status);
    await f.run("response", { parsed: { url: new URL(url) } }, props);
    assert.equal(props.response.body, original);
  }
});

test("native JSON streams filter and unchanged/malformed streams preserve original bytes", async () => {
  const f = fixture();
  for (const value of [
    JSON.stringify(player()),
    "  {broken JSON \n",
    ' {"videoDetails":{"videoId":"x"}}\n',
  ]) {
    const props = response(new Blob([value]).stream());
    await f.run("response", { parsed: { url: new URL(playerUrl) } }, props);
    const output = await bodyText(props);
    if (value.includes("playerAds")) {
      assert.equal(Object.hasOwn(JSON.parse(output), "playerAds"), false);
      assert.equal(JSON.parse(output).videoDetails.videoId, "fixture");
    } else assert.equal(output, value);
  }
});

test("JSON buffering is bounded and oversized chunked bodies retain exact bytes", async () => {
  const f = fixture();
  const original = JSON.stringify({
    playerAds: [1],
    padding: "x".repeat(2 * 1024 * 1024),
  });
  for (const body of [
    original,
    new TextEncoder().encode(original).buffer,
    new Blob([original]),
    new Blob([original]).stream(),
  ]) {
    const props = response(body);
    await f.run("response", { parsed: { url: new URL(playerUrl) } }, props);
    assert.equal(await bodyText(props), original);
  }
});

test("initial player-data hooks install synchronously and leave site properties alone when disabled", async () => {
  const f = fixture();
  const makeWindow = () => {
    const nodes = new Map();
    const doc = {
      head: {
        appendChild(node) {
          nodes.set(node.id, node);
        },
      },
      documentElement: {},
      getElementById(id) {
        return nodes.get(id);
      },
      createElement() {
        return {};
      },
      addEventListener() {},
    };
    return { document: doc };
  };
  const win = makeWindow();
  const context = {
    window: win,
    client: { url: new URL(youtube) },
    isTopLevel: true,
  };
  // Invoke directly: init.post is not awaited by the engine.
  f.frame.hooks.init.post[0](context, {});
  win.ytInitialPlayerResponse = player();
  assert.equal(
    Object.hasOwn(win.ytInitialPlayerResponse, "adPlacements"),
    false,
  );
  assert.equal(
    win.ytInitialPlayerResponse.streamingData.adaptiveFormats.length,
    1,
  );
  assert.match(
    win.document.getElementById("atlas-youtube-adblock").textContent,
    /ytd-display-ad-renderer/,
  );
  f.enable(false);
  const next = player();
  win.ytInitialPlayerResponse = next;
  assert.equal(win.ytInitialPlayerResponse, next);
  const other = makeWindow();
  f.frame.hooks.init.post[0]({ ...context, window: other }, {});
  assert.equal(Object.hasOwn(other, "ytInitialPlayerResponse"), false);
});

test("invalid UTF-8 JSON leaves source bytes untouched", async () => {
  const f = fixture();
  const start = new TextEncoder().encode('{"playerAds":[],"title":"');
  const end = new TextEncoder().encode('"}');
  const invalid = new Uint8Array(start.length + 1 + end.length);
  invalid.set(start);
  invalid[start.length] = 0xff;
  invalid.set(end, start.length + 1);
  for (const body of [
    invalid.buffer,
    new Blob([invalid]),
    new Blob([invalid]).stream(),
  ]) {
    const props = response(body);
    await f.run("response", { parsed: { url: new URL(playerUrl) } }, props);
    assert.deepEqual(
      new Uint8Array(await new Response(props.response.body).arrayBuffer()),
      invalid,
    );
  }
});
