import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../server/store.mjs";
import { installHubBranch } from "../server/hub-branch.mjs";
import { installFrontendDocumentReservations } from "../server/frontend-documents.mjs";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
const origin = "https://front.example",
  resourceOrigin = "https://selected.example",
  session = "s".repeat(43),
  hash = "a".repeat(64),
  parent = "doc_" + "a".repeat(32),
  child = "doc_" + "b".repeat(32),
  popup = "doc_" + "c".repeat(32),
  nonce = "d".repeat(64);
async function fixture(t) {
  const app = Fastify(),
    dir = mkdtempSync(join(tmpdir(), "atlas-hub-doc-")),
    store = openStore(dir);
  let live = true,
    fresh = true,
    disabled = false,
    documents;
  const owner = { hash, origin, generation: 1 },
    grant = {
      protocol: 1,
      userId: randomUUID(),
      profileId: randomUUID(),
      branchId: randomUUID(),
      sessionId: randomUUID(),
      contextId: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  const pool = {
    setRequireHubOwnership() {},
    refreshHubIdentity() {},
    assertHubLease() {},
    validHubLease: (h) => fresh && h === hash,
    frontendAssignments: {
      identity: (raw, o, g) =>
        live && raw === session && o === origin && g === 1 ? owner : null,
      validate: (o) =>
        live && o.hash === hash && o.origin === origin && o.generation === 1,
    },
    list: () => [
      {
        id: "remote",
        endpoint: resourceOrigin,
        state: disabled ? "disabled" : "active",
      },
    ],
    resourceOwner: async () => ({
      nodeId: "remote",
      frontendOrigin: origin,
      resourceOrigin,
      leaseHash: hash,
      generation: 1,
      role: "frontend-resource-owner-v1",
      purpose: "native-resource-owner",
      expiresAt: Date.now() + 100000,
    }),
  };
  await installHubBranch(app, {
    config: {
      appOrigin: origin,
      hubOrigin: "https://hub.example",
      hubBranchId: grant.branchId,
      hubBranchSecret: "s".repeat(43),
      opaqueRuntimeActivated: true,
    },
    originFor: (req) => "https://" + req.headers.host,
    store,
    seal: store.seal,
    unseal: store.unseal,
    pool,
    authorizeReservedDocument: (req, id, kind) =>
      documents?.documentNavigation(req, id, kind) === true,
    fetch: async () => new Response(JSON.stringify({ grant })),
  });
  documents = installFrontendDocumentReservations(app, {
    pool,
    originFor: (req) => "https://" + req.headers.host,
    limitBrowse() {},
    ttlMs: 1000,
  });
  installSandboxFramePrototype(app, {
    capabilities: true,
    nativeResourceOrigin: documents.resourceOrigin,
    nestedFramePolicy: documents.nestedPolicy,
  });
  const cookie =
    "__Host-atlas-hub=" +
    store.seal(
      JSON.stringify({
        token: "t".repeat(43),
        grant,
        origin,
        generation: 1,
        csrf: "c".repeat(43),
      }),
    );
  const headers = { host: "front.example", origin, cookie };
  // Protected sentinel handlers prove a successful response is impossible for
  // arbitrary APIs/resource mutations, rather than just testing missing routes.
  app.post("/api/browse/controller/runtime", () => ({ exposed: true }));
  app.get("/browse/renderer/v1/:id/helper", () => ({ exposed: true }));
  app.post("/browse/frame/:id", () => ({ exposed: true }));
  app.post("/browse/resource/:id", () => ({ exposed: true }));
  await app.ready();
  t.after(async () => {
    await app.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    documents,
    revoke: () => (live = false),
    staleHub: () => (fresh = false),
    disable: () => (disabled = true),
    reserve: (id, extra = {}) =>
      app.inject({
        method: "POST",
        url: "/api/browse/controller/document",
        headers,
        payload: { session, generation: 1, documentId: id, ...extra },
      }),
    request: (url = "/browse/frame/" + child, method = "GET", extra = {}) =>
      app.inject({ method, url, headers: { host: "front.example", ...extra } }),
    remove: (id) =>
      app.inject({
        method: "DELETE",
        url: "/api/browse/controller/document",
        headers,
        payload: { session, generation: 1, documentId: id },
      }),
  };
}
async function reserveNested(f) {
  assert.equal(
    (await f.reserve(parent, { bootstrapNonce: nonce })).statusCode,
    200,
  );
  assert.equal(
    (
      await f.reserve(child, {
        parentDocumentId: parent,
        bootstrapNonce: nonce,
      })
    ).statusCode,
    200,
  );
}
test("opaque nested GET/HEAD uses only a live exact physical reservation; nonce bootstrap remains sandboxed", async (t) => {
  const f = await fixture(t);
  await reserveNested(f);
  const response = await f.request();
  assert.equal(response.statusCode, 200);
  assert.match(
    response.headers["content-security-policy"],
    /^sandbox allow-scripts/,
  );
  assert.doesNotMatch(
    response.headers["content-security-policy"],
    /allow-same-origin/,
  );
  assert.match(response.body, new RegExp(nonce));
  assert.equal(
    (await f.request("/browse/frame/" + child, "HEAD")).statusCode,
    200,
  );
  assert.equal((await f.request("/browse/frame/" + parent)).statusCode, 401);
  assert.equal(
    (await f.request("/browse/frame/" + child, "GET", { origin: "null" }))
      .statusCode,
    200,
  );
});
test("random, foreign-host, query-altered and wrong-kind physical documents never bypass Hub auth", async (t) => {
  const f = await fixture(t);
  await reserveNested(f);
  for (const url of [
    "/browse/frame/doc_" + "f".repeat(32),
    "/browse/frame/" + child + "?forged=1",
    "/browse/popup/" + child,
  ])
    assert.notEqual((await f.request(url)).statusCode, 200);
  assert.notEqual(
    (
      await f.request("/browse/frame/" + child, "GET", {
        host: "foreign.example",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.request("/browse/frame/" + child, "GET", {
        origin: "https://foreign.example",
      })
    ).statusCode,
    401,
  );
});
test("expired reservations, revoked assignment and stale/revoked Hub proof deny the cookieless document", async (t) => {
  for (const revoke of ["revoke", "staleHub", "disable"]) {
    const f = await fixture(t);
    await reserveNested(f);
    f[revoke]();
    assert.equal((await f.request()).statusCode, 401);
  }
  const f = await fixture(t);
  await reserveNested(f);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2000 });
  assert.equal((await f.request()).statusCode, 401);
});
test("removing a parent reservation invalidates a surviving nested physical URL", async (t) => {
  const f = await fixture(t);
  await reserveNested(f);
  assert.equal((await f.remove(parent)).statusCode, 200);
  assert.equal((await f.request()).statusCode, 401);
});
test("popup physical bootstrap requires its exact reserved kind and does not authorize APIs or resource mutations", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.reserve(popup, { kind: "popup", bootstrapNonce: nonce }))
      .statusCode,
    200,
  );
  assert.equal((await f.request("/browse/popup/" + popup)).statusCode, 200);
  assert.equal((await f.request("/browse/frame/" + popup)).statusCode, 401);
  for (const [url, method] of [
    ["/browse/frame/" + popup, "POST"],
    ["/api/browse/controller/document", "POST"],
    ["/api/browse/controller/runtime", "POST"],
    ["/browse/renderer/v1/" + popup + "/helper", "GET"],
    ["/browse/resource/" + popup, "POST"],
  ])
    assert.equal(
      (await f.request(url, method, { origin: "null" })).statusCode,
      401,
    );
});

