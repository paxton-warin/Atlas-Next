import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { WebSocket } from "ws";
import {
  createOpaqueNetworkClient,
  createPinnedOpaqueRewriter,
  OPAQUE_NETWORK_PROTOCOL,
  OPAQUE_RUNTIME_HELD_GATES,
} from "../runtime/opaque-runtime-adapter.ts";

const documentId = "fixture-document-1";
function setup(options = {}) {
  const channel = new MessageChannel();
  const messages = [];
  channel.port2.addEventListener("message", (event) =>
    messages.push(event.data),
  );
  channel.port2.start();
  const client = createOpaqueNetworkClient({
    port: channel.port1,
    documentId,
    documentURL: "https://website.test/path/index.html",
    ...options,
  });
  const untilMessage = async (index = 0) => {
    for (let n = 0; n < 200 && !messages[index]; n++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(messages[index], "peer received request");
    return messages[index];
  };
  const reply = (sequence, response, overrides = {}) => {
    channel.port2.postMessage({
      protocol: OPAQUE_NETWORK_PROTOCOL,
      documentId,
      sequence,
      type: "response",
      response: {
        url: "https://website.test/api",
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/plain"]],
        body: new TextEncoder().encode("fixture-result").buffer,
        ...response,
      },
      ...overrides,
    });
  };
  const close = () => {
    client.dispose();
    channel.port2.close();
  };
  return { client, messages, untilMessage, reply, close, peer: channel.port2 };
}
const rawRequest = (overrides = {}) => ({
  url: "/api",
  method: "GET",
  headers: [],
  credentials: "same-origin",
  mode: "cors",
  ...overrides,
});
test("resource loader carries original metadata while website fetch ignores extra arguments", async () => {
  const s = setup();
  try {
    const resource = s.client.fetchResource(
      "https://website.test/api",
      {},
      {
        destination: "script",
        nonce: "dGVzdA==",
        integrity: "sha256-original",
        isModule: true,
      },
    );
    const first = await s.untilMessage();
    assert.equal(first.request.destination, "script");
    assert.equal(first.request.policyNonce, "dGVzdA==");
    assert.equal(first.request.policyIntegrity, "sha256-original");
    assert.equal(first.request.isModule, true);
    s.reply(first.sequence, {});
    await resource;
    const website = s.client.fetch(
      "https://website.test/api",
      {},
      { destination: "script", nonce: "dGVzdA==" },
    );
    const second = await s.untilMessage(1);
    assert.equal(second.request.destination, undefined);
    assert.equal(second.request.policyNonce, undefined);
    s.reply(second.sequence, {});
    await website;
  } finally {
    s.close();
  }
});
test("private network events and disposal bypass later mutable native prototypes", async () => {
  const s = setup(),
    leaks = [],
    data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data"),
    nativeApply = Reflect.apply;
  const methods = new Map(
    ["postMessage", "removeEventListener", "close"].map((name) => [
      name,
      {
        own: Object.getOwnPropertyDescriptor(MessagePort.prototype, name),
        fn: MessagePort.prototype[name],
      },
    ]),
  );
  try {
    Object.defineProperty(MessageEvent.prototype, "data", {
      ...data,
      get() {
        if (this.currentTarget !== s.peer) leaks.push("data");
        return nativeApply(data.get, this, []);
      },
    });
    for (const [name, { fn }] of methods)
      Object.defineProperty(MessagePort.prototype, name, {
        configurable: true,
        writable: true,
        value: function (...args) {
          if (this !== s.peer) leaks.push(name);
          return nativeApply(fn, this, args);
        },
      });
    const pending = s.client.request(rawRequest()),
      wire = await s.untilMessage();
    s.reply(wire.sequence);
    assert.equal((await pending).status, 200);
    s.client.dispose();
    assert.deepEqual(leaks, []);
  } finally {
    Object.defineProperty(MessageEvent.prototype, "data", data);
    for (const [name, { own }] of methods)
      if (own) Object.defineProperty(MessagePort.prototype, name, own);
      else Reflect.deleteProperty(MessagePort.prototype, name);
    s.close();
  }
});

test("bound fetch resolves logical URLs, preserves request body, never sends controller credentials", async () => {
  const s = setup();
  try {
    const pending = s.client.fetch("../api#not-http", {
      method: "POST",
      headers: { "x-fixture": "yes" },
      body: "request-data",
      credentials: "include",
    });
    const wire = await s.untilMessage();
    assert.equal(wire.request.url, "https://website.test/api");
    assert.equal(wire.request.credentials, "include");
    assert.equal(new TextDecoder().decode(wire.request.body), "request-data");
    assert.deepEqual(Object.keys(wire).sort(), [
      "documentId",
      "protocol",
      "request",
      "sequence",
      "type",
    ]);
    assert.ok(
      !JSON.stringify(wire).match(/relayTicket|sessionHash|session|cookieJar/),
    );
    s.reply(wire.sequence, {
      headers: [
        ["set-cookie", "hidden=1"],
        ["x-fixture", "reply"],
      ],
    });
    const response = await pending;
    assert.equal(response.url, "https://website.test/api");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.clone().text(), "fixture-result");
    assert.equal(await response.text(), "fixture-result");
    assert.equal(response.bodyUsed, true);
  } finally {
    s.close();
  }
});

