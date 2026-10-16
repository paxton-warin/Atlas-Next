import { test, expect, type Page, type Frame } from "@playwright/test";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import ts from "typescript";

let origin: string;
const server = Fastify({ logger: false });
test.beforeAll(async () => {
  const source = readFileSync(
    process.env.ATLAS_IDB_SOURCE_PATH ||
      new URL("../runtime/sandbox-idb.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  server.get("/sandbox-idb.js", (_request, reply) =>
    reply
      .header("Access-Control-Allow-Origin", "*")
      .type("application/javascript")
      .send(compiled),
  );
  server.get("/", (_request, reply) =>
    reply
      .type("text/html")
      .send("<!doctype html><title>Trusted controller</title>"),
  );
  server.get("/frame", (_request, reply) =>
    reply
      .header(
        "Content-Security-Policy",
        "sandbox allow-scripts; script-src 'unsafe-inline' 'self';",
      )
      .type("text/html")
      .send(
        `<!doctype html><script type="module">import {createSandboxIndexedDB} from '/sandbox-idb.js'; window.idbReady=true; addEventListener('message',event=>{if(event.source!==parent||event.data.type!=='idb-bind')return;window.idb=createSandboxIndexedDB(event.ports[0],event.data.documentId);window.idbBound=true;});</script>`,
      ),
  );
  origin = await server.listen({ host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => server.close());
async function bind(
  page: Page,
  website = "https://idb.fixture.example/",
  timeoutMs?: number,
  limits?: Record<string, number>,
): Promise<Frame> {
  await page.goto(origin);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.src = "/frame";
    document.body.append(frame);
  });
  const frame = await expect
    .poll(() =>
      page
        .frames()
        .find((frame) => frame.url().endsWith("/frame"))
        ?.url(),
    )
    .toBe(origin + "/frame")
    .then(() => page.frames().find((frame) => frame.url().endsWith("/frame"))!);
  await frame.waitForFunction(() => (window as any).idbReady);
  await page.evaluate(
    async ({ website, timeoutMs, limits }) => {
      const { bindSandboxIndexedDB } = await import("/sandbox-idb.js");
      const channel = new MessageChannel();
      (window as any).idbBinding = bindSandboxIndexedDB({
        port: channel.port1,
        documentId: "document-idb-fixture",
        website,
        frontendOrigin: location.origin,
        factory: indexedDB,
        timeoutMs,
        limits,
      });
      document
        .querySelector("iframe")!
        .contentWindow!.postMessage(
          { type: "idb-bind", documentId: "document-idb-fixture" },
          "*",
          [channel.port2],
        );
    },
    { website, timeoutMs, limits },
  );
  await frame.waitForFunction(() => (window as any).idbBound);
  return frame;
}

test("real native commit survives controller reload; callback chains and Blob values preserve order", async ({
  page,
}) => {
  let frame = await bind(page);
  const result = await frame.evaluate(async () => {
    const events: string[] = [];
    const idb = (window as any).idb;
    const db: any = await new Promise((resolve, reject) => {
      const open = idb.open("records", 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore("records", {
          keyPath: "id",
        });
        store.createIndex("byName", "name", { unique: true });
        store.put({
          id: 1,
          name: "first",
          blob: new Blob(["saved bytes"], { type: "text/plain" }),
        });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction("records", "readwrite"),
      store = tx.objectStore("records");
    const get = store.get(1);
    get.onsuccess = () => {
      events.push("get");
      store.put({ id: 2, name: "second", blob: get.result.blob }).onsuccess =
        () => {
          events.push("put");
          store.get(2).onsuccess = (event: any) => {
            events.push("read-after-put");
            (window as any).value = event.target.result;
          };
        };
    };
    tx.oncomplete = () => events.push("complete");
    await tx.done;
    return {
      events,
      blob: await (window as any).value.blob.text(),
      names: [...db.objectStoreNames],
      cmp: idb.cmp([1, "a"], [1, "b"]),
    };
  });
  expect(result).toEqual({
    events: ["get", "put", "read-after-put", "complete"],
    blob: "saved bytes",
    names: ["records"],
    cmp: -1,
  });
  frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const request = idb.open("records");
        request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction("records");
      const get = tx.objectStore("records").get(2);
      const value: any = await new Promise(
        (resolve) => (get.onsuccess = () => resolve(get.result)),
      );
      await tx.done;
      return { name: value.name, blob: await value.blob.text() };
    }),
  ).toEqual({ name: "second", blob: "saved bytes" });
});

test("cursor continue, update, delete and key ranges stay in one native transaction", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const request = idb.open("cursor", 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("values");
          store.put("one", 1);
          store.put("two", 2);
          store.put("three", 3);
        };
        request.onsuccess = () => resolve(request.result);
      });
      const seen: any[] = [];
      const tx = db.transaction("values", "readwrite");
      const cursor = tx
        .objectStore("values")
        .openCursor(IDBKeyRange.lowerBound(1));
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (!value) return;
        seen.push([value.key, value.value]);
        if (value.key === 1) value.update("ONE");
        if (value.key === 2) value.delete();
        value.continue();
      };
      await tx.done;
      const read = db.transaction("values");
      const get = read.objectStore("values").getAll();
      const values = await new Promise(
        (resolve) => (get.onsuccess = () => resolve(get.result)),
      );
      await read.done;
      return { seen, values };
    }),
  ).toEqual({
    seen: [
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ],
    values: ["ONE", "three"],
  });
});

test("preventDefault preserves native transaction; unhandled constraint error atomically aborts", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const request = idb.open("constraints", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("values");
        request.onsuccess = () => resolve(request.result);
      });
      const first = db.transaction("values", "readwrite");
      first.objectStore("values").add("retained", 1);
      const duplicate = first.objectStore("values").add("duplicate", 1);
      duplicate.onerror = (event: any) => event.preventDefault();
      await first.done;
      const second = db.transaction("values", "readwrite");
      second.objectStore("values").put("must rollback", 2);
      second.objectStore("values").add("bad", 1);
      let error = "";
      try {
        await second.done;
      } catch (failure) {
        error = (failure as Error).name;
      }
      const read = db.transaction("values");
      const get = read.objectStore("values").getAll();
      const values = await new Promise(
        (resolve) => (get.onsuccess = () => resolve(get.result)),
      );
      await read.done;
      return { error, values };
    }),
  ).toEqual({ error: "ConstraintError", values: ["retained"] });
});

