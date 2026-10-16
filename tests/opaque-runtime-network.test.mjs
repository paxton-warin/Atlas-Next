import test from "node:test";
import assert from "node:assert/strict";
import { bindSandboxNetwork } from "../runtime/sandbox-network.ts";
import { createOpaqueNetworkClient } from "../runtime/opaque-runtime-adapter.ts";

function fixture(fetch) {
  const channel = new MessageChannel();
  const documentId = "real-bound-document";
  const documentURL = "https://website.test/path/page";
  const calls = [];
  const broker = bindSandboxNetwork({
    port: channel.port1,
    documentId,
    documentURL,
    frontendOrigin: "https://atlas.test",
    forbiddenOrigins: ["https://node.test"],
    fetch: async (...args) => {
      calls.push(args);
      return await fetch(...args);
    },
  });
  const client = createOpaqueNetworkClient({
    port: channel.port2,
    documentId,
    documentURL,
  });
  return {
    client,
    broker,
    calls,
    close() {
      client.dispose();
      broker.dispose();
    },
  };
}
const response = (url, headers = [], body = "fixture-body") => ({
  url,
  status: 200,
  statusText: "OK",
  headers,
  body: new TextEncoder().encode(body).buffer,
});

test("actual network-v2 client and trusted broker agree on request, CORS, cookies and denied infrastructure", async () => {
  const s = fixture((request) =>
    response(request.url, [
      ["x-fixture", "yes"],
      ["set-cookie", "private=website-cookie"],
    ]),
  );
  try {
    const basic = await s.client.fetch("../api", {
      method: "POST",
      body: "payload",
    });
    assert.equal(basic.type, "basic");
    assert.equal(await basic.text(), "fixture-body");
    assert.equal(basic.headers.get("set-cookie"), null);
    assert.equal(new TextDecoder().decode(s.calls[0][0].body), "payload");
    assert.equal(s.calls[0][1].origin, "https://website.test");
    assert.equal(s.calls[0][1].documentURL, "https://website.test/path/page");
    assert.equal(s.calls[0][1].preflight, false);
    const calls = s.calls.length;
    await assert.rejects(s.client.fetch("https://atlas.test/api/admin"), {
      code: "destination_denied",
    });
    await assert.rejects(s.client.fetch("https://node.test/relay/secret"), {
      code: "destination_denied",
    });
    assert.equal(s.calls.length, calls);
    await assert.rejects(s.client.fetch("https://peer.test/private"), {
      code: "cors_denied",
    });
    const opaque = await s.client.fetch("https://peer.test/private", {
      mode: "no-cors",
    });
    assert.equal(opaque.type, "opaque");
    assert.equal(opaque.status, 0);
    assert.equal(await opaque.text(), "");
    assert.equal(opaque.body, null);
    assert.equal([...opaque.headers].length, 0);
  } finally {
    s.close();
  }
});

test("trusted broker preflights unsafe writes and returns only exposed cross-site headers", async () => {
  const s = fixture((request, context) =>
    response(
      request.url,
      context.preflight
        ? [
            ["access-control-allow-origin", "https://website.test"],
            ["access-control-allow-credentials", "true"],
            ["access-control-allow-methods", "PUT"],
            ["access-control-allow-headers", "x-fixture"],
          ]
        : [
            ["access-control-allow-origin", "https://website.test"],
            ["access-control-allow-credentials", "true"],
            ["access-control-expose-headers", "x-visible"],
            ["x-visible", "yes"],
            ["x-private", "hidden"],
            ["set-cookie", "private=1"],
          ],
    ),
  );
  try {
    const reply = await s.client.fetch("https://peer.test/resource", {
      method: "PUT",
      headers: { "x-fixture": "value" },
      credentials: "include",
      body: "put-payload",
    });
    assert.equal(reply.type, "cors");
    assert.equal(reply.headers.get("x-visible"), "yes");
    assert.equal(reply.headers.get("x-private"), null);
    assert.equal(reply.headers.get("set-cookie"), null);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0][0].method, "OPTIONS");
    assert.equal(s.calls[0][0].credentials, "omit");
    assert.equal(s.calls[1][0].method, "PUT");
  } finally {
    s.close();
  }
});

test("destination spoofing cannot grant readable no-cors script bytes", async () => {
  const s = fixture((request) =>
    response(request.url, [["x-secret", "hidden"]], "cross-site secret"),
  );
  try {
    const result = await s.client.request({
      url: "https://peer.test/native.js",
      method: "GET",
      headers: [],
      mode: "no-cors",
      credentials: "same-origin",
      destination: "script",
      isModule: false,
    });
    assert.equal(result.type, "opaque");
    assert.equal(result.body.byteLength, 0);
    assert.equal(result.url, "");
    assert.deepEqual(result.headers, []);
  } finally {
    s.close();
  }
});

test("port cancellation reaches the real trusted transport AbortSignal", async () => {
  let wasAborted = false;
  let started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  const s = fixture(async (_request, context) => {
    started();
    await new Promise((resolve) =>
      context.signal.addEventListener(
        "abort",
        () => {
          wasAborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return response("https://website.test/slow");
  });
  try {
    const control = new AbortController();
    const pending = s.client.fetch("/slow", { signal: control.signal });
    await start;
    control.abort();
    await assert.rejects(pending, { name: "AbortError" });
    for (let n = 0; n < 100 && !wasAborted; n++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(wasAborted, true);
  } finally {
    s.close();
  }
});

test("real opaque client preserves checked redirect follow/error/manual and native filtered clone shape", async () => {
  const s = fixture((request) =>
    request.url.endsWith("/start")
      ? { ...response(request.url, [["location", "/final"]]), status: 302 }
      : response(request.url, [], "final-body"),
  );
  try {
    const followed = await s.client.fetch("/start");
    assert.equal(followed.url, "https://website.test/final");
    assert.equal(followed.redirected, true);
    assert.equal(followed.clone().redirected, true);
    assert.equal(await followed.text(), "final-body");
    const manual = await s.client.fetch("/start", { redirect: "manual" });
    assert.equal(manual.type, "opaqueredirect");
    assert.equal(manual.url, "https://website.test/start");
    assert.equal(manual.redirected, false);
    assert.equal(manual.status, 0);
    assert.equal(manual.body, null);
    assert.equal(await manual.clone().text(), "");
    assert.equal(manual.clone().url, manual.url);
    await assert.rejects(s.client.fetch("/start", { redirect: "error" }), {
      code: "redirect_denied",
    });
  } finally {
    s.close();
  }
});
