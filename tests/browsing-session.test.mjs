import test from "node:test";
import assert from "node:assert/strict";
import {
  restoreBrowsingLease,
  restoreBrowsingLeaseOnStartup,
  browsingSessionToRelease,
  selectBrowsingLeaseForOwner,
  createBrowsingLeaseLifecycle,
  normalizeBrowsingLease,
  leaseRetryDelay,
} from "../web/src/browsing-session.ts";
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
test("startup sends explicit restore and persists only server-confirmed result", async () => {
  const calls = [],
    saved = [];
  const lease = { session: "existing", generation: 2 };
  assert.equal(
    await restoreBrowsingLease(
      "existing",
      async (...args) => {
        calls.push(args);
        return lease;
      },
      (s) => saved.push(s),
    ),
    lease,
  );
  assert.deepEqual(calls, [["existing", "restore"]]);
  assert.deepEqual(saved, ["existing"]);
});
test("unknown/revoked/generic409 and connectivity errors never allocate a new session", async () => {
  for (const code of [
    "INVALID_SESSION",
    "SESSION_REVOKED",
    "SESSION_EXPIRED",
    "NODE_UNAVAILABLE",
    undefined,
  ]) {
    const calls = [];
    const error = Object.assign(Error("fixture"), { status: 409, code });
    await assert.rejects(
      restoreBrowsingLease(
        "saved",
        async (...args) => {
          calls.push(args);
          throw error;
        },
        () => assert.fail("no write"),
      ),
      (e) => e === error,
    );
    assert.deepEqual(calls, [["saved", "restore"]]);
  }
});
test("malformed saved session is an explicit empty restore", async () => {
  for (const saved of [null, {}, "x".repeat(101), ""]) {
    const calls = [];
    await restoreBrowsingLease(
      saved,
      async (...args) => {
        calls.push(args);
        return { session: "fresh" };
      },
      () => {},
    );
    assert.deepEqual(calls, [["", "restore"]]);
  }
});
test("simultaneous startup reads saved session inside the shared lock", async () => {
  let saved = "expired",
    issued = 0;
  const calls = [],
    locks = lockFixture();
  const restore = () =>
    restoreBrowsingLeaseOnStartup(
      () => saved,
      async (s, intent) => {
        calls.push([s, intent]);
        return { session: s === "expired" ? `fresh-${++issued}` : s };
      },
      (s) => {
        saved = s;
      },
      locks,
    );
  const [first, second] = await Promise.all([restore(), restore()]);
  assert.equal(first.session, second.session);
  assert.equal(issued, 1);
  assert.deepEqual(calls, [
    ["expired", "restore"],
    ["fresh-1", "restore"],
  ]);
});
test("manual owner selection releases only its own pin after a successful reserve", async () => {
  let saved = "peer";
  const calls = [];
  await selectBrowsingLeaseForOwner(
    "own",
    () => saved,
    async (s) => {
      calls.push(s);
      return { session: "new" };
    },
    (s) => (saved = s),
    lockFixture(),
  );
  assert.deepEqual(calls, ["own"]);
  assert.equal(saved, "new");
  assert.equal(browsingSessionToRelease("active", saved), "active");
  await assert.rejects(
    selectBrowsingLeaseForOwner(
      "own",
      () => saved,
      async () => {
        throw Error("offline");
      },
      () => assert.fail("no write"),
      lockFixture(),
    ),
    /offline/,
  );
});
function fixture(request) {
  let current = {
    session: "same",
    generation: 1,
    ticket: "old",
    bootTicket: "old",
    serverTime: 1,
  };
  const scheduled = [],
    applied = [],
    terminal = [];
  const options = {
    current: () => current,
    request,
    apply: (v) => {
      current = v;
      applied.push(v);
    },
    terminal: (e) => terminal.push(e),
    schedule: (_fn, delay) => {
      scheduled.push(delay);
      return 1;
    },
    cancel: () => {},
  };
  const lifecycle = createBrowsingLeaseLifecycle(options);
  return {
    lifecycle,
    scheduled,
    applied,
    terminal,
    current: () => current,
    set: (v) => {
      current = v;
    },
    options,
  };
}
test("renew changes credentials without changing the iframe bootstrap ticket", async () => {
  const f = fixture(async () => ({
    session: "same",
    generation: 1,
    ticket: "new",
    serverTime: 2,
    expiresAt: 100000,
  }));
  await f.lifecycle.check();
  assert.equal(f.current().ticket, "new");
  assert.equal(f.current().bootTicket, "old");
  assert.deepEqual(f.scheduled, [300000]);
  assert.deepEqual(f.terminal, []);
});
test("only typed idle expiry restores same pin; generation change gets a new bootstrap ticket", async () => {
  const calls = [];
  const f = fixture(async (lease, intent) => {
    calls.push([lease.session, intent]);
    if (intent === "renew")
      throw Object.assign(Error("idle"), { code: "SESSION_EXPIRED" });
    return { session: "same", generation: 2, ticket: "fresh" };
  });
  await f.lifecycle.check();
  assert.deepEqual(calls, [
    ["same", "renew"],
    ["same", "restore"],
  ]);
  assert.equal(f.current().bootTicket, "fresh");
});
test("offline and generic401 are retryable, never erase pin or expire the page", async () => {
  for (const error of [
    Error("offline"),
    Object.assign(Error("gateway"), { status: 401 }),
    Object.assign(Error("node"), {
      code: "NODE_UNAVAILABLE",
      retryable: true,
      retryAfter: 12,
    }),
  ]) {
    const f = fixture(async () => {
      throw error;
    });
    await f.lifecycle.check();
    assert.deepEqual(f.applied, []);
    assert.deepEqual(f.terminal, []);
    assert.equal(f.current().session, "same");
    assert.equal(f.scheduled[0], error.retryAfter ? 12000 : 1000);
  }
});
test("revoked, invalid and generation-mismatched sessions are terminal", async () => {
  for (const code of [
    "SESSION_REVOKED",
    "INVALID_SESSION",
    "SESSION_GENERATION_MISMATCH",
  ]) {
    const f = fixture(async () => {
      throw Object.assign(Error(code), { code });
    });
    await f.lifecycle.check();
    assert.equal(f.terminal.length, 1);
    assert.deepEqual(f.scheduled, []);
  }
});
test("late responses after manual node switch cannot overwrite the new owner pin", async () => {
  let resolve;
  const f = fixture(() => new Promise((r) => (resolve = r)));
  const pending = f.lifecycle.check();
  f.set({ session: "manual", generation: 8 });
  resolve({ session: "same", generation: 1, ticket: "stale" });
  await pending;
  assert.deepEqual(f.applied, []);
  assert.equal(f.current().session, "manual");
});
test("one window coalesces pending renewals and reuses a peer refresh inside the lock", async () => {
  let release,
    calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((r) => (release = r));
  });
  const first = f.lifecycle.check(),
    second = f.lifecycle.check();
  assert.equal(first, second);
  release({ session: "same", generation: 1, ticket: "new" });
  await first;
  assert.equal(calls, 1);
  let applied;
  const peer = {
    session: "same",
    generation: 1,
    ticket: "peer",
    serverTime: 3,
    expiresLocally: Date.now() + 360000,
  };
  const lifecycle = createBrowsingLeaseLifecycle({
    ...f.options,
    locks: lockFixture(),
    readRemembered: () => peer,
    apply: (v) => (applied = v),
    request: async () => assert.fail("peer already renewed"),
  });
  await lifecycle.check();
  assert.equal(applied.ticket, "peer");
  lifecycle.stop();
});
test("retry delay respects Retry-After and remains bounded 1–30 seconds", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 20].map((n) => leaseRetryDelay(n)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  assert.equal(leaseRetryDelay(0, 12), 12000);
  assert.equal(leaseRetryDelay(0, 120), 30000);
  assert.equal(leaseRetryDelay(0, 0), 1000);
});

