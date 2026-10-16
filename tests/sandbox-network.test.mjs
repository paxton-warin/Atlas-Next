import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { createOriginalDocumentPolicy } from "../runtime/original-document-policy.ts";
import {
  bindSandboxNetwork,
  SANDBOX_NETWORK_PROTOCOL as protocol,
} from "../runtime/sandbox-network.ts";

const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (url, headers = [], body = "website body") => ({
  url,
  status: 200,
  statusText: "OK",
  headers,
  body: new TextEncoder().encode(body).buffer,
});
const originalPolicy = (...contentPolicies) =>
  createOriginalDocumentPolicy({
    documentURL: "https://site.example/page",
    contentPolicies,
  });
test("media destination uses original media-src per hop without becoming a CORS/body grant", async () => {
  const f=fixture(request=>request.url.endsWith("/redirect")?{...response(request.url,[["location","https://denied.example/movie"]]),status:302}:response(request.url),{
    originalPolicy:originalPolicy("default-src 'none';media-src 'self' https://peer.example;connect-src 'none'"),
  });
  try {
    assert.equal((await f.wait(f.send({url:"/movie",destination:"media"}))).type,"response");
    assert.equal((await f.wait(f.send({url:"/movie"}))).code,"original_policy_denied");
    const denied=await f.wait(f.send({url:"https://peer.example/movie",destination:"media",mode:"cors"}));
    assert.equal(denied.code,"cors_denied");
    const opaque=await f.wait(f.send({url:"https://peer.example/movie",destination:"media",mode:"no-cors"}));
    assert.equal(opaque.response.type,"opaque");assert.equal(opaque.response.body.byteLength,0);
    const count=f.calls.length;
    assert.equal((await f.wait(f.send({url:"/redirect",destination:"media"}))).code,"original_policy_denied");
    assert.equal(f.calls.length,count+1);
    assert.equal(f.calls.at(-1)[0].url,"https://site.example/redirect");
  }finally{f.close()}
});
test("trusted original connect policy rejects website fetch before transport or preflight", async () => {
  const s = fixture((request) => response(request.url), {
    originalPolicy: originalPolicy("script-src 'self';connect-src 'none'"),
  });
  try {
    const denied = await s.wait(s.send({ url: "/allowed.js" }));
    assert.equal(denied.code, "original_policy_denied");
    assert.equal(s.calls.length, 0);
    const preflight = await s.wait(
      s.send({
        url: "https://peer.example/api",
        method: "PUT",
        headers: [["x-test", "yes"]],
      }),
    );
    assert.equal(preflight.code, "original_policy_denied");
    assert.equal(s.calls.length, 0);
  } finally {
    s.close();
  }
});
test("resource destination and nonce metadata never grant readable no-CORS bytes", async () => {
  const s = fixture((request) => response(request.url), {
    originalPolicy: originalPolicy(
      "script-src 'self' 'nonce-dGVzdA==';connect-src 'none'",
    ),
  });
  try {
    const own = await s.wait(
      s.send({ url: "/allowed.js", destination: "script" }),
    );
    assert.equal(own.type, "response");
    const cors = await s.wait(
      s.send({
        url: "https://peer.example/code.js",
        destination: "script",
        policyNonce: "dGVzdA==",
        mode: "cors",
      }),
    );
    assert.equal(cors.code, "cors_denied");
    const opaque = await s.wait(
      s.send({
        url: "https://peer.example/code.js",
        destination: "script",
        policyNonce: "dGVzdA==",
        mode: "no-cors",
      }),
    );
    assert.equal(opaque.response.type, "opaque");
    assert.equal(opaque.response.body.byteLength, 0);
    const unknown = await s.wait(
      s.send({ url: "/allowed.js", destination: "iframe" }),
    );
    assert.equal(unknown.code, "original_policy_resource_kind_required");
  } finally {
    s.close();
  }
});
test("original CSP checks every redirect BEFORE sending next hop", async () => {
  const s = fixture(
    (request) => ({
      ...response(request.url, [["location", "https://denied.example/next"]]),
      status: 302,
    }),
    { originalPolicy: originalPolicy("connect-src 'self'") },
  );
  try {
    const r = await s.wait(s.send({ url: "/redirect" }));
    assert.equal(r.code, "original_policy_denied");
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0][0].url, "https://site.example/redirect");
  } finally {
    s.close();
  }
});
test("redirect matching skips CSP path after redirect without skipping host authorization", async () => {
  const s = fixture(
    (request) =>
      request.url.endsWith("/allowed/start")
        ? { ...response(request.url, [["location", "/outside"]]), status: 302 }
        : response(request.url),
    {
      originalPolicy: originalPolicy(
        "connect-src https://site.example/allowed/",
      ),
    },
  );
  try {
    const r = await s.wait(s.send({ url: "/allowed/start" }));
    assert.equal(r.type, "response");
    assert.equal(r.response.url, "https://site.example/outside");
    assert.equal(s.calls.length, 2);
  } finally {
    s.close();
  }
});
test("upgrade-insecure-requests changes trusted transport URL before mixed-content checks", async () => {
  const s = fixture((request) => response(request.url), {
    originalPolicy: originalPolicy(
      "upgrade-insecure-requests;connect-src 'self'",
    ),
  });
  try {
    const r = await s.wait(s.send({ url: "http://site.example/api" }));
    assert.equal(r.type, "response");
    assert.equal(s.calls[0][0].url, "https://site.example/api");
  } finally {
    s.close();
  }
});
function fixture(fetch, options = {}) {
  const { port1, port2 } = new MessageChannel(),
    replies = [],
    calls = [];
  const broker = bindSandboxNetwork({
    documentId: "document-capability",
    documentURL: "https://site.example/page",
    frontendOrigin: "https://atlas.example",
    forbiddenOrigins: ["https://node.example"],
    port: port1,
    fetch: async (...args) => {
      calls.push(args);
      return fetch(...args);
    },
    ...options,
  });
  port2.on("message", (value) => replies.push(value));
  let next = 1;
  const send = (request, extra = {}) => {
    const sequence = next++;
    port2.postMessage({
      protocol,
      documentId: "document-capability",
      sequence,
      type: "fetch",
      request: { url: "/resource", method: "GET", headers: [], ...request },
      ...extra,
    });
    return sequence;
  };
  const wait = async (sequence) => {
    for (let i = 0; i < 100; i++) {
      const reply = replies.find((r) => r.sequence === sequence);
      if (reply) return reply;
      await pause(5);
    }
    assert.fail("network capability did not reply");
  };
  return {
    broker,
    replies,
    calls,
    send,
    wait,
    port: port2,
    close() {
      broker.dispose();
      port2.close();
    },
  };
}

