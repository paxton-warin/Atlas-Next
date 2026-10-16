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

export { fixture, nativeHeaders };
