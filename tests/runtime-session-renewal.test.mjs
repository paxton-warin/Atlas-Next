import test from "node:test";
import assert from "node:assert/strict";
import {
  watchRuntimeSession,
  loadRuntimeConfig,
  runtimeConnectionRetryDelay,
} from "../runtime/connection.ts";
import { refreshRelayCredentials } from "../runtime/relay-controller.ts";

function installGlobals() {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    fetch: globalThis.fetch,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    parent: globalThis.parent,
  };
  const win = new EventTarget(),
    doc = new EventTarget();
  doc.hidden = false;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = { protocol: "https:" };
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.removeEventListener = win.removeEventListener.bind(win);
  globalThis.parent = win;
  return () => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  };
}
test("expired transport credential asks frontend for renewal instead of expiring the document", async () => {
  const cleanup = installGlobals();
  const events = [];
  let watcher;
  try {
    globalThis.fetch = async () => ({
      status: 401,
      json: async () => ({ code: "TICKET_EXPIRED" }),
    });
    watcher = watchRuntimeSession("old", (type, data) =>
      events.push({ type, ...data }),
    );
    await watcher.check();
    assert.deepEqual(events, [
      { type: "session-refresh-needed", code: "TICKET_EXPIRED" },
    ]);
  } finally {
    watcher?.dispose();
    cleanup();
  }
});
test("connectivity failure does not report expiry; mutable watcher uses rotated bearer", async () => {
  const cleanup = installGlobals();
  const events = [],
    bearers = [];
  let watcher;
  try {
    globalThis.fetch = async (_url, options) => {
      bearers.push(options.headers.authorization);
      throw Error("offline");
    };
    watcher = watchRuntimeSession("old", (type) => events.push(type));
    await watcher.check();
    watcher.update("fresh");
    await watcher.check();
    assert.deepEqual(bearers, ["Bearer old", "Bearer fresh"]);
    assert.deepEqual(events, []);
  } finally {
    watcher?.dispose();
    cleanup();
  }
});
test("old in-flight 401 cannot override a newer credential", async () => {
  const cleanup = installGlobals();
  const events = [];
  let resolve, watcher;
  try {
    globalThis.fetch = () => new Promise((r) => (resolve = r));
    watcher = watchRuntimeSession("old", (type) => events.push(type));
    const pending = watcher.check();
    watcher.update("fresh");
    resolve({ status: 401, json: async () => ({ code: "TICKET_EXPIRED" }) });
    await pending;
    assert.deepEqual(events, []);
  } finally {
    watcher?.dispose();
    cleanup();
  }
});
test("relay rotation reuses the client, HTTP pool, live socket and frames", async () => {
  const cleanup = installGlobals(),
    calls = [],
    old = {
      socket: "live",
      updateRelay(relay) { calls.push(relay); },
    },
    frame = { identity: "unchanged" };
  try {
    const controller = {
      transport: old,
      frames: [frame],
      replaceConnector(t) {
        calls.push("swap");
        this.transport = t;
      },
    };
    await refreshRelayCredentials(
      controller,
      "https://relay.example",
      "fresh.ticket",
    );
    assert.deepEqual(calls, ["wss://relay.example/relay/fresh.ticket/"]);
    assert.equal(controller.frames[0], frame);
    assert.equal(old.socket, "live");
    assert.equal(controller.transport, old);
  } finally {
    cleanup();
  }
});
test("relay rotation rejects non-origin addresses and HTTPS downgrades", async () => {
  const cleanup = installGlobals();
  try {
    for (const origin of [
      "http://relay.example",
      "https://relay.example/path",
      "https://u:p@relay.example",
      "https://relay.example/?q=1",
      "javascript:alert(1)",
    ])
      await assert.rejects(
        refreshRelayCredentials({ transport: { updateRelay() {} } }, origin, "ticket"),
      );
  } finally {
    cleanup();
  }
});

test("typed runtime 409 revocation requests authoritative frontend validation", async () => {
  const cleanup = installGlobals(),
    events = [];
  let watcher;
  try {
    globalThis.fetch = async () => ({
      status: 409,
      json: async () => ({ code: "SESSION_REVOKED", retryable: false }),
    });
    watcher = watchRuntimeSession("ticket", (type, data) =>
      events.push({ type, ...data }),
    );
    await watcher.check();
    assert.deepEqual(events, [
      { type: "session-refresh-needed", code: "SESSION_REVOKED" },
    ]);
  } finally {
    watcher?.dispose();
    cleanup();
  }
});
test("generic 409 is not interpreted as revocation", async () => {
  const cleanup = installGlobals(),
    events = [];
  let watcher;
  try {
    globalThis.fetch = async () => ({
      status: 409,
      json: async () => ({ code: "UNRELATED_CONFLICT" }),
    });
    watcher = watchRuntimeSession("ticket", (type) => events.push(type));
    await watcher.check();
    assert.deepEqual(events, []);
  } finally {
    watcher?.dispose();
    cleanup();
  }
});
test("runtime bootstrap retries network, 503 and 429 with the same assigned bearer", async () => {
  const cleanup = installGlobals(),
    setTimeoutOriginal = globalThis.setTimeout,
    delays = [],
    bearers = [];
  let calls = 0;
  try {
    globalThis.setTimeout = (fn, delay) => {
      delays.push(delay);
      return setTimeoutOriginal(fn, 0);
    };
    globalThis.fetch = async (_url, options) => {
      bearers.push(options.headers.authorization);
      if (++calls === 1) throw TypeError("offline");
      if (calls === 2)
        return {
          ok: false,
          status: 503,
          headers: new Headers({ "Retry-After": "2" }),
          json: async () => ({ code: "NODE_UNAVAILABLE", retryable: true }),
        };
      if (calls === 3)
        return {
          ok: false,
          status: 429,
          headers: new Headers({ "Retry-After": "invalid" }),
          json: async () => ({ retryable: true }),
        };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          runtimeOrigin: "https://runtime.example",
          generation: 1,
        }),
      };
    };
    assert.equal((await loadRuntimeConfig("same-ticket")).generation, 1);
    assert.deepEqual(bearers, [
      "Bearer same-ticket",
      "Bearer same-ticket",
      "Bearer same-ticket",
      "Bearer same-ticket",
    ]);
    assert.deepEqual(delays, [1000, 2000, 4000]);
  } finally {
    globalThis.setTimeout = setTimeoutOriginal;
    cleanup();
  }
});
test("runtime bootstrap does not repeatedly retry an authentication failure", async () => {
  const cleanup = installGlobals();
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        json: async () => ({ code: "TICKET_EXPIRED", error: "Expired ticket" }),
      };
    };
    await assert.rejects(loadRuntimeConfig("stale"), /Expired ticket/);
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});
test("runtime bootstrap retry delay clamps valid hints and rejects malformed hints", () => {
  assert.equal(runtimeConnectionRetryDelay(0, "12"), 12000);
  assert.equal(runtimeConnectionRetryDelay(0, "120"), 30000);
  assert.equal(runtimeConnectionRetryDelay(2, "invalid"), 4000);
  assert.equal(runtimeConnectionRetryDelay(0, "0"), 1000);
});
