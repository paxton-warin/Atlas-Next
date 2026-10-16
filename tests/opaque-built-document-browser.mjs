/** Actual built self-boot assets + real frontend session/owner APIs. This is a
 * synthetic logical website, not public Cookie Clicker/Discord qualification.
 * Node selection changes real coordinator assignments; website transport here
 * is a deterministic fixed-document callback, not a claimed fleet deployment.
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { buildOpaqueRuntime } from "../scripts/build-opaque-runtime.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const directory = await fs.mkdtemp(join(tmpdir(), "atlas-built-document-"));
const assetDir = join(directory, "assets");
const manifest = await buildOpaqueRuntime({ outdir: assetDir });
const frontendModule = await build({
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  stdin: {
    resolveDir: resolve("runtime"),
    contents: `export {createOpaqueWebsiteDocument} from './sandbox-controller.ts';
  export {createSandboxStorageOwner} from './sandbox-storage-owner.ts';
  export {createSandboxCookieOwner} from './sandbox-cookie-owner.ts';`,
  },
});
const app = await createApp({
  dataDir: join(directory, "data"),
  staticDir: "/not-built",
  appOrigin: "http://127.0.0.1:0",
  runtimeOrigin: "https://runtime.invalid",
  localRelayMode: "frontend",
  opaqueRuntimeEnabled: true,
  opaqueAssetsDir: assetDir,
});
app.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send(
      "<!doctype html><title>Trusted built-runtime qualification</title><main></main>",
    ),
);
app.get("/qualification.js", (_req, reply) =>
  reply
    .type("application/javascript")
    .send(frontendModule.outputFiles[0].contents),
);
app.get("/favicon.ico", (_req, reply) => reply.code(204).send());
await app.listen({ host: "127.0.0.1", port: 0 });
const origin = "http://127.0.0.1:" + app.server.address().port;
let node, browser;
const errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(origin);
  const first = await page.evaluate(async () => {
    const prepared = await fetch("/api/browse/controller/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!prepared.ok) throw Error("controller bootstrap failed");
    const { requestId } = await prepared.json();
    const response = await fetch("/api/browse/controller/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "new", requestId }),
    });
    const lease = await response.json();
    window.lease = lease;
    localStorage.setItem("qualification.lease", JSON.stringify(lease));
    window.runtimeAssets = await (
      await fetch("/api/browse/controller/runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    return {
      status: response.status,
      node: lease.node?.id,
      frontend: lease.frontendOrigin,
    };
  });
  assert.deepEqual(first, { status: 200, node: "local", frontend: origin });
  const website = "https://save.example/game";
  const html = (
    write,
  ) => `<!doctype html><html><head><title>Logical site</title></head><body><div id="ready">waiting</div><script>
  (async()=>{const previous=localStorage.getItem('CookieClickerGame');
  ${write ? "localStorage.setItem('CookieClickerGame','built-runtime-committed-save');document.cookie='manual=committed; Path=/; Max-Age=600';" : ""}
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('built-document-save',1);req.onupgradeneeded=()=>req.result.createObjectStore('items');req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result)});
  ${write ? "const writeTx=db.transaction('items','readwrite');writeTx.objectStore('items').put(new Blob(['native-backed blob']),'record');await writeTx.done;" : ""}
  const socket=new WebSocket('wss://save.example/socket',['first','second']);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});const echo=new Promise(resolve=>socket.onmessage=e=>resolve(e.data));socket.send('built-private-port-echo');const socketEcho=await echo;socket.close();
  const tx=db.transaction('items'),req=tx.objectStore('items').get('record');const value=await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});await tx.done;db.close();
  let parentDenied=false;try{parentDenied=parent.document===document}catch{parentDenied=true}
  window.builtResult={previous,save:localStorage.getItem('CookieClickerGame'),cookie:document.cookie,blob:await value.text(),socketEcho,parentDenied,logical:location.origin};document.getElementById('ready').textContent='rendered';})();
  </script></body></html>`;
  async function open(write) {
    await page.evaluate(
      async ({ website, html }) => {
        window.currentBinding?.dispose();
        window.storageOwner?.dispose();
        window.cookieOwner?.dispose();
        const {
          createOpaqueWebsiteDocument,
          createSandboxStorageOwner,
          createSandboxCookieOwner,
        } = await import("/qualification.js");
        const registrationHeaders = () => ({
          "x-atlas-browse-session": window.lease.session,
          "x-atlas-browse-generation": String(window.lease.generation),
        });
        window.storageOwner = await createSandboxStorageOwner({
          workerURL: window.runtimeAssets.workers.storage,
          registrationHeaders,
        });
        window.cookieOwner = await createSandboxCookieOwner({
          workerURL: window.runtimeAssets.workers.cookies,
          browserSessionId: window.lease.browserSessionId,
          registrationHeaders,
        });
        window.contentStates = [];
        window.currentBinding = createOpaqueWebsiteDocument({
          website,
          container: document.querySelector("main"),
          factory: indexedDB,
          storageProvider: window.storageOwner,
          cookieProvider: window.cookieOwner,
          sessionId: "built_document_browsing_tab_0123456",
          selfBootContent: true,
          webSocketConnect: (url, protocols, context, events) => {
            if (
              url !== "wss://save.example/socket" ||
              context.origin !== "https://save.example"
            )
              throw Error("fixed WebSocket document denied");
            queueMicrotask(() => events.open(protocols[1], ""));
            return {
              send(data) {
                events.message(data);
              },
              close(code = 1000, reason = "") {
                events.close(code, reason, true);
              },
            };
          },
          onContentState: (state) => window.contentStates.push(state),
          fetch: async (request, context) => {
            if (
              request.url !== website ||
              context.origin !== "https://save.example"
            )
              throw Error("fixed-document transport denied");
            return {
              url: request.url,
              status: 200,
              statusText: "OK",
              headers: [["content-type", "text/html;charset=utf-8"]],
              body: new TextEncoder().encode(html).buffer,
            };
          },
        });
        await window.currentBinding.ready;
      },
      { website, html: html(write) },
    );
    await page.waitForFunction(
      () =>
        window.contentStates.includes("ready") ||
        window.contentStates.includes("error"),
      { timeout: 20000 },
    );
    const frame = page.frames().find((f) => f.url().includes("/browse/frame/"));
    assert.ok(frame, "frontend frame remains attached");
    assert.ok(frame.url().startsWith(origin + "/browse/frame/"));
    try {
      await frame.waitForFunction(() => window.builtResult, null, {
        timeout: 20000,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          stage: "built-site-script",
          errors,
          frame: await frame.evaluate(() => ({
            state: document.readyState,
            body: document.body?.innerText,
            scripts: [...document.scripts].map((s) => ({
              type: s.type,
              src: s.getAttribute("src"),
            })),
          })),
        }),
      );
      throw error;
    }
    const result = await frame.evaluate(() => window.builtResult);
    assert.equal(await page.evaluate(() => window.currentBinding.live), true);
    assert.deepEqual(await page.evaluate(() => window.contentStates), [
      "ready",
    ]);
    return result;
  }
  const written = await open(true);
  assert.equal(written.previous, null);
  assert.equal(written.save, "built-runtime-committed-save");
  assert.equal(written.blob, "native-backed blob");
  assert.equal(written.socketEcho, "built-private-port-echo");
  assert.equal(written.parentDenied, true);
  assert.equal(written.logical, "https://save.example");
  assert.equal(written.cookie, "manual=committed");
  const reloaded = await open(false);
  assert.equal(reloaded.previous, written.save);
  assert.equal(reloaded.cookie, written.cookie);
  await page.reload();
  await page.evaluate(async () => {
    const saved = JSON.parse(localStorage.getItem("qualification.lease"));
    const response = await fetch("/api/browse/controller/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "restore",
        session: saved.session,
        generation: saved.generation,
      }),
    });
    if (!response.ok) throw Error("restored controller assignment failed");
    window.lease = await response.json();
    window.runtimeAssets = await (
      await fetch("/api/browse/controller/runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
  });
  const browserReloaded = await open(false);
  assert.equal(browserReloaded.previous, written.save);
  assert.equal(browserReloaded.cookie, written.cookie);
  node = await createNodeService({
    pairing: { verify: () => true, save: () => {} },
  });
  await node.listen({ host: "127.0.0.1", port: 0 });
  const selected = await app.nodePool.attach(
    {
      endpoint: "http://127.0.0.1:" + node.server.address().port,
      name: "Replacement",
      code: "fixture",
    },
    origin,
  );
  const old = await page.evaluate(() => window.lease);
  const candidate = await app.nodePool.frontendAssignments.select(
    old.session,
    origin,
    selected.id,
  );
  assert.ok(
    app.store.db
      .prepare("SELECT 1 FROM browse_leases WHERE hash=?")
      .get(old.sessionHash),
  );
  await page.evaluate(() => {
    window.currentBinding.dispose();
    window.storageOwner.dispose();
    window.cookieOwner.dispose();
  });
  const committed = await page.evaluate(
    async ({ candidate, previousSession }) => {
      const response = await fetch("/api/browse/controller/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previousSession,
          session: candidate.session,
          generation: candidate.generation,
        }),
      });
      window.lease = await response.json();
      return { status: response.status, node: window.lease.node?.id };
    },
    { candidate, previousSession: old.session },
  );
  assert.deepEqual(committed, { status: 200, node: selected.id });
  assert.equal((await open(false)).save, written.save);
  const direct = await browser.newPage();
  const response = await direct.goto(
    origin + "/browse/frame/direct_document_0123456789",
  );
  assert.match(
    response.headers()["content-security-policy"],
    /^sandbox allow-scripts;/,
  );
  assert.doesNotMatch(
    response.headers()["content-security-policy"],
    /allow-same-origin/,
  );
  const directState = await direct.evaluate(() => {
    let storageDenied = false;
    try {
      void localStorage;
    } catch {
      storageDenied = true;
    }
    return { origin: window.origin, storageDenied };
  });
  assert.deepEqual(directState, { origin: "null", storageDenied: true });
  await direct.close();
  assert.deepEqual(
    errors.filter((e) => !e.includes("favicon.ico")),
    [],
  );
  const receipt = {
    result: "built_self_boot_and_authenticated_frontend_storage_verified",
    assetCount: Object.keys(manifest.files).length,
    sourceCoreHash: manifest.coreSourceSHA256,
    frontendFrame: true,
    saveReload: true,
    browserReload: true,
    coordinatorNodeChange: true,
    privateWebSocketPort: true,
    idbBlob: true,
    cookies: true,
    directVisitOpaque: true,
    scope:
      "synthetic website and callback transport; not public-site or fleet acceptance",
  };
  await fs.writeFile(
    "evidence/frontend-controller-20261016/BUILT-DOCUMENT.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await node?.close();
  await app.close();
  await fs.rm(directory, { recursive: true, force: true });
}
