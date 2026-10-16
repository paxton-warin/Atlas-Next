import test from "node:test";
import assert from "node:assert/strict";
import {
  createSandboxRelay,
  createSandboxRelayWebSocketConnect,
} from "../runtime/sandbox-relay.ts";
import { installSandboxRelayWorker } from "../runtime/sandbox-relay-worker.ts";
const protocol = "atlas-relay-worker-v1",
  pause = (n = 5) => new Promise((r) => setTimeout(r, n));
const assignment = {
  origin: "https://node.example",
  ticket: "ticket",
  generation: 1,
  sessionHash: "a".repeat(64),
};
function fixture(t) {
  const workers = [];
  class Worker {
    constructor() {
      this.messages = [];
      workers.push(this);
    }
    postMessage(m) {
      this.messages.push(m);
      if (m.type === "initialize")
        queueMicrotask(() =>
          this.emit({
            id: m.id,
            type: this.fail ? "error" : "ready",
            code: "relay_unavailable",
          }),
        );
      if (m.type === "ws-send")
        queueMicrotask(() => this.emit({ id: m.id, type: "ws-sent" }));
      if (m.type === "ws-close")
        queueMicrotask(() =>
          this.emit({
            id: m.socket,
            type: "ws-close",
            code: 1006,
            reason: "",
            wasClean: false,
          }),
        );
    }
    emit(m) {
      this.onmessage?.({ data: { protocol, ...m } });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const owner = Object.assign(Object.create(globalThis), {
    location: { origin: "https://atlas.example", protocol: "https:" },
    Worker,
  });
  const creating = createSandboxRelay({
    assignment,
    workerURL: "/worker.js",
    window: owner,
    timeoutMs: 500,
  });
  t.after(async () => {
    (await creating).dispose();
  });
  return { creating, workers };
}
function socket(relay, extra = {}) {
  const events = [],
    control = new AbortController();
  const ws = relay.connectWebSocket(
    "wss://site.example/ws",
    [],
    [["Origin", "https://site.example"]],
    {
      open: (...v) => events.push(["open", ...v]),
      message: (v) => events.push(["message", v]),
      error: () => events.push(["error"]),
      close: (...v) => events.push(["close", ...v]),
    },
    control.signal,
    extra.onHandshake,
  );
  return { ws, events, control };
}
test("replacement retains actual old worker until both established WS and inflight HTTP finish", async (t) => {
  const f = fixture(t),
    relay = await f.creating,
    old = f.workers[0],
    s = socket(relay);
  const sid = old.messages.find((m) => m.type === "ws-open").id;
  old.emit({ id: sid, type: "ws-open", selectedProtocol: "", extensions: "" });
  const request = relay.request(
    {
      url: "https://site.example/http",
      method: "GET",
      headers: [],
      mode: "cors",
      credentials: "omit",
    },
    new AbortController().signal,
  );
  const rid = old.messages.find((m) => m.type === "request").id;
  await relay.replace({ ...assignment, generation: 2 });
  assert.equal(old.terminated, undefined);
  assert.equal(relay.webSockets, 1);
  await s.ws.send("retained");
  assert.equal(old.messages.at(-1).type, "ws-send");
  s.ws.close();
  await pause();
  assert.equal(old.terminated, undefined, "HTTP remains in flight");
  old.emit({
    id: rid,
    type: "response",
    response: {
      status: 200,
      statusText: "OK",
      headers: [],
      body: new ArrayBuffer(0),
    },
  });
  assert.equal((await request).status, 200);
  assert.equal(old.terminated, true);
  assert.equal(relay.webSockets, 0);
});
test("failed replacement leaves established WS and assignment active", async (t) => {
  const f = fixture(t),
    relay = await f.creating,
    old = f.workers[0],
    s = socket(relay);
  const replacing = relay.replace({ ...assignment, generation: 2 });
  f.workers[1].fail = true;
  await assert.rejects(replacing, (e) => e.code === "relay_unavailable");
  assert.equal(old.terminated, undefined);
  assert.equal(relay.assignment.generation, 1);
  await s.ws.send("still-active");
});
test("handshake commit remains awaited and abort/disposal cannot acknowledge stale cookie work", async (t) => {
  for (const kind of ["abort", "dispose", "reject"]) {
    const f = fixture(t),
      relay = await f.creating,
      worker = f.workers[0];
    let release;
    const pending = new Promise(
      (resolve, reject) =>
        (release =
          kind === "reject"
            ? () => reject(Error("native commit failed"))
            : resolve),
    );
    const s = socket(relay, { onHandshake: () => pending }),
      id = worker.messages.find((m) => m.type === "ws-open").id;
    worker.emit({
      id,
      type: "ws-headers",
      headers: [["set-cookie", "website=durable"]],
    });
    await pause();
    assert.equal(
      worker.messages.some((m) => m.type === "ws-headers-committed"),
      false,
    );
    if (kind === "abort") s.control.abort();
    else if (kind === "dispose") relay.dispose();
    release();
    await pause();
    assert.equal(
      worker.messages.some((m) => m.type === "ws-headers-committed"),
      false,
      kind,
    );
    assert.equal(
      s.events.some((e) => e[0] === "open"),
      false,
    );
    assert.equal(relay.webSockets, 0);
  }
});
test("fixed helper derives cookies/Origin, commits before open and denies current relay without caller blacklist", async () => {
  const controller = new AbortController(),
    context = {
      documentId: "fixed",
      documentURL: "https://site.example/path",
      origin: "https://site.example",
      signal: controller.signal,
    };
  let committed = false,
    seen;
  const connect = createSandboxRelayWebSocketConnect({
    documentId: context.documentId,
    documentURL: context.documentURL,
    topLevelURL: context.documentURL,
    frontendOrigin: "https://atlas.example",
    relay: {
      assignment,
      connectWebSocket(...args) {
        seen = args;
        return { send() {}, close() {} };
      },
    },
    cookies: {
      async getRequestHeader(c) {
        assert.equal(c.requestURL, "https://socket.example/ws");
        return "private=HttpOnly";
      },
      async storeResponseCookies(lines, c) {
        assert.equal(c.signal, controller.signal);
        assert.deepEqual(lines, ["server=value; HttpOnly"]);
        await pause();
        committed = true;
      },
    },
  });
  await connect("wss://socket.example/ws", [], context, {});
  assert.deepEqual(seen[2], [
    ["Origin", "https://site.example"],
    ["Cookie", "private=HttpOnly"],
  ]);
  const committing = seen[5]([["set-cookie", "server=value; HttpOnly"]]);
  assert.equal(committed, false);
  await committing;
  assert.equal(committed, true);
  for (const url of [
    "wss://node.example/ws",
    "wss://atlas.example/ws",
    "ws://socket.example/ws",
  ])
    await assert.rejects(
      connect(url, [], context, {}),
      (e) => e.code === "relay_websocket_destination_denied",
    );
  await assert.rejects(
    connect(
      "wss://socket.example/ws",
      [],
      { ...context, origin: "https://forged.example" },
      {},
    ),
    (e) => e.code === "relay_websocket_destination_denied",
  );
});
async function rawWorker(t) {
  const scope = new EventTarget(),
    messages = [],
    peers = [];
  class Probe {
    constructor() {
      queueMicrotask(() => {
        const b = new Uint8Array(9);
        b[0] = 3;
        this.onmessage({ data: b.buffer });
      });
    }
    close() {}
  }
  class Curl {
    create_request(_u, _d, end, headers) {
      this.end = end;
      this.headers = headers;
    }
    close() {
      this.closed = true;
      this.session_ptr = 0;
    }
  }
  class Client {
    constructor() {
      this.session = Object.assign(new Curl(), { stream_response() {} });
    }
    async init() {
      this.ready = true;
    }
    connect(url, _protocols, headers, onopen, onmessage, onclose, onerror) {
      const c = Object.assign(new Curl(), {
        url: String(url),
        recv_buffer: [],
        session_ptr: 1,
        connected: false,
        options: { headers: Object.fromEntries(headers) },
      });
      c.create_request(
        String(url),
        () => {},
        () => {},
        () => {},
      );
      JSON.stringify({ headers: c.options.headers });
      peers.push({
        c,
        onopen,
        onmessage,
        onclose,
        onerror,
        open() {
          c.headers(
            new TextEncoder().encode(
              "HTTP/1.1 101 Switching Protocols\r\n\r\n",
            ),
          );
          c.connected = true;
          onopen();
        },
      });
      return [
        () => {},
        () => {
          if (c.connected) {
            c.connected = false;
            c.close();
            onclose();
          }
        },
      ];
    }
  }
  scope.location = { origin: "https://atlas.example", protocol: "https:" };
  scope.WebSocket = Probe;
  scope.postMessage = (m) => messages.push(m);
  const instance = installSandboxRelayWorker(scope, async () => ({
    HttpEngineClient: Client,
  }));
  let id = 0;
  const send = (m) =>
    scope.dispatchEvent(
      new MessageEvent("message", { data: { protocol, id: ++id, ...m } }),
    );
  t.after(() => instance.dispose());
  send({ type: "initialize", assignment, timeoutMs: 500 });
  await pause();
  return { send, messages, peers };
}
test("actual worker waits for cookie commit ACK, bounds zero-byte incoming queues and disposes native sockets", async (t) => {
  const f = await rawWorker(t);
  f.send({
    id: 10,
    type: "ws-open",
    url: "wss://site.example/",
    headers: [["Origin", "https://site.example"]],
    protocols: [],
    timeoutMs: 500,
  });
  f.peers[0].open();
  await pause();
  assert.equal(
    f.messages.some((m) => m.id === 10 && m.type === "ws-headers"),
    true,
  );
  assert.equal(
    f.messages.some((m) => m.id === 10 && m.type === "ws-open"),
    false,
  );
  f.send({ type: "ws-headers-committed", socket: 10 });
  await pause();
  assert.equal(
    f.messages.some((m) => m.id === 10 && m.type === "ws-open"),
    true,
  );
  for (let i = 0; i < 65; i++) f.peers[0].onmessage("");
  assert.equal(
    f.messages.filter((m) => m.id === 10 && m.type === "ws-message").length,
    64,
  );
  assert.equal(
    f.messages.some((m) => m.id === 10 && m.type === "ws-error"),
    true,
  );
  assert.equal(f.peers[0].c.closed, true);
});
test("actual worker limits connecting sockets, oversized payloads and rejects late handshake commits after disposal", async (t) => {
  const f = await rawWorker(t);
  for (let i = 0; i < 17; i++)
    f.send({
      id: 20 + i,
      type: "ws-open",
      url: "wss://site.example/",
      headers: [["Origin", "https://site.example"]],
      protocols: [],
      timeoutMs: 500,
    });
  assert.equal(f.peers.length, 16);
  assert.equal(
    f.messages.some((m) => m.id === 36 && m.type === "ws-error"),
    true,
  );
  f.peers[0].open();
  await pause();
  f.send({ type: "ws-close", socket: 20 });
  await pause();
  f.send({ type: "ws-headers-committed", socket: 20 });
  await pause();
  assert.equal(
    f.messages.some((m) => m.id === 20 && m.type === "ws-open"),
    false,
  );
  f.peers[1].open();
  await pause();
  f.send({ type: "ws-headers-committed", socket: 21 });
  await pause();
  f.peers[1].onmessage("x".repeat(1024 * 1024 + 1));
  assert.equal(
    f.messages.some((m) => m.id === 21 && m.type === "ws-error"),
    true,
  );
  f.send({ type: "dispose" });
  for (const p of f.peers) assert.equal(p.c.closed, true);
});
