import test from "node:test";
import assert from "node:assert/strict";
import { attachFullscreenKeyboard } from "../runtime/fullscreen-keyboard.ts";

function fixture(implementation = () => Promise.resolve()) {
  const doc = new EventTarget();
  const frame = {};
  const calls = [],
    reports = [];
  const keyboard = {
    lock(keys) {
      calls.push(keys);
      return implementation();
    },
    unlock() {
      calls.push("unlock");
    },
  };
  const dispose = attachFullscreenKeyboard(
    doc,
    { keyboard },
    () => doc.fullscreenElement === frame,
    (state) => reports.push(state),
  );
  const fullscreen = (value = frame) => {
    doc.fullscreenElement = value;
    doc.dispatchEvent(new Event("fullscreenchange"));
  };
  return { doc, calls, reports, dispose, fullscreen, frame };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("fullscreen keyboard captures only Escape for the owned runtime and releases on exit", async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  f.fullscreen({}); // unrelated app fullscreen is not a game
  assert.deepEqual(f.calls, []);
  f.fullscreen();
  f.fullscreen(); // duplicate/nested events don't reacquire
  await settle();
  assert.deepEqual(f.calls, [["Escape"]]);
  assert.deepEqual(f.reports, ["locked"]);
  f.fullscreen(null);
  assert.deepEqual(f.calls, [["Escape"], "unlock"]);
  f.dispose();
  assert.equal(f.calls.length, 2);
});

test("unsupported keyboard API reports once without throwing or blocking fullscreen", () => {
  const doc = new EventTarget(),
    reports = [];
  doc.fullscreenElement = {};
  const dispose = attachFullscreenKeyboard(
    doc,
    {},
    () => true,
    (state) => reports.push(state),
  );
  doc.dispatchEvent(new Event("fullscreenchange"));
  assert.deepEqual(reports, ["unavailable"]);
  dispose();
});

for (const synchronous of [false, true]) {
  test(`fullscreen keyboard handles ${synchronous ? "synchronous" : "asynchronous"} denial and allows a later entry`, async () => {
    let denied = true;
    const f = fixture(() => {
      if (!denied) return Promise.resolve();
      const error = new DOMException("Denied", "NotAllowedError");
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    f.fullscreen();
    await settle();
    assert.deepEqual(f.calls, [["Escape"], "unlock"]);
    assert.deepEqual(f.reports, ["denied"]);
    assert.equal(f.doc.fullscreenElement, f.frame);
    f.fullscreen(null);
    denied = false;
    f.fullscreen();
    await settle();
    assert.deepEqual(f.reports, ["denied", "locked"]);
    f.dispose();
    assert.equal(f.calls.at(-1), "unlock");
  });
}

test("exit/unmount cancels pending lock and never reacquires after late resolution", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  f.fullscreen();
  f.dispose();
  assert.deepEqual(f.calls, [["Escape"], "unlock"]);
  resolve();
  await settle();
  assert.deepEqual(f.reports, []);
  f.fullscreen();
  assert.equal(f.calls.length, 2); // listener removed
});

test("rapid fullscreen exit/re-entry ignores stale rejection without unlocking new capture", async () => {
  const pending = [];
  const f = fixture(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  );
  f.fullscreen();
  f.fullscreen(null);
  f.fullscreen();
  pending[0].reject(new Error("Superseded"));
  pending[1].resolve();
  await settle();
  assert.deepEqual(f.calls, [["Escape"], "unlock", ["Escape"]]);
  assert.deepEqual(f.reports, ["locked"]);
  f.fullscreen({});
  assert.equal(f.calls.at(-1), "unlock");
  f.dispose();
});
