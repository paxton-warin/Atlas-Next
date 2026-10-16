import test from "node:test";
import assert from "node:assert/strict";
import { sandboxRelayURL } from "../runtime/sandbox-relay-protocol.ts";
import { createSandboxRelayFetch } from "../runtime/sandbox-relay.ts";
const assignment = {
  origin: "https://node.example",
  ticket: "secret.ticket",
  generation: 2,
  sessionHash: "a".repeat(64),
};
const request = {
  url: "https://website.example/data",
  method: "GET",
  headers: [],
  credentials: "include",
  mode: "cors",
};
const context = {
  documentId: "bound-document",
  documentURL: "https://website.example/page#fragment",
  origin: "https://website.example",
  signal: new AbortController().signal,
  preflight: false,
};
test("trusted top-level navigation forwards SameSite navigation and omits address-bar referrer", async () => {
  const calls = [],
    contexts = [];
  const fetch = createSandboxRelayFetch({
    documentId: context.documentId,
    documentURL: context.documentURL,
    topLevelURL: "https://website.example/",
    frontendOrigin: "https://atlas.example",
    relay: {
      assignment,
      async request(value) {
        calls.push(value);
        return {
          url: value.url,
          status: 200,
          statusText: "OK",
          headers: [],
          body: new ArrayBuffer(0),
        };
      },
    },
    cookies: {
      async getRequestHeader(value) {
        contexts.push(value);
        return "";
      },
      async storeResponseCookies() {},
    },
  });
  await fetch(
    { ...request, mode: "no-cors" },
    { ...context, topLevelNavigation: true, referrerURL: null },
  );
  assert.deepEqual(calls[0].headers, []);
  assert.equal(contexts[0].topLevelNavigation, true);
  await assert.rejects(
    fetch(request, {
      ...context,
      referrerURL: "https://atlas.example/private",
    }),
    /invalid_trusted_referrer/,
  );
});
test("relay validates assignments and constructs only the selected node WebSocket URL", () => {
  assert.equal(
    sandboxRelayURL(assignment, true),
    "wss://node.example/relay/secret.ticket/",
  );
  for (const patch of [
    { origin: "http://node.example" },
    { origin: "https://node.example/path" },
    { origin: "https://name:pass@node.example" },
    { ticket: "x/y" },
    { generation: 0 },
  ])
    assert.throws(() => sandboxRelayURL({ ...assignment, ...patch }, true));
});
test("trusted relay fetch derives origin/referrer/cookies and awaits cookie commit; no credential headers return", async () => {
  const calls = [],
    contexts = [];
  let committed = false;
  const fetch = createSandboxRelayFetch({
    documentId: context.documentId,
    documentURL: context.documentURL,
    topLevelURL: "https://website.example/",
    frontendOrigin: "https://atlas.example",
    forbiddenOrigins: ["https://other-node.example"],
    relay: {
      assignment,
      async request(r) {
        calls.push(r);
        return {
          status: 200,
          statusText: "OK",
          headers: [
            ["set-cookie", "secret=value; HttpOnly"],
            ["content-type", "text/plain"],
          ],
          body: new ArrayBuffer(0),
        };
      },
    },
    cookies: {
      async getRequestHeader(c) {
        contexts.push(c);
        return "website=only";
      },
      async storeResponseCookies(lines, c) {
        assert.deepEqual(lines, ["secret=value; HttpOnly"]);
        assert.deepEqual(c, contexts[0]);
        await new Promise((r) => setTimeout(r, 10));
        committed = true;
      },
    },
  });
  const response = await fetch(request, context);
  assert.equal(committed, true);
  assert.deepEqual(calls[0].headers, [
    ["origin", "https://website.example"],
    ["referer", "https://website.example/page"],
    ["cookie", "website=only"],
  ]);
  assert.equal(contexts[0].topLevelURL, "https://website.example/");
  assert.deepEqual(response.headers, [["content-type", "text/plain"]]);
  assert.equal(response.url, request.url);
  for (const url of [
    "https://atlas.example/api/admin",
    "https://node.example/relay/secret",
    "https://other-node.example/",
    "http://website.example/",
    "https://a:b@website.example/",
  ])
    await assert.rejects(
      fetch({ ...request, url }, context),
      (e) => e.code === "destination_denied",
    );
  await assert.rejects(
    fetch(request, { ...context, documentId: "other" }),
    (e) => e.code === "relay_document_mismatch",
  );
  await assert.rejects(
    fetch({ ...request, headers: [["cookie", "forged"]] }, context),
    (e) => e.code === "forbidden_request_header",
  );
});
test("preflight never sends/stores cookies and cross-site referrer excludes document path", async () => {
  let sent,
    stored = 0;
  const fetch = createSandboxRelayFetch({
    documentId: context.documentId,
    documentURL: context.documentURL,
    topLevelURL: "https://website.example/",
    frontendOrigin: "https://atlas.example",
    relay: {
      assignment,
      async request(r) {
        sent = r;
        return {
          status: 204,
          statusText: "No Content",
          headers: [["set-cookie", "evil=1"]],
          body: new ArrayBuffer(0),
        };
      },
    },
    cookies: {
      async getRequestHeader(c) {
        assert.equal(c.credentials, "omit");
        return "should-not-send";
      },
      async storeResponseCookies() {
        stored++;
      },
    },
  });
  await fetch(
    { ...request, url: "https://peer.example/", method: "OPTIONS" },
    { ...context, preflight: true },
  );
  assert.equal(stored, 0);
  assert.deepEqual(sent.headers, [
    ["origin", "https://website.example"],
    ["referer", "https://website.example/"],
  ]);
});

