import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfileStream } from "../web/src/profile-stream.ts";
import { HUB_LIMITS } from "../runtime/hub-contracts.ts";
const namespace = { kind: "local", origin: "https://site.example" };
test("stream replay accepts binary wire expansion but rejects crossing the encoded allowance", async () => {
  const request = async () => ({
    revision: 1,
    snapshotRevision: 1,
    snapshot: { codec: "atlas-chunks-v1", bytes: 85 * 1024 * 1024 },
    journal: [],
  });
  assert.equal((await loadProfileStream(request, namespace)).revision, 1);
  await assert.rejects(
    loadProfileStream(
      async () => ({
        ...(await request()),
        snapshot: {
          codec: "atlas-chunks-v1",
          bytes: HUB_LIMITS.streamBytes + 1,
        },
      }),
      namespace,
    ),
    /PROFILE_STREAM_SIZE_EXCEEDED/,
  );
});
test("profile restore collects1001 pinned journal entries before native hydration", async () => {
  const calls = [];
  const value = await loadProfileStream(async (body) => {
    calls.push(body);
    const after = body.after ?? 0,
      end = Math.min(after + 500, 1001);
    return {
      revision: 1001,
      snapshotRevision: 0,
      snapshot: after === 0 ? { fixture: true } : null,
      journal: Array.from({ length: end - after }, (_, i) => ({
        revision: after + i + 1,
        payload: { save: i },
      })),
      hasMore: end < 1001,
      nextAfter: end,
    };
  }, namespace);
  assert.equal(value.journal.length, 1001);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], {
    namespace,
    after: 500,
    targetRevision: 1001,
    snapshotRevision: 0,
  });
});
test("profile restore rejects checkpoint changes, gaps, truncated pages, forged cursor and oversized chunk graphs", async () => {
  for (const mutate of [
    (p) => ({ ...p, snapshotRevision: 1 }),
    (p) => ({ ...p, journal: [{ revision: 3, payload: {} }] }),
    (p) => ({ ...p, journal: [] }),
    (p) => ({ ...p, hasMore: true, nextAfter: 0 }),
    (p) => ({
      ...p,
      journal: [
        { revision: 2, payload: { codec: "atlas-chunks-v1", bytes: 999 } },
      ],
    }),
  ]) {
    let calls = 0;
    await assert.rejects(
      loadProfileStream(
        async () =>
          ++calls === 1
            ? {
                revision: 2,
                snapshotRevision: 0,
                snapshot: null,
                journal: [{ revision: 1, payload: {} }],
                hasMore: true,
                nextAfter: 1,
              }
            : mutate({
                revision: 2,
                snapshotRevision: 0,
                snapshot: null,
                journal: [{ revision: 2, payload: {} }],
                hasMore: false,
                nextAfter: 2,
              }),
        namespace,
        500,
      ),
      /PROFILE_STREAM_/,
    );
  }
});
test("empty stream and checkpoint-only stream restore without invented journal entries", async () => {
  for (const rev of [0, 12]) {
    const r = await loadProfileStream(
      async () => ({
        revision: rev,
        snapshotRevision: rev,
        snapshot: rev ? {} : null,
        journal: [],
        hasMore: false,
        nextAfter: rev,
      }),
      namespace,
    );
    assert.equal(r.revision, rev);
  }
});
