import test from "node:test";
import assert from "node:assert/strict";
import {
  createNativeResourceClient,
  NATIVE_RESOURCE_DOCUMENT_PROTOCOL as protocol,
} from "../runtime/native-resource-owner.ts";
const identity = "atlas-script-context:" + "a".repeat(32),
  resourceOrigin = "https://node.test",
  url = resourceOrigin + "/native-resource/v1/resource/" + "b".repeat(43),
  documentId = "document_context_protocol";
class FakeImage extends EventTarget {
  set src(_value) {
    queueMicrotask(() => this.dispatchEvent(new Event("load")));
  }
}
async function fixture(reply) {
  const channel = new MessageChannel(),
    messages = [],
    bindings = [];
  const client = createNativeResourceClient({
    port: channel.port2,
    documentId,
    resourceOrigin,
    Image: FakeImage,
    timeoutMs: 200,
  });
  channel.port1.onmessage = (e) => {
    messages.push(e.data);
    if (e.data.type === "prepare")
      channel.port1.postMessage({
        protocol,
        documentId,
        type: "resource",
        sequence: e.data.sequence,
        url,
        ...reply(e.data),
      });
  };
  channel.port1.postMessage({
    protocol,
    documentId,
    type: "enroll",
    url: resourceOrigin + "/native-resource/v1/enroll/" + "c".repeat(43),
    nonce: "n",
  });
  await client.ready;
  return {
    client,
    messages,
    bindings,
    prepare: () =>
      client.prepare(
        {
          url: "https://website.test/code.js",
          kind: "script",
          scriptContext: identity,
        },
        undefined,
        (b) => bindings.push(b),
      ),
    dispose() {
      client.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
test("private native context receipt is consumed before URL-only completion, without accepting caller sourceURL", async () => {
  const f = await fixture(() => ({
    scriptContext: { identity, baseURL: "https://website.test/final/code.js" },
  }));
  try {
    const result = await f.prepare();
    assert.equal(result, url);
    assert.equal(typeof result, "string");
    assert.deepEqual(f.bindings, ["https://website.test/final/code.js"]);
    assert.equal(
      Object.hasOwn(
        f.messages.find((m) => m.type === "prepare").descriptor,
        "baseURL",
      ),
      false,
    );
    await assert.rejects(
      f.client.prepare({
        url: "https://website.test/code.js",
        kind: "script",
        scriptContext: identity,
        sourceURL: "https://website.test/other.js",
      }),
    );
  } finally {
    f.dispose();
  }
});
test("missing/mismatched/credentialed/non-HTTP/selected-node context receipts never bind or complete", async () => {
  for (const scriptContext of [
    undefined,
    {
      identity: "atlas-script-context:" + "d".repeat(32),
      baseURL: "https://website.test/x",
    },
    { identity, baseURL: "file:///private" },
    { identity, baseURL: "https://u:p@website.test/x" },
    { identity, baseURL: "https://node.test/x" },
    { identity, baseURL: "https://website.test/x", extra: true },
  ]) {
    const f = await fixture(() => ({ scriptContext }));
    try {
      await assert.rejects(f.prepare());
      assert.deepEqual(f.bindings, []);
    } finally {
      f.dispose();
    }
  }
});
test("private native errors preserve only the fixed boot-diagnostic enum, never arbitrary messages or URLs", async () => {
  for (const [code, expected] of [
    [
      "NATIVE_FONT_DEPENDENCY_UNSUPPORTED",
      "NATIVE_FONT_DEPENDENCY_UNSUPPORTED",
    ],
    ["https://private.test/token=secret", "native_resource_failed"],
    ["UNKNOWN_WEBSITE_REASON", "native_resource_failed"],
  ]) {
    const f = await fixture(() => ({ type: "error", code }));
    try {
      await assert.rejects(
        f.prepare(),
        (e) => e.code === expected && e.message === expected,
      );
      assert.deepEqual(f.bindings, []);
    } finally {
      f.dispose();
    }
  }
});
