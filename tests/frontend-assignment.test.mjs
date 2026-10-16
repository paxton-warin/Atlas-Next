import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { digest, token } from "../server/store.mjs";
import {
  createFrontendAssignmentCoordinator,
  FRONTEND_ASSIGNMENT_KEY,
  FRONTEND_ASSIGNMENT_LOCK,
} from "../runtime/frontend-assignment.ts";
const origin = "http://frontend.example";
const flush = () => new Promise((r) => setImmediate(r));
function locks() {
  let tail = Promise.resolve();
  const names = [];
  return {
    names,
    request(name, fn) {
      names.push(name);
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    },
  };
}
function storage() {
  const map = new Map();
  return {
    map,
    fail: false,
    getItem(k) {
      return map.get(k) ?? null;
    },
    setItem(k, v) {
      if (this.fail) throw Error("storage quota fixture");
      map.set(k, v);
    },
  };
}
function clock() {
  let now = Date.now(),
    next = 0;
  const timers = new Map();
  return {
    now: () => now,
    timers,
    schedule(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, delay, at: now + delay });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
    },
  };
}
function bus() {
  const peers = new Set(),
    messages = [];
  return {
    messages,
    channel() {
      const listeners = new Set();
      const self = {
        addEventListener(_t, fn) {
          listeners.add(fn);
        },
        removeEventListener(_t, fn) {
          listeners.delete(fn);
        },
        postMessage(data) {
          messages.push(data);
          for (const peer of peers)
            if (peer !== self)
              queueMicrotask(() => {
                for (const fn of peer.listeners) fn({ data });
              });
        },
        close() {
          peers.delete(self);
        },
        listeners,
      };
      peers.add(self);
      return self;
    },
  };
}
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-assignment-owner-"));
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    appOrigin: origin,
    dynamicOrigins: false,
    runtimeOrigin: "https://runtime.invalid",
    localRelayMode: "frontend",
    opaqueRuntimeEnabled: true,
  });
  const remotes = [],
    calls = [],
    events = [];
  let cookie = "",
    before,
    after,
    dropCommit = false,
    probe;
  const admin = token(),
    csrf = token(),
    time = Date.now();
  app.store.db
    .prepare("INSERT INTO sessions(hash,csrf,created,seen) VALUES(?,?,?,?)")
    .run(digest(admin), csrf, time, time);
  const fetch = async (path, input) => {
    const body = JSON.parse(input.body);
    calls.push({ path, body });
    const intercept = await before?.(path, body);
    if (intercept) return intercept;
    const response = await app.inject({
      method: input.method,
      url: path,
      headers: {
        origin,
        cookie: "atlas-admin=" + admin + (cookie ? "; " + cookie : ""),
        ...Object.fromEntries(new Headers(input.headers)),
      },
      payload: body,
    });
    if (response.headers["set-cookie"])
      cookie = response.headers["set-cookie"].split(";")[0];
    if (path.endsWith("/commit")) {
      events.push("server-commit");
      if (dropCommit) {
        dropCommit = false;
        throw new TypeError("response dropped AFTER server commit");
      }
    }
    const result = new Response(response.body, {
      status: response.statusCode,
      headers: response.headers,
    });
    return (await after?.(path, body, result)) ?? result;
  };
  const peers = [];
  const createRelay = async (lease) => {
    events.push("probe:" + lease.node.id);
    await probe?.(lease);
    let assignment = {
      origin: lease.relayOrigin,
      ticket: lease.relayTicket ?? lease.ticket,
      generation: lease.generation,
      sessionHash: lease.sessionHash,
    };
    const peer = {
      lease,
      disposed: false,
      pending: 0,
      webSockets: 0,
      replacements: [],
      get assignment() {
        return assignment;
      },
      async replace(value) {
        peer.replacements.push(value);
        assignment = value;
        events.push("replace:" + lease.node.id);
      },
      async request() {
        return {
          status: 200,
          statusText: "OK",
          headers: [],
          body: new TextEncoder().encode(lease.node.id).buffer,
        };
      },
      connectWebSocket() {
        return { send() {}, close() {} };
      },
      dispose() {
        peer.disposed = true;
        events.push("dispose:" + lease.node.id);
      },
    };
    peers.push(peer);
    return peer;
  };
  const sharedStorage = storage(),
    sharedLocks = locks(),
    timekeeper = clock();
  function coordinator(extra = {}) {
    const owner = createFrontendAssignmentCoordinator({
      workerURL: "/relay-worker.js",
      frontendOrigin: origin,
      storage: sharedStorage,
      locks: sharedLocks,
      fetch,
      createRelay,
      events: false,
      channel: false,
      visible: () => true,
      now: timekeeper.now,
      schedule: timekeeper.schedule,
      cancel: timekeeper.cancel,
      ...extra,
    });
    owners.push(owner);
    return owner;
  }
  const owners = [];
  t.after(async () => {
    for (const owner of owners) owner.stop();
    await Promise.all(remotes.map((r) => r.close()));
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    calls,
    events,
    peers,
    storage: sharedStorage,
    locks: sharedLocks,
    clock: timekeeper,
    coordinator,
    csrf,
    get record() {
      return JSON.parse(
        sharedStorage.getItem(FRONTEND_ASSIGNMENT_KEY) || "null",
      );
    },
    intercept(fn) {
      before = fn;
    },
    response(fn) {
      after = fn;
    },
    probe(fn) {
      probe = fn;
    },
    dropCommit() {
      dropCommit = true;
    },
    resetBrowserSession() {
      cookie = "";
    },
    async remote() {
      const node = await createNodeService({
        fixture: true,
        pairing: { verify: () => true, save: () => {} },
      });
      await node.listen({ host: "127.0.0.1", port: 0 });
      remotes.push(node);
      const endpoint = "http://127.0.0.1:" + node.server.address().port;
      return app.nodePool.attach(
        { endpoint, name: "Remote", code: "fixture" },
        origin,
      );
    },
  };
}

