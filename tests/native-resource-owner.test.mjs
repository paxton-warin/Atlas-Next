import test from "node:test";
import assert from "node:assert/strict";
import {
  createNativeResourceOwner,
  createNativeResourceClient,
  NATIVE_RESOURCE_DOCUMENT_PROTOCOL as protocol,
} from "../runtime/native-resource-owner.ts";
const frontend = "https://front.test",
  resourceOrigin = "https://selected.test",
  docId = "native_document_123456",
  cap = "a".repeat(43),
  nativeURL = resourceOrigin + "/native-resource/v1/resource/" + "b".repeat(43),
  enrollment = "/native-resource/v1/enroll/" + "c".repeat(43),
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
class FakeImage extends EventTarget {
  set src(value) {
    this.assigned = value;
    queueMicrotask(() => this.dispatchEvent(new Event("load")));
  }
}
async function fixture(t, changes = {}) {
  let identity = {
      nodeId: "selected",
      resourceOrigin,
      leaseHash: "a".repeat(64),
      generation: 1,
    },
    grantExpiry = Date.now() + 60000;
  const http = [],
    wire = [],
    sockets = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor(url) {
      super();
      this.url = String(url);
      sockets.push(this);
      queueMicrotask(() =>
        this.message({
          type: "ready",
          capability: "native-resource-gateway-v1",
        }),
      );
    }
    message(value) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(value) }),
      );
    }
    send(raw) {
      if (typeof raw !== "string") {
        wire.push({ binary: true, bytes: raw.byteLength });
        return;
      }
      const v = JSON.parse(raw);
      wire.push(v);
      if (v.type === "begin")
        queueMicrotask(() =>
          this.message({ type: "upload-ready", uploadId: v.uploadId }),
        );
      if (v.type === "commit")
        queueMicrotask(() =>
          this.message({
            type: "resource-ready",
            uploadId: v.uploadId,
            url: nativeURL,
          }),
        );
      if (v.type === "abort-upload")
        queueMicrotask(() =>
          this.message({ type: "upload-aborted", uploadId: v.uploadId }),
        );
      if (v.type === "ping")
        queueMicrotask(() => this.message({ type: "pong" }));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event("close")));
    }
  }
  const response = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  const window = {
    location: { origin: frontend },
    crypto: globalThis.crypto,
    WebSocket: Socket,
    fetch: async (url, init) => {
      http.push({ url: String(url), init });
      if (String(url).endsWith("/owners/renew"))
        return response({
          expiresAt: grantExpiry,
          enrollments: [{ documentId: docId, enrollment }],
        });
      if (String(url).endsWith("/owners"))
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : response({
              capability: cap,
              websocket: "/native-resource/v1/owner/" + cap,
              resourceOrigin,
              expiresAt: grantExpiry,
            });
      return response({
        documentId: JSON.parse(init.body).documentId,
        enrollment,
      });
    },
  };
  const owner = await createNativeResourceOwner({
    window,
    identity: () => identity,
    grant: async () => ({
      ...identity,
      frontendOrigin: frontend,
      ownerTicket: "purpose.signed.ticket",
      role: "frontend-resource-owner-v1",
      purpose: "native-resource-owner",
      expiresAt: grantExpiry,
    }),
    timeoutMs: 200,
    renewBeforeMs: 1000,
    ...changes,
  });
  t.after(() => owner.dispose());
  return {
    owner,
    http,
    wire,
    sockets,
    setIdentity: (v) => (identity = v),
    identity: () => identity,
    extend: () => (grantExpiry += 60000),
  };
}
async function binding(f, t, changes = {}) {
  const channel = new MessageChannel(),
    childWire = [];
  channel.port2.addEventListener("message", (event) =>
    childWire.push(event.data),
  );
  const client = createNativeResourceClient({
    port: channel.port2,
    documentId: docId,
    resourceOrigin,
    Image: FakeImage,
    timeoutMs: 200,
  });
  const doc = await f.owner.bind({
    documentId: docId,
    documentURL: "https://website.test/path/",
    topLevelURL: "https://website.test/",
    contentPolicies: [],
    fetch: async (req) => ({
      url: req.url,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "image/png"]],
      body: new Uint8Array([137, 80, 78, 71]).buffer,
    }),
    port: channel.port1,
    ...changes,
  });
  t.after(() => {
    client.dispose();
    doc.dispose();
  });
  await Promise.all([client.ready, doc.ready]);
  return { client, doc, childWire, channel };
}
test("role and purpose metadata reject a relay ticket before native owner HTTP", async () => {
  let calls = 0;
  await assert.rejects(
    createNativeResourceOwner({
      window: {
        location: { origin: frontend },
        fetch: () => {
          calls++;
        },
        WebSocket: class {},
        crypto: globalThis.crypto,
      },
      identity: () => ({
        nodeId: "selected",
        resourceOrigin,
        leaseHash: "a".repeat(64),
        generation: 1,
      }),
      grant: async () => ({
        ownerTicket: "relay.ticket",
        role: "frontend-controller-v2",
        purpose: "relay",
      }),
    }),
    { code: "native_owner_ticket_denied" },
  );
  assert.equal(calls, 0);
});
test("URL-only bound child interface receives no owner ticket, cookie or response bytes", async (t) => {
  const f = await fixture(t),
    b = await binding(f, t);
  assert.equal(
    await b.client.prepare({
      url: "https://private.test/image.png",
      kind: "image",
    }),
    nativeURL,
  );
  const visible = JSON.stringify(b.childWire);
  for (const forbidden of [
    "purpose.signed.ticket",
    "authorization",
    "body",
    "sha256",
    "cookie",
  ])
    assert.equal(visible.toLowerCase().includes(forbidden), false, visible);
  assert.ok(
    b.childWire.every((v) => v.documentId === docId && v.protocol === protocol),
  );
  assert.ok(
    f.http.every(
      (v) => v.init.credentials === "omit" && v.init.redirect === "error",
    ),
  );
  assert.equal(f.wire.filter((v) => v.type === "begin").length, 1);
  assert.ok(f.wire.some((v) => v.binary));
});
test("document IDs are reserved before asynchronous work and mismatch messages revoke", async (t) => {
  const f = await fixture(t),
    b = await binding(f, t),
    second = new MessageChannel();
  t.after(() => {
    second.port1.close();
    second.port2.close();
  });
  await assert.rejects(
    f.owner.bind({ documentId: docId, port: second.port1 }),
    { code: "native_owner_invalid_document" },
  );
  for (let i = 0; i < 4; i++)
    b.channel.port2.postMessage({
      protocol,
      documentId: "wrong_document_123456",
      type: "prepare",
      sequence: i + 2,
      descriptor: { url: "/image", kind: "image" },
    });
  await delay(10);
  assert.equal(f.owner.stats().documents, 0);
  await assert.rejects(b.client.prepare({ url: "/image", kind: "image" }));
});
test("parent binding never accepts caller-selected document authority or frontend destinations", async (t) => {
  const f = await fixture(t),
    b = await binding(f, t);
  await assert.rejects(
    b.client.prepare({ url: frontend + "/secret", kind: "image" }),
  );
  await assert.rejects(
    b.client.prepare({
      url: "/image",
      kind: "image",
      documentURL: "https://attacker.test/",
    }),
  );
  assert.equal(f.wire.filter((v) => v.type === "begin").length, 0);
});
test("generation changes terminate old owner and its document-bound resource authority", async (t) => {
  const f = await fixture(t),
    b = await binding(f, t);
  f.setIdentity({ ...f.identity(), generation: 2 });
  await assert.rejects(b.client.prepare({ url: "/image", kind: "image" }));
  assert.equal(f.owner.stats().live, false);
  assert.equal(f.owner.stats().documents, 0);
});
test("same-identity renewal refreshes enrollment without changing bound child authority", async (t) => {
  const f = await fixture(t),
    b = await binding(f, t),
    before = b.childWire.filter((v) => v.type === "enroll").length;
  f.extend();
  await f.owner.renew();
  await b.client.ready;
  assert.equal(
    b.childWire.filter((v) => v.type === "enroll").length,
    before + 1,
  );
  assert.equal(
    await b.client.prepare({ url: "/image", kind: "image" }),
    nativeURL,
  );
  const renewed = f.http.find((v) => v.url.endsWith("/owners/renew"));
  assert.equal(JSON.parse(renewed.init.body).capability, cap);
  assert.equal(
    renewed.init.headers.Authorization,
    "Bearer purpose.signed.ticket",
  );
});
test("cancellation aborts stale source and suppresses late URL publication", async (t) => {
  const f = await fixture(t);
  let resolveFetch;
  const b = await binding(f, t, {
    fetch: (req, ctx) =>
      new Promise((resolve, reject) => {
        resolveFetch = () =>
          resolve({
            url: req.url,
            status: 200,
            statusText: "OK",
            headers: [["content-type", "image/png"]],
            body: new Uint8Array([137, 80, 78, 71]).buffer,
          });
        ctx.signal.addEventListener("abort", () => reject(Error("aborted")), {
          once: true,
        });
      }),
  });
  const signal = new AbortController(),
    task = b.client.prepare({ url: "/slow", kind: "image" }, signal.signal);
  await delay(5);
  signal.abort();
  await assert.rejects(task);
  resolveFetch();
  await delay(10);
  assert.equal(
    b.childWire.some((v) => v.type === "resource"),
    false,
  );
  assert.equal(
    f.wire.some((v) => v.type === "begin"),
    false,
  );
});
test("captured Image setter ignores later prototype replacement during renewal", async (t) => {
  const f = await fixture(t),
    b = await binding(f, t);
  const original = Object.getOwnPropertyDescriptor(FakeImage.prototype, "src");
  let intercepted = 0;
  Object.defineProperty(FakeImage.prototype, "src", {
    configurable: true,
    set() {
      intercepted++;
      throw Error("intercepted");
    },
  });
  t.after(() => Object.defineProperty(FakeImage.prototype, "src", original));
  f.extend();
  await f.owner.renew();
  assert.equal(intercepted, 0);
});
test("transient/stale auto-renew failures retain valid authority until its hard expiry", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const f = await fixture(t, { renewBeforeMs: 20000 });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  t.mock.timers.tick(40000);
  await flush();
  assert.equal(f.owner.stats().live, true);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(f.owner.stats().live, true);
  }
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(f.owner.stats().live, false);
});