test("hidden pages defer periodic renewal and validate when visible", async () => {
  let visible = false,
    calls = 0;
  const f = fixture(async () => {
    calls++;
    return { session: "same", generation: 1, ticket: "new" };
  });
  const lifecycle = createBrowsingLeaseLifecycle({
    ...f.options,
    visible: () => visible,
  });
  await lifecycle.check();
  assert.equal(calls, 0);
  assert.equal(f.scheduled.at(-1), 300000);
  visible = true;
  await lifecycle.check();
  assert.equal(calls, 1);
  lifecycle.stop();
});
test("manual switch epoch invalidates in-flight renewal before the new pin arrives", async () => {
  let resolve,
    epoch = 0;
  const f = fixture(() => new Promise((r) => (resolve = r)));
  const lifecycle = createBrowsingLeaseLifecycle({
    ...f.options,
    epoch: () => epoch,
  });
  const pending = lifecycle.check();
  epoch++;
  resolve({ session: "same", generation: 1, ticket: "late" });
  await pending;
  assert.deepEqual(f.applied, []);
  lifecycle.stop();
});

test("stale mounted generation revalidates the same private capability without an obsolete generation", async () => {
  const calls = [];
  const f = fixture(async (lease, intent) => {
    calls.push({
      session: lease.session,
      generation: lease.generation,
      intent,
    });
    if (intent === "renew")
      throw Object.assign(Error("peer restored"), {
        code: "SESSION_GENERATION_MISMATCH",
      });
    return { session: "same", generation: 2, ticket: "authoritative" };
  });
  await f.lifecycle.check();
  assert.deepEqual(calls, [
    { session: "same", generation: 1, intent: "renew" },
    { session: "same", generation: undefined, intent: "restore" },
  ]);
  assert.equal(f.current().generation, 2);
  assert.equal(f.current().bootTicket, "authoritative");
  assert.deepEqual(f.terminal, []);
});
test("higher generation in peer storage is only a hint and always goes through authoritative restore", async () => {
  const calls = [];
  const f = fixture(async (lease, intent) => {
    calls.push([lease.session, lease.generation, intent]);
    return { session: "same", generation: 2, ticket: "server" };
  });
  const lifecycle = createBrowsingLeaseLifecycle({
    ...f.options,
    readRemembered: () => ({
      session: "same",
      generation: 2,
      ticket: "untrusted-peer",
    }),
  });
  await lifecycle.check();
  assert.deepEqual(calls, [["same", undefined, "restore"]]);
  assert.equal(f.current().ticket, "server");
  lifecycle.stop();
});
test("stale-generation recovery never revives a server-revoked capability", async () => {
  const f = fixture(async (_lease, intent) => {
    throw Object.assign(Error("fixture"), {
      code:
        intent === "renew" ? "SESSION_GENERATION_MISMATCH" : "SESSION_REVOKED",
    });
  });
  await f.lifecycle.check();
  assert.deepEqual(f.applied, []);
  assert.equal(f.terminal[0].code, "SESSION_REVOKED");
});
test("a delayed lower-generation response cannot overwrite a newer remembered generation", async () => {
  let peer = null;
  const calls = [];
  const f = fixture(async (lease, intent) => {
    calls.push([lease.generation, intent]);
    if (intent === "renew") {
      peer = { session: "same", generation: 2, ticket: "peer" };
      return { session: "same", generation: 1, ticket: "late" };
    }
    return { session: "same", generation: 2, ticket: "current" };
  });
  const lifecycle = createBrowsingLeaseLifecycle({
    ...f.options,
    readRemembered: () => peer,
  });
  await lifecycle.check();
  assert.deepEqual(calls, [
    [1, "renew"],
    [undefined, "restore"],
  ]);
  assert.equal(f.current().generation, 2);
  assert.equal(f.current().ticket, "current");
  lifecycle.stop();
});

