/** Actual Chromium, two frontend origins: portable snapshots, replay, atomic
 * replacement, native key generators, and recoverable logical DB deletion. */
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r.type("text/html").send("<!doctype html><title>Profile store proof</title>"),
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
  const origin = await app.listen({ port: 0, host: "0.0.0.0" }),
    port = new URL(origin).port;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const old = await browser.newPage();
  await old.goto("http://127.0.0.1:" + port);
  const exported = await old.evaluate(async () => {
    const { SandboxCookieJar } = await import("/sandbox-cookies.ts"),
      { exportProfileSnapshots } = await import("/profile-store.ts"),
      { encodePortableValue } = await import("/hub-contracts.ts"),
      { PROFILE_IDB_KEEP, profileIDBPrefix } = await import(
        "/profile-journal.ts"
      );
    const open = (name, version, setup) =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open(name, version);
          r.onupgradeneeded = () => setup(r.result, r.transaction);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        }),
      done = (tx) =>
        new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onabort = () => rej(tx.error);
        });
    let db = await open("atlas.browsing.v2", 1, (d) =>
      d.createObjectStore("origins"),
    );
    let tx = db.transaction("origins", "readwrite");
    tx.objectStore("origins").put(
      { revision: 3, entries: [["score", "55"]] },
      "https://game.example",
    );
    tx.objectStore("origins").put(
      { revision: 1, entries: [["do-not-import", "session"]] },
      ["session", "old", "https://game.example"],
    );
    await done(tx);
    db.close();
    localStorage.setItem("https://game.example@legacy-save", "native-value");
    localStorage.setItem("atlas.admin.fixture-token", "must-not-export");
    db = await open("https://game.example@old-native", 2, (d) =>
      d.createObjectStore("legacy"),
    );
    tx = db.transaction("legacy", "readwrite");
    tx.objectStore("legacy").put("native-record", "legacy-key");
    await done(tx);
    db.close();
    db = await open("__scramjet_controller", 1, (d) =>
      d.createObjectStore("state"),
    );
    tx = db.transaction("state", "readwrite");
    tx.objectStore("state").put(
      {
        updatedAt: Date.now() - 100,
        cookies: JSON.stringify({
          fixture: {
            name: "old-cookie",
            value: "native-cookie",
            domain: ".game.example",
            hostOnly: true,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
          },
        }),
      },
      "cookies",
    );
    await done(tx);
    db.close();
    db = await open(
      profileIDBPrefix("https://game.example") + "save",
      3,
      (d) => {
        d.createObjectStore(PROFILE_IDB_KEEP);
        const s = d.createObjectStore("players", {
          keyPath: "id",
          autoIncrement: true,
        });
        s.createIndex("email", "email", { unique: true });
        s.createIndex("tags", "tags", { multiEntry: true });
      },
    );
    tx = db.transaction("players", "readwrite");
    let s = tx.objectStore("players");
    s.add({
      id: 1,
      email: "one@example.test",
      tags: ["a", "b"],
      blob: new Blob(["native-blob"], { type: "text/plain" }),
    });
    s.add({ id: 99, email: "gone@example.test" });
    s.delete(99);
    await done(tx);
    db.close();
    const jar = new SandboxCookieJar({
      factory: indexedDB,
      browserSessionId: "legacy-session-123456",
      forbiddenOrigins: [location.origin],
    });
    await jar.storeResponseCookies(
      [
        "auth=secret-fixture; Secure; HttpOnly; SameSite=None; Path=/",
        "theme=green; Secure; Path=/",
      ],
      {
        requestURL: "https://game.example/",
        documentURL: "https://game.example/",
        topLevelURL: "https://game.example/",
      },
    );
    await jar.close();
    const snapshots = await exportProfileSnapshots(indexedDB, null);
    return await Promise.all(
      snapshots.map(async (e) => ({
        namespace: e.namespace,
        payload: await encodePortableValue(e.payload),
      })),
    );
  });
  assert.equal(exported.length, 4);
  assert.equal(JSON.stringify(exported).includes("must-not-export"), false);
  const page = await browser.newPage();
  await page.goto("http://localhost:" + port);
  const result = await page.evaluate(async (entries) => {
    const p = await import("/profile-store.ts"),
      c = await import("/profile-idb-catalog.ts"),
      j = await import("/profile-journal.ts"),
      codec = await import("/hub-contracts.ts"),
      idb = await import("/sandbox-idb.ts"),
      permissions = await import("/profile-permissions.ts"),
      cookies = await import("/sandbox-cookies.ts");
    const id = "11111111-1111-4111-8111-111111111111",
      contextId = "trusted-context-123456",
      origin = "https://game.example";
    for (const e of entries)
      await p.restoreProfileStream(
        indexedDB,
        id,
        e.namespace,
        codec.decodePortableValue(e.payload),
        [],
        { revision: 1, epoch: 1 },
      );
    await permissions.setProfilePermit(indexedDB, {
      profileId: id,
      group: codec.hubSiteGroup(origin),
      contextId,
      epoch: 1,
      expiresAt: Date.now() + 90000,
      offline: false,
      revoked: false,
    });
    const snapshots = await p.exportProfileSnapshots(indexedDB, id),
      dbsnap = snapshots.find((e) => e.namespace.kind === "idb" && e.namespace.name === "save").payload;
    const ns = { kind: "idb", origin, name: "save" },
      journals = [
        {
          revision: 2,
          mode: "journal",
          payload: {
            version: 4,
            changes: [
              {
                type: "schema",
                action: "createStore",
                store: "more",
                options: { keyPath: null },
              },
              {
                type: "schema",
                action: "createIndex",
                store: "players",
                index: "extra",
                keyPath: "email",
                options: {},
              },
              {
                type: "operation",
                action: "put",
                store: "players",
                key: 300,
                args: [{ id: 300, email: "temporary@example.test" }, 300],
              },
              {
                type: "operation",
                action: "delete",
                store: "players",
                args: [300],
              },
            ],
          },
        },
      ];
    await p.restoreProfileStream(indexedDB, id, ns, dbsnap, journals, {
      revision: 2,
      epoch: 1,
    });
    let alias = (await c.listProfileIDBDatabases(indexedDB, id)).find(
      (e) => e.name === "save",
    );
    const before = alias.physical;
    const bad = structuredClone(dbsnap);
    bad.stores[0].records.push({
      key: 2,
      value: { id: 2, email: "one@example.test" },
    });
    let atomicError = "";
    try {
      await p.restoreProfileStream(indexedDB, id, ns, bad, [], {
        revision: 3,
        epoch: 1,
      });
    } catch (e) {
      atomicError = e.name;
    }
    alias = (await c.listProfileIDBDatabases(indexedDB, id)).find(
      (e) => e.name === "save",
    );
    const pointerPreserved = alias.physical === before;
    const channel = new MessageChannel(),
      binding = idb.bindSandboxIndexedDB({
        port: channel.port1,
        documentId: "profile_store_document",
        website: origin,
        frontendOrigin: location.origin,
        factory: indexedDB,
        profileId: id,
        profileContextId: contextId,
      }),
      facade = idb.createSandboxIndexedDB(
        channel.port2,
        "profile_store_document",
      );
    const db = await new Promise((res, rej) => {
      const r = facade.open("save", 4);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const done = (tx) =>
      new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onabort = () => rej(tx.error);
      });
    let tx = db.transaction("players", "readonly"),
      s = tx.objectStore("players"),
      lookup = s.index("email").get("one@example.test"),
      complete = done(tx);
    const record = await new Promise((res, rej) => {
      lookup.onsuccess = () => res(lookup.result);
      lookup.onerror = () => rej(lookup.error);
    });
    await complete;
    const blob = await record.blob.text();
    tx = db.transaction("players", "readwrite");
    const added = tx.objectStore("players").add({ email: "two@example.test" }),
      key = await new Promise((res, rej) => {
        added.onsuccess = () => res(added.result);
        added.onerror = () => rej(added.error);
      });
    await done(tx);
    await permissions.setProfilePermit(indexedDB,{profileId:id,group:codec.hubSiteGroup(origin),contextId:'newer-context-owner',epoch:2,expiresAt:Date.now()+90000,offline:false,revoked:false});
    const stale=db.transaction('players','readwrite');stale.objectStore('players').put({id:999,email:'must-not-save@example.test'});let staleDenied=false;try{await done(stale);}catch{staleDenied=true;}
    await permissions.setProfilePermit(indexedDB,{profileId:id,group:codec.hubSiteGroup(origin),contextId,epoch:1,expiresAt:Date.now()-1,offline:true,revoked:false});
    const offline=db.transaction('players','readwrite'),offlineRequest=offline.objectStore('players').add({email:'offline-save@example.test'}),offlineKey=await new Promise((resolve,reject)=>{offlineRequest.onsuccess=()=>resolve(offlineRequest.result);offlineRequest.onerror=()=>reject(offlineRequest.error);});await done(offline);
    db.close();
    await binding.flush();
    binding.dispose();
    await c.deleteProfileIDBDatabase(indexedDB, id, origin, "save");
    const afterDelete = await c.listProfileIDBDatabases(indexedDB, id),
      catalog = await c.openProfileCatalog(indexedDB, id);
    let rows = await new Promise((res, rej) => {
      const tx = catalog.transaction("meta"),
        r = tx.objectStore("meta").getAll();
      tx.oncomplete = () => res(r.result);
      tx.onabort = () => rej(tx.error);
    });
    catalog.close();
    const preserved = rows
      .filter((x) => x?.kind === "idb")
      .map((x) => x.payload);
    const tombstone = preserved.find((x) => x.deleted),
      deleted = afterDelete.find((x) => x.name === "save").deleted === true,
      journalPreserved = preserved.some((x) =>
        x.changes?.some((c) => c.key === 301),
      );
    let pendingBlocked = false;
    try {
      await p.restoreProfileStream(indexedDB, id, ns, dbsnap, [], {
        revision: 3,
        epoch: 1,
      });
    } catch (e) {
      pendingBlocked = e.message === "PROFILE_PENDING_LOCAL_WRITES";
    }
    // Model cloud acknowledgements before applying the next canonical stream.
    const ackCatalog = await c.openProfileCatalog(indexedDB, id);
    await new Promise((resolve, reject) => {
      const tx = ackCatalog.transaction("meta", "readwrite"),
        store = tx.objectStore("meta"),
        r = store.getAllKeys();
      r.onsuccess = () => {
        for (const k of r.result)
          if (typeof k === "string" && k.startsWith(j.PROFILE_OUTBOX_PREFIX))
            store.delete(k);
        store.put(0, j.PROFILE_OUTBOX_BYTES);
      };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    ackCatalog.close();
    // Applying the cloud tombstone then a version-one upgrade must really reset
    // the version and generator, without exposing the retired physical database.
    await p.restoreProfileStream(
      indexedDB,
      id,
      ns,
      {
        format: "atlas-idb-snapshot-v1",
        version: 0,
        stores: [],
        deleted: true,
      },
      [
        {
          revision: 4,
          payload: {
            version: 1,
            changes: [
              {
                type: "schema",
                action: "createStore",
                store: "new",
                options: { autoIncrement: true },
              },
              {
                type: "operation",
                action: "add",
                store: "new",
                key: 1,
                args: ["fresh"],
              },
            ],
          },
        },
      ],
      { revision: 4, epoch: 2 },
    );
    const final = (await p.exportProfileSnapshots(indexedDB, id)).find(
      (e) => e.namespace.kind === "idb" && e.namespace.name === "save",
    ).payload;
    const jar = new cookies.SandboxCookieJar({
      factory: indexedDB,
      profileId: id,
      profileContextId: contextId,
      browserSessionId: "another-branch-session",
      forbiddenOrigins: [location.origin],
    });
    const header = await jar.getRequestHeader({
      requestURL: origin + "/",
      documentURL: origin + "/",
      topLevelURL: origin + "/",
    });
    await jar.close();
    const peerId = "22222222-2222-4222-8222-222222222222";
    const peer = await new Promise((resolve, reject) => {
      const r = indexedDB.open(
        j.profileDatabaseName("atlas.browsing.v2", peerId),
        1,
      );
      r.onupgradeneeded = () => r.result.createObjectStore("origins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    let peerTx = peer.transaction("origins", "readwrite");
    peerTx
      .objectStore("origins")
      .put({ revision: 1, entries: [["score", "peer"]] }, origin);
    await done(peerTx);
    peer.close();
    await p.clearProfileWebsiteData(indexedDB, id, contextId);
    const cleared = await p.exportProfileSnapshots(indexedDB, id),
      peerSaved = await p.exportProfileSnapshots(indexedDB, peerId),
      queue = await import("/profile-sync.ts"),
      clearKinds = [
        ...new Set(
          (await queue.nativeProfileQueue(indexedDB, id).list()).map(
            (e) => e.entry.kind,
          ),
        ),
      ].sort();
    return {
      local: snapshots.find((e) => e.namespace.kind === "local").payload
        .entries,
      sourceNext: dbsnap.stores[0].generator.next,
      blob,
      indexes: dbsnap.stores[0].indexes.map((i) => i.name),
      key,
      staleDenied,
      offlineKey,
      atomicError,
      pointerPreserved,
      pendingBlocked,
      deleted,
      journalPreserved,
      tombstone: !!tombstone,
      finalVersion: final.version,
      finalRecord: final.stores[0].records[0].value,
      finalNext: final.stores[0].generator.next,
      header,
      clearedLocal: cleared.find((e) => e.namespace.kind === "local").payload
        .entries,
      clearedIDB: cleared.find((e) => e.namespace.kind === "idb" && e.namespace.name === "save").payload
        .deleted,
      clearedCookies: cleared.some((e) => e.namespace.kind === "cookies"),
      peerSaved: peerSaved.find((e) => e.namespace.kind === "local").payload
        .entries,
      clearKinds,
    };
  }, exported);
  assert.deepEqual(Object.fromEntries(result.local), {
    score: "55",
    "legacy-save": "native-value",
  });
  assert.equal(result.sourceNext, 100);
  assert.equal(result.blob, "native-blob");
  assert.deepEqual(result.indexes, ["email", "tags"]);
  assert.equal(result.key, 301);
  assert.equal(result.staleDenied,true);
  assert.equal(result.offlineKey,302);
  assert.equal(result.atomicError, "ConstraintError");
  assert.equal(result.pointerPreserved, true);
  assert.equal(result.pendingBlocked, true);
  assert.equal(result.deleted, true);
  assert.equal(result.journalPreserved, true);
  assert.equal(result.tombstone, true);
  assert.equal(result.finalVersion, 1);
  assert.equal(result.finalRecord, "fresh");
  assert.equal(result.finalNext, 2);
  assert.match(result.header, /auth=secret-fixture/);
  assert.match(result.header, /theme=green/);
  assert.match(result.header, /old-cookie=native-cookie/);
  assert.deepEqual(result.clearedLocal, []);
  assert.equal(result.clearedIDB, true);
  assert.equal(result.clearedCookies, false);
  assert.deepEqual(result.peerSaved, [["score", "peer"]]);
  assert.deepEqual(result.clearKinds, ["cookies", "idb", "local"]);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: 15,
        observed: {
          ...result,
          header: "exportable HttpOnly and session cookies restored",
        },
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app.close();
}
