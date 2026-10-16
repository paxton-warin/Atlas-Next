#!/usr/bin/env node
/** Real Chromium proof of the inactive marker-only synchronous storage stack. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import { installSandboxStorageRendezvous } from "../server/sandbox-storage-rendezvous.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
const output = resolve(
  process.argv[2] ||
    "evidence/combined-update-20261015/sandbox-storage-browser.json",
);
const executablePath =
  process.env.CHROME_PATH ||
  [
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
if (!executablePath)
  throw Error("Set CHROME_PATH to a local Chromium executable.");
const app = Fastify({ logger: false }),
  site = "https://save.fixture.example",
  peerSite = "https://peer.fixture.example";
let frontend;
const markers = [];
app.addHook("onRequest", (req, _res, done) => {
  if (req.url.startsWith("/browse/storage/commit/"))
    markers.push({
      origin: req.headers.origin,
      cookiePresent: !!req.headers.cookie,
      authorizationPresent: !!req.headers.authorization,
    });
  done();
});
app.addHook("preValidation", (req, _res, done) => {
  if (req.url.startsWith("/browse/storage/commit/"))
    markers.at(-1).bodyKeys = Object.keys(
      typeof req.body === "string" ? JSON.parse(req.body) : req.body,
    );
  done();
});
installSandboxStorageRendezvous(app, {
  originFor: () => frontend,
  authorizeOwner: (req) =>
    req.headers["x-fixture-csrf"] === "fixture-csrf"
      ? { fixture: "trusted" }
      : null,
  validateOwner: () => true,
  timeoutMs: 250,
});
for (const name of [
  "sandbox-storage-worker",
  "sandbox-local-storage",
  "sandbox-vault",
])
  app.get("/" + name + ".js", (_req, reply) =>
    reply
      .header("Access-Control-Allow-Origin", "*")
      .type("application/javascript")
      .send(
        transpileModule(
          readFileSync(resolve("runtime/" + name + ".ts"), "utf8"),
          {
            compilerOptions: {
              target: ScriptTarget.ES2022,
              module: ModuleKind.ESNext,
            },
          },
        ).outputText.replaceAll('.ts"', '.js"'),
      ),
  );
app.get("/child", (_req, reply) =>
  reply
    .header(
      "Content-Security-Policy",
      `sandbox allow-scripts;default-src 'none';script-src ${frontend} 'unsafe-inline';connect-src ${frontend};frame-ancestors 'self';base-uri 'none';form-action 'none'`,
    )
    .type("text/html")
    .send("<!doctype html><title>Opaque storage fixture</title>"),
);
app.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Trusted storage fixture</title>"),
);
await app.listen({ port: 0, host: "127.0.0.1" });
frontend = "http://127.0.0.1:" + app.server.address().port;
const receipt = {
  version: 1,
  command: "node tests/sandbox-storage-browser.mjs",
  recordedAt: new Date().toISOString(),
  localOnly: true,
  productionChanged: false,
  generalRuntimeQualified: false,
  markerBodyOnly: true,
  websiteValuesReachServer: false,
  sources: Object.fromEntries(
    [
      "server/sandbox-storage-rendezvous.mjs",
      "runtime/sandbox-storage-worker.ts",
      "runtime/sandbox-local-storage.ts",
      "runtime/sandbox-vault.ts",
    ].map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
};
let browser;
async function initialize(page) {
  await page.goto(frontend);
  return page.evaluate(async () => {
    const response = await fetch("/api/browse/storage/owners", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fixture-csrf": "fixture-csrf",
      },
      body: "{}",
    });
    const owner = await response.json();
    window.owner = owner;
    window.worker = new Worker("/sandbox-storage-worker.js", {
      type: "module",
    });
    window.workerEvents = [];
    worker.addEventListener("message", (e) => workerEvents.push(e.data));
    const ready = new Promise((resolve, reject) => {
      function receive(e) {
        if (e.data.type === "ready") {
          worker.removeEventListener("message", receive);
          resolve();
        } else if (e.data.type === "error") reject(Error(e.data.error.code));
      }
      worker.addEventListener("message", receive);
      worker.onerror = (e) => reject(Error(e.message));
    });
    worker.postMessage({
      type: "initialize",
      socketURL: location.origin.replace("http:", "ws:") + owner.websocket,
    });
    await ready;
    window.sessionId =
      sessionStorage.getItem("fixture-tab-session") || crypto.randomUUID();
    sessionStorage.setItem("fixture-tab-session", sessionId);
  });
}
async function createChild(page, website = site, quotaBytes = 1024) {
  const id = "doc_" + crypto.randomUUID().replaceAll("-", "");
  const details = await page.evaluate(
    async ({ documentId, website, quotaBytes }) => {
      const response = await fetch("/api/browse/storage/documents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + owner.capability,
        },
        body: JSON.stringify({ documentId }),
      });
      const d = await response.json();
      if (!response.ok) throw Error(JSON.stringify(d));
      const f = document.createElement("iframe");
      f.dataset.documentId = documentId;
      f.sandbox = "allow-scripts";
      f.src = "/child";
      await new Promise((resolve) => {
        f.onload = resolve;
        document.body.append(f);
      });
      return { ...d };
    },
    { documentId: id, website, quotaBytes },
  );
  const frame = page
    .frames()
    .filter((f) => f.parentFrame() === page.mainFrame())
    .at(-1);
  await frame.evaluate(
    async ({ endpoint, documentId, frontend }) => {
      const { createSandboxStorageFacades } = await import(
        frontend + "/sandbox-local-storage.js"
      );
      window.testBinding = new Promise((resolve, reject) => {
        function receive(e) {
          if (e.source !== parent || e.ports.length !== 1) return;
          removeEventListener("message", receive);
          window.documentPort = e.ports[0];
          createSandboxStorageFacades({
            documentId,
            endpoint,
            port: e.ports[0],
          }).then((value) => {
            window.facades = value;
            window.storageEvents = [];
            addEventListener("storage", (e) =>
              storageEvents.push({
                key: e.key,
                oldValue: e.oldValue,
                newValue: e.newValue,
                url: e.url,
                local: e.storageArea === value.localStorage,
                session: e.storageArea === value.sessionStorage,
              }),
            );
            resolve();
          }, reject);
        }
        addEventListener("message", receive);
      });
    },
    { endpoint: details.commit, documentId: id, frontend },
  );
  await page.evaluate(
    async ({ documentId, website, quotaBytes }) => {
      const c = new MessageChannel(),
        f = document.querySelector(
          'iframe[data-document-id="' + documentId + '"]',
        );
      worker.postMessage(
        { type: "bind-document", documentId, website, sessionId, quotaBytes },
        [c.port1],
      );
      f.contentWindow.postMessage({}, "*", [c.port2]);
    },
    { documentId: id, website, quotaBytes },
  );
  await frame.evaluate(() => testBinding);
  return { frame, id, commit: details.commit };
}
function namedPropertyProbe(mode) {
  const storage = mode === "native" ? localStorage : facades.localStorage;
  const prototype = Storage.prototype;
  const get = prototype.getItem.bind(storage),
    set = prototype.setItem.bind(storage);
  prototype.clear.call(storage);
  const keys = [
    "__proto__",
    "getItem",
    "length",
    "constructor",
    "toString",
    "ordinary",
  ];
  for (const key of keys) set(key, "stored:" + key);
  const initial = {
    keys: Object.keys(storage).sort(),
    ownNames: Reflect.ownKeys(storage)
      .filter((k) => typeof k === "string")
      .sort(),
    types: keys.map((key) => [key, typeof storage[key]]),
    stored: keys.map((key) => [key, get(key)]),
    length: storage.length,
    ordinaryDescriptor: Object.getOwnPropertyDescriptor(storage, "ordinary"),
  };
  const collisionHasOwn = keys.map((key) => [key, Object.hasOwn(storage, key)]);
  storage.getItem = "ordinary expando";
  const assignedMethod = {
    value: storage.getItem,
    stored: get("getItem"),
    own: Object.hasOwn(storage, "getItem"),
  };
  delete storage.getItem;
  const restoredMethod = {
    type: typeof storage.getItem,
    stored: get("getItem"),
  };
  const assignedLength = {
    result: Reflect.set(storage, "length", 999),
    stored: get("length"),
    length: storage.length,
  };
  const savedPrototype = Object.getPrototypeOf(storage);
  storage.__proto__ = { fixture: "expando prototype" };
  const assignedPrototype = {
    fixture: Object.getPrototypeOf(storage).fixture,
    stored: get("__proto__"),
  };
  Object.setPrototypeOf(storage, savedPrototype);
  Object.defineProperty(storage, "defined", { value: 3 });
  const defined = {
    stored: get("defined"),
    descriptor: Object.getOwnPropertyDescriptor(storage, "defined"),
  };
  const errors = {};
  for (const [key, run] of Object.entries({
    missingKey: () => prototype.key.call(storage),
    bigintKey: () => prototype.key.call(storage, 1n),
    symbolKey: () => prototype.key.call(storage, Symbol("index")),
    badReceiver: () => prototype.getItem.call({}, "ordinary"),
    missingValue: () => prototype.setItem.call(storage, "ordinary"),
    accessor: () =>
      Object.defineProperty(storage, "accessor", {
        get() {
          return 3;
        },
      }),
  }))
    try {
      run();
      errors[key] = "unexpected_success";
    } catch (error) {
      errors[key] = error.name;
    }
  const result = {
    initial,
    assignedMethod,
    restoredMethod,
    assignedLength,
    assignedPrototype,
    defined,
    errors,
  };
  prototype.clear.call(storage);
  return { result, collisionHasOwn };
}
async function holdNativeStorage(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("atlas.browsing.v2", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    window.holdStorage = true;
    window.holdTransaction = db.transaction("origins", "readwrite");
    window.holdDone = new Promise((resolve) => {
      holdTransaction.oncomplete = holdTransaction.onabort = () => {
        db.close();
        resolve();
      };
    });
    const store = holdTransaction.objectStore("origins");
    function pump() {
      store.get("__hold_fixture__").onsuccess = () => {
        if (holdStorage) pump();
      };
    }
    pump();
  });
}
async function releaseNativeStorage(page) {
  await page.evaluate(async () => {
    holdStorage = false;
    await holdDone;
  });
}
async function reload(page) {
  await page.reload();
  await initialize(page);
  return createChild(page);
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  receipt.browser = browser.version();
  const context = await browser.newContext(),
    page = await context.newPage();
  await initialize(page);
  let first = await createChild(page);
  receipt.boundary = await first.frame.evaluate(() => {
    const check = (fn) => {
      try {
        return fn();
      } catch (e) {
        return e.name;
      }
    };
    return {
      effectiveOrigin: origin,
      parentAccess: check(() => parent.document.title),
      nativeStorage: check(() => localStorage.length),
      nativeIDB: check(() => indexedDB.open("forbidden")),
    };
  });
  assert.equal(receipt.boundary.effectiveOrigin, "null");
  assert.equal(receipt.boundary.parentAccess, "SecurityError");
  assert.equal(receipt.boundary.nativeStorage, "SecurityError");
  assert.equal(receipt.boundary.nativeIDB, "SecurityError");
  receipt.facade = await first.frame.evaluate(() => {
    const ls = facades.localStorage;
    ls.setItem("save", "777 cookies");
    ls["property"] = "stored";
    const keys = Object.keys(ls);
    delete ls.property;
    let symbolError;
    try {
      ls.setItem(Symbol("x"), "bad");
    } catch (e) {
      symbolError = e.name;
    }
    let receiverError;
    try {
      const fn = ls.getItem;
      fn("save");
    } catch (e) {
      receiverError = e.name;
    }
    return {
      save: ls.getItem("save"),
      length: ls.length,
      key: ls.key(0),
      keys,
      deleted: ls.getItem("property"),
      symbolError,
      receiverError,
      instance: ls instanceof Storage,
      tag: Object.prototype.toString.call(ls),
    };
  });
  assert.equal(receipt.facade.save, "777 cookies");
  assert.equal(receipt.facade.length, 1);
  assert.equal(receipt.facade.deleted, null);
  assert.equal(receipt.facade.symbolError, "TypeError");
  assert.equal(receipt.facade.receiverError, "TypeError");
  assert.equal(receipt.facade.instance, true);
  assert.equal(receipt.facade.tag, "[object Storage]");
  const nativeNamed = await page.evaluate(namedPropertyProbe, "native");
  const parityChild = await createChild(page, "https://named.fixture.example");
  const facadeNamed = await parityChild.frame.evaluate(
    namedPropertyProbe,
    "facade",
  );
  assert.deepEqual(facadeNamed.result, nativeNamed.result);
  receipt.namedPropertyParity = {
    compared: [
      "Object.keys",
      "Reflect.ownKeys",
      "__proto__",
      "getItem",
      "length",
      "constructor",
      "toString",
      "method expandos",
      "default data descriptors",
      "borrowed Storage.prototype methods",
      "argument conversions",
    ],
    matched: true,
  };
  // Legacy platform objects have reflection behavior ordinary JS Proxies do
  // not reproduce exactly: keep this distinction visible rather than assert
  // broad native exotic-object equivalence from the common API test.
  receipt.collisionReflection = {
    native: nativeNamed.collisionHasOwn,
    facade: facadeNamed.collisionHasOwn,
    exactParity:
      JSON.stringify(nativeNamed.collisionHasOwn) ===
      JSON.stringify(facadeNamed.collisionHasOwn),
  };
  // A successful write is followed by whole-shell reload as the next command.
  receipt.syncWrite = await first.frame.evaluate(() => {
    const start = performance.now();
    facades.localStorage.setItem("save", "immediate reload");
    return { returned: "undefined", milliseconds: performance.now() - start };
  });
  first = await reload(page);
  receipt.afterImmediateReload = await first.frame.evaluate(() =>
    facades.localStorage.getItem("save"),
  );
  assert.equal(receipt.afterImmediateReload, "immediate reload");
  receipt.quota = await first.frame.evaluate(() => {
    const ls = facades.localStorage;
    ls.setItem("within", "x".repeat(450));
    try {
      ls.setItem("overflow", "y".repeat(100));
      return "unexpected_success";
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(receipt.quota, "QuotaExceededError");
  first = await reload(page);
  receipt.afterQuota = await first.frame.evaluate(() => ({
    save: facades.localStorage.getItem("save"),
    overflow: facades.localStorage.getItem("overflow"),
  }));
  assert.deepEqual(receipt.afterQuota, {
    save: "immediate reload",
    overflow: null,
  });
  await first.frame.evaluate(() => facades.localStorage.removeItem("within"));
  const peer = await createChild(page, peerSite),
    same = await createChild(page);
  await peer.frame.evaluate(() =>
    facades.localStorage.setItem("save", "peer secret"),
  );
  await first.frame.evaluate(() => {
    facades.localStorage.setItem("shared", "first");
    facades.sessionStorage.setItem("tab-only", "same-tab");
  });
  await same.frame.waitForFunction(
    () =>
      facades.localStorage.getItem("shared") === "first" &&
      facades.sessionStorage.getItem("tab-only") === "same-tab",
  );
  receipt.sameTab = await same.frame.evaluate(() => ({
    local: facades.localStorage.getItem("shared"),
    session: facades.sessionStorage.getItem("tab-only"),
    events: storageEvents,
  }));
  assert.ok(receipt.sameTab.events.some((e) => e.key === "shared" && e.local));
  assert.ok(
    receipt.sameTab.events.some((e) => e.key === "tab-only" && e.session),
  );
  await first.frame.evaluate(() => {
    facades.localStorage.setItem("event-probe", "one");
    facades.localStorage.setItem("event-probe", "one");
    facades.localStorage.removeItem("missing-event-probe");
    facades.localStorage.setItem("event-probe", "two");
    facades.localStorage.removeItem("event-probe");
    facades.sessionStorage.clear();
    facades.sessionStorage.clear();
    try {
      facades.localStorage.setItem("quota-event-probe", "x".repeat(2048));
    } catch {}
  });
  await same.frame.waitForFunction(
    () =>
      storageEvents.filter((e) => e.key === "event-probe").length === 3 &&
      storageEvents.some((e) => e.key === null && e.session),
  );
  receipt.eventSemantics = await same.frame.evaluate(() => ({
    changes: storageEvents
      .filter((e) => e.key === "event-probe")
      .map(({ key, oldValue, newValue, local }) => ({
        key,
        oldValue,
        newValue,
        local,
      })),
    missingEvents: storageEvents.filter((e) => e.key === "missing-event-probe")
      .length,
    quotaEvents: storageEvents.filter((e) => e.key === "quota-event-probe")
      .length,
    clearEvents: storageEvents.filter((e) => e.key === null && e.session)
      .length,
  }));
  assert.deepEqual(receipt.eventSemantics, {
    changes: [
      { key: "event-probe", oldValue: null, newValue: "one", local: true },
      { key: "event-probe", oldValue: "one", newValue: "two", local: true },
      { key: "event-probe", oldValue: "two", newValue: null, local: true },
    ],
    missingEvents: 0,
    quotaEvents: 0,
    clearEvents: 1,
  });
  receipt.sourceMutationEvents = await first.frame.evaluate(
    () => storageEvents.filter((e) => e.key === "event-probe").length,
  );
  assert.equal(receipt.sourceMutationEvents, 0);
  receipt.peerIsolation = await peer.frame.evaluate(() => ({
    save: facades.localStorage.getItem("save"),
    shared: facades.localStorage.getItem("shared"),
  }));
  assert.deepEqual(receipt.peerIsolation, {
    save: "peer secret",
    shared: null,
  });
  const otherPage = await context.newPage();
  await initialize(otherPage);
  const other = await createChild(otherPage);
  receipt.otherTabSession = await other.frame.evaluate(() =>
    facades.sessionStorage.getItem("tab-only"),
  );
  assert.equal(receipt.otherTabSession, null);
  await first.frame.evaluate(() =>
    facades.localStorage.setItem("cross-tab", "visible"),
  );
  await other.frame.waitForFunction(
    () => facades.localStorage.getItem("cross-tab") === "visible",
  );
  receipt.crossTab = await other.frame.evaluate(() => ({
    value: facades.localStorage.getItem("cross-tab"),
    events: storageEvents,
  }));
  assert.ok(
    receipt.crossTab.events.some((e) => e.key === "cross-tab" && e.local),
  );
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? first : other).frame.evaluate(
        (i) => facades.localStorage.setItem("parallel-" + i, "" + i),
        i,
      ),
    ),
  );
  await first.frame.waitForFunction(() =>
    Array.from({ length: 12 }, (_, i) =>
      facades.localStorage.getItem("parallel-" + i),
    ).every((v, i) => v === "" + i),
  );
  receipt.concurrentWrites = 12;
  // Hold a real native read/write transaction to force the worker's write to
  // remain uncommitted beyond the server deadline. No production test-delay API.
  await holdNativeStorage(page);
  receipt.deadline = await first.frame.evaluate(() => {
    try {
      facades.localStorage.setItem("save", "timed-out write");
      return "unexpected_success";
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(receipt.deadline, "TimeoutError");
  await releaseNativeStorage(page);
  await first.frame.evaluate(() =>
    facades.localStorage.setItem("after-timeout", "works"),
  );
  first = await reload(page);
  receipt.afterTimeoutReload = await first.frame.evaluate(() => ({
    save: facades.localStorage.getItem("save"),
    next: facades.localStorage.getItem("after-timeout"),
  }));
  assert.deepEqual(receipt.afterTimeoutReload, {
    save: "immediate reload",
    next: "works",
  });
  // A real pending native write is aborted by server-driven revocation before
  // its object-store lock becomes available. This is not a late-write delay.
  await holdNativeStorage(page);
  const ownerCapability = await page.evaluate(() => owner.capability);
  const beforeUnbind = markers.length;
  const pendingUnboundWrite = first.frame.evaluate(() => {
    try {
      facades.localStorage.setItem("save", "unbound queued write");
      return "unexpected_success";
    } catch (error) {
      return error.name;
    }
  });
  const markerDeadline = Date.now() + 3000;
  while (markers.length === beforeUnbind) {
    if (Date.now() > markerDeadline) throw Error("revocation marker timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
  const revokedResponse = await fetch(
    frontend + "/api/browse/storage/documents/" + first.id,
    {
      method: "DELETE",
      headers: { origin: frontend, authorization: "Bearer " + ownerCapability },
    },
  );
  assert.equal(revokedResponse.status, 204);
  receipt.revokedPendingWrite = await pendingUnboundWrite;
  assert.equal(receipt.revokedPendingWrite, "InvalidStateError");
  await releaseNativeStorage(page);
  const afterUnbind = await createChild(page);
  receipt.afterUnboundWrite = await afterUnbind.frame.evaluate(() =>
    facades.localStorage.getItem("save"),
  );
  assert.equal(receipt.afterUnboundWrite, "immediate reload");
  await first.frame.waitForFunction(() => {
    try {
      facades.localStorage.getItem("save");
      return false;
    } catch (error) {
      return error.name === "InvalidStateError";
    }
  });
  receipt.revoked = await first.frame.evaluate(() => {
    try {
      facades.localStorage.setItem("save", "revoked");
      return "unexpected_success";
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(receipt.revoked, "InvalidStateError");
  receipt.revisionReconciliation = await afterUnbind.frame.evaluate(
    async ({ documentId, endpoint }) => {
      const { createSandboxStorageFacades } = await import(
          "/sandbox-local-storage.js"
        ),
        channels = new MessageChannel();
      const ready = createSandboxStorageFacades({
        documentId,
        endpoint,
        port: channels.port1,
      });
      channels.port2.postMessage({
        type: "ready",
        documentId,
        snapshots: {
          local: { revision: 5, entries: [["value", "five"]] },
          session: { revision: 0, entries: [] },
        },
      });
      const value = await ready,
        events = [];
      const listener = (e) => {
        if (e.storageArea === value.localStorage) events.push(e.newValue);
      };
      addEventListener("storage", listener);
      const change = (revision, text) => ({
        type: "snapshot",
        documentId,
        kind: "local",
        snapshot: { revision, entries: [["value", text]] },
        change: {
          sourceDocumentId: "another-document",
          url: "https://save.fixture.example/",
          key: "value",
          oldValue: null,
          newValue: text,
        },
      });
      channels.port2.postMessage(change(8, "eight"));
      channels.port2.postMessage(change(6, "six"));
      channels.port2.postMessage({
        ...change(99, "spoof"),
        documentId: "different-document",
      });
      await new Promise((resolve) => {
        const tick = () =>
          events.length === 2 ? resolve() : setTimeout(tick, 0);
        tick();
      });
      const result = { current: value.localStorage.getItem("value"), events };
      removeEventListener("storage", listener);
      value.dispose();
      channels.port2.close();
      return result;
    },
    { documentId: "diagnostic_document_1234", endpoint: afterUnbind.commit },
  );
  assert.deepEqual(receipt.revisionReconciliation, {
    current: "eight",
    events: ["eight", "six"],
  });
  assert.ok(
    markers.every(
      (m) =>
        m.origin === "null" &&
        !m.cookiePresent &&
        !m.authorizationPresent &&
        JSON.stringify(m.bodyKeys) === '["sequence"]',
    ),
  );
  receipt.markerRequests = markers.length;
  receipt.allMarkersAnonymousAndSequenceOnly = true;
  receipt.result = "inactive_sync_storage_components_verified";
  receipt.constraints = [
    "General browsing runtime and node relay switching are not qualified by this storage-only suite.",
    "Mirrored reads reconcile authoritative cross-document snapshots on event-loop delivery; synchronous same-task cross-tab visibility is not native-equivalence qualified. Borrowed Storage.prototype methods are tested, but legacy exotic-object hasOwn/explicit-nonconfigurable-descriptor reflection still differs.",
    "Server deadlines bound reached requests; Window sync XHR transport-blackhole timeouts remain browser-controlled.",
    "Native global quota exhaustion was not injected; actual native transactions abort on configured logical per-website quota.",
    "Session records are browser-local and keyed by trusted tab session ID; retiring old session records needs a bounded retention policy. A new tab ID is empty; reusing a trusted ID restores its session data.",
    "A lost transport acknowledgement can throw after a native commit; failure is explicit, but a network error is not proof that the write did not commit. Cancellation and revocation abort writes that remain uncommitted.",
  ];
  receipt.exitStatus = 0;
  await context.close();
} catch (e) {
  receipt.result = "test_failure";
  receipt.failure = { name: e.name, message: e.message, stack: e.stack };
  receipt.exitStatus = 1;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      receipt: output,
      result: receipt.result,
      exitStatus: receipt.exitStatus,
      generalRuntimeQualified: false,
    }),
  );
}
