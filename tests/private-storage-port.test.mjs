/** Native MessagePort unit regression; real opaque Window and native IDB proof
 * is tests/private-storage-port-browser.mjs. ACK XHR here is an explicit stub. */
import test from "node:test";
import assert from "node:assert/strict";
import { createSandboxStorageFacades } from "../runtime/sandbox-local-storage.ts";
import { createSandboxDocumentCookie } from "../runtime/sandbox-document-cookie.ts";
import { createSandboxIndexedDB } from "../runtime/sandbox-idb.ts";

test("child storage, cookie and IDB ports never enter hostile public getters or methods", async () => {
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const deleteProperty = Reflect.deleteProperty;
  const nativeData = descriptor(MessageEvent.prototype, "data").get;
  const channels = [
    new MessageChannel(),
    new MessageChannel(),
    new MessageChannel(),
  ];
  const privatePorts = new Set(channels.map((channel) => channel.port2));
  const peers = channels.map((channel) => channel.port1);
  const documentId = "private_storage_unit_document";
  class ACKXHR {
    open() {}
    setRequestHeader() {}
    send() {}
    get status() {
      return 200;
    }
    get responseText() {
      return '{"ok":true,"revision":1}';
    }
  }
  const owner = {
    origin: "null",
    location: {
      origin: "https://frontend.test",
      href: "https://frontend.test/",
    },
    MessageEvent,
    MessagePort,
    EventTarget,
    Uint8Array,
    XMLHttpRequest: ACKXHR,
    Storage: class Storage {
      key() {}
      getItem() {}
      setItem() {}
      removeItem() {}
      clear() {}
      get length() {
        return 0;
      }
    },
    setTimeout,
    clearTimeout,
  };
  peers[0].postMessage({
    type: "ready",
    documentId,
    snapshots: {
      local: { revision: 0, entries: [] },
      session: { revision: 0, entries: [] },
    },
  });
  peers[1].postMessage({
    protocol: "atlas-cookie-result-v1",
    documentId,
    type: "ready",
    documentURL: "https://website.test/path",
    key: new Uint8Array(32).fill(7),
  });
  const storage = await createSandboxStorageFacades({
    port: channels[0].port2,
    documentId,
    endpoint: "https://frontend.test/browse/storage/commit/" + "a".repeat(43),
    window: owner,
  });
  const cookie = await createSandboxDocumentCookie({
    port: channels[1].port2,
    documentId,
    endpoint: "https://frontend.test/browse/cookies/result/" + "b".repeat(43),
    window: owner,
  });
  const idb = createSandboxIndexedDB(channels[2].port2, documentId);
  const restores = [],
    leaks = [];
  const record = (name, receiver) => {
    if (privatePorts.has(receiver)) leaks.push(name);
  };
  const replace = (prototype, name, value) => {
    const old = descriptor(prototype, name);
    define(prototype, name, {
      configurable: true,
      writable: true,
      ...old,
      value,
    });
    restores.push(() =>
      old ? define(prototype, name, old) : deleteProperty(prototype, name),
    );
  };
  const oldData = descriptor(MessageEvent.prototype, "data");
  define(MessageEvent.prototype, "data", {
    ...oldData,
    get() {
      record("data", this.currentTarget);
      return apply(nativeData, this, []);
    },
  });
  restores.push(() => define(MessageEvent.prototype, "data", oldData));
  for (const [prototype, names] of [
    [MessagePort.prototype, ["postMessage", "start", "close"]],
    [EventTarget.prototype, ["addEventListener", "removeEventListener"]],
  ]) {
    for (const name of names) {
      const original = prototype[name];
      replace(prototype, name, function (...args) {
        record(name, this);
        return apply(original, this, args);
      });
    }
  }
  const fill = Uint8Array.prototype.fill;
  replace(Uint8Array.prototype, "fill", function (...args) {
    if (this.byteLength === 32) leaks.push("cookie-key-fill");
    return apply(fill, this, args);
  });
  try {
    peers[2].onmessage = (event) => {
      const message = apply(nativeData, event, []);
      if (message.type === "databases")
        peers[2].postMessage({
          protocol: message.protocol,
          documentId,
          type: "result",
          request: message.request,
          value: [{ name: "unit-db", version: 1 }],
        });
    };
    peers[0].postMessage({
      type: "snapshot",
      documentId,
      kind: "local",
      snapshot: { revision: 2, entries: [["mirror", "committed"]] },
    });
    peers[1].postMessage({
      protocol: "atlas-cookie-result-v1",
      documentId,
      type: "revoked",
    });
    storage.localStorage.setItem("own", "value");
    assert.deepEqual(await idb.databases(), [{ name: "unit-db", version: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(storage.localStorage.getItem("mirror"), "committed");
    assert.throws(() => cookie.get(), { name: "InvalidStateError" });
    storage.dispose();
    cookie.dispose();
    idb.dispose();
    assert.deepEqual(leaks, []);
  } finally {
    for (const restore of restores.reverse()) restore();
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
  }
});