test("transfer uses a private byte copy and does not detach website data", async () => {
  const s = setup();
  try {
    const body = new Uint8Array([1, 2, 3]).buffer;
    const pending = s.client.request(rawRequest({ method: "POST", body }));
    const wire = await s.untilMessage();
    assert.equal(body.byteLength, 3);
    assert.deepEqual([...new Uint8Array(wire.request.body)], [1, 2, 3]);
    s.reply(wire.sequence);
    await pending;
  } finally {
    s.close();
  }
});

test("cross-document, wrong-protocol and duplicate replies never resolve another request", async () => {
  const s = setup();
  try {
    const pending = s.client.fetch("/api");
    const wire = await s.untilMessage();
    s.reply(wire.sequence, undefined, { documentId: "other-document" });
    s.reply(wire.sequence, undefined, { protocol: "wrong" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.client.pending, 1);
    s.reply(wire.sequence);
    assert.equal(await (await pending).text(), "fixture-result");
    s.reply(wire.sequence, {
      body: new TextEncoder().encode("duplicate").buffer,
    });
    assert.equal(s.client.pending, 0);
  } finally {
    s.close();
  }
});

test("aborts have a separate monotonic cancellation sequence and late bodies stay discarded", async () => {
  const s = setup();
  try {
    const controller = new AbortController();
    const pending = s.client.fetch("/api", { signal: controller.signal });
    const wire = await s.untilMessage();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    const cancel = await s.untilMessage(1);
    assert.equal(cancel.type, "cancel");
    assert.equal(cancel.targetSequence, wire.sequence);
    assert.equal(cancel.sequence, wire.sequence + 1);
    s.reply(wire.sequence);
    assert.equal(s.client.pending, 0);
  } finally {
    s.close();
  }
});

test("already-aborted input produces no network message", async () => {
  const s = setup();
  try {
    const signal = AbortSignal.abort();
    await assert.rejects(s.client.fetch("/api", { signal }), {
      name: "AbortError",
    });
    assert.equal(s.messages.length, 0);
  } finally {
    s.close();
  }
});

test("timeout sends cancellation and document disposal rejects all pending work", async () => {
  const s = setup({ timeoutMs: 10 });
  try {
    await assert.rejects(s.client.fetch("/api"), { code: "network_timeout" });
    const cancel = await s.untilMessage(1);
    assert.equal(cancel.type, "cancel");
    const pending = s.client.fetch("/next");
    await s.untilMessage(2);
    s.client.dispose();
    await assert.rejects(pending, { code: "document_disposed" });
    await assert.rejects(s.client.fetch("/later"), {
      code: "document_disposed",
    });
  } finally {
    s.close();
  }
});

test("opaque no-cors responses retain no readable bytes, URL, headers or native successful status", async () => {
  const s = setup();
  try {
    const pending = s.client.fetch("https://cross-origin.test/secret", {
      mode: "no-cors",
    });
    const wire = await s.untilMessage();
    assert.equal(wire.request.mode, "no-cors");
    s.reply(wire.sequence, {
      type: "opaque",
      url: "",
      status: 0,
      statusText: "",
      headers: [],
      body: new ArrayBuffer(0),
    });
    const response = await pending;
    assert.equal(response.type, "opaque");
    assert.equal(response.url, "");
    assert.equal(response.status, 0);
    assert.equal(response.ok, false);
    assert.equal(response.body, null);
    assert.equal([...response.headers].length, 0);
    assert.equal(await response.text(), "");
    assert.equal(response.clone().type, "opaque");
    const nativeStatus = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "status",
    ).get;
    assert.equal(nativeStatus.call(response), 0);
  } finally {
    s.close();
  }
});

test("opaque response containing hidden body or headers is rejected", async () => {
  for (const invalid of [
    { headers: [["x-secret", "no"]], body: new ArrayBuffer(0) },
    { headers: [], body: new Uint8Array([1]).buffer },
  ]) {
    const s = setup();
    try {
      const pending = s.client.fetch("https://cross-origin.test/api", {
        mode: "no-cors",
      });
      const wire = await s.untilMessage();
      s.reply(wire.sequence, {
        type: "opaque",
        url: "",
        status: 0,
        ...invalid,
      });
      await assert.rejects(pending, { code: "invalid_network_response" });
    } finally {
      s.close();
    }
  }
});

