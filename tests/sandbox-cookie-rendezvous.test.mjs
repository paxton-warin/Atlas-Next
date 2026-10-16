import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import WebSocket from "ws";
import { once } from "node:events";
import { installSandboxCookieRendezvous } from "../server/sandbox-cookie-rendezvous.mjs";

async function fixture(t, options = {}) {
  const app = Fastify({ logger: false });
  let origin,
    valid = true;
  const cookies = installSandboxCookieRendezvous(app, {
    originFor: (request) => "http://" + request.headers.host,
    authorizeOwner: (request) =>
      request.headers["x-test-owner"] === "valid"
        ? { session: "verified-fixture" }
        : null,
    validateOwner: () => valid,
    timeoutMs: 1500,
    ...options,
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const host = new URL(origin).host;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await app.close();
  });
  const post = (url, payload, headers = {}) =>
    app.inject({
      method: "POST",
      url,
      payload,
      headers: { host, origin, ...headers },
    });
  async function owner() {
    const result = await post(
      "/api/browse/cookies/owners",
      {},
      { "x-test-owner": "valid" },
    );
    assert.equal(result.statusCode, 200);
    return result.json();
  }
  async function document(owner, documentId = "bound_document_0123456789") {
    const result = await post(
      "/api/browse/cookies/documents",
      { documentId },
      { authorization: "Bearer " + owner.capability },
    );
    assert.equal(result.statusCode, 200);
    return result.json();
  }
  async function connect(owner, wsOrigin = origin) {
    const ws = new WebSocket(origin.replace("http:", "ws:") + owner.websocket, {
      headers: { origin: wsOrigin },
    });
    sockets.push(ws);
    const ready = once(ws, "message");
    await once(ws, "open");
    assert.deepEqual(JSON.parse((await ready)[0]), { type: "ready" });
    return ws;
  }
  const marker = (doc, sequence, headers = {}) =>
    post(doc.result, JSON.stringify({ sequence }), {
      origin: "null",
      "content-type": "text/plain",
      ...headers,
    });
  return {
    app,
    cookies,
    origin,
    post,
    owner,
    document,
    connect,
    marker,
    revoke() {
      valid = false;
    },
  };
}

test("owner and document minting require trusted origin and explicit owner authentication", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post("/api/browse/cookies/owners", {})).statusCode,
    401,
  );
  assert.equal(
    (
      await f.post(
        "/api/browse/cookies/owners",
        {},
        { "x-test-owner": "valid", origin: "null" },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        "/api/browse/cookies/owners",
        { arbitrary: "payload" },
        { "x-test-owner": "valid" },
      )
    ).statusCode,
    400,
  );
  const owner = await f.owner();
  assert.equal(owner.capability.length, 43);
  assert.equal(
    (
      await f.post("/api/browse/cookies/documents", {
        documentId: "bound_document_0123456789",
      })
    ).statusCode,
    401,
  );
  const doc = await f.document(owner);
  assert.match(doc.result, /^\/browse\/cookies\/result\/[A-Za-z0-9_-]{43}$/);
  assert.equal(f.cookies.documentCount, 1);
  assert.equal(
    (
      await f.post(
        "/api/browse/cookies/documents",
        { documentId: doc.documentId },
        { authorization: "Bearer " + owner.capability },
      )
    ).statusCode,
    409,
  );
});

test("only the precise opaque marker endpoint accepts Origin:null, never frontend cookies or save values", async (t) => {
  const f = await fixture(t),
    owner = await f.owner(),
    doc = await f.document(owner);
  await f.connect(owner);
  for (const headers of [
    { origin: f.origin },
    { cookie: "atlas-admin=secret" },
    { authorization: "Bearer arbitrary" },
  ])
    assert.equal((await f.marker(doc, 1, headers)).statusCode, 403);
  const leaked = await f.post(
    doc.result,
    JSON.stringify({ sequence: 1, value: "never accepted" }),
    { origin: "null", "content-type": "text/plain" },
  );
  assert.equal(leaked.statusCode, 409);
  assert.equal(
    (await f.marker({ result: doc.result.slice(0, -1) + "!" }, 1)).statusCode,
    409,
  );
  assert.equal(
    (
      await f.post(
        "/api/browse/cookies/documents",
        { documentId: "new_document_1234567" },
        { origin: "null", authorization: "Bearer " + owner.capability },
      )
    ).statusCode,
    403,
  );
});