test("blocked upgrade waits for prior connection; versionchange closes and upgrades schema", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const first: any = await new Promise((resolve) => {
        const open = idb.open("upgrade", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("old");
        open.onsuccess = () => resolve(open.result);
      });
      const events: string[] = [];
      first.onversionchange = (event: any) => {
        events.push(
          "versionchange:" + event.oldVersion + ":" + event.newVersion,
        );
      };
      const open = idb.open("upgrade", 2);
      open.onblocked = () => {
        events.push("blocked");
        first.close();
      };
      open.onupgradeneeded = () => {
        events.push("upgrade");
        open.result.deleteObjectStore("old");
        open.result.createObjectStore("new");
      };
      const second: any = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      return {
        events,
        names: [...second.objectStoreNames],
        version: second.version,
      };
    }),
  ).toEqual({
    events: ["versionchange:1:2", "blocked", "upgrade"],
    names: ["new"],
    version: 2,
  });
});

test("document-bound origin isolates database names and native frontend data", async ({
  page,
}) => {
  let frame = await bind(page, "https://one.idb.example");
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.open("frontend-secret", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("private");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
  });
  expect(
    await frame.evaluate(async () => {
      let native = "";
      try {
        indexedDB.open("frontend-secret");
      } catch (error) {
        native = (error as Error).name;
      }
      const idb = (window as any).idb;
      await new Promise((resolve) => {
        const request = idb.open("same-name", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("one");
        request.onsuccess = () => resolve(request.result);
      });
      return { native, databases: await idb.databases() };
    }),
  ).toEqual({
    native: "SecurityError",
    databases: [{ name: "same-name", version: 1 }],
  });
  frame = await bind(page, "https://two.idb.example");
  expect(await frame.evaluate(() => (window as any).idb.databases())).toEqual(
    [],
  );
});

test("explicit commit acknowledges persistence and rejects post-commit operations", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const request = idb.open("commit", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("values");
        request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction("values", "readwrite");
      tx.objectStore("values").put("committed", 1);
      tx.commit();
      await tx.done;
      let status = "";
      try {
        tx.objectStore("values").put("late", 2);
      } catch (error) {
        status = (error as Error).name;
      }
      return status;
    }),
  ).toBe("InvalidStateError");
});

test("request callback microtasks stay active, unrelated timer task cannot issue new requests", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const open = idb.open("task", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("values");
        open.onsuccess = () => resolve(open.result);
      });
      const tx = db.transaction("values", "readwrite");
      const store = tx.objectStore("values");
      let microtask = false;
      store.put("a", 1).onsuccess = () => {
        Promise.resolve().then(() => {
          store.put("b", 2);
          microtask = true;
        });
      };
      await tx.done;
      const later = db.transaction("values", "readwrite");
      const laterStore = later.objectStore("values");
      const error = await new Promise((resolve) =>
        setTimeout(() => {
          try {
            laterStore.put("bad", 3);
            resolve("unexpected request");
          } catch (error) {
            resolve((error as Error).name);
          }
        }, 20),
      );
      await later.done;
      return { microtask, error };
    }),
  ).toEqual({ microtask: true, error: "TransactionInactiveError" });
});

test("aborted upgrade schema is rolled back and synchronous structuredClone errors leave transaction usable", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const first: any = await new Promise((resolve) => {
        const open = idb.open("abort-upgrade", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("retained");
        open.onsuccess = () => resolve(open.result);
      });
      first.close();
      const failed = await new Promise((resolve) => {
        const open = idb.open("abort-upgrade", 2);
        open.onupgradeneeded = () => {
          open.result.deleteObjectStore("retained");
          open.result.createObjectStore("rollback");
          open.transaction.abort();
        };
        open.onerror = () => resolve(open.error.name);
      });
      const db: any = await new Promise((resolve) => {
        const open = idb.open("abort-upgrade");
        open.onsuccess = () => resolve(open.result);
      });
      const tx = db.transaction("retained", "readwrite");
      let clone = "";
      try {
        tx.objectStore("retained").put(() => {}, 1);
      } catch (error) {
        clone = (error as Error).name;
      }
      tx.objectStore("retained").put("good", 2);
      await tx.done;
      return {
        failed,
        names: [...db.objectStoreNames],
        version: db.version,
        clone,
      };
    }),
  ).toEqual({
    failed: "AbortError",
    names: ["retained"],
    version: 1,
    clone: "DataCloneError",
  });
});

test("broker liveness bound aborts an unacknowledged upgrade rather than holding native database lock forever", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const { bindSandboxIndexedDB } = await import("/sandbox-idb.js");
      const channel = new MessageChannel();
      const messages: any[] = [];
      const binding = bindSandboxIndexedDB({
        port: channel.port1,
        documentId: "stalled-document",
        website: "https://stalled.idb.example/",
        frontendOrigin: location.origin,
        factory: indexedDB,
        timeoutMs: 75,
      });
      channel.port2.onmessage = (event) => messages.push(event.data);
      channel.port2.start();
      channel.port2.postMessage({
        protocol: "atlas-idb-v1",
        documentId: "stalled-document",
        sequence: 1,
        type: "open",
        name: "stalled",
        request: 1,
        version: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      binding.dispose();
      channel.port2.close();
      return messages.map((message) => [
        message.type,
        message.error?.name || null,
      ]);
    }),
  ).toContainEqual(["abort", "AbortError"]);
});

test("forged origin and replayed sequence never select a different website namespace", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const { bindSandboxIndexedDB } = await import("/sandbox-idb.js");
      const channel = new MessageChannel();
      const messages: any[] = [];
      const binding = bindSandboxIndexedDB({
        port: channel.port1,
        documentId: "bound-document",
        website: "https://bound.idb.example/",
        frontendOrigin: location.origin,
        factory: indexedDB,
      });
      channel.port2.onmessage = (event) => messages.push(event.data);
      channel.port2.start();
      channel.port2.postMessage({
        protocol: "atlas-idb-v1",
        documentId: "bound-document",
        sequence: 1,
        type: "open",
        origin: "https://victim.idb.example",
        name: "secret",
        request: 1,
      });
      channel.port2.postMessage({
        protocol: "atlas-idb-v1",
        documentId: "wrong-document",
        sequence: 1,
        type: "databases",
        request: 2,
      });
      channel.port2.postMessage({
        protocol: "atlas-idb-v1",
        documentId: "bound-document",
        sequence: 1,
        type: "databases",
        request: 3,
      });
      channel.port2.postMessage({
        protocol: "atlas-idb-v1",
        documentId: "bound-document",
        sequence: 1,
        type: "databases",
        request: 4,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      binding.dispose();
      channel.port2.close();
      return messages.map((message) =>
        message.type === "result" ? message.value : message.error.name,
      );
    }),
  ).toEqual(["SecurityError", "SecurityError", "SecurityError", []]);
});