test("pending higher assignment generation blocks older renewal; explicit fresh lease can restart at generation1", async () => {
  const { createSandboxRelay } = await import("../runtime/sandbox-relay.ts");
  const workers = [];
  class WorkerFixture {
    constructor() {
      workers.push(this);
    }
    postMessage(m) {
      if (m.type === "initialize") {
        this.start = m;
        this.ready = () =>
          this.onmessage({
            data: { protocol: m.protocol, id: m.id, type: "ready" },
          });
        if (workers.length === 1) queueMicrotask(this.ready);
      }
    }
    terminate() {
      this.terminated = true;
    }
  }
  const relay = await createSandboxRelay({
    assignment: { ...assignment, generation: 1 },
    workerURL: "/worker.js",
    window: {
      location: { origin: "https://atlas.example", protocol: "https:" },
      Worker: WorkerFixture,
    },
    timeoutMs: 2000,
  });
  try {
    const newer = relay.replace({ ...assignment, generation: 3 });
    await assert.rejects(
      relay.replace({ ...assignment, generation: 2 }),
      (e) => e.code === "relay_assignment_conflict",
    );
    workers[1].ready();
    await newer;
    assert.equal(relay.assignment.generation, 3);
    const fresh = { ...assignment, generation: 1, sessionHash: "b".repeat(64) };
    await assert.rejects(
      relay.replace(fresh),
      (e) => e.code === "relay_assignment_conflict",
    );
    const replacing = relay.replace(fresh, { allowNodeChange: true });
    workers[2].ready();
    await replacing;
    assert.equal(relay.assignment.generation, 1);
    assert.equal(relay.assignment.sessionHash, fresh.sessionHash);
  } finally {
    relay.dispose();
  }
});

test("abort-ignoring transport worker is retired after bounded cancellation grace", async () => {
  const { createSandboxRelay } = await import("../runtime/sandbox-relay.ts");
  let worker;
  class WorkerFixture {
    constructor() {
      worker = this;
    }
    postMessage(m) {
      if (m.type === "initialize")
        queueMicrotask(() =>
          this.onmessage({
            data: { protocol: m.protocol, id: m.id, type: "ready" },
          }),
        );
    }
    terminate() {
      this.terminated = true;
    }
  }
  const relay = await createSandboxRelay({
    assignment,
    workerURL: "/worker.js",
    window: {
      location: { origin: "https://atlas.example", protocol: "https:" },
      Worker: WorkerFixture,
    },
    timeoutMs: 2000,
  });
  try {
    const abort = new AbortController(),
      requesting = relay.request(request, abort.signal);
    abort.abort();
    await assert.rejects(requesting, (e) => e.code === "relay_request_aborted");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(worker.terminated, true);
    assert.equal(relay.pending, 0);
    await assert.rejects(
      relay.request(request, new AbortController().signal),
      (e) => e.code === "relay_disposed",
    );
  } finally {
    relay.dispose();
  }
});

test("raw worker bounds aggregate response headers and cancels the unread response", async () => {
  const { installSandboxRelayWorker } = await import(
    "../runtime/sandbox-relay-worker.ts"
  );
  const protocol = "atlas-relay-worker-v1",
    messages = [];
  let cancelled = false;
  class SocketFixture {
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
  scope.location = { origin: "https://atlas.example", protocol: "https:" };
  scope.WebSocket = SocketFixture;
  scope.postMessage = (m) => messages.push(m);
  class ClientFixture {
    constructor() {
      this.session = { stream_response() {}, close() {} };
    }
    async init() {
      this.ready = true;
    }
    async request() {
      return {
        status: 200,
        statusText: "OK",
        headers: Array.from({ length: 100 }, (_, i) => [
          "x-" + i,
          "v".repeat(6000),
        ]),
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      };
    }
  }
  const installed = installSandboxRelayWorker(scope, async () => ({
    HttpEngineClient: ClientFixture,
  }));
  const send = (m) =>
    scope.dispatchEvent(
      new MessageEvent("message", { data: { protocol, ...m } }),
    );
  try {
    send({ id: 1, type: "initialize", assignment, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(messages.find((m) => m.id === 1).type, "ready");
    send({ id: 2, type: "request", request, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      messages.find((m) => m.id === 2 && m.type === "error").code,
      "relay_response_header_limit",
    );
    assert.equal(cancelled, true);
  } finally {
    installed.dispose();
  }
});

test("relay uses broker-serialized redirect Origin and permanent taint, not a child-selected header", async () => {
  const calls = [];
  const fetch = createSandboxRelayFetch({
    documentId: context.documentId,
    documentURL: context.documentURL,
    topLevelURL: context.documentURL,
    frontendOrigin: "https://atlas.example",
    relay: {
      assignment,
      async request(r) {
        calls.push(r);
        return {
          status: 200,
          statusText: "OK",
          headers: [],
          body: new ArrayBuffer(0),
        };
      },
    },
    cookies: {
      getRequestHeader: async () => "",
      storeResponseCookies: async () => {},
    },
  });
  await fetch(
    { ...request, credentials: "omit" },
    {
      ...context,
      requestOrigin: "null",
      responseTaint: "cors",
      redirectCount: 2,
    },
  );
  assert.equal(new Headers(calls[0].headers).get("origin"), "null");
  await fetch(
    { ...request, credentials: "omit", mode: "no-cors" },
    {
      ...context,
      requestOrigin: "null",
      responseTaint: "opaque",
      redirectCount: 2,
    },
  );
  assert.equal(new Headers(calls[1].headers).get("origin"), null);
  await fetch(
    { ...request, credentials: "omit", mode: "no-cors", method: "POST" },
    {
      ...context,
      requestOrigin: "null",
      responseTaint: "opaque",
      redirectCount: 2,
    },
  );
  assert.equal(new Headers(calls[2].headers).get("origin"), "null");
});