test("cookie result waits for the exact document/sequence ciphertext; plaintext never crosses this API", async (t) => {
  const f = await fixture(t, { timeoutMs: 500 }),
    owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  const waiting = once(ws, "message");
  let completed = false;
  const result = f.marker(doc, 1).then((value) => {
    completed = true;
    return value;
  });
  const [data] = await waiting;
  assert.deepEqual(JSON.parse(data), {
    type: "wait",
    documentId: doc.documentId,
    sequence: 1,
  });
  assert.equal(completed, false);
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: "other_document_123456",
      sequence: 1,
      packet: "99".repeat(64),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, false);
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 1,
      packet: "1".repeat(64),
    }),
  );
  assert.deepEqual((await result).json(), { ok: true, packet: "1".repeat(64) });
  assert.equal(
    (await f.marker(doc, 1)).json().error.code,
    "invalid_cookies_sequence",
  );
});

test("encrypted early result is consumed once and delayed results never acknowledge another operation", async (t) => {
  const f = await fixture(t),
    owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 1,
      packet: "7".repeat(64),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual((await f.marker(doc, 1)).json(), {
    ok: true,
    packet: "7".repeat(64),
  });
  const waiting = once(ws, "message");
  const result = f.marker(doc, 2);
  await waiting;
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 1,
      packet: "8".repeat(64),
    }),
  );
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 2,
      packet: "A".repeat(64),
    }),
  );
  assert.deepEqual((await result).json(), {
    ok: true,
    packet: "A".repeat(64),
  });
});

test("disconnect, deadline and revoked leases return explicit failure, never a fabricated save acknowledgement", async (t) => {
  const f = await fixture(t, { timeoutMs: 60 }),
    owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  const wait = once(ws, "message"),
    result = f.marker(doc, 1);
  await wait;
  ws.close();
  assert.equal((await result).statusCode, 503);
  await f.connect(owner);
  const timeout = await f.marker(doc, 2);
  assert.equal(timeout.statusCode, 504);
  assert.equal(timeout.json().error.code, "cookies_result_timeout");
  f.revoke();
  assert.equal((await f.marker(doc, 3)).statusCode, 409);
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal(f.cookies.documentCount, 0);
});

test("document revocation closes pending markers without deleting browser cookies or unrelated documents", async (t) => {
  const f = await fixture(t, { timeoutMs: 500 }),
    owner = await f.owner(),
    doc = await f.document(owner),
    other = await f.document(owner, "another_document_123456");
  const ws = await f.connect(owner),
    messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  const wait = once(ws, "message"),
    pending = f.marker(doc, 1);
  await wait;
  const removed = await f.app.inject({
    method: "DELETE",
    url: "/api/browse/cookies/documents/" + doc.documentId,
    headers: {
      host: new URL(f.origin).host,
      origin: f.origin,
      authorization: "Bearer " + owner.capability,
    },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal((await pending).statusCode, 409);
  assert.equal(f.cookies.documentCount, 1);
  const result = f.marker(other, 1);
  // WebSocket parsers may emit multiple messages in one stack. Retain all
  // messages instead of attaching a second once() after a queued revoke.
  for (
    let i = 0;
    i < 100 &&
    !messages.some(
      (m) => m.type === "wait" && m.documentId === other.documentId,
    );
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    messages.some(
      (m) => m.type === "wait" && m.documentId === other.documentId,
    ),
  );
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: other.documentId,
      sequence: 1,
      packet: "1".repeat(64),
    }),
  );
  assert.equal((await result).statusCode, 200);
});

