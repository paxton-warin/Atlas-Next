import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { adaptRelayCredentialRotation } from "../scripts/runtime-relay-rotation.mjs";
import { adaptHttpEngineLifecycle } from "../scripts/runtime-httpengine-lifecycle.mjs";

const original = await readFile(new URL("../upstream/scramjet-ls-bypass/app/vendor/httpengine-client.js", import.meta.url));
const rotated = adaptRelayCredentialRotation(original);
const adapted = adaptHttpEngineLifecycle(rotated).toString();
function harness() {
  const timeouts = new Map(), intervals = new Map(), allocated = new Set();
  let nextTimer = 0, nextPointer = 1, removals = 0, cleanups = 0, functionsRemoved = 0;
  const heap = new Uint8Array(1024); heap.set(new TextEncoder().encode("data"));
  const context = {
    Map, ReadableStream, DOMException, TypeError, Error, Uint8Array, queueMicrotask,
    check_loaded() {},
    Module: { HEAPU8: heap, addFunction: () => ++nextTimer, removeFunction: () => functionsRemoved++ },
    _session_create: () => 1000,
    _session_add_request() {}, _session_perform() {}, _session_get_active: () => 0,
    _session_remove_request: () => removals++, _session_cleanup: () => cleanups++,
    _create_request() {},
    _request_cleanup(pointer) { assert.ok(allocated.delete(pointer), "native request freed twice"); },
    c_func(_fn, _args) { const pointer = nextPointer++; allocated.add(pointer); return pointer; },
    setTimeout(fn) { const id = ++nextTimer; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  const start = adapted.indexOf("  class CurlSession {");
  const end = adapted.indexOf("  class HTTPSession extends CurlSession", start);
  const Session = vm.runInNewContext(adapted.slice(start, end) + "; CurlSession", context);
  const session = new Session();
  const flush = () => { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); } };
  const streamRequest = signal => {
    const state = { id: session.last_request_id, ends: [], headers: 0, body: null, handle: null };
    state.handle = session.stream_response("http://fixture/", body => { state.headers++; state.body = body; },
      code => { state.ends.push(code); session.remove_request(state.handle); }, signal);
    session.start_request(state.handle);
    return state;
  };
  const empty = () => {
    assert.equal(session.active_requests, 0); assert.equal(Object.keys(session.request_callbacks).length, 0);
    assert.equal(session.requests_list.length, 0); assert.equal(session.atlasRequests.size, 0);
    assert.equal(allocated.size, 0); assert.equal(intervals.size, 0);
  };
  return { session, streamRequest, flush, empty, context, intervals, allocated,
    reuse(pointer) { nextPointer = pointer; }, counts: () => ({ removals, cleanups, functionsRemoved }) };
}

test("lifecycle adaptation accepts only the post-rotation artifact", () => {
  assert.throws(() => adaptHttpEngineLifecycle(original), /post-rotation/);
  assert.throws(() => adaptHttpEngineLifecycle(Buffer.from(rotated.toString() + "\n")), /post-rotation/);
  assert.doesNotThrow(() => new Function(adapted));
  assert.match(adapted, /updateRelay\(relay\)/);
});
test("natural completion accounts once and removes its handle", async () => {
  const h = harness(), r = h.streamRequest();
  h.session.end_callback(r.id, 0); h.session.end_callback(r.id, 0); h.flush();
  assert.deepEqual(r.ends, [0]); assert.equal(r.headers, 1); assert.equal((await r.body.getReader().read()).done, true);
  h.empty(); assert.equal(h.counts().removals, 1);
});
test("abort before headers cleans up without a later network byte", () => {
  const h = harness(), signal = new AbortController(), r = h.streamRequest(signal.signal);
  signal.abort(); h.flush(); assert.deepEqual(r.ends, [-1]); assert.equal(r.headers, 0); h.empty();
});
test("already aborted signal waits until the native handle is assigned", async () => {
  const h = harness(), signal = new AbortController(); signal.abort();
  const r = h.streamRequest(signal.signal); assert.deepEqual(r.ends, []);
  await Promise.resolve(); h.flush(); assert.deepEqual(r.ends, [-1]); h.empty();
});
test("body cancel terminates a held response with no later data", async () => {
  const h = harness(), r = h.streamRequest(); h.session.data_callback(r.id, 0, 4);
  await r.body.cancel(); h.flush(); assert.deepEqual(r.ends, [-1]); h.empty();
});
test("native end racing an abort decrements once and ignores late callbacks", () => {
  const h = harness(), signal = new AbortController(), r = h.streamRequest(signal.signal);
  signal.abort(); h.session.end_callback(r.id, 0);
  h.session.headers_callback(r.id, 999999, 100); h.session.data_callback(r.id, 999999, 100);
  h.flush(); assert.deepEqual(r.ends, [-1]); h.empty();
});
test("late data after cancellation cannot emit headers or read recycled memory", () => {
  const h = harness(), signal = new AbortController(), r = h.streamRequest(signal.signal);
  signal.abort(); h.session.data_callback(r.id, 999999, 100); h.session.headers_callback(r.id, 999999, 100);
  h.flush(); assert.equal(r.headers, 0); h.empty();
});
test("error after headers rejects the stream rather than inventing a clean EOF", async () => {
  const h = harness(), r = h.streamRequest(); h.session.data_callback(r.id, 0, 4);
  const reader = r.body.getReader(); assert.equal((await reader.read()).value.length, 4);
  h.session.end_callback(r.id, 18); h.flush();
  await assert.rejects(reader.read(), /HTTP transport failed: 18/); assert.deepEqual(r.ends, [18]); h.empty();
});
test("natural completion detaches its AbortSignal listener", async () => {
  const h = harness(), signal = new AbortController(), r = h.streamRequest(signal.signal);
  h.session.end_callback(r.id, 0); h.flush(); signal.abort();
  assert.deepEqual(r.ends, [0]); assert.equal((await r.body.getReader().read()).done, true); h.empty();
});
test("an old removal timer cannot free a recycled native pointer", () => {
  const h = harness(), a = h.streamRequest(); h.session.remove_request(a.handle);
  h.session.remove_request_now(a.handle); h.reuse(a.handle);
  const b = h.streamRequest(); assert.equal(a.handle, b.handle);
  h.flush(); assert.equal(h.session.atlasRequests.size, 1); assert.equal(h.session.active_requests, 1);
  h.session.end_callback(b.id, 0); h.flush(); h.empty();
});
test("close releases every request and is idempotent", () => {
  const h = harness(), requests = Array.from({ length: 6 }, () => h.streamRequest());
  h.session.close(); h.session.close(); h.flush(); h.flush(); h.session.close_now();
  h.empty(); for (const r of requests) assert.deepEqual(r.ends, [-1]);
  assert.equal(h.counts().cleanups, 1); assert.equal(h.counts().functionsRemoved, 3);
});
test("accounting is published before a synchronous native completion", () => {
  const h = harness(); h.context._session_perform = () => h.session.end_callback(0, 0);
  const r = h.streamRequest(); h.flush(); assert.deepEqual(r.ends, [0]); h.empty();
});