test("opaque website gets custom IDB prototypes and native-compatible request/cursor brands", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const { installSandboxIndexedDB } = await import("/sandbox-idb.js");
      const facade = (window as any).idb;
      installSandboxIndexedDB(window, facade);
      const illegal: string[] = [];
      for (const name of [
        "IDBFactory",
        "IDBRequest",
        "IDBOpenDBRequest",
        "IDBDatabase",
        "IDBTransaction",
        "IDBObjectStore",
        "IDBIndex",
        "IDBCursor",
        "IDBCursorWithValue",
      ])
        try {
          new (window as any)[name]();
        } catch (error) {
          illegal.push((error as Error).name);
        }
      const request = indexedDB.open("brands", 1);
      const openBrands = [
        request instanceof IDBOpenDBRequest,
        request instanceof IDBRequest,
        indexedDB instanceof IDBFactory,
        Object.prototype.toString.call(request),
      ];
      const db = await new Promise<any>((resolve) => {
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("values");
          store.createIndex("index", "x");
          store.put({ x: 1 }, 1);
        };
        request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction("values"),
        store = tx.objectStore("values"),
        index = store.index("index");
      const cursor = store.openCursor();
      const value: any = await new Promise(
        (resolve) => (cursor.onsuccess = () => resolve(cursor.result)),
      );
      const valueBrand = [
        value instanceof IDBCursor,
        value instanceof IDBCursorWithValue,
        store instanceof IDBObjectStore,
        index instanceof IDBIndex,
        index instanceof IDBObjectStore,
        "put" in index,
      ];
      await tx.done;
      return {
        illegal,
        openBrands,
        valueBrand,
        tag: Object.prototype.toString.call(db),
        factoriesEqual: (window as any).idb === indexedDB,
      };
    }),
  ).toEqual({
    illegal: Array(9).fill("TypeError"),
    openBrands: [true, true, true, "[object IDBOpenDBRequest]"],
    valueBrand: [true, true, true, true, false, false],
    tag: "[object IDBDatabase]",
    factoriesEqual: true,
  });
});

test("store/index rename shares metadata and native committed schema; aborted rename restores original schema", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      let store: any, index: any;
      const db: any = await new Promise((resolve) => {
        const open = idb.open("rename", 1);
        open.onupgradeneeded = () => {
          store = open.result.createObjectStore("before", { keyPath: "id" });
          index = store.createIndex("oldIndex", "name");
          store.put({ id: 1, name: "one" });
          store.name = "after";
          index.name = "newIndex";
          index.get("one").onsuccess = () => {};
        };
        open.onsuccess = () => resolve(open.result);
      });
      const committed = {
        names: [...db.objectStoreNames],
        storeName: store.name,
        indexName: index.name,
        indexes: [...store.indexNames],
      };
      db.close();
      await new Promise((resolve) => {
        const open = idb.open("rename", 2);
        open.onupgradeneeded = () => {
          open.transaction.objectStore("after").name = "rolledback";
          open.transaction.abort();
        };
        open.onerror = () => resolve(null);
      });
      const reopened: any = await new Promise((resolve) => {
        const open = idb.open("rename");
        open.onsuccess = () => resolve(open.result);
      });
      return {
        committed,
        afterAbort: [...reopened.objectStoreNames],
        version: reopened.version,
      };
    }),
  ).toEqual({
    committed: {
      names: ["after"],
      storeName: "after",
      indexName: "newIndex",
      indexes: ["newIndex"],
    },
    afterAbort: ["after"],
    version: 1,
  });
});

test("WebIDL/key/schema errors are synchronous and preserve a usable native transaction", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb,
        errors: any = {};
      const check = (name: string, callback: () => any) => {
        try {
          callback();
          errors[name] = "unexpected";
        } catch (error) {
          errors[name] = (error as Error).name;
        }
      };
      check("openMissing", () => idb.open());
      check("openZero", () => idb.open("a", 0));
      check("openNegative", () => idb.open("a", -1));
      check("openSymbol", () => idb.open(Symbol()));
      const db: any = await new Promise((resolve) => {
        const open = idb.open("sync-errors", 1.9);
        open.onupgradeneeded = () => {
          const db = open.result;
          check("badPath", () =>
            db.createObjectStore("bad", { keyPath: "foo..bar" }),
          );
          check("compoundAuto", () =>
            db.createObjectStore("bad", {
              keyPath: ["x"],
              autoIncrement: true,
            }),
          );
          const store = db.createObjectStore("inline", { keyPath: "id" });
          check("multiEntry", () =>
            store.createIndex("bad", ["x"], { multiEntry: true }),
          );
          db.createObjectStore("out");
        };
        open.onsuccess = () => resolve(open.result);
      });
      check("mode", () => db.transaction("inline", "invalid"));
      check("empty", () => db.transaction([]));
      check("missingStore", () => db.transaction("missing"));
      const tx = db.transaction(["inline", "out"], "readwrite"),
        store = tx.objectStore("inline"),
        out = tx.objectStore("out");
      check("inlineSeparate", () => store.put({ id: 1 }, 1));
      check("missingInline", () => store.put({}));
      check("missingOut", () => out.put("x"));
      check("badKey", () => out.get(NaN));
      check("missingGet", () => out.get());
      check("count", () => out.getAll(null, -1));
      check("direction", () => out.openCursor(null, "bad"));
      check("clone", () => out.put(() => {}, 1));
      store.put({ id: 1 });
      out.put("good", 1);
      await tx.done;
      return errors;
    }),
  ).toEqual({
    openMissing: "TypeError",
    openZero: "TypeError",
    openNegative: "TypeError",
    openSymbol: "TypeError",
    badPath: "SyntaxError",
    compoundAuto: "InvalidAccessError",
    multiEntry: "InvalidAccessError",
    mode: "TypeError",
    empty: "InvalidAccessError",
    missingStore: "NotFoundError",
    inlineSeparate: "DataError",
    missingInline: "DataError",
    missingOut: "DataError",
    badKey: "DataError",
    missingGet: "TypeError",
    count: "TypeError",
    direction: "TypeError",
    clone: "DataCloneError",
  });
});