test("first allocation persists its exact pin before real relay-factory failure; retry never allocates again", async (t) => {
  const f = await fixture(t);
  let first = true;
  f.probe(() => {
    assert.ok(f.record.active.session);
    if (first) {
      first = false;
      throw Object.assign(Error("offline"), { code: "relay_unavailable" });
    }
  });
  const c = f.coordinator();
  await assert.rejects(c.start(), { code: "relay_unavailable" });
  const pinned = f.record.active.session;
  assert.equal(c.state.status, "retrying");
  assert.equal(f.peers.length, 0);
  await c.check({ authoritative: true });
  assert.equal(c.current.session, pinned);
  assert.equal(f.calls.filter((c) => c.body.intent === "new").length, 1);
  assert.equal(c.state.status, "ready");
});

test("visible five-minute validation refreshes active12h lease and relay credentials in place without replacing website owner identity", async (t) => {
  const f = await fixture(t),
    changes = [],
    c = f.coordinator({ onAssignment: (e) => changes.push(e) });
  const first = await c.start();
  f.clock.advance(300000);
  await c.check();
  assert.equal(c.current.session, first.session);
  assert.equal(c.current.node.id, first.node.id);
  assert.equal(f.peers.length, 1);
  assert.ok(f.calls.some((c) => c.body.intent === "renew"));
  assert.ok(c.current.leaseExpiresAt > c.current.serverTime + 11 * 3600000);
  assert.equal(changes.at(-1).identityChanged, false);
  assert.equal(f.peers[0].disposed, false);
  assert.ok(f.locks.names.every((n) => n === FRONTEND_ASSIGNMENT_LOCK));
});

test("two trusted windows share one pin, coalesce timer renewals, and metadata-only broadcasts never echo-write indefinitely", async (t) => {
  const f = await fixture(t),
    b = bus(),
    a = f.coordinator({ channel: b.channel() }),
    c = f.coordinator({ channel: b.channel() });
  await a.start();
  await c.start();
  await flush();
  await flush();
  assert.equal(a.current.session, c.current.session);
  assert.equal(f.calls.filter((c) => c.body.intent === "new").length, 1);
  const before = f.calls.length;
  f.clock.advance(300000);
  await Promise.all([a.check(), c.check()]);
  await flush();
  await flush();
  assert.equal(f.calls.length - before, 1);
  assert.equal(a.current.session, c.current.session);
  const messages = b.messages.length;
  await flush();
  await flush();
  assert.equal(b.messages.length, messages);
  for (const m of b.messages) {
    assert.deepEqual(Object.keys(m).sort(), [
      "protocol",
      "revision",
      "sessionHash",
    ]);
    assert.ok(!JSON.stringify(m).includes(a.current.session));
  }
});

