import test from "node:test";
import assert from "node:assert/strict";
import { createNativeResourceProvider } from "../runtime/native-resource-provider.ts";
const identity = {
    nodeId: "selected",
    resourceOrigin: "https://selected.test",
    leaseHash: "a".repeat(64),
    generation: 1,
  },
  nativeURL =
    "https://selected.test/native-resource/v1/resource/" + "a".repeat(43),
  documentId = "native_document_123456",
  fetch = async () => {
    throw Error("not invoked");
  };
const fields = {
  documentId,
  documentURL: "https://website.test/path/",
  topLevelURL: "https://website.test/",
  contentPolicies: [],
  fetch,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
async function fixture(t, overrides = {}) {
  const { owner: ownerOverrides, ...providerOverrides } = overrides;
  const calls = [],
    ready = deferred();
  let current = { ...identity },
    ownerLive = true,
    ownerDisposed = 0,
    bindingDisposed = 0;
  const owner = {
    bind: async (input) => {
      calls.push(input);
      input.port.postMessage({ type: "queued-before-transfer" });
      return {
        ready: ready.promise,
        prepare: async () => nativeURL,
        dispose: () => {
          bindingDisposed++;
          input.port.close();
        },
      };
    },
    renew: async () => {},
    dispose: () => {
      ownerLive = false;
      ownerDisposed++;
    },
    stats: () => ({ live: ownerLive }),
    ...ownerOverrides,
  };
  const provider = await createNativeResourceProvider({
    owner,
    identity: () => current,
    ...providerOverrides,
  });
  t.after(() => provider.dispose());
  return {
    provider,
    owner,
    calls,
    ready,
    identity: (v) => (current = v),
    ownerDied: () => (ownerLive = false),
    counts: () => ({ ownerDisposed, bindingDisposed }),
  };
}
test("attach returns peer port BEFORE enrollment ready; queued messages survive transfer", async (t) => {
  const f = await fixture(t);
  let awaited = false;
  f.ready.promise.then(() => (awaited = true));
  const bound = await Promise.race([
    f.provider.attach(fields),
    delay(100).then(() => {
      throw Error("deadlocked awaiting ready");
    }),
  ]);
  assert.equal(awaited, false);
  assert.equal(bound.resourceOrigin, identity.resourceOrigin);
  const message = await new Promise((resolve) => {
    bound.port.onmessage = (e) => resolve(e.data);
  });
  assert.deepEqual(message, { type: "queued-before-transfer" });
  f.ready.resolve();
  await bound.ready;
  assert.equal(awaited, true);
  assert.equal(
    await bound.prepare({ url: "/image", kind: "image" }),
    nativeURL,
  );
  bound.dispose();
  assert.equal(f.counts().bindingDisposed, 1);
});
test("bind uses trusted factory and fixed policy/context only, never caller transport fields", async (t) => {
  const seen = [];
  const f = await fixture(t, {
    documentBindings: async (context) => {
      seen.push(context);
      return { fetch };
    },
  });
  const policies = ["img-src 'self'"];
  const result = await f.provider.bind({
    documentId,
    website: "https://website.test/path/",
    contentPolicies: policies,
    coep: "require-corp",
  });
  assert.equal(seen[0].documentURL, "https://website.test/path/");
  assert.equal(seen[0].topLevelURL, "https://website.test/path/");
  assert.ok(Object.isFrozen(seen[0]));
  policies.push("img-src *");
  assert.deepEqual(f.calls[0].contentPolicies, ["img-src 'self'"]);
  assert.equal(f.calls[0].coep, "require-corp");
  assert.equal(result.resourceOrigin, identity.resourceOrigin);
  f.ready.resolve();
  result.dispose();
  await assert.rejects(
    f.provider.bind({
      documentId,
      website: "https://website.test/",
      contentPolicies: [],
      fetch,
    }),
    { code: "native_provider_trusted_bindings_required" },
  );
});
test("duplicate document is reserved while trusted factory is pending", async (t) => {
  const wait = deferred(),
    f = await fixture(t, { documentBindings: () => wait.promise });
  const first = f.provider.bind({
    documentId,
    website: "https://website.test/",
    contentPolicies: [],
  });
  await assert.rejects(
    f.provider.bind({
      documentId,
      website: "https://website.test/",
      contentPolicies: [],
    }),
    { code: "native_provider_document_exists" },
  );
  wait.resolve({ fetch });
  const result = await first;
  f.ready.resolve();
  result.dispose();
});
test("provider disposal during async factory prevents port or owner document allocation", async (t) => {
  const wait = deferred(),
    f = await fixture(t, { documentBindings: () => wait.promise });
  const task = f.provider.bind({
    documentId,
    website: "https://website.test/",
    contentPolicies: [],
  });
  f.provider.dispose();
  wait.resolve({ fetch });
  await assert.rejects(task, { code: "native_provider_disposed" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.provider.stats().documents, 0);
});
test("late owner binding after disposal is explicitly disposed and no peer escapes", async (t) => {
  const wait = deferred();
  let lateDisposed = 0;
  const f = await fixture(t, { owner: { bind: () => wait.promise } });
  const task = f.provider.attach(fields);
  f.provider.dispose();
  wait.resolve({
    ready: Promise.resolve(),
    prepare: async () => nativeURL,
    dispose: () => lateDisposed++,
  });
  await assert.rejects(task, { code: "native_provider_disposed" });
  assert.equal(lateDisposed, 1);
});
test("changed pinned identity revokes adapter and all document ports without switching node", async (t) => {
  const f = await fixture(t),
    bound = await f.provider.attach(fields);
  f.ready.resolve();
  f.identity({ ...identity, generation: 2 });
  await assert.rejects(bound.prepare({ url: "/image", kind: "image" }), {
    code: "native_provider_assignment_changed",
  });
  assert.equal(f.provider.stats().live, false);
  assert.equal(f.counts().bindingDisposed, 1);
  assert.equal(f.counts().ownerDisposed, 1);
});
test("owner unavailable and failed readiness clean provider-owned ports", async (t) => {
  const f = await fixture(t),
    bound = await f.provider.attach(fields);
  f.ready.reject(Error("enrollment failed"));
  await assert.rejects(bound.ready);
  await delay(1);
  assert.equal(f.provider.stats().documents, 0);
  f.ownerDied();
  assert.equal(f.provider.stats().live, false);
});
test("missing original policy and forbidden override fields reject before owner bind", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.provider.attach({ ...fields, contentPolicies: undefined }),
    { code: "native_provider_invalid_document" },
  );
  await assert.rejects(
    f.provider.attach({ ...fields, resourceOrigin: "https://attacker.test" }),
    { code: "native_provider_invalid_document" },
  );
  await assert.rejects(
    f.provider.bind({
      documentId,
      website: "https://website.test/",
      contentPolicies: [],
    }),
    { code: "native_provider_trusted_bindings_required" },
  );
  assert.equal(f.calls.length, 0);
});
test("returned URL is rechecked against selected resource host", async (t) => {
  const f = await fixture(t, {
      owner: {
        bind: async () => ({
          ready: Promise.resolve(),
          prepare: async () =>
            "https://attacker.test/native-resource/v1/resource/" +
            "a".repeat(43),
          dispose() {},
        }),
      },
    }),
    bound = await f.provider.attach(fields);
  await assert.rejects(bound.prepare({ url: "/image", kind: "image" }), {
    code: "native_provider_wrong_resource_node",
  });
});
test("throwing trusted document cleanup does not retain sibling bindings or owner", async (t) => {
  let disposed = 0;
  const f = await fixture(t, {
    owner: {
      bind: async () => ({
        ready: Promise.resolve(),
        prepare: async () => nativeURL,
        dispose() {
          disposed++;
          throw Error("trusted cleanup failed");
        },
      }),
    },
  });
  await f.provider.attach(fields);
  await f.provider.attach({ ...fields, documentId: "native_document_987654" });
  assert.doesNotThrow(() => f.provider.dispose());
  assert.equal(disposed, 2);
  assert.equal(f.counts().ownerDisposed, 1);
  assert.equal(f.provider.stats().documents, 0);
});
