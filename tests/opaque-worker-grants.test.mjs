import test from "node:test";
import assert from "node:assert/strict";
import { createOpaqueWorkerGrants } from "../runtime/opaque-worker-grants.ts";
const id = "worker_" + "a".repeat(48),
  documentId = "original_document_0123456789";
const source = {
  url: "https://site.test/final.js",
  source: "postMessage(42)",
  contentPolicies: ["script-src 'self'"],
};
const next = (port) =>
  new Promise((resolve) =>
    port.addEventListener("message", (e) => resolve(e.data), { once: true }),
  );
function fixture(timeoutMs = 1000) {
  const control = new MessageChannel();
  control.port2.start();
  const client = createOpaqueWorkerGrants({
    port: control.port1,
    documentId,
    timeoutMs,
  });
  return {
    control,
    client,
    close() {
      client.dispose();
      control.port1.close();
      control.port2.close();
    },
  };
}
test("worker grants bind only exact private control request and transfer two isolated capabilities", async () => {
  const f = fixture(),
    n = new MessageChannel(),
    i = new MessageChannel();
  try {
    const request = next(f.control.port2),
      pending = f.client.bind({
        documentId: id,
        documentURL: "https://site.test/start.js",
        type: "module",
        credentials: "omit",
      });
    const r = await request;
    assert.deepEqual(r, {
      protocol: 2,
      documentId,
      type: "worker-create",
      requestId: 1,
      workerId: id,
      url: "https://site.test/start.js",
      kind: "module",
      credentials: "omit",
    });
    f.control.port2.postMessage(
      {
        protocol: 2,
        documentId,
        type: "worker-grant",
        requestId: 1,
        workerId: id,
        ok: true,
        source,
      },
      [n.port2, i.port2],
    );
    const grant = await pending;
    assert.equal(Object.getPrototypeOf(grant), null);
    assert.equal(grant.source.url, source.url);
    assert.ok(Object.isFrozen(grant.source));
    const transfer = next(n.port1);
    n.port1.start();
    grant.network.postMessage("private network");
    assert.equal(await transfer, "private network");
    const release = next(f.control.port2);
    grant.dispose();
    assert.equal((await release).type, "worker-release");
    grant.network.close();
    grant.indexedDB.close();
  } finally {
    f.close();
    n.port1.close();
    i.port1.close();
  }
});
test("denied worker grant returns fixed typed code rather than assigning readonly DOMException.code", async () => {
  const f = fixture();
  try {
    const request = next(f.control.port2),
      pending = f.client.bind({
        documentId: id,
        documentURL: "https://site.test/start.js",
        type: "classic",
      });
    await request;
    f.control.port2.postMessage({
      protocol: 2,
      documentId,
      type: "worker-grant",
      requestId: 1,
      workerId: id,
      ok: false,
      code: "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
    });
    await assert.rejects(pending, {
      name: "NotSupportedError",
      code: "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
    });
  } finally {
    f.close();
  }
});
test("private grant resolution resists Promise/Map/MessageEvent/Object.then poisoning", async () => {
  const f = fixture(),
    n = new MessageChannel(),
    i = new MessageChannel();
  const NativePromise = Promise,
    mapGet = Map.prototype.get,
    eventData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data"),
    then = Object.getOwnPropertyDescriptor(Object.prototype, "then");
  let leaked = false;
  try {
    const request = next(f.control.port2),
      pending = f.client.bind({
        documentId: id,
        documentURL: "https://site.test/start.js",
        type: "classic",
      });
    await request;
    globalThis.Promise = class {
      constructor() {
        leaked = true;
        throw Error("poisoned Promise");
      }
    };
    Map.prototype.get = () => {
      leaked = true;
      throw Error("poisoned map");
    };
    Object.defineProperty(MessageEvent.prototype, "data", {
      configurable: true,
      get() {
        leaked = true;
        throw Error("poisoned event");
      },
    });
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        if (this.network || this.indexedDB) leaked = true;
        return undefined;
      },
    });
    f.control.port2.postMessage(
      {
        protocol: 2,
        documentId,
        type: "worker-grant",
        requestId: 1,
        workerId: id,
        ok: true,
        source,
      },
      [n.port2, i.port2],
    );
    const grant = await pending;
    assert.equal(leaked, false);
    assert.equal(Object.getPrototypeOf(grant), null);
    grant.network.close();
    grant.indexedDB.close();
  } finally {
    globalThis.Promise = NativePromise;
    Map.prototype.get = mapGet;
    Object.defineProperty(MessageEvent.prototype, "data", eventData);
    if (then) Object.defineProperty(Object.prototype, "then", then);
    else delete Object.prototype.then;
    f.close();
    n.port1.close();
    i.port1.close();
  }
});
test("invalid final origin is rejected and timeout/dispose release pending worker binding", async () => {
  const f = fixture(20);
  try {
    const request = next(f.control.port2),
      pending = f.client.bind({
        documentId: id,
        documentURL: "https://site.test/start.js",
        type: "classic",
      });
    await request;
    f.control.port2.postMessage({
      protocol: 2,
      documentId,
      type: "worker-grant",
      requestId: 1,
      workerId: id,
      ok: true,
      source: { ...source, url: "https://peer.test/a.js" },
    });
    await assert.rejects(pending, TypeError);
    const timeout = f.client.bind({
      documentId: "worker_" + "b".repeat(48),
      documentURL: "https://site.test/start.js",
      type: "classic",
    });
    await assert.rejects(timeout, { name: "TimeoutError" });
    const disposed = f.client.bind({
      documentId: "worker_" + "c".repeat(48),
      documentURL: "https://site.test/start.js",
      type: "classic",
    });
    f.client.dispose();
    await assert.rejects(disposed, { name: "AbortError" });
  } finally {
    f.close();
  }
});
