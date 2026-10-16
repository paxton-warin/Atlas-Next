/** Real frontend coordinator/default-component composition qualification.
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
const directory = await fs.mkdtemp(join(tmpdir(), "atlas-built-native-"));
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
export {createFrontendBrowser} from './frontend-browser.ts';`,
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
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=";
  const html = `<!doctype html><html><head><title>Native site</title><link rel="stylesheet" href="https://assets.example/style"></head><body><img id="picture" src="https://assets.example/image"><script src="https://assets.example/code"></script><script>
  (async()=>{let parentFrontendLeak=false;try{parentFrontendLeak=!!parent.document.querySelector('main[data-trusted-frontend]')}catch{};
  const picture=document.getElementById('picture');if(!picture.complete)await new Promise((r,j)=>{picture.onload=r;picture.onerror=j});
  let canvas;try{const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(picture,0,0);c.toDataURL();canvas='readable'}catch(e){canvas=e.name};
  let css;try{document.styleSheets[0].cssRules;css='readable'}catch(e){css=e.name};
  const before=localStorage.getItem('joint-native-save');localStorage.setItem('joint-native-save',String(Number(before||0)+1));window.jointResult={before,parentFrontendLeak,canvas,css,script:window.nativeScriptOrigin,color:getComputedStyle(document.body).backgroundColor,save:localStorage.getItem('joint-native-save')};})();
  </script></body></html>`;
  const boot = async ({ html, png }) => {
    const { createFrontendBrowser } = await import("/fixture.js");
    const calls = [];
    const transport = async (request, context) => {
      calls.push({
        url: request.url,
        destination: request.destination,
        documentURL: context.documentURL,
      });
      let body,
        type,
        status = 200,
        extra = [];
      if (request.url === "https://site.example/start") {
        body = "";
        type = "text/html";
        status = 302;
        extra = [["location", "/page"]];
      } else if (request.url === "https://site.example/page") {
        body = html;
        type = "text/html;charset=utf-8";
        extra = [
          [
            "content-security-policy",
            "default-src 'none'; script-src https://assets.example 'unsafe-inline'; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
          ],
        ];
      } else if (request.url === "https://assets.example/image") {
        body = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        type = "image/png";
      } else if (request.url === "https://assets.example/style") {
        body = "body{background-color:rgb(1, 2, 3)}";
        type = "text/css";
      } else if (request.url === "https://assets.example/code") {
        body = "window.nativeScriptOrigin=location.origin";
        type = "application/javascript";
      } else throw Error("Synthetic transport denied");
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : body;
      return {
        url: request.url,
        status,
        statusText: status === 200 ? "OK" : "Found",
        headers: [["content-type", type], ...extra],
        body: bytes.buffer,
      };
    };

    window.jointStates = [];
    window.jointCalls = calls;
    window.assignmentEvents = [];
    window.logicalLocations = [];
    window.frontendBrowser = await createFrontendBrowser({
      container: document.querySelector("main"),
      timeoutMs: 30000,
      onState: (state) => jointStates.push(state),
      onAssignment: (event) =>
        assignmentEvents.push({
          reason: event.reason,
          identityChanged: event.identityChanged,
        }),
      onLocation: (url) => logicalLocations.push(url),
      components: {
        fetch: (fixed) => async (request, context) => {
          if (
            context.documentId !== fixed.documentId ||
            context.documentURL !== fixed.documentURL
          )
            throw Error("synthetic fixture context mismatch");
          return transport(request, context);
        },
      },
    });
    await frontendBrowser.start("https://site.example/start");
  };
  await page.evaluate(boot, { html, png });
  const frame = page
    .frames()
    .find((f) => f.url().startsWith(frontend + "/browse/frame/"));
  assert.ok(frame);
  try {
    await frame.waitForFunction(() => window.jointResult, null, {
      timeout: 25000,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        errors,
        states: await page.evaluate(() => window.jointStates),
        body: await frame
          .evaluate(() => document.documentElement.outerHTML.slice(0, 1000))
          .catch(() => null),
      }),
    );
    throw error;
  }
  const result = await frame.evaluate(() => window.jointResult);
  assert.deepEqual(result, {
    parentFrontendLeak: false,
    canvas: "SecurityError",
    css: "SecurityError",
    script: "https://site.example",
    color: "rgb(1, 2, 3)",
    before: null,
    save: "1",
  });
  const renewed = await page.evaluate(async () => {
    const previous = frontendBrowser.document,
      frame = previous.frame,
      prior = frontendBrowser.assignment;
    await frontendBrowser.check();
    return {
      sameBinding: previous === frontendBrowser.document,
      sameFrame: frame === frontendBrowser.document.frame,
      sameIdentity:
        prior.sessionHash === frontendBrowser.assignment.sessionHash &&
        prior.generation === frontendBrowser.assignment.generation &&
        prior.node.id === frontendBrowser.assignment.node.id,
      ticketRenewed: prior.ticket !== frontendBrowser.assignment.ticket,
      locations: logicalLocations,
      states: jointStates,
      events: assignmentEvents,
    };
  });
  assert.equal(renewed.sameBinding, true);
  assert.equal(renewed.sameFrame, true);
  assert.equal(renewed.sameIdentity, true);
  assert.equal(renewed.ticketRenewed, true);
  assert.deepEqual(renewed.locations, ["https://site.example/page"]);
  assert.equal(renewed.states.at(-1).status, "ready");
  assert.ok(
    renewed.events.some(
      (event) => event.reason === "renew" && !event.identityChanged,
    ),
  );
  const cdp = await page.context().newCDPSession(frame);
  const frameTree = (await cdp.send("Page.getFrameTree")).frameTree;
  const opaqueFrame = frameTree.frame.url.startsWith(
    frontend + "/browse/frame/",
  )
    ? frameTree
    : frameTree.childFrames?.find((item) =>
        item.frame.url.startsWith(frontend + "/browse/frame/"),
      );
  assert.ok(opaqueFrame);
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: opaqueFrame.frame.id,
    worldName: "native-boundary-qualification",
    grantUniveralAccess: false,
  });
  const boundary = await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression:
      "(()=>{try{parent.document.body;return 'readable'}catch(error){return error.name}})()",
    returnByValue: true,
  });
  assert.equal(boundary.result.value, "SecurityError");
  const logicalURLs = await frame.evaluate(() => [
    document.querySelector("img").getAttribute("src"),
    document.querySelector("link").getAttribute("href"),
  ]);
  assert.deepEqual(logicalURLs, [
    "https://assets.example/image",
    "https://assets.example/style",
  ]);
  const physical = await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression:
      "[document.querySelector('img').getAttribute('src'),document.querySelector('link').getAttribute('href')]",
    returnByValue: true,
  });
  const urls = physical.result.value;
  for (const url of urls)
    assert.ok(url.startsWith(frontend + "/native-resource/v1/resource/"), url);
  const offBrowser = await new Promise((resolve, reject) => {
    const r = https.get(
      urls[0],
      {
        ca: cert,
        lookup: (_h, o, cb) =>
          o.all
            ? cb(null, [{ address: "127.0.0.1", family: 4 }])
            : cb(null, "127.0.0.1", 4),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    r.on("error", reject);
  });
  assert.equal(offBrowser, 403);
  const previous = await page.evaluate(() => ({
    sessionHash: frontendBrowser.assignment.sessionHash,
    generation: frontendBrowser.assignment.generation,
    node: frontendBrowser.assignment.node.id,
    browserSessionId: frontendBrowser.assignment.browserSessionId,
    tabSessionId: frontendBrowser.tabSessionId,
    documentId: frontendBrowser.document.documentId,
  }));
  await page.reload();
  await page.evaluate(boot, { html, png });
  const restoredFrame = page
    .frames()
    .find((f) => f.url().startsWith(frontend + "/browse/frame/"));
  assert.ok(restoredFrame);
  await restoredFrame.waitForFunction(() => window.jointResult, null, {
    timeout: 25000,
  });
  const restored = await restoredFrame.evaluate(() => window.jointResult);
  assert.equal(restored.before, "1");
  assert.equal(restored.save, "2");
  assert.equal(restored.parentFrontendLeak, false);
  const restoration = await page.evaluate(
    (previous) => ({
      sameSession:
        previous.sessionHash === frontendBrowser.assignment.sessionHash,
      sameGeneration:
        previous.generation === frontendBrowser.assignment.generation,
      sameNode: previous.node === frontendBrowser.assignment.node.id,
      sameBrowserSession:
        previous.browserSessionId ===
        frontendBrowser.assignment.browserSessionId,
      sameTabSession: previous.tabSessionId === frontendBrowser.tabSessionId,
      newDocument: previous.documentId !== frontendBrowser.document.documentId,
      finalURL: logicalLocations.at(-1),
    }),
    previous,
  );
  assert.deepEqual(restoration, {
    sameSession: true,
    sameGeneration: true,
    sameNode: true,
    sameBrowserSession: true,
    sameTabSession: true,
    newDocument: true,
    finalURL: "https://site.example/page",
  });
  const receipt = {
    result: "frontend_browser_default_components_verified",
    componentsOverride: ["fetch"],
    validRenewal: {
      sameBinding: renewed.sameBinding,
      sameFrame: renewed.sameFrame,
      sameIdentity: renewed.sameIdentity,
      ticketRenewed: renewed.ticketRenewed,
    },
    reload: {
      ...restoration,
      savedBefore: restored.before,
      savedAfter: restored.save,
    },
    assets: Object.keys(manifest.files).length,
    realBuiltRelayProbe: true,
    realFrontendControllerAndNativeGateway: true,
    sourceRedirectReboundBeforeStorage: true,
    canvas: result.canvas,
    css: result.css,
    nativeIsolatedWorldParent: boundary.result.value,
    virtualParentFrontendLeak: result.parentFrontendLeak,
    offBrowser,
    scope:
      "Main integration with deterministic website transport; not public-site/fleet acceptance",
  };
  await fs.writeFile(
    "evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
  await page.evaluate(() => {
    frontendBrowser.dispose();
  });
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => edge.close(r));
  await runtime?.close();
  await app?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
