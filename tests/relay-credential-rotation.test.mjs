import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import {
  adaptRelayCredentialRotation,
  HTTP_ENGINE_ROTATION_SHA256,
} from "../scripts/runtime-relay-rotation.mjs";

const original = readFileSync(new URL(
  "../upstream/scramjet-ls-bypass/app/vendor/httpengine-client.js", import.meta.url,
));
const adapted = adaptRelayCredentialRotation(original);

function shippedClasses(source) {
  class MockWebSocket extends EventTarget {
    static live = new Set();
    constructor(url) {
      super(); this.url = url; MockWebSocket.live.add(this);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: new Uint8Array([3, 0, 0, 0, 0, 0, 8, 0, 0]).buffer,
      })));
    }
    send() {}
    close() {
      MockWebSocket.live.delete(this);
      this.dispatchEvent(new Event("close"));
    }
  }
  class MockCloseEvent extends Event {
    constructor(type, props = {}) { super(type); Object.assign(this, props); }
  }
  let sessions = 0, newestRelay;
  const context = {
    Event, EventTarget, MessageEvent, CloseEvent: MockCloseEvent,
    WebSocket: MockWebSocket, TextEncoder, Uint8Array, Uint16Array, Uint32Array,
    DataView, ArrayBuffer, Blob, URL,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(context);
  source = source.toString();
  const relay = source.slice(source.indexOf("  const packet_types = {"),
    source.indexOf("  function logger(type, text)"));
  const client = source.slice(source.indexOf("var HttpEngineClient = class {"),
    source.indexOf("if(__exports != exports)"));
  vm.runInContext(relay + `
    globalThis.RelayWebSocket = RelayWebSocket;
    globalThis.connections = _relay_connections;`, context);
  context.httpengine = {
    ready: true, version: { lib: "fixture" },
    relay: { relay_connections: context.connections },
    set_websocket(url) { newestRelay = url; },
    HTTPSession: class {
      constructor() { sessions++; }
      set_connections() {}
    },
  };
  vm.runInContext(client + "\nglobalThis.Client = HttpEngineClient;", context);
  return { ...context, sessions: () => sessions, newestRelay: () => newestRelay };
}
const turn = () => new Promise(queueMicrotask);
const ticket = (n) => `wss://node.fixture/relay/ticket-${n}/`;

test("local adaptation qualifies exact upstream input and final output", () => {
  assert.equal(createHash("sha256").update(adapted).digest("hex"),
    HTTP_ENGINE_ROTATION_SHA256);
  assert.throws(() => adaptRelayCredentialRotation(Buffer.from("changed pin")),
    /qualified HTTP engine/);
});

test("baseline reproduces 32 idle ticket-keyed relay sockets with no active streams", async () => {
  const f = shippedClasses(original);
  for (let n = 0; n < 32; n++) {
    const stream = new f.RelayWebSocket(ticket(n) + "example.com:443");
    await turn(); stream.close();
  }
  assert.equal(f.WebSocket.live.size, 32);
  assert.equal(Object.keys(f.connections).length, 32);
  assert.equal(Object.values(f.connections).reduce((n, c) =>
    n + Object.keys(c.active_streams).length, 0), 0);
});

test("144 credential renewals retain one actual relay socket and one native HTTP session", async () => {
  const f = shippedClasses(adapted), client = new f.Client({ relay: ticket(0) });
  await client.init(); const httpSession = client.session;
  const persistent = new f.RelayWebSocket(ticket(0) + "stream.fixture:443");
  await turn(); const socket = persistent.connection.ws;
  for (let n = 1; n <= 144; n++) {
    client.updateRelay(ticket(n)); await client.init();
    const request = new f.RelayWebSocket(ticket(n) + "example.com:443");
    assert.equal(request.connection.ws, socket);
    await turn(); request.close();
    assert.equal(persistent.stream.open, true);
  }
  assert.equal(f.WebSocket.live.size, 1);
  assert.equal(Object.keys(f.connections).length, 1);
  assert.equal(f.sessions(), 1);
  assert.equal(client.session, httpSession);
  assert.equal(f.newestRelay(), ticket(144));
  assert.equal(f.connections[ticket(0)], undefined);
  persistent.close();
});

test("post-rotation reconnect uses refreshed ticket and a stale close never deletes its replacement", async () => {
  const f = shippedClasses(adapted), client = new f.Client({ relay: ticket(0) });
  await client.init();
  const first = new f.RelayWebSocket(ticket(0) + "example.com:443");
  await turn(); client.updateRelay(ticket(1));
  first.connection.ws.close();
  assert.equal(Object.keys(f.connections).length, 0);
  const next = new f.RelayWebSocket(ticket(1) + "example.com:443");
  await turn();
  assert.equal(next.connection.ws.url, ticket(1));
  first.connection.ws.dispatchEvent(new Event("close"));
  assert.equal(f.connections[ticket(1)], next.connection);
  assert.equal(f.WebSocket.live.size, 1);
});