test("owner WebSocket rejects foreign origins and malformed value-bearing receipts", async (t) => {
  const f = await fixture(t),
    owner = await f.owner();
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + owner.websocket, {
    headers: { origin: "https://foreign.example" },
  });
  const failed = await new Promise((resolve) => {
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    ws.on("error", () => {});
  });
  assert.equal(failed, 403);
  ws.terminate();
  const active = await f.connect(owner),
    closed = once(active, "close");
  active.send(
    JSON.stringify({
      type: "result",
      documentId: "bound_document_0123456789",
      sequence: 1,
      ok: true,
      value: "not-a-marker",
    }),
  );
  assert.equal((await closed)[0], 1008);
});

test("abandoned registrations and disconnected owners expire without retaining document capabilities", async (t) => {
  const f = await fixture(t, { disconnectedGraceMs: 30 });
  const abandoned = await f.owner();
  await f.document(abandoned);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal(f.cookies.documentCount, 0);
  const owner = await f.owner();
  const doc = await f.document(owner);
  const ws = await f.connect(owner),
    closed = once(ws, "close");
  ws.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal((await f.marker(doc, 1)).statusCode, 409);
});

test("owner revocation remains terminal across asynchronous document authorization", async (t) => {
  let hold = false,
    entered,
    release;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    validateOwner: async () => {
      if (hold) {
        entered();
        await gate;
      }
      return true;
    },
  });
  const owner = await f.owner();
  hold = true;
  const pending = f.post(
    "/api/browse/cookies/documents",
    { documentId: "revocation_document_0123456" },
    { authorization: "Bearer " + owner.capability },
  );
  await arrived;
  f.cookies.revokeOwner(owner.capability);
  release();
  const response = await pending;
  assert.equal(response.statusCode, 401);
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal(
    f.cookies.documentCount,
    0,
    "late validator never mints an orphan document",
  );
});

test("document revocation is rechecked after asynchronous marker lease validation", async (t) => {
  let hold = false,
    entered,
    release;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    validateOwner: async () => {
      if (hold) {
        entered();
        await gate;
      }
      return true;
    },
  });
  const owner = await f.owner(),
    doc = await f.document(owner);
  await f.connect(owner);
  hold = true;
  const pending = f.marker(doc, 1);
  await arrived;
  f.cookies.revokeOwner(owner.capability);
  release();
  assert.equal((await pending).statusCode, 409);
  assert.equal(f.cookies.documentCount, 0);
});

test("expired live leases are revoked by heartbeats instead of being kept alive by pings", async (t) => {
  let authorized = true,
    calls = 0;
  const f = await fixture(t, {
    idleMs: 80,
    validateOwner: () => {
      calls++;
      return authorized;
    },
  });
  const owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  authorized = false;
  const before = calls,
    closed = once(ws, "close");
  for (let i = 0; i < 100; i++) ws.send(JSON.stringify({ type: "ping" }));
  assert.equal((await closed)[0], 1008);
  assert.ok(calls > before, "heartbeat rechecks the current lease");
  assert.equal(messages.filter((value) => value.type === "pong").length, 0);
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal(f.cookies.documentCount, 0);
  assert.equal((await f.marker(doc, 1)).statusCode, 409);
});

