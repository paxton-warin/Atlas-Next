import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import {
  bindOpaqueWebSockets,
  createOpaqueWebSocket,
  OPAQUE_WEBSOCKET_PROTOCOL as protocol,
} from "../runtime/opaque-websocket.ts";
import { createPinnedRelayWebSocket } from "../runtime/sandbox-relay-websocket.ts";
class CloseEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.code = init.code || 0;
    this.reason = init.reason || "";
    this.wasClean = !!init.wasClean;
  }
}
const realm = Object.assign(Object.create(globalThis), { CloseEvent });
const pause = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const event = (target, type) =>
  new Promise((r) => target.addEventListener(type, r, { once: true }));
function fixture(t, extra = {}) {
  const { port1, port2 } = new MessageChannel(),
    calls = [],
    peers = [];
  const broker = bindOpaqueWebSockets({
    port: port1,
    documentId: "bound-document",
    documentURL: "https://site.example/page",
    frontendOrigin: "https://atlas.example",
    forbiddenOrigins: ["https://node.example"],
    connect: (url, protocols, context, events) => {
      calls.push({ url, protocols, context });
      const p = {
        events,
        sent: [],
        closed: [],
        send(data) {
          this.sent.push(data);
        },
        close(...args) {
          this.closed.push(args);
        },
      };
      peers.push(p);
      queueMicrotask(() => events.open(protocols.at(-1) || "", ""));
      return p;
    },
    ...extra,
  });
  const child = createOpaqueWebSocket({
    port: port2,
    documentId: "bound-document",
    documentURL: () => "https://site.example/page",
    window: realm,
    ...extra,
  });
  t.after(() => {
    child.dispose();
    broker.dispose();
  });
  return { broker, child, calls, peers };
}
test("opaque WS resolves logical URLs, publishes actual protocol and fixes trusted logical Origin", async (t) => {
  const f = fixture(t),
    ws = new f.child.WebSocket("/socket", ["first", "actual"]);
  assert.equal(ws.url, "wss://site.example/socket");
  assert.equal(ws.readyState, 0);
  assert.throws(() => ws.send("early"), { name: "InvalidStateError" });
  await event(ws, "open");
  assert.equal(ws.protocol, "actual");
  assert.equal(ws.extensions, "");
  assert.equal(ws.readyState, 1);
  assert.equal(f.calls[0].context.origin, "https://site.example");
  assert.equal(f.calls[0].context.documentURL, "https://site.example/page");
  assert.equal(Object.isFrozen(f.calls[0].context), true);
  assert.equal(Object.prototype.toString.call(ws), "[object WebSocket]");
});
test("text, Blob and typed-array sends preserve order and exact slices without detaching website buffers", async (t) => {
  const f = fixture(t),
    ws = new f.child.WebSocket("/socket");
  await event(ws, "open");
  const data = new Uint8Array([1, 2, 3, 4]);
  ws.send(new Blob(["blob"]));
  ws.send(data.subarray(1, 3));
  ws.send("text");
  assert.equal(ws.bufferedAmount, 10);
  for (let i = 0; i < 100 && ws.bufferedAmount; i++) await pause();
  assert.equal(ws.bufferedAmount, 0);
  assert.equal(f.peers[0].sent.length, 3);
  assert.equal(new TextDecoder().decode(f.peers[0].sent[0]), "blob");
  assert.deepEqual([...new Uint8Array(f.peers[0].sent[1])], [2, 3]);
  assert.equal(f.peers[0].sent[2], "text");
  assert.equal(data.byteLength, 4);
});
test("incoming messages use selected binaryType, correct target/currentTarget/origin, and acknowledge bounded delivery", async (t) => {
  const f = fixture(t),
    ws = new f.child.WebSocket("/socket");
  await event(ws, "open");
  let result = event(ws, "message");
  f.peers[0].events.message(new Uint8Array([7, 8]).buffer);
  const first = await result;
  assert.ok(first.data instanceof Blob);
  assert.equal(first.target, ws);
  assert.equal(first.origin, "wss://site.example");
  assert.deepEqual([...new Uint8Array(await first.data.arrayBuffer())], [7, 8]);
  ws.binaryType = "arraybuffer";
  result = event(ws, "message");
  f.peers[0].events.message(new Uint8Array([9]).buffer);
  assert.ok((await result).data instanceof ArrayBuffer);
  await pause();
  assert.equal(f.broker.queuedBytes, 0);
});
test("frontend/node/mixed-content URLs and malformed protocol lists never reach trusted transport", async (t) => {
  const f = fixture(t);
  for (const url of [
    "wss://atlas.example/",
    "wss://node.example/",
    "ws://site.example/",
  ]) {
    const ws = new f.child.WebSocket(url);
    const close = await event(ws, "close");
    assert.equal(close.code, 1006);
    assert.equal(close.wasClean, false);
  }
  assert.equal(f.calls.length, 0);
  for (const protocols of [["same", "same"], ["with space"], ["x".repeat(257)]])
    assert.throws(() => new f.child.WebSocket("/socket", protocols), {
      name: "SyntaxError",
    });
  assert.throws(() => new f.child.WebSocket("wss://site.example/#fragment"), {
    name: "SyntaxError",
  });
  assert.throws(() => new f.child.WebSocket("wss://user:pass@site.example/"), {
    name: "SyntaxError",
  });
});
test("close validates code/UTF8 reason, follows queued sends and reports only supplied transport facts", async (t) => {
  const f = fixture(t),
    ws = new f.child.WebSocket("/socket");
  await event(ws, "open");
  assert.throws(() => ws.close(1006), { name: "InvalidAccessError" });
  assert.throws(() => ws.close(1000, "😀".repeat(31)), { name: "SyntaxError" });
  ws.send(new Blob(["last"]));
  ws.close(3001, "done");
  assert.equal(ws.readyState, 2);
  for (let i = 0; i < 100 && !f.peers[0].closed.length; i++) await pause();
  assert.equal(new TextDecoder().decode(f.peers[0].sent[0]), "last");
  assert.deepEqual(f.peers[0].closed[0], [3001, "done"]);
  const closed = event(ws, "close");
  f.peers[0].events.close(3001, "done", true);
  const value = await closed;
  assert.equal(value.code, 3001);
  assert.equal(value.wasClean, true);
  assert.equal(ws.readyState, 3);
  assert.equal(f.broker.sockets, 0);
});
test("oversized outgoing payloads and document socket limits are explicit and never copied into transport", async (t) => {
  const f = fixture(t, { maxMessageBytes: 8, maxSockets: 1 }),
    ws = new f.child.WebSocket("/socket");
  await event(ws, "open");
  assert.throws(() => new f.child.WebSocket("/another"), {
    name: "QuotaExceededError",
  });
  assert.throws(() => ws.send(new Uint8Array(9)), {
    name: "QuotaExceededError",
  });
  assert.equal(f.peers[0].sent.length, 0);
  assert.throws(() => ws.send(new Blob(["x".repeat(9)])), {
    name: "QuotaExceededError",
  });
});
test("zero-byte messages cannot bypass bounded message-count queues", async (t) => {
  const f = fixture(t),
    ws = new f.child.WebSocket("/socket");
  await event(ws, "open");
  for (let i = 0; i < 64; i++) ws.send("");
  assert.throws(() => ws.send(""), { name: "QuotaExceededError" });
  assert.equal(ws.readyState, 2);
  const raw = fakePinned(),
    control = new AbortController(),
    events = [];
  createPinnedRelayWebSocket({
    client: raw.client,
    url: "wss://site.example/",
    protocols: ["actual"],
    headers: [],
    signal: control.signal,
    onHandshake: () => new Promise(() => {}),
    events: {
      open() {
        events.push("open");
      },
      message() {},
      error() {
        events.push("error");
      },
      close: () => events.push("closed"),
    },
  });
  raw.handshake();
  await pause();
  for (let i = 0; i < 65; i++) raw.callbacks.onmessage("");
  assert.deepEqual(events, ["error", "closed"]);
  assert.equal(raw.curl.baseCloses, 1);
});
test("unread incoming port backlog is bounded and aborts underlying document socket", async (t) => {
  const { port1, port2 } = new MessageChannel();
  let events, signal;
  const replies = [];
  port2.on("message", (v) => replies.push(v));
  const broker = bindOpaqueWebSockets({
    port: port1,
    documentId: "doc",
    documentURL: "https://site.example/",
    frontendOrigin: "https://atlas.example",
    maxMessageBytes: 32,
    maxQueuedBytes: 64,
    connect: (_u, _p, c, e) => {
      events = e;
      signal = c.signal;
      e.open("", "");
      return { send() {}, close() {} };
    },
  });
  t.after(() => {
    broker.dispose();
    port2.close();
  });
  port2.postMessage({
    protocol,
    documentId: "doc",
    sequence: 1,
    socket: 1,
    type: "open",
    url: "wss://site.example/",
    protocols: [],
  });
  while (!events) await pause();
  events.message("x".repeat(32));
  events.message("x".repeat(32));
  assert.equal(broker.queuedBytes, 64);
  events.message("x");
  await pause();
  assert.equal(broker.sockets, 0);
  assert.equal(broker.queuedBytes, 0);
  assert.equal(signal.aborted, true);
  assert.equal(replies.filter((r) => r.type === "message").length, 2);
  assert.equal(replies.at(-1).wasClean, false);
});
test("disposal revokes all peers, pending handshake is timed out and unknown document messages never mint sockets", async (t) => {
  const f = fixture(t);
  const ws = new f.child.WebSocket("/socket");
  await event(ws, "open");
  f.broker.dispose();
  const closed = await event(ws, "close");
  assert.equal(closed.code, 1006);
  assert.equal(f.calls[0].context.signal.aborted, true);
  const { port1, port2 } = new MessageChannel();
  let signal;
  const b = bindOpaqueWebSockets({
    port: port1,
    documentId: "doc",
    documentURL: "https://site.example/",
    frontendOrigin: "https://atlas.example",
    connectTimeoutMs: 10,
    connect: (_u, _p, c) => {
      signal = c.signal;
      return new Promise(() => {});
    },
  });
  t.after(() => {
    b.dispose();
    port2.close();
  });
  port2.postMessage({
    protocol,
    documentId: "doc",
    sequence: 1,
    socket: 1,
    type: "open",
    url: "wss://site.example/",
    protocols: [],
  });
  for (let i = 0; i < 30 && !signal; i++) await pause();
  await pause(20);
  assert.equal(signal.aborted, true);
  assert.equal(b.sockets, 0);
});
function fakePinned() {
  class Curl {
    create_request(_u, _d, end, headers) {
      this.end = end;
      this.headers = headers;
      return 1;
    }
    close() {
      this.baseCloses = (this.baseCloses || 0) + 1;
      this.session_ptr = 0;
    }
  }
  class HTTP extends Curl {}
  let curl,
    callbacks,
    sent = [];
  const client = {
    ready: true,
    session: new HTTP(),
    connect(url, _protocols, _headers, onopen, onmessage, onclose, onerror) {
      curl = Object.assign(new Curl(), {
        url: String(url),
        recv_buffer: [],
        session_ptr: 1,
        connected: false,
        options: { headers: Object.fromEntries(_headers) },
      });
      curl.create_request(
        String(url),
        () => {},
        () => {
          curl.nativeEnds = (curl.nativeEnds || 0) + 1;
          curl.connected = true;
        },
        () => {},
      );
      curl.serializedOptions = JSON.parse(
        JSON.stringify({ headers: curl.options.headers }),
      );
      callbacks = { onopen, onmessage, onclose, onerror };
      return [
        (data) => sent.push(data),
        () => {
          if (curl.connected) {
            curl.connected = false;
            curl.close();
            onclose();
          }
        },
      ];
    },
  };
  return {
    client,
    Curl,
    get curl() {
      return curl;
    },
    get callbacks() {
      return callbacks;
    },
    sent,
    handshake(protocol = "actual") {
      for (const line of [
        "HTTP/1.1 101 Switching Protocols\r\n",
        "Upgrade: websocket\r\n",
        `Sec-WebSocket-Protocol: ${protocol}\r\n`,
        "\r\n",
      ])
        curl.headers(new TextEncoder().encode(line));
      curl.connected = true;
      callbacks.onopen("wrong", "wrong");
    },
  };
}
test("copied-engine close seam sends real code/reason and reports only a fully sent/received handshake as clean", async () => {
  const f = fakePinned(),
    sent = [],
    seen = [];
  f.Curl.prototype.__atlasSendClose = function (bytes) {
    sent.push(bytes.slice());
    return { code: 0, sent: bytes.length };
  };
  const socket = createPinnedRelayWebSocket({
    client: f.client,
    url: "wss://site.example/",
    protocols: ["actual"],
    headers: [],
    signal: new AbortController().signal,
    events: {
      open() {},
      message() {},
      error() {
        seen.push("error");
      },
      close: (...v) => seen.push(v),
    },
  });
  f.handshake();
  await pause();
  socket.close(3001, "ré");
  assert.equal(sent.length, 1);
  assert.equal(new DataView(sent[0].buffer).getUint16(0), 3001);
  assert.equal(new TextDecoder().decode(sent[0].subarray(2)), "ré");
  assert.deepEqual(seen, [], "sending close is not a completed handshake");
  f.curl.__atlasOnCloseFrame(sent[0]);
  f.callbacks.onclose();
  assert.deepEqual(seen, [[3001, "ré", true]]);
});
test("copied-engine partial or failed close send and malformed peer frames never acknowledge a clean close", async () => {
  for (const mode of ["partial", "again", "invalid-code", "invalid-utf8"]) {
    const f = fakePinned(),
      seen = [];
    f.Curl.prototype.__atlasSendClose = function (bytes) {
      return {
        code: mode === "again" ? 81 : 0,
        sent: mode === "partial" ? 0 : bytes.length,
      };
    };
    const socket = createPinnedRelayWebSocket({
      client: f.client,
      url: "wss://site.example/",
      protocols: ["actual"],
      headers: [],
      signal: new AbortController().signal,
      events: {
        open() {},
        message() {},
        error() {
          seen.push("error");
        },
        close: (...v) => seen.push(v),
      },
    });
    f.handshake();
    await pause();
    if (mode === "partial" || mode === "again") socket.close(3001, "x");
    else {
      f.curl.__atlasOnCloseFrame(
        mode === "invalid-code"
          ? new Uint8Array([3, 237])
          : new Uint8Array([11, 185, 255]),
      );
      f.callbacks.onclose();
    }
    assert.ok(seen.includes("error"), mode);
    assert.deepEqual(seen.at(-1), [1006, "", false], mode);
  }
});
test("pinned shim recovers selected protocol from real callback shape and restores vendor prototype immediately", async () => {
  const f = fakePinned(),
    original = f.Curl.prototype.create_request,
    seen = [];
  const control = new AbortController();
  const socket = createPinnedRelayWebSocket({
    client: f.client,
    url: "wss://site.example/socket",
    protocols: ["first", "actual"],
    headers: [["Origin", "https://site.example"]],
    signal: control.signal,
    events: {
      open: (...v) => seen.push(["open", ...v]),
      message: (v) => seen.push(["message", v]),
      error: () => seen.push(["error"]),
      close: (...v) => seen.push(["close", ...v]),
    },
  });
  assert.equal(f.Curl.prototype.create_request, original);
  assert.equal(f.curl.serializedOptions.redirect, "manual");
  f.handshake();
  await pause();
  assert.deepEqual(seen, [["open", "actual", ""]]);
  socket.send("hello");
  assert.deepEqual(f.sent, ["hello"]);
  socket.close(3001, "not-invented");
  assert.deepEqual(seen.at(-1), ["close", 1006, "", false]);
  assert.equal(
    f.curl.baseCloses,
    1,
    "native Curl cleanup occurs once, not double-free",
  );
});
test("pinned shim rejects unoffered protocol and cancels CONNECTING native session once", async () => {
  for (const bad of [true, false]) {
    const f = fakePinned(),
      events = [],
      control = new AbortController();
    createPinnedRelayWebSocket({
      client: f.client,
      url: "wss://site.example/socket",
      protocols: ["actual"],
      headers: [],
      signal: control.signal,
      events: {
        open: () => events.push("open"),
        message() {},
        error: () => events.push("error"),
        close: (code, _r, clean) => events.push([code, clean]),
      },
    });
    if (bad) f.handshake("unoffered");
    else control.abort();
    await pause();
    assert.equal(events.includes("open"), false);
    assert.deepEqual(events.at(-1), [1006, false]);
    assert.equal(f.curl.baseCloses, 1);
  }
});

test("pinned shim late successful callback cannot restart receive state after CONNECTING abort", () => {
  const f = fakePinned(),
    abort = new AbortController();
  let originalEnd = 0;
  const original = f.Curl.prototype.create_request;
  f.Curl.prototype.create_request = function (url, data, end, headers) {
    return original.call(
      this,
      url,
      data,
      () => {
        originalEnd++;
        end(0);
      },
      headers,
    );
  };
  createPinnedRelayWebSocket({
    client: f.client,
    url: "wss://site.example/socket",
    protocols: ["actual"],
    headers: [],
    signal: abort.signal,
    events: { open() {}, message() {}, error() {}, close() {} },
  });
  abort.abort();
  f.curl.end(0);
  assert.equal(originalEnd, 1);
  assert.equal(f.curl.baseCloses, 1);
  assert.equal(f.curl.connected, false);
  assert.equal(f.curl.nativeEnds, undefined);
});