test("network broker fixes logical origin and denies frontend, nodes, credentials, forbidden headers, and mixed content", async () => {
  const f = fixture((r) => response(r.url));
  try {
    for (const request of [
      { url: "https://atlas.example/api/admin" },
      { url: "https://node.example/relay/ticket" },
      { url: "https://name:secret@site.example" },
      { url: "http://site.example" },
      { url: "file:///secret" },
      { headers: [["cookie", "frontend=secret"]] },
      { headers: [["Origin", "https://peer.example"]] },
      { headers: [["Sec-Fetch-Site", "same-origin"]] },
      { method: "CONNECT" },
      { mode: "same-origin", url: "https://peer.example" },
    ]) {
      assert.equal((await f.wait(f.send(request))).type, "error");
    }
    assert.equal(f.calls.length, 0);
    const result = await f.wait(f.send({}));
    assert.equal(result.type, "response");
    assert.equal(result.response.url, "https://site.example/resource");
    assert.equal(f.calls[0][1].origin, "https://site.example");
    assert.equal(f.calls[0][1].documentURL, "https://site.example/page");
    assert.equal(Object.isFrozen(f.calls[0][1]), true);
  } finally {
    f.close();
  }
});

test("cross-site no-cors destination spoof never exposes bytes or response headers", async () => {
  const f = fixture((r) =>
    response(r.url, [
      ["x-secret", "hidden"],
      ["set-cookie", "auth=hidden"],
    ]),
  );
  try {
    const reply = await f.wait(
      f.send({
        url: "https://peer.example/secret",
        mode: "no-cors",
        destination: "script",
      }),
    );
    assert.deepEqual(
      { ...reply.response, body: reply.response.body.byteLength },
      {
        url: "",
        status: 0,
        statusText: "",
        headers: [],
        body: 0,
        type: "opaque",
        redirected: false,
      },
    );
    assert.equal(
      (
        await f.wait(
          f.send({ url: "https://peer.example/secret", mode: "cors" }),
        )
      ).code,
      "cors_denied",
    );
    assert.equal(
      (
        await f.wait(
          f.send({
            url: "https://peer.example/secret",
            mode: "no-cors",
            headers: [["authorization", "secret"]],
          }),
        )
      ).code,
      "cors_denied",
    );
  } finally {
    f.close();
  }
});

