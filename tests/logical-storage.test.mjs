import test from "node:test";
import assert from "node:assert/strict";
import { createLogicalStorage } from "../runtime/logical-storage.ts";
function nativeStore(entries = []) {
  const map = new Map(entries);
  return {
    getItem: (key) => map.get(String(key)) ?? null,
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}
test("logical Web Storage provides keys, enumeration, deletion and clear with exact origin boundaries", () => {
  const native = nativeStore([
    ["atlas.settings", "frontend-preferences"],
    ["https://example.test@a", "one"],
    ["https://example.test.evil@b", "neighbor"],
    ["http://example.test@a", "http-save"],
  ]);
  const store = createLogicalStorage(native, "https://example.test");
  assert.equal(store.length, 1);
  assert.equal(store.key(0), "a");
  assert.equal(store.key(1), null);
  assert.equal(store.getItem("missing"), null);
  assert.equal(store.missing, undefined);
  store.b = 2;
  assert.deepEqual(Object.keys(store), ["a", "b"]);
  assert.deepEqual({ ...store }, { a: "one", b: "2" });
  delete store.a;
  assert.equal(store.getItem("a"), null);
  Object.defineProperty(store, "c", { value: "three" });
  assert.equal(store.c, "three");
  store.clear();
  assert.equal(store.length, 0);
  assert.equal(native.getItem("atlas.settings"), "frontend-preferences");
  assert.equal(native.getItem("https://example.test.evil@b"), "neighbor");
  assert.equal(native.getItem("http://example.test@a"), "http-save");
});
test("legacy host saves upgrade non-destructively once and never resurrect after clear", () => {
  const native = nativeStore([
    ["example.test@save", "legacy"],
    ["example.test.other@save", "other"],
  ]);
  const store = createLogicalStorage(native, "https://example.test/path");
  assert.equal(store.save, "legacy");
  assert.equal(native.getItem("example.test@save"), "legacy");
  store.clear();
  assert.equal(
    createLogicalStorage(native, "https://example.test").getItem("save"),
    null,
  );
  assert.equal(native.getItem("example.test.other@save"), "other");
});
test("logical origin storage survives a node/frame change and does not overwrite an existing modern save", () => {
  const native = nativeStore([
    ["example.test@save", "legacy"],
    ["https://example.test@save", "current"],
  ]);
  const first = createLogicalStorage(native, "https://example.test/a");
  assert.equal(first.save, "current");
  first.setItem("save", "node-one");
  const second = createLogicalStorage(native, "https://example.test/b");
  assert.equal(second.save, "node-one");
  second.setItem("save", "node-two");
  assert.equal(first.save, "node-two");
  assert.equal(
    createLogicalStorage(native, "http://example.test").save,
    "legacy",
  );
  assert.equal(first.save, "node-two");
});

test("clearing website data preserves Atlas settings, chats, assignments and unrelated databases/caches", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const origin = "https://atlas.example";
  const local = nativeStore([
    ["atlas.settings", "prefs"],
    ["atlas.chats", "chats"],
    ["atlas.nodeSession", "assignment"],
    ["example.test@old", "legacy"],
    ["https://example.test@save", "website"],
    ["__atlas.logicalStorage.v1@https://example.test", "1"],
  ]);
  const session = nativeStore([
    ["atlas.tab", "tab"],
    ["https://example.test@session", "website"],
  ]);
  const removedDBs = [],
    removedCaches = [],
    messages = [];
  let handler;
  const parent = { postMessage: (message) => messages.push(message) };
  runInNewContext(
    readFileSync(
      new URL("../runtime/public/clear.js", import.meta.url),
      "utf8",
    ),
    {
      fetch: async () => ({ json: async () => ({ appOrigin: origin }) }),
      location: { hash: "#ticket=fixture" },
      URLSearchParams,
      parent,
      window: {
        addEventListener: (_name, listener) => {
          handler = listener;
        },
      },
      localStorage: local,
      sessionStorage: session,
      indexedDB: {
        databases: async () =>
          [
            "atlas-chats",
            "https://example.test@save",
            "__runtimekit_controller",
            "other",
          ].map((name) => ({ name })),
        deleteDatabase: (name) => {
          removedDBs.push(name);
          const request = {};
          queueMicrotask(() => request.onsuccess());
          return request;
        },
      },
      caches: {
        keys: async () => ["atlas-shell", "https://example.test@assets"],
        delete: async (name) => {
          removedCaches.push(name);
          return true;
        },
      },
    },
  );
  for (let i = 0; i < 10 && !handler; i++) await Promise.resolve();
  assert.ok(handler);
  await handler({
    source: parent,
    origin,
    data: { atlas: 1, type: "confirm-clear" },
  });
  assert.deepEqual(removedDBs, [
    "https://example.test@save",
    "__runtimekit_controller",
  ]);
  assert.deepEqual(removedCaches, ["https://example.test@assets"]);
  assert.equal(local.getItem("atlas.settings"), "prefs");
  assert.equal(local.getItem("atlas.chats"), "chats");
  assert.equal(local.getItem("atlas.nodeSession"), "assignment");
  assert.equal(local.getItem("https://example.test@save"), null);
  assert.equal(local.getItem("example.test@old"), null);
  assert.equal(session.getItem("atlas.tab"), "tab");
  assert.equal(session.getItem("https://example.test@session"), null);
  assert.equal(messages.at(-1).type, "cleared");
});
