/** Exact current engine vs targeted adapter, real loopback HTTP/SSE/Wisp/WS.
 * Correctness only: no user data, public websites, CPU throttling or load test. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { adaptRelayCredentialRotation } from "../scripts/runtime-relay-rotation.mjs";
import { adaptHttpEngineLifecycle } from "../scripts/runtime-httpengine-lifecycle.mjs";

const evidence = "evidence/performance-remediation-20261029/runtime-lifecycle";
await mkdir(evidence, { recursive: true });
const baseline = process.env.ATLAS_LIFECYCLE_BASELINE_ASSET
  ? await readFile(process.env.ATLAS_LIFECYCLE_BASELINE_ASSET)
  : adaptRelayCredentialRotation(await readFile("upstream/scramjet-ls-bypass/app/vendor/httpengine-client.js"));
const modified = adaptHttpEngineLifecycle(baseline);
const sockets = new Set(), held = new Set(), timers = new Set();
logging.set_level(logging.NONE);
Object.assign(wisp.options, { allow_loopback_ips: true, allow_private_ips: true,
  hostname_whitelist: [/^127\.0\.0\.1$/], wisp_version: 1 });
const ws = new WebSocketServer({ noServer: true });
ws.on("connection", socket => socket.on("message", bytes => socket.send(bytes)));
let upgrades = 0;
const server = createServer({ shouldUpgradeCallback: q => q.headers.upgrade?.toLowerCase() === "websocket" }, (q, r) => {
  const path = new URL(q.url, "http://127.0.0.1").pathname;
  r.setHeader("cache-control", "no-store");
  if (path === "/baseline.js" || path === "/modified.js") {
    r.setHeader("content-type", "application/javascript"); r.end(path === "/baseline.js" ? baseline : modified); return;
  }
  if (path === "/empty") { r.writeHead(204); r.end(); return; }
  if (path === "/not-modified") { r.writeHead(304); r.end(); return; }
  if (path === "/redirect") { r.writeHead(302, { location: "/empty", "content-type": "text/plain" }); r.end("redirect"); return; }
  if (path === "/truncated") {
    r.writeHead(200, { "content-type": "text/plain", "content-length": 100 }); r.write("initial");
    const timer = setTimeout(() => { timers.delete(timer); r.destroy(); }, 60); timers.add(timer); return;
  }
  if (["/held", "/headers-held", "/sse", "/finite-sse"].includes(path)) {
    held.add(r); r.on("close", () => held.delete(r));
    r.setHeader("content-type", path.includes("sse") ? "text/event-stream" : "text/plain");
    if (path === "/headers-held") r.flushHeaders(); else r.write(path.includes("sse") ? "data: initial\n\n" : "initial");
    if (path.includes("sse")) {
      let n = 0;
      const timer = setInterval(() => { r.write("data: " + ++n + "\n\n"); if (path === "/finite-sse" && n === 3) r.end(); }, 20);
      timers.add(timer); r.on("close", () => { clearInterval(timer); timers.delete(timer); });
    }
    return;
  }
  r.setHeader("content-type", "text/html"); r.end("<!doctype html><title>Local HTTP lifecycle qualification</title>");
});
server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
server.on("upgrade", (q, s, h) => {
  if (q.url === "/site-ws") ws.handleUpgrade(q, s, h, socket => ws.emit("connection", socket, q));
  else if (q.url.startsWith("/wisp/")) { upgrades++; wisp.routeRequest(q, s, h); }
  else s.destroy();
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
wisp.options.port_whitelist = [server.address().port];
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-proxy-server"] });
const rows = [], variants = process.env.ATLAS_LIFECYCLE_VARIANTS?.split(",") || ["baseline", "modified"],
  cases = ["abort-before-headers", "already-aborted", "cancel-held-no-data", "cancel-sse", "abort20", "empty", "not-modified", "response-constructor-error", "finite-sse", "truncated", "redirect", "redirect-error", "close-many", "rotation-websocket"]
    .filter(name => !process.env.ATLAS_LIFECYCLE_CASES || process.env.ATLAS_LIFECYCLE_CASES.split(",").includes(name));
let report;
try {
  for (const variant of variants) for (const name of cases) {
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(String(e.message).slice(0, 160)));
    await page.goto(origin); await page.addScriptTag({ url: origin + "/" + variant + ".js" });
    const beforeUpgrades = upgrades;
    const result = await page.evaluate(async ({ origin, name }) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const engine = new HttpEngineTransport.HttpEngineClient({ relay: origin.replace("http:", "ws:") + "/wisp/a/" });
      await engine.init();
      const get = (path, signal) => engine.request(new URL(origin + path), "GET", null, [], signal);
      const details = {};
      if (name === "abort-before-headers" || name === "already-aborted") {
        const a = new AbortController(); if (name === "already-aborted") a.abort();
        const request = get("/headers-held", a.signal);
        if (name !== "already-aborted") setTimeout(() => a.abort(), 20);
        details.error = await Promise.race([request.then(() => "unexpected-success", e => e.name), sleep(300).then(() => "pending-timeout")]);
      } else if (name === "cancel-held-no-data" || name === "cancel-sse") {
        const response = await get(name === "cancel-sse" ? "/sse" : "/held");
        await response.body.cancel();
      } else if (name === "abort20") {
        for (let n = 0; n < 20; n++) { const a = new AbortController(); await get("/held", a.signal); a.abort(); await sleep(3); }
      } else if (name === "empty") {
        const response = await get("/empty"); details.status = response.status; details.empty = response.body === null;
      } else if (name === "not-modified") {
        const response = await Promise.race([get("/not-modified"), sleep(300).then(() => null)]);
        details.status = response?.status ?? "pending-timeout"; details.empty = response?.body === null;
      } else if (name === "response-constructor-error") {
        engine.session.constructor.create_response = () => { throw new Error("fixture-response-constructor-error"); };
        details.error = await Promise.race([get("/empty").then(() => "unexpected-success", e => e.message), sleep(300).then(() => "pending-timeout")]);
      } else if (name === "finite-sse") {
        details.body = await new Response((await get("/finite-sse")).body).text();
      } else if (name === "truncated") {
        const response = await get("/truncated");
        details.bodyOutcome = await new Response(response.body).text().then(text => ({ text }), e => ({ error: e.name }));
      } else if (name === "redirect") {
        const response = await get("/redirect"); details.status = response.status; details.body = await new Response(response.body).text();
      } else if (name === "redirect-error") {
        details.error = await engine.session.fetch(origin + "/redirect", { redirect: "error" }).then(() => "unexpected-success", e => e.name);
      } else if (name === "close-many") {
        await Promise.all(Array.from({ length: 6 }, () => get("/held")));
        engine.session.close(); engine.session.close();
      } else if (name === "rotation-websocket") {
        await get("/empty"); const session = engine.session;
        const events = [];
        let controls;
        await new Promise((resolve, reject) => { controls = engine.connect(new URL(origin.replace("http:", "ws:") + "/site-ws"), [], [], resolve,
          data => events.push(data), () => {}, reject); });
        const emit = async value => { controls[0](value); for (let n = 0; n < 100 && events.length === 0; n++) await sleep(5); return new TextDecoder().decode(events.shift()); };
        details.before = await emit("before");
        engine.updateRelay(origin.replace("http:", "ws:") + "/wisp/b/");
        details.after = await emit("after"); details.sameSession = engine.session === session;
        await get("/empty"); controls[1]();
      }
      await sleep(90);
      return { ...details, active: engine.session.active_requests,
        callbacks: Object.keys(engine.session.request_callbacks).length,
        handles: engine.session.requests_list.length, pumpStopped: engine.session.event_loop === null,
        owners: engine.session.atlasRequests?.size ?? null };
    }, { origin, name });
    const row = { variant, name, ...result, relayUpgrades: upgrades - beforeUpgrades, errors };
    rows.push(row); console.log(JSON.stringify(row)); await context.close();
    if (variant === "modified") {
      assert.equal(result.active, 0, name); assert.equal(result.callbacks, 0, name);
      assert.equal(result.handles, 0, name); assert.equal(result.pumpStopped, true, name);
      assert.equal(result.owners, 0, name); assert.deepEqual(errors, [], name);
      if (name.includes("aborted") || name === "abort-before-headers") assert.equal(result.error, "AbortError", name);
      if (name === "empty") { assert.equal(result.status, 204); assert.equal(result.empty, true); }
      if (name === "not-modified") { assert.equal(result.status, 304); assert.equal(result.empty, true); }
      if (name === "response-constructor-error") assert.equal(result.error, "fixture-response-constructor-error");
      if (name === "finite-sse") assert.equal(result.body, "data: initial\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\n");
      if (name === "truncated") assert.equal(result.bodyOutcome.error, "TypeError");
      if (name === "redirect") { assert.equal(result.status, 302); assert.equal(result.body, "redirect"); }
      if (name === "redirect-error") assert.equal(result.error, "TypeError");
      if (name === "rotation-websocket") { assert.equal(result.before, "before"); assert.equal(result.after, "after"); assert.equal(result.sameSession, true); assert.equal(row.relayUpgrades, 1); }
    }
  }
  if (variants.includes("baseline") && cases.includes("abort20")) assert.ok(rows.some(r => r.variant === "baseline" && r.name === "abort20" && r.callbacks === 20));
  if (variants.includes("baseline") && cases.includes("cancel-held-no-data")) assert.ok(rows.some(r => r.variant === "baseline" && r.name === "cancel-held-no-data" && r.handles === 1));
  report = { result: "PASS", browser: browser.version(), command: "node tests/perf-httpengine-lifecycle.browser.mjs", exitStatus: 0, rows };
} catch (error) { report = { result: "FAIL", error: String(error), rows }; throw error; }
finally {
  await writeFile(evidence + "/" + (process.env.ATLAS_LIFECYCLE_REPORT || "BROWSER") + ".json", JSON.stringify(report, null, 2) + "\n");
  await browser.close(); for (const timer of timers) clearInterval(timer); for (const r of held) r.destroy();
  for (const socket of ws.clients) socket.terminate(); await new Promise(r => ws.close(r));
  for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r));
}
