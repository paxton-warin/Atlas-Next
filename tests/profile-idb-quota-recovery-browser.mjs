/** Native metadata crash-boundary proof; no timer/TTL cleanup or guessed usage. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const app = Fastify({ logger: false });
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const chacha = (await build({ entryPoints: [import.meta.resolve("@noble/ciphers/chacha.js").replace(/^file:\/\//, "")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" })).outputFiles[0].text;
app.get("/chacha-vendor.js", (_q,r) => r.type("application/javascript").send(chacha));
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Quota crash boundaries</title>"),
);
app.get("/tldts.js", (_q, r) =>
  r
    .type("application/javascript")
    .send(readFileSync("node_modules/tldts/dist/index.esm.min.js", "utf8")),
);
app.get("/:file", (q, r) =>
  r.type("application/javascript").send(
    ts
      .transpileModule(readFileSync((process.env.ATLAS_NATIVE_RUNTIME_DIR || "runtime/") + q.params.file, "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      })
      .outputText.replace('from "tldts"', 'from "/tldts.js"').replace(/from (["'])@noble\/ciphers\/chacha\.js\1/g, 'from "/chacha-vendor.js"'),
  ),
);
let browser;
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext();
  let page = await context.newPage();
  await page.goto(origin);
  const seed = await page.evaluate(async () => {
    const q = await import("/profile-idb-quota.ts"),
      j = await import("/profile-journal.ts");
    const prefix = j.profileIDBPrefix("https://crash.quota.example"),
      physical = prefix + "save";
    const r = indexedDB.open(physical);
    await new Promise((res, rej) => {
      r.onupgradeneeded = () => {
        r.result.createObjectStore(j.PROFILE_IDB_KEEP);
        r.result.createObjectStore("data");
      };
      r.onerror = () => rej(r.error);
      r.onsuccess = res;
    });
    const db = r.result,
      tx = db.transaction([j.PROFILE_IDB_KEEP, "data"], "readwrite", {
        durability: "strict",
      });
    tx.objectStore(j.PROFILE_IDB_KEEP).put(
      { bytes: 1000, records: 1, indexEntries: 0, sliceBytes: 4096 },
      "usage",
    );
    tx.objectStore("data").put("committed-old", "save");
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onabort = () => rej(tx.error);
    });
    db.close();
    await q.reserveQuotaDatabase(indexedDB, prefix, "save", physical, 8);
    await q.reconcileQuotaSource(indexedDB, prefix, { name: "save", physical });
    await q.reserveQuotaCommit(
      indexedDB,
      prefix,
      { name: "save", physical },
      1000,
      6000,
      8192,
    );
    return { prefix, physical };
  });
  await page.close();
  page = await context.newPage();
  await page.goto(origin);
  const aborted = await page.evaluate(async ({ prefix, physical }) => {
    const q = await import("/profile-idb-quota.ts");
    const read = () =>
      new Promise((res, rej) => {
        const r = indexedDB.open(prefix + "#quota");
        r.onsuccess = () => {
          const d = r.result,
            tx = d.transaction("databases"),
            a = tx.objectStore("databases").get("save");
          a.onsuccess = () => res(a.result);
          tx.oncomplete = () => d.close();
        };
        r.onerror = () => rej(r.error);
      });
    const before = (await read()).bytes;
    await q.reconcileQuotaSource(indexedDB, prefix, { name: "save", physical });
    return { before, after: (await read()).bytes };
  }, seed);
  assert.deepEqual(aborted, { before: 6000, after: 1000 });
  await page.evaluate(async ({ prefix, physical }) => {
    const q = await import("/profile-idb-quota.ts"),
      j = await import("/profile-journal.ts");
    await q.reserveQuotaCommit(
      indexedDB,
      prefix,
      { name: "save", physical },
      1000,
      6000,
      8192,
    );
    const r = indexedDB.open(physical);
    await new Promise((res) => {
      r.onsuccess = res;
    });
    const d = r.result,
      tx = d.transaction([j.PROFILE_IDB_KEEP, "data"], "readwrite", {
        durability: "strict",
      });
    tx.objectStore(j.PROFILE_IDB_KEEP).put(
      { bytes: 6000, records: 1, indexEntries: 0, sliceBytes: 8192 },
      "usage",
    );
    tx.objectStore("data").put("committed-new", "save");
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onabort = () => rej(tx.error);
    });
    d.close();
  }, seed);
  await page.close();
  page = await context.newPage();
  await page.goto(origin);
  const committed = await page.evaluate(async ({ prefix, physical }) => {
    const q = await import("/profile-idb-quota.ts");
    await q.reconcileQuotaSource(indexedDB, prefix, { name: "save", physical });
    const old = await q.reserveQuotaCommit(
        indexedDB,
        prefix,
        { name: "save", physical },
        6000,
        7000,
        8192,
      ),
      latest = await q.reserveQuotaCommit(
        indexedDB,
        prefix,
        { name: "save", physical },
        6000,
        6500,
        8192,
      );
    await q.finishQuotaCommit(indexedDB, prefix, old, false);
    const r = indexedDB.open(prefix + "#quota");
    await new Promise((res) => {
      r.onsuccess = res;
    });
    const d = r.result,
      tx = d.transaction("databases"),
      a = tx.objectStore("databases").get("save"),
      value = await new Promise((res) => {
        a.onsuccess = () => res(a.result);
      });
    d.close();
    await q.finishQuotaCommit(indexedDB, prefix, latest, false);
    const shrink = await q.reserveQuotaCommit(
      indexedDB,
      prefix,
      { name: "save", physical },
      6000,
      1000,
      4096,
    );
    return {
      chargeAfterStaleAck: value.bytes,
      tokenPreserved: value.intent.token === latest.token,
      shrinkCharge: shrink.before,
    };
  }, seed);
  assert.deepEqual(committed, {
    chargeAfterStaleAck: 6500,
    tokenPreserved: true,
    shrinkCharge: 6000,
  });
  await page.close();
  page = await context.newPage();
  await page.goto(origin);
  const recovered = await page.evaluate(async ({ prefix, physical }) => {
    const q = await import("/profile-idb-quota.ts");
    await q.reconcileQuotaSource(indexedDB, prefix, { name: "save", physical });
    return await q.readQuotaUsage(indexedDB, physical);
  }, seed);
  assert.equal(recovered, 6000);
  const portable = await page.evaluate(async () => {
    const { restoreProfileStream, clearProfileWebsiteData } = await import(
        "/profile-store.ts"
      ),
      { setProfilePermit } = await import("/profile-permissions.ts"),
      { bindSandboxIndexedDB, createSandboxIndexedDB } = await import(
        "/sandbox-idb.ts"
      ),
      j = await import("/profile-journal.ts"),
      q = await import("/profile-idb-quota.ts");
    const id = "33333333-3333-4333-8333-333333333333",
      origin = "https://restored.quota.example",
      ns = { kind: "idb", origin, name: "large" },
      ctx = "quota-recovery";
    await setProfilePermit(indexedDB, {
      profileId: id,
      group: "quota.example",
      contextId: ctx,
      epoch: 1,
      expiresAt: Date.now() + 90000,
      offline: false,
    });
    const payload = {
      format: "atlas-idb-snapshot-v1",
      version: 1,
      stores: [
        {
          name: "data",
          keyPath: null,
          autoIncrement: false,
          indexes: [],
          generator: null,
          records: Array.from({ length: 6 }, (_, i) => ({
            key: i,
            value: new Blob([new Uint8Array(2 * 1024 * 1024)]),
          })),
        },
      ],
    };
    await restoreProfileStream(indexedDB, id, ns, payload, [], {
      revision: 1,
      epoch: 1,
    });
    const c = new MessageChannel(),
      documentId = crypto.randomUUID(),
      binding = bindSandboxIndexedDB({
        factory: indexedDB,
        profileId: id,
        profileContextId: ctx,
        website: origin,
        frontendOrigin: location.origin,
        documentId,
        port: c.port1,
        limits: { quotaBytes: 1024 * 1024 },
      }),
      idb = createSandboxIndexedDB(c.port2, documentId);
    const db = await new Promise((res, rej) => {
      const r = idb.open("large");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const read = db.transaction("data"),
      r = read.objectStore("data").get(0),
      blob = await new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    await read.done;
    const over = db.transaction("data", "readwrite"),
      growth = over.done.then(
        () => "committed",
        (e) => e.name,
      );
    over.objectStore("data").put("growth", 7);
    const denied = await growth;
    db.close();
    binding.dispose();
    await clearProfileWebsiteData(indexedDB, id, ctx);
    const meta = indexedDB.open(j.profileIDBPrefix(origin, id) + "#quota");
    await new Promise((res) => {
      meta.onsuccess = res;
    });
    const d = meta.result,
      tx = d.transaction("databases"),
      count = tx.objectStore("databases").count(),
      rows = await new Promise((res) => {
        count.onsuccess = () => res(count.result);
      });
    d.close();
    return {
      restoredBytes: blob.size,
      recordCount: payload.stores[0].records.length,
      denied,
      remainingQuotaRows: rows,
    };
  });
  assert.deepEqual(portable, {
    restoredBytes: 2 * 1024 * 1024,
    recordCount: 6,
    denied: "QuotaExceededError",
    remainingQuotaRows: 0,
  });
  const local = await page.evaluate(async () => {
    const { restoreProfileStream } = await import("/profile-store.ts"),
      { setProfilePermit } = await import("/profile-permissions.ts"),
      { installSandboxStorageWorker } = await import(
        "/sandbox-storage-worker.ts"
      );
    const id = "44444444-4444-4444-8444-444444444444",
      site = "https://local.quota.example",
      contextId = "local-quota-proof";
    await setProfilePermit(indexedDB, {
      profileId: id,
      group: "quota.example",
      contextId,
      epoch: 1,
      expiresAt: Date.now() + 90000,
      offline: false,
    });
    await restoreProfileStream(
      indexedDB,
      id,
      { kind: "local", origin: site },
      {
        format: "atlas-local-snapshot-v1",
        revision: 1,
        entries: [
          ["large", "x".repeat(3 * 1024 * 1024)],
          ["extra", "y".repeat(1000)],
        ],
      },
      [],
      { revision: 1, epoch: 1 },
    );
    const NativeSocket = globalThis.WebSocket,
      results = new Map();
    let receiver, ownerReady;
    const ready = new Promise((res) => (ownerReady = res));
    // Only owner receipt transport is stubbed. The real worker implementation,
    // native IDB commit/abort and actual document MessagePorts run unchanged.
    class ReceiptSocket {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        queueMicrotask(() =>
          this.onmessage({ data: JSON.stringify({ type: "ready" }) }),
        );
      }
      send(text) {
        const v = JSON.parse(text);
        if (v.type === "result") {
          results.get(v.documentId + ":" + v.sequence)?.(v);
          results.delete(v.documentId + ":" + v.sequence);
        }
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    globalThis.WebSocket = ReceiptSocket;
    const scope = {
      location,
      indexedDB,
      postMessage(m) {
        if (m.type === "ready") ownerReady();
        if (m.type === "error") throw Error(m.error.code);
      },
      addEventListener(_type, fn) {
        receiver = fn;
      },
      removeEventListener() {},
    };
    const installed = installSandboxStorageWorker(scope);
    receiver({
      data: {
        type: "initialize",
        socketURL:
          location.origin.replace("http:", "ws:") +
          "/browse/storage/owner/" +
          "a".repeat(43),
        profileId: id,
        profileContextId: contextId,
      },
      ports: [],
    });
    await ready;
    const bind = async (quotaBytes) => {
      const documentId = "doc_" + crypto.randomUUID().replaceAll("-", ""),
        c = new MessageChannel();
      const ready = new Promise((res) => {
        c.port2.onmessage = (e) => {
          if (e.data.type === "ready") res(e.data.snapshots.local);
        };
      });
      receiver({
        data: {
          type: "bind-document",
          documentId,
          website: site,
          sessionId: "session_abcdefghijklmnopqrst",
          quotaBytes,
        },
        ports: [c.port1],
      });
      const snapshot = await ready;
      let seq = 0;
      return {
        snapshot,
        write(change) {
          const sequence = ++seq,
            result = new Promise((res) =>
              results.set(documentId + ":" + sequence, res),
            );
          c.port2.postMessage({
            type: "mutate",
            documentId,
            sequence,
            kind: "local",
            change,
          });
          return result;
        },
      };
    };
    try {
      const lower = await bind(64 * 1024),
        loaded = lower.snapshot.entries.find((e) => e[0] === "large")[1].length;
      const shrink = await lower.write({
          op: "set",
          key: "large",
          value: "x".repeat(2 * 1024 * 1024),
        }),
        growth = await lower.write({ op: "set", key: "new", value: "x" }),
        remove = await lower.write({ op: "remove", key: "large" }),
        higher = await bind(128 * 1024),
        raised = await higher.write({
          op: "set",
          key: "larger",
          value: "x".repeat(50 * 1024),
        }),
        clear = await lower.write({ op: "clear" });
      return {
        loaded,
        shrink: shrink.ok,
        growth: growth.error?.name,
        remove: remove.ok,
        raised: raised.ok,
        clear: clear.ok,
      };
    } finally {
      installed.dispose();
      globalThis.WebSocket = NativeSocket;
    }
  });
  assert.deepEqual(local, {
    loaded: 3 * 1024 * 1024,
    shrink: true,
    growth: "QuotaExceededError",
    remove: true,
    raised: true,
    clear: true,
  });
  console.log(
    JSON.stringify({
      result: "native_origin_quota_recovery_verified",
      crashBeforeSourceCommit: aborted,
      crashAfterSourceCommit: recovered,
      staleAcknowledgement: committed,
      portable,
      local,
    }),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
}
