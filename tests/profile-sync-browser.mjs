/** Native Chromium crash/reload proof for the trusted durable queue adapter. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Durable queue fixture</title>"),
);
for (const name of ["profile-sync", "profile-compaction-sync", "profile-journal", "profile-idb-catalog", "profile-idb-quota", "profile-locks", "hub-contracts"])
  app.get("/" + name + ".ts", (_q, r) =>
    r
      .type("application/javascript")
      .send(
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
let browser;
try {
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const cloudState = await page.evaluate(async () => {
    const { appendProfileJournal, profileDatabaseName } = await import(
      "/profile-journal.ts"
    );
    const { nativeProfileQueue, drainProfileQueue } = await import(
      "/profile-sync.ts"
    );
    const { hubNamespace } = await import("/hub-contracts.ts");
    const id = "11111111-1111-4111-8111-111111111111";
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(profileDatabaseName("atlas.browsing.v2", id), 1);
      r.onupgradeneeded = () => r.result.createObjectStore("origins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("origins", "readwrite", {
          durability: "strict",
        }),
        s = tx.objectStore("origins");
      s.put({ save: "42" }, "https://game.example");
      for (const value of ["41", "42"])
        appendProfileJournal(
          s,
          {
            profileId: id,
            kind: "local",
            origin: "https://game.example",
            payload: { key: "save", value },
            bytes: 40,
          },
          "array",
        );
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const sha = async (s) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const state = { revision: 0, receipts: {} };
    const cloud = {
      receipt: async (id) => state.receipts[id] || null,
      stream: async () => ({ revision: state.revision }),
      writer: async () => ({
        epoch: 3,
        expiresAt: new Date(Date.now() + 90000).toISOString(),
      }),
      commit: async (v) => {
        state.revision++;
        state.receipts[v.idempotencyKey] = {
          acknowledged: true,
          namespace: JSON.parse(hubNamespace(v.namespace).key),
          mode: v.mode,
          revision: state.revision,
          payloadHash: await sha(
            JSON.stringify([
              hubNamespace(v.namespace).key,
              v.mode,
              v.baseRevision,
              await sha(JSON.stringify(v.payload)),
            ]),
          ),
        };
        throw Error("simulated lost remote response");
      },
    };
    const queue = nativeProfileQueue(indexedDB, id);
    let error = "";
    try {
      await drainProfileQueue(queue, cloud);
    } catch (e) {
      error = e.message;
    }
    return { ...state, error, pending: (await queue.list()).length };
  });
  assert.equal(cloudState.error, "simulated lost remote response");
  assert.equal(cloudState.pending, 2);
  assert.equal(cloudState.revision, 1);
  await page.reload();
  const result = await page.evaluate(async (state) => {
    const { nativeProfileQueue, drainProfileQueue } = await import(
      "/profile-sync.ts"
    );
    const id = "11111111-1111-4111-8111-111111111111",
      queue = nativeProfileQueue(indexedDB, id);
    let writes = 0;
    const cloud = {
      receipt: async (id) => state.receipts[id] || null,
      stream: async () => ({ revision: state.revision }),
      writer: async () => ({
        epoch: 3,
        expiresAt: new Date(Date.now() + 90000).toISOString(),
      }),
      commit: async (v) => {
        if (v.baseRevision !== state.revision)
          throw Error("wrong base revision");
        writes++;
        return { acknowledged: true, revision: ++state.revision };
      },
    };
    const acknowledged = await drainProfileQueue(queue, cloud),
      pending = await queue.list();
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("atlas.browsing.v2:profile:" + id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const local = await new Promise((resolve, reject) => {
      const tx = db.transaction("origins"),
        s = tx.objectStore("origins"),
        r = s.getAll();
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return {
      acknowledged,
      pending: pending.length,
      writes,
      revision: state.revision,
      save: local.find((x) => x?.save)?.save,
      head: local.find((x) => x?.revision === 2 && x.epoch === 3),
      otherAccountPending: (
        await nativeProfileQueue(
          indexedDB,
          "22222222-2222-4222-8222-222222222222",
        ).list()
      ).length,
    };
  }, cloudState);
  assert.deepEqual(result, {
    acknowledged: 2,
    pending: 0,
    writes: 1,
    revision: 2,
    save: "42",
    head: { revision: 2, epoch: 3 },
    otherAccountPending: 0,
  });
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "native transaction persists data and journal",
          "lost response preserves pending entries",
          "reload preserves prepared fencing epoch",
          "matching receipt avoids duplicate write",
          "next commit advances canonical revision",
          "acknowledgements clear only journal, preserve save",
          "other profile cannot see queue",
        ],
        observed: result,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app.close();
}
