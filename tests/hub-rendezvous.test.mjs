import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import WebSocket from "ws";
import { openStore } from "../server/store.mjs";
import { installHubBranch } from "../server/hub-branch.mjs";
import { installSandboxStorageRendezvous } from "../server/sandbox-storage-rendezvous.mjs";
import { installSandboxCookieRendezvous } from "../server/sandbox-cookie-rendezvous.mjs";
for (const kind of ["storage", "cookies"])
  test(`Hub opaque ${kind} marker bypasses cookie gate only for exact capability; actual owner receipt remains required`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-hub-marker-")),
      store = openStore(dir),
      app = Fastify(),
      origin = "https://frontend.example";
    const grant = {
      protocol: 1,
      userId: randomUUID(),
      profileId: randomUUID(),
      sessionId: randomUUID(),
      branchId: randomUUID(),
      contextId: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    };
    await installHubBranch(app, {
      config: {
        appOrigin: origin,
        hubOrigin: "https://hub.example",
        hubBranchId: grant.branchId,
        hubBranchSecret: "s".repeat(43),
        opaqueRuntimeActivated: true,
      },
      originFor: () => origin,
      store,
      seal: store.seal,
      unseal: store.unseal,
      fetch: async () => new Response(JSON.stringify({ grant })),
    });
    const install =
      kind === "storage"
        ? installSandboxStorageRendezvous
        : installSandboxCookieRendezvous;
    install(app, {
      originFor: () => origin,
      authorizeOwner: (req) =>
        req.headers["x-fixture-owner"] === "valid"
          ? { session: "verified" }
          : null,
      validateOwner: () => true,
      timeoutMs: 1000,
    });
    const server = await app.listen({ host: "127.0.0.1", port: 0 });
    let ws;
    t.after(async () => {
      ws?.terminate();
      await app.close();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const auth =
        "__Host-atlas-hub=" +
        store.seal(
          JSON.stringify({
            token: "t".repeat(43),
            grant,
            origin,
            generation: 1,
            csrf: "c".repeat(43),
          }),
        ),
      headers = { origin, cookie: auth, "x-fixture-owner": "valid" };
    const ownerPath = `/api/browse/${kind}/owners`,
      documentPath = `/api/browse/${kind}/documents`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: ownerPath,
          headers: { origin: "null" },
          payload: {},
        })
      ).statusCode,
      401,
    );
    const owner = (
      await app.inject({ method: "POST", url: ownerPath, headers, payload: {} })
    ).json();
    assert.ok(owner.capability);
    const document = await app.inject({
      method: "POST",
      url: documentPath,
      headers: { ...headers, authorization: "Bearer " + owner.capability },
      payload: { documentId: "gated_document_0123456789" },
    });
    assert.equal(document.statusCode, 200, document.body);
    const doc = document.json(),
      url = kind === "storage" ? doc.commit : doc.result;
    ws = new WebSocket(server.replace("http:", "ws:") + owner.websocket, {
      origin,
    });
    const ready = once(ws, "message");
    await once(ws, "open");
    await ready;
    const marker = (path, sequence, extraHeaders = {}) =>
      app.inject({
        method: "POST",
        url: path,
        headers: {
          origin: "null",
          "content-type": "text/plain",
          ...extraHeaders,
        },
        payload: JSON.stringify({ sequence }),
      });
    const pending = once(ws, "message");
    let finished = false;
    const response = marker(url, 1).then((value) => {
      finished = true;
      return value;
    });
    const message = JSON.parse((await pending)[0]);
    assert.equal(message.type, "wait");
    assert.equal(
      finished,
      false,
      "native-write result must not be acknowledged before its exact document receipt",
    );
    ws.send(
      JSON.stringify({
        type: "result",
        documentId: doc.documentId,
        sequence: 1,
        ...(kind === "storage"
          ? { ok: true, revision: 1 }
          : { packet: "1".repeat(64) }),
      }),
    );
    const committed = await response;
    assert.equal(committed.statusCode, 200, committed.body);
    assert.equal(committed.json().ok, true);
    assert.equal(committed.headers["access-control-allow-origin"], "*");
    assert.equal(
      (await marker(url, 1)).statusCode,
      409,
      "receipt sequence cannot replay",
    );
    const nativeHeaders = {
      cookie: "__Host-atlas-native-" + "n".repeat(16) + "=ignored",
    };
    const nativePending = once(ws, "message");
    const nativeResponse = marker(url, 2, nativeHeaders);
    const nativeMessage = JSON.parse(
      (
        await Promise.race([
          nativePending,
          nativeResponse.then((value) => {
            throw Error(
              "Native-cookie marker rejected before receipt: " +
                value.statusCode,
            );
          }),
        ])
      )[0],
    );
    assert.equal(nativeMessage.type, "wait");
    ws.send(
      JSON.stringify({
        type: "result",
        documentId: doc.documentId,
        sequence: 2,
        ...(kind === "storage"
          ? { ok: true, revision: 2 }
          : { packet: "2".repeat(64) }),
      }),
    );
    const nativeCommitted = await nativeResponse;
    assert.equal(nativeCommitted.statusCode, 200, nativeCommitted.body);
    assert.equal(nativeCommitted.json().ok, true);
    assert.equal(nativeCommitted.headers["access-control-allow-origin"], "*");
    assert.equal(
      (
        await marker(
          url.slice(0, url.lastIndexOf("/") + 1) + "z".repeat(43),
          3,
          nativeHeaders,
        )
      ).statusCode,
      409,
    );
    for (const cookie of [
      "__Host-atlas-hub=forged",
      nativeHeaders.cookie + "; unrelated=1",
    ])
      assert.equal((await marker(url, 3, { cookie })).statusCode, 401);
    assert.equal(
      (
        await marker(url, 3, {
          ...nativeHeaders,
          authorization: "Bearer forged",
        })
      ).statusCode,
      401,
    );

    assert.equal(
      (await marker(url.slice(0, url.lastIndexOf("/") + 1) + "x".repeat(43), 1))
        .statusCode,
      409,
      "random document capability is denied by actual rendezvous authority",
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/hub/profile",
          headers: { origin: "null" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: documentPath,
          headers: { origin: "null", ...nativeHeaders },
          payload: { documentId: "no_cookie_document_123" },
        })
      ).statusCode,
      401,
    );
  });
