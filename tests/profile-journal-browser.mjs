/** Finite Chromium proof: local data and outbox commit/abort together. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Profile journal fixture</title>"),
);
for (const name of [
  "profile-journal",
  "profile-permissions",
  "profile-idb-catalog", "profile-idb-quota", "profile-locks",
  "hub-contracts",
  "sandbox-idb",
  "sandbox-cookies",
])
  app.get("/" + name + ".ts", (_q, r) =>
    r.type("application/javascript").send(
      ts
        .transpileModule(readFileSync("runtime/" + name + ".ts", "utf8"), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        })
        .outputText.replace('from "tldts"', 'from "/tldts.js"'),
    ),
  );
app.get("/tldts.js", (_q, r) =>
  r
    .type("application/javascript")
    .send(readFileSync("node_modules/tldts/dist/index.esm.min.js", "utf8")),
);
const origin = await app.listen({ port: 0, host: "127.0.0.1" });
const executablePath =
  process.env.CHROME_PATH ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ].find(existsSync);
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const j = await import("/profile-journal.ts");
    const profileId = "11111111-1111-4111-8111-111111111111";
    const permissions = await import("/profile-permissions.ts");
    const profileContextId = "journal-proof-context";
    for (const group of ["cookie.example", "idb.example"])
      await permissions.setProfilePermit(indexedDB, {
        profileId,
        group,
        contextId: profileContextId,
        epoch: 1,
        expiresAt: Date.now() + 90000,
        offline: false,
        revoked: false,
      });
    const open = (name, setup) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => setup(r.result);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const done = (tx) =>
      new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => reject(tx.error || Error("aborted"));
      });
    const db = await open("atomic-fixture", (db) =>
      db.createObjectStore("data"),
    );
    const count = () =>
      new Promise((resolve) => {
        const tx = db.transaction("data"),
          r = tx.objectStore("data").getAll();
        tx.oncomplete = () => resolve(r.result);
      });
    const write = (value, abort = false) =>
      new Promise((resolve) => {
        const tx = db.transaction("data", "readwrite"),
          s = tx.objectStore("data");
        s.put(value, "save");
        j.appendProfileJournal(s, {
          profileId,
          profileContextId,
          kind: "local",
          origin: "https://save.example",
          payload: { value },
          bytes: 64,
        });
        if (abort) tx.abort();
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => resolve(false);
      });
    await write("one");
    await write("two", true);
    const entries = await count();
    const afterAbort = entries.filter(
      (x) => x && typeof x === "object" && x.kind === "local",
    );
    const tx = db.transaction("data", "readwrite"),
      s = tx.objectStore("data");
    j.appendProfileJournal(s, {
      profileId,
      profileContextId,
      kind: "local",
      origin: "https://save.example",
      payload: { value: "three" },
      bytes: 64,
    });
    j.appendProfileJournal(s, {
      profileId,
      profileContextId,
      kind: "local",
      origin: "https://save.example",
      payload: { value: "four" },
      bytes: 64,
    });
    await done(tx);
    const after = await count();
    const quotaTx = db.transaction("data", "readwrite");
    quotaTx
      .objectStore("data")
      .put(j.PROFILE_OUTBOX_LIMIT, j.PROFILE_OUTBOX_BYTES);
    await done(quotaTx);
    const quotaAborted = !(await write("must-not-commit"));
    const stillSaved = await new Promise((resolve) => {
      const tx = db.transaction("data"),
        r = tx.objectStore("data").get("save");
      tx.oncomplete = () => resolve(r.result);
    });
    const seq = after
      .filter((x) => x && typeof x === "object" && x.kind === "local")
      .map((x) => x.sequence)
      .sort();
    const cookies = await import("/sandbox-cookies.ts");
    const jar = new cookies.SandboxCookieJar({
      factory: indexedDB,
      profileId,
      profileContextId,
      browserSessionId: "fixture_browser_session",
      forbiddenOrigins: [location.origin],
    });
    const context = {
      requestURL: "https://cookie.example/path",
      documentURL: "https://cookie.example/path",
      topLevelURL: "https://cookie.example/path",
      credentials: "include",
    };
    await jar.storeResponseCookies(
      ["save=private-fixture; Path=/; Secure; HttpOnly"],
      context,
    );
    await jar.close();
    const peer = new cookies.SandboxCookieJar({
      factory: indexedDB,
      profileId: "22222222-2222-4222-8222-222222222222",
      browserSessionId: "fixture_browser_session",
      forbiddenOrigins: [location.origin],
    });
    const peerHeader = await peer.getRequestHeader(context);
    await peer.close();
    const cookieDB = await open(
      j.profileDatabaseName(cookies.SANDBOX_COOKIE_DATABASE, profileId),
      () => {},
    );
    const cookieEntries = await new Promise((resolve) => {
      const tx = cookieDB.transaction("meta"),
        r = tx.objectStore("meta").getAll();
      tx.oncomplete = () =>
        resolve(
          r.result.filter(
            (x) => x && typeof x === "object" && x.kind === "cookies",
          ),
        );
    });
    cookieDB.close();
    const mod = await import("/sandbox-idb.ts");
    const channel = new MessageChannel();
    const binding = mod.bindSandboxIndexedDB({
      port: channel.port1,
      documentId: "fixture_document_123456",
      website: "https://idb.example",
      frontendOrigin: location.origin,
      factory: indexedDB,
      profileId,
      profileContextId,
    });
    const facade = mod.createSandboxIndexedDB(
      channel.port2,
      "fixture_document_123456",
    );
    const request = facade.open("save", 1);
    const storeDB = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () =>
        request.result.createObjectStore("s", { autoIncrement: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let idbtx = storeDB.transaction("s", "readwrite");
    idbtx.objectStore("s").put({ saved: "yes" });
    await done(idbtx);
    idbtx = storeDB.transaction("s", "readwrite");
    idbtx.objectStore("s").put({ saved: "no" });
    idbtx.abort();
    await new Promise((resolve) => (idbtx.onabort = resolve));
    storeDB.close();
    const deletion = facade.deleteDatabase("save");
    const deletionError = await new Promise((resolve) => {
      deletion.onerror = () => resolve(deletion.error.name);
      deletion.onsuccess = () => resolve("success");
    });
    storeDB.close();
    binding.dispose();
    const idb = await open(
      "atlas.browsing.profile-catalog.v1:profile:" + profileId,
      () => {},
    );
    const idbEntries = await new Promise((resolve) => {
      const tx = idb.transaction("meta"),
        r = tx.objectStore("meta").getAll();
      tx.oncomplete = () =>
        resolve(
          r.result.filter(
            (x) =>
              x &&
              typeof x === "object" &&
              x.kind === "idb" &&
              Array.isArray(x.payload.changes),
          ),
        );
    });
    idb.close();
    db.close();
    return {
      quotaAborted,
      stillSaved,
      peerHeader,
      deletionError,
      afterAbort: afterAbort.map((x) => x.payload.value),
      seq,
      cookieChanges: cookieEntries
        .flatMap((x) => x.payload.changes)
        .map((x) => x.op),
      idbEntries: idbEntries
        .sort((a, b) => a.sequence - b.sequence)
        .map((x) => ({ sequence: x.sequence, changes: x.payload.changes })),
    };
  });
  assert.equal(result.quotaAborted, true);
  assert.equal(result.stillSaved, "one");
  assert.equal(result.peerHeader, "");
  assert.equal(result.deletionError, "success");
  assert.deepEqual(result.afterAbort, ["one"]);
  assert.deepEqual(result.seq, [1, 2, 3]);
  assert.deepEqual(result.cookieChanges, ["set"]);
  assert.equal(result.idbEntries.length, 2);
  assert.equal(result.idbEntries[1].changes[0].key, 1);
  assert.equal(
    result.idbEntries.some((x) =>
      x.changes.some((c) => JSON.stringify(c).includes('"no"')),
    ),
    false,
  );
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: 10,
        localOnly: true,
        remoteSyncQualified: false,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app.close();
}
