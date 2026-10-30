/** Real unchanged pinned HttpEngine in trusted per-assignment workers -> real
 * authorized Wisp node A/B -> controlled website. No frontend payload proxy.
 * Regression: response arrives immediately before abort; no late header may use a cleared native handle.
 * Standalone: node tests/sandbox-relay-cancellation-browser.mjs (fixture4199). */
import Fastify from "fastify";
import fs from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { createNodeService } from "../server/node-service.mjs";
import { signTicket } from "../server/node-ticket.mjs";
const frontendApp = Fastify({ logger: false }),
  website = Fastify({ logger: false });
const calls = [],
  payloadPaths = [],
  nodes = [],
  errors = [];
let websitePendingResolve, peerPendingResolve;
website.get("/peer-hold", async (_req, reply) => {
  await new Promise((resolve) => (peerPendingResolve = resolve));
  return reply
    .type("text/plain")
    .send("independent peer survived cancellation");
});
website.get("/data", (req, reply) => {
  calls.push({
    path: req.url,
    origin: req.headers.origin,
    referer: req.headers.referer,
    cookie: req.headers.cookie,
  });
  return reply
    .header("Set-Cookie", [
      "website=private; HttpOnly; Path=/",
      "visible=1; Path=/",
    ])
    .type("text/plain")
    .send("payload through assigned Wisp node");
});
website.get("/hold", async (_req, reply) => {
  await new Promise((r) => (websitePendingResolve = r));
  return reply.type("text/plain").send("old assignment survived replacement");
});
website.get("/truncated", (_request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/plain",
    "content-length": "100",
  });
  reply.raw.write("partial");
  setTimeout(() => reply.raw.destroy(), 20);
});
website.get("/large", (_req, reply) =>
  reply
    .type("application/octet-stream")
    .send(Buffer.alloc(9 * 1024 * 1024, 120)),
);
const modules = [
  "sandbox-relay",
  "sandbox-relay-protocol",
  "sandbox-relay-worker",
  "sandbox-relay-websocket",
  "resource-response-budget",
];
for (const name of modules) {
  const source = fs.readFileSync(
    name === "sandbox-relay-worker" &&
      process.env.ATLAS_RELAY_WORKER_SOURCE_PATH
      ? process.env.ATLAS_RELAY_WORKER_SOURCE_PATH
      : new URL(`../runtime/${name}.ts`, import.meta.url),
    "utf8",
  );
  const code = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replaceAll(/(from\s+["'])\.\/([^"']+)\.ts/g, "$1./$2.js");
  frontendApp.get(`/${name}.js`, (_req, reply) =>
    reply.type("application/javascript").send(code),
  );
}
frontendApp.get("/clients/httpengine-client.js", (_req, reply) =>
  reply
    .type("application/javascript")
    .send(
      fs.readFileSync(
        new URL(
          "../runtime/public/clients/httpengine-client.js",
          import.meta.url,
        ),
      ),
    ),
);
frontendApp.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Trusted frontend relay test</title>"),
);
frontendApp.get("/favicon.ico", (_req, reply) => reply.code(204).send());
frontendApp.addHook("onRequest", (req, _reply, done) => {
  payloadPaths.push(req.url);
  done();
});
let browser;
try {
  await website.listen({ host: "127.0.0.1", port: 4199 });
  await frontendApp.listen({ host: "127.0.0.1", port: 0 });
  const frontend = "http://localhost:" + frontendApp.server.address().port;
  const lease = "a".repeat(64),
    secret = "controlled-relay-fixture-secret-0123456789";
  for (let i = 0; i < 2; i++) {
    const node = await createNodeService({
      id: "node-" + i,
      secret,
      fixture: true,
      staticDir: "/not-built",
      runtimeOrigin: "http://localhost:1",
    });
    await node.listen({ host: "127.0.0.1", port: 0 });
    node.applyControl({
      state: "active",
      revision: 1,
      leases: [lease],
      grants: [{ hash: lease, generation: 1, expiresAt: Date.now() + 600000 }],
    });
    nodes.push(node);
  }
  const assignments = nodes.map((node, i) => {
    const origin = "http://localhost:" + node.server.address().port;
    return {
      origin,
      generation: 1,
      sessionHash: lease,
      ticket: signTicket(
        {
          lease,
          generation: 1,
          node: "node-" + i,
          name: "Controlled node " + i,
          origin: frontend,
          runtimeOrigin: frontend,
          relayOrigin: origin,
          role: "frontend-controller-v2",
          expires: Date.now() + 600000,
        },
        secret,
      ),
    };
  });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage(),
    sockets = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("websocket", (ws) => {
    sockets.push(new URL(ws.url()).origin);
  });
  page.on(
    "worker",
    (worker) =>
      void worker
        .evaluate(() => {
          const interval = setInterval(() => {
            const p = self.HttpEngineTransport?.HttpEngineClient?.prototype;
            if (!p) return;
            clearInterval(interval);
            const request = p.request;
            p.request = async function (...args) {
              self.__probeSession = this.session;
              return Reflect.apply(request, this, args);
            };
          }, 0);
        })
        .catch(() => {}),
  );
  await page.goto(frontend);
  const initial = await page.evaluate(
    async ({ assignments }) => {
      const { createSandboxRelay, createSandboxRelayFetch } = await import(
        "/sandbox-relay.js"
      );
      const relay = await createSandboxRelay({
        assignment: assignments[0],
        workerURL: "/sandbox-relay-worker.js",
        timeoutMs: 5000,
      });
      window.relay = relay;
      const context = {
        documentId: "real-assigned-document",
        documentURL: "http://127.0.0.1:4199/page",
        origin: "http://127.0.0.1:4199",
        signal: new AbortController().signal,
        preflight: false,
      };
      const cookieOps = [];
      const fetch = createSandboxRelayFetch({
        documentId: context.documentId,
        documentURL: context.documentURL,
        topLevelURL: context.documentURL,
        frontendOrigin: location.origin,
        relay,
        cookies: {
          async getRequestHeader() {
            return "website=only";
          },
          async storeResponseCookies(lines, c) {
            cookieOps.push({ lines, url: c.requestURL });
          },
        },
      });
      window.relayFetch = fetch;
      window.relayContext = context;
      const response = await fetch(
        {
          url: "http://127.0.0.1:4199/data",
          method: "GET",
          headers: [],
          credentials: "include",
          mode: "same-origin",
        },
        context,
      );
      return {
        body: new TextDecoder().decode(response.body),
        headers: response.headers,
        cookieOps,
        assignment: relay.assignment.origin,
      };
    },
    { assignments },
  );
  assert.equal(initial.body, "payload through assigned Wisp node");
  assert.equal(initial.assignment, assignments[0].origin);
  assert.deepEqual(initial.cookieOps[0], {
    lines: ["website=private; HttpOnly; Path=/", "visible=1; Path=/"],
    url: "http://127.0.0.1:4199/data",
  });
  assert.equal(
    initial.headers.some(([name]) => /^set-cookie/i.test(name)),
    false,
  );
  assert.equal(calls[0].cookie, "website=only");
  assert.equal(calls[0].referer, "http://127.0.0.1:4199/page");
  await page.evaluate(() => {
    window.peerPending = window.relayFetch(
      {
        url: "http://127.0.0.1:4199/peer-hold",
        method: "GET",
        headers: [],
        credentials: "omit",
        mode: "same-origin",
      },
      window.relayContext,
    );
  });
  for (let n = 0; n < 100 && !peerPendingResolve; n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof peerPendingResolve, "function");
  let cancelled = 0,
    attempts = 0;
  for (let iteration = 0; iteration < 120 && cancelled < 30; iteration++) {
    attempts++;
    websitePendingResolve = undefined;
    await page.evaluate(() => {
      window.probeAbort = new AbortController();
      window.probePending = window
        .relayFetch(
          {
            url: "http://127.0.0.1:4199/hold",
            method: "GET",
            headers: [],
            credentials: "omit",
            mode: "same-origin",
          },
          { ...window.relayContext, signal: window.probeAbort.signal },
        )
        .then(
          () => ({ completedBeforeCancel: true }),
          (e) => ({ code: e.code, name: e.name }),
        );
    });
    for (let n = 0; n < 100 && !websitePendingResolve; n++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(typeof websitePendingResolve, "function");
    if (process.env.ATLAS_CANCEL_HELD_RESPONSE !== "1") websitePendingResolve();
    const value = await page.evaluate(async () => {
      window.probeAbort.abort();
      const aborted = await window.probePending;
      try {
        const response = await window.relayFetch(
          {
            url: "http://127.0.0.1:4199/data",
            method: "GET",
            headers: [],
            credentials: "omit",
            mode: "same-origin",
          },
          window.relayContext,
        );
        return { aborted, body: new TextDecoder().decode(response.body) };
      } catch (error) {
        return { aborted, error: error.code, name: error.name };
      }
    });
    console.log("NATIVE_ABORT_REUSE", JSON.stringify({ iteration, ...value }));
    if (value.aborted.code === "relay_request_aborted") cancelled++;
    else assert.deepEqual(value.aborted, { completedBeforeCancel: true });
    assert.equal(value.body, "payload through assigned Wisp node");
    websitePendingResolve();
  }
  assert.equal(
    cancelled,
    30,
    "Thirty genuine in-flight cancellations must occur",
  );
  peerPendingResolve();
  assert.equal(
    await page.evaluate(async () =>
      new TextDecoder().decode((await window.peerPending).body),
    ),
    "independent peer survived cancellation",
  );
  const workers = page.workers();
  let stats;
  for (let attempt = 0; attempt < 100; attempt++) {
    stats = await Promise.all(
      workers.map((worker) =>
        worker.evaluate(() => {
          const s = self.__probeSession;
          return s
            ? {
                active: s.active_requests,
                requests: s.requests_list.length,
                callbacks: Object.keys(s.request_callbacks).length,
                eventLoop: s.event_loop !== null,
              }
            : null;
        }),
      ),
    );
    if (
      stats
        .filter(Boolean)
        .every(
          (s) =>
            s.requests === 0 &&
            s.active === 0 &&
            s.callbacks === 0 &&
            s.eventLoop === false,
        )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  console.log("NATIVE_ABORT_BOOKKEEPING", JSON.stringify(stats));
  for (const value of stats.filter(Boolean)) {
    assert.equal(value.active, 0);
    assert.equal(value.requests, 0);
    assert.equal(value.callbacks, 0);
    assert.equal(value.eventLoop, false);
  }
  assert.deepEqual(errors, []);
  console.log(
    "NATIVE_ABORT_REUSE_ALL_PASS " +
      JSON.stringify({
        cancelledRequests: cancelled,
        attempts,
        independentPeerSurvives: true,
        bookkeeping: stats,
        errors,
      }),
  );
} finally {
  websitePendingResolve?.();
  peerPendingResolve?.();
  await browser?.close();
  await Promise.all(nodes.map((n) => n.close()));
  await frontendApp.close();
  await website.close();
}
