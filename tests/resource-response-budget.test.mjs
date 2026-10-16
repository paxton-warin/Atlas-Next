import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import {
  resourceResponseBudget,
  DEFAULT_RESPONSE_BYTES,
  SCRIPT_RESPONSE_BYTES,
  AGGREGATE_RELAY_RESPONSE_BYTES,
} from "../runtime/resource-response-budget.ts";
import { bindSandboxNetwork } from "../runtime/sandbox-network.ts";
import { createOpaqueNetworkClient } from "../runtime/opaque-runtime-adapter.ts";
import { installSandboxRelayWorker } from "../runtime/sandbox-relay-worker.ts";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
test("decoded script budget is finite32MiB; other destinations remain8MiB", () => {
  assert.equal(resourceResponseBudget("script"), 32 * 1024 * 1024);
  for (const kind of [
    undefined,
    "connect",
    "style",
    "font",
    "worker",
    "image",
    "media",
    "document",
    "SCRIPT",
  ])
    assert.equal(resourceResponseBudget(kind), 8 * 1024 * 1024);
  assert.equal(AGGREGATE_RELAY_RESPONSE_BYTES, 64 * 1024 * 1024);
});
test("trusted broker and child agree on a9MiB script without broadening ordinary fetch, no-CORS readability or explicit smaller test limits", async () => {
  for (const scenario of ["script", "fetch", "opaque", "explicit-limit"]) {
    const { port1, port2 } = new MessageChannel();
    const broker = bindSandboxNetwork({
      port: port1,
      documentId: "budget-document",
      documentURL: "https://site.test/page",
      frontendOrigin: "https://front.test",
      fetch: async (request) => ({
        url: request.url,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/javascript"]],
        body: new ArrayBuffer(9 * 1024 * 1024),
      }),
    });
    const client = createOpaqueNetworkClient({
      port: port2,
      documentId: "budget-document",
      documentURL: "https://site.test/page",
      ...(scenario === "explicit-limit" ? { maxBodyBytes: 4 } : {}),
    });
    try {
      const request =
        scenario === "fetch"
          ? client.fetch("https://site.test/large")
          : client.fetchResource(
              scenario === "opaque"
                ? "https://peer.test/large"
                : "https://site.test/large",
              { mode: scenario === "opaque" ? "no-cors" : "cors" },
              { destination: "script" },
            );
      if (scenario === "fetch" || scenario === "explicit-limit")
        await assert.rejects(request);
      else {
        const response = await request;
        assert.equal(
          (await response.arrayBuffer()).byteLength,
          scenario === "opaque" ? 0 : 9 * 1024 * 1024,
        );
        assert.equal(response.type, scenario === "opaque" ? "opaque" : "basic");
      }
    } finally {
      client.dispose();
      broker.dispose();
    }
  }
});
function relayFixture(makeResponse) {
  const messages = [];
  class Socket {
    constructor() {
      queueMicrotask(() => {
        const bytes = new Uint8Array(9);
        bytes[0] = 3;
        this.onmessage({ data: bytes.buffer });
      });
    }
    close() {}
  }
  const scope = new EventTarget();
  scope.location = { origin: "https://front.test", protocol: "https:" };
  scope.WebSocket = Socket;
  scope.postMessage = (m) => messages.push(m);
  class Client {
    constructor() {
      this.session = { stream_response() {}, close() {} };
    }
    async init() {
      this.ready = true;
    }
    async request(url, _method, _body, _headers, signal) {
      return {
        status: 200,
        statusText: "OK",
        headers: [],
        body: makeResponse(url, signal),
      };
    }
  }
  const worker = installSandboxRelayWorker(scope, async () => ({
    HttpEngineClient: Client,
  }));
  const send = (m) =>
    scope.dispatchEvent(
      new MessageEvent("message", {
        data: { protocol: "atlas-relay-worker-v1", ...m },
      }),
    );
  const wait = async (id, type) => {
    for (let n = 0; n < 1000; n++) {
      const value = messages.find((m) => m.id === id && m.type === type);
      if (value) return value;
      await pause(1);
    }
    assert.fail("relay reply missing " + id + " " + type);
  };
  send({
    id: 1,
    type: "initialize",
    assignment: {
      origin: "https://node.test",
      ticket: "signed.ticket",
      generation: 1,
      sessionHash: "a".repeat(64),
    },
    timeoutMs: 1000,
  });
  return {
    send,
    wait,
    worker,
    messages,
    request: (id, destination) =>
      send({
        id,
        type: "request",
        timeoutMs: 2000,
        request: {
          url: "https://site.test/" + id,
          method: "GET",
          headers: [],
          mode: "cors",
          credentials: "omit",
          destination,
        },
      }),
  };
}
test("relay streamed script9MiB succeeds, ordinary9MiB and script33MiB are cancelled at their finite limits", async () => {
  const signals = new Map();
  const f = relayFixture((url, signal) => {
    signals.set(url.pathname, signal);
    return new ReadableStream({
      start(c) {
        const mb = 1024 * 1024;
        if (url.pathname === "/4") {
          const chunk = new Uint8Array(8 * mb);
          for (let i = 0; i < 4; i++) c.enqueue(chunk);
          c.enqueue(new Uint8Array(mb));
        } else c.enqueue(new Uint8Array(9 * mb));
        c.close();
      },
    });
  });
  try {
    await f.wait(1, "ready");
    f.request(2, "script");
    assert.equal(
      (await f.wait(2, "response")).response.body.byteLength,
      9 * 1024 * 1024,
    );
    f.request(3, undefined);
    assert.equal((await f.wait(3, "error")).code, "relay_response_limit");
    f.request(4, "script");
    assert.equal((await f.wait(4, "error")).code, "relay_response_limit");
    assert.equal(signals.get("/3").aborted, true);
    assert.equal(signals.get("/4").aborted, true);
  } finally {
    f.worker.dispose();
  }
});
test("relay aggregate retained streams stay bounded64MiB and slots free after cancellation/completion", async () => {
  const streams = new Map();
  const chunk = new Uint8Array(8 * 1024 * 1024);
  const f = relayFixture(
    (url) =>
      new ReadableStream({
        start(c) {
          streams.set(url.pathname, c);
          for (let i = 0; i < 3; i++) c.enqueue(chunk);
        },
      }),
  );
  try {
    await f.wait(1, "ready");
    f.request(2, "script");
    f.request(3, "script");
    await pause(10);
    f.request(4, "script");
    assert.equal((await f.wait(4, "error")).code, "relay_response_limit");
    streams.get("/2").close();
    streams.get("/3").close();
    await f.wait(2, "response");
    await f.wait(3, "response");
    f.request(5, "script");
    await pause(5);
    streams.get("/5").close();
    assert.equal(
      (await f.wait(5, "response")).response.body.byteLength,
      24 * 1024 * 1024,
    );
  } finally {
    f.worker.dispose();
  }
});
test("relay bounds tiny/empty chunk counts, aborts the source and releases accounting for later requests", async () => {
  const signals = new Map();
  const cancelled = new Set();
  const f = relayFixture((url, signal) => {
    signals.set(url.pathname, signal);
    let reads = 0;
    return new ReadableStream(
      {
        pull(c) {
          if (url.pathname === "/4") {
            c.enqueue(new Uint8Array([42]));
            c.close();
            return;
          }
          if (reads++ < 8193)
            c.enqueue(new Uint8Array(url.pathname === "/2" ? 1 : 0));
          else c.close();
        },
        cancel() {
          cancelled.add(url.pathname);
        },
      },
      { highWaterMark: 0 },
    );
  });
  try {
    await f.wait(1, "ready");
    for (const id of [2, 3]) {
      f.request(id, "script");
      const settled = await f.wait(id, "settled");
      assert.equal(settled.type, "settled");
      assert.equal(
        f.messages.find((m) => m.id === id && m.type === "error")?.code,
        "relay_response_chunk_limit",
      );
      assert.equal(signals.get("/" + id).aborted, true);
      assert.equal(cancelled.has("/" + id), true);
    }
    f.request(4, "script");
    assert.deepEqual(
      [...new Uint8Array((await f.wait(4, "response")).response.body)],
      [42],
    );
  } finally {
    f.worker.dispose();
  }
});
test("relay snapshots each stream chunk instead of retaining mutable oversized backing views", async () => {
  const backing = new Uint8Array(1024 * 1024);
  let reads = 0;
  const f = relayFixture(
    () =>
      new ReadableStream(
        {
          pull(c) {
            if (reads++ === 0) {
              backing[0] = 17;
              c.enqueue(backing.subarray(0, 1));
            } else {
              backing[0] = 99;
              backing[1] = 23;
              c.enqueue(backing.subarray(1, 2));
              c.close();
            }
          },
        },
        { highWaterMark: 0 },
      ),
  );
  try {
    await f.wait(1, "ready");
    f.request(2, "script");
    assert.deepEqual(
      [...new Uint8Array((await f.wait(2, "response")).response.body)],
      [17, 23],
    );
  } finally {
    f.worker.dispose();
  }
});