test("idle-expired owner reserves fresh private capability on the SAME node and commits only after candidate probe", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start();
  f.app.store.db
    .prepare("UPDATE browse_leases SET seen=? WHERE hash=?")
    .run(Date.now() - 12 * 3600000 - 100, old.sessionHash);
  f.probe((lease) => {
    if (lease.session !== old.session) {
      assert.equal(f.record.pending.candidate.session, lease.session);
      assert.equal(f.record.pending.previous.session, old.session);
      assert.equal(f.record.pending.stage, "reserved");
      assert.equal(f.events.includes("server-commit"), false);
      assert.equal(f.peers[0].disposed, false);
    }
  });
  const restored = await c.check({ authoritative: true });
  assert.notEqual(restored.session, old.session);
  assert.equal(restored.node.id, old.node.id);
  assert.equal(f.record.pending, null);
  assert.ok(
    f.events.indexOf("server-commit") >
      f.events.indexOf("probe:" + old.node.id),
  );
  assert.equal(
    f.app.store.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(old.sessionHash).reason,
    "revoked",
  );
});

test("node outage and Retry-After retain the saved/active pin with bounded backoff and no new allocation", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start();
  f.intercept((path) =>
    path.endsWith("/session")
      ? new Response(
          JSON.stringify({
            error: "node offline",
            code: "NODE_UNAVAILABLE",
            retryable: true,
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "retry-after": "90",
            },
          },
        )
      : null,
  );
  await assert.rejects(c.check({ authoritative: true }), {
    code: "NODE_UNAVAILABLE",
  });
  assert.equal(c.current.session, old.session);
  assert.equal(f.record.active.session, old.session);
  assert.equal(c.state.status, "retrying");
  assert.equal(c.state.retryIn, 30000);
  assert.equal(f.peers[0].disposed, false);
  assert.equal(f.calls.filter((c) => c.body.intent === "new").length, 1);
});

test("explicit revocation is terminal and never allocates; only explicit reconnect starts a fresh private owner", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start();
  f.app.nodePool.release(old.session, origin);
  await assert.rejects(c.check({ authoritative: true }), {
    code: "SESSION_REVOKED",
  });
  assert.equal(c.state.status, "revoked");
  assert.equal(f.calls.filter((c) => c.body.intent === "new").length, 1);
  const fresh = await c.reconnect();
  assert.notEqual(fresh.session, old.session);
  assert.equal(c.state.status, "ready");
  assert.equal(f.calls.filter((c) => c.body.intent === "new").length, 2);
});

test("admin selection reserves/probes/commits before switching stable transport and retiring old relay", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start(),
    remote = await f.remote();
  let release;
  const gate = new Promise((r) => (release = r));
  f.probe(async (lease) => {
    if (lease.node.id === remote.id) {
      assert.equal(f.record.pending.candidate.node.id, remote.id);
      assert.equal(f.record.pending.stage, "reserved");
      await gate;
    }
  });
  const switching = c.selectNode(remote.id, f.csrf);
  while (!f.record.pending) await flush();
  assert.equal(c.current.session, old.session);
  assert.equal(f.peers[0].disposed, false);
  assert.equal(c.transport.assignment.sessionHash, old.sessionHash);
  release();
  const selected = await switching;
  assert.equal(selected.node.id, remote.id);
  assert.equal(c.transport.assignment.sessionHash, selected.sessionHash);
  assert.equal(
    c.transport.assignment.ticket,
    selected.relayTicket ?? selected.ticket,
  );
  assert.equal(f.record.pending, null);
  assert.equal(f.peers[0].disposed, true);
  const probeIndex = f.events.lastIndexOf("probe:" + remote.id),
    commitIndex = f.events.indexOf("server-commit"),
    disposeIndex = f.events.indexOf("dispose:" + old.node.id);
  assert.ok(probeIndex < commitIndex && commitIndex < disposeIndex);
});