test("error bubbles preserve request target/currentTarget, stopPropagation and onerror listener order", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const open = idb.open("events", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("values");
        open.onsuccess = () => resolve(open.result);
      });
      const events: any[] = [];
      const tx = db.transaction("values", "readwrite"),
        store = tx.objectStore("values");
      store.add("a", 1);
      const request = store.add("b", 1);
      request.onerror = (event: any) =>
        events.push([
          "onerror",
          event.target === request,
          event.currentTarget === request,
          event.eventPhase,
        ]);
      request.addEventListener("error", (event: any) =>
        events.push([
          "listener",
          event.target === request,
          event.currentTarget === request,
          event.eventPhase,
        ]),
      );
      tx.onerror = (event: any) => {
        events.push([
          "transaction",
          event.target === request,
          event.currentTarget === tx,
          event.eventPhase,
        ]);
        event.preventDefault();
      };
      db.onerror = (event: any) =>
        events.push([
          "database",
          event.target === request,
          event.currentTarget === db,
          event.defaultPrevented,
        ]);
      await tx.done;
      const stop = db.transaction("values", "readwrite"),
        error = stop.objectStore("values").add("duplicate", 1);
      error.onerror = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
      };
      stop.onerror = () => events.push(["unexpected"]);
      await stop.done;
      return events;
    }),
  ).toEqual([
    ["onerror", true, true, 2],
    ["listener", true, true, 2],
    ["transaction", true, true, 3],
    ["database", true, true, true],
  ]);
});

test("cursor identity, continuePrimaryKey, key-only brands and synchronous advancement errors match native behavior", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const { installSandboxIndexedDB } = await import("/sandbox-idb.js");
      installSandboxIndexedDB(window, (window as any).idb);
      const db: any = await new Promise((resolve) => {
        const open = indexedDB.open("advanced-cursor", 1);
        open.onupgradeneeded = () => {
          const store = open.result.createObjectStore("values", {
            keyPath: "id",
          });
          store.createIndex("group", "group");
          for (const id of [1, 2, 3, 4])
            store.put({ id, group: id === 4 ? 2 : 1 });
        };
        open.onsuccess = () => resolve(open.result);
      });
      const tx = db.transaction("values"),
        request = tx.objectStore("values").index("group").openCursor();
      const seen: any[] = [],
        errors: string[] = [],
        objects: any[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        seen.push([cursor.key, cursor.primaryKey]);
        objects.push(cursor);
        if (cursor.primaryKey === 1) {
          try {
            cursor.continue(1);
          } catch (error) {
            errors.push((error as Error).name);
          }
          try {
            cursor.advance(0);
          } catch (error) {
            errors.push((error as Error).name);
          }
          cursor.continuePrimaryKey(1, 3);
        } else cursor.continue();
      };
      await tx.done;
      const keys = db.transaction("values"),
        keyRequest = keys.objectStore("values").openKeyCursor();
      const keyCursor: any = await new Promise(
        (resolve) => (keyRequest.onsuccess = () => resolve(keyRequest.result)),
      );
      const keyBrands = [
        keyCursor instanceof IDBCursor,
        keyCursor instanceof IDBCursorWithValue,
        "value" in keyCursor,
      ];
      await keys.done;
      return {
        seen,
        errors,
        sameCursor: objects.every((value) => value === objects[0]),
        keyBrands,
      };
    }),
  ).toEqual({
    seen: [
      [1, 1],
      [1, 3],
      [2, 4],
    ],
    errors: ["DataError", "TypeError"],
    sameCursor: true,
    keyBrands: [true, false, false],
  });
});

test("unhandled success-handler exceptions abort all native writes and are reported to the website realm", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const failures: string[] = [];
      addEventListener("error", (event) => {
        failures.push(event.message);
        event.preventDefault();
      });
      const idb = (window as any).idb;
      const db: any = await new Promise((resolve) => {
        const open = idb.open("handler-error", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("values");
        open.onsuccess = () => resolve(open.result);
      });
      const tx = db.transaction("values", "readwrite");
      tx.objectStore("values").put("must rollback", 1).onsuccess = () => {
        throw Error("fixture-handler-error");
      };
      let aborted = "";
      try {
        await tx.done;
      } catch (error) {
        aborted = (error as Error).name;
      }
      const read = db.transaction("values");
      const count = read.objectStore("values").count();
      const value = await new Promise(
        (resolve) => (count.onsuccess = () => resolve(count.result)),
      );
      await read.done;
      return {
        aborted,
        value,
        reported: failures.some((message) =>
          message.includes("fixture-handler-error"),
        ),
      };
    }),
  ).toEqual({ aborted: "AbortError", value: 0, reported: true });
});

test("separate document ports serialize native transactions for the same website without lost updates", async ({
  page,
  context,
}) => {
  const first = await bind(page);
  const secondPage = await context.newPage();
  const second = await bind(secondPage);
  const initialize = async (frame: Frame) =>
    frame.evaluate(async () => {
      const idb = (window as any).idb;
      (window as any).shared = await new Promise((resolve) => {
        const open = idb.open("shared", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("counter");
        open.onsuccess = () => resolve(open.result);
      });
    });
  await Promise.all([initialize(first), initialize(second)]);
  const increment = (frame: Frame) =>
    frame.evaluate(async () => {
      const tx = (window as any).shared.transaction("counter", "readwrite"),
        store = tx.objectStore("counter"),
        get = store.get("count");
      get.onsuccess = () => store.put((get.result || 0) + 1, "count");
      await tx.done;
    });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      increment(index % 2 ? first : second),
    ),
  );
  expect(
    await first.evaluate(async () => {
      const tx = (window as any).shared.transaction("counter"),
        get = tx.objectStore("counter").get("count");
      const result = await new Promise(
        (resolve) => (get.onsuccess = () => resolve(get.result)),
      );
      await tx.done;
      return result;
    }),
  ).toBe(20);
  await secondPage.close();
});

test("zero-delay timer tasks cannot extend transactions, and pending result/error getters throw synchronously", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const open = idb.open("task-boundary", 1);
      const pending: string[] = [];
      for (const field of ["result", "error"])
        try {
          open[field];
        } catch (error) {
          pending.push((error as Error).name);
        }
      const db: any = await new Promise((resolve) => {
        open.onupgradeneeded = () => open.result.createObjectStore("values");
        open.onsuccess = () => resolve(open.result);
      });
      const statuses: string[] = [];
      for (let index = 0; index < 20; index++) {
        const tx = db.transaction("values", "readwrite"),
          store = tx.objectStore("values");
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            try {
              store.put("late", index);
              statuses.push("unexpected");
            } catch (error) {
              statuses.push((error as Error).name);
            }
            resolve();
          }, 0),
        );
        await tx.done;
      }
      let readonly = false;
      try {
        db.name = "forged";
      } catch {
        readonly = true;
      }
      return { pending, statuses, readonly, name: db.name };
    }),
  ).toEqual({
    pending: ["InvalidStateError", "InvalidStateError"],
    statuses: Array(20).fill("TransactionInactiveError"),
    readonly: false,
    name: "task-boundary",
  });
});

