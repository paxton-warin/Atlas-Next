import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const api = (
  await build({
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    stdin: {
      resolveDir: resolve("runtime"),
      contents: `export{inspectLegacySite,copyLegacySiteToV2}from'./local-legacy-migration-v2.ts';export{profileDatabaseName,profileIDBPrefix}from'./profile-journal.ts';export{LocalCookieJarV2 as SandboxCookieJar}from'./local-cookie-jar-v2.ts';export{profileCatalogName}from'./profile-idb-catalog.ts';`,
    },
  })
).outputFiles[0].text;
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Non-destructive migration</title>"),
);
app.get("/api.js", (_q, r) => r.type("application/javascript").send(api));
let browser;
const report = {
  command: "node tests/local-migration-v2-browser.mjs",
  productionChanged: false,
};
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  report.browser = browser.version();
  const page = await browser.newPage();
  await page.goto(origin);
  report.checks = await page.evaluate(async () => {
    const api = await import("/api.js"),
      legacy = "11111111-1111-4111-8111-111111111111",
      replica = "44444444-4444-4444-8444-444444444444",
      origin = "https://child.example.com";
    const req = (q) =>
        new Promise((res, rej) => {
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        }),
      done = (tx) =>
        new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onabort = () => rej(tx.error);
        });
    const open = async (name, upgrade) => {
      const q = indexedDB.open(name, 1);
      q.onupgradeneeded = () => upgrade?.(q.result);
      return req(q);
    };
    const local = await open(
      api.profileDatabaseName("atlas.browsing.v2", legacy),
      (db) => db.createObjectStore("origins"),
    );
    let tx = local.transaction("origins", "readwrite"),
      complete = done(tx);
    tx.objectStore("origins").put(
      { revision: 7, entries: [["save", "original-value"]] },
      origin,
    );
    await complete;
    const nativeGet = IDBObjectStore.prototype.get;
    let forbiddenReads = 0;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "origins" && key === origin) forbiddenReads++;
      return nativeGet.call(this, key);
    };
    const unknown = await api.inspectLegacySite(indexedDB, legacy, origin),
      unknownReads = forbiddenReads;
    IDBObjectStore.prototype.get = nativeGet;
    tx = local.transaction("origins", "readwrite");
    complete = done(tx);
    tx.objectStore("origins").put(
      { format: 2, revision: 7, bytes: 128, count: 1 },
      ["local-migration-size-v2", origin],
    );
    await complete;
    const cookie = {
        id: JSON.stringify([null, "example.com", false, "/", "session"]),
        name: "session",
        value: "parent-domain-cookie",
        domain: "example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
        partition: null,
        sessionId: "profile-" + legacy,
        expires: null,
        created: 1,
        accessed: 1,
        site: "example.com",
      },
      cookieBytes = new TextEncoder().encode(JSON.stringify(cookie)).length;
    const sourceCookies = await open(
      api.profileDatabaseName("atlas.browsing.cookies.v2", legacy),
      (db) => {
        db.createObjectStore("cookies", { keyPath: "id" });
        db.createObjectStore("meta");
      },
    );
    tx = sourceCookies.transaction(["cookies", "meta"], "readwrite");
    complete = done(tx);
    tx.objectStore("cookies").put(cookie);
    tx.objectStore("meta").put(8, "revision");
    tx.objectStore("meta").put(
      {
        format: 2,
        scope: "complete-stored-jar",
        revision: 8,
        bytes: cookieBytes,
        count: 1,
      },
      "local-cookie-migration-size-v2",
    );
    tx.objectStore("meta").put({ bytes: cookieBytes, revision: 8 }, [
      "local-cookie-size-v2",
      cookie.id,
    ]);
    await complete;
    const eligible = await api.inspectLegacySite(indexedDB, legacy, origin),
      migration = await api.copyLegacySiteToV2(
        indexedDB,
        legacy,
        replica,
        origin,
      );
    const target = await open(
      api.profileDatabaseName("atlas.browsing.v2", replica),
    );
    tx = target.transaction(["values-v2", "origins"]);
    complete = done(tx);
    const copied = await req(
      tx.objectStore("values-v2").get(["local", origin, "save"]),
    );
    await complete;
    tx = local.transaction("origins");
    complete = done(tx);
    const original = await req(tx.objectStore("origins").get(origin));
    await complete;
    const authority = {
        version: 2,
        profileId: legacy,
        replicaId: replica,
        localAuthGeneration: "generation_0123456789abcdef",
        browserSessionId: "session_0123456789abcdef",
      },
      jar = new api.SandboxCookieJar({
        factory: indexedDB,
        profileId: replica,
        localAuthority: authority,
        browserSessionId: authority.browserSessionId,
        forbiddenOrigins: [location.origin],
      }),
      cookieView = await jar.getRequestHeader({
        requestURL: origin + "/",
        documentURL: origin + "/",
        topLevelURL: origin + "/",
        credentials: "include",
      });
    await jar.close();
    const incompleteReplica = "55555555-5555-4555-8555-555555555555",
      catalog = await open(api.profileCatalogName(incompleteReplica), (db) =>
        db.createObjectStore("meta"),
      );
    tx = catalog.transaction("meta", "readwrite");
    complete = done(tx);
    tx.objectStore("meta").put({ state: "preparing" }, [
      "local-site-v2",
      origin,
    ]);
    await complete;
    const interrupted = await api.copyLegacySiteToV2(
      indexedDB,
      legacy,
      incompleteReplica,
      origin,
    );
    const unsafe = await open(
      api.profileIDBPrefix(origin, legacy) + "unverified",
      (db) => db.createObjectStore("data"),
    );
    const unsafeInspection = await api.inspectLegacySite(
      indexedDB,
      legacy,
      origin,
    );
    for (const db of [local, target, sourceCookies, catalog, unsafe])
      db.close();
    return {
      unknown: unknown.state,
      unknownReason: unknown.reason,
      unknownReads,
      eligible: eligible.state,
      migration: migration.state,
      copied,
      original: original.entries[0][1],
      cookieView,
      interrupted: interrupted.state,
      interruptedReason: interrupted.reason,
      unsafe: unsafeInspection.state,
      unsafeReason: unsafeInspection.reason,
    };
  });
  const c = report.checks;
  assert.equal(c.unknown, "deferred");
  assert.equal(c.unknownReads, 0);
  assert.equal(c.eligible, "eligible");
  assert.equal(c.migration, "eligible");
  assert.equal(c.copied, "original-value");
  assert.equal(c.original, "original-value");
  assert.equal(c.cookieView, "session=parent-domain-cookie");
  assert.equal(c.interrupted, "deferred");
  assert.equal(c.unsafe, "deferred");
  report.result = "PASS";
  console.log(
    "LOCAL_MIGRATION_V2 PASS bounded certificate cut; original preserved; parent-domain cookie retained; unknown/IDB/interrupted sites deferred",
  );
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir("evidence/local-first-backups-20261028", { recursive: true });
  await writeFile(
    "evidence/local-first-backups-20261028/MIGRATION_V2_BROWSER.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await app.close();
}
