/** Actual React App/Popout -> default seven-asset runtime -> real paired nodes.
 * Upstream HTML is a deterministic local website, not a public-site claim.
 * Local TLS trust and test-only capability advertisement never change sources.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { buildOpaqueRuntime } from "../scripts/build-opaque-runtime.mjs";
import { token, digest } from "../server/store.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const dir = await fs.mkdtemp(join(tmpdir(), "atlas-ui-real-"));
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
  join(dir, "key"),
  "-out",
  join(dir, "cert"),
  "-days",
  "1",
  "-subj",
  "/CN=front.test",
  "-addext",
  "subjectAltName=DNS:front.test,DNS:localhost,DNS:node0.localhost,DNS:node1.localhost",
]);
const key = await fs.readFile(join(dir, "key")),
  cert = await fs.readFile(join(dir, "cert"));
const spki = openssl(
  ["dgst", "-sha256", "-binary"],
  openssl(
    ["pkey", "-pubin", "-outform", "der"],
    openssl(["x509", "-pubkey", "-noout"], cert),
  ),
).toString("base64");
// Trust only this generated CA in addition to the process's existing roots.
const originalCAs = tls.getCACertificates("default");
tls.setDefaultCACertificates([...originalCAs, cert.toString()]);
const oldTrust = process.env.TRUST_PROXY;
process.env.TRUST_PROXY = "127.0.0.1,::1";
const nativeNow = Date.now;
let clockOffset = 0;
Date.now = () => nativeNow() + clockOffset;
const edges = [],
  nodes = [],
  errors = [],
  requests = [],
  websiteCalls = [],
  resourceHosts = [];
let app,
  browser,
  website,
  stage = "setup",
  controllerFailure;
const checkpoint = (value) => {
  stage = value;
  console.log("UI_REAL_STAGE " + value);
};
async function edgeFor(getApp, hostname) {
  const sockets = new Set();
  const edge = https.createServer({ key, cert }, (req, res) => {
    const target = getApp();
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: target.server.address().port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-forwarded-proto": "https",
          "x-forwarded-host": req.headers.host,
        },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  edge.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  edge.on("secureConnection", (socket) => socket.on("error", () => {}));
  edge.on("upgrade", (req, socket, head) =>
    getApp().server.emit("upgrade", req, socket, head),
  );
  await new Promise((resolve) => edge.listen(0, "127.0.0.1", resolve));
  edges.push({ edge, sockets });
  return `https://${hostname}:${edge.address().port}`;
}
const frontend = await edgeFor(() => app, "front.test");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
  "base64",
);
const websiteOrigin = "http://127.0.0.1:4199";
const websiteHTML = `<!doctype html><html><head><title>Actual UI website</title><link rel="stylesheet" href="http://localhost:4199/style"></head><body><h1>Actual UI website</h1><img src="http://localhost:4199/pixel"><button id="save">Manual Save</button><output id="state"></output><script>
function read(){return {local:localStorage.getItem('ui-save'),session:sessionStorage.getItem('ui-session'),cookie:document.cookie,origin:location.origin,path:location.pathname};}
if(!sessionStorage.getItem('ui-session'))sessionStorage.setItem('ui-session',crypto.randomUUID());
function show(){document.getElementById('state').textContent=JSON.stringify(read());}
document.getElementById('save').addEventListener('click',async()=>{localStorage.setItem('ui-save','manually committed');document.cookie='ui-cookie=committed; Path=/; Max-Age=31536000';await fetch('/echo');show();});
show();window.uiFixture={read};
</script></body></html>`;
const evidence = {
  scope:
    "Actual App/Popout/default runtime, seven assets, real paired node endpoints and deterministic upstream website; not public-site/fleet acceptance",
  activation: "actual server advertisement via explicit test configuration; production default held",
};
try {
  const assetDir = join(dir, "assets"),
    manifest = await buildOpaqueRuntime({ outdir: assetDir });
  const compiled = await build({
    absWorkingDir: resolve("."),
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import App from './web/src/App.tsx';import Popout from './web/src/Popout.tsx';createRoot(document.getElementById('root')).render(<React.StrictMode>{location.pathname==='/popout'?<Popout/>:<App/>}</React.StrictMode>);`,
      resolveDir: resolve("."),
      sourcefile: "actual-ui.tsx",
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    target: "es2022",
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  app = await createApp({
    dataDir: join(dir, "data"),
    staticDir: "/not-built",
    appOrigin: frontend,
    dynamicOrigins: false,
    runtimeOrigin: "https://runtime.invalid",
    localRelayMode: "frontend",
    nodesEnabled: true,
    opaqueRuntimeEnabled: true,
    opaqueRuntimeActivated: true,
    opaqueAssetsDir: assetDir,
  });
  app.addHook("onRequest", async (req) => {
    requests.push({
      path: req.url.split("?")[0],
      method: req.method,
      at: Date.now(),
    });
  });
  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/api/browse/controller/session" && controllerFailure)
      return reply.code(controllerFailure).header("Retry-After", "1").send({
        error: "Deterministic controller outage",
        code: "CONTROL_UNAVAILABLE",
        retryable: true,
        serverTime: Date.now(),
      });
  });

  const shell =
    "<!doctype html><html><head><style>[hidden]{display:none!important}.runtime-area,.popout-content{position:relative;height:65vh}button,a,input{margin:3px}</style></head><body><div id=root></div><script type=module src=/ui.js></script></body></html>";
  app.get("/", (_req, reply) => reply.type("text/html").send(shell));
  app.get("/popout", (_req, reply) => reply.type("text/html").send(shell));
  app.get("/_control/atlas-owner", (_req, reply) =>
    reply.type("text/html").send(shell),
  );
  app.get("/ui.js", (_req, reply) =>
    reply.type("application/javascript").send(compiled.outputFiles[0].contents),
  );
  app.get("/favicon.ico", (_req, reply) => reply.code(204).send());
  app.get("/favicon.svg", (_req, reply) =>
    reply
      .type("image/svg+xml")
      .send('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  website = http.createServer((req, res) => {
    websiteCalls.push({ path: req.url, cookie: req.headers.cookie || "" });
    res.setHeader("connection", "close");
    if (req.url === "/style") {
      res.setHeader("content-type", "text/css");
      res.end("body{background-color:rgb(1, 2, 3)}");
    } else if (req.url === "/pixel") {
      res.setHeader("content-type", "image/png");
      res.end(png);
    } else if (req.url === "/echo") {
      res.setHeader("content-type", "text/plain");
      res.end(req.headers.cookie || "");
    } else {
      res.setHeader("content-type", "text/html;charset=utf-8");
      res.end(websiteHTML);
    }
  });
  await new Promise((resolve) => website.listen(4199, "127.0.0.1", resolve));
  for (let i = 0; i < 2; i++) {
    let service, credentials;
    const origin = await edgeFor(() => service, "node" + i + ".localhost");
    service = await createNodeService({
      fixture: true,
      runtimeOrigin: origin,
      pairing: {
        verify: () => true,
        save: (value) => {
          credentials = value;
        },
      },
    });
    service.addHook("onRequest", async (req) => {
      if (req.url.startsWith("/native-resource/v1/resource/"))
        resourceHosts.push(origin);
    });
    await service.listen({ host: "127.0.0.1", port: 0 });
    const { id } = await app.nodePool.attach(
      { endpoint: origin, name: "Actual UI node " + i, code: "fixture" },
      frontend,
    );
    nodes.push({
      id,
      origin,
      service,
      get secret() {
        return credentials.secret;
      },
    });
  }
  app.nodePool.update("local", { state: "disabled", weight: 1 });
  const administrator = token(),
    csrf = token(),
    now = Date.now();
  app.store.db
    .prepare("INSERT INTO sessions(hash,csrf,created,seen) VALUES(?,?,?,?)")
    .run(digest(administrator), csrf, now, now);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--no-proxy-server",
      "--host-resolver-rules=MAP front.test 127.0.0.1,MAP node0.localhost 127.0.0.1,MAP node1.localhost 127.0.0.1",
      "--ignore-certificate-errors-spki-list=" + spki,
    ],
  });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "__Host-atlas-admin",
      value: administrator,
      url: frontend,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  await context.addInitScript(
    ({ frontend }) => {
      if (
        window !== top ||
        location.origin !== frontend ||
        location.pathname.startsWith("/browse/")
      )
        return;
      window.__uiInitialWindowId = sessionStorage.getItem(
        "atlas.frontendWindow.v2",
      );
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({ motion: false, autocomplete: false }),
      );
      const native = Date.now;
      window.__uiClockOffset = 0;
      Date.now = () => native() + window.__uiClockOffset;
      const timeout = window.setTimeout;
      window.__uiRenewTimers = [];
      window.setTimeout = function (fn, delay, ...args) {
        if (delay === 300000 && typeof fn === "function")
          window.__uiRenewTimers.push(() => fn(...args));
        return timeout.call(window, fn, delay, ...args);
      };
    },
    { frontend },
  );
  function watch(page) {
    page.on("pageerror", (error) =>
      errors.push({ stage, type: "pageerror", message: error.message }),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push({
          stage,
          type: "console",
          message: message.text(),
          url: message.location().url,
        });
    });
  }
  const assignment = (page) =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("atlas.frontendAssignment.v2"))?.active,
    );
  async function documentFrame(page) {
    const element = page.locator('[data-frontend-runtime="2"] iframe').first();
    await element.waitFor({ timeout: 45000 });
    const frame = await (await element.elementHandle()).contentFrame();
    assert.ok(frame);
    await frame.waitForURL(
      (url) => url.href.startsWith(frontend + "/browse/frame/"),
      { timeout: 45000 },
    );
    await frame.waitForFunction(() => window.uiFixture, null, {
      timeout: 45000,
    });
    return frame;
  }
  async function restoreWebsite(page) {
    await page.locator(".tab-main").first().click();
    return documentFrame(page);
  }
  async function nativeOrigin(page, frame) {
    const cdp = await context.newCDPSession(frame);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "atlas-ui-native-origin-proof",
    });
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "self.origin",
      contextId: executionContextId,
      returnByValue: true,
    });
    await cdp.detach();
    return result.value;
  }
  const page = await context.newPage();
  watch(page);
  checkpoint("app-start");
  await page.goto(frontend);
  const search = page.getByRole("combobox", {
    name: "Search the web",
    exact: true,
  });
  await search.fill(websiteOrigin + "/one");
  await search.press("Enter");
  let frame = await documentFrame(page);
  let first = await assignment(page);
  assert.equal(new URL(frame.url()).origin, frontend);
  assert.equal(await nativeOrigin(page, frame), "null");
  assert.equal(
    await page
      .locator('iframe[title="Atlas isolated browsing runtime"]')
      .count(),
    0,
  );
  const startState = await frame.evaluate(() => uiFixture.read());
  checkpoint("manual-save");
  assert.equal(startState.local, null);
  await frame.getByRole("button", { name: "Manual Save" }).click();
  await frame.waitForFunction(() =>
    uiFixture.read().cookie.includes("ui-cookie=committed"),
  );
  assert.ok(
    websiteCalls.some(
      (call) =>
        call.path === "/echo" && call.cookie.includes("ui-cookie=committed"),
    ),
  );
  const savedSession = (await frame.evaluate(() => uiFixture.read())).session;
  const firstDocument = frame.url();
  checkpoint("whole-shell-reload");
  await page.reload();
  frame = await restoreWebsite(page);
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).local,
    "manually committed",
  );
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).session,
    savedSession,
  );
  assert.notEqual(frame.url(), firstDocument);
  evidence.fullReload = {
    save: true,
    sessionStorageIdentity: true,
    frontendFrameURL: true,
  };
  checkpoint("native-duplicate-window");
  // Native window.open with a live opener clones sessionStorage in Chromium.
  const [cloned, cloneSnapshot] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate(() => {
      const popup = window.open(location.href, "_blank");
      return popup.sessionStorage.getItem("atlas.frontendWindow.v2");
    }),
  ]);
  watch(cloned);
  await cloned.waitForLoadState();
  const clonedFrame = await restoreWebsite(cloned),
    cloneState = await clonedFrame.evaluate(() => uiFixture.read());
  assert.equal(cloneState.local, "manually committed");
  assert.notEqual(cloneState.session, savedSession);
  const ownerIds = await Promise.all(
    [page, cloned].map((p) =>
      p.evaluate(() => sessionStorage.getItem("atlas.frontendWindow.v2")),
    ),
  );
  assert.notEqual(ownerIds[0], ownerIds[1]);
  assert.equal(cloneSnapshot, ownerIds[0]);
  evidence.nativeDuplicateWindow = {
    nativeSessionStorageCloneObserved: true,
    sharedLocal: true,
    separateSession: true,
    uniqueOwner: true,
  };
  await cloned.close();
  checkpoint("popout-handoff");
  const popoutEvent = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popout = await popoutEvent;
  watch(popout);
  await popout.waitForLoadState();
  let popFrame = await documentFrame(popout);
  const launchSession = new URLSearchParams(
    new URL(popout.url()).hash.slice(1),
  ).get("session");
  assert.equal(launchSession, first.session);
  assert.equal(
    (await popFrame.evaluate(() => uiFixture.read())).local,
    "manually committed",
  );
  const popSession = (await popFrame.evaluate(() => uiFixture.read())).session;
  assert.notEqual(popSession, savedSession);
  await popout.reload();
  popFrame = await documentFrame(popout);
  assert.equal(
    (await popFrame.evaluate(() => uiFixture.read())).session,
    popSession,
  );
  evidence.popout = {
    currentFrontendFrame: new URL(popFrame.url()).origin === frontend,
    exactAssignment: true,
    sharedSave: true,
    distinctSession: true,
    reloadRetainedSession: true,
  };
  await popout.close();
  checkpoint("admin-node-selection");
  // Exercise actual administrator React controls/coordinator reserve-probe-commit.
  const target = nodes.find((node) => node.id !== first.node.id);
  await page.goto(frontend + "/_control/atlas-owner");
  await page
    .getByRole("button", { name: "Browsing nodes", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Assign this browser to", exact: true })
    .selectOption(target.id);
  await page
    .getByRole("button", { name: "Apply to this browser", exact: true })
    .click();
  await page.waitForFunction(
    (node) =>
      JSON.parse(localStorage.getItem("atlas.frontendAssignment.v2"))?.active
        ?.node?.id === node,
    target.id,
  );
  await page.goto(frontend);
  frame = await restoreWebsite(page);
  const switched = await assignment(page);
  assert.equal(switched.node.id, target.id);
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).local,
    "manually committed",
  );
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).session,
    savedSession,
  );
  assert.ok(resourceHosts.includes(target.origin));
  assert.ok(
    websiteCalls
      .filter((call) => call.path === "/one")
      .at(-1)
      .cookie.includes("ui-cookie=committed"),
  );
  evidence.nodeSwitch = {
    original: first.node.name,
    selected: switched.node.name,
    save: true,
    cookie: (await frame.evaluate(() => uiFixture.read())).cookie.includes(
      "ui-cookie=committed",
    ),
    sessionStorage: true,
    nativeHTTPSUsesSameSelectedNode: true,
  };
  checkpoint("transient-controller-lifecycle");
  await page.bringToFront();
  const stable = await assignment(page);
  await page.evaluate(() => {
    window.__uiStableFrame = document.querySelector(
      '[data-frontend-runtime="2"] iframe',
    );
  });
  async function assertStable(label) {
    const value = await assignment(page);
    assert.equal(value.session, stable.session, label + " session");
    assert.equal(value.node.id, stable.node.id, label + " pin");
    assert.equal(
      await page.evaluate(
        () =>
          window.__uiStableFrame ===
          document.querySelector('[data-frontend-runtime="2"] iframe'),
      ),
      true,
      label + " original frame",
    );
    assert.equal(
      await page.locator(".runtime-error").count(),
      0,
      label + " no reconnect/error overlay",
    );
  }
  async function signal(event, status = 200) {
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/browse/controller/session" &&
        response.status() === status,
      { timeout: 20000 },
    );
    await page.evaluate((event) => {
      if (event === "resume" || event === "visibilitychange")
        document.dispatchEvent(new Event(event));
      else window.dispatchEvent(new Event(event));
    }, event);
    await response;
    // Wait for the actual coordinator to persist its accepted response.
    if (status === 200)
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem("atlas.frontendAssignment.v2"))
            ?.validatedAt >=
          Date.now() - 2000,
      );
  }
  for (const status of [429, 503]) {
    controllerFailure = status;
    await signal("online", status);
    await assertStable("HTTP" + status);
  }
  controllerFailure = undefined;
  await signal("online");
  await assertStable("online recovery");
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(75);
  await assertStable("offline");
  await context.setOffline(false);
  await signal("online");
  await assertStable("return online");
  app.store.db
    .prepare("UPDATE nodes SET seen=? WHERE id=?")
    .run(Date.now() - 120000, stable.node.id);
  await signal("pageshow", 503);
  await assertStable("stale heartbeat");
  for (const node of nodes)
    await app.nodePool.heartbeat(node.id, node.secret, 0);
  await signal("resume");
  await assertStable("heartbeat resume");
  evidence.transientLifecycle = {
    offline: true,
    rateLimit429: true,
    server503: true,
    staleHeartbeat: true,
    onlineAndResume: true,
    noSilentNodeOrFrameChange: true,
  };
  checkpoint("clock-advanced-active-13-hours");
  const activeSteps = [];
  async function advanceClock(milliseconds) {
    clockOffset += milliseconds;
    await page.evaluate((offset) => {
      window.__uiClockOffset = offset;
    }, clockOffset);
    for (const node of nodes)
      await app.nodePool.heartbeat(node.id, node.secret, 0);
  }
  // Invoke the exact default five-minute timer callback after advancing Date,
  // rather than waiting five wall-clock minutes or substituting a coordinator.
  await advanceClock(5 * 60000);
  const timerResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/browse/controller/session" &&
      response.status() === 200,
  );
  await page.evaluate(() => {
    const timer = window.__uiRenewTimers.at(-1);
    if (!timer) throw Error("default renewal timer absent");
    timer();
  });
  await timerResponse;
  await assertStable("five-minute renewal timer");
  for (const hours of [4, 4, 4, 1]) {
    await advanceClock(hours * 3600000);
    await signal("resume");
    await assertStable("active elapsed " + clockOffset);
    // This active-browsing scenario performs real cookie/storage work each
    // interval. A fake Date jump alone does not run independent worker pings.
    const stepState = await frame.evaluate(() => {
      localStorage.setItem("ui-active-checkpoint", String(Date.now()));
      return uiFixture.read();
    });
    assert.equal(stepState.local, "manually committed");
    assert.ok(stepState.cookie.includes("ui-cookie=committed"));
    activeSteps.push({
      elapsedHours: clockOffset / 3600000,
      node: (await assignment(page)).node.name,
      sameFrame: true,
    });
  }
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).local,
    "manually committed",
  );
  assert.ok(
    (await frame.evaluate(() => uiFixture.read())).cookie.includes(
      "ui-cookie=committed",
    ),
  );
  evidence.activeBeyond12Hours = {
    defaultFiveMinuteTimer: true,
    sameSession: true,
    sameFrame: true,
    steps: activeSteps,
  };
  checkpoint("clock-advanced-idle-next-day");
  const preIdle = await assignment(page);
  const preIdleFrame = frame.url();
  await advanceClock(13 * 3600000);
  await signal("pageshow");
  await page.waitForFunction(
    (old) =>
      JSON.parse(localStorage.getItem("atlas.frontendAssignment.v2"))?.active
        ?.session !== old,
    preIdle.session,
  );
  await page.waitForFunction((previous) => {
    const frame = document.querySelector('[data-frontend-runtime="2"] iframe');
    return frame && frame.src !== previous;
  }, preIdleFrame);
  frame = await documentFrame(page);
  const recovered = await assignment(page);
  assert.equal(recovered.node.id, preIdle.node.id);
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).local,
    "manually committed",
  );
  assert.equal(
    (await frame.evaluate(() => uiFixture.read())).session,
    savedSession,
  );
  assert.equal(
    await page.locator(".runtime-error").count(),
    0,
    "normal idle expiry does not ask for manual reconnect",
  );
  evidence.overnightResume = {
    freshSession: recovered.session !== preIdle.session,
    previousHealthyNode: true,
    save: true,
    sessionStorage: true,
    noManualReconnect: true,
  };
  evidence.assetCount = Object.keys(manifest.files || {}).length;
  assert.equal(evidence.assetCount, 7);
  evidence.runtimeAssets = manifest.files;
  evidence.noLegacySessionRequests = requests.every(
    (request) => request.path !== "/api/browse/session",
  );
  evidence.websiteRequestsThroughActualHttpEngine = websiteCalls.length;
  evidence.errors = errors;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        stage,
        failure: error.message,
        errors,
        requests: requests.slice(-30),
        websiteCalls: websiteCalls.slice(-12),
        resourceHosts,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  Date.now = nativeNow;
  tls.setDefaultCACertificates(originalCAs);
  if (oldTrust === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = oldTrust;
  await browser?.close();
  if (website) await new Promise((resolve) => website.close(resolve));
  for (const node of nodes) await node.service.close();
  await app?.close();
  for (const { edge, sockets } of edges) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => edge.close(resolve));
  }
  await fs.rm(dir, { recursive: true, force: true });
}