test("synchronous argument validation parity matrix matches this Chrome native IndexedDB", async ({
  page,
}) => {
  const frame = await bind(page);
  const matrix = async (facade: boolean) => {
    const factory = facade ? (window as any).idb : indexedDB,
      result: any = {};
    const record = (name: string, operation: () => any) => {
      try {
        const request = operation();
        if (request && "onerror" in request)
          request.onerror = (event: any) => event.preventDefault();
        result[name] = "ok";
      } catch (error) {
        result[name] = (error as Error).name;
      }
    };
    for (const [name, version] of [
      ["zero", 0],
      ["negative", -1],
      ["nan", NaN],
      ["infinite", Infinity],
    ] as const)
      record("version:" + name, () => factory.open("invalid", version));
    const db: any = await new Promise((resolve, reject) => {
      const open = factory.open("matrix", 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        record("create:badpath", () =>
          db.createObjectStore("bad", { keyPath: "x..y" }),
        );
        record("create:numberoptions", () =>
          db.createObjectStore("bad-options", 5),
        );
        record("create:array-auto", () =>
          db.createObjectStore("array-auto", {
            keyPath: ["x"],
            autoIncrement: true,
          }),
        );
        record("create:empty-auto", () =>
          db.createObjectStore("empty-auto", {
            keyPath: "",
            autoIncrement: true,
          }),
        );
        const out = db.createObjectStore("out");
        db.createObjectStore("inline", { keyPath: "id" });
        record("index:array-multi", () =>
          out.createIndex("bad", ["x"], { multiEntry: true }),
        );
        record("index:numberoptions", () =>
          out.createIndex("bad-options", "x", 5),
        );
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    record("transaction:empty", () => db.transaction([]));
    record("transaction:null", () => db.transaction(null));
    record("transaction:mode", () => db.transaction("out", "bad"));
    record("transaction:durability", () =>
      db.transaction("out", "readonly", { durability: "bad" }),
    );
    record("transaction:numberoptions", () =>
      db.transaction("out", "readonly", 5),
    );
    const tx = db.transaction(["out", "inline"], "readwrite"),
      done = new Promise((resolve) => (tx.oncomplete = resolve)),
      out = tx.objectStore("out"),
      inline = tx.objectStore("inline");
    for (const [name, callback] of Object.entries({
      getMissing: () => out.get(),
      getNull: () => out.get(null),
      getUndefined: () => out.get(undefined),
      getNaN: () => out.get(NaN),
      getObject: () => out.get({}),
      getAllOptions: () => out.getAll({ query: 1 }),
      getAllNegative: () => out.getAll(null, -1),
      getAllOverflow: () => out.getAll(null, 2 ** 32),
      getAllZero: () => out.getAll(null, 0),
      cursorDirection: () => out.openCursor(null, "bad"),
      putMissing: () => out.put(),
      putOutMissingKey: () => out.put("a"),
      putBadKey: () => out.put("a", {}),
      putClone: () => out.put(() => {}, 1),
      putInlineMissingKey: () => inline.put({}),
      putInlineSeparate: () => inline.put({ id: 1 }, 1),
    }))
      record("operation:" + name, callback);
    await done;
    return result;
  };
  const native = await page.evaluate(matrix, false),
    facade = await frame.evaluate(matrix, true);
  expect(facade).toEqual(native);
});

test("modern getAll/getAllKeys/getAllRecords options retain ranges, reverse ordering, count and arbitrary marker-shaped stored values", async ({
  page,
}) => {
  page.on("pageerror", (error) => console.log("IDB_PAGE_ERROR", error.message));
  const frame = await bind(page);
  const run = async (facade: boolean) => {
    const factory = facade ? (window as any).idb : indexedDB;
    const db: any = await new Promise((resolve) => {
      const open = factory.open("all-records", 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore("values");
        for (const id of [1, 2, 3])
          store.put({ __atlasKeyRange: 1, lower: id, value: "v" + id }, id);
      };
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction("values"),
      store = tx.objectStore("values"),
      done = new Promise((resolve) => (tx.oncomplete = resolve)),
      options = { query: IDBKeyRange.bound(1, 3), count: 2, direction: "prev" };
    const result = await Promise.all(
      [
        store.getAll(options),
        store.getAllKeys(options),
        store.getAllRecords(options),
        store.get(2),
      ].map(
        (request) =>
          new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event: any) => {
              event.preventDefault();
              reject(Error(request.error.name + ":" + request.error.message));
            };
          }),
      ),
    );
    await done;
    result[2] = (result[2] as any[]).map((record) => ({
      key: record.key,
      primaryKey: record.primaryKey,
      value: record.value,
    }));
    return result;
  };
  const native = await page.evaluate(run, false);
  expect(await frame.evaluate(run, true)).toEqual(native);
});

test("facade constructors reject borrowed getter and factory calls rather than accepting forged brands", async ({
  page,
}) => {
  const frame = await bind(page);
  expect(
    await frame.evaluate(async () => {
      const facade = (window as any).idb,
        types = facade.constructors,
        errors: string[] = [];
      for (const [name, field] of [
        ["IDBRequest", "result"],
        ["IDBRequest", "error"],
        ["IDBRequest", "readyState"],
        ["IDBDatabase", "name"],
        ["IDBDatabase", "version"],
        ["IDBCursor", "key"],
      ])
        try {
          Object.getOwnPropertyDescriptor(
            types[name].prototype,
            field,
          )!.get!.call({});
          errors.push("unexpected");
        } catch (error) {
          errors.push((error as Error).name);
        }
      try {
        types.IDBFactory.prototype.open.call({}, "forged");
      } catch (error) {
        errors.push((error as Error).name);
      }
      return errors;
    }),
  ).toEqual(Array(7).fill("TypeError"));
});

test("atomic quota ledger counts Blob writes and cursor mutations; rejection preserves committed and frontend data", async ({
  page,
}) => {
  const website = "https://quota.idb.example/";
  const frame = await bind(page, website, undefined, {
    quotaBytes: 8192,
    maxDatabases: 2,
  });
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("frontend-unrelated");
      open.onupgradeneeded = () => open.result.createObjectStore("private");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction("private", "readwrite");
    tx.objectStore("private").put("retained", "secret");
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  const result = await frame.evaluate(async () => {
    const idb = (window as any).idb;
    const db: any = await new Promise((resolve, reject) => {
      const open = idb.open("durable", 1);
      open.onupgradeneeded = () =>
        open.result
          .createObjectStore("records")
          .put({ blob: new Blob(["x".repeat(1000)]), marker: "saved" }, 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const over = db.transaction("records", "readwrite");
    const overResult = over.done.then(
      () => "committed",
      (e: any) => e.name,
    );
    over.objectStore("records").put({ blob: new Blob(["x".repeat(3000)]) }, 2);
    const rejected = await overResult;
    const read = db.transaction("records"),
      request = read.objectStore("records").getAll();
    const values = await new Promise<any[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await read.done;
    const cursorTx = db.transaction("records", "readwrite"),
      cursorResult = cursorTx.done.then(
        () => "committed",
        (e: any) => e.name,
      );
    cursorTx.objectStore("records").openCursor().onsuccess = (e: any) =>
      e.target.result?.update({ blob: new Blob(["x".repeat(4000)]) });
    const cursorRejected = await cursorResult;
    const remove = db.transaction("records", "readwrite");
    remove.objectStore("records").openCursor().onsuccess = (e: any) =>
      e.target.result?.delete();
    await remove.done;
    const reuse = db.transaction("records", "readwrite");
    reuse.objectStore("records").put({ blob: new Blob(["y".repeat(2500)]) }, 3);
    await reuse.done;
    const clear = db.transaction("records", "readwrite");
    clear.objectStore("records").clear();
    await clear.done;
    db.close();
    return {
      rejected,
      cursorRejected,
      savedCount: values.length,
      savedMarker: values[0].marker,
      savedBlob: values[0].blob.size,
      allowance: db.storageAllowance,
    };
  });
  expect(result).toEqual({
    rejected: "QuotaExceededError",
    cursorRejected: "QuotaExceededError",
    savedCount: 1,
    savedMarker: "saved",
    savedBlob: 1000,
    allowance: { quotaBytes: 8192, sliceBytes: 4096, maxDatabases: 2 },
  });
  expect(
    await page.evaluate(async () => {
      const read = async (name: string, store: string, key: string) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const open = indexedDB.open(name);
          open.onsuccess = () => resolve(open.result);
        });
        const request = db.transaction(store).objectStore(store).get(key);
        const result = await new Promise<any>(
          (resolve) => (request.onsuccess = () => resolve(request.result)),
        );
        db.close();
        return result;
      };
      const prefix =
        "atlas.browsing.idb.v2:" +
        encodeURIComponent("https://quota.idb.example") +
        ":";
      return {
        frontend: await read("frontend-unrelated", "private", "secret"),
        usage: await read(
          prefix + "durable",
          "__atlas_idb_keepalive_v2__",
          "usage",
        ),
      };
    }),
  ).toEqual({
    frontend: "retained",
    usage: { bytes: 278, sliceBytes: 4096, records: 0, indexEntries: 0 },
  });
});

test("index creation quota abort rolls back the whole native upgrade, including schema and version", async ({
  page,
}) => {
  const frame = await bind(
    page,
    "https://index-quota.idb.example/",
    undefined,
    { quotaBytes: 8192, maxDatabases: 1 },
  );
  expect(
    await frame.evaluate(async () => {
      const idb = (window as any).idb;
      const openDB = (version: number, upgrade: (db: any) => void) =>
        new Promise<any>((resolve, reject) => {
          const open = idb.open("index-size", version);
          open.onupgradeneeded = () => upgrade(open.result);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
      let db = await openDB(1, (db) =>
        db.createObjectStore("records").put(
          {
            blob: new Blob(["x".repeat(3000)]),
            tags: Array.from({ length: 50 }, (_, i) => "tag-" + i),
          },
          1,
        ),
      );
      db.close();
      const upgraded: any = await new Promise((resolve) => {
        const open = idb.open("index-size", 2);
        open.onupgradeneeded = () =>
          open.transaction
            .objectStore("records")
            .createIndex("byTags", "tags", { multiEntry: true });
        open.onsuccess = () => {
          open.result.close();
          resolve("committed");
        };
        open.onerror = () => resolve(open.error.name);
      });
      db = await new Promise((resolve, reject) => {
        const open = idb.open("index-size");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction("records"),
        store = tx.objectStore("records"),
        request = store.count();
      const count = await new Promise(
        (resolve) => (request.onsuccess = () => resolve(request.result)),
      );
      await tx.done;
      const result = {
        upgraded,
        version: db.version,
        indexes: [...store.indexNames],
        count,
      };
      db.close();
      return result;
    }),
  ).toEqual({
    upgraded: "QuotaExceededError",
    version: 1,
    indexes: [],
    count: 1,
  });
});

test("origin reservation serializes simultaneous opens and delete-recreate races across document ports", async ({
  page,
  context,
}) => {
  const website = "https://reservation.idb.example/",
    limits = { quotaBytes: 8192, maxDatabases: 2 };
  const frame = await bind(page, website, undefined, limits),
    other = await context.newPage();
  const second = await bind(other, website, undefined, limits);
  const open = (frame: Frame, name: string) =>
    frame.evaluate(async (name) => {
      return await new Promise<string>((resolve) => {
        const request = (window as any).idb.open(name);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("records");
        request.onerror = () => resolve(request.error.name);
        request.onsuccess = () => {
          request.result.close();
          resolve("opened");
        };
      });
    }, name);
  expect(
    await Promise.all([
      open(frame, "one"),
      open(second, "two"),
      open(frame, "three"),
    ]),
  ).toEqual(["opened", "opened", "QuotaExceededError"]);
  // Separate native metadata transactions serialize deletion with reopening the
  // same logical name; neither ordering can release an in-use reservation.
  const deleted = frame.evaluate(
    async () =>
      new Promise<string>((resolve) => {
        const request = (window as any).idb.deleteDatabase("one");
        request.onsuccess = () => resolve("deleted");
        request.onerror = () => resolve(request.error.name);
      }),
  );
  expect(await Promise.all([deleted, open(second, "one")])).toEqual([
    "deleted",
    "opened",
  ]);
  expect(await open(frame, "three")).toBe("QuotaExceededError");
  await frame.evaluate(
    async () =>
      new Promise<void>((resolve, reject) => {
        const request = (window as any).idb.deleteDatabase("one");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
  );
  expect(await open(frame, "three")).toBe("opened");
  expect(
    await page.evaluate(async () => {
      const prefix =
        "atlas.browsing.idb.v2:" +
        encodeURIComponent("https://reservation.idb.example") +
        ":";
      const db = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open(prefix + "#quota");
        open.onsuccess = () => resolve(open.result);
      });
      const request = db
        .transaction("databases")
        .objectStore("databases")
        .getAllKeys();
      const keys = await new Promise(
        (resolve) => (request.onsuccess = () => resolve(request.result)),
      );
      db.close();
      return keys;
    }),
  ).toEqual(["three", "two"]);
  await other.close();
});

test("pre-clone payload checks reject huge sparse arrays, Blob bytes, accessors and hidden platform data", async ({
  page,
}) => {
  const frame = await bind(page, "https://payload.idb.example/");
  expect(
    await frame.evaluate(async () => {
      const { boundedIDBValueBytes } = await import("/sandbox-idb.js");
      let getterCalls = 0;
      const accessor = {
        get value() {
          getterCalls++;
          return new Uint8Array(5 * 1024 * 1024);
        },
      };
      const values = [
        new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]),
        Array(2 ** 32 - 1),
        accessor,
        new ImageData(2, 2),
      ];
      const errors = values.map((value) => {
        try {
          boundedIDBValueBytes(value);
          return "accepted";
        } catch (error: any) {
          return error.name;
        }
      });
      const hugeError = new Error("x".repeat(3 * 1024 * 1024));
      try {
        boundedIDBValueBytes(hugeError);
        errors.push("accepted");
      } catch (error: any) {
        errors.push(error.name);
      }
      return { errors, getterCalls };
    }),
  ).toEqual({
    errors: [
      "QuotaExceededError",
      "QuotaExceededError",
      "DataCloneError",
      "DataCloneError",
      "QuotaExceededError",
    ],
    getterCalls: 0,
  });
});

test("document connection, transaction, pending request, queued-byte and payload bounds terminate and release native resources", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const { bindSandboxIndexedDB, createSandboxIndexedDB } = await import(
        "/sandbox-idb.js"
      );
      const results: any[] = [];
      for (const kind of [
        "connection",
        "transaction",
        "pending",
        "queue",
        "payload",
        "dispose",
      ]) {
        const limits =
          kind === "connection"
            ? { maxConnections: 1 }
            : kind === "transaction"
              ? { maxTransactions: 1 }
              : kind === "pending"
                ? { maxPendingRequests: 3 }
                : kind === "queue"
                  ? { maxQueueBytes: 700 }
                  : kind === "payload"
                    ? { maxPayloadBytes: 700 }
                    : {};
        const channel = new MessageChannel(),
          documentId = "bound-" + kind;
        const binding = bindSandboxIndexedDB({
          port: channel.port1,
          documentId,
          website: "https://" + kind + ".bounds.idb.example",
          frontendOrigin: location.origin,
          factory: indexedDB,
          limits,
        });
        const idb = createSandboxIndexedDB(channel.port2, documentId);
        const db: any = await new Promise((resolve, reject) => {
          const open = idb.open("bounded");
          open.onupgradeneeded = () => open.result.createObjectStore("records");
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        let outcome: Promise<string>;
        if (kind === "connection")
          outcome = new Promise((resolve) => {
            const open = idb.open("bounded");
            open.onerror = () => resolve(open.error!.name);
            open.onsuccess = () => resolve("opened");
          });
        else {
          const first = db.transaction("records", "readwrite");
          outcome = first.done.then(
            () => "committed",
            (e: any) => e.name,
          );
          if (kind === "transaction") {
            const second = db.transaction("records", "readwrite");
            second.done.catch(() => {});
          }
          if (kind === "pending")
            for (let i = 0; i < 5; i++)
              first.objectStore("records").put("x", i);
          if (kind === "queue" || kind === "payload")
            first.objectStore("records").put(new Blob(["x".repeat(1000)]), 1);
          if (kind === "dispose") binding.dispose();
        }
        const error = await outcome;
        await new Promise((resolve) => setTimeout(resolve, 25));
        results.push({ kind, error, ...binding.stats });
        idb.dispose();
        binding.dispose();
      }
      return results;
    }),
  ).toEqual(
    ["connection", "transaction", "pending", "queue", "payload", "dispose"].map(
      (kind) => ({
        kind,
        error: kind === "dispose" ? "AbortError" : "QuotaExceededError",
        live: false,
        connections: 0,
        transactions: 0,
        pendingRequests: 0,
        queuedBytes: 0,
        pendingOpens: 0,
        pendingControls: 0,
      }),
    ),
  );
});

test("bounded control requests cannot flood native deletes while a prior connection blocks deletion", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const { bindSandboxIndexedDB, createSandboxIndexedDB } = await import(
        "/sandbox-idb.js"
      );
      const channel = new MessageChannel(),
        documentId = "delete-control-bound";
      const binding = bindSandboxIndexedDB({
        port: channel.port1,
        documentId,
        website: "https://control-bound.idb.example",
        frontendOrigin: location.origin,
        factory: indexedDB,
        limits: { maxPendingRequests: 3 },
      });
      const idb = createSandboxIndexedDB(channel.port2, documentId);
      const db: any = await new Promise((resolve, reject) => {
        const open = idb.open("bounded");
        open.onupgradeneeded = () => open.result.createObjectStore("records");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const outcomes = Array.from(
        { length: 4 },
        () =>
          new Promise<string>((resolve) => {
            const remove = idb.deleteDatabase("bounded");
            remove.onsuccess = () => resolve("deleted");
            remove.onerror = () => resolve(remove.error!.name);
          }),
      );
      const result = await Promise.all(outcomes);
      db.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { result, ...binding.stats };
    }),
  ).toEqual({
    result: [
      "QuotaExceededError",
      "QuotaExceededError",
      "QuotaExceededError",
      "QuotaExceededError",
    ],
    live: false,
    connections: 0,
    transactions: 0,
    pendingRequests: 0,
    queuedBytes: 0,
    pendingOpens: 0,
    pendingControls: 0,
  });
});

test("durable reservation survives disposal exactly after native upgrade commit and blocks orphan quota bypass", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const { bindSandboxIndexedDB, createSandboxIndexedDB } = await import(
        "/sandbox-idb.js"
      );
      const channel = new MessageChannel(),
        documentId = "commit-dispose";
      const options = {
        documentId,
        website: "https://commit-dispose.idb.example",
        frontendOrigin: location.origin,
        factory: indexedDB,
        limits: { quotaBytes: 8192, maxDatabases: 1 },
      };
      const binding = bindSandboxIndexedDB({ port: channel.port1, ...options });
      let sequence = 0;
      const send = (message: any) =>
        channel.port2.postMessage({
          protocol: "atlas-idb-v1",
          documentId,
          sequence: ++sequence,
          ...message,
        });
      await new Promise<void>((resolve) => {
        channel.port2.onmessage = (event) => {
          if (event.data.type === "upgrade") {
            send({
              type: "schema",
              transaction: event.data.transaction,
              action: "createStore",
              store: "records",
            });
            send({
              type: "operation",
              transaction: event.data.transaction,
              request: 2,
              store: "records",
              action: "put",
              args: ["committed", 1],
            });
          }
          if (event.data.type === "result") {
            send({
              type: "ack",
              transaction: event.data.transaction,
              eventId: event.data.eventId,
            });
            send({ type: "fence", transaction: event.data.transaction });
          }
          if (event.data.type === "complete") {
            binding.dispose();
            resolve();
          }
        };
        channel.port2.start();
        send({ type: "open", name: "one", request: 1 });
      });
      const nextChannel = new MessageChannel(),
        next = bindSandboxIndexedDB({ port: nextChannel.port1, ...options });
      const idb = createSandboxIndexedDB(nextChannel.port2, documentId);
      const second = await new Promise<string>((resolve) => {
        const open = idb.open("two");
        open.onerror = () => resolve(open.error!.name);
        open.onsuccess = () => resolve("opened");
      });
      const first: any = await new Promise((resolve, reject) => {
        const open = idb.open("one");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = first.transaction("records"),
        request = tx.objectStore("records").get(1);
      const saved = await new Promise(
        (resolve) => (request.onsuccess = () => resolve(request.result)),
      );
      await tx.done;
      first.close();
      next.dispose();
      idb.dispose();
      return { second, saved };
    }),
  ).toEqual({ second: "QuotaExceededError", saved: "committed" });
});

