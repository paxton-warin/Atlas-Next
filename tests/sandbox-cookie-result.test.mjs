import test from "node:test";
import assert from "node:assert/strict";
import {
  newCookieResultKey,
  sealCookieResult,
  openCookieResult,
} from "../runtime/sandbox-cookie-result.ts";
const result = {
  documentId: "cookie_document_1234567",
  sequence: 1,
  operation: "get",
  view: "visible=fixture-only",
  viewVersion: 1,
  expiresAt: null,
};
test("synchronous cookie result encrypts/authenticates only the fixed document/sequence/operation view", () => {
  const key = newCookieResultKey(),
    packet = sealCookieResult(key, result);
  assert.deepEqual(openCookieResult(key, packet, result), result);
  assert.ok(!Buffer.from(packet, "base64").includes(Buffer.from(result.view)));
  assert.notEqual(packet, sealCookieResult(key, result));
  for (const expected of [
    { ...result, documentId: "different_document_1234" },
    { ...result, sequence: 2 },
    { ...result, operation: "set" },
  ])
    assert.throws(() => openCookieResult(key, packet, expected), {
      name: "SecurityError",
    });
  assert.throws(() => openCookieResult(newCookieResultKey(), packet, result), {
    name: "SecurityError",
  });
  const damaged = Buffer.from(packet, "base64");
  damaged[damaged.length - 1] ^= 1;
  assert.throws(
    () => openCookieResult(key, damaged.toString("base64"), result),
    { name: "SecurityError" },
  );
});
test("cookie result bounds reject oversized views and malformed authenticated schema", () => {
  const key = newCookieResultKey();
  assert.throws(
    () =>
      sealCookieResult(key, {
        ...result,
        view: "x".repeat(4 * 1024 * 1024 + 2048),
      }),
    { name: "QuotaExceededError" },
  );
  for (const patch of [
    { viewVersion: -1 },
    { error: "HttpOnly" },
    { unexpected: "field" },
  ])
    assert.throws(
      () =>
        openCookieResult(
          key,
          sealCookieResult(key, { ...result, ...patch }),
          result,
        ),
      { name: "SecurityError" },
    );
  assert.throws(() => openCookieResult(key, "not a packet", result), {
    name: "SecurityError",
  });
});

test("stalled OPEN cookie socket cannot grow an unbounded result queue", async () => {
  const { sendBoundedCookieResult } = await import(
    "../runtime/sandbox-cookie-worker.ts"
  );
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(value) {
      this.bufferedAmount += value.length;
    },
  };
  const packet = "A".repeat(4 * 1024 * 1024);
  sendBoundedCookieResult(socket, {
    documentId: result.documentId,
    sequence: 1,
    packet,
  });
  sendBoundedCookieResult(socket, {
    documentId: result.documentId,
    sequence: 2,
    packet,
  });
  assert.throws(
    () =>
      sendBoundedCookieResult(socket, {
        documentId: result.documentId,
        sequence: 3,
        packet,
      }),
    { name: "QuotaExceededError" },
  );
  assert.ok(socket.bufferedAmount < 12 * 1024 * 1024);
  socket.readyState = 3;
  assert.throws(
    () =>
      sendBoundedCookieResult(socket, {
        documentId: result.documentId,
        sequence: 4,
        packet,
      }),
    { name: "QuotaExceededError" },
  );
});

test("cookie SPA URL changes cannot change the immutable logical website origin", async () => {
  const { cookieDocumentURL } = await import(
    "../runtime/sandbox-cookie-worker.ts"
  );
  assert.equal(
    cookieDocumentURL(
      "https://site.example/new/path#state",
      "https://site.example/initial",
    ),
    "https://site.example/new/path",
  );
  for (const url of [
    "https://peer.example/",
    "http://site.example/",
    "https://user:secret@site.example/",
    "data:text/html,no",
    "https://site.example.evil/",
  ])
    assert.throws(
      () => cookieDocumentURL(url, "https://site.example/initial"),
      { name: "SecurityError" },
    );
});
