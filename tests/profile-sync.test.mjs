import test from "node:test";
import assert from "node:assert/strict";
import { drainProfileQueue, changeNamespace } from "../runtime/profile-sync.ts";
import { encodePortableValue, hubNamespace } from "../runtime/hub-contracts.ts";
const change = {
  entry: {
    id: "transaction-00000001",
    profileId: "00000000-0000-0000-0000-000000000001",
    kind: "local",
    origin: "https://game.example",
    createdAt: 1,
    payload: { op: "set", key: "save", value: "42" },
    bytes: 40,
  },
  database: "fixture",
  store: "origins",
  key: ["outbox", "id"],
  arrayKeys: true,
};
function fixture(overrides = {}) {
  let removed = false,
    head = null;
  const queue = {
    list: async () => [change],
    head: async () => head,
    acknowledge: async (_c, h) => {
      removed = true;
      head = h;
    },
  };
  const cloud = {
    stream: async () => ({ revision: 0 }),
    writer: async () => ({
      epoch: 1,
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    }),
    commit: async () => ({ acknowledged: true, revision: 1 }),
    ...overrides,
  };
  return { queue, cloud, removed: () => removed };
}
test("only a positive remote transaction acknowledgement removes pending local data", async () => {
  const f = fixture();
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.equal(f.removed(), true);
});
test("network failure preserves durable pending entries", async () => {
  const f = fixture({
    commit: async () => {
      throw Error("offline");
    },
  });
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /offline/);
  assert.equal(f.removed(), false);
});
test("an unknown existing cloud head never becomes a blind overwrite", async () => {
  const f = fixture({ stream: async () => ({ revision: 9 }) });
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /RESTORE_REQUIRED/);
  assert.equal(f.removed(), false);
});
test("lost ownership keeps the offline branch rather than uploading it over another writer", async () => {
  const f = fixture();
  f.queue.head = async () => ({ revision: 0, epoch: 2 });
  await assert.rejects(
    drainProfileQueue(f.queue, f.cloud),
    /RECOVERY_REQUIRED/,
  );
  assert.equal(f.removed(), false);
});
test("missing or wrong acknowledgement is not reported as synced", async () => {
  for (const value of [
    { acknowledged: false, revision: 1 },
    { acknowledged: true, revision: 3 },
  ]) {
    const f = fixture({ commit: async () => value });
    await assert.rejects(drainProfileQueue(f.queue, f.cloud), /ACK_INVALID/);
    assert.equal(f.removed(), false);
  }
});
test("opaque or credential-bearing logical namespaces are rejected", () => {
  assert.throws(() =>
    changeNamespace({ ...change, entry: { ...change.entry, origin: "null" } }),
  );
  assert.throws(() =>
    changeNamespace({
      ...change,
      entry: { ...change.entry, origin: "https://user:secret@game.example" },
    }),
  );
});
const sha = async (value) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
async function receiptFor(c, base = 0) {
  const n = hubNamespace(changeNamespace(c));
  return {
    acknowledged: true,
    namespace: JSON.parse(n.key),
    mode: "journal",
    revision: base + 1,
    payloadHash: await sha(
      JSON.stringify([
        n.key,
        "journal",
        base,
        await sha(JSON.stringify(await encodePortableValue(c.entry.payload))),
      ]),
    ),
  };
}
test("a lost response is recovered from a matching receipt without a duplicate write", async () => {
  const f = fixture({
    receipt: async () => receiptFor(change),
    commit: async () => {
      throw Error("must not duplicate");
    },
  });
  f.queue.prepared = async () => ({ revision: 0, epoch: 7 });
  let head;
  f.queue.acknowledge = async (_c, h) => {
    head = h;
  };
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.deepEqual(head, { revision: 1, epoch: 7 });
});
test("a receipt without durable preparation never invents a writer epoch", async () => {
  const f = fixture({ receipt: async () => receiptFor(change) });
  await assert.rejects(
    drainProfileQueue(f.queue, f.cloud),
    /RECEIPT_UNPREPARED/,
  );
  assert.equal(f.removed(), false);
});
test("mismatched receipt payload, namespace or revision keeps the local journal", async () => {
  const receipt = await receiptFor(change);
  for (const corrupted of [
    { payloadHash: "0".repeat(64) },
    { namespace: ["local", "https://peer.example", ""] },
    { revision: 9 },
  ]) {
    const f = fixture({ receipt: async () => ({ ...receipt, ...corrupted }) });
    f.queue.prepared = async () => ({ revision: 0, epoch: 1 });
    await assert.rejects(
      drainProfileQueue(f.queue, f.cloud),
      /RECEIPT_INVALID/,
    );
    assert.equal(f.removed(), false);
  }
});
test("preparation is persisted before a remote write is attempted", async () => {
  const f = fixture();
  let prepared = null;
  f.queue.prepare = async (_c, h) => {
    prepared = h;
  };
  f.cloud.commit = async () => {
    assert.deepEqual(prepared, { revision: 0, epoch: 1 });
    throw Error("lost response");
  };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /lost response/);
  assert.equal(f.removed(), false);
});
test("invalid or expired writer deadlines preserve pending changes", async () => {
  for (const expiresAt of [
    "not-a-deadline",
    new Date(Date.now() - 1).toISOString(),
  ]) {
    const f = fixture({ writer: async () => ({ epoch: 1, expiresAt }) });
    await assert.rejects(drainProfileQueue(f.queue, f.cloud), /WRITER_EXPIRED/);
    assert.equal(f.removed(), false);
  }
});
test("a cookie journal spanning unrelated domains is held rather than put into the wrong site's stream", () => {
  const cookie = (domains) => ({
    ...change,
    entry: {
      ...change.entry,
      kind: "cookies",
      payload: {
        changes: domains.map((domain) => ({
          op: "delete",
          cookie: { domain },
        })),
      },
    },
  });
  assert.doesNotThrow(() =>
    changeNamespace(cookie(["game.example", "sub.game.example"])),
  );
  assert.throws(
    () => changeNamespace(cookie(["game.example", "other.example"])),
    /COOKIE_PARTITION_REQUIRED/,
  );
});

test('worker-produced metadata can never be silently encoded as a missing journal payload',async()=>{
 const c={entry:{id:'metadata-change',kind:'local',origin:'https://game.example',payload:undefined},database:'native',store:'meta',key:'change',arrayKeys:false,payloadOmitted:true,namespace:{kind:'local',origin:'https://game.example'}};
 const queue={list:async()=>[c],head:async()=>null};
 await assert.rejects(drainProfileQueue(queue,{writer:async()=>{throw Error('Unexpected writer')},stream:async()=>{throw Error('Unexpected stream')},commit:async()=>{throw Error('Unexpected commit')}}),/PROFILE_QUEUE_PAYLOAD_REQUIRED/);
 assert.equal(changeNamespace(c).origin,'https://game.example');assert.throws(()=>changeNamespace({...c,namespace:{kind:'local',origin:'https://different.example'}}),/REFERENCE_INVALID/);
});
