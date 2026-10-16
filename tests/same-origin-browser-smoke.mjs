#!/usr/bin/env node
// Focused actual-Chromium acceptance: current frontend origin, two direct WSS
// nodes, virtual cookies and durable game saves. No external websites/accounts.
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  request as requestHttp,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { chromium, expect as browserExpect } from "@playwright/test";
import { WebSocketServer } from "ws";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";

process.env.ATLAS_BROWSER_RUNTIME = "same-origin";
process.env.NODE_ENV = "test";
process.env.ATLAS_TEST_FIXTURE = "1";
process.env.TRUST_PROXY = "127.0.0.1,::1";
const expect = browserExpect.configure({ timeout: 15000 });
const output = resolve(
  process.argv[2] || "evidence/same-origin-browser-20261016/RECEIPT.json",
);
const built = resolve(process.env.ATLAS_SMOKE_DIST || "dist");
const frontend = "https://atlas.localhost:4510";
const configuredFrontend = "https://stable-frontend.invalid";
const target = "http://localhost:4199";
const runtimePath = "/browse/runtime/";
const sessionStorageKey = "atlas.nodeSession.sameOrigin.v1";
const leaseStorageKey = "atlas.nodeLease.sameOrigin.v1";
const legacySession = "stale-legacy-node-session-fixture";
const temporary = mkdtempSync(join(tmpdir(), "atlas-same-origin-browser-"));
const receipt = {
  result: "RUNNING",
  frontend,
  configuredFrontend,
  target,
  runtimePath,
  nodes: ["https://127.0.0.1:4512", "https://127.0.0.1:4513"],
  checks: {},
};
const services = [],
  proxies = [],
  websiteSockets = new Set(),
  observedSockets = [],
  relayedUpgrades = [],
  errors = [];
let app, browser, context, heartbeat;
const fixtureWebSockets = new WebSocketServer({ noServer: true });
const save = "cookie-clicker:777";
function html(cookie) {
  return `<!doctype html><meta charset="utf-8"><title>Same-origin smoke fixture</title>
<h1>Same-origin smoke fixture</h1><p id="server-cookie">${cookie.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>
<p id="document-cookie"></p><p id="state">loading</p>
<a href="/smoke/signin">Sign in fixture</a><button id="save">Save game</button>
<button id="fetch">Test fetch</button><p id="fetch-result"></p>
<button id="socket">Test WebSocket</button><p id="socket-result"></p>
<button id="popup">Open managed popup</button><p id="popup-result"></p>
<input id="draft" aria-label="Unsent draft"><script>
const database=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('atlas-smoke-game',1);r.onupgradeneeded=()=>r.result.createObjectStore('saves');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
async function state(){const db=await database();const indexed=await new Promise((resolve,reject)=>{const tx=db.transaction('saves','readonly'),r=tx.objectStore('saves').get('game');tx.oncomplete=()=>resolve(r.result||null);tx.onerror=()=>reject(tx.error)});db.close();document.querySelector('#state').textContent=JSON.stringify({local:localStorage.getItem('atlas-smoke-save'),indexed});document.querySelector('#document-cookie').textContent=document.cookie}
document.querySelector('#save').onclick=async()=>{localStorage.setItem('atlas-smoke-save',${JSON.stringify(save)});document.cookie='atlas_smoke_js=written; Path=/smoke/; Max-Age=3600';const db=await database();await new Promise((resolve,reject)=>{const tx=db.transaction('saves','readwrite');tx.objectStore('saves').put(${JSON.stringify(save)},'game');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();await state()};
document.querySelector('#fetch').onclick=async()=>document.querySelector('#fetch-result').textContent=await fetch('/smoke/echo',{method:'POST',body:'fetch works'}).then(r=>r.text());
document.querySelector('#socket').onclick=()=>{const s=new WebSocket('ws://localhost:4199/smoke/socket');s.onopen=()=>s.send('socket works');s.onmessage=e=>{document.querySelector('#socket-result').textContent=e.data;s.close()}};
document.querySelector('#popup').onclick=()=>window.open('/smoke/popup','atlas-smoke-popup');
addEventListener('message',e=>{if(e.data==='managed-popup-done')document.querySelector('#popup-result').textContent='Opener received'});state().catch(e=>document.querySelector('#state').textContent=e.name+':'+e.message);
</script>`;
}
const website = createHttpServer(
  {
    shouldUpgradeCallback: (req) =>
      req.headers.upgrade?.toLowerCase() === "websocket",
  },
  async (req, res) => {
    const url = new URL(req.url, target);
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/smoke/signin") {
      res.writeHead(302, {
        "Set-Cookie": [
          "atlas_smoke_session=retained; Path=/smoke/; HttpOnly; Max-Age=3600; SameSite=Lax",
          "atlas_smoke_domain=retained; Domain=localhost; Path=/smoke/; Max-Age=3600; SameSite=Lax",
          "atlas_smoke_path=retained; Path=/smoke/private/; Max-Age=3600; SameSite=Lax",
          "atlas_smoke_wrong_domain=bad; Domain=invalid.example; Path=/; Max-Age=3600",
        ],
        Location: "/smoke/page",
      });
      return res.end();
    }
    if (url.pathname === "/smoke/popup") {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        `<!doctype html><h1>Managed popup fixture</h1><button onclick="opener.postMessage('managed-popup-done',location.origin);window.close()">Finish managed popup</button>`,
      );
    }
    if (
      ["/smoke/echo", "/smoke/private/echo", "/outside/echo"].includes(
        url.pathname,
      )
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          cookie: req.headers.cookie || "",
          method: req.method,
          body,
        }),
      );
    }
    res.setHeader("Content-Type", "text/html");
    res.end(html(req.headers.cookie || ""));
  },
);
website.on("connection", (socket) => {
  websiteSockets.add(socket);
  socket.on("close", () => websiteSockets.delete(socket));
});
website.on("upgrade", (req, socket, head) => {
  if (req.url !== "/smoke/socket") return socket.destroy();
  fixtureWebSockets.handleUpgrade(req, socket, head, (ws) =>
    fixtureWebSockets.emit("connection", ws),
  );
});
fixtureWebSockets.on("connection", (ws) =>
  ws.on("message", (data) => ws.send(data.toString())),
);

