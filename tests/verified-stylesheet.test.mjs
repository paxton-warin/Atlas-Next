import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authenticateStylesheet,
  createVerifiedStylesheetPlugin,
  splitLinkHeader,
} from "../runtime/verified-stylesheet.ts";

const url =
  "https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/css/discord-2022.shared.1353b75ab.min.css";
const original = 'body{background:url("/background.png");color:rgb(1,2,3)}';
const sri = (text, algorithm = "sha384") =>
  algorithm + "-" + createHash(algorithm).update(text).digest("base64");
function fixture({ body = original, allow = "*", status = 200 } = {}) {
  const callbacks = new Map();
  class ManagedPlugin {
    install() {}
    tap(hook, callback) {
      callbacks.set(hook, callback);
    }
  }
  const requests = [];
  const frame = {
    hooks: { fetch: { intercept: {}, response: {} } },
    fetchHandler: {
      context: {},
      client: {
        async fetch(target, init) {
          requests.push({ target: target.href, init });
          return new Response(body, {
            status,
            headers: {
              "Content-Type": "text/css",
              "Access-Control-Allow-Origin": allow,
            },
          });
        },
      },
    },
  };
  const globals = {
    $runtimekitController: { ManagedPlugin },
    $runtimekit: {
      RuntimeKitHeaders: { fromRawHeaders: (headers) => new Headers(headers) },
      restoreurl: (value) => value,
      transformCss: (text) =>
        text.replace("/background.png", "/proxy/background.png"),
    },
  };
  createVerifiedStylesheetPlugin(globals).install(frame);
  const document = async (
    header = `<${url}>; rel=preload; as=style; crossorigin; integrity="${sri(original)}"`,
    page = "https://discord.com/",
  ) => {
    const props = {
      response: { status: 200, headers: new Headers({ Link: header }) },
    };
    await callbacks.get(frame.hooks.fetch.response)(
      {
        request: { method: "GET" },
        parsed: { url: new URL(page), destination: "document" },
      },
      props,
    );
    return props;
  };
  const resource = (target = url, destination = "style") => {
    const props = {};
    callbacks.get(frame.hooks.fetch.intercept)(
      { parsed: { url: new URL(target), destination } },
      props,
    );
    return props.response;
  };
  return { document, resource, requests };
}

test("Link parsing keeps comma-containing URL targets and quoted parameters intact", () => {
  assert.deepEqual(
    splitLinkHeader(
      '<https://example.test/a,b>; title="a,b"; rel=preload, <https://example.test/c>; rel=preconnect',
    ),
    [
      '<https://example.test/a,b>; title="a,b"; rel=preload',
      " <https://example.test/c>; rel=preconnect",
    ],
  );
});

test("publisher authentication uses the strongest supported SRI algorithm, never a weaker matching digest", async () => {
  const bytes = new TextEncoder().encode(original);
  const good = await authenticateStylesheet(bytes, sri(original));
  assert.equal(good.algorithm, "sha384");
  await assert.rejects(
    authenticateStylesheet(
      bytes,
      sri(original, "sha256") + " " + sri("tampered", "sha512"),
    ),
    /mismatch/,
  );
  await assert.rejects(
    authenticateStylesheet(bytes, "sha1-abc"),
    /unsupported/,
  );
});

test("verified original bytes are rewritten once and exact rewritten bytes receive a new authenticated preload digest", async () => {
  const f = fixture();
  const result = await f.document();
  const served = f.resource();
  assert.equal(served.status, 200);
  assert.notEqual(served.body, original);
  assert.ok(
    result.response.headers
      .get("link")
      .includes('integrity="' + sri(served.body) + '"'),
  );
  assert.ok(!result.response.headers.get("link").includes(sri(original)));
  assert.equal(served.headers.get("content-encoding"), null);
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.deepEqual(f.requests, [
    {
      target: url,
      init: {
        method: "GET",
        headers: [
          ["Accept", "text/css,*/*;q=0.1"],
          ["Origin", "https://discord.com"],
        ],
        redirect: "manual",
      },
    },
  ]);
});

test("mismatched bytes, non-public CORS and failed responses remain blocked without replacing upstream integrity", async () => {
  for (const options of [
    { body: "tampered" },
    { allow: "https://other.test" },
    { status: 503 },
  ]) {
    const f = fixture(options),
      result = await f.document(),
      served = f.resource();
    assert.equal(served.status, 502);
    assert.equal(
      served.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.ok(result.response.headers.get("link").includes(sri(original)));
    assert.notEqual(served.body, original);
  }
});

test("unrelated pages, asset hosts, missing integrity, scripts, fonts and third-party requests are untouched", async () => {
  for (const [header, page] of [
    [
      `<${url}>; rel=preload; as=style; integrity="${sri(original)}"`,
      "https://discord.com/login",
    ],
    [
      `<${url.replace("website-files.com", "website-files.com.evil.test")}>; rel=preload; as=style; integrity="${sri(original)}"`,
      "https://discord.com/",
    ],
    [`<${url}>; rel=preload; as=style`, "https://discord.com/"],
    [
      `<${url}>; rel=preload; as=script; integrity="${sri(original)}"`,
      "https://discord.com/",
    ],
  ]) {
    const f = fixture();
    await f.document(header, page);
    assert.equal(f.requests.length, 0);
    assert.equal(f.resource(), undefined);
  }
  const f = fixture();
  await f.document();
  assert.equal(f.resource(url, "font"), undefined);
  assert.equal(f.resource("https://other.test/style.css"), undefined);
});

test("oversized resource streams are rejected before any rewritten stylesheet can be served", async () => {
  const f = fixture({ body: "x".repeat(4 * 1024 * 1024 + 1) });
  const result = await f.document();
  assert.equal(f.resource().status, 502);
  assert.ok(result.response.headers.get("link").includes(sri(original)));
});