test("commit's refreshed credentials replace the already-probed ticket before promotion", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  await c.start();
  const remote = await f.remote();
  let reserved;
  f.probe((lease) => {
    if (lease.node.id === remote.id)
      reserved = lease.relayTicket ?? lease.ticket;
  });
  f.response(async (path, _body, response) => {
    if (!path.endsWith("/commit")) return;
    // Deliberately distinct trusted control response credential: this unit uses
    // the deterministic relay seam; the browser proof verifies real tickets.
    const grant = await response.json();
    grant.relayTicket = reserved + ".refreshed";
    return Response.json(grant);
  });
  const selected = await c.selectNode(remote.id, f.csrf);
  assert.notEqual(selected.relayTicket, reserved);
  assert.equal(c.transport.assignment.ticket, selected.relayTicket);
  assert.equal(f.peers.at(-1).replacements.at(-1).ticket, selected.relayTicket);
  assert.ok(
    f.events.indexOf("server-commit") <
      f.events.lastIndexOf("replace:" + remote.id),
  );
});

test("a confirmed generation or endpoint different from the probed reservation never promotes that relay", async (t) => {
  for (const field of ["generation", "relayOrigin"]) {
    await t.test(field, async (t) => {
      const f = await fixture(t),
        c = f.coordinator();
      const old = await c.start(),
        remote = await f.remote();
      f.response(async (path, _body, response) => {
        if (!path.endsWith("/commit")) return;
        const grant = await response.json();
        if (field === "generation") grant.generation++;
        else grant.relayOrigin = "https://different-relay.example";
        return Response.json(grant);
      });
      await assert.rejects(c.selectNode(remote.id, f.csrf), {
        code: "INVALID_FRONTEND_COMMIT",
      });
      assert.equal(c.current.session, old.session);
      assert.equal(c.transport.assignment.sessionHash, old.sessionHash);
      assert.equal(f.peers[0].disposed, false);
      assert.equal(f.peers.at(-1).disposed, true);
      assert.equal(f.record.pending.stage, "commit-intent");
      // The server really committed before the damaged response. Resolve its
      // journal, not the now-revoked predecessor, on the next explicit check.
      f.response(undefined);
      const recovered = await c.check({ authoritative: true });
      assert.equal(recovered.node.id, remote.id);
      assert.equal(f.record.pending, null);
    });
  }
});

test("failed candidate probe retains original relay and journal; no server commit or automatic alternate node", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start(),
    remote = await f.remote();
  f.probe((lease) => {
    if (lease.node.id === remote.id)
      throw Object.assign(Error("candidate offline"), {
        code: "relay_unavailable",
      });
  });
  await assert.rejects(c.selectNode(remote.id, f.csrf), {
    code: "relay_unavailable",
  });
  assert.equal(c.current.session, old.session);
  assert.equal(f.peers[0].disposed, false);
  assert.equal(f.record.pending.candidate.node.id, remote.id);
  assert.equal(f.events.includes("server-commit"), false);
  assert.ok(
    f.app.store.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(old.sessionHash),
  );
});

test("ambiguous successful commit survives reload: candidate is authoritatively resolved BEFORE revoked previous owner", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start(),
    remote = await f.remote();
  f.dropCommit();
  await assert.rejects(
    c.selectNode(remote.id, f.csrf),
    /response dropped AFTER server commit/,
  );
  const pending = f.record.pending;
  assert.equal(pending.stage, "commit-intent");
  assert.equal(pending.previous.session, old.session);
  assert.equal(c.current.session, old.session);
  assert.equal(f.peers[0].disposed, false);
  c.stop();
  const before = f.calls.length,
    reloaded = f.coordinator();
  const recovered = await reloaded.start();
  assert.equal(recovered.session, pending.candidate.session);
  assert.equal(recovered.node.id, remote.id);
  assert.equal(f.record.pending, null);
  const attempts = f.calls.slice(before);
  assert.equal(attempts[0].body.session, pending.candidate.session);
  assert.equal(attempts[0].body.intent, "restore");
  assert.ok(!attempts.some((x) => x.body.session === old.session));
  assert.equal(reloaded.state.status, "ready");
});

