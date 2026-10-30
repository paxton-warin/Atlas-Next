import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { installFrontendDocumentReservations } from "../server/frontend-documents.mjs";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
const origin = "https://front.example",
  resourceOrigin = "https://selected.example";
const id = "doc_" + "a".repeat(32),
  session = "s".repeat(43),
  hash = "a".repeat(64);
async function fixture(t, limits = {}) {
  const app = Fastify();
  let live = true,
    held,
    after,
    validations = 0;
  const owner = { hash, origin, generation: 1 };
  const pool = {
    frontendAssignments: {
      identity(raw, front, generation) {
        return live && raw === session && front === origin && generation === 1
          ? owner
          : null;
      },
      validate(value) {
        validations++;
        return (
          live &&
          value.hash === hash &&
          value.origin === origin &&
          value.generation === 1
        );
      },
    },
    list: () => [{ id: "remote", endpoint: resourceOrigin, state: "active" }],
    async resourceOwner() {
      if (held) await held;
      return {
        nodeId: "remote",
        frontendOrigin: origin,
        resourceOrigin,
        leaseHash: hash,
        generation: 1,
        role: "frontend-resource-owner-v1",
        purpose: "native-resource-owner",
        expiresAt: Date.now() + 100000,
      };
    },
  };
  const reservations = installFrontendDocumentReservations(app, {
    pool,
    originFor: (req) => "https://" + req.headers.host,
    limitBrowse() {},
    ...limits,
  });
  installSandboxFramePrototype(app, {
    capabilities: true,
    nativeResourceOrigin: reservations.resourceOrigin,
  });
  t.after(() => app.close());
  return {
    app,
    reservations,
    get validations() {
      return validations;
    },
    revoke() {
      live = false;
    },
    hold() {
      held = new Promise((r) => (after = r));
      return () => after();
    },
    reserve(documentId = id, patch = {}, headers = {}) {
      return app.inject({
        method: "POST",
        url: "/api/browse/controller/document",
        headers: { host: "front.example", origin, ...headers },
        payload: { session, generation: 1, documentId, ...patch },
      });
    },
    frame(documentId = id, host = "front.example") {
      return app.inject({
        url: "/browse/frame/" + documentId,
        headers: { host },
      });
    },
  };
}
test("frame reservations authorize only selected HTTPS native paths; direct/foreign/expired visits remain opaque", async (t) => {
  const f = await fixture(t);
  assert.doesNotMatch(
    (await f.frame()).headers["content-security-policy"],
    /selected\.example/,
  );
  const registered = await f.reserve();
  assert.equal(registered.statusCode, 200);
  assert.equal(registered.json().frameURL, origin + "/browse/frame/" + id);
  const response = await f.frame(),
    csp = response.headers["content-security-policy"];
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(
    csp,
    /script-src [^;]*https:\/\/selected\.example\/native-resource\/v1\/resource\//,
  );
  assert.match(
    csp,
    /img-src [^;]*https:\/\/selected\.example\/native-resource\/v1\/enroll\//,
  );
  assert.doesNotMatch(
    csp,
    /connect-src [^;]*selected|selected\.example\/(?!native-resource)/,
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "Host, Origin");
  assert.doesNotMatch(
    (await f.frame(id, "other.example")).headers["content-security-policy"],
    /selected/,
  );
  assert.equal((await f.reserve()).statusCode, 200);
  assert.equal(f.reservations.size, 1);
  f.revoke();
  assert.doesNotMatch(
    (await f.frame()).headers["content-security-policy"],
    /selected/,
  );
  assert.equal(f.reservations.size, 0);
});
test("opaque/foreign callers, extra fields, invalid generation and node-selected URL claims are denied", async (t) => {
  const f = await fixture(t);
  for (const origin of ["null", "https://other.example", ""])
    assert.equal((await f.reserve(id, {}, { origin })).statusCode, 403);
  for (const patch of [{ generation: 0 }, { session: "x".repeat(43) }])
    assert.equal((await f.reserve(id, patch)).statusCode, 403);
  for (const patch of [
    { resourceOrigin: "https://attacker.example" },
    { documentId: "invalid" },
  ])
    assert.equal((await f.reserve(id, patch)).statusCode, 400);
  assert.equal(f.reservations.size, 0);
});
test("revocation during grant negotiation fails closed and bounded reservations cannot bypass limits", async (t) => {
  const f = await fixture(t, { maxPerLease: 1, maxEntries: 1 });
  assert.equal((await f.reserve()).statusCode, 200);
  assert.equal((await f.reserve("doc_" + "b".repeat(32))).statusCode, 429);
  const release = f.hold(),
    pending = f.reserve();
  await new Promise((r) => setTimeout(r, 10));
  f.revoke();
  release();
  assert.equal((await pending).statusCode, 409);
  assert.doesNotMatch(
    (await f.frame()).headers["content-security-policy"],
    /selected/,
  );
  assert.equal(f.reservations.size, 0);
});
test("unknown frame visits cannot multiply lease/database cleanup by all retained reservations", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 12; n++)
    assert.equal(
      (await f.reserve("doc_" + n.toString(16).padStart(32, "0"))).statusCode,
      200,
    );
  const before = f.validations;
  await f.frame("doc_" + "f".repeat(32));
  assert.equal(
    f.validations,
    before,
    "unknown document performs no per-entry lease validations",
  );
  await f.frame("doc_" + "0".repeat(32));
  assert.equal(
    f.validations,
    before + 1,
    "known document validates only its own authoritative tuple",
  );
});

test("nested physical policy requires a same-assignment parent; direct frames keep ancestor protection", async (t) => {
  const f = await fixture(t),
    child = "doc_" + "b".repeat(32),
    other = "doc_" + "c".repeat(32);
  assert.equal(
    (
      await f.reserve(child, {
        parentDocumentId: id,
        bootstrapNonce: "a".repeat(72),
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.reserve()).statusCode, 200);
  assert.equal(
    (
      await f.reserve(child, {
        parentDocumentId: id,
        bootstrapNonce: "a".repeat(72),
      })
    ).statusCode,
    200,
  );
  const nested = f.reservations.nestedPolicy(
    { headers: { host: "front.example" } },
    child,
  );
  assert.equal(nested.nested, true);
  assert.equal(nested.prefix, origin + "/browse/frame/");
  assert.equal(nested.bootstrapNonce, "a".repeat(72));
  assert.equal(
    f.reservations.nestedPolicy({ headers: { host: "front.example" } }, id)
      .nested,
    false,
  );
  assert.equal(
    (
      await f.reserve(child, {
        parentDocumentId: other,
        bootstrapNonce: "a".repeat(72),
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.reserve(child)).statusCode, 200);
  assert.equal(
    f.reservations.nestedPolicy({ headers: { host: "front.example" } }, child)
      .nested,
    true,
    "refresh cannot remove nested binding",
  );
  assert.equal(
    (
      await f.reserve(
        other,
        { parentDocumentId: id, bootstrapNonce: "a".repeat(72) },
        { origin: "null" },
      )
    ).statusCode,
    403,
  );
});