test("older browser query features are hidden or typed NotSupportedError instead of silently changing query semantics", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const original = Object.getOwnPropertyDescriptor(
        IDBObjectStore.prototype,
        "getAllRecords",
      );
      delete (IDBObjectStore.prototype as any).getAllRecords;
      const { bindSandboxIndexedDB, createSandboxIndexedDB } = await import(
        "/sandbox-idb.js"
      );
      const channel = new MessageChannel(),
        binding = bindSandboxIndexedDB({
          port: channel.port1,
          documentId: "older",
          website: "https://older.idb.example",
          frontendOrigin: location.origin,
          factory: indexedDB,
        });
      const idb = createSandboxIndexedDB(channel.port2, "older");
      const db: any = await new Promise((resolve, reject) => {
        const open = idb.open("older");
        open.onupgradeneeded = () => open.result.createObjectStore("records");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction("records"),
        store = tx.objectStore("records");
      let optionsError = "accepted";
      try {
        store.getAll({ direction: "prev" });
      } catch (e: any) {
        optionsError = e.name;
      }
      const old = store.getAll();
      await new Promise((resolve) => (old.onsuccess = resolve));
      await tx.done;
      const records = typeof store.getAllRecords;
      db.close();
      binding.dispose();
      if (original)
        Object.defineProperty(
          IDBObjectStore.prototype,
          "getAllRecords",
          original,
        );
      return { records, optionsError };
    }),
  ).toEqual({ records: "undefined", optionsError: "NotSupportedError" });
});

