import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { installNativeResourceGateway } from "../server/native-resource-gateway.mjs";
const ROOT = "/native-resource/v1/",
  frontend = "https://front.test",
  policy = {
    originalAllowed: true,
    mixedContentChecked: true,
    integrityChecked: true,
    contentPolicyChecked: true,
  };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, limits = {}) {
  const app = Fastify({ logger: false });
  let origin,
    allowed = true,
    validation = () => allowed,
    identityOverride = {};
  const gateway = installNativeResourceGateway(app, {
    originFor: (req) => "https://" + req.headers.host,
    authorizeOwner: (req) =>
      req.headers.authorization === "Bearer dedicated-owner-ticket"
        ? Object.freeze({
            nodeId: "selected",
            frontendOrigin: frontend,
            resourceOrigin: origin,
            leaseHash: "a".repeat(64),
            generation: 1,
            expiresAt: Date.now() + 60000,
            ...identityOverride,
          })
        : null,
    validateOwner: () => validation(),
    blockedHosts: ["blocked.test"],
    limits,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = "127.0.0.1:" + app.server.address().port;
  origin = "https://" + address;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await delay(5);
    await app.close();
  });
  const inject = (path, options = {}) =>
    app.inject({
      url: ROOT + path,
      headers: { host: address, origin: frontend, ...options.headers },
      ...options,
      headers: { host: address, origin: frontend, ...options.headers },
    });
  const register = async () => {
    const r = await inject("owners", {
      method: "POST",
      headers: { authorization: "Bearer dedicated-owner-ticket" },
      payload: {},
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  async function connect(owner, headers = {}) {
    const ws = new WebSocket("ws://" + address + owner.websocket, {
      headers: { Origin: frontend, ...headers },
    });
    sockets.push(ws);
    const messages = [],
      waiters = [];
    ws.on("message", (data) => {
      const v = JSON.parse(data.toString());
      const i = waiters.findIndex((w) => w.test(v));
      if (i < 0) messages.push(v);
      else {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(v);
      }
    });
    ws.on("error", () => {});
    ws.next = (predicate = () => true) => {
      const i = messages.findIndex(predicate);
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = {
          test: predicate,
          resolve,
          timer: setTimeout(() => reject(Error("message timeout")), 1500),
        };
        waiters.push(w);
      });
    };
    await once(ws, "open");
    assert.equal((await ws.next()).type, "ready");
    return ws;
  }
  const document = async (owner, id = "test-document-123456") => {
    const r = await inject("documents", {
      method: "POST",
      headers: { authorization: "Bearer " + owner.capability },
      payload: {
        documentId: id,
        documentURL: "https://website.test/path/",
        topLevelURL: "https://website.test/",
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const make = async () => {
    const owner = await register(),
      ws = await connect(owner),
      doc = await document(owner);
    return { owner, ws, doc };
  };
  const metadata = (doc, body = Buffer.from("a{color:red}"), extra = {}) => ({
    type: "begin",
    uploadId: randomBytes(16).toString("hex"),
    documentId: doc.documentId,
    sourceURL: "https://unreadable.test/style.css",
    kind: "style",
    mime: "text/css",
    bodyBytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    policy,
    ...extra,
  });
  const upload = async (ws, doc, body = Buffer.from("a{color:red}")) => {
    const m = metadata(doc, body);
    ws.send(JSON.stringify(m));
    assert.equal((await ws.next()).type, "upload-ready");
    ws.send(Buffer.concat([Buffer.from(m.uploadId), body]));
    ws.send(JSON.stringify({ type: "commit", uploadId: m.uploadId }));
    const r = await ws.next();
    assert.equal(r.type, "resource-ready", JSON.stringify(r));
    return { url: new URL(r.url).pathname, meta: m, body };
  };
  const enroll = async (doc) => {
    const r = await app.inject({
      url: doc.enrollment,
      headers: {
        host: address,
        "sec-fetch-dest": "image",
        "sec-fetch-mode": "no-cors",
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    const set = r.headers["set-cookie"];
    assert.match(set, /Secure; HttpOnly; SameSite=None; Partitioned; Path=\//);
    return set.split(";")[0];
  };
  return {
    app,
    gateway,
    inject,
    register,
    connect,
    document,
    make,
    metadata,
    upload,
    enroll,
    address,
    origin,
    getAllowed: () => allowed,
    setAllowed: (v) => (allowed = v),
    setIdentity: (v) => (identityOverride = v),
    setValidation: (f) => (validation = f),
  };
}
const nativeHeaders = (f, cookie, extra = {}) => ({
  host: f.address,
  cookie,
  "sec-fetch-dest": "style",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "cross-site",
  ...extra,
});
test("requires dedicated purpose and exact non-opaque frontend owner origin", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { authorization: "Bearer relay-ticket" },
    { authorization: "Bearer dedicated-owner-ticket", origin: "null" },
    {
      authorization: "Bearer dedicated-owner-ticket",
      origin: "https://attacker.test",
    },
  ])
    assert.ok(
      (await f.inject("owners", { method: "POST", headers, payload: {} }))
        .statusCode >= 400,
    );
  const preflight = await f.inject("owners", {
    method: "OPTIONS",
    headers: { origin: "null" },
  });
  assert.equal(preflight.statusCode, 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  const owner = await f.register();
  assert.ok(owner.capability);
  assert.equal(f.gateway.stats().owners, 1);
});
test("document URL binding rejects frontend, assigned node, and reserved hosts", async (t) => {
  const f = await fixture(t),
    owner = await f.register();
  await f.connect(owner);
  for (const documentURL of [
    frontend,
    f.origin,
    "https://blocked.test/",
    "file:///private",
    "https://user:password@website.test/",
  ]) {
    const r = await f.inject("documents", {
      method: "POST",
      headers: { authorization: "Bearer " + owner.capability },
      payload: {
        documentId: "test-document-123456",
        documentURL,
        topLevelURL: "https://website.test/",
      },
    });
    assert.ok(r.statusCode >= 400, r.body);
  }
  assert.equal(f.gateway.stats().documents, 0);
});
test("uploads only browser-provided bytes; cookie proof required in addition to visible cap", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make(),
    resource = await f.upload(ws, doc);
  let r = await f.app.inject({
    url: resource.url,
    headers: nativeHeaders(f, ""),
  });
  assert.equal(r.statusCode, 403);
  const cookie = await f.enroll(doc);
  r = await f.app.inject({
    url: resource.url,
    headers: nativeHeaders(f, cookie),
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, resource.body.toString());
  for (const field of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "timing-allow-origin",
    "set-cookie",
  ])
    assert.equal(r.headers[field], undefined);
  assert.equal(r.headers["cache-control"], "private, no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  const head = await f.app.inject({
    method: "HEAD",
    url: resource.url,
    headers: nativeHeaders(f, cookie),
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-length"], String(resource.body.length));
  assert.equal(
    (
      await f.app.inject({
        url: doc.enrollment,
        headers: {
          host: f.address,
          "sec-fetch-dest": "image",
          "sec-fetch-mode": "no-cors",
        },
      })
    ).statusCode,
    403,
  );
});
test("native gate rejects duplicate/wrong cookies, document/fetch/navigation and query confusion", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make(),
    resource = await f.upload(ws, doc),
    cookie = await f.enroll(doc);
  for (const [cookieValue, extra, url] of [
    [cookie + "; " + cookie, {}, resource.url],
    [cookie.slice(0, -1) + "x", {}, resource.url],
    [cookie, { "sec-fetch-dest": "document" }, resource.url],
    [cookie, { "sec-fetch-mode": "cors" }, resource.url],
    [cookie, { "sec-fetch-site": "none" }, resource.url],
    [cookie, {}, resource.url + "?anything=1"],
  ])
    assert.equal(
      (
        await f.app.inject({
          url,
          headers: nativeHeaders(f, cookieValue, extra),
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: resource.url,
        headers: nativeHeaders(f, cookie),
      })
    ).statusCode,
    404,
  );
});
test("enrollment is one-use even concurrent asynchronous live-owner validation", async (t) => {
  const f = await fixture(t),
    { doc } = await f.make();
  let resolve;
  const hold = new Promise((r) => (resolve = r));
  f.setValidation(() => hold);
  const request = () =>
    f.app.inject({
      url: doc.enrollment,
      headers: {
        host: f.address,
        "sec-fetch-dest": "image",
        "sec-fetch-mode": "no-cors",
      },
    });
  const a = request(),
    b = request();
  await delay(10);
  resolve(true);
  const responses = await Promise.all([a, b]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 403]);
});
test("owner revocation defeats pending validations and releases cached RAM", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make(),
    resource = await f.upload(ws, doc),
    cookie = await f.enroll(doc);
  let resolve;
  const hold = new Promise((r) => (resolve = r));
  f.setValidation(() => hold);
  const pending = f.app.inject({
    url: resource.url,
    headers: nativeHeaders(f, cookie),
  });
  await delay(10);
  f.gateway.revokeSession("a".repeat(64));
  resolve(true);
  assert.equal((await pending).statusCode, 403);
  assert.deepEqual(f.gateway.stats(), {
    owners: 0,
    documents: 0,
    resources: 0,
    bytes: 0,
    validations: 0,
  });
});
test("upload digest mismatch cannot publish partial bytes and revokes owner", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make(),
    m = f.metadata(doc, Buffer.from("good"));
  ws.send(JSON.stringify(m));
  assert.equal((await ws.next()).type, "upload-ready");
  ws.send(Buffer.concat([Buffer.from(m.uploadId), Buffer.from("evil")]));
  ws.send(JSON.stringify({ type: "commit", uploadId: m.uploadId }));
  assert.equal((await ws.next()).code, "native_resource_digest_mismatch");
  await delay(10);
  assert.equal(f.gateway.stats().bytes, 0);
  assert.equal(f.gateway.stats().resources, 0);
});
test("upload reservation quotas reject before accepting payload and clear all state", async (t) => {
  const f = await fixture(t, {
      bodyBytes: 16,
      documentBytes: 16,
      ownerBytes: 16,
      totalBytes: 16,
    }),
    { ws, doc } = await f.make();
  await f.upload(ws, doc, Buffer.alloc(12, 65));
  ws.send(JSON.stringify(f.metadata(doc, Buffer.alloc(12, 66))));
  assert.equal((await ws.next()).code, "native_resource_cache_limit");
  await delay(10);
  assert.equal(f.gateway.stats().bytes, 0);
});
test("unfinished upload expiry clears reservation; owner disconnect clears cache", async (t) => {
  const f = await fixture(t, { uploadMs: 30 }),
    { ws, doc } = await f.make(),
    m = f.metadata(doc);
  ws.send(JSON.stringify(m));
  assert.equal((await ws.next()).type, "upload-ready");
  assert.equal((await ws.next()).code, "native_resource_upload_timeout");
  assert.equal(f.gateway.stats().bytes, 0);
  await f.upload(ws, doc);
  ws.close();
  await delay(20);
  assert.equal(f.gateway.stats().bytes, 0);
  assert.equal(f.gateway.stats().owners, 0);
});
test("policy attestation and HTTPS mixed-content checks fail closed", async (t) => {
  for (const extra of [
    { policy: { ...policy, integrityChecked: false } },
    { sourceURL: "http://website.test/style.css" },
    { sourceURL: "https://blocked.test/style.css" },
    { kind: "document", mime: "text/html" },
  ]) {
    const f = await fixture(t),
      { ws, doc } = await f.make();
    ws.send(JSON.stringify(f.metadata(doc, undefined, extra)));
    assert.equal((await ws.next()).type, "error");
    await delay(5);
    assert.equal(f.gateway.stats().bytes, 0);
  }
});
test("unconnected owner and enrollment expire without persistence", async (t) => {
  const f = await fixture(t, { connectMs: 20, enrollmentMs: 15 });
  await f.register();
  await delay(35);
  assert.equal(f.gateway.stats().owners, 0);
  const { doc } = await f.make();
  await delay(25);
  const r = await f.app.inject({
    url: doc.enrollment,
    headers: {
      host: f.address,
      "sec-fetch-dest": "image",
      "sec-fetch-mode": "no-cors",
    },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(r.headers["set-cookie"], undefined);
});
test("invalidated lease fails native serving and owner operations", async (t) => {
  const f = await fixture(t),
    { owner, ws, doc } = await f.make(),
    resource = await f.upload(ws, doc),
    cookie = await f.enroll(doc);
  f.setAllowed(false);
  assert.equal(
    (
      await f.app.inject({
        url: resource.url,
        headers: nativeHeaders(f, cookie),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.inject("documents", {
        method: "POST",
        headers: { authorization: "Bearer " + owner.capability },
        payload: {},
      })
    ).statusCode,
    401,
  );
  ws.send(JSON.stringify({ type: "ping" }));
  await delay(15);
  assert.equal(f.gateway.stats().bytes, 0);
});
test("bounded control queue revokes flooding owner while validation is pending", async (t) => {
  const f = await fixture(t, { queuedMessages: 3, validationMs: 30 }),
    { ws, doc } = await f.make();
  let resolve;
  const hold = new Promise((r) => (resolve = r));
  f.setValidation(() => hold);
  for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: "ping" }));
  await delay(15);
  assert.equal(f.gateway.stats().owners, 0);
  resolve(true);
  await delay(10);
  assert.equal(f.gateway.stats().bytes, 0);
});
test("revoke-document clears its resources but retains unrelated owner", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make();
  await f.upload(ws, doc);
  ws.send(
    JSON.stringify({ type: "revoke-document", documentId: doc.documentId }),
  );
  await delay(15);
  assert.equal(f.gateway.stats().resources, 0);
  assert.equal(f.gateway.stats().bytes, 0);
  assert.equal(f.gateway.stats().owners, 1);
});
test("dedicated owner authorizer is bounded across unresolved callbacks", async (t) => {
  const app = Fastify({ logger: false });
  let calls = 0,
    resolve;
  const hold = new Promise((r) => (resolve = r));
  const gateway = installNativeResourceGateway(app, {
    originFor: () => "https://selected.test",
    authorizeOwner: () => {
      calls++;
      return hold;
    },
    validateOwner: () => true,
    limits: { validationMs: 15, validations: 2 },
  });
  t.after(() => app.close());
  const request = () =>
    app.inject({
      method: "POST",
      url: ROOT + "owners",
      headers: { origin: frontend, authorization: "Bearer purpose" },
      payload: {},
    });
  const responses = await Promise.all([request(), request(), request()]);
  assert.ok(responses.every((r) => r.statusCode === 401));
  assert.equal(calls, 2);
  assert.equal(gateway.stats().validations, 2);
  resolve(null);
  await delay(1);
  assert.equal(gateway.stats().validations, 0);
});

test("unknown resource with forged undefined cookie still returns generic403", async (t) => {
  const f = await fixture(t);
  const r = await f.app.inject({
    url: ROOT + "resource/" + "x".repeat(43),
    headers: nativeHeaders(f, "undefined=" + "a".repeat(43)),
  });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body, "Native resource unavailable");
});
test("abort-upload releases partial reservation and racing committed resource only", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make(),
    kept = await f.upload(ws, doc),
    m = f.metadata(doc);
  ws.send(JSON.stringify(m));
  assert.equal((await ws.next()).type, "upload-ready");
  ws.send(JSON.stringify({ type: "abort-upload", uploadId: m.uploadId }));
  assert.equal((await ws.next()).type, "upload-aborted");
  assert.equal(f.gateway.stats().bytes, kept.body.length);
  const racing = await f.upload(ws, doc);
  ws.send(
    JSON.stringify({ type: "abort-upload", uploadId: racing.meta.uploadId }),
  );
  assert.equal((await ws.next()).type, "upload-aborted");
  assert.equal(f.gateway.stats().bytes, kept.body.length);
  assert.equal(f.gateway.stats().resources, 1);
  assert.equal(f.gateway.stats().owners, 1);
});
test("fresh same-identity purpose ticket renews owner without changing secret or resource caps", async (t) => {
  const f = await fixture(t),
    { owner, ws, doc } = await f.make(),
    resource = await f.upload(ws, doc),
    cookie = await f.enroll(doc);
  const expiresAt = Date.now() + 120000;
  f.setIdentity({ expiresAt });
  const r = await f.inject("owners/renew", {
    method: "POST",
    headers: { authorization: "Bearer dedicated-owner-ticket" },
    payload: { capability: owner.capability },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().expiresAt, expiresAt);
  assert.equal(r.json().enrollments.length, 1);
  const refreshed = await f.enroll({
    enrollment: r.json().enrollments[0].enrollment,
  });
  assert.equal(refreshed, cookie);
  assert.equal(
    (
      await f.app.inject({
        url: resource.url,
        headers: nativeHeaders(f, cookie),
      })
    ).statusCode,
    200,
  );
  assert.equal(f.gateway.stats().resources, 1);
  const stale = await f.inject("owners/renew", {
    method: "POST",
    headers: { authorization: "Bearer dedicated-owner-ticket" },
    payload: { capability: owner.capability },
  });
  assert.equal(stale.statusCode, 409);
});
test("owner renewal rejects scope changes, expired owners and explicit revocation", async (t) => {
  const f = await fixture(t),
    { owner } = await f.make();
  for (const scope of [
    { nodeId: "different" },
    { generation: 2 },
    { leaseHash: "b".repeat(64) },
    { frontendOrigin: "https://attacker.test" },
    { resourceOrigin: "https://other-node.test" },
  ]) {
    f.setIdentity({ expiresAt: Date.now() + 120000, ...scope });
    const r = await f.inject("owners/renew", {
      method: "POST",
      headers: { authorization: "Bearer dedicated-owner-ticket" },
      payload: { capability: owner.capability },
    });
    assert.ok(r.statusCode === 403, r.body);
  }
  f.setIdentity({ expiresAt: Date.now() + 120000 });
  f.gateway.revokeSession("a".repeat(64));
  assert.equal(
    (
      await f.inject("owners/renew", {
        method: "POST",
        headers: { authorization: "Bearer dedicated-owner-ticket" },
        payload: { capability: owner.capability },
      })
    ).statusCode,
    401,
  );
  const expired = await fixture(t);
  expired.setIdentity({ expiresAt: Date.now() + 30 });
  const short = await expired.register();
  await delay(40);
  expired.setIdentity({ expiresAt: Date.now() + 120000 });
  assert.equal(
    (
      await expired.inject("owners/renew", {
        method: "POST",
        headers: { authorization: "Bearer dedicated-owner-ticket" },
        payload: { capability: short.capability },
      })
    ).statusCode,
    401,
  );
});
