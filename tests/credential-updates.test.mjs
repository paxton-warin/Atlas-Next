import test from "node:test";
import assert from "node:assert/strict";
import { orderedCredentialUpdates } from "../runtime/credential-updates.ts";

const value = (ticket, ticketExpiresAt) => ({ ticket, ticketExpiresAt });
test("credential updates discard stale deadlines and duplicate refreshes", async () => {
  const applied = [];
  const update = orderedCredentialUpdates(value("boot", 100), async (v) => {
    applied.push(v.ticket);
  });
  assert.equal(await update(value("fresh", 200)), true);
  assert.equal(await update(value("stale", 150)), false);
  assert.equal(await update(value("fresh", 200)), true);
  assert.equal(await update(value("conflicting", 200)), false);
  assert.equal(await update(value("invalid", NaN)), false);
  assert.deepEqual(applied, ["fresh"]);
});
test("superseded queued credentials never initialize a connector", async () => {
  const applied = [];
  const update = orderedCredentialUpdates(value("boot", 100), async (v) => {
    applied.push(v.ticket);
  });
  const old = update(value("older", 200));
  const fresh = update(value("newest", 300));
  assert.equal(await old, false);
  assert.equal(await fresh, true);
  assert.deepEqual(applied, ["newest"]);
});
test("in-flight initialization completes before newer connector initialization", async () => {
  const events = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const update = orderedCredentialUpdates(value("boot", 100), async (v) => {
    events.push("start:" + v.ticket);
    if (v.ticket === "older") await held;
    events.push("swap:" + v.ticket);
  });
  const old = update(value("older", 200));
  await Promise.resolve();
  const fresh = update(value("newest", 300));
  assert.deepEqual(events, ["start:older"]);
  release();
  assert.equal(await old, true);
  assert.equal(await fresh, true);
  assert.deepEqual(events, [
    "start:older",
    "swap:older",
    "start:newest",
    "swap:newest",
  ]);
});
test("failed refresh keeps the committed credential and permits retry", async () => {
  let fail = true;
  const applied = [];
  const update = orderedCredentialUpdates(value("boot", 100), async (v) => {
    if (fail) throw Error("transport unavailable");
    applied.push(v.ticket);
  });
  await assert.rejects(update(value("fresh", 200)), /transport unavailable/);
  fail = false;
  assert.equal(await update(value("fresh", 200)), true);
  assert.deepEqual(applied, ["fresh"]);
});
