import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { hubNamespace } from "../runtime/hub-contracts.ts";
const { drainProfileQueue } = await import(
  process.env.PROFILE_SYNC_SOURCE
    ? pathToFileURL(process.env.PROFILE_SYNC_SOURCE).href
    : "../runtime/profile-sync.ts"
);

function fixture() {
  const change = {
    entry: {
      id: "transaction-receipt-0001",
      profileId: "00000000-0000-0000-0000-000000000001",
      kind: "local",
      origin: "https://game.example",
      createdAt: 1,
      payload: { op: "set", key: "save", value: "42" },
      bytes: 40,
    },
    database: "fixture", store: "origins", key: ["outbox", "id"], arrayKeys: true,
  };
  const state = {
    changes: [change], head: { revision: 0, epoch: 7 }, prepared: null,
    revision: 0, receipt: null,
  };
  const calls = { receipt: 0, stream: 0, writer: 0, commit: 0, prepare: 0, acknowledge: 0 };
  const queue = {
    list: async () => [...state.changes],
    head: async () => structuredClone(state.head),
    prepared: async () => structuredClone(state.prepared),
    prepare: async (_change, head) => {
      calls.prepare++;
      state.prepared = structuredClone(head);
    },
    acknowledge: async (_change, head) => {
      calls.acknowledge++;
      state.changes = []; state.prepared = null; state.head = structuredClone(head);
    },
  };
  const sha = async value => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
  const cloud = {
    receipt: async () => { calls.receipt++; return state.receipt; },
    stream: async () => { calls.stream++; return { revision: state.revision }; },
    writer: async () => { calls.writer++; return { epoch: 7, expiresAt: new Date(Date.now() + 90000).toISOString() }; },
    commit: async input => {
      calls.commit++;
      assert.deepEqual(state.prepared, { revision: input.baseRevision, epoch: input.epoch }, "preparation must already be durable");
      state.revision++;
      state.receipt = {
        acknowledged: true,
        namespace: JSON.parse(hubNamespace(input.namespace).key), mode: "journal",
        revision: state.revision,
        payloadHash: await sha(JSON.stringify([hubNamespace(input.namespace).key, "journal", input.baseRevision, await sha(JSON.stringify(input.payload))])),
      };
      return { acknowledged: true, revision: state.revision };
    },
  };
  return { queue, cloud, state, calls };
}

test("fresh durable changes perform no receipt HTTP preflight and retain head/writer/commit checks", async () => {
  const f = fixture();
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.deepEqual(f.calls, { receipt: 0, stream: 1, writer: 1, commit: 1, prepare: 1, acknowledge: 1 });
  assert.equal(f.state.changes.length, 0);
});

test("lost commit response survives a restarted drain and recovers its receipt after ownership changes", async () => {
  const f = fixture(), commit = f.cloud.commit;
  f.cloud.commit = async input => { await commit(input); throw Error("connection lost after commit"); };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /connection lost after commit/);
  assert.deepEqual(f.state.prepared, { revision: 0, epoch: 7 });
  assert.equal(f.state.changes.length, 1);
  // A new queue facade models reopening around the same durable preparation.
  const reopened = { ...f.queue };
  f.cloud.stream = async () => { throw Error("must not restore an already committed write"); };
  f.cloud.writer = async () => { throw Error("ownership changed after commit"); };
  assert.equal(await drainProfileQueue(reopened, f.cloud), 1);
  assert.equal(f.calls.receipt, 1, "only the uncertain retry probes its receipt");
  assert.equal(f.calls.commit, 1, "the acknowledged remote write is never repeated");
  assert.deepEqual(f.state.head, { revision: 1, epoch: 7 });
});

test("fresh receipt optimization never bypasses an unknown remote head", async () => {
  const f = fixture();
  f.state.head = null; f.state.revision = 4;
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /PROFILE_RESTORE_REQUIRED/);
  assert.equal(f.calls.receipt, 0);
  assert.equal(f.calls.commit, 0);
  assert.equal(f.calls.acknowledge, 0);
  assert.equal(f.state.changes.length, 1);
});

test("failed preparation prevents commit and preserves the pending save", async () => {
  const f = fixture();
  f.queue.prepare = async () => { throw Error("local disk write failed"); };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /local disk write failed/);
  assert.equal(f.calls.receipt, 0);
  assert.equal(f.calls.commit, 0);
  assert.equal(f.calls.acknowledge, 0);
  assert.equal(f.state.changes.length, 1);
});

test("a prepared receipt miss still rejects changed writer epochs", async () => {
  const f = fixture();
  f.state.prepared = { revision: 0, epoch: 7 };
  f.cloud.writer = async () => ({ epoch: 8, expiresAt: new Date(Date.now() + 90000).toISOString() });
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /PROFILE_RECOVERY_REQUIRED/);
  assert.equal(f.calls.receipt, 1);
  assert.equal(f.calls.commit, 0);
  assert.equal(f.state.changes.length, 1);
});

test("legacy queues without both preparation methods keep their receipt checks", async () => {
  for (const missing of ["prepared", "prepare"]) {
    const f = fixture();
    delete f.queue[missing];
    f.cloud.commit = async () => ({ acknowledged: true, revision: 1 });
    assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
    assert.equal(f.calls.receipt, 1, missing + " is not proof of a fresh operation");
  }
});
