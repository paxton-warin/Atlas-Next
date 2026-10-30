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
const directory = await fs.mkdtemp(join(tmpdir(), "atlas-nested-document-"));
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
  await page.evaluate(async (rejectPopupReservations) => {
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
    const bootstrap = await post("/api/browse/controller/bootstrap", {});
    const assignment = await post("/api/browse/controller/session", {
      intent: "new",
      requestId: bootstrap.requestId,
    });
    const assets = await post("/api/browse/controller/runtime", {});
    const headers = () => ({
      "x-atlas-browse-session": assignment.session,
      "x-atlas-browse-generation": String(assignment.generation),
    });
    const storage = await api.createSandboxStorageOwner({
      workerURL: assets.workers.storage,
      registrationHeaders: headers,
    });
    const cookies = await api.createSandboxCookieOwner({
      workerURL: assets.workers.cookies,
      browserSessionId: assignment.browserSessionId,
      registrationHeaders: headers,
    });
    const frames = api.createFrontendFrameReservations({
      assignment: () => assignment,
    });
    window.calls = [];
    const transport = async (request, context) => {
      calls.push({
        url: request.url,
        documentId: context.documentId,
        documentURL: context.documentURL,
      });
      let html;
      if (request.url === "https://parent.example/root")
        html =
          `<!doctype html><html><head></head><body><iframe id="child" src="https://child.example/one"></iframe><button id="dynamic">Add child</button><script>
        document.getElementById('dynamic').onclick=()=>{const f=document.createElement('iframe');f.id='dynamic-child';f.src='https://dynamic.example/three';document.body.appendChild(f)};
        window.allMessages=[];window.childMessages=[];addEventListener('message',e=>{allMessages.push({data:e.data,origin:e.origin});if(e.data?.nestedReady){childMessages.push({value:e.data.logical,origin:e.origin});e.source.postMessage({parentAck:true},e.origin)}});window.sendPrivateToChild=()=>document.getElementById('child').contentWindow.postMessage({shouldNotCrossDocument:true},'https://child.example');window.parentReady=true;
      </scr` + `ipt></body></html>`;
      else if (request.url === "https://child.example/one")
        html =
          `<!doctype html><html><head></head><body><iframe src="https://grand.example/two"></iframe><script>
        localStorage.setItem('child-save','one');document.cookie='child=cookie; Path=/; Max-Age=600; SameSite=None; Secure';
        window.nestedResult={site:location.origin,save:localStorage.getItem('child-save'),cookie:document.cookie,frontendLeak:false};
        try{nestedResult.frontendLeak=!!top.document.querySelector('[data-trusted-frontend]')}catch{};addEventListener('message',e=>{if(e.data?.parentAck)window.parentAckOrigin=e.origin});parent.postMessage({nestedReady:true,logical:location.origin},'https://parent.example');parent.postMessage({$runtimekit$messagetype:'window',$runtimekit$origin:'https://admin.example',$runtimekit$data:{nestedReady:true,logical:'spoof'}},'*');
      </scr` + `ipt></body></html>`;
      else if (
        request.url === "https://grand.example/two" ||
        request.url === "https://dynamic.example/three"
      )
        html =
          `<!doctype html><html><head></head><body><script>
        localStorage.setItem('child-save',location.origin);window.nestedResult={site:location.origin,save:localStorage.getItem('child-save'),cookie:document.cookie};
      </scr` + `ipt></body></html>`;
      else throw Error("Unexpected nested destination:" + request.url);
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
    window.owners = { storage, cookies, frames, source };
    window.states = [];
    window.binding = api.createOpaqueWebsiteDocument({
      website: "https://parent.example/root",
      container: document.querySelector("main"),
      factory: indexedDB,
      sessionId: "nested_document_tab_0123456789",
      storageProvider: storage,
      cookieProvider: cookies,
      fetch: transport,
      sourceProvider: source,
      frameProvider: rejectPopupReservations ? {...frames,reserve(input){if(input.kind==="popup")throw Object.assign(Error("fixture_popup_reserve_429"),{status:429});return frames.reserve(input);}} : frames,
      timeoutMs: 30000,
      onContentState: (s) => states.push(s),
    });
    await binding.ready;
  }, process.env.ATLAS_TEST_POPUP_RESERVATION_FAILURE === "1");
  try {
    await page.waitForFunction(() => states.includes("ready"), null, {
      timeout: 30000,
    });
    await page.waitForFunction(() => calls.length >= 3, null, {
      timeout: 30000,
    });
    await page.waitForFunction(() => document.querySelector("iframe"), null, {
      timeout: 30000,
    });
    const website = page
      .frames()
      .find((f) => f.parentFrame() === page.mainFrame());
    assert.ok(website);
    await website.waitForFunction(() => parentReady, null, { timeout: 30000 });
    const child = website.childFrames()[0];
    assert.ok(child);
    await child.waitForFunction(() => window.nestedResult, null, {
      timeout: 30000,
    });
    assert.deepEqual(await child.evaluate(() => nestedResult), {
      site: "https://child.example",
      save: "one",
      cookie: "child=cookie",
      frontendLeak: false,
    });
    const grand = child.childFrames()[0];
    assert.ok(grand);
    await grand.waitForFunction(() => window.nestedResult, null, {
      timeout: 30000,
    });
    await website.waitForFunction(
      () => window.childMessages.length === 1,
      null,
      { timeout: 5000 },
    );
    assert.deepEqual(await website.evaluate(() => childMessages), [
      { value: "https://child.example", origin: "https://child.example" },
    ]);
    await child.waitForFunction(
      () => window.parentAckOrigin === "https://parent.example",
      null,
      { timeout: 5000 },
    );
    assert.equal(
      (await grand.evaluate(() => nestedResult)).save,
      "https://grand.example",
    );
    const added = page.waitForEvent("frameattached", {
      predicate: (f) => f.parentFrame() === website,
    });
    await website.locator("#dynamic").click();
    const dynamic = await added;
    await dynamic.waitForFunction(() => window.nestedResult, null, {
      timeout: 30000,
    });
    assert.equal(
      (await dynamic.evaluate(() => nestedResult)).site,
      "https://dynamic.example",
    );
    for (const f of [website, child, grand, dynamic])
      assert.ok(f.url().startsWith(frontend + "/browse/frame/"));
    const childResponse = await app.inject({
      url: new URL(child.url()).pathname,
      headers: { host: new URL(frontend).host },
    });
    assert.match(
      childResponse.headers["content-security-policy"],
      /^sandbox allow-scripts(?: allow-popups)?;/,
    );
    assert.doesNotMatch(
      childResponse.headers["content-security-policy"],
      /allow-same-origin|frame-ancestors/,
    );
    const rootResponse = await app.inject({
      url: new URL(website.url()).pathname,
      headers: { host: new URL(frontend).host },
    });
    assert.match(
      rootResponse.headers["content-security-policy"],
      /frame-ancestors 'self'/,
    );
    const cdp = await page.context().newCDPSession(website);
    const tree = await cdp.send("Page.getFrameTree");
    const find = (tree) =>
      tree.frame.url === child.url().split("#")[0]
        ? tree.frame
        : (tree.childFrames ?? []).map(find).find(Boolean);
    const childNative = find(tree.frameTree);
    if (!childNative)
      console.error(
        JSON.stringify({ nativeTree: tree, childURL: child.url() }),
      );
    assert.ok(childNative);
    const nativeWorld = await cdp.send("Page.createIsolatedWorld", {
      frameId: childNative.id,
      worldName: "nested-native-boundary",
    });
    const native = await cdp.send("Runtime.evaluate", {
      contextId: nativeWorld.executionContextId,
      returnByValue: true,
      expression: `(()=>{let topDenied=false,parentDenied=false,storageDenied=false;try{void top.document}catch{topDenied=true}try{void parent.document}catch{parentDenied=true}try{void localStorage}catch{storageDenied=true}return{origin:self.origin,topDenied,parentDenied,storageDenied}})()`,
    });
    assert.deepEqual(native.result.value, {
      origin: "null",
      topDenied: true,
      parentDenied: true,
      storageDenied: true,
    });
    // Reuse the SAME WindowProxy for an unbound replacement Document. A
    // logical-origin message must stay on the original document's closed port.
    const navigated = page.waitForEvent("framenavigated", {
      predicate: (f) => f === child,
    });
    await cdp.send("Runtime.evaluate", {
      contextId: nativeWorld.executionContextId,
      expression: "location.reload()",
    });
    await navigated;
    await child.waitForLoadState("load");
    await child.evaluate(() => {
      window.newMessages = [];
      addEventListener("message", (e) => newMessages.push(e.data));
    });
    await website.evaluate(() => sendPrivateToChild());
    const rootWorld = await cdp.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "nested-native-parent-barrier",
    });
    await cdp.send("Runtime.evaluate", {
      contextId: rootWorld.executionContextId,
      expression: `document.getElementById('child').contentWindow.postMessage({nativeBarrier:true},'*')`,
    });
    await child.waitForFunction(
      () => newMessages.some((m) => m.nativeBarrier),
      null,
      { timeout: 5000 },
    );
    assert.equal(
      await child.evaluate(() =>
        newMessages.some((m) => m.shouldNotCrossDocument),
      ),
      false,
    );
    await cdp.detach();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "general_nested_opaque_documents_verified",
        staticChild: true,
        recursiveChild: true,
        dynamicSrcBeforeAppend: true,
        frontendURLs: true,
        logicalNamespaces: true,
        perDocumentPorts: true,
        headerSandbox: true,
        staleWindowProxyMessageDenied: true,
        popupReserve429: process.env.ATLAS_TEST_POPUP_RESERVATION_FAILURE === "1",
        errors,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        errors,
        states: await page.evaluate(() => states),
        calls: await page.evaluate(() => calls),
        frames: await Promise.all(
          page.frames().map(async (f) => ({
            url: f.url(),
            result: await f
              .evaluate(() => ({
                body: document.body?.innerText,
                result: window.nestedResult,
                parentReady: window.parentReady,
                childMessages: window.childMessages,
                allMessages: window.allMessages,
              }))
              .catch(() => null),
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