test("Main native-resource enrollment cookies do not block a separately authorized physical bootstrap or authorize anything else", async (t) => {
  const f = await fixture(t);
  await reserveNested(f);
  assert.equal(
    (await f.reserve(popup, { kind: "popup", bootstrapNonce: nonce }))
      .statusCode,
    200,
  );
  const headers = {
    origin: "null",
    cookie:
      "__Host-atlas-native-" +
      "A".repeat(16) +
      "=opaque; __Host-atlas-native-" +
      "b".repeat(16) +
      "=untrusted",
  };
  // Values are deliberately not enrollment credentials. This cookie family is
  // ignored for the physical shell; only the independent live reservation grants it.
  for (const route of ["/browse/frame/" + child, "/browse/popup/" + popup])
    for (const method of ["GET", "HEAD"])
      assert.equal((await f.request(route, method, headers)).statusCode, 200);
  for (const [route, method] of [
    ["/browse/frame/doc_" + "f".repeat(32), "GET"],
    ["/browse/frame/" + parent, "GET"],
    ["/browse/frame/" + child, "POST"],
    ["/api/browse/controller/runtime", "POST"],
    ["/api/browse/controller/document", "POST"],
    ["/browse/resource/" + child, "POST"],
  ])
    assert.equal((await f.request(route, method, headers)).statusCode, 401);
  for (const cookie of [
    headers.cookie + "; __Host-atlas-hub=forged",
    headers.cookie + "; arbitrary=1",
    "__Host-atlas-native-short=1",
    "__Host-atlas-native-" + "a".repeat(16),
  ])
    assert.equal(
      (await f.request(undefined, "GET", { origin: "null", cookie }))
        .statusCode,
      401,
    );
  f.staleHub();
  assert.equal((await f.request(undefined, "GET", headers)).statusCode, 401);
});