test("explicit reconnect resolves an ambiguous committed candidate before choosing its replacement owner", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start(),
    remote = await f.remote();
  f.dropCommit();
  await assert.rejects(c.selectNode(remote.id, f.csrf), /response dropped/);
  const candidate = f.record.pending.candidate,
    before = f.calls.length;
  const replacement = await c.reconnect();
  assert.notEqual(replacement.session, candidate.session);
  assert.notEqual(replacement.session, old.session);
  const attempts = f.calls.slice(before);
  assert.equal(attempts[0].body.session, candidate.session);
  assert.equal(attempts[0].body.intent, "restore");
  assert.equal(
    attempts.find((x) => x.body.intent === "new").body.session,
    candidate.session,
  );
  assert.equal(f.record.pending, null);
  assert.equal(
    f.app.store.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(candidate.sessionHash).reason,
    "revoked",
  );
});

test("a failed durable journal write prevents candidate probe/commit and leaves active old worker intact", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start(),
    remote = await f.remote();
  f.intercept((path) => {
    if (path === "/api/admin/nodes/controller-select") f.storage.fail = true;
  });
  await assert.rejects(c.selectNode(remote.id, f.csrf), {
    code: "FRONTEND_STORAGE_UNAVAILABLE",
  });
  assert.equal(c.current.session, old.session);
  assert.equal(f.peers[0].disposed, false);
  assert.equal(f.events.includes("probe:" + remote.id), false);
  assert.equal(f.events.includes("server-commit"), false);
});

test("late renewal response cannot supersede a newer explicit selection epoch", async (t) => {
  const f = await fixture(t),
    changes = [],
    c = f.coordinator({
      onAssignment: (e) => changes.push(e.assignment.node.id),
    });
  const old = await c.start(),
    remote = await f.remote();
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    inRequest = new Promise((r) => (entered = r));
  let first = true;
  f.intercept(async (path, body) => {
    if (path.endsWith("/session") && body.intent === "renew" && first) {
      first = false;
      entered();
      await gate;
    }
  });
  const renewal = c.check({ authoritative: true });
  await inRequest;
  const selection = c.selectNode(remote.id, f.csrf);
  release();
  await assert.rejects(renewal, { code: "FRONTEND_OPERATION_STALE" });
  const next = await selection;
  assert.equal(next.node.id, remote.id);
  assert.equal(c.current.node.id, remote.id);
  assert.equal(changes.at(-1), remote.id);
  assert.equal(f.record.active.session, next.session);
});

test("explicit reconnect from a valid owner uses reserve/probe/commit rather than leaking the old lease", async (t) => {
  const f = await fixture(t),
    c = f.coordinator(),
    old = await c.start();
  const fresh = await c.reconnect();
  assert.notEqual(fresh.session, old.session);
  assert.ok(
    f.calls.some(
      (x) => x.body.intent === "new" && x.body.session === old.session,
    ),
  );
  assert.ok(f.events.includes("server-commit"));
  assert.equal(
    f.app.store.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(old.sessionHash),
    undefined,
  );
});

test("later explicit selection is rejected as busy without invalidating an already authorized pending selection", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  await c.start();
  const remote = await f.remote();
  let release;
  const gate = new Promise((r) => (release = r));
  f.probe(async (lease) => {
    if (lease.node.id === remote.id) await gate;
  });
  const first = c.selectNode(remote.id, f.csrf);
  while (!f.record.pending) await flush();
  await assert.rejects(c.selectNode("local", f.csrf), { code: "SESSION_BUSY" });
  release();
  assert.equal((await first).node.id, remote.id);
});

test("old worker with in-flight work is retained past successful commit until that work settles", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  await c.start();
  const old = f.peers[0];
  old.pending = 1;
  const remote = await f.remote();
  await c.selectNode(remote.id, f.csrf);
  assert.equal(old.disposed, false);
  old.pending = 0;
  f.clock.advance(1000);
  assert.equal(old.disposed, true);
});

test("pageshow, online, visibility resume validate authoritatively; hidden interval does not renew, stop removes listeners", async (t) => {
  const f = await fixture(t),
    windowEvents = new EventTarget(),
    documentEvents = new EventTarget();
  let visible = true;
  const win = {
    location: { origin, protocol: "http:" },
    document: documentEvents,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  };
  const c = f.coordinator({
    window: win,
    events: true,
    visible: () => visible,
  });
  await c.start();
  for (const type of ["online", "pageshow"]) {
    const before = f.calls.length;
    windowEvents.dispatchEvent(new Event(type));
    await c.check();
    assert.ok(f.calls.length > before);
  }
  visible = false;
  const before = f.calls.length;
  f.clock.advance(300000);
  await flush();
  assert.equal(f.calls.length, before);
  visible = true;
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await c.check();
  assert.ok(f.calls.length > before);
  const stopped = f.calls.length;
  c.stop();
  windowEvents.dispatchEvent(new Event("online"));
  documentEvents.dispatchEvent(new Event("resume"));
  await flush();
  assert.equal(f.calls.length, stopped);
});

