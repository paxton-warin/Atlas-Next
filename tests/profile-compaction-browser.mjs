/** Native Chromium proof: strict IDB compaction intent/head transactions,
 * reload/lost response, exact schemas/keys/binary values and restored generators.
 * Cloud transport below is deterministic fake; no real Hub/cloud claims. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Native compaction durability</title>"),
);
app.get("/tldts.js", (_q, r) =>
  r
    .type("application/javascript")
    .send(readFileSync("node_modules/tldts/dist/index.esm.min.js", "utf8")),
);
app.get("/:file", (q, r) => {
  const name = q.params.file;
  if (!/^[a-z0-9-]+\.ts$/.test(name)) return r.code(404).send();
  return r.type("application/javascript").send(
    ts
      .transpileModule(readFileSync("runtime/" + name, "utf8"), {
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
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const first = await page.evaluate(async () => {
    const { nativeProfileQueue, drainProfileQueue } = await import(
        "/profile-sync.ts"
      ),
      { appendProfileJournal, profileDatabaseName } = await import(
        "/profile-journal.ts"
      ),
      { hubNamespace, encodePortableValue } = await import("/hub-contracts.ts"),
      { compactProfileStream } = await import("/profile-compaction.ts");
    const profile = "11111111-1111-4111-8111-111111111111",
      namespace = { kind: "local", origin: "https://game.example" },
      name = profileDatabaseName("atlas.browsing.v2", profile);
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("origins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("origins", "readwrite", {
          durability: "strict",
        }),
        store = tx.objectStore("origins");
      store.put(
        { revision: 129, entries: [["save", "native-unuploaded"]] },
        namespace.origin,
      );
      store.put({ revision: 128, epoch: 7 }, [
        "cloud-head",
        hubNamespace(namespace).key,
      ]);
      appendProfileJournal(
        store,
        {
          profileId: profile,
          kind: "local",
          origin: namespace.origin,
          bytes: 100,
          payload: {
            revision: 129,
            change: { op: "set", key: "save", value: "native-unuploaded" },
          },
        },
        "array",
      );
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const state = {
      revision: 128,
      snapshotRevision: 0,
      snapshotBytes: 0,
      restoreBytes: 100000,
      snapshot: null,
      journal: Array.from({ length: 128 }, (_, i) => ({
        revision: i + 1,
        mode: "journal",
        payload: {
          revision: i + 1,
          change: { op: "set", key: "save", value: "cloud-" + i },
        },
      })),
      receipts: {},
      commits: [],
    };
    const sha = async (text) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const cloud = {
      encode: encodePortableValue,
      receipt: async (id) => state.receipts[id] || null,
      stream: async () => ({ ...state }),
      writer: async () => ({
        epoch: 7,
        expiresAt: new Date(Date.now() + 90000).toISOString(),
      }),
      snapshot: async () => ({
        revision: state.revision,
        payload: compactProfileStream(indexedDB, namespace, state),
      }),
      commit: async (v) => {
        state.commits.push(v.mode);
        if (v.mode !== "snapshot") throw Error("expected snapshot");
        state.revision++;
        state.snapshotRevision = state.revision;
        state.receipts[v.idempotencyKey] = {
          acknowledged: true,
          namespace: JSON.parse(hubNamespace(namespace).key),
          mode: v.mode,
          revision: state.revision,
          payloadHash: await sha(
            JSON.stringify([
              hubNamespace(namespace).key,
              v.mode,
              v.baseRevision,
              await sha(JSON.stringify(v.payload)),
            ]),
          ),
        };
        state.snapshot = v.payload;
        state.journal = [];
        throw Error("lost response after COMMIT");
      },
    };
    const queue = nativeProfileQueue(indexedDB, profile);
    let error;
    try {
      await drainProfileQueue(queue, cloud);
    } catch (e) {
      error = e.message;
    }
    const pending = await queue.list(),
      plan = await queue.compaction(pending[0]),
      head = await queue.head(pending[0]);
    return { state, error, pending: pending.length, plan: !!plan, head };
  });
  assert.equal(first.error, "lost response after COMMIT");
  assert.equal(first.pending, 1);
  assert.equal(first.plan, true);
  assert.deepEqual(first.head, { revision: 128, epoch: 7 });
  await page.reload();
  const second = await page.evaluate(async (state) => {
    const { nativeProfileQueue, drainProfileQueue } = await import(
        "/profile-sync.ts"
      ),
      { profileDatabaseName } = await import("/profile-journal.ts"),
      { encodePortableValue } = await import("/hub-contracts.ts");
    const profile = "11111111-1111-4111-8111-111111111111",
      queue = nativeProfileQueue(indexedDB, profile),
      before = (await queue.list())[0];
    const cloud = {
      encode: encodePortableValue,
      receipt: async (id) => state.receipts[id] || null,
      stream: async () => ({
        revision: state.revision,
        snapshotRevision: state.snapshotRevision,
        restoreBytes: 1000,
        snapshotBytes: 1000,
      }),
      snapshot: async () => {
        throw Error("must use exact receipt");
      },
      writer: async () => ({
        epoch: 7,
        expiresAt: new Date(Date.now() + 90000).toISOString(),
      }),
      commit: async (v) => {
        if (v.mode !== "journal") throw Error("snapshot duplicated");
        state.commits.push(v.mode);
        state.revision++;
        return { acknowledged: true, revision: state.revision };
      },
    };
    const acknowledged = await drainProfileQueue(queue, cloud),
      pending = await queue.list(),
      plan = await queue.compaction(before),
      head = await queue.head(before);
    const db = await new Promise((resolve) => {
        const r = indexedDB.open(
          profileDatabaseName("atlas.browsing.v2", profile),
        );
        r.onsuccess = () => resolve(r.result);
      }),
      native = await new Promise((resolve) => {
        const r = db
          .transaction("origins")
          .objectStore("origins")
          .get("https://game.example");
        r.onsuccess = () => resolve(r.result);
      });
    db.close();
    return {
      acknowledged,
      pending: pending.length,
      plan,
      head,
      native,
      commits: state.commits,
    };
  }, first.state);
  assert.deepEqual(second, {
    acknowledged: 1,
    pending: 0,
    plan: null,
    head: { revision: 130, epoch: 7 },
    native: { revision: 129, entries: [["save", "native-unuploaded"]] },
    commits: ["snapshot", "journal"],
  });
  const native = await page.evaluate(async () => {
    const { compactProfileStream } = await import("/profile-compaction.ts"),
      { restoreProfileStream, exportProfileSnapshots } = await import(
        "/profile-store.ts"
      ),
      { encodePortableValue, decodePortableValue } = await import(
        "/hub-contracts.ts"
      ),
      { resolveProfileIDBDatabase } = await import("/profile-idb-catalog.ts");
    const profile = "22222222-2222-4222-8222-222222222222",
      namespace = {
        kind: "idb",
        origin: "https://game.example",
        name: "continuity",
      };
    const rich = {
      label: "first",
      binary: new Uint8Array([0, 255, 17]),
      blob: new Blob(["persisted blob"], { type: "text/plain" }),
      date: new Date("2026-10-21T12:00:00Z"),
      map: new Map([["k", 42n]]),
      set: new Set(["x", 3]),
    };
    rich.self = rich;
    const stream = {
      revision: 3,
      snapshotRevision: 0,
      snapshot: null,
      journal: [
        {
          revision: 1,
          mode: "journal",
          payload: {
            version: 1,
            changes: [
              {
                type: "schema",
                action: "createStore",
                store: "saves",
                options: { autoIncrement: true },
              },
              {
                type: "schema",
                action: "createIndex",
                store: "saves",
                index: "label",
                keyPath: "label",
                options: { unique: false },
              },
              {
                type: "record",
                action: "add",
                store: "saves",
                key: 1,
                args: [rich],
              },
              {
                type: "record",
                action: "put",
                store: "saves",
                key: 42,
                args: [{ label: "deleted" }],
              },
            ],
          },
        },
        {
          revision: 2,
          mode: "journal",
          payload: {
            version: 2,
            changes: [
              {
                type: "record",
                action: "delete",
                store: "saves",
                args: [
                  {
                    __atlasKeyRange: 1,
                    lower: 5,
                    upper: 50,
                    lowerOpen: false,
                    upperOpen: false,
                  },
                ],
              },
              {
                type: "schema",
                action: "renameIndex",
                store: "saves",
                index: "label",
                name: "by-label",
              },
              {
                type: "schema",
                action: "renameStore",
                store: "saves",
                name: "state",
              },
              {
                type: "schema",
                action: "createStore",
                store: "binary",
                options: {},
              },
              {
                type: "record",
                action: "put",
                store: "binary",
                key: new Uint8Array([1, 2, 3]).buffer,
                args: [new Uint16Array([4, 65535])],
              },
            ],
          },
        },
        {
          revision: 3,
          mode: "journal",
          payload: {
            version: 2,
            changes: [
              {
                type: "record",
                action: "add",
                store: "state",
                key: 43,
                args: [{ label: "last" }],
              },
            ],
          },
        },
      ],
    };
    const compacted = compactProfileStream(indexedDB, namespace, stream),
      decoded = decodePortableValue(await encodePortableValue(compacted));
    await restoreProfileStream(indexedDB, profile, namespace, decoded, [], {
      revision: 4,
      epoch: 9,
    });
    const physical = await resolveProfileIDBDatabase(
        indexedDB,
        profile,
        namespace.origin,
        namespace.name,
      ),
      db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(physical);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const tx = db.transaction(["state", "binary"], "readwrite"),
      store = tx.objectStore("state"),
      a = store.get(1),
      next = store.add({ label: "generated" }),
      binary = tx.objectStore("binary").get(new Uint8Array([1, 2, 3]).buffer),
      indexes = [...store.indexNames];
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const got = a.result,
      exported = await exportProfileSnapshots(indexedDB, profile);
    const deleted = compactProfileStream(indexedDB, namespace, {
      revision: 1,
      snapshotRevision: 0,
      snapshot: null,
      journal: [{ revision: 1, payload: { format: "atlas-idb-delete-v1" } }],
    });
    return {
      version: compacted.version,
      stores: compacted.stores.map((s) => s.name),
      records: compacted.stores
        .find((s) => s.name === "state")
        .records.map((r) => r.key),
      generator: compacted.stores.find((s) => s.name === "state").generator,
      next: next.result,
      indexes,
      binary: [...got.binary],
      blob: await got.blob.text(),
      date: got.date.toISOString(),
      bigint: String(got.map.get("k")),
      set: [...got.set],
      cycle: got.self === got,
      binaryKeyValue: [...binary.result],
      deleted: deleted.deleted,
      exported: exported.length,
    };
  });
  assert.deepEqual(native, {
    version: 2,
    stores: ["state", "binary"],
    records: [1, 43],
    generator: { next: 44 },
    next: 44,
    indexes: ["by-label"],
    binary: [0, 255, 17],
    blob: "persisted blob",
    date: "2026-10-21T12:00:00.000Z",
    bigint: "42",
    set: ["x", 3],
    cycle: true,
    binaryKeyValue: [4, 65535],
    deleted: true,
    exported: 1,
  });
  const cleanup = await page.evaluate(async () => {
    const { nativeProfileQueue } = await import("/profile-sync.ts"),
      { restoreProfileStream } = await import("/profile-store.ts"),
      { profileDatabaseName } = await import("/profile-journal.ts"),
      { hubNamespace } = await import("/hub-contracts.ts");
    const profile = "11111111-1111-4111-8111-111111111111",
      namespace = { kind: "local", origin: "https://game.example" },
      db = await new Promise((resolve) => {
        const r = indexedDB.open(
          profileDatabaseName("atlas.browsing.v2", profile),
        );
        r.onsuccess = () => resolve(r.result);
      });
    const tx = db.transaction("origins", "readwrite", { durability: "strict" });
    tx.objectStore("origins").put(
      {
        id: "compact-stale-intent",
        namespace,
        head: { revision: 128, epoch: 7 },
        payload: {},
      },
      ["cloud-compaction", hubNamespace(namespace).key],
    );
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
    await restoreProfileStream(
      indexedDB,
      profile,
      namespace,
      {
        format: "atlas-local-snapshot-v1",
        revision: 200,
        entries: [["save", "authoritative"]],
      },
      [],
      { revision: 200, epoch: 8 },
    );
    const change = {
      entry: { kind: "local", origin: namespace.origin },
      database: profileDatabaseName("atlas.browsing.v2", profile),
      store: "origins",
      arrayKeys: true,
    };
    const queue = nativeProfileQueue(indexedDB, profile);
    return {
      head: await queue.head(change),
      plan: await queue.compaction(change),
    };
  });
  assert.deepEqual(cleanup, { head: { revision: 200, epoch: 8 }, plan: null });
  const transactions = await page.evaluate(async () => {
    const { nativeProfileQueue } = await import("/profile-sync.ts");
    const { profileDatabaseName } = await import("/profile-journal.ts");
    const { restoreProfileStream } = await import("/profile-store.ts");
    const { hubNamespace } = await import("/hub-contracts.ts");
    const profile = "11111111-1111-4111-8111-111111111111",
      namespace = { kind: "local", origin: "https://game.example" };
    const change = {
      entry: { kind: "local", origin: namespace.origin },
      database: profileDatabaseName("atlas.browsing.v2", profile),
      store: "origins",
      arrayKeys: true,
    };
    const queue = nativeProfileQueue(indexedDB, profile),
      plan = {
        id: "compact-native-CAS-operation",
        namespace,
        head: { revision: 200, epoch: 8 },
        payload: { codec: "test-wire" },
      };
    let stalePrepareRejected = false,
      changedIntentRejected = false,
      staleEpochRejected = false;
    try {
      await queue.prepareCompaction(change, {
        ...plan,
        head: { revision: 199, epoch: 8 },
      });
    } catch {
      stalePrepareRejected = true;
    }
    await queue.prepareCompaction(change, plan);
    try {
      await queue.prepareCompaction(change, {
        ...plan,
        payload: { codec: "different-wire" },
      });
    } catch {
      changedIntentRejected = true;
    }
    const preservedIntent =
      JSON.stringify(await queue.compaction(change)) === JSON.stringify(plan);
    const db = await new Promise((resolve) => {
      const r = indexedDB.open(change.database);
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction("origins", "readwrite", { durability: "strict" });
    tx.objectStore("origins").put({ revision: 201, epoch: 9 }, [
      "cloud-head",
      hubNamespace(namespace).key,
    ]);
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });
    db.close();
    try {
      await queue.finishCompaction(change, plan);
    } catch {
      staleEpochRejected = true;
    }
    const fencedHead = await queue.head(change),
      pending = (await queue.list()).length;
    await restoreProfileStream(
      indexedDB,
      profile,
      namespace,
      {
        format: "atlas-local-snapshot-v1",
        revision: 300,
        entries: [["save", "authoritative"]],
      },
      [],
      { revision: 300, epoch: 10 },
    );
    return {
      stalePrepareRejected,
      changedIntentRejected,
      preservedIntent,
      staleEpochRejected,
      fencedHead,
      pending,
      obsoletePlan: await queue.compaction(change),
    };
  });
  assert.deepEqual(transactions, {
    stalePrepareRejected: true,
    changedIntentRejected: true,
    preservedIntent: true,
    staleEpochRejected: true,
    fencedHead: { revision: 201, epoch: 9 },
    pending: 0,
    obsoletePlan: null,
  });
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        browser: browser.version(),
        first: {
          error: first.error,
          pending: first.pending,
          plan: first.plan,
          head: first.head,
        },
        second,
        native,
        cleanup,
        transactions,
        transport:
          "deterministic in-process fake cloud; native Chromium IDB/portable codecs real",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app.close();
}
