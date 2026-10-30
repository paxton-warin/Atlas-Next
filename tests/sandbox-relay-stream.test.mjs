import test from "node:test";
import assert from "node:assert/strict";
const { propagatePinnedRelayStreamFailures } = await import(
  process.env.ATLAS_RELAY_WORKER_SOURCE_PATH ||
    "../runtime/sandbox-relay-worker.ts"
);
function fixture() {
  let callbacks, vendorSignal;
  const session = {
    stream_response(_url, headers, end, signal) {
      vendorSignal = signal;
      callbacks = { headers, end };
      // Model the pin's original ungated abort callback for baseline testing.
      signal?.addEventListener("abort", () => end(-1));
      return 41;
    },
  };
  propagatePinnedRelayStreamFailures(session);
  return {
    session,
    get callbacks() {
      return callbacks;
    },
    get vendorSignal() {
      return vendorSignal;
    },
  };
}
test("cancelled pinned request cannot invoke late first headers or end with a cleared handle", async () => {
  const f = fixture(),
    signal = new AbortController(),
    codes = [];
  let handle = 41,
    headers = 0;
  assert.equal(
    f.session.stream_response(
      "https://site.example/",
      () => {
        assert.notEqual(
          handle,
          null,
          "late native headers dereferenced a cleared handle",
        );
        headers++;
      },
      (code) => {
        codes.push(code);
        handle = null;
      },
      signal.signal,
    ),
    41,
  );
  signal.abort();
  let cancelled = false;
  f.callbacks.headers(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  f.callbacks.end(0);
  f.callbacks.end(7);
  assert.equal(f.vendorSignal, undefined);
  assert.equal(headers, 0);
  assert.deepEqual(codes, [-1]);
  assert.equal(cancelled, true);
});
test("already-cancelled signal completes only after request_async can assign its native handle", async () => {
  const f = fixture(),
    signal = new AbortController();
  signal.abort();
  let handle = null;
  const codes = [];
  handle = f.session.stream_response(
    "https://site.example/",
    () => assert.fail("aborted headers"),
    (code) => {
      assert.equal(handle, 41);
      codes.push(code);
    },
    signal.signal,
  );
  assert.deepEqual(codes, []);
  await Promise.resolve();
  assert.deepEqual(codes, [-1]);
});
test("successful end detaches cancellation and keeps the final body intact", async () => {
  const f = fixture(),
    signal = new AbortController(),
    codes = [];
  let body, source;
  f.session.stream_response(
    "https://site.example/",
    (value) => (body = value),
    (code) => codes.push(code),
    signal.signal,
  );
  f.callbacks.headers(
    new ReadableStream({
      start(c) {
        source = c;
      },
    }),
  );
  source.enqueue(new Uint8Array([1, 2, 3]));
  source.close();
  f.callbacks.end(0);
  signal.abort();
  assert.deepEqual(
    [...new Uint8Array(await new Response(body).arrayBuffer())],
    [1, 2, 3],
  );
  assert.deepEqual(codes, [0]);
});
test("truncated successful HTTP body still fails after a nonzero native completion", async () => {
  const f = fixture(),
    signal = new AbortController(),
    codes = [];
  let body, source;
  f.session.stream_response(
    "https://site.example/",
    (value) => (body = value),
    (code) => codes.push(code),
    signal.signal,
  );
  f.callbacks.headers(
    new ReadableStream({
      start(c) {
        source = c;
      },
    }),
  );
  source.enqueue(new Uint8Array([1]));
  source.close();
  f.callbacks.end(18);
  await assert.rejects(
    new Response(body).arrayBuffer(),
    /relay_upstream_failed/,
  );
  signal.abort();
  assert.deepEqual(codes, [18]);
});
test("synchronous terminal return cannot install a stale cancellation listener", () => {
  const signal = new AbortController();
  let listeners = 0;
  const codes = [];
  const add = signal.signal.addEventListener.bind(signal.signal);
  signal.signal.addEventListener = (...args) => {
    listeners++;
    return add(...args);
  };
  const session = {
    stream_response(_url, _headers, end) {
      end(0);
      return 41;
    },
  };
  propagatePinnedRelayStreamFailures(session);
  assert.equal(
    session.stream_response(
      "https://site.example/",
      () => {},
      (code) => codes.push(code),
      signal.signal,
    ),
    41,
  );
  signal.abort();
  assert.equal(listeners, 0);
  assert.deepEqual(codes, [0]);
});

function ownedFixture(completeDuringRemove = false) {
  let removed = 0;
  const session = {
    last_request_id: 0,
    active_requests: 0,
    requests_list: [],
    request_callbacks: {},
    stream_response(_url, _headers, end) {
      this.request_callbacks[this.last_request_id++] = { end };
      return 41;
    },
    remove_request(handle) {
      setTimeout(() => this.remove_request_now(handle), 1);
    },
    remove_request_now(handle) {
      if (completeDuringRemove) {
        const id = Object.keys(this.request_callbacks)[0];
        if (id !== undefined) this.nativeEnd(Number(id), 0);
      }
      removed++;
      this.requests_list.splice(this.requests_list.indexOf(handle), 1);
    },
    nativeEnd(id, code) {
      this.active_requests--;
      this.request_callbacks[id].end(code);
      delete this.request_callbacks[id];
    },
  };
  propagatePinnedRelayStreamFailures(session);
  const start = () => {
    const signal = new AbortController(),
      id = session.last_request_id;
    let handle;
    handle = session.stream_response(
      "https://site.example/",
      () => {},
      () => session.remove_request(handle),
      signal.signal,
    );
    session.requests_list.push(handle);
    session.active_requests++;
    return { signal, id, handle };
  };
  return {
    session,
    start,
    get removed() {
      return removed;
    },
  };
}
test("held cancellation reconciles callbacks only after native removal and cleanup is idempotent", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = ownedFixture(),
    r = f.start();
  r.signal.abort();
  assert.equal(f.session.active_requests, 1);
  assert.equal(Object.keys(f.session.request_callbacks).length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.session.active_requests, 0);
  assert.deepEqual(f.session.request_callbacks, {});
  assert.equal(f.removed, 1);
  f.session.remove_request_now(r.handle);
  assert.equal(f.removed, 1);
});
test("natural completion is not decremented twice by deferred native removal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = ownedFixture(),
    r = f.start();
  f.session.nativeEnd(r.id, 0);
  assert.equal(f.session.active_requests, 0);
  t.mock.timers.tick(1);
  assert.equal(f.session.active_requests, 0);
  assert.equal(f.removed, 1);
});
test("native completion during removal wins over manual-abort bookkeeping", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = ownedFixture(true),
    r = f.start();
  r.signal.abort();
  t.mock.timers.tick(1);
  assert.equal(f.session.active_requests, 0);
  assert.deepEqual(f.session.request_callbacks, {});
  assert.equal(f.removed, 1);
});
test("deferred removal cannot free a reused handle owned by a newer request", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = ownedFixture(),
    a = f.start();
  a.signal.abort();
  f.session.remove_request_now(a.handle);
  const b = f.start();
  t.mock.timers.tick(1);
  assert.equal(f.removed, 1);
  assert.equal(f.session.active_requests, 1);
  assert.equal(Object.keys(f.session.request_callbacks).length, 1);
  f.session.nativeEnd(b.id, 0);
  t.mock.timers.tick(1);
  assert.equal(f.removed, 2);
  assert.equal(f.session.active_requests, 0);
  assert.deepEqual(f.session.request_callbacks, {});
});
