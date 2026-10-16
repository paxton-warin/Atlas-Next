/** Real native Chrome vs trusted broker redirect parity; ephemeral local origins. */
import http from "node:http";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  bindSandboxNetwork,
  SANDBOX_NETWORK_PROTOCOL as protocol,
} from "../runtime/sandbox-network.ts";
const receipt = {
  source: "https://fetch.spec.whatwg.org/#http-redirect-fetch",
  cases: [],
  gatesHeld: [
    "Full Fetch WPT and non-Chrome engines remain unqualified.",
    "Cookie fixture here validates effective credentials forwarding, not the production persistent cookie jar.",
    "Redirect Referrer-Policy and cross-site SameSite cookie-chain behavior require separate qualification.",
  ],
};
const servers = [],
  origins = [],
  logs = [];
let stage = "native";
for (let index = 0; index < 3; index++) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, origins[index]);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = {
      server: index,
      path: u.pathname,
      method: req.method,
      origin: req.headers.origin ?? null,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      contentLanguage: req.headers["content-language"] ?? null,
      contentEncoding: req.headers["content-encoding"] ?? null,
      contentLocation: req.headers["content-location"] ?? null,
      xTest: req.headers["x-test"] ?? null,
      cookie: req.headers.cookie ?? null,
      body: Buffer.concat(chunks).toString(),
    };
    if (u.pathname !== "/page" && u.pathname !== "/favicon.ico")
      logs.push({ stage, ...entry });
    const cors = u.searchParams.get("cors") ?? "reflect";
    if (cors !== "none") {
      res.setHeader(
        "Access-Control-Allow-Origin",
        cors === "star" ? "*" : (req.headers.origin ?? origins[0]),
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Expose-Headers", "x-visible");
    }
    if (req.method === "OPTIONS") {
      if (u.searchParams.has("preflightRedirect")) {
        res.statusCode = 302;
        res.setHeader("Location", origins[index] + "/final");
        res.end();
        return;
      }
      res.setHeader(
        "Access-Control-Allow-Methods",
        req.headers["access-control-request-method"] ?? "GET",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.headers["access-control-request-headers"] ?? "",
      );
      res.statusCode = 204;
      res.end();
      return;
    }
    if (u.pathname === "/page") {
      res.setHeader("Content-Type", "text/html");
      res.setHeader(
        "Set-Cookie",
        "network_fixture=visible; Path=/; SameSite=Lax",
      );
      res.end("<!doctype html><title>Native fetch parity</title>");
      return;
    }
    if (u.pathname === "/loop") {
      const remaining = Number(u.searchParams.get("n"));
      if (remaining > 0) {
        res.statusCode = 302;
        res.setHeader("Location", `/loop?n=${remaining - 1}`);
        res.end();
        return;
      }
    }
    if (u.pathname === "/go") {
      res.statusCode = Number(u.searchParams.get("status") ?? 302);
      if (u.searchParams.has("to"))
        res.setHeader(
          "Location",
          u.searchParams.has("to2")
            ? [u.searchParams.get("to"), u.searchParams.get("to2")]
            : u.searchParams.get("to"),
        );
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Visible", "visible");
    res.setHeader("X-Hidden", "hidden");
    res.end(JSON.stringify(entry));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origins.push(`http://127.0.0.1:${server.address().port}`);
  servers.push(server);
}
const [A, B, C] = origins;
const go = (origin, status, to, extras = {}) =>
  origin +
  "/go?" +
  new URLSearchParams({
    status: String(status),
    ...(to === undefined ? {} : { to }),
    ...extras,
  });
function manualTransport(request, ctx) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(request.headers);
    if (
      ctx.preflight ||
      ctx.responseTaint === "cors" ||
      !["GET", "HEAD"].includes(request.method)
    )
      headers.origin = ctx.requestOrigin;
    if (request.credentials === "include" && !ctx.preflight)
      headers.cookie = "network_fixture=visible";
    const transport = http.request(
      request.url,
      { method: request.method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const raw = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            raw.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
          resolve({
            url: request.url,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: raw,
            body: body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength,
            ),
          });
        });
      },
    );
    const abort = () => transport.destroy(new Error("aborted"));
    ctx.signal.addEventListener("abort", abort, { once: true });
    transport.on("error", reject);
    transport.on("close", () => ctx.signal.removeEventListener("abort", abort));
    transport.end(
      request.body === undefined ? undefined : Buffer.from(request.body),
    );
  });
}
async function brokerFetch(input) {
  const channel = new MessageChannel();
  const binding = bindSandboxNetwork({
    port: channel.port1,
    documentId: "native-parity",
    documentURL: A + "/page",
    frontendOrigin: "http://atlas.fixture.invalid",
    fetch: manualTransport,
    timeoutMs: 5000,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      channel.port2.on("message", resolve);
      channel.port2.on("messageerror", reject);
      channel.port2.postMessage({
        protocol,
        documentId: "native-parity",
        sequence: 1,
        type: "fetch",
        request: {
          url: input.url,
          method: input.method ?? "GET",
          mode: input.mode ?? "cors",
          credentials: input.credentials ?? "same-origin",
          headers: Object.entries(input.headers ?? {}),
          redirect: input.redirect ?? "follow",
          body:
            input.body === undefined
              ? undefined
              : new TextEncoder().encode(input.body).buffer,
        },
      });
    });
    if (result.type === "error") return { error: true };
    const r = result.response;
    return {
      status: r.status,
      type: r.type,
      url: r.url,
      redirected: r.redirected ?? false,
      visibleHeaders: Object.fromEntries(
        ["x-visible", "x-hidden", "location", "set-cookie"].map((name) => [
          name,
          new Headers(r.headers).get(name),
        ]),
      ),
      body: new TextDecoder().decode(r.body),
    };
  } finally {
    binding.dispose();
    channel.port2.close();
  }
}
const cases = [
  [
    "cors-include-star-denied",
    { url: B + "/final?cors=star", credentials: "include" },
  ],
  ["cors-omit-star", { url: B + "/final?cors=star", credentials: "omit" }],
  [
    "manual-cross-denied",
    { url: go(B, 302, C + "/final", { cors: "none" }), redirect: "manual" },
  ],
  ["data-redirect-denied", { url: go(A, 302, "data:text/plain,secret") }],
  ["invalid-location-denied", { url: go(A, 302, "http://[") }],
  [
    "include-cross-auth-stripped",
    {
      url: go(A, 302, B + "/final"),
      credentials: "include",
      headers: { Authorization: "site-token" },
    },
  ],
  [
    "cross-same-origin-redirect-keeps-origin",
    { url: go(B, 302, B + "/final") },
  ],
  [
    "multiple-location-distinct",
    { url: go(A, 302, A + "/final", { to2: B + "/final" }) },
  ],
  [
    "multiple-location-identical",
    { url: go(A, 302, A + "/final", { to2: A + "/final" }) },
  ],
  ["same-origin302", { url: go(A, 302, "/final") }],
  [
    "post301",
    {
      url: go(A, 301, "/final"),
      method: "POST",
      body: "payload",
      headers: {
        "Content-Type": "application/json",
        "Content-Language": "en",
        "Content-Location": "/old",
        "Content-Encoding": "identity",
      },
    },
  ],
  [
    "post302-cross-auth-strip",
    {
      url: go(A, 302, B + "/final"),
      method: "POST",
      body: "payload",
      headers: {
        "Content-Type": "application/json",
        Authorization: "site-token",
        "X-Test": "kept",
      },
    },
  ],
  [
    "put303",
    {
      url: go(A, 303, "/final"),
      method: "PUT",
      body: "payload",
      headers: { "Content-Type": "application/json" },
    },
  ],
  ["head303", { url: go(A, 303, "/final"), method: "HEAD" }],
  [
    "post307-cross-body",
    {
      url: go(A, 307, B + "/final"),
      method: "POST",
      body: "payload",
      headers: { "Content-Type": "application/json", "X-Test": "kept" },
    },
  ],
  [
    "put308-cross-body",
    {
      url: go(A, 308, B + "/final"),
      method: "PUT",
      body: "payload",
      headers: { "Content-Type": "application/json" },
    },
  ],
  [
    "cors-return-origin-null",
    {
      url: go(A, 302, go(B, 302, A + "/final")),
      headers: { Authorization: "site-token", "X-Test": "kept" },
    },
  ],
  ["initial-cross-origin-null", { url: go(B, 302, C + "/final") }],
  [
    "cors-denied-intermediate",
    { url: go(B, 302, C + "/final", { cors: "none" }) },
  ],
  [
    "preflight-redirect-denied",
    { url: B + "/final?preflightRedirect=1", method: "PUT", body: "payload" },
  ],
  [
    "same-origin-mode-cross-denied",
    { url: go(A, 302, B + "/final"), mode: "same-origin" },
  ],
  [
    "opaque-return-stays-opaque",
    { url: go(A, 302, go(B, 302, A + "/final")), mode: "no-cors" },
  ],
  ["manual-same-origin", { url: go(A, 302, B + "/final"), redirect: "manual" }],
  [
    "manual-cross-origin",
    { url: go(B, 302, C + "/final"), redirect: "manual" },
  ],
  ["manual-no-location", { url: go(A, 302, undefined), redirect: "manual" }],
  ["error-mode", { url: go(A, 302, B + "/final"), redirect: "error" }],
  ["redirect-status-no-location", { url: go(A, 302, undefined) }],
  ["nonredirect300", { url: go(A, 300, B + "/final") }],
  ["twenty-redirects", { url: A + "/loop?n=20" }],
  ["twentyone-redirects-denied", { url: A + "/loop?n=21" }],
];
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(A + "/page");
  for (const [name, input] of cases) {
    stage = "native";
    const start = logs.length;
    const native = await page.evaluate(async (input) => {
      try {
        const { url, ...init } = input;
        const r = await fetch(url, init);
        return {
          status: r.status,
          type: r.type,
          url: r.url,
          redirected: r.redirected,
          visibleHeaders: Object.fromEntries(
            ["x-visible", "x-hidden", "location", "set-cookie"].map((name) => [
              name,
              r.headers.get(name),
            ]),
          ),
          body: await r.text(),
        };
      } catch {
        return { error: true };
      }
    }, input);
    const nativeHops = logs
      .slice(start)
      .filter((r) => r.stage === "native")
      .map(({ stage, ...r }) => r);
    stage = "broker";
    const next = logs.length;
    const broker = await brokerFetch(input);
    const brokerHops = logs
      .slice(next)
      .filter((r) => r.stage === "broker")
      .map(({ stage, ...r }) => r);
    const comparison = { name, native, broker, nativeHops, brokerHops };
    try {
      assert.deepEqual(broker, native);
      assert.deepEqual(brokerHops, nativeHops);
      comparison.matches = true;
    } catch (error) {
      comparison.matches = false;
      comparison.difference = error.message;
    }
    receipt.cases.push(comparison);
  }
  receipt.passed = receipt.cases.filter((c) => c.matches).length;
  receipt.failed = receipt.cases.length - receipt.passed;
  await writeFile(
    new URL(
      "../evidence/combined-update-20261015/sandbox-network-redirects/native-parity.json",
      import.meta.url,
    ),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        cases: receipt.cases.length,
        passed: receipt.passed,
        failed: receipt.failed,
        mismatches: receipt.cases
          .filter((c) => !c.matches)
          .map((c) => ({
            name: c.name,
            native: c.native,
            broker: c.broker,
            nativeHops: c.nativeHops,
            brokerHops: c.brokerHops,
          })),
      },
      null,
      2,
    ),
  );
  assert.equal(receipt.failed, 0);
} finally {
  await browser?.close();
  for (const server of servers)
    await new Promise((resolve) => server.close(resolve));
}