test("fresh explicit reconnect pin survives first probe failure instead of retrying its known-revoked predecessor", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  const old = await c.start();
  f.app.nodePool.release(old.session, origin);
  await assert.rejects(c.check({ authoritative: true }), {
    code: "SESSION_REVOKED",
  });
  let once = true;
  f.probe((lease) => {
    if (lease.session !== old.session && once) {
      once = false;
      throw Object.assign(Error("offline new relay"), {
        code: "relay_unavailable",
      });
    }
  });
  await assert.rejects(c.reconnect(), { code: "relay_unavailable" });
  const pin = f.record.active;
  assert.notEqual(pin.session, old.session);
  await c.check({ authoritative: true });
  assert.equal(c.current.session, pin.session);
  assert.equal(f.calls.filter((x) => x.body.intent === "new").length, 2);
});

test("expired candidate at commit is reconciled back to valid previous pin, not mislabeled as active-session expiration", async (t) => {
  const f = await fixture(t),
    c = f.coordinator(),
    old = await c.start(),
    remote = await f.remote();
  let once = true;
  f.intercept((path, body) => {
    if (path.endsWith("/commit") && once) {
      once = false;
      f.app.store.db
        .prepare(
          "UPDATE frontend_assignments SET reservation_expires=0 WHERE hash=?",
        )
        .run(digest(body.session));
    }
  });
  await assert.rejects(c.selectNode(remote.id, f.csrf), {
    code: "COMMIT_REQUIRES_RECONCILIATION",
  });
  assert.equal(c.state.status, "retrying");
  assert.equal(c.current.session, old.session);
  await c.check({ authoritative: true });
  assert.equal(c.current.session, old.session);
  assert.equal(c.state.status, "ready");
  assert.equal(f.record.pending, null);
});

test("revoked candidate during commit does not revoke a still-valid previous owner", async (t) => {
  const f = await fixture(t),
    c = f.coordinator(),
    old = await c.start(),
    remote = await f.remote();
  let once = true;
  f.intercept((path, body) => {
    if (path.endsWith("/commit") && once) {
      once = false;
      f.app.nodePool.release(body.session, origin);
    }
  });
  await assert.rejects(c.selectNode(remote.id, f.csrf), {
    code: "COMMIT_REQUIRES_RECONCILIATION",
  });
  await c.check({ authoritative: true });
  assert.equal(c.current.session, old.session);
  assert.equal(c.state.status, "ready");
});

test("authoritative predecessor revocation during commit becomes terminal only after candidate-first reconciliation", async (t) => {
  const f = await fixture(t),
    c = f.coordinator(),
    old = await c.start(),
    remote = await f.remote();
  let once = true;
  f.intercept((path) => {
    if (path.endsWith("/commit") && once) {
      once = false;
      f.app.nodePool.release(old.session, origin);
    }
  });
  await assert.rejects(c.selectNode(remote.id, f.csrf), {
    code: "COMMIT_REQUIRES_RECONCILIATION",
  });
  await assert.rejects(c.check({ authoritative: true }), {
    code: "SESSION_REVOKED",
  });
  assert.equal(c.state.status, "revoked");
});

