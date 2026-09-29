import test from "node:test";
import assert from "node:assert/strict";
import {
  restoreBrowsingLease,
  restoreBrowsingLeaseOnStartup,
  browsingSessionToRelease,
} from "../web/src/browsing-session.ts";

test("valid stored session is reused without reallocating", async () => {
  const calls = [],
    saved = [];
  const lease = { session: "existing", node: { id: "same" } };
  assert.equal(
    await restoreBrowsingLease(
      "existing",
      async (s) => {
        calls.push(s);
        return lease;
      },
      (s) => saved.push(s),
    ),
    lease,
  );
  assert.deepEqual(calls, ["existing"]);
  assert.deepEqual(saved, ["existing"]);
});
test("expired stored lease renews once on cold start and persists only replacement", async () => {
  const calls = [],
    saved = [];
  const lease = { session: "fresh" };
  await restoreBrowsingLease(
    "expired",
    async (s) => {
      calls.push(s);
      if (s) throw Object.assign(Error("expired"), { status: 409 });
      return lease;
    },
    (s) => saved.push(s),
  );
  assert.deepEqual(calls, ["expired", ""]);
  assert.deepEqual(saved, ["fresh"]);
});
test("offline nodes, network errors, rate limits and server errors never discard a valid pin", async () => {
  for (const status of [undefined, 401, 403, 429, 502, 503]) {
    let count = 0;
    const error = Object.assign(Error("fixture"), { status });
    await assert.rejects(
      restoreBrowsingLease(
        "existing",
        async () => {
          count++;
          throw error;
        },
        () => assert.fail("must not persist"),
      ),
      (e) => e === error,
    );
    assert.equal(count, 1);
  }
});
test("failed renewal has no retry loop and leaves stored token unchanged", async () => {
  const calls = [];
  await assert.rejects(
    restoreBrowsingLease(
      "expired",
      async (s) => {
        calls.push(s);
        throw Object.assign(Error("fixture"), { status: 409 });
      },
      () => assert.fail("must not persist"),
    ),
  );
  assert.deepEqual(calls, ["expired", ""]);
});
test("new or malformed local state allocates once", async () => {
  for (const saved of ["", null, {}, "x".repeat(101)]) {
    const calls = [];
    await restoreBrowsingLease(
      saved,
      async (s) => {
        calls.push(s);
        return { session: "fresh" };
      },
      () => {},
    );
    assert.deepEqual(calls, [""]);
  }
});

function lockFixture() {
  let queue = Promise.resolve();
  return {
    request(name, callback) {
      assert.equal(name, "atlas-browsing-session");
      const next = queue.then(callback);
      queue = next.catch(() => {});
      return next;
    },
  };
}

test("simultaneous startup windows read saved state inside one shared lock", async () => {
  let saved = "expired",
    issued = 0;
  const calls = [],
    locks = lockFixture();
  const allocate = async (session) => {
    calls.push(session);
    if (session === "expired")
      throw Object.assign(Error("expired"), { status: 409 });
    return { session: session || `fresh-${++issued}` };
  };
  const restore = () =>
    restoreBrowsingLeaseOnStartup(
      () => saved,
      allocate,
      (s) => {
        saved = s;
      },
      locks,
    );
  const [first, second] = await Promise.all([restore(), restore()]);
  assert.deepEqual(calls, ["expired", "", "fresh-1"]);
  assert.equal(issued, 1);
  assert.equal(first.session, second.session);
  assert.equal(saved, first.session);
});

test("startup failure releases its lock without deleting the saved pin", async () => {
  let saved = "existing",
    calls = 0;
  const locks = lockFixture();
  const restore = () =>
    restoreBrowsingLeaseOnStartup(
      () => saved,
      async (session) => {
        if (++calls === 1)
          throw Object.assign(Error("offline"), { status: 503 });
        return { session };
      },
      (s) => {
        saved = s;
      },
      locks,
    );
  await assert.rejects(restore(), /offline/);
  assert.equal((await restore()).session, "existing");
  assert.equal(saved, "existing");
  assert.equal(calls, 2);
});

test("without Web Locks, racing windows retain independent leases and reconnect releases only their own", async () => {
  let saved = "expired",
    issued = 0;
  const restore = () =>
    restoreBrowsingLeaseOnStartup(
      () => saved,
      async (session) => {
        if (session === "expired")
          throw Object.assign(Error("expired"), { status: 409 });
        return { session: `fresh-${++issued}` };
      },
      (s) => {
        saved = s;
      },
    );
  const [first, second] = await Promise.all([restore(), restore()]);
  assert.notEqual(first.session, second.session);
  assert.equal(saved, second.session);
  assert.equal(browsingSessionToRelease(first.session, saved), first.session);
  assert.equal(browsingSessionToRelease(second.session, saved), second.session);
});

test("reconnect uses the active pin even when persistence failed or another window changed storage", () => {
  for (const saved of ["other-window", "stale", null, {}, "x".repeat(101)])
    assert.equal(browsingSessionToRelease("active", saved), "active");
  assert.equal(
    browsingSessionToRelease(undefined, "saved-before-boot"),
    "saved-before-boot",
  );
  assert.equal(browsingSessionToRelease(undefined, {}), "");
  assert.equal(browsingSessionToRelease(undefined, "x".repeat(101)), "");
});
