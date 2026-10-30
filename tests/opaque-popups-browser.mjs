/** Joint built-document/controller/CSP/storage/native-gateway qualification.
 * Website transport is a deterministic callback. The selected Main relay is
 * actually probed through the built worker; this is NOT public-site acceptance.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import https from "node:https";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import { createRuntime } from "../server/runtime.mjs";
import { buildOpaqueRuntime } from "../scripts/build-opaque-runtime.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const directory = await fs.mkdtemp(join(tmpdir(), "atlas-opaque-popup-"));
const openssl = (args, input) => {
  const r = spawnSync("openssl", args, { input });
  if (r.status) throw Error(String(r.stderr));
  return r.stdout;
};
openssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  join(directory, "key"),
  "-out",
  join(directory, "cert"),
  "-days",
  "1",
  "-subj",
  "/CN=front.test",
  "-addext",
  "subjectAltName=DNS:front.test",
]);
const key = await fs.readFile(join(directory, "key")),
  cert = await fs.readFile(join(directory, "cert"));
const spki = openssl(
  ["dgst", "-sha256", "-binary"],
  openssl(
    ["pkey", "-pubin", "-outform", "der"],
    openssl(["x509", "-pubkey", "-noout"], cert),
  ),
).toString("base64");
let app, runtime, browser;
const sockets = new Set();
const edge = https.createServer({ key, cert }, (req, res) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: app.server.address().port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
edge.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((r) => edge.listen(0, "127.0.0.1", r));
const frontend = "https://front.test:" + edge.address().port;
try {
  const assetDir = join(directory, "assets"),
    manifest = await buildOpaqueRuntime({ outdir: assetDir });
  const bundle = await build({
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    stdin: {
      resolveDir: resolve("runtime"),
      contents: `
export {createOpaqueWebsiteDocument} from './sandbox-controller.ts';
export {createFrontendDocumentSource} from './frontend-document-source.ts';
export {createFrontendFrameReservations} from './frontend-frame-reservation.ts';
export {createNativeResourceProvider} from './native-resource-provider.ts';
export {createSandboxStorageOwner} from './sandbox-storage-owner.ts';
export {createSandboxCookieOwner} from './sandbox-cookie-owner.ts';
export {createSandboxRelay} from './sandbox-relay.ts';`,
    },
  });
  app = await createApp({
    dataDir: join(directory, "data"),
    staticDir: "/not-built",
    appOrigin: frontend,
    dynamicOrigins: false,
    runtimeOrigin: "https://runtime.invalid",
    localRelayMode: "frontend",
    opaqueRuntimeEnabled: true,
    opaqueAssetsDir: assetDir,
  });
  app.get("/", (_req, reply) =>
    reply
      .type("text/html")
      .send(
        "<!doctype html><title>Joint native qualification</title><main data-trusted-frontend=1></main>",
      ),
  );
  app.get("/fixture.js", (_req, reply) =>
    reply.type("application/javascript").send(bundle.outputFiles[0].contents),
  );
  app.get("/favicon.ico", (_req, reply) => reply.code(204).send());
  await app.listen({ host: "127.0.0.1", port: 0 });
  runtime = await createRuntime({
    appOrigin: frontend,
    runtimeOrigin: "https://runtime.invalid",
    authorize: (...args) => app.nodePool.resolve(...args),
  });
  await runtime.listen({ host: "127.0.0.1", port: 0 });
  app.nodePool.setLocalConnections(() => runtime.connectionCount());
  edge.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, frontend).pathname;
    (path.startsWith("/relay/") || path.startsWith("/wisp/")
      ? runtime
      : app
    ).server.emit("upgrade", req, socket, head);
  });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--no-proxy-server",
      "--host-resolver-rules=MAP front.test 127.0.0.1",
      "--ignore-certificate-errors-spki-list=" + spki,
    ],
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(frontend);
  await page.evaluate(async () => {
    const api = await import("/fixture.js");
    const post = async (path, body) => {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error(path + ":" + r.status);
      return r.json();
    };
    const bootstrap = await post("/api/browse/controller/bootstrap", {}),
      assignment = await post("/api/browse/controller/session", {
        intent: "new",
        requestId: bootstrap.requestId,
      }),
      assets = await post("/api/browse/controller/runtime", {});
    const headers = () => ({
      "x-atlas-browse-session": assignment.session,
      "x-atlas-browse-generation": String(assignment.generation),
    });
    const storage = await api.createSandboxStorageOwner({
        workerURL: assets.workers.storage,
        registrationHeaders: headers,
      }),
      cookies = await api.createSandboxCookieOwner({
        workerURL: assets.workers.cookies,
        browserSessionId: assignment.browserSessionId,
        registrationHeaders: headers,
      }),
      frames = api.createFrontendFrameReservations({
        assignment: () => assignment,
      });
    window.calls = [];
    const transport = async (request, context) => {
      calls.push({ url: request.url, documentId: context.documentId });
      let html;
      if (request.url === "https://parent.example/root")
        html =
          `<!doctype html><html><head></head><body><button id="open">Open</button><button id="reuse">Reuse</button><button id="close">Close</button><script>
        window.messages=[];window.unsolicited=open('https://popup.example/start');
        document.getElementById('open').onclick=()=>{window.popupHandle=open('https://popup.example/start','qualified-popup');window.opened=!!popupHandle};
        document.getElementById('reuse').onclick=()=>{const previous=popupHandle;window.popupHandle=open('https://popup.example/next','qualified-popup');window.reused=previous===popupHandle};
        document.getElementById('close').onclick=()=>popupHandle.close();
        addEventListener('message',e=>{if(e.data?.popupReady){messages.push({page:e.data.page,origin:e.origin});e.source.postMessage({parentReply:true},e.origin)}});window.parentReady=true;
      </scr` + `ipt></body></html>`;
      else if (
        ["https://popup.example/start", "https://popup.example/next"].includes(
          request.url,
        )
      ) {
        const page = request.url.endsWith("/next") ? "next" : "start";
        html =
          `<!doctype html><html><head></head><body><script>
        const previous=localStorage.getItem('popup-save');localStorage.setItem('popup-save','committed');document.cookie='popup=cookie; Secure; Path=/';
        window.popupResult={page:'${page}',previous,logical:location.origin,cookie:document.cookie,openerDenied:false};try{void opener.document}catch{popupResult.openerDenied=true};
        addEventListener('message',e=>{if(e.data?.parentReply)window.parentReplyOrigin=e.origin});opener.postMessage({popupReady:true,page:'${page}'},'https://parent.example');
      </scr` + `ipt></body></html>`;
      } else throw Error("Unexpected destination");
      return {
        url: request.url,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/html;charset=utf-8"]],
        body: new TextEncoder().encode(html).buffer,
      };
    };
    const source = api.createFrontendDocumentSource({
      frontendOrigin: location.origin,
      selectedNodeOrigin: () => assignment.relayOrigin,
      fetch: transport,
    });
    window.states = [];
    window.owners = { source, storage, cookies, frames };
    window.binding = api.createOpaqueWebsiteDocument({
      website: "https://parent.example/root",
      container: document.querySelector("main"),
      factory: indexedDB,
      sessionId: "popup_document_tab_0123456789",
      storageProvider: storage,
      cookieProvider: cookies,
      fetch: transport,
      sourceProvider: source,
      frameProvider: frames,
      timeoutMs: 30000,
      onContentState: (s) => states.push(s),
    });
    await binding.ready;
  });
  try {
    await page.waitForFunction(() => states.includes("ready"), null, {
      timeout: 30000,
    });
    const site = page
      .frames()
      .find((f) => f.parentFrame() === page.mainFrame());
    assert.ok(site);
    await site.waitForFunction(() => window.parentReady);
    assert.equal(await site.evaluate(() => unsolicited), null);
    assert.equal(page.context().pages().length, 1);
    const opened = page.context().waitForEvent("page");
    await site.locator("#open").click();
    const popup = await opened;
    await popup.waitForFunction(() => window.popupResult, null, {
      timeout: 30000,
    });
    await popup.waitForFunction(
      () => window.parentReplyOrigin === "https://parent.example",
      null,
      { timeout: 10000 },
    );
    assert.equal(await site.evaluate(() => opened), true);
    assert.deepEqual(await popup.evaluate(() => popupResult), {
      page: "start",
      previous: null,
      logical: "https://popup.example",
      cookie: "popup=cookie",
      openerDenied: true,
    });
    assert.ok(popup.url().startsWith(frontend + "/browse/popup/"));
    assert.equal(new URL(popup.url()).hash, "");
    const cdp = await page.context().newCDPSession(popup),
      tree = await cdp.send("Page.getFrameTree"),
      world = await cdp.send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "opaque-popup-boundary",
      });
    const boundary = await cdp.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      returnByValue: true,
      expression: `(()=>{let openerDenied=false,storageDenied=false,cookiesDenied=false;try{void opener.document}catch{openerDenied=true}try{void localStorage}catch{storageDenied=true}try{void document.cookie}catch{cookiesDenied=true}return{origin:self.origin,openerDenied,storageDenied,cookiesDenied}})()`,
    });
    assert.deepEqual(boundary.result.value, {
      origin: "null",
      openerDenied: true,
      storageDenied: true,
      cookiesDenied: true,
    });
    await cdp.detach();
    const first = popup.url();
    await site.locator("#reuse").click();
    await popup.waitForURL((url) => url.href !== first);
    await popup.waitForFunction(
      () => window.popupResult?.page === "next",
      null,
      { timeout: 30000 },
    );
    await popup.waitForFunction(
      () => window.parentReplyOrigin === "https://parent.example",
      null,
      { timeout: 10000 },
    );
    assert.equal(await site.evaluate(() => reused), true);
    assert.equal(page.context().pages().length, 2);
    assert.equal(
      (await popup.evaluate(() => popupResult)).previous,
      "committed",
    );
    const closed = popup.waitForEvent("close");
    await site.locator("#close").click();
    await closed;
    assert.equal(await site.evaluate(() => popupHandle.closed), true);
    assert.deepEqual(await site.evaluate(() => messages), [
      { page: "start", origin: "https://popup.example" },
      { page: "next", origin: "https://popup.example" },
    ]);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "opaque_linked_popup_verified",
        synchronousBlockedNull: true,
        realNativeHandle: true,
        sameFrontendURL: true,
        privateBootstrapNonce: true,
        logicalOpenerMessages: true,
        close: true,
        namedReuse: true,
        storagePreserved: true,
        nativeBoundary: boundary.result.value,
        noEscapeSandbox: true,
        errors,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        errors,
        states: await page.evaluate(() => states),
        calls: await page.evaluate(() => calls),
        pages: await Promise.all(
          page
            .context()
            .pages()
            .map(async (p) => ({
              url: p.url(),
              frames: await Promise.all(
                p
                  .frames()
                  .map(async (f) => ({
                    url: f.url(),
                    state: await f
                      .evaluate(() => ({
                        body: document.body?.innerText,
                        result: window.popupResult,
                        reply: window.parentReplyOrigin,
                        parentReady: window.parentReady,
                        messages: window.messages,
                      }))
                      .catch(() => null),
                  })),
              ),
            })),
        ),
      }),
    );
    throw error;
  }
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => edge.close(r));
  await runtime?.close();
  await app?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