test("lost first allocation reply survives full coordinator reload using one persisted signed request and exact pin", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let lost = true;
  f.intercept((path, body) => {
    if (path.endsWith("/session") && body.intent === "new") {
      assert.equal(f.record.initial.requestId, body.requestId);
      assert.equal(f.record.active, null);
    }
  });
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && lost) {
      lost = false;
      throw new TypeError("lost initial allocation reply");
    }
  });
  await assert.rejects(c.start(), /lost initial allocation reply/);
  const journal = f.record.initial;
  const pinned = f.app.store.db.prepare("SELECT * FROM browse_leases").all();
  assert.equal(pinned.length, 1);
  assert.equal(f.record.active, null);
  assert.ok(journal.requestId);
  assert.equal(f.peers.length, 0);
  c.stop();
  const reloaded = f.coordinator(),
    lease = await reloaded.start();
  assert.equal(lease.sessionHash, pinned[0].hash);
  assert.equal(lease.node.id, pinned[0].node);
  assert.equal(f.record.initial, null);
  assert.equal(f.record.active.session, lease.session);
  const newCalls = f.calls.filter((x) => x.body.intent === "new");
  assert.equal(newCalls.length, 2);
  assert.equal(newCalls[0].body.requestId, newCalls[1].body.requestId);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/bootstrap")).length, 1);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
});

test("lost bootstrap reply has no lease side effect; retry can establish a new signed request safely", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let lost = true;
  f.response((path) => {
    if (path.endsWith("/bootstrap") && lost) {
      lost = false;
      throw new TypeError("lost bootstrap reply");
    }
  });
  await assert.rejects(c.start(), /lost bootstrap reply/);
  assert.equal(f.record, null);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    0,
  );
  const lease = await c.check({ authoritative: true });
  assert.ok(lease.session);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/bootstrap")).length, 2);
  assert.equal(f.calls.filter((x) => x.body.intent === "new").length, 1);
});

test("persisting signed initial intent is mandatory before allocating; local write failure creates zero leases", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  f.storage.fail = true;
  await assert.rejects(c.start(), { code: "FRONTEND_STORAGE_UNAVAILABLE" });
  assert.equal(f.calls.filter((x) => x.body.intent === "new").length, 0);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    0,
  );
  f.storage.fail = false;
  await c.check({ authoritative: true });
  assert.equal(f.calls.filter((x) => x.body.intent === "new").length, 1);
});

test("two windows recover a lost initial response without creating a second lease or probe", async (t) => {
  const f = await fixture(t),
    a = f.coordinator(),
    b = f.coordinator();
  let lost = true;
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && lost) {
      lost = false;
      throw new TypeError("lost shared initial reply");
    }
  });
  const results = await Promise.allSettled([a.start(), b.start()]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  const recovered = await a.check({ authoritative: true });
  assert.equal(recovered.session, b.current.session);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
  assert.equal(
    new Set(
      f.calls
        .filter((x) => x.body.intent === "new")
        .map((x) => x.body.requestId),
    ).size,
    1,
  );
});

test("lost initial reply followed by changed browser session fails terminally without rebinding or another lease", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let lost = true;
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && lost) {
      lost = false;
      throw new TypeError("lost initial reply before browser reset");
    }
  });
  await assert.rejects(c.start(), /lost initial reply/);
  const journal = f.record.initial;
  c.stop();
  f.resetBrowserSession();
  const reloaded = f.coordinator();
  await assert.rejects(reloaded.start(), {
    code: "INITIAL_REQUEST_BINDING_MISMATCH",
    retryable: false,
  });
  assert.equal(reloaded.state.status, "error");
  assert.deepEqual(f.record.initial, journal);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/bootstrap")).length, 1);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
});

test("truncated successful initial response retains the signed request for authoritative retry", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let truncated = true;
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && truncated) {
      truncated = false;
      return new Response('{"session":', { status: 200 });
    }
  });
  await assert.rejects(c.start(), {
    code: "CONTROL_RESPONSE_INVALID",
    retryable: true,
  });
  const signed = f.record.initial.requestId,
    hash = f.app.store.db.prepare("SELECT hash FROM browse_leases").get().hash;
  const recovered = await c.check({ authoritative: true });
  assert.equal(recovered.sessionHash, hash);
  assert.equal(f.record.initial, null);
  assert.deepEqual(
    f.calls.filter((x) => x.body.intent === "new").map((x) => x.body.requestId),
    [signed, signed],
  );
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
});