test("invalid raw transaction command acknowledges a real native abort and never leaves earlier writes committed", async ({
  page,
}) => {
  await page.goto(origin);
  expect(
    await page.evaluate(async () => {
      const { bindSandboxIndexedDB } = await import("/sandbox-idb.js");
      const channel = new MessageChannel(),
        documentId = "real-abort",
        website = "https://real-abort.idb.example";
      const binding = bindSandboxIndexedDB({
        port: channel.port1,
        documentId,
        website,
        frontendOrigin: location.origin,
        factory: indexedDB,
        timeoutMs: 5000,
      });
      let sequence = 0;
      const send = (m: any) =>
        channel.port2.postMessage({
          protocol: "atlas-idb-v1",
          documentId,
          sequence: ++sequence,
          ...m,
        });
      const messages: any[] = [];
      await new Promise<void>((resolve, reject) => {
        channel.port2.onmessage = ({ data: m }) => {
          messages.push(m);
          if (m.type === "upgrade") {
            send({
              type: "schema",
              transaction: m.transaction,
              action: "createStore",
              store: "records",
            });
            send({
              type: "operation",
              transaction: m.transaction,
              request: 2,
              store: "records",
              action: "put",
              args: ["saved", 1],
            });
          }
          if (m.type === "result" && m.request === 2) {
            send({
              type: "ack",
              transaction: m.transaction,
              eventId: m.eventId,
            });
            send({ type: "fence", transaction: m.transaction });
          }
          if (m.type === "opened") {
            send({
              type: "begin",
              transaction: "tx:3",
              connection: m.connection,
              mode: "readwrite",
              stores: ["records"],
            });
            send({
              type: "operation",
              transaction: "tx:3",
              request: 3,
              store: "records",
              action: "put",
              args: ["must roll back", 1],
            });
          }
          if (m.type === "result" && m.request === 3)
            send({
              type: "schema",
              transaction: "tx:3",
              store: "__atlas_idb_keepalive_v2__",
              action: "deleteStore",
            });
          if (m.type === "abort" && m.transaction === "tx:3") resolve();
          if (m.type === "closed") reject(new Error(m.error.name));
        };
        channel.port2.start();
        send({ type: "open", name: "atomic", request: 1 });
      });
      const name =
        "atlas.browsing.idb.v2:" + encodeURIComponent(website) + ":atomic";
      const saved = await Promise.race([
        new Promise((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onsuccess = () => {
            const db = open.result,
              request = db.transaction("records").objectStore("records").get(1);
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => reject(request.error);
          };
          open.onerror = () => reject(open.error);
        }),
        new Promise((resolve) =>
          setTimeout(
            () => resolve("native lock still held after claimed abort"),
            500,
          ),
        ),
      ]);
      const result = {
        saved,
        abort: messages.find(
          (m) => m.type === "abort" && m.transaction === "tx:3",
        )?.error.name,
        falseComplete: messages.some(
          (m) => m.type === "complete" && m.transaction === "tx:3",
        ),
      };
      binding.dispose();
      return result;
    }),
  ).toEqual({ saved: "saved", abort: "SecurityError", falseComplete: false });
});

