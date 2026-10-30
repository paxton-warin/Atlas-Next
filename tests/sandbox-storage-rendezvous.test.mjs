import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import WebSocket from "ws";
import { once } from "node:events";
import { installSandboxStorageRendezvous } from "../server/sandbox-storage-rendezvous.mjs";

async function fixture(t, options = {}) {
  const app = Fastify({ logger: false });
  let origin,
    valid = true;
  const storage = installSandboxStorageRendezvous(app, {
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
  async function owner(body = {}) {
    const result = await post(
      "/api/browse/storage/owners",
      {},
      { "x-test-owner": "valid", ...(body.localReceipts ? { "x-atlas-local-receipts": "1" } : {}) },
    );
    assert.equal(result.statusCode, 200);
    return result.json();
  }
  async function document(owner, documentId = "bound_document_0123456789") {
    const result = await post(
      "/api/browse/storage/documents",
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
    post(doc.commit, JSON.stringify({ sequence }), {
      origin: "null",
      "content-type": "text/plain",
      ...headers,
    });
  return {
    app,
    storage,
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
    (await f.post("/api/browse/storage/owners", {})).statusCode,
    401,
  );
  assert.equal(
    (
      await f.post(
        "/api/browse/storage/owners",
        {},
        { "x-test-owner": "valid", origin: "null" },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        "/api/browse/storage/owners",
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
      await f.post("/api/browse/storage/documents", {
        documentId: "bound_document_0123456789",
      })
    ).statusCode,
    401,
  );
  const doc = await f.document(owner);
  assert.match(doc.commit, /^\/browse\/storage\/commit\/[A-Za-z0-9_-]{43}$/);
  assert.equal(f.storage.documentCount, 1);
  assert.equal(
    (
      await f.post(
        "/api/browse/storage/documents",
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
    doc.commit,
    JSON.stringify({ sequence: 1, value: "never accepted" }),
    { origin: "null", "content-type": "text/plain" },
  );
  assert.equal(leaked.statusCode, 409);
  assert.equal(
    (await f.marker({ commit: doc.commit.slice(0, -1) + "!" }, 1)).statusCode,
    409,
  );
  assert.equal(
    (
      await f.post(
        "/api/browse/storage/documents",
        { documentId: "new_document_1234567" },
        { origin: "null", authorization: "Bearer " + owner.capability },
      )
    ).statusCode,
    403,
  );
});

test("marker success waits for exact native-commit receipt; save bodies never cross the server", async (t) => {
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
      ok: true,
      revision: 99,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, false);
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 1,
      ok: true,
      revision: 1,
    }),
  );
  assert.deepEqual((await result).json(), { ok: true, revision: 1 });
  assert.equal(
    (await f.marker(doc, 1)).json().error.code,
    "invalid_storage_sequence",
  );
});

test("early commit receipt is consumed once, quota errors propagate, and delayed receipts never acknowledge another operation", async (t) => {
  const f = await fixture(t),
    owner = await f.owner(),
    doc = await f.document(owner),
    ws = await f.connect(owner);
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 1,
      ok: true,
      revision: 7,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual((await f.marker(doc, 1)).json(), { ok: true, revision: 7 });
  const waiting = once(ws, "message");
  const result = f.marker(doc, 2);
  await waiting;
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 1,
      ok: true,
      revision: 8,
    }),
  );
  ws.send(
    JSON.stringify({
      type: "result",
      documentId: doc.documentId,
      sequence: 2,
      ok: false,
      error: { name: "QuotaExceededError", code: "website_quota" },
    }),
  );
  assert.deepEqual((await result).json(), {
    ok: false,
    error: { name: "QuotaExceededError", code: "website_quota" },
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
  assert.equal(timeout.json().error.code, "storage_commit_timeout");
  f.revoke();
  assert.equal((await f.marker(doc, 3)).statusCode, 409);
  assert.equal(f.storage.ownerCount, 0);
  assert.equal(f.storage.documentCount, 0);
});

test("document revocation closes pending markers without deleting browser storage or unrelated documents", async (t) => {
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
    url: "/api/browse/storage/documents/" + doc.documentId,
    headers: {
      host: new URL(f.origin).host,
      origin: f.origin,
      authorization: "Bearer " + owner.capability,
    },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal((await pending).statusCode, 409);
  assert.equal(f.storage.documentCount, 1);
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
      ok: true,
      revision: 1,
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
  assert.equal(f.storage.ownerCount, 0);
  assert.equal(f.storage.documentCount, 0);
  const owner = await f.owner();
  const doc = await f.document(owner);
  const ws = await f.connect(owner),
    closed = once(ws, "close");
  ws.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.storage.ownerCount, 0);
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
    "/api/browse/storage/documents",
    { documentId: "revocation_document_0123456" },
    { authorization: "Bearer " + owner.capability },
  );
  await arrived;
  f.storage.revokeOwner(owner.capability);
  release();
  const response = await pending;
  assert.equal(response.statusCode, 401);
  assert.equal(f.storage.ownerCount, 0);
  assert.equal(
    f.storage.documentCount,
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
  f.storage.revokeOwner(owner.capability);
  release();
  assert.equal((await pending).statusCode, 409);
  assert.equal(f.storage.documentCount, 0);
});