test(
  "the sweep validates connected lease authority even without heartbeat or HTTP traffic",
  { timeout: 5000 },
  async (t) => {
    let authorized = true,
      calls = 0,
      entered;
    const checked = new Promise((resolve) => {
      entered = resolve;
    });
    // Advance only the interval scheduler. Real Date.now/WS I/O stay live, so
    // this authority-sweep test cannot accidentally become an idle-age cleanup
    // when a parallel test delays the first real 80ms timer beyond its idle TTL.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = await fixture(t, {
      idleMs: 60_000,
      validateOwner: () => {
        calls++;
        if (!authorized) entered();
        return authorized;
      },
    });
    const owner = await f.owner();
    await f.document(owner);
    const ws = await f.connect(owner),
      before = calls,
      closed = once(ws, "close");
    authorized = false;
    t.mock.timers.tick(30_000);
    await checked;
    assert.equal((await closed)[0], 1008);
    assert.ok(
      calls > before,
      "sweep asks the coordinator before an idle-age-only cleanup",
    );
    assert.equal(f.cookies.ownerCount, 0);
    assert.equal(f.cookies.documentCount, 0);
  },
);

test("concurrent HTTP and heartbeat validation is bounded, times out explicitly, and never revives on late success", async (t) => {
  let hold = false,
    calls = 0,
    release,
    entered,
    signal;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    validationTimeoutMs: 45,
    validateOwner: (_identity, options) => {
      if (!hold) return true;
      calls++;
      signal = options.signal;
      entered();
      return gate;
    },
  });
  const owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  hold = true;
  const result = f.marker(doc, 1);
  await arrived;
  for (let i = 0; i < 250; i++) ws.send(JSON.stringify({ type: "ping" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1, "all in-flight checks share one coordinator lookup");
  const response = await result;
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    ok: false,
    error: { name: "TimeoutError", code: "cookies_owner_validation_timeout" },
  });
  assert.equal(signal.aborted, true);
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal(f.cookies.documentCount, 0);
  release(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    f.cookies.ownerCount,
    0,
    "late coordinator success has no authority",
  );
  assert.equal((await f.marker(doc, 1)).statusCode, 409);
});

test("heartbeat validation timeout fails an already waiting result without a fabricated commit receipt", async (t) => {
  let hold = false;
  const f = await fixture(t, {
    timeoutMs: 500,
    validationTimeoutMs: 30,
    validateOwner: () => (hold ? new Promise(() => {}) : true),
  });
  const owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  const waiting = once(ws, "message"),
    pending = f.marker(doc, 1);
  assert.equal(JSON.parse((await waiting)[0]).type, "wait");
  hold = true;
  ws.send(JSON.stringify({ type: "ping" }));
  const response = await pending;
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: 503,
    ok: false,
    error: { name: "TimeoutError", code: "cookies_owner_validation_timeout" },
  });
  assert.equal(f.cookies.ownerCount, 0);
  assert.equal(f.cookies.documentCount, 0);
});

test("coordinator rejection is a typed failure and asynchronous heartbeat success cannot cross revocation", async (t) => {
  let mode = "valid",
    release,
    entered;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    validateOwner: () => {
      if (mode === "failed")
        return Promise.reject(Error("private coordinator failure"));
      if (mode === "hold") {
        entered();
        return gate;
      }
      return true;
    },
  });
  const first = await f.owner(),
    doc = await f.document(first);
  await f.connect(first);
  mode = "failed";
  const response = await f.marker(doc, 1);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    ok: false,
    error: { name: "NetworkError", code: "cookies_owner_validation_failed" },
  });
  mode = "valid";
  const owner = await f.owner(),
    ws = await f.connect(owner),
    messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  mode = "hold";
  ws.send(JSON.stringify({ type: "ping" }));
  await arrived;
  f.cookies.revokeOwner(owner.capability);
  release(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    messages.some((value) => value.type === "pong"),
    false,
  );
  assert.equal(f.cookies.ownerCount, 0);
});

test("invalid coordinator validation deadlines are rejected at registration", async () => {
  for (const validationTimeoutMs of [0, -1, Infinity, NaN, 30001]) {
    const app = Fastify({ logger: false });
    assert.throws(
      () =>
        installSandboxCookieRendezvous(app, {
          originFor: () => "http://fixture",
          authorizeOwner: () => ({}),
          validateOwner: () => true,
          validationTimeoutMs,
        }),
      TypeError,
    );
    await app.close();
  }
});