test("ACK-drained repeated writes still obey cumulative transaction byte bound and roll back", async ({
  page,
}) => {
  const frame = await bind(page, "https://cumulative.idb.example/", undefined, {
    maxQueueBytes: 2048,
  });
  expect(
    await frame.evaluate(async () => {
      const db: any = await new Promise((resolve, reject) => {
        const open = (window as any).idb.open("bounded");
        open.onupgradeneeded = () =>
          open.result.createObjectStore("records").put("saved", 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction("records", "readwrite"),
        result = tx.done.then(
          () => "committed",
          (error: any) => error.name,
        );
      let writes = 0;
      const write = () => {
        writes++;
        tx
          .objectStore("records")
          .put(new Blob(["x".repeat(100)]), 1).onsuccess = write;
      };
      write();
      const error = await result;
      return { error, bounded: writes < 10 };
    }),
  ).toEqual({ error: "QuotaExceededError", bounded: true });
  expect(
    await page.evaluate(async () => {
      const name =
        "atlas.browsing.idb.v2:" +
        encodeURIComponent("https://cumulative.idb.example") +
        ":bounded";
      const db = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => resolve(open.result);
      });
      const request = db.transaction("records").objectStore("records").get(1),
        result = await new Promise(
          (resolve) => (request.onsuccess = () => resolve(request.result)),
        );
      db.close();
      return result;
    }),
  ).toBe("saved");
});
