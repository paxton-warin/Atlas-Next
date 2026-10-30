import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const source = (
  await build({
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    stdin: {
      resolveDir: resolve("runtime"),
      contents:
        "export {inspectLegacyLocalPresence} from './local-legacy-presence-v2.ts';",
    },
  })
).outputFiles[0].text;
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Legacy presence metadata guard</title>"),
);
app.get("/api.js", (_q, r) => r.type("application/javascript").send(source));
const report = {
  command: "node tests/local-legacy-presence-v2-browser.mjs",
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
  const page = await browser.newPage();
  await page.goto(base);
  report.cases = await page.evaluate(async () => {
    const { inspectLegacyLocalPresence } = await import("/api.js");
    const request = (r) =>
      new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const done = (t) =>
      new Promise((res, rej) => {
        t.oncomplete = res;
        t.onabort = () => rej(t.error);
      });
    const id = (n) =>
      String(n).padStart(8, "0") + "-1111-4111-8111-111111111111";
    const scoped = (base, n) => base + ":profile:" + id(n);
    const native = (n, name) =>
      "atlas.browsing.idb.v2:profile:" +
      id(n) +
      ":https%3A%2F%2Fsite.example:" +
      name;
    async function seed(name, stores) {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        for (const store of Object.keys(stores))
          r.result.createObjectStore(store);
      };
      const db = await request(r);
      if (Object.keys(stores).length) {
        const t = db.transaction(Object.keys(stores), "readwrite"),
          end = done(t);
        for (const [store, rows] of Object.entries(stores))
          for (const [key, value] of rows) t.objectStore(store).put(value, key);
        await end;
      }
      db.close();
    }
    // Only known scalar counters/certificates: empty bookkeeping is NOT local data.
    await seed(scoped("atlas.browsing.v2", 1), {
      origins: [
        [["outbox-bytes"], 0],
        [["outbox-sequence"], 0],
      ],
    });
    await seed(scoped("atlas.browsing.cookies.v2", 1), {
      cookies: [],
      meta: [["revision", 0]],
    });
    await seed(scoped("atlas.browsing.profile-catalog.v1", 1), {
      meta: [
        ["profile-outbox-bytes", 0],
        ["profile-outbox-sequence", 0],
      ],
    });
    await seed(native(1, "#quota"), {
      databases: [["database", { bytes: 1234 }]],
      meta: [["unrelated", "control"]],
    });
    await seed("atlas.profile.control.v1", {
      control: [[id(1), { permit: true }]],
    });
    await seed(scoped("atlas.browsing.v2", 2), {
      origins: [
        ["https://site.example", { entries: [["draft", "untouched"]] }],
      ],
    });
    await seed(scoped("atlas.browsing.v2", 3), {
      origins: [[["outbox", "pending"], { payload: "retained" }]],
    });
    await seed(scoped("atlas.browsing.cookies.v2", 4), {
      cookies: [["cookie", { unknownLarge: "x".repeat(65536) }]],
      meta: [],
    });
    await seed(scoped("atlas.browsing.profile-catalog.v1", 5), {
      meta: [
        [
          ["database", "https://site.example", "records"],
          { deleted: true, physical: null },
        ],
      ],
    });
    await seed(native(6, "records"), { records: [] });
    await seed(scoped("atlas.unknown.user-bytes.v1", 7), {
      values: [["unknown", { retain: true }]],
    });
    await seed(scoped("atlas.unknown.control.v1", 8), { meta: [] });
    await seed(scoped("atlas.browsing.v2", 9), {
      origins: Array.from({ length: 70 }, (_, n) => [
        ["local-migration-size-v2", String(n)],
        { bytes: 0 },
      ]),
    });
    await seed(native(10, "#quota"), {
      databases: [["records", { bytes: 0 }]],
    });
    const methods = ["get", "getAll", "openCursor"];
    let valueReads = 0;
    const originals = Object.fromEntries(
      methods.map((name) => [name, IDBObjectStore.prototype[name]]),
    );
    for (const name of methods)
      IDBObjectStore.prototype[name] = function () {
        valueReads++;
        throw Error("Presence guard attempted website-value read: " + name);
      };
    const results = [];
    try {
      for (let n = 1; n <= 10; n++)
        results.push({
          fixture: n,
          ...(await inspectLegacyLocalPresence(indexedDB, id(n))),
        });
    } finally {
      for (const name of methods)
        IDBObjectStore.prototype[name] = originals[name];
    }
    return { results, valueReads };
  });
  const r = report.cases.results;
  assert.equal(report.cases.valueReads, 0);
  assert.equal(
    r[0].present,
    false,
    "empty legacy databases / nonempty quota / permits do not hide completed cloud restore",
  );
  for (const n of [2, 3, 4, 5, 6, 7, 9])
    assert.equal(r[n - 1].present, true, "existing source " + n + " protected");
  assert.equal(r[6].uncertain, true);
  assert.equal(r[8].uncertain, true);
  assert.equal(r[7].present, false);
  assert.equal(r[9].present, false);
  report.result = "PASS";
  console.log(
    "LEGACY_PRESENCE_V2 PASS empty bookkeeping/quota do not skip restore; local/cookie/catalog/dirty/schema/unknown data protected; zero value reads",
  );
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  const directory = resolve(
    "evidence/local-first-backups-20261028/activation-worker",
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "LEGACY_PRESENCE_V2_BROWSER.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await app.close();
}