test("malformed Retry-After never becomes a zero-delay retry loop", () => {
  assert.equal(leaseRetryDelay(0, NaN), 1000);
  assert.equal(leaseRetryDelay(1, -5), 2000);
  assert.equal(leaseRetryDelay(2, Infinity), 4000);
});

test("runtime authentication failure bypasses otherwise fresh remembered credentials", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw Object.assign(Error("revoked"), { code: "SESSION_REVOKED" });
  });
  const lifecycle = createBrowsingLeaseLifecycle({
    ...f.options,
    readRemembered: () => ({
      session: "same",
      generation: 1,
      serverTime: 999,
      expiresLocally: Date.now() + 360000,
      ticket: "cached",
    }),
  });
  await lifecycle.check(true);
  assert.equal(calls, 1);
  assert.equal(f.terminal[0].code, "SESSION_REVOKED");
  lifecycle.stop();
});
test("an authoritative request queued behind ordinary renewal cannot disappear", async () => {
  let release,
    calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) return new Promise((r) => (release = r));
    throw Object.assign(Error("revoked"), { code: "SESSION_REVOKED" });
  });
  const pending = f.lifecycle.check();
  f.lifecycle.check(true);
  release({ session: "same", generation: 1, ticket: "first" });
  await pending;
  assert.equal(calls, 2);
  assert.equal(f.terminal[0].code, "SESSION_REVOKED");
});
