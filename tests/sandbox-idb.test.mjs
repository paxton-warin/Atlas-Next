import test from "node:test";
import assert from "node:assert/strict";
import {
  compareSandboxKeys,
  bindSandboxIndexedDB,
  boundedIDBValueBytes,
} from "../runtime/sandbox-idb.ts";

test("sandbox key comparison matches IndexedDB type order and recursive binary/array lexicography", () => {
  const keys = [
    -Infinity,
    -1,
    0,
    Infinity,
    new Date(0),
    new Date(1),
    "",
    "a",
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 1]),
    new Uint8Array([1]),
    [],
    [0],
    [0, "a"],
    [0, "b"],
    [1],
  ];
  for (let a = 0; a < keys.length; a++)
    for (let b = 0; b < keys.length; b++)
      assert.equal(
        compareSandboxKeys(keys[a], keys[b]),
        Math.sign(a - b),
        `${a} / ${b}`,
      );
  assert.equal(
    compareSandboxKeys(
      new Uint8Array([0, 1, 2]).subarray(1),
      new Uint8Array([1, 2]).buffer,
    ),
    0,
  );
});

test("invalid keys and cyclic or sparse arrays throw synchronous DataError", () => {
  const cyclic = [];
  cyclic.push(cyclic);
  for (const key of [
    NaN,
    new Date(NaN),
    null,
    undefined,
    {},
    true,
    cyclic,
    Array(1),
    [{}],
  ])
    assert.throws(() => compareSandboxKeys(key, 0), { name: "DataError" });
});

test("broker binding refuses frontend, credential-bearing and non-HTTP namespace grants before registering a port", () => {
  const port = {
    addEventListener() {
      assert.fail("invalid identity must not bind");
    },
    start() {
      assert.fail("invalid identity must not start");
    },
  };
  for (const website of [
    "https://frontend.example/",
    "https://frontend.example:444/",
    "https://a:b@site.example",
    "file:///private/",
    "data:text/html,example",
  ])
    assert.throws(
      () =>
        bindSandboxIndexedDB({
          port,
          documentId: "document",
          website,
          frontendOrigin: "https://frontend.example",
          factory: {},
        }),
      { name: "TypeError" },
    );
});

test("bounded clone accounting charges full shared backing buffers and Blob/File metadata", () => {
  const backing = new ArrayBuffer(4096),
    view = new Uint8Array(backing, 0, 1);
  assert.throws(() => boundedIDBValueBytes(view, 1024), {
    name: "QuotaExceededError",
  });
  assert.throws(() => boundedIDBValueBytes(new DataView(backing, 0, 1), 1024), {
    name: "QuotaExceededError",
  });
  assert.ok(
    boundedIDBValueBytes([view, new Uint8Array(backing, 1, 1)], 5000) < 5000,
    "shared buffer counted once",
  );
  assert.throws(
    () =>
      boundedIDBValueBytes(new Blob(["a"], { type: "x".repeat(2048) }), 1024),
    { name: "QuotaExceededError" },
  );
  assert.throws(
    () => boundedIDBValueBytes(new File(["a"], "x".repeat(2048)), 1024),
    { name: "QuotaExceededError" },
  );
});

test("bounded sparse array accounting charges holes rather than only enumerable entries", () => {
  assert.throws(() => boundedIDBValueBytes(Array(1000), 1024), {
    name: "QuotaExceededError",
  });
  assert.throws(
    () =>
      boundedIDBValueBytes(
        Array.from({ length: 10 }, () => Array(1000)),
        5000,
      ),
    { name: "QuotaExceededError" },
  );
  let calls = 0;
  assert.throws(
    () =>
      boundedIDBValueBytes({
        get value() {
          calls++;
          return "x";
        },
      }),
    { name: "DataCloneError" },
  );
  assert.equal(calls, 0);
});

test("prototype-forged Date and Error values cannot hide enumerable clone payloads", () => {
  const forgedDate = Object.assign(Object.create(Date.prototype), {
    huge: "x".repeat(2048),
  });
  assert.throws(() => boundedIDBValueBytes(forgedDate, 1024));
  const forgedError = Object.assign(Object.create(Error.prototype), {
    huge: "x".repeat(2048),
  });
  assert.throws(() => boundedIDBValueBytes(forgedError, 1024), {
    name: "QuotaExceededError",
  });
  let calls = 0;
  const prototype = Object.create(Error.prototype, {
    name: {
      get() {
        calls++;
        return "Error";
      },
    },
  });
  assert.throws(() => boundedIDBValueBytes(Object.create(prototype), 1024), {
    name: "DataCloneError",
  });
  assert.equal(calls, 0);
});

test('normal document values and IDB keys retain native cross-realm structured-clone types', async()=>{
  const {runInNewContext}=await import('node:vm');
  const value=runInNewContext('({plain:{save:"durable"},date:new Date(123),map:new Map([["a",new Set([1,2])]]),bytes:new Uint8Array([1,2,3]),view:new DataView(new Uint8Array([4,5]).buffer),buffer:new ArrayBuffer(4),regex:/game/i})');
  assert.ok(boundedIDBValueBytes(value)>0);
  const native=structuredClone(value);
  assert.equal(compareSandboxKeys(value.date,native.date),0);
  assert.equal(compareSandboxKeys(value.buffer,native.buffer),0);
});