async function listen(service, port) {
  await service.listen({ port, host: "127.0.0.1" });
  services.push(service);
}
async function proxy(port, upstream, tls) {
  const sockets = new Set();
  const headers = (req) => ({
    ...req.headers,
    "x-forwarded-host": req.headers.host,
    "x-forwarded-proto": "https",
  });
  const server = createHttpsServer(tls, (req, res) => {
    const forward = requestHttp(
      {
        host: "127.0.0.1",
        port: upstream,
        path: req.url,
        method: req.method,
        headers: headers(req),
      },
      (incoming) => {
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(res);
      },
    );
    forward.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(error.code || "PROXY_ERROR");
    });
    req.pipe(forward);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    relayedUpgrades.push({
      node: `https://127.0.0.1:${port}`,
      path: new URL(req.url, frontend).pathname
        .split("/")
        .slice(0, 2)
        .join("/"),
      origin: req.headers.origin,
    });
    const forward = requestHttp({
      host: "127.0.0.1",
      port: upstream,
      path: req.url,
      headers: headers(req),
    });
    forward.on("upgrade", (incoming, connected, incomingHead) => {
      socket.write(
        `HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n${Object.entries(
          incoming.headers,
        )
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("")}\r\n`,
      );
      if (incomingHead.length) socket.write(incomingHead);
      if (head.length) connected.write(head);
      socket.pipe(connected).pipe(socket);
      socket.on("close", () => connected.destroy());
      connected.on("error", () => socket.destroy());
    });
    forward.on("response", (incoming) => {
      socket.end(
        `HTTP/1.1 ${incoming.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
      );
      incoming.resume();
    });
    forward.on("error", () => socket.destroy());
    socket.on("error", () => forward.destroy());
    forward.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  proxies.push({ server, sockets });
}
const host = (page) =>
  page.frameLocator('iframe[title="Atlas isolated browsing runtime"]');
const site = (page) =>
  host(page).frameLocator('iframe[title="Proxied website"]:not([hidden])');
async function openTarget(page) {
  await page.goto(frontend);
  const saved = page.getByRole("button", {
    name: "Same-origin smoke fixture",
    exact: true,
  });
  if (await saved.count()) await saved.first().click();
  else {
    await page.getByLabel("Search the web").fill(target + "/smoke/page");
    await page.getByLabel("Search the web").press("Enter");
  }
  await expect(
    site(page).getByRole("heading", {
      name: "Same-origin smoke fixture",
      exact: true,
    }),
  ).toBeVisible();
}
async function savedState(page) {
  await expect(site(page).locator("#state")).toHaveText(
    JSON.stringify({ local: save, indexed: save }),
  );
  await expect(site(page).locator("#server-cookie")).toContainText(
    "atlas_smoke_session=retained",
  );
  await expect(site(page).locator("#server-cookie")).toContainText(
    "atlas_smoke_domain=retained",
  );
  await expect(site(page).locator("#document-cookie")).toContainText(
    "atlas_smoke_js=written",
  );
  await expect(site(page).locator("#document-cookie")).not.toContainText(
    "atlas_smoke_session",
  );
}
async function network(page) {
  await site(page)
    .getByRole("button", { name: "Test fetch", exact: true })
    .click();
  await expect(site(page).locator("#fetch-result")).toContainText(
    "fetch works",
  );
  await site(page)
    .getByRole("button", { name: "Test WebSocket", exact: true })
    .click();
  await expect(site(page).locator("#socket-result")).toHaveText("socket works");
}
async function assertPhysicalOrigin(page) {
  const iframe = page.locator(
    'iframe[title="Atlas isolated browsing runtime"]',
  );
  const source = new URL(await iframe.getAttribute("src"));
  assert.equal(
    source.origin,
    frontend,
    "runtime iframe must use current frontend origin",
  );
  assert.equal(source.pathname, runtimePath);
  assert.equal(
    await host(page)
      .locator("body")
      .evaluate(
        (body) => body.ownerDocument.defaultView.parent.location.origin,
      ),
    frontend,
    "runtime must read native same-origin parent rather than only display a frontend URL",
  );
  // Inspect the browser-native frame URL, independent of rewritten Location.
  const runtimeFrame = await (await iframe.elementHandle()).contentFrame();
  const websiteFrame = runtimeFrame
    .childFrames()
    .find((frame) => frame.url().startsWith(frontend + "/~/"));
  assert.ok(
    websiteFrame,
    "website native browsing context must be frontend-origin",
  );
  receipt.nativeWebsiteOrigin = new URL(websiteFrame.url()).origin;
}
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=atlas.localhost",
      "-addext",
      "subjectAltName=DNS:atlas.localhost,DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(temporary, "key.pem"),
      "-out",
      join(temporary, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(temporary, "cert.pem"), "utf8"),
    key = readFileSync(join(temporary, "key.pem"));
  setDefaultCACertificates([...getCACertificates(), cert]);
  await new Promise((resolve, reject) => {
    website.once("error", reject);
    website.listen(4199, "127.0.0.1", resolve);
  });
  app = await createApp({
    dataDir: join(temporary, "data"),
    appOrigin: configuredFrontend,
    runtimeOrigin: "https://runtime.invalid",
    staticDir: join(built, "web"),
    nodesEnabled: true,
    sameOriginRuntime: true,
    runtimePath,
    runtimeStaticDir: join(built, "runtime"),
    opaqueRuntimeEnabled: false,
    opaqueRuntimeActivated: false,
    fixture: true,
  });
  await listen(app, 4511);
  await proxy(4510, 4511, { key, cert });
  const nodes = [];
  for (let i = 0; i < 2; i++) {
    const service = await createNodeService({
      fixture: true,
      runtimeOrigin: receipt.nodes[i],
      staticDir: join(built, "runtime"),
      pairing: { verify: (code) => code === "BROWSER-SMOKE", save() {} },
    });
    await listen(service, 4522 + i);
    await proxy(4512 + i, 4522 + i, { key, cert });
    const attached = await app.nodePool.attach(
      {
        name: `Smoke node ${i + 1}`,
        endpoint: receipt.nodes[i],
        code: "BROWSER-SMOKE",
      },
      frontend,
    );
    nodes.push({ service, id: attached.id });
  }
  app.nodePool.update("local", { state: "disabled", weight: 1 });
  heartbeat = setInterval(async () => {
    for (const { service, id } of nodes) {
      const row = app.store.db
        .prepare("SELECT credential FROM nodes WHERE id=?")
        .get(id);
      await app.nodePool
        .heartbeat(
          id,
          app.store.unseal(row.credential),
          service.connectionCount(),
        )
        .catch(() => {});
      service.applyControl(app.nodePool.nodeState(id));
    }
  }, 5000);
  const initial = await app.nodePool.select(
    "",
    frontend,
    app.atlasConfig.runtimeOrigin,
    nodes[0].id,
  );
  receipt.initialNode = initial.node.name;
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP atlas.localhost 127.0.0.1",
    ],
  });
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  context.on("page", (page) =>
    page.on("websocket", (socket) => observedSockets.push(socket.url())),
  );
  await context.addInitScript(
    ({ session, sessionStorageKey, legacySession }) => {
      if (window !== top || location.hostname !== "atlas.localhost") return;
      localStorage.setItem("atlas.onboarded", "true");
      localStorage.setItem(
        "atlas.settings",
        JSON.stringify({ motion: false, restore: true }),
      );
      if (!localStorage.getItem("atlas.smokeSeeded")) {
        localStorage.setItem("atlas.smokeSeeded", "true");
        localStorage.setItem(sessionStorageKey, JSON.stringify(session));
        localStorage.setItem(
          "atlas.nodeSession",
          JSON.stringify(legacySession),
        );
        localStorage.setItem(
          "atlas.nodeLease.v2",
          JSON.stringify({
            session: legacySession,
            generation: 1,
            ticket: "stale-legacy-ticket",
            runtimeOrigin: "https://old-node.invalid",
            node: { id: "legacy-node", name: "Legacy node", online: true },
          }),
        );
      }
    },
    { session: initial.session, sessionStorageKey, legacySession },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 240)));
  page.setDefaultTimeout(15000);
  await openTarget(page);
  const publicConfig = await page.evaluate(() =>
    fetch("/api/config").then((response) => response.json()),
  );
  assert.equal(
    publicConfig.runtimeOrigin,
    frontend,
    "current frontend alias must win over configured APP_ORIGIN fallback",
  );
  assert.equal(publicConfig.runtimeProtocols.sameOrigin.activated, true);
  assert.equal(publicConfig.runtimeProtocols.opaque.activated, false);
  await assertPhysicalOrigin(page);
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      sessionStorageKey,
    ),
    initial.session,
  );
  assert.equal(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("atlas.nodeSession")),
    ),
    legacySession,
  );
  receipt.checks.currentFrontendNativeOrigin = "PASS";
  receipt.checks.staleLegacyAssignmentIgnoredAndPreserved = "PASS";
  await network(page);
  assert.ok(
    relayedUpgrades.some(
      (upgrade) =>
        upgrade.node === receipt.nodes[0] && upgrade.origin === frontend,
    ),
    "selected first node must receive frontend-origin WSS directly",
  );
  assert.ok(
    !relayedUpgrades.some((upgrade) => upgrade.node.endsWith(":4510")),
    "remote browsing traffic must not fall back to the frontend relay",
  );
  receipt.checks.firstNodeDirectWssHttpAndWebSocket = "PASS";
  await site(page)
    .getByRole("link", { name: "Sign in fixture", exact: true })
    .click();
  await expect(site(page).locator("#server-cookie")).toContainText(
    "atlas_smoke_session=retained",
  );
  await site(page)
    .getByRole("button", { name: "Save game", exact: true })
    .click();
  await savedState(page);
  const cookies = await site(page)
    .locator("body")
    .evaluate(async () => {
      const get = (path) =>
        fetch(path)
          .then((response) => response.json())
          .then((value) => value.cookie);
      return {
        normal: await get("/smoke/echo"),
        private: await get("/smoke/private/echo"),
        outside: await get("/outside/echo"),
        visible: document.cookie,
      };
    });
  assert.match(cookies.normal, /atlas_smoke_domain=retained/);
  assert.doesNotMatch(
    cookies.normal,
    /atlas_smoke_path=|atlas_smoke_wrong_domain=/,
  );
  assert.match(cookies.private, /atlas_smoke_path=retained/);
  assert.equal(cookies.outside, "");
  assert.doesNotMatch(cookies.visible, /atlas_smoke_session=/);
  receipt.checks.cookieHttpOnlyDomainPathAndDocumentCookie = "PASS";
  receipt.checks.localStorageAndIndexedDbSave = "PASS";
  await openTarget(page);
  await savedState(page);
  receipt.checks.reloadRetainsCookiesAndGameSave = "PASS";
  const oldSession = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    sessionStorageKey,
  );
  const second = await app.nodePool.select(
    oldSession,
    frontend,
    app.atlasConfig.runtimeOrigin,
    nodes[1].id,
  );
  assert.notEqual(second.session, oldSession);
  await page.evaluate(
    ({ session, sessionStorageKey, leaseStorageKey }) => {
      localStorage.setItem(sessionStorageKey, JSON.stringify(session));
      localStorage.removeItem(leaseStorageKey);
    },
    { session: second.session, sessionStorageKey, leaseStorageKey },
  );
  await openTarget(page);
  await assertPhysicalOrigin(page);
  await savedState(page);
  await network(page);
  assert.ok(
    relayedUpgrades.some(
      (upgrade) =>
        upgrade.node === receipt.nodes[1] && upgrade.origin === frontend,
    ),
    "selected second node must receive frontend-origin WSS directly",
  );
  assert.ok(
    !relayedUpgrades.some((upgrade) => upgrade.node.endsWith(":4510")),
    "node change must preserve direct remote WSS routing",
  );
  receipt.checks.nodeChangeRetainsCookiesLocalStorageAndIndexedDb = "PASS";
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Pop out tab", exact: true }).click();
  const popup = await opened;
  popup.setDefaultTimeout(15000);
  await expect(
    site(popup).getByRole("heading", {
      name: "Same-origin smoke fixture",
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(new URL(popup.url()).origin, frontend);
  assert.equal(new URL(popup.url()).pathname, "/popout");
  await assertPhysicalOrigin(popup);
  await savedState(popup);
  await popup.reload();
  await savedState(popup);
  receipt.checks.frontendPopoutAndReloadShareCookiesAndGameSave = "PASS";
  await site(popup)
    .getByRole("button", { name: "Open managed popup", exact: true })
    .click();
  await expect(
    site(popup).getByRole("heading", {
      name: "Managed popup fixture",
      exact: true,
    }),
  ).toBeVisible();
  await site(popup)
    .getByRole("button", { name: "Finish managed popup", exact: true })
    .click();
  await expect(site(popup).locator("#popup-result")).toHaveText(
    "Opener received",
  );
  await savedState(popup);
  receipt.checks.managedPopupOpenerAndClose = "PASS";
  const physicalCookies = await context.cookies(frontend);
  assert.ok(
    !physicalCookies.some((cookie) => cookie.name.startsWith("atlas_smoke_")),
    "virtual website cookies must not become native frontend cookies",
  );
  receipt.checks.websiteCookiesRemainVirtual = "PASS";
  receipt.result = "PASS";
  console.log(
    "SAME_ORIGIN_BROWSER=PASS; CURRENT_FRONTEND_NATIVE_ORIGIN=PASS; DIRECT_SELECTED_NODE_WSS=PASS; COOKIE_HTTPONLY_DOMAIN_PATH=PASS; COOKIE_STORAGE_IDB_RELOAD_NODE_CHANGE=PASS; EMBEDDED_POPOUT=PASS; MANAGED_POPUP=PASS",
  );
} catch (error) {
  receipt.result = "FAIL";
  receipt.failure = error.message;
  if (process.env.ATLAS_SMOKE_DEBUG === "1") {
    receipt.stack = error.stack;
    receipt.frames = context
      ? await Promise.all(
          context.pages().map(async (page) => ({
            url: page.url().split("#")[0],
            frames: page
              .frames()
              .map((frame) => frame.url().split("#")[0].slice(0, 160)),
            body: await page
              .locator("body")
              .innerText()
              .catch(() => "closed"),
          })),
        )
      : [];
  }
  console.log("SAME_ORIGIN_BROWSER=FAIL; " + error.message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  receipt.relayUpgrades = relayedUpgrades;
  receipt.browserSocketOrigins = [
    ...new Set(observedSockets.map((value) => new URL(value).origin)),
  ];
  receipt.pageErrors = errors;
  await browser?.close();
  for (const { server, sockets } of proxies) {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const service of services.reverse()) {
    service.server.closeAllConnections?.();
    await service.close();
  }
  for (const client of fixtureWebSockets.clients) client.terminate();
  fixtureWebSockets.close();
  for (const socket of websiteSockets) socket.destroy();
  await new Promise((resolve) => website.close(resolve));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  // Reopen the claimed evidence artifact before returning its absolute path.
  assert.equal(JSON.parse(readFileSync(output, "utf8")).result, receipt.result);
  console.log("RECEIPT=" + output);
  rmSync(temporary, { recursive: true, force: true });
}
