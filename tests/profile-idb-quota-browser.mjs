/** Native Chromium: one origin budget across physical databases and documents. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Native origin quota proof</title>"),
);
app.get("/tldts.js", (_q, r) =>
  r
    .type("application/javascript")
    .send(readFileSync("node_modules/tldts/dist/index.esm.min.js", "utf8")),
);
app.get("/:file", (q, r) => {
  const f = q.params.file;
  if (!/^[a-z0-9-]+\.ts$/.test(f)) return r.code(404).send();
  return r
    .type("application/javascript")
    .send(
      ts
        .transpileModule(readFileSync((process.env.ATLAS_NATIVE_RUNTIME_DIR || "runtime/") + f, "utf8"), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        })
        .outputText.replace('from "tldts"', 'from "/tldts.js"'),
    );
});
let browser;
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const { bindSandboxIndexedDB, createSandboxIndexedDB } = await import(
      "/sandbox-idb.ts"
    );
    const { profileIDBPrefix } = await import("/profile-journal.ts");
    const open = (idb, name) =>
      new Promise((res, rej) => {
        const r = idb.open(name);
        r.onupgradeneeded = () => r.result.createObjectStore("data");
        r.onerror = () => rej(r.error);
        r.onsuccess = () => res(r.result);
      });
    const bindings = [];
    const bind = (website, quotaBytes) => {
      const c = new MessageChannel(),
        documentId = crypto.randomUUID();
      const b = bindSandboxIndexedDB({
        factory: indexedDB,
        website,
        frontendOrigin: location.origin,
        documentId,
        port: c.port1,
        limits: { quotaBytes, maxDatabases: 8 },
      });
      bindings.push(b);
      return createSandboxIndexedDB(c.port2, documentId);
    };
    const write = async (db, key, size) => {
      const tx = db.transaction("data", "readwrite");
      const done = tx.done.then(
        () => "committed",
        (e) => e.name,
      );
      tx.objectStore("data").put(new Blob([new Uint8Array(size)]), key);
      return done;
    };
    const read = async (db, key) => {
      const tx = db.transaction("data");
      const r = tx.objectStore("data").get(key);
      const value = await new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await tx.done;
      return value?.size ?? null;
    };
    const del = async (db, key) => {
      const tx = db.transaction("data", "readwrite");
      const done = tx.done;
      tx.objectStore("data").delete(key);
      await done;
    };
    const website = "https://quota.fixture.example",
      idb = bind(website, 8192),
      a = await open(idb, "a"),
      b = await open(idb, "b");
    const beyondOldSlice = await write(a, 1, 5000);
    const aggregateRejected = await write(b, 1, 3000);
    const preserved = await read(a, 1);
    a.close();
    b.close();
    for (const x of bindings.splice(0)) x.dispose();
    const lower = bind(website, 4096),
      lowerA = await open(lower, "a");
    const lowerRead = await read(lowerA, 1),
      lowerGrowth = await write(lowerA, 2, 100);
    await del(lowerA, 1);
    const lowerDeleteReuse = await write(lowerA, 1, 1000);
    lowerA.close();
    for (const x of bindings.splice(0)) x.dispose();
    const higher = bind(website, 16384),
      higherA = await open(higher, "a");
    const raised = await write(higherA, 1, 10000);
    higherA.close();
    for (const x of bindings.splice(0)) x.dispose();
    const site = "https://concurrent.quota.example",
      one = bind(site, 8192),
      two = bind(site, 8192),
      c = await open(one, "c"),
      d = await open(two, "d");
    const initial = await Promise.all([write(c, 1, 3000), write(d, 1, 3000)]);
    const concurrent = await Promise.all([
      write(c, 1, 3600),
      write(d, 1, 3600),
    ]);
    const counts = [await read(c, 1), await read(d, 1)];
    c.close();
    d.close();
    for (const x of bindings.splice(0)) x.dispose();
    const big = bind("https://full.quota.example", 64 * 1024 * 1024),
      full = await open(big, "full");
    let chunks = 0;
    for (let i = 0; i < 21; i++) {
      if ((await write(full, i, 3 * 1024 * 1024)) !== "committed") break;
      chunks++;
    }
    const beyond64 = await write(full, 21, 3 * 1024 * 1024);
    full.close();
    for (const x of bindings.splice(0)) x.dispose();
    const rows = await new Promise((res, rej) => {
      const r = indexedDB.open(profileIDBPrefix(site) + "#quota");
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("databases"),
          q = tx.objectStore("databases").getAll();
        q.onsuccess = () => res(q.result);
        tx.oncomplete = () => db.close();
      };
      r.onerror = () => rej(r.error);
    });
    return {
      beyondOldSlice,
      aggregateRejected,
      preserved,
      lowerRead,
      lowerGrowth,
      lowerDeleteReuse,
      raised,
      initial,
      concurrent,
      counts,
      fullChunks: chunks,
      fullBytes: chunks * 3 * 1024 * 1024,
      beyond64,
      chargedBytes: rows.reduce((n, r) => n + r.bytes, 0),
    };
  });
  console.log(JSON.stringify(result));
  assert.equal(result.beyondOldSlice, "committed");
  assert.equal(result.aggregateRejected, "QuotaExceededError");
  assert.equal(result.preserved, 5000);
  assert.equal(result.lowerRead, 5000);
  assert.equal(result.lowerGrowth, "QuotaExceededError");
  assert.equal(result.lowerDeleteReuse, "committed");
  assert.equal(result.raised, "committed");
  assert.deepEqual(result.initial, ["committed", "committed"]);
  assert.deepEqual(result.concurrent.slice().sort(), [
    "QuotaExceededError",
    "committed",
  ]);
  assert.deepEqual(result.counts.slice().sort(), [3000, 3600]);
  assert.equal(result.fullChunks, 21);
  assert.equal(result.beyond64, "QuotaExceededError");
  assert.ok(result.chargedBytes <= 8192);
  console.log(
    JSON.stringify({ result: "native_origin_quota_verified", ...result }),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
}
