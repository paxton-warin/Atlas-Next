import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { compactProfileStream } from "../runtime/profile-compaction.ts";
import {
  needsProfileCompaction,
  portableWireBytes,
} from "../runtime/profile-compaction-sync.ts";
import {
  hubNamespace,
  encodePortableValue,
  decodePortableValue,
  HUB_LIMITS,
} from "../runtime/hub-contracts.ts";
const { drainProfileQueue } = await import(
  process.env.PROFILE_SYNC_SOURCE
    ? pathToFileURL(process.env.PROFILE_SYNC_SOURCE).href
    : "../runtime/profile-sync.ts"
);
const namespace = { kind: "local", origin: "https://game.example" };
const sha = async (text) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toString("hex");
const change = (n = 1) => ({
  entry: {
    id: "durable-transaction-" + n,
    sequence: n,
    profileId: "11111111-1111-4111-8111-111111111111",
    kind: "local",
    origin: namespace.origin,
    createdAt: n,
    bytes: 60,
    payload: {
      revision: n + 128,
      change: { op: "set", key: "save", value: "pending-" + n },
    },
  },
  database: "db",
  store: "origins",
  key: ["outbox", "" + n],
  arrayKeys: true,
});
function fixture() {
  const changes = [change()];
  let head = { revision: 128, epoch: 7 },
    plan = null;
  const prepared = new Map(),
    receipts = new Map(),
    calls = [];
  const state = {
    revision: 128,
    snapshotRevision: 0,
    restoreBytes: 100000,
    snapshotBytes: 0,
    snapshot: null,
    journal: Array.from({ length: 128 }, (_, i) => ({
      revision: i + 1,
      mode: "journal",
      payload: {
        revision: i + 1,
        change: { op: "set", key: "save", value: "ack-" + i },
      },
    })),
  };
  const queue = {
    list: async () => [...changes],
    head: async () => structuredClone(head),
    prepared: async (c) => prepared.get(c.entry.id) || null,
    prepare: async (c, h) => {
      if (prepared.has(c.entry.id))
        assert.deepEqual(prepared.get(c.entry.id), h);
      prepared.set(c.entry.id, structuredClone(h));
    },
    acknowledge: async (c, h) => {
      const i = changes.findIndex((x) => x.entry.id === c.entry.id);
      if (i >= 0) changes.splice(i, 1);
      head = structuredClone(h);
      prepared.delete(c.entry.id);
    },
    compaction: async () => structuredClone(plan),
    prepareCompaction: async (_c, p) => {
      assert.deepEqual(head, p.head);
      assert.equal(plan, null);
      plan = structuredClone(p);
    },
    finishCompaction: async (_c, p) => {
      assert.deepEqual(plan, p);
      assert.deepEqual(head, p.head);
      head = { revision: p.head.revision + 1, epoch: p.head.epoch };
      plan = null;
    },
  };
  const cloud = {
    encode: encodePortableValue,
    receipt: async (id) => receipts.get(id) || null,
    stream: async () => ({ ...state }),
    writer: async () => ({
      epoch: 7,
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    }),
    snapshot: async (_n, expected) => {
      calls.push("reduce");
      assert.equal(state.revision, expected);
      return {
        revision: state.revision,
        payload: compactProfileStream({}, namespace, structuredClone(state)),
      };
    },
    commit: async (v) => {
      calls.push(v.mode);
      assert.equal(v.baseRevision, state.revision);
      assert.equal(v.epoch, 7);
      state.revision++;
      const decoded = decodePortableValue(v.payload);
      if (v.mode === "snapshot") {
        state.snapshot = decoded;
        state.snapshotRevision = state.revision;
        state.journal = [];
        state.snapshotBytes = portableWireBytes(v.payload);
        state.restoreBytes = state.snapshotBytes;
      } else {
        state.journal.push({
          revision: state.revision,
          mode: "journal",
          payload: decoded,
        });
        state.restoreBytes += portableWireBytes(v.payload);
      }
      receipts.set(v.idempotencyKey, {
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
      });
      return { acknowledged: true, revision: state.revision };
    },
  };
  return {
    queue,
    cloud,
    changes,
    state,
    prepared,
    receipts,
    calls,
    head: () => head,
    plan: () => plan,
  };
}
test("automatic checkpoint folds128 ACKed journals before next durable change, then drains normally", async () => {
  const f = fixture();
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.deepEqual(f.calls, ["reduce", "snapshot", "journal"]);
  assert.equal(f.state.snapshotRevision, 129);
  assert.equal(f.state.revision, 130);
  assert.deepEqual(f.state.snapshot.entries, [["save", "ack-127"]]);
  assert.equal(f.changes.length, 0);
  assert.equal(f.plan(), null);
  assert.deepEqual(f.head(), { revision: 130, epoch: 7 });
});
test("small streams never upload a snapshot on each key write", async () => {
  const f = fixture();
  f.state.revision = 1;
  f.state.journal = f.state.journal.slice(0, 1);
  f.queue.head = async () => ({ revision: 1, epoch: 7 });
  f.queue.acknowledge = async () => {};
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.deepEqual(f.calls, ["journal"]);
});
test("byte trigger includes chunk-expanded bytes and incoming payload before crossing restore allowance", () => {
  assert.equal(
    needsProfileCompaction(
      {
        revision: 2,
        snapshotRevision: 1,
        restoreBytes: 120 * 1024 * 1024,
        snapshotBytes: 119 * 1024 * 1024,
      },
      10 * 1024 * 1024,
    ),
    true,
  );
  assert.equal(
    needsProfileCompaction(
      {
        revision: 1,
        snapshotRevision: 1,
        restoreBytes: 120 * 1024 * 1024,
        snapshotBytes: 120 * 1024 * 1024,
      },
      1,
    ),
    false,
  );
  assert.equal(
    needsProfileCompaction(
      {
        revision: 3,
        snapshotRevision: 1,
        restoreBytes: 20 * 1024 * 1024,
        snapshotBytes: 2 * 1024 * 1024,
      },
      1,
    ),
    true,
  );
  assert.equal(
    portableWireBytes({ codec: "atlas-chunks-v1", bytes: 17 * 1024 * 1024 }),
    17 * 1024 * 1024,
  );
  assert.throws(
    () =>
      portableWireBytes({
        codec: "atlas-chunks-v1",
        bytes: HUB_LIMITS.streamBytes + 1,
      }),
    /SIZE_EXCEEDED/,
  );
  assert.throws(
    () =>
      needsProfileCompaction(
        { revision: 1, snapshotRevision: 2, restoreBytes: 0, snapshotBytes: 0 },
        0,
      ),
    /METADATA_INVALID/,
  );
});
test("lost snapshot response survives a new drain and exact receipt advances only head, not native pending data", async () => {
  const f = fixture(),
    commit = f.cloud.commit;
  let lost = true;
  f.cloud.commit = async (v) => {
    const ack = await commit(v);
    if (v.mode === "snapshot" && lost) {
      lost = false;
      throw Error("lost snapshot response");
    }
    return ack;
  };
  await assert.rejects(
    drainProfileQueue(f.queue, f.cloud),
    /lost snapshot response/,
  );
  assert.equal(f.changes.length, 1);
  assert.equal(f.head().revision, 128);
  assert.ok(f.plan());
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.equal(f.calls.filter((c) => c === "snapshot").length, 1);
  assert.equal(f.changes.length, 0);
  assert.equal(f.head().revision, 130);
});
test("crash after positive snapshot ACK but before local head transaction resumes without another remote write", async () => {
  const f = fixture(),
    finish = f.queue.finishCompaction;
  let crash = true;
  f.queue.finishCompaction = async (...a) => {
    if (crash) {
      crash = false;
      throw Error("local transaction aborted");
    }
    return finish(...a);
  };
  await assert.rejects(
    drainProfileQueue(f.queue, f.cloud),
    /transaction aborted/,
  );
  assert.equal(f.head().revision, 128);
  assert.equal(f.changes.length, 1);
  assert.ok(f.plan());
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.equal(f.calls.filter((c) => c === "snapshot").length, 1);
});
test("uncommitted snapshot plan refreshes same payload/chunks and retries same immutable id", async () => {
  const f = fixture(),
    commit = f.cloud.commit;
  let offline = true;
  const ids = [];
  f.cloud.commit = async (v) => {
    if (v.mode === "snapshot") {
      ids.push(v.idempotencyKey);
      if (offline) {
        offline = false;
        throw Error("offline");
      }
    }
    return commit(v);
  };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /offline/);
  assert.equal(f.changes.length, 1);
  assert.ok(f.plan());
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.calls.filter((c) => c === "reduce").length, 2);
});
test("changed canonical source during resumed upload leaves durable plan and pending change untouched", async () => {
  const f = fixture();
  f.cloud.commit = async () => {
    throw Error("offline");
  };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /offline/);
  f.cloud.snapshot = async () => ({
    revision: 128,
    payload: {
      format: "atlas-local-snapshot-v1",
      revision: 128,
      entries: [["save", "different"]],
    },
  });
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /SOURCE_CHANGED/);
  assert.equal(f.changes.length, 1);
  assert.equal(f.head().revision, 128);
  assert.ok(f.plan());
});
test("stale writer epoch/CAS and bad snapshot acknowledgement never retire local journal", async () => {
  for (const mutation of ["epoch", "cas", "ack"]) {
    const f = fixture();
    if (mutation === "epoch")
      f.cloud.writer = async () => ({
        epoch: 8,
        expiresAt: new Date(Date.now() + 90000).toISOString(),
      });
    if (mutation === "cas")
      f.cloud.snapshot = async () => {
        f.state.revision++;
        return {
          revision: 128,
          payload: {
            format: "atlas-local-snapshot-v1",
            revision: 128,
            entries: [],
          },
        };
      };
    if (mutation === "ack")
      f.cloud.commit = async () => ({ acknowledged: false, revision: 129 });
    await assert.rejects(
      drainProfileQueue(f.queue, f.cloud),
      /RECOVERY_REQUIRED|REVISION_CONFLICT|ACK_INVALID/,
    );
    assert.equal(f.changes.length, 1);
    assert.equal(f.head().revision, 128);
  }
});
test("forged compaction receipt cannot advance head or clear data", async () => {
  const f = fixture(),
    commit = f.cloud.commit;
  f.cloud.commit = async (v) => {
    await commit(v);
    throw Error("lost");
  };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /lost/);
  f.receipts.get(f.plan().id).payloadHash = "0".repeat(64);
  await assert.rejects(
    drainProfileQueue(f.queue, f.cloud),
    /COMPACTION_RECEIPT_INVALID/,
  );
  assert.equal(f.head().revision, 128);
  assert.equal(f.changes.length, 1);
});
test("an unresolved prepared journal is never silently rebased into a different operation", async () => {
  const f = fixture();
  f.prepared.set(f.changes[0].entry.id, { revision: 128, epoch: 7 });
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.deepEqual(f.calls, ["journal"]);
});
test("new native transactions during reduction stay pending and are not included or retired", async () => {
  const f = fixture(),
    snapshot = f.cloud.snapshot;
  f.cloud.snapshot = async (...a) => {
    f.changes.push(change(2));
    return snapshot(...a);
  };
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].entry.id, "durable-transaction-2");
  assert.deepEqual(f.state.snapshot.entries, [["save", "ack-127"]]);
  assert.equal(await drainProfileQueue(f.queue, f.cloud), 1);
  assert.equal(f.changes.length, 0);
});
test("snapshot quota failure preserves native data, outbox and prepared immutable compaction", async () => {
  const f = fixture();
  f.cloud.commit = async () => {
    throw Object.assign(Error("canonical snapshot quota exceeded"), {
      code: "HUB_QUOTA",
    });
  };
  await assert.rejects(drainProfileQueue(f.queue, f.cloud), /quota/);
  assert.equal(f.changes.length, 1);
  assert.equal(f.head().revision, 128);
  assert.ok(f.plan());
});
test("local pure reduction preserves removals/clear and rejects gaps/partial histories without mutating inputs", () => {
  const stream = {
    revision: 4,
    snapshotRevision: 1,
    snapshot: {
      format: "atlas-local-snapshot-v1",
      revision: 1,
      entries: [["old", "v"]],
    },
    journal: [
      {
        revision: 2,
        payload: { revision: 2, change: { op: "remove", key: "old" } },
      },
      { revision: 3, payload: { revision: 3, change: { op: "clear" } } },
      {
        revision: 4,
        payload: {
          revision: 4,
          change: { op: "set", key: "now", value: "yes" },
        },
      },
    ],
  };
  const before = structuredClone(stream);
  assert.deepEqual(compactProfileStream({}, namespace, stream), {
    format: "atlas-local-snapshot-v1",
    revision: 4,
    entries: [["now", "yes"]],
  });
  assert.deepEqual(stream, before);
  assert.throws(
    () =>
      compactProfileStream({}, namespace, {
        ...stream,
        journal: stream.journal.slice(1),
      }),
    /STREAM_INVALID/,
  );
  assert.throws(
    () =>
      compactProfileStream({}, namespace, {
        ...stream,
        journal: [
          { ...stream.journal[0], revision: 3 },
          ...stream.journal.slice(1),
        ],
      }),
    /STREAM_INVALID/,
  );
});
test("cookie compaction keeps session/expired rows and tombstones without crossing site groups", () => {
  const cookie = (name, value) => {
    const c = {
      partition: null,
      domain: "game.example",
      hostOnly: true,
      path: "/",
      name,
      value,
      expires: null,
      sessionId: "source-session",
    };
    c.id = JSON.stringify([c.partition, c.domain, c.hostOnly, c.path, c.name]);
    return c;
  };
  const a = cookie("save", "old"),
    b = { ...cookie("other", "v"), expires: 1 };
  const stream = {
    revision: 3,
    snapshotRevision: 1,
    snapshot: {
      format: "atlas-cookie-snapshot-v1",
      revision: 1,
      cookies: [a, b],
    },
    journal: [
      {
        revision: 2,
        payload: {
          revision: 2,
          changes: [{ op: "set", cookie: cookie("save", "new") }],
        },
      },
      {
        revision: 3,
        payload: { revision: 3, changes: [{ op: "delete", cookie: b }] },
      },
    ],
  };
  const result = compactProfileStream(
    {},
    { kind: "cookies", origin: namespace.origin },
    stream,
  );
  assert.deepEqual(result.cookies, [cookie("save", "new")]);
  assert.equal(result.revision, 3);
  assert.equal(stream.snapshot.cookies[0].value, "old");
  const peer = cookie("peer", "v");
  peer.domain = "other.example";
  peer.id = JSON.stringify([null, peer.domain, true, "/", peer.name]);
  assert.throws(
    () =>
      compactProfileStream(
        {},
        { kind: "cookies", origin: namespace.origin },
        {
          revision: 1,
          snapshotRevision: 1,
          snapshot: {
            format: "atlas-cookie-snapshot-v1",
            revision: 1,
            cookies: [peer],
          },
          journal: [],
        },
      ),
    /NAMESPACE_INVALID/,
  );
});
test("long-running stream compacts periodically, not on every write, and restores newest canonical state", async () => {
  const f = fixture();
  for (let i = 1; i <= 1025; i++) {
    if (i > 1) f.changes.push(change(i));
    await drainProfileQueue(f.queue, f.cloud);
  }
  assert.equal(f.calls.filter((c) => c === "snapshot").length, 9);
  assert.equal(f.state.revision - f.state.snapshotRevision, 1);
  assert.equal(f.changes.length, 0);
  assert.deepEqual(compactProfileStream({}, namespace, f.state).entries, [
    ["save", "pending-1025"],
  ]);
});