test("bounded body, concurrency, invalid scheme and malformed response fail closed", async () => {
  const s = setup({ maxBodyBytes: 3, maxPending: 1, maxQueued: 0 });
  try {
    await assert.rejects(
      s.client.fetch("/api", { method: "POST", body: "oversize" }),
      { code: "body_limit" },
    );
    await assert.rejects(s.client.fetch("file:///secret"), TypeError);
    await assert.rejects(
      s.client.fetch("https://user:pass@website.test/"),
      TypeError,
    );
    const pending = s.client.request(rawRequest());
    const wire = await s.untilMessage();
    await assert.rejects(s.client.request(rawRequest()), {
      code: "concurrency_limit",
    });
    s.reply(wire.sequence, {
      status: 200,
      body: new Uint8Array([1, 2, 3, 4]).buffer,
    });
    await assert.rejects(pending, { code: "invalid_network_response" });
  } finally {
    s.close();
  }
});

test("typed peer errors and malformed statuses remain fetch failures", async () => {
  const s = setup();
  try {
    const denied = s.client.fetch("/api");
    const first = await s.untilMessage();
    s.peer.postMessage({
      protocol: OPAQUE_NETWORK_PROTOCOL,
      documentId,
      sequence: first.sequence,
      type: "error",
      code: "cors_denied",
      message: "CORS denied.",
    });
    await assert.rejects(denied, { code: "cors_denied" });
    const malformed = s.client.fetch("/next");
    const second = await s.untilMessage(1);
    s.reply(second.sequence, { status: 101 });
    await assert.rejects(malformed, { code: "invalid_network_response" });
  } finally {
    s.close();
  }
});

function pinnedCore() {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance,
    Uint8Array,
    ArrayBuffer,
    Blob,
    atob,
    btoa,
    WebAssembly,
    Headers,
    Request,
    Response,
    crypto,
    setTimeout,
    clearTimeout,
    MessageChannel,
    WebSocket,
    EventTarget,
    Event,
    MessageEvent,
    ReadableStream,
    WritableStream,
    TransformStream,
    fetch,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../runtime/public/runtime/runtimekit.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  return sandbox.$runtimekit;
}

test("REAL committed RuntimeKit + WASM rewrite HTML, CSS, static/dynamic imports; no substitute parser", () => {
  const rewriter = createPinnedOpaqueRewriter({
    core: pinnedCore(),
    wasm: fs.readFileSync(
      new URL("../runtime/public/runtime/runtimekit.wasm", import.meta.url),
    ),
    documentURL: "https://website.test/path/index.html",
    prefix: "https://atlas.test/~/app/document/",
  });
  const js = rewriter.javascript(
    "globalThis.result = location.origin; import('./lazy.js')",
    "https://website.test/path/main.js",
    true,
  );
  assert.match(js, /\$runtimekit\$wrap\(location\)/);
  assert.match(js, /\$runtimekit\$import/);
  const module = rewriter.javascript(
    "import x from './dependency.js'; export default x;",
    "https://website.test/path/main.js",
    true,
  );
  assert.match(
    module,
    /~\/app\/document\/https%3A%2F%2Fwebsite.test%2Fpath%2Fdependency.js/,
  );
  const html = rewriter.html(
    '<script src="./main.js"></script><img src="/icon.svg"><style>body {background:url(/bg.png)}</style>',
  );
  assert.match(html, /runtimekit-attr-src="\.\/main.js"/);
  assert.match(html, /~\/app\/document\/https%3A%2F%2Fwebsite.test%2Ficon.svg/);
  assert.match(
    rewriter.css("body { background: url(./bg.png) }"),
    /website.test%2Fpath%2Fbg.png/,
  );
  assert.ok(OPAQUE_RUNTIME_HELD_GATES.some((gate) => gate.includes("ESM")));
});

test("unqualified or incompatible core is rejected before boot", () => {
  assert.throws(
    () =>
      createPinnedOpaqueRewriter({
        core: {},
        wasm: new Uint8Array(),
        documentURL: "https://website.test/",
        prefix: "https://atlas.test/~/",
      }),
    /pinned RuntimeKit/,
  );
});

test("Request input overrides preserve body/headers and HEAD results have no body", async () => {
  const s = setup();
  try {
    const original = new Request("https://website.test/original", {
      method: "POST",
      body: "request-input",
      headers: { "x-original": "yes" },
    });
    const pending = s.client.fetch(original, {
      headers: { "x-replacement": "yes" },
    });
    const wire = await s.untilMessage();
    assert.equal(new TextDecoder().decode(wire.request.body), "request-input");
    assert.equal(
      wire.request.headers.some(([key]) => key === "x-original"),
      false,
    );
    assert.equal(
      wire.request.headers.some(([key]) => key === "x-replacement"),
      true,
    );
    s.reply(wire.sequence);
    await pending;
    const head = s.client.fetch("/head", { method: "HEAD" });
    const second = await s.untilMessage(1);
    s.reply(second.sequence, { body: new ArrayBuffer(0) });
    assert.equal((await head).body, null);
  } finally {
    s.close();
  }
});
