import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const legacy = "11111111-1111-4111-8111-111111111111";
const guard = `const originalOpen=IDBFactory.prototype.open;IDBFactory.prototype.open=function(name,...args){if(String(name).includes('${legacy}'))throw Error('LEGACY_DATABASE_ACCESS_FORBIDDEN:'+name);return originalOpen.call(this,name,...args)};`;
const bundle = async (contents) =>
  (
    await build({
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      stdin: { resolveDir: resolve("runtime"), contents },
    })
  ).outputFiles[0].text;
const files = {
  "/api.js": await bundle(
    `export{createReplicaControlV2}from'../web/src/replica-control-v2.ts';export{createNativeOwnerV2}from'./native-owner-v2.ts';export{createLocalStorageOwnerV2,createLocalCookieOwnerV2}from'./sandbox-local-owners-v2.ts';export{createSandboxStorageFacades,rebindSandboxStorageFacades}from'./sandbox-local-storage.ts';export{createSandboxDocumentCookie}from'./sandbox-document-cookie.ts';export{createSandboxIndexedDB}from'./sandbox-idb.ts';`,
  ),
  "/control.js":
    guard + (await bundle(`import'./replica-native-control-worker-v2.ts';`)),
  "/native.js": guard + (await bundle(`import'./local-native-worker.ts';`)),
  "/storage.js":
    guard + (await bundle(`import'./storage-native-worker-v2.ts';`)),
  "/cookies.js":
    guard + (await bundle(`import'./cookie-native-worker-v2.ts';`)),
};
const app = Fastify({ logger: false });
app.get("/", (_q, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Native-only local authority</title>"),
);
for (const [path, source] of Object.entries(files))
  app.get(path, (_q, reply) =>
    reply.type("application/javascript").send(source),
  );
app.all("/api/hub/*", (_q, reply) =>
  reply.code(503).send({ error: { code: "HUB_UNAVAILABLE" } }),
);
const report = {
  command: "node tests/native-only-control-v2-browser.mjs",
  productionChanged: false,
};
let browser;
try {
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  report.browser = browser.version();
  const context = await browser.newContext(),
    page = await context.newPage(),
    requests = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/hub/")) requests.push(req.url());
  });
  await page.goto(base);
  report.setup = await page.evaluate(async () => {
    window.api = await import("/api.js");
    window.req = (r) =>
      new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    window.done = (t) =>
      new Promise((res, rej) => {
        t.oncomplete = res;
        t.onabort = () => rej(t.error);
      });
    const id = "11111111-1111-4111-8111-111111111111";
    // Seed uncertified old local/cookie/IDB data plus a prepared legacy outbox.
    for (const [name, store] of [
      ["atlas.browsing.v2:profile:" + id, "origins"],
      ["atlas.browsing.cookies.v2:profile:" + id, "cookies"],
      [
        "atlas.browsing.idb.v2:profile:" +
          id +
          ":https%3A%2F%2Fsite.example:old",
        "records",
      ],
    ]) {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(store);
      const db = await req(r),
        t = db.transaction(store, "readwrite"),
        end = done(t);
      t.objectStore(store).put(
        { legacy: "untouched", payload: "x".repeat(16384) },
        "old",
      );
      await end;
      db.close();
    }
    window.control = api.createReplicaControlV2({
      nativeOnly: true,
      createWorker: () => new Worker("/control.js", { type: "module" }),
    });
    const initial = await control.initialize(id, "native-only-v1", true);
    const peerControl = api.createReplicaControlV2({
      nativeOnly: true,
      createWorker: () => new Worker("/control.js", { type: "module" }),
    });
    await peerControl.initialize(id, "native-only-v1", true);
    // Cloud failure is explicitly persisted as unavailable, not a fake empty
    // cloud or a completed backup. The independent native workspace still opens.
    const unavailable = await control.cloudUnavailable();
    const peerUnavailable = await peerControl.cloudUnavailable();
    peerControl.dispose();
    const prepared = await control.prepareSite("https://site.example/");
    window.authority = {
      version: 2,
      profileId: id,
      replicaId: initial.account.replicaId,
      localAuthGeneration: "native_generation_0123456789abcdef",
      browserSessionId: "native_session_0123456789abcdef",
    };
    window.localOwner = await api.createLocalStorageOwnerV2({
      workerURL: "/storage.js",
      localAuthority: authority,
    });
    const storage = await localOwner.bind({
      documentId: "native_storage_document_012345",
      website: "https://site.example",
      sessionId: authority.browserSessionId,
    });
    window.facades = await api.createSandboxStorageFacades({
      documentId: "native_storage_document_012345",
      endpoint: storage.endpoint,
      port: storage.port,
      window,
      localOnly: true,
    });
    api.rebindSandboxStorageFacades(facades, window);
    window.cookieOwner = await api.createLocalCookieOwnerV2({
      workerURL: "/cookies.js",
      localAuthority: authority,
    });
    const cookie = await cookieOwner.bind({
      documentId: "native_cookie_document_0123456",
      website: "https://site.example",
    });
    window.cookies = await api.createSandboxDocumentCookie({
      documentId: "native_cookie_document_0123456",
      endpoint: cookie.endpoint,
      port: cookie.port,
      window,
      localOnly: true,
    });
    window.native = await api.createNativeOwnerV2(authority, {
      createWorker: () => new Worker("/native.js", { type: "module" }),
    });
    const idb = await native.bind({
      documentId: "native_idb_document_012345678",
      website: "https://site.example",
    });
    window.idb = api.createSandboxIndexedDB(
      idb.port,
      "native_idb_document_012345678",
    );
    const open = window.idb.open("data", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("records");
    window.db = await req(open);
    return {
      initialLegacy: initial.legacy,
      nativeOnly: initial.nativeOnly,
      prepared,
      replicaId: authority.replicaId,
      restoreUnavailable: unavailable.restoreUnavailable,
      competingWindowSameReplica:
        peerUnavailable.replicaId === initial.account.replicaId,
      oldImported: facades.localStorage.getItem("old"),
    };
  });
  await context.setOffline(true);
  report.offline = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++)
      facades.localStorage.setItem("draft", "native-" + i);
    cookies.set("native=works; Secure; Path=/; SameSite=Lax");
    const t = db.transaction("records", "readwrite"),
      end = t.done;
    t.objectStore("records").put({ text: "native-only" }, "draft");
    await end;
    const read = db.transaction("records"),
      readDone = read.done,
      row = await req(read.objectStore("records").get("draft"));
    await readDone;
    const again = await control.initialize(
      authority.profileId,
      "native-only-v1",
      true,
    );
    return {
      local: facades.localStorage.getItem("draft"),
      cookie: cookies.get(),
      idb: row.text,
      stableReplica: again.account.replicaId === authority.replicaId,
      restoreUnavailable: again.account.restoreUnavailable,
    };
  });
  await context.setOffline(false);
  report.legacyUnchanged = await page.evaluate(async () => {
    const r = indexedDB.open(
        "atlas.browsing.v2:profile:" + authority.profileId,
      ),
      old = await req(r),
      t = old.transaction("origins"),
      end = done(t),
      row = await req(t.objectStore("origins").get("old"));
    await end;
    old.close();
    await native.revoke(authority.localAuthGeneration);
    let revoked;
    try {
      const tx = db.transaction("records", "readwrite");
      const failed = tx.done;
      tx.objectStore("records").put("denied", "revoked");
      await failed;
    } catch (e) {
      revoked = e.name;
    }
    return { old: row.legacy, revoked };
  });
  assert.equal(report.setup.initialLegacy, false);
  assert.equal(report.setup.nativeOnly, true);
  assert.equal(report.setup.prepared.mode, "local-v2");
  assert.equal(report.setup.prepared.cookieLocal, true);
  assert.equal(report.setup.restoreUnavailable, true);
  assert.equal(report.setup.competingWindowSameReplica, true);
  assert.equal(report.setup.oldImported, null);
  assert.notEqual(report.setup.replicaId, legacy);
  assert.equal(report.offline.local, "native-99");
  assert.ok(report.offline.cookie.includes("native=works"));
  assert.equal(report.offline.idb, "native-only");
  assert.equal(report.offline.stableReplica, true);
  assert.equal(report.offline.restoreUnavailable, true);
  assert.equal(report.legacyUnchanged.old, "untouched");
  assert.ok(report.legacyUnchanged.revoked);
  assert.deepEqual(requests, []);
  report.hubRequests = requests;
  report.result = "PASS";
  console.log(
    "NATIVE_ONLY_CONTROL_V2 PASS legacy stores never opened by actors; no imports/fallback/Hub commits; stable native scope; offline localStorage/cookies/IDB; logout revokes",
  );
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  const dir = resolve("evidence/local-first-backups-20261028/native-only");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "NATIVE_ONLY_CONTROL_V2_BROWSER.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await app.close();
}