test("next-day unresolved initial intent retires its exact expired owner before bootstrapping one fresh assignment", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let lost = true;
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && lost) {
      lost = false;
      throw new TypeError("lost next-day initial reply");
    }
  });
  await assert.rejects(c.start(), /lost next-day initial reply/);
  c.stop();
  const old = f.app.store.db
      .prepare("SELECT hash FROM browse_leases")
      .get().hash,
    before = f.calls.length,
    now = Date.now;
  try {
    Date.now = () => now() + 13 * 3600000;
    const reloaded = f.coordinator(),
      fresh = await reloaded.start();
    assert.notEqual(fresh.sessionHash, old);
    assert.equal(f.record.initial, null);
    assert.deepEqual(
      f.calls.slice(before).map((x) => x.path),
      [
        "/api/browse/controller/session",
        "/api/browse/controller/initial-retire",
        "/api/browse/controller/bootstrap",
        "/api/browse/controller/session",
      ],
    );
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      1,
    );
    assert.equal(
      f.app.store.db
        .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
        .get(old).reason,
      "revoked",
    );
  } finally {
    Date.now = now;
  }
});

test("lost confirmed initial-retirement response keeps journal and retries retirement before allocating", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let allocationLost = true,
    retirementLost = true;
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && allocationLost) {
      allocationLost = false;
      throw new TypeError("initial allocation lost");
    }
    if (path.endsWith("/initial-retire") && retirementLost) {
      retirementLost = false;
      throw new TypeError("initial retirement reply lost");
    }
  });
  await assert.rejects(c.start(), /initial allocation lost/);
  c.stop();
  const journal = f.record.initial,
    now = Date.now;
  try {
    Date.now = () => now() + 13 * 3600000;
    const reloaded = f.coordinator();
    await assert.rejects(reloaded.start(), /initial retirement reply lost/);
    assert.deepEqual(f.record.initial, journal);
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      0,
    );
    assert.equal(
      f.calls.filter((x) => x.path.endsWith("/bootstrap")).length,
      1,
    );
    await reloaded.check({ authoritative: true });
    assert.equal(
      f.calls.filter((x) => x.path.endsWith("/initial-retire")).length,
      2,
    );
    assert.equal(
      f.calls.filter((x) => x.path.endsWith("/bootstrap")).length,
      2,
    );
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      1,
    );
  } finally {
    Date.now = now;
  }
});

test("transient initial retirement failure retains unresolved intent and never allocates a fallback", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let lost = true;
  f.response((path, body) => {
    if (path.endsWith("/session") && body.intent === "new" && lost) {
      lost = false;
      throw new TypeError("initial allocation lost for outage");
    }
  });
  await assert.rejects(c.start(), /initial allocation lost/);
  c.stop();
  const journal = f.record.initial,
    now = Date.now;
  f.intercept((path) =>
    path.endsWith("/initial-retire")
      ? new Response(
          JSON.stringify({ code: "CONTROL_UNAVAILABLE", retryable: true }),
          { status: 503 },
        )
      : null,
  );
  try {
    Date.now = () => now() + 13 * 3600000;
    const reloaded = f.coordinator();
    await assert.rejects(reloaded.start(), {
      code: "CONTROL_UNAVAILABLE",
      retryable: true,
    });
    assert.deepEqual(f.record.initial, journal);
    assert.equal(
      f.calls.filter((x) => x.path.endsWith("/bootstrap")).length,
      1,
    );
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      0, // ordinary 12h pruning already expired it; no replacement allocated.
    );
    assert.equal(f.calls.filter((x) => x.body.intent === "new").length, 2);
    f.intercept(undefined);
    await reloaded.check({ authoritative: true });
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      1,
    );
  } finally {
    Date.now = now;
  }
});

test("next-day expired initial request preserves explicit revocation rather than silently starting new access", async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  let lost = true,
    raw;
  f.response(async (path, body, response) => {
    if (path.endsWith("/session") && body.intent === "new" && lost) {
      lost = false;
      raw = (await response.clone().json()).session;
      throw new TypeError("initial reply lost before revoke");
    }
  });
  await assert.rejects(c.start(), /initial reply lost before revoke/);
  c.stop();
  f.app.nodePool.release(raw, origin);
  const now = Date.now;
  try {
    Date.now = () => now() + 13 * 3600000;
    const reloaded = f.coordinator();
    await assert.rejects(reloaded.start(), {
      code: "SESSION_REVOKED",
      retryable: false,
    });
    assert.equal(reloaded.state.status, "revoked");
    assert.equal(
      f.calls.filter((x) => x.path.endsWith("/bootstrap")).length,
      1,
    );
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      0,
    );
  } finally {
    Date.now = now;
  }
});