test("CORS credentials and exposed headers are checked against parent-assigned website identity", async () => {
  let credentials = false;
  const f = fixture((r) =>
    response(r.url, [
      [
        "access-control-allow-origin",
        credentials ? "https://site.example" : "*",
      ],
      ["access-control-allow-credentials", "true"],
      ["access-control-expose-headers", "x-public,set-cookie"],
      ["content-type", "text/plain"],
      ["x-public", "visible"],
      ["x-secret", "hidden"],
      ["set-cookie", "website=secret"],
    ]),
  );
  try {
    let result = await f.wait(f.send({ url: "https://peer.example" }));
    assert.equal(result.response.type, "cors");
    assert.deepEqual(result.response.headers, [
      ["content-type", "text/plain"],
      ["x-public", "visible"],
    ]);
    assert.equal(
      (
        await f.wait(
          f.send({ url: "https://peer.example", credentials: "include" }),
        )
      ).code,
      "cors_denied",
    );
    credentials = true;
    result = await f.wait(
      f.send({ url: "https://peer.example", credentials: "include" }),
    );
    assert.equal(result.type, "response");
    const native = await f.wait(f.send({}));
    assert.equal(
      native.response.headers.some(([n]) => n === "set-cookie"),
      false,
    );
  } finally {
    f.close();
  }
});

test("unsafe CORS requests require anonymous preflight; wildcard never grants Authorization", async () => {
  let authorize = false;
  const f = fixture((r, ctx) =>
    response(
      r.url,
      ctx.preflight
        ? [
            ["access-control-allow-origin", "https://site.example"],
            ["access-control-allow-methods", "PUT"],
            [
              "access-control-allow-headers",
              authorize ? "authorization,x-test" : "*",
            ],
          ]
        : [["access-control-allow-origin", "https://site.example"]],
    ),
  );
  try {
    const request = {
      url: "https://peer.example/api",
      method: "PUT",
      headers: [
        ["Authorization", "website-token"],
        ["X-Test", "value"],
      ],
    };
    assert.equal((await f.wait(f.send(request))).code, "cors_preflight_denied");
    assert.equal(
      f.calls.length,
      1,
      "denied preflight never sends actual write",
    );
    assert.equal(f.calls[0][0].credentials, "omit");
    assert.equal(f.calls[0][1].preflight, true);
    authorize = true;
    assert.equal((await f.wait(f.send(request))).type, "response");
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2][0].method, "PUT");
    assert.equal(f.calls[2][1].preflight, false);
  } finally {
    f.close();
  }
});