test("HTTP fallback receives a recent native receipt after more than64 browser-local acknowledgements", async (t) => {
  const f = await fixture(t), owner = await f.owner({ localReceipts: true }), doc = await f.document(owner), ws = await f.connect(owner);
  for (let sequence = 1; sequence <= 130; sequence++) ws.send(JSON.stringify({ type: "result", documentId: doc.documentId, sequence, ok: true, revision: sequence }));
  const pong = once(ws, "message"); ws.send(JSON.stringify({ type: "ping" }));
  assert.equal(JSON.parse((await pong)[0]).type, "pong");
  const result = await f.marker(doc, 130);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { ok: true, revision: 130 });
});

test("local-ack receipt retention remains bounded and cannot acknowledge an evicted old operation", async (t) => {
  const f = await fixture(t, { timeoutMs: 25 }), owner = await f.owner({ localReceipts: true }), doc = await f.document(owner), ws = await f.connect(owner);
  for (let sequence = 1; sequence <= 130; sequence++) ws.send(JSON.stringify({ type: "result", documentId: doc.documentId, sequence, ok: true, revision: sequence }));
  const pong = once(ws, "message"); ws.send(JSON.stringify({ type: "ping" })); await pong;
  const stale = await f.marker(doc, 1);
  assert.equal(stale.statusCode, 504);
  assert.equal(stale.json().ok, false);
  const recent = await f.marker(doc, 130);
  assert.equal(recent.statusCode, 200);
  assert.deepEqual(recent.json(), { ok: true, revision: 130 });
});

for (const type of ["ping", "result"]) test(`revoked assignment closes owner channel on ${type} without waiting for another HTTP marker`, async (t) => {
  const f = await fixture(t), owner = await f.owner(), doc = await f.document(owner), ws = await f.connect(owner);
  f.revoke();
  const closed = once(ws, "close");
  ws.send(JSON.stringify(type === "ping" ? { type } : { type, documentId: doc.documentId, sequence: 1, ok: true, revision: 1 }));
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(f.storage.documentCount, 0);
});


test("legacy owners retain contiguous marker order and local opt-in does not fabricate receipts", async (t) => {
  const f = await fixture(t, { timeoutMs: 20 });
  for (const localReceipts of [false, true]) {
    const owner = await f.owner({ localReceipts }), doc = await f.document(owner), ws = await f.connect(owner);
    const missing = await f.marker(doc, 100);
    assert.equal(missing.statusCode, localReceipts ? 504 : 409);
    assert.equal(missing.json().ok, false);
  }
});
