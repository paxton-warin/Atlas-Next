import test from "node:test";
import assert from "node:assert/strict";
import {
  createDestinationResolver,
  isPublicIp,
} from "../server/destination-resolver.mjs";

const addresses = [
  { address: "1.1.1.1", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("parallel streams and short-lived repeat connections use one validated DNS lookup", async () => {
  let calls = 0;
  const answer = deferred();
  const resolve = createDestinationResolver({
    lookup: async (host, options) => {
      calls++;
      assert.equal(host, "example.test");
      assert.deepEqual(options, { all: true });
      return answer.promise;
    },
  });
  const waiting = Array.from({ length: 20 }, () => resolve("example.test"));
  answer.resolve(addresses);
  const results = await Promise.all(waiting);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], addresses);
  results[0][0].address = "127.0.0.1";
  assert.deepEqual(await resolve("EXAMPLE.TEST"), addresses);
  assert.deepEqual(results[1], addresses);
  assert.equal(calls, 1);
});

test("expired answers are resolved again and mixed public/private results are rejected", async () => {
  let time = 0,
    calls = 0;
  const resolve = createDestinationResolver({
    now: () => time,
    ttlMs: 100,
    lookup: async () =>
      ++calls === 1
        ? addresses
        : [...addresses, { address: "127.0.0.1", family: 4 }],
  });
  await resolve("changing.test");
  time = 99;
  await resolve("changing.test");
  assert.equal(calls, 1);
  time = 100;
  await assert.rejects(resolve("changing.test"), /Destination rejected/);
  await assert.rejects(resolve("changing.test"), /Destination rejected/);
  assert.equal(calls, 3, "rejected answers are not cached");
});

test("cache uses a bounded least-recently-used set", async () => {
  const hosts = [];
  const resolve = createDestinationResolver({
    maxEntries: 2,
    lookup: async (host) => {
      hosts.push(host);
      return addresses;
    },
  });
  for (const host of [
    "a.test",
    "b.test",
    "a.test",
    "c.test",
    "a.test",
    "b.test",
  ])
    await resolve(host);
  assert.deepEqual(hosts, ["a.test", "b.test", "c.test", "b.test"]);
});

test("empty, malformed, private and IPv4-mapped private addresses never enter public cache", async () => {
  for (const response of [
    [],
    [{ address: "no-address", family: 4 }],
    [{ address: "1.1.1.1", family: 6 }],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
  ]) {
    const resolve = createDestinationResolver({ lookup: async () => response });
    await assert.rejects(resolve("bad.test"), /Destination rejected/);
  }
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("127.0.0.1"), false);
});

test("fixture exceptions never populate the public cache", async () => {
  let calls = 0;
  const resolve = createDestinationResolver({
    lookup: async () => {
      calls++;
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  await resolve("fixture.test", { allowPrivate: true });
  await assert.rejects(resolve("fixture.test"), /Destination rejected/);
  assert.equal(calls, 2);
});

test("DNS errors are shared in flight but never retained for the next attempt", async () => {
  let calls = 0;
  const resolve = createDestinationResolver({
    lookup: async () => {
      if (++calls === 1)
        throw Object.assign(Error("temporary lookup failure"), {
          code: "EAI_AGAIN",
        });
      return addresses;
    },
  });
  const results = await Promise.allSettled([
    resolve("retry.test"),
    resolve("retry.test"),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.deepEqual(await resolve("retry.test"), addresses);
  assert.equal(calls, 2);
});

test("DNS deadline rejects promptly without letting timed-out OS work escape the pending limit", async () => {
  let calls = 0;
  const slow = deferred();
  const resolve = createDestinationResolver({
    timeoutMs: 20,
    maxPending: 1,
    lookup: async () => (++calls === 1 ? slow.promise : addresses),
  });
  const waiting = resolve("slow.test");
  await assert.rejects(resolve("other.test"), /resolver busy/);
  await assert.rejects(waiting, { code: "ETIMEDOUT" });
  await assert.rejects(resolve("slow.test"), /resolver busy/);
  slow.resolve(addresses);
  await new Promise((yes) => setImmediate(yes));
  await resolve("slow.test");
  assert.equal(
    calls,
    2,
    "late resolution after timeout must not populate cache",
  );
});

test("invalid resolver bounds fail explicitly", () => {
  for (const options of [
    { ttlMs: -1 },
    { timeoutMs: 0 },
    { maxEntries: 0 },
    { maxPending: -1 },
  ])
    assert.throws(
      () => createDestinationResolver(options),
      /Invalid DNS resolver limits/,
    );
});
