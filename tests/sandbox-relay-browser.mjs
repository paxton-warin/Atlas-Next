/** Real unchanged pinned HttpEngine in trusted per-assignment workers -> real
 * authorized Wisp node A/B -> controlled website. No frontend payload proxy.
 * Standalone: node tests/sandbox-relay-browser.mjs (uses website fixture4199). */
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
let websitePendingResolve;
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
];
for (const name of modules) {
  const source = fs.readFileSync(
    new URL(`../runtime/${name}.ts`, import.meta.url),
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
    window.oldFetch = window.relayFetch(
      {
        url: "http://127.0.0.1:4199/hold",
        method: "GET",
        headers: [],
        credentials: "omit",
        mode: "same-origin",
      },
      window.relayContext,
    );
  });
  for (let n = 0; n < 100 && !websitePendingResolve; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(typeof websitePendingResolve, "function");
  const rotated = await page.evaluate(
    async ({ assignments }) => {
      let implicitDenied = false;
      try {
        await window.relay.replace(assignments[1]);
      } catch (e) {
        implicitDenied = e.code === "relay_assignment_conflict";
      }
      await window.relay.replace(assignments[1], { allowNodeChange: true });
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
      const nodeBefore = window.relay.assignment.origin;
      let failedReplacement = false;
      try {
        await window.relay.replace(
          { ...assignments[0], ticket: "bad.ticket" },
          { allowNodeChange: true },
        );
      } catch {
        failedReplacement = true;
      }
      return {
        implicitDenied,
        failedReplacement,
        nodeBefore,
        nodeAfter: window.relay.assignment.origin,
        body: new TextDecoder().decode(response.body),
      };
    },
    { assignments },
  );
  assert.equal(rotated.implicitDenied, true);
  assert.equal(rotated.failedReplacement, true);
  assert.equal(rotated.nodeBefore, assignments[1].origin);
  assert.equal(rotated.nodeAfter, assignments[1].origin);
  websitePendingResolve();
  assert.equal(
    await page.evaluate(async () =>
      new TextDecoder().decode((await window.oldFetch).body),
    ),
    "old assignment survived replacement",
  );
  const limits = await page.evaluate(async () => {
    const r = {
      url: "http://127.0.0.1:4199/large",
      method: "GET",
      headers: [],
      credentials: "omit",
      mode: "same-origin",
    };
    let truncated;
    try {
      await window.relayFetch(
        { ...r, url: "http://127.0.0.1:4199/truncated" },
        window.relayContext,
      );
      truncated = "unexpected-success";
    } catch (error) {
      truncated = error.code;
    }
    let large;
    try {
      await window.relayFetch(r, window.relayContext);
    } catch (e) {
      large = e.code;
    }
    const abort = new AbortController();
    abort.abort();
    let aborted;
    try {
      await window.relayFetch(
        { ...r, url: "http://127.0.0.1:4199/data" },
        { ...window.relayContext, signal: abort.signal },
      );
    } catch (e) {
      aborted = e.code;
    }
    const pending = window.relay.pending;
    window.relay.dispose();
    return { large, aborted, pending, truncated };
  });
  assert.equal(limits.truncated, "relay_upstream_failed");
  assert.equal(limits.large, "relay_response_limit");
  assert.equal(limits.aborted, "relay_request_aborted");
  assert.equal(limits.pending, 0);
  assert.deepEqual(errors, []);
  assert.equal(
    payloadPaths.some((p) => /^\/(data|hold|large)/.test(p)),
    false,
  );
  // Worker WebSockets are not exposed on Page's websocket event on every Chrome
  // revision; real node counters and website requests independently prove hops.
  assert.equal(calls.length, 2);
  const result = {
    result: "PASS",
    realAuthorizedNodes: 2,
    pinnedTransport: "HttpEngine 0.7.4",
    websiteRequests: calls.length,
    frontendWebsitePayloadRequests: 0,
    explicitNodeChange: true,
    failedReplacementRetainsAssignment: true,
    priorInFlightRequestCompletes: true,
    limits,
    errors,
  };
  fs.mkdirSync("evidence/combined-update-20261015/real-relay", {
    recursive: true,
  });
  fs.writeFileSync(
    "evidence/combined-update-20261015/real-relay/verification.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log("REAL_ASSIGNED_RELAY_RESULT " + JSON.stringify(result));
} finally {
  websitePendingResolve?.();
  await browser?.close();
  await Promise.all(nodes.map((n) => n.close()));
  await frontendApp.close();
  await website.close();
}