test("transport redirects and oversized binary replies fail closed", async () => {
  let kind = "redirect";
  const f = fixture(
    (r) =>
      kind === "redirect"
        ? response("https://atlas.example/api/admin")
        : response(r.url, [], "12345"),
    { maxResponseBytes: 4 },
  );
  try {
    assert.equal((await f.wait(f.send({}))).code, "destination_denied");
    kind = "size";
    assert.equal((await f.wait(f.send({}))).code, "invalid_network_response");
  } finally {
    f.close();
  }
});

test("network queue bounds concurrency and storage; queued cancellation never calls transport", async () => {
  const resolve = [];
  const f = fixture(
    (r) => new Promise((ok) => resolve.push(() => ok(response(r.url)))),
  );
  try {
    const ids = Array.from({ length: 33 }, () => f.send({}));
    await pause();
    assert.equal(f.calls.length, 4);
    assert.equal(f.broker.pending, 32);
    assert.equal((await f.wait(ids[32])).code, "network_backpressure");
    const cancel = f.send(
      {},
      { type: "cancel", request: undefined, targetSequence: ids[4] },
    );
    assert.equal((await f.wait(ids[4])).code, "request_aborted");
    assert.equal((await f.wait(cancel)).type, "cancelled");
    resolve[0]();
    await f.wait(ids[0]);
    await pause();
    assert.equal(f.calls.length, 5);
    assert.equal(f.broker.pending, 30);
    f.close();
    assert.equal(
      f.calls.slice(1).every(([, ctx]) => ctx.signal.aborted),
      true,
    );
  } finally {
    f.close();
    for (const done of resolve) done();
  }
});

test("hung transport revokes capability at bounded deadline and discards late results", async () => {
  let finish;
  const f = fixture(
    (r) =>
      new Promise((resolve) => {
        finish = () => resolve(response(r.url));
      }),
    { timeoutMs: 30 },
  );
  try {
    const id = f.send({});
    assert.equal((await f.wait(id)).code, "network_timeout");
    assert.equal(f.broker.live, false);
    assert.equal(f.calls[0][1].signal.aborted, true);
    finish();
    await pause();
    assert.equal(f.replies.filter((r) => r.type === "response").length, 0);
  } finally {
    f.close();
  }
});

test("malformed capabilities and replay never advance document identity or invoke transport", async () => {
  const f = fixture((r) => response(r.url));
  try {
    f.port.postMessage({
      protocol,
      documentId: "other-document",
      sequence: 1,
      type: "fetch",
    });
    await pause();
    assert.equal(f.replies[0].code, "invalid_capability_message");
    const id = f.send({});
    await f.wait(id);
    for (let i = 0; i < 3; i++)
      f.port.postMessage({
        protocol,
        documentId: "document-capability",
        sequence: 1,
        type: "fetch",
      });
    await pause();
    assert.equal(f.calls.length, 1);
    assert.equal(f.broker.live, false);
  } finally {
    f.close();
  }
});

const redirectResponse = (url, status, location, headers = []) => ({
  ...response(
    url,
    location === undefined ? headers : [["location", location], ...headers],
    "",
  ),
  status,
  statusText: "Redirect",
});
const cors = (origin = "https://site.example") => [
  ["access-control-allow-origin", origin],
];

test("checked same-origin redirects preserve relative resolution and final URL/redirected metadata", async () => {
  const f = fixture((r) =>
    r.url.endsWith("/resource")
      ? redirectResponse(r.url, 302, "./final")
      : response(r.url, [["x-visible", "yes"]]),
  );
  try {
    const result = await f.wait(f.send({}));
    assert.equal(result.response.url, "https://site.example/final");
    assert.equal(result.response.redirected, true);
    assert.equal(result.response.type, "basic");
    assert.equal(f.calls.length, 2);
    assert.equal(
      f.calls.every(([r]) => r.redirect === undefined),
      true,
      "transport never receives redirect authority",
    );
    assert.deepEqual(
      f.calls.map(([, c]) => [
        c.requestOrigin,
        c.responseTaint,
        c.redirectCount,
      ]),
      [
        ["https://site.example", "basic", 0],
        ["https://site.example", "basic", 1],
      ],
    );
  } finally {
    f.close();
  }
});

