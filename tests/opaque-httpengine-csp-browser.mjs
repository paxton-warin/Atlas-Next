/** The real pinned engine must boot under the production trusted-worker CSP
 * without fetch(data:...) or a CSP relaxation. A vendor control reproduces the
 * reported violation while still reaching the vendor's local-decoder fallback.
 * All fixtures are loopback-only; no relay or upstream request is issued. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { adaptPinnedHttpEngine } from "../scripts/opaque-httpengine.mjs";

const source = await readFile(
  "runtime/public/clients/httpengine-client.js",
  "utf8",
);
const app = Fastify({ logger: false });
const engines = { vendor: source, adapted: adaptPinnedHttpEngine(source) };
const policy =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss://selected-node.invalid";
const requests = [];
let browser;
app.addHook("onRequest", async (request) => {
  requests.push(new URL(request.url, "http://loopback.invalid").pathname);
});
app.get("/", (_request, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Engine CSP fixture</title>"),
);
app.get("/favicon.ico", (_request, reply) => reply.code(204).send());
app.get("/engine/:phase.js", (request, reply) => {
  const engine = engines[request.params.phase];
  return engine
    ? reply.type("application/javascript").send(engine)
    : reply.code(404).send();
});
app.get("/worker/:phase.js", (request, reply) => {
  const phase = request.params.phase;
  if (!(phase in engines)) return reply.code(404).send();
  return reply
    .header("Content-Security-Policy", policy)
    .header("Cache-Control", "no-store")
    .type("application/javascript").send(`
const violations = [];
let dataFetches = 0, nonLocalFetches = 0;
addEventListener('securitypolicyviolation', event => {
  violations.push({directive:event.effectiveDirective,blockedData:event.blockedURI.startsWith('data')});
});
const nativeFetch = fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('data:')) dataFetches++;
  else if (new URL(url, location.href).origin !== location.origin) nonLocalFetches++;
  return nativeFetch(input, init);
};
try {
  await import('/engine/${phase}.js');
  const client = new HttpEngineTransport.HttpEngineClient({relay:'wss://selected-node.invalid/'});
  await client.init();
  await new Promise(resolve => setTimeout(resolve, 80));
  postMessage({ready:client.ready,dataFetches,nonLocalFetches,violations});
} catch (error) {
  postMessage({errorName:error?.name || 'Error',dataFetches,nonLocalFetches,violations});
}
`);
});
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const workerResponse = await app.inject("/worker/adapted.js");
  assert.equal(workerResponse.headers["content-security-policy"], policy);
  assert.doesNotMatch(policy.split("connect-src")[1], /data:|blob:|\*/);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin);
  async function boot(phase) {
    return page.evaluate(
      (phase) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(`/worker/${phase}.js`, { type: "module" });
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("engine_boot_timeout"));
          }, 15000);
          worker.onmessage = (event) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = () => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error("engine_worker_error"));
          };
        }),
      phase,
    );
  }
  const control = await boot("vendor");
  assert.equal(control.ready, true);
  assert.equal(control.dataFetches, 1);
  assert.equal(control.nonLocalFetches, 0);
  assert.ok(
    control.violations.some(
      (event) => event.directive === "connect-src" && event.blockedData,
    ),
  );
  const adapted = await boot("adapted");
  assert.equal(adapted.ready, true);
  assert.equal(adapted.dataFetches, 0);
  assert.equal(adapted.nonLocalFetches, 0);
  assert.deepEqual(adapted.violations, []);
  assert.ok(requests.includes("/engine/adapted.js"));
  console.log(
    JSON.stringify({
      control,
      adapted,
      connectPolicyUnchanged: true,
      externalRequests: 0,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
