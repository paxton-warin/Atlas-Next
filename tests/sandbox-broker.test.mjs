import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MessageChannel } from "node:worker_threads";
import { bindSandboxDocument } from "../runtime/sandbox-broker.ts";
import { logicalStorageOrigin } from "../runtime/sandbox-vault.ts";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";

test("sandbox frame route keeps URL while applying immutable opaque-origin policy", async () => {
  const app = Fastify();
  installSandboxFramePrototype(app);
  try {
    const response = await app.inject("/browse/frame/fixture_document_123");
    assert.equal(response.statusCode, 200);
    assert.match(
      response.headers["content-security-policy"],
      /^sandbox allow-scripts;/,
    );
    assert.doesNotMatch(
      response.headers["content-security-policy"],
      /allow-same-origin/,
    );
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal((await app.inject("/browse/frame/bad")).statusCode, 404);
  } finally {
    await app.close();
  }
});
test("logical storage namespaces distinguish scheme/port and reject credentials", () => {
  assert.equal(
    logicalStorageOrigin("https://site.example/game"),
    "https://site.example",
  );
  assert.notEqual(
    logicalStorageOrigin("http://site.example"),
    logicalStorageOrigin("https://site.example"),
  );
  assert.notEqual(
    logicalStorageOrigin("https://site.example:444"),
    logicalStorageOrigin("https://site.example"),
  );
  assert.throws(() => logicalStorageOrigin("https://name:secret@site.example"));
  assert.throws(() => logicalStorageOrigin("file:///tmp/x"));
});
test("document capabilities fix site identity, serialize writes, acknowledge commit, and reject injected origins", async () => {
  const channels = new MessageChannel();
  const calls = [];
  let finish;
  const committed = new Promise((resolve) => (finish = resolve));
  const broker = bindSandboxDocument({
    documentId: "own-doc",
    website: "https://game.example/",
    frontendOrigin: "https://atlas.example",
    port: channels.port1,
    vault: {
      async snapshot(origin) {
        calls.push(["snapshot", origin]);
        return { revision: 0, entries: [] };
      },
      async write(origin, change) {
        calls.push(["write", origin, change]);
        await committed;
        return { revision: 1, entries: [[change.key, change.value]] };
      },
    },
  });
  const replies = [];
  channels.port2.on("message", (value) => replies.push(value));
  const send = (value) =>
    channels.port2.postMessage({
      protocol: 2,
      documentId: "own-doc",
      ...value,
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    send({
      sequence: 1,
      type: "mutate",
      origin: "https://peer.example",
      change: { op: "set", key: "save", value: "bad" },
    });
    await tick();
    assert.equal(calls.length, 0);
    assert.equal(replies[0].code, "invalid_capability_message");
    send({
      sequence: 1,
      type: "mutate",
      change: { op: "set", key: "save", value: "kept" },
    });
    await tick();
    assert.equal(replies.length, 1, "no success before vault commit");
    send({ sequence: 2, type: "flush" });
    await tick();
    assert.equal(replies.length, 1);
    finish();
    await broker.flush();
    await tick();
    assert.deepEqual(calls, [
      [
        "write",
        "https://game.example",
        { op: "set", key: "save", value: "kept" },
      ],
    ]);
    assert.deepEqual(
      replies.slice(1).map((r) => [r.type, r.sequence]),
      [
        ["ack", 1],
        ["ack", 2],
      ],
    );
    broker.dispose();
    send({ sequence: 3, type: "snapshot" });
    await tick();
    assert.equal(calls.length, 1);
  } finally {
    finish();
    broker.dispose();
    channels.port2.close();
  }
});
test("sandbox broker never binds frontend resources as website storage", () => {
  const { port1, port2 } = new MessageChannel();
  try {
    assert.throws(
      () =>
        bindSandboxDocument({
          documentId: "x",
          website: "https://atlas.example/api/admin/state",
          frontendOrigin: "https://atlas.example",
          port: port1,
          vault: {},
        }),
      /Frontend/,
    );
  } finally {
    port1.close();
    port2.close();
  }
});

test("storage capability bounds queued work and rejects malformed changes before calling native storage", async () => {
  const { port1, port2 } = new MessageChannel();
  let finish,
    writes = 0;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const binding = bindSandboxDocument({
    documentId: "bounded-document",
    website: "https://website.example",
    frontendOrigin: "https://atlas.example",
    port: port1,
    vault: {
      async snapshot() {
        return { revision: 0, entries: [] };
      },
      async write() {
        writes++;
        await gate;
        return { revision: 1, entries: [] };
      },
    },
  });
  const replies = [];
  port2.on("message", (message) => replies.push(message));
  const send = (sequence, change) =>
    port2.postMessage({
      protocol: 2,
      documentId: "bounded-document",
      type: "mutate",
      sequence,
      change,
    });
  try {
    send(1, { op: "set", key: 5, value: "invalid" });
    send(2, { op: "clear", key: "not-allowed" });
    send(3, { op: "set", key: "large", value: "x".repeat(6 * 1024 * 1024) });
    for (let n = 4; n < 133; n++)
      send(n, { op: "set", key: String(n), value: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(replies[0].code, "invalid_storage_operation");
    assert.equal(replies[1].code, "invalid_storage_operation");
    assert.equal(replies[2].code, "storage_backpressure");
    assert.equal(replies[3].code, "storage_backpressure");
    assert.equal(binding.pending, 128);
    assert.equal(writes, 1);
    binding.dispose();
    finish();
    await binding.flush();
    assert.equal(
      writes,
      1,
      "disposed queued operations never start a native transaction",
    );
    assert.equal(binding.pending, 0);
  } finally {
    finish();
    binding.dispose();
    port2.close();
  }
});