test("every redirect destination rechecks frontend/node, credentials, schemes, same-origin mode and downgrade before transport", async () => {
  for (const [target, code] of [
    ["https://atlas.example/api/admin", "destination_denied"],
    ["https://node.example/relay", "destination_denied"],
    ["https://u:p@site.example/final", "destination_denied"],
    ["file:///etc/passwd", "destination_denied"],
    ["http://site.example/final", "mixed_content_denied"],
  ]) {
    const f = fixture((r) => redirectResponse(r.url, 302, target));
    try {
      assert.equal((await f.wait(f.send({}))).code, code);
      assert.equal(f.calls.length, 1);
    } finally {
      f.close();
    }
  }
  const f = fixture((r) =>
    redirectResponse(r.url, 302, "https://peer.example/final"),
  );
  try {
    assert.equal(
      (await f.wait(f.send({ mode: "same-origin" }))).code,
      "cors_denied",
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});

test("redirect method rules clear POST301/302 and non-HEAD303 body headers but preserve307/308 bytes", async () => {
  for (const [status, method, expected] of [
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [303, "PUT", "GET"],
    [303, "HEAD", "HEAD"],
    [307, "POST", "POST"],
    [308, "PUT", "PUT"],
    [301, "PUT", "PUT"],
  ]) {
    const f = fixture((r) =>
      r.url.endsWith("/resource")
        ? redirectResponse(r.url, status, "/final")
        : response(r.url),
    );
    try {
      const reply = await f.wait(
        f.send({
          method,
          body:
            method === "HEAD"
              ? undefined
              : new TextEncoder().encode("payload").buffer,
          headers: [
            ["content-encoding", "identity"],
            ["content-language", "en"],
            ["content-location", "/old"],
            ["content-type", "application/json"],
            ["x-test", "retained"],
            ["authorization", "site-token"],
          ],
        }),
      );
      assert.equal(reply.type, "response");
      const next = f.calls.at(-1)[0];
      assert.equal(next.method, expected);
      if (expected === "GET") {
        assert.equal(next.body, undefined);
        assert.deepEqual(next.headers, [
          ["authorization", "site-token"],
          ["x-test", "retained"],
        ]);
      } else if (method !== "HEAD")
        assert.equal(new TextDecoder().decode(next.body), "payload");
    } finally {
      f.close();
    }
  }
});

test("cross-origin redirect strips Authorization, re-preflights remaining headers, and never regains same-origin credentials", async () => {
  const f = fixture((r, c) =>
    c.preflight
      ? response(
          r.url,
          [
            ...cors(c.requestOrigin),
            [
              "access-control-allow-methods",
              r.headers.find(([n]) => n === "access-control-request-method")[1],
            ],
            ["access-control-allow-headers", "x-test"],
          ],
          "",
        )
      : r.url.endsWith("/resource")
        ? redirectResponse(r.url, 307, "https://peer.example/step")
        : r.url.endsWith("/step")
          ? redirectResponse(
              r.url,
              307,
              "https://site.example/final",
              cors(c.requestOrigin),
            )
          : response(r.url, cors(c.requestOrigin)),
  );
  try {
    assert.equal(
      (
        await f.wait(
          f.send({
            headers: [
              ["authorization", "site-token"],
              ["x-test", "retained"],
            ],
          }),
        )
      ).type,
      "response",
    );
    const actual = f.calls.filter(([, c]) => !c.preflight);
    assert.deepEqual(
      actual.map(([r, c]) => [
        new URL(r.url).origin,
        r.credentials,
        c.origin,
        c.requestOrigin,
        c.responseTaint,
      ]),
      [
        [
          "https://site.example",
          "include",
          "https://site.example",
          "https://site.example",
          "basic",
        ],
        [
          "https://peer.example",
          "omit",
          "https://site.example",
          "https://site.example",
          "cors",
        ],
        [
          "https://site.example",
          "omit",
          "https://site.example",
          "null",
          "cors",
        ],
      ],
    );
    assert.equal(
      actual[0][0].headers.some(([n]) => n === "authorization"),
      true,
    );
    assert.equal(
      actual
        .slice(1)
        .every(([r]) => !r.headers.some(([n]) => n === "authorization")),
      true,
    );
    assert.equal(f.calls.filter(([, c]) => c.preflight).length, 2);
    assert.equal(
      f.calls
        .filter(([, c]) => c.preflight)
        .every(([r]) => r.credentials === "omit"),
      true,
    );
  } finally {
    f.close();
  }
});

test("CORS permission applies to intermediate redirects and null-tainted final responses", async () => {
  let allowFirst = false,
    allowNull = false;
  const f = fixture((r, c) =>
    r.url.startsWith("https://peer.example")
      ? redirectResponse(
          r.url,
          302,
          "https://third.example/final",
          allowFirst ? cors() : [],
        )
      : response(r.url, cors(allowNull ? "null" : "https://site.example")),
  );
  try {
    assert.equal(
      (await f.wait(f.send({ url: "https://peer.example/start" }))).code,
      "cors_denied",
    );
    assert.equal(f.calls.length, 1);
    allowFirst = true;
    assert.equal(
      (await f.wait(f.send({ url: "https://peer.example/start" }))).code,
      "cors_denied",
    );
    assert.equal(f.calls.length, 3);
    allowNull = true;
    const result = await f.wait(f.send({ url: "https://peer.example/start" }));
    assert.equal(result.type, "response");
    assert.equal(result.response.type, "cors");
    assert.equal(result.response.redirected, true);
    assert.equal(f.calls.at(-1)[1].requestOrigin, "null");
  } finally {
    f.close();
  }
});

test("cross-origin no-cors redirect chains remain opaque even when the final URL returns to document origin", async () => {
  const f = fixture((r) =>
    r.url.endsWith("/resource")
      ? redirectResponse(r.url, 302, "https://peer.example/step")
      : r.url.endsWith("/step")
        ? redirectResponse(r.url, 302, "https://site.example/final")
        : response(r.url, [["x-secret", "hidden"]], "secret"),
  );
  try {
    const result = await f.wait(f.send({ mode: "no-cors" }));
    assert.deepEqual(
      { ...result.response, body: result.response.body.byteLength },
      {
        url: "",
        status: 0,
        statusText: "",
        headers: [],
        body: 0,
        type: "opaque",
        redirected: false,
      },
    );
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls.at(-1)[0].credentials, "omit");
  } finally {
    f.close();
  }
});

test("manual redirects expose no Location, headers or bytes; error mode never follows; no-Location and nonredirect300 statuses remain responses", async () => {
  let status = 302,
    location = "https://peer.example/secret";
  const f = fixture((r) =>
    redirectResponse(r.url, status, location, [["x-secret", "hidden"]]),
  );
  try {
    const manual = await f.wait(f.send({ redirect: "manual" }));
    assert.deepEqual(
      { ...manual.response, body: manual.response.body.byteLength },
      {
        url: "https://site.example/resource",
        status: 0,
        statusText: "",
        headers: [],
        body: 0,
        type: "opaqueredirect",
        redirected: false,
      },
    );
    assert.equal(f.calls.length, 1);
    assert.equal(
      (await f.wait(f.send({ redirect: "error" }))).code,
      "redirect_denied",
    );
    assert.equal(f.calls.length, 2);
    location = undefined;
    assert.equal((await f.wait(f.send({}))).response.status, 302);
    status = 300;
    location = "https://peer.example/secret";
    assert.equal((await f.wait(f.send({}))).response.status, 300);
    assert.equal(f.calls.length, 4);
  } finally {
    f.close();
  }
});

test("20 redirects succeed, a21st is rejected, cumulative bytes remain bounded and preflight redirects never execute writes", async () => {
  let count = 20;
  const f = fixture((r, c) =>
    c.preflight
      ? redirectResponse(r.url, 307, "/other", cors())
      : count-- > 0
        ? redirectResponse(r.url, 302, "/resource")
        : response(r.url),
  );
  try {
    assert.equal((await f.wait(f.send({}))).type, "response");
    assert.equal(f.calls.length, 21);
    count = 21;
    assert.equal((await f.wait(f.send({}))).code, "redirect_limit");
    assert.equal(f.calls.length, 42);
    assert.equal(
      (
        await f.wait(
          f.send({ url: "https://peer.example/write", method: "PUT" }),
        )
      ).code,
      "cors_preflight_denied",
    );
    assert.equal(f.calls.length, 43);
  } finally {
    f.close();
  }
  let first = true;
  const bounded = fixture(
    (r) =>
      first
        ? ((first = false),
          {
            ...redirectResponse(r.url, 302, "/final"),
            body: new Uint8Array(3).buffer,
          })
        : response(r.url, [], "123"),
    { maxResponseBytes: 5 },
  );
  try {
    assert.equal(
      (await bounded.wait(bounded.send({}))).code,
      "invalid_network_response",
    );
  } finally {
    bounded.close();
  }
});

test("redirect-preflight allow-methods matching remains method-case-sensitive", async () => {
  const f = fixture((r, c) =>
    response(
      r.url,
      c.preflight
        ? [...cors(), ["access-control-allow-methods", "PATCH"]]
        : cors(),
    ),
  );
  try {
    assert.equal(
      (await f.wait(f.send({ url: "https://peer.example", method: "patch" })))
        .code,
      "cors_preflight_denied",
    );
    assert.equal(f.calls[0][0].headers[0][1], "patch");
  } finally {
    f.close();
  }
});

test("Location duplicates match native HTTP: identical values resolve once, conflicting values never issue a synthetic comma-joined hop", async () => {
  let conflicting = true;
  const f = fixture((r) =>
    r.url.endsWith("/resource")
      ? redirectResponse(r.url, 302, "/final", [
          ["Location", conflicting ? "/other" : "/final"],
        ])
      : response(r.url),
  );
  try {
    assert.equal((await f.wait(f.send({}))).code, "invalid_redirect");
    assert.equal(f.calls.length, 1);
    conflicting = false;
    const result = await f.wait(f.send({}));
    assert.equal(result.response.url, "https://site.example/final");
    assert.equal(f.calls.length, 3);
  } finally {
    f.close();
  }
});

test("XHR forced preflight survives the document channel, stays anonymous and cannot be a truthy non-boolean", async () => {
  let allow = true;
  const f = fixture((r, c) =>
    response(
      r.url,
      c.preflight
        ? allow
          ? [...cors(), ["access-control-allow-methods", "POST"]]
          : []
        : cors(),
    ),
  );
  try {
    const request = {
      url: "https://peer.example/upload",
      method: "POST",
      forcePreflight: true,
    };
    assert.equal((await f.wait(f.send(request))).type, "response");
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0][0].method, "OPTIONS");
    assert.equal(f.calls[0][0].credentials, "omit");
    assert.equal(f.calls[0][1].preflight, true);
    assert.equal(f.calls[1][0].method, "POST");
    allow = false;
    assert.equal((await f.wait(f.send(request))).code, "cors_preflight_denied");
    assert.equal(f.calls.length, 3, "denied preflight never sends the upload");
    assert.equal(
      (await f.wait(f.send({ ...request, forcePreflight: "false" }))).code,
      "invalid_network_request",
    );
    assert.equal(f.calls.length, 3);
    assert.equal(
      (await f.wait(f.send({ method: "POST", forcePreflight: true }))).type,
      "response",
    );
    assert.equal(
      f.calls[3][1].preflight,
      false,
      "same logical origin needs no CORS preflight",
    );
  } finally {
    f.close();
  }
});
