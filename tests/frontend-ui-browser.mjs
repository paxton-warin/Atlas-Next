/** Real Chrome/React App+Popout composition proof. Only the runtime factory is
 * deterministic here; this test does NOT qualify upstream transport/isolation.
 * Those are exercised by frontend-browser-browser.mjs and sandbox tests. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './web/src/App.tsx';
import Popout from './web/src/Popout.tsx';
import NodeSettings from './web/src/NodeSettings.tsx';
const nodeProof=<NodeSettings csrf="fixture-csrf" browsingNode={{id:'nodeA',name:'Node A'}} selectBrowsingNode={async(node,csrf)=>{window.__nodeSelectionCalls ||= [];window.__nodeSelectionCalls.push({node,csrf});return {node:{id:node,name:node}}}} onLeaseSelected={(lease,persisted)=>window.__nodeSelectionResult={lease,persisted}}/>;
createRoot(document.getElementById('root')).render(<React.StrictMode>{location.pathname==='/__node-proof'?nodeProof:location.pathname==='/popout'?<Popout/>:<App/>}</React.StrictMode>);
`;
const factory = `
const test = window.__frontendUITest ||= {created:[],calls:[]};
export async function createFrontendBrowser(options) {
 const index=test.created.length;
 const record={tabSessionId:options.tabSessionId,initialSession:options.coordinatorOptions?.initialSession?.session, disposed:false};
 record.connection=(state)=>options.onAssignmentState?.(state);
 test.created.push(record);
 let assignment={protocol:2,session:record.initialSession||'a'.repeat(43),sessionHash:'b'.repeat(64),generation:1,frontendOrigin:location.origin,runtimeOrigin:location.origin,relayOrigin:'https://selected-node.invalid',node:{id:'nodeA',name:'Selected node A'},ticket:'fixture-ticket',browserSessionId:'c'.repeat(43),ticketExpiresAt:Date.now()+3600000,leaseExpiresAt:Date.now()+43200000,serverTime:Date.now(),pendingCommit:false};
 let document;
 function assigned(){options.onAssignment?.({assignment,previous:null,reason:'startup',identityChanged:true});options.onAssignmentState?.({status:'ready'});}
 async function navigate(url){
   test.calls.push({index,type:'navigate',url});record.url=url; document?.frame.remove();
   const frame=window.document.createElement('iframe'); frame.title='Opaque UI fixture'; frame.sandbox='allow-scripts';
   frame.src='/browse/frame/doc_'+crypto.randomUUID().replaceAll('-','')+'?fixture='+encodeURIComponent(url);
   frame.style.cssText='width:100%;height:100%;border:0';document={frame};options.container.appendChild(frame);
   options.onLocation?.(url);options.onState?.({status:'loading'});
   await new Promise(resolve=>frame.onload=resolve);options.onState?.({status:'ready'});return document;
 }
 return {get assignment(){return assignment},get document(){return document},pageCommand(command){
 test.calls.push({index,type:'page-command',command});record.diagnostics=command.type==='compatibility-config'?command.diagnostics:record.diagnostics;
 if(command.type==='compatibility-config')options.onTelemetry?.({type:'compatibility-status',origin:new URL(record.url||'https://site.test').origin,rule:'runtime-only-v1',applied:0,risk:false,throttled:false});
 if(command.type==='compatibility-export')options.onTelemetry?.({type:'compatibility-diagnostics',report:{version:1,active:!!record.diagnostics,entries:[{event:'document',at:1,origin:new URL(record.url).origin}]}});return true;
 },async connect(){test.calls.push({index,type:'connect'});assigned();return assignment;},async start(url){assigned();return navigate(url)},navigate,async check(){test.calls.push({index,type:'check'});return assignment},async reconnect(){test.calls.push({index,type:'reconnect'});assigned();return assignment},async selectNode(node,csrf){test.calls.push({index,type:'select',node,csrf});assignment={...assignment,node:{id:node,name:node},generation:assignment.generation+1};assigned();return assignment},dispose(){record.disposed=true;document?.frame.remove()}};
}
`;
const compiled = await build({
  absWorkingDir: resolve("."),
  stdin: {
    contents: entry,
    resolveDir: resolve("."),
    sourcefile: "atlas-ui-proof.tsx",
    loader: "tsx",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "deterministic-runtime-factory-only",
      setup(builder) {
        builder.onResolve(
          { filter: /(?:^|\/)runtime\/frontend-browser\.ts$/ },
          () => ({ path: "factory", namespace: "ui-fixture" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "ui-fixture" }, () => ({
          contents: factory,
          loader: "js",
        }));
      },
    },
  ],
});
let activated = false;
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push({ path: url.pathname, method: request.method });
  if (url.pathname === "/app.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(compiled.outputFiles[0].text);
    return;
  }
  if (url.pathname === "/api/config") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        runtimeOrigin: `http://127.0.0.1:${server.address().port}`,
        nodeRouting: false,
        runtimeProtocols: { opaque: { version: 2, activated } },
      }),
    );
    return;
  }
  if (url.pathname === "/api/admin/nodes") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "local",
          name: "Main server",
          state: "active",
          online: true,
          setupRequired: true,
        },
        { id: "nodeB", name: "Node B", state: "active", online: true },
      ]),
    );
    return;
  }
  if (url.pathname === "/api/catalog") {
    response.setHeader("content-type", "application/json");
    response.end("[]");
    return;
  }
  if (url.pathname === "/api/search/suggestions") {
    response.setHeader("content-type", "application/json");
    response.end("[]");
    return;
  }
  if (url.pathname.startsWith("/browse/frame/doc_")) {
    response.setHeader("content-type", "text/html");
    response.setHeader(
      "content-security-policy",
      "sandbox allow-scripts; default-src 'none'",
    );
    response.end(
      "<!doctype html><h1>UI fixture: " +
        (url.searchParams.get("fixture") || "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;") +
        "</h1>",
    );
    return;
  }
  response.setHeader("content-type", "text/html");
  // Legacy runtime origin has a different Host, and receives no React app.
  if (request.headers.host?.startsWith("127.0.0.1:")) {
    response.end("<!doctype html><p>Legacy fixture runtime</p>");
    return;
  }
  response.end(`<!doctype html><html><head><style>
    [hidden]{display:none!important}.runtime-area,.popout-content{position:relative;height:65vh}button,a,input{margin:3px}
  </style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
});
server.listen(0, "0.0.0.0");
await once(server, "listening");
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext();
await context.addInitScript(() => {
  if (window !== top) return;
  localStorage.setItem("atlas.onboarded", "true");
  localStorage.setItem(
    "atlas.settings",
    JSON.stringify({ motion: false, autocomplete: false }),
  );
});
try {
  const page = await context.newPage();
  await page.goto(base);
  await page
    .getByRole("combobox", { name: "Search the web", exact: true })
    .waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-frontend-runtime="2"]').count(), 0);
  assert.equal(
    await page.evaluate(() => window.__frontendUITest?.created.length || 0),
    0,
  );
  activated = true;
  await page.reload();
  await page.waitForFunction(() =>
    window.__frontendUITest?.calls.some((c) => c.type === "connect"),
  );
  assert.equal(
    await page
      .locator('iframe[title="Atlas isolated browsing runtime"]')
      .count(),
    0,
  );
  await page
    .getByRole("combobox", { name: "Search the web", exact: true })
    .fill("https://site.test/one");
  await page
    .getByRole("combobox", { name: "Search the web", exact: true })
    .press("Enter");
  const frame = page.locator('[data-frontend-runtime="2"] iframe');
  await frame.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-frontend-runtime="2"] iframe')
        ?.contentWindow,
  );
  const firstSource = await frame.getAttribute("src");
  assert.equal(new URL(firstSource, base).origin, base);
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts");
  await page
    .getByRole("combobox", { name: "Address bar", exact: true })
    .fill("https://site.test/two");
  await page
    .getByRole("combobox", { name: "Address bar", exact: true })
    .press("Enter");
  await page.waitForFunction(() =>
    window.__frontendUITest.calls.some(
      (c) => c.url === "https://site.test/two",
    ),
  );
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__frontendUITest.calls.filter(
        (c) => c.url === "https://site.test/one",
      ).length === 2,
  );
  await page
    .getByRole("button", { name: "Connection options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Page options", exact: true })
    .click();
  const optionsPanel = page.getByRole("dialog", {
    name: "Page options",
    exact: true,
  });
  await optionsPanel.waitFor();
  await optionsPanel
    .getByRole("checkbox", {
      name: "Record local diagnostics (5 minutes)",
      exact: true,
    })
    .check();
  const downloaded = page.waitForEvent("download");
  await optionsPanel
    .getByRole("button", { name: "Export local diagnostics", exact: true })
    .click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), "atlas-local-diagnostics.json");
  await optionsPanel
    .getByRole("button", { name: "Close page options", exact: true })
    .click();
  const beforeRetry = await frame.getAttribute("src");
  await page.evaluate(() =>
    window.__frontendUITest.created
      .at(-1)
      .connection({ status: "retrying", code: "SERVER_UNAVAILABLE" }),
  );
  assert.equal(await frame.getAttribute("src"), beforeRetry);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search the web", exact: true })
    .fill("https://other.test/other");
  await page
    .getByRole("combobox", { name: "Search the web", exact: true })
    .press("Enter");
  await page.waitForFunction(() =>
    window.__frontendUITest.calls.some(
      (c) => c.url === "https://other.test/other",
    ),
  );
  assert.equal(
    await page.locator('[data-frontend-runtime="2"] iframe').count(),
    2,
  );
  await page.getByRole("button", { name: "site.test", exact: true }).click();
  assert.equal(
    await page
      .locator(
        '[data-frontend-runtime="2"] [data-frontend-tab]:not([hidden]) iframe',
      )
      .getAttribute("src"),
    beforeRetry,
  );
  const ids = await page.evaluate(() =>
    window.__frontendUITest.created
      .filter((x) => !x.disposed)
      .map((x) => x.tabSessionId),
  );
  assert.equal(new Set(ids).size, ids.length);
  const popoutHref = await page
    .getByRole("link", { name: "Pop out tab", exact: true })
    .getAttribute("href");
  assert.equal(new URL(popoutHref).origin, base);
  assert.equal(new URL(popoutHref).pathname, "/popout");
  assert.equal(popoutHref.includes("ticket="), false);
  const popup = await context.newPage();
  await popup.goto(popoutHref);
  await popup.locator('[data-frontend-runtime="2"] iframe').waitFor();
  const popupIdentity = await popup.evaluate(() =>
    window.__frontendUITest.created.filter((x) => x.initialSession),
  );
  assert.ok(popupIdentity.length >= 1);
  assert.ok(popupIdentity.every((x) => x.initialSession === "a".repeat(43)));
  assert.equal(
    await popup.getByRole("link", { name: "Open direct node tab" }).count(),
    0,
  );
  const popupSource = await popup
    .locator('[data-frontend-runtime="2"] iframe')
    .getAttribute("src");
  assert.equal(new URL(popupSource, base).origin, base);
  const firstId = await popup.evaluate(
    () =>
      window.__frontendUITest.created.findLast((x) => x.initialSession)
        .tabSessionId,
  );
  await popup.reload();
  await popup.locator('[data-frontend-runtime="2"] iframe').waitFor();
  const reloadedId = await popup.evaluate(
    () =>
      window.__frontendUITest.created.findLast((x) => x.initialSession)
        .tabSessionId,
  );
  assert.equal(reloadedId, firstId);
  assert.equal(
    requests.filter((r) => r.path === "/api/browse/session").length,
    0,
  );
  const admin = await context.newPage();
  await admin.goto(base + "/__node-proof");
  await admin
    .getByRole("option", { name: "Main server", exact: true })
    .waitFor({ state: "attached" });
  assert.equal(
    await admin
      .getByRole("option", { name: "Main server", exact: true })
      .isDisabled(),
    false,
  );
  await admin
    .getByRole("combobox", { name: "Assign this browser to", exact: true })
    .selectOption("local");
  await admin
    .getByRole("button", { name: "Apply to this browser", exact: true })
    .click();
  await admin.waitForFunction(() => window.__nodeSelectionResult);
  assert.deepEqual(await admin.evaluate(() => window.__nodeSelectionCalls), [
    { node: "local", csrf: "fixture-csrf" },
  ]);
  assert.equal(
    await admin.evaluate(() => window.__nodeSelectionResult.persisted),
    true,
  );
  assert.equal(
    requests.filter((r) => r.path === "/api/admin/nodes/select").length,
    0,
  );
  console.log(
    JSON.stringify({
      qualification:
        "React UI composition with deterministic runtime factory; not upstream/runtime acceptance",
      inactiveDefault: "legacy unchanged",
      activatedFrameOrigin: base,
      popoutFrameOrigin: base,
      popupSessionExact: true,
      explicitTabIdentityReloadStable: true,
      legacyLeaseRequestsInV2: 0,
      trustedBackNavigation: true,
    }),
  );
} finally {
  await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
