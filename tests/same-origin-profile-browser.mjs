/** Actual built same-origin document/profile/owner integration.
 * Upstream website HTTP and cloud acknowledgments are deterministic mocks;
 * native browser stores, original-document ports and receipt sockets are real.
 * This is not an actual Hub sign-in or public-site compatibility qualification.
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
const directory = await fs.mkdtemp(join(tmpdir(), "atlas-same-origin-profile-"));
const evidence = resolve("evidence/same-origin-profile-20261021");
const accountA = "11111111-1111-4111-8111-111111111111";
const accountB = "22222222-2222-4222-8222-222222222222";
const openssl = (args, input) => {
  const result = spawnSync("openssl", args, { input });
  if (result.status) throw Error(String(result.stderr));
  return result.stdout;
};
openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key"),
  "-out", join(directory, "cert"), "-days", "1", "-subj", "/CN=front.test", "-addext", "subjectAltName=DNS:front.test"]);
const key = await fs.readFile(join(directory, "key")), cert = await fs.readFile(join(directory, "cert"));
const spki = openssl(["dgst", "-sha256", "-binary"], openssl(["pkey", "-pubin", "-outform", "der"],
  openssl(["x509", "-pubkey", "-noout"], cert))).toString("base64");
let app, runtime, browser;
const sockets = new Set();
const edge = https.createServer({ key, cert }, (request, reply) => {
  const upstream = http.request({ hostname: "127.0.0.1", port: app.server.address().port,
    path: request.url, method: request.method, headers: request.headers }, (response) => {
    reply.writeHead(response.statusCode, response.headers); response.pipe(reply);
  });
  upstream.on("error", () => { reply.writeHead(502); reply.end(); });
  request.pipe(upstream);
});
edge.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => edge.listen(0, "127.0.0.1", resolve));
const frontend = "https://front.test:" + edge.address().port;
try {
  const assetDir = join(directory, "assets");
  await buildOpaqueRuntime({ outdir: assetDir });
  const bundle = await build({ bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    stdin: { resolveDir: resolve("runtime"), contents: `
export {createFrontendBrowser} from './frontend-browser.ts';
export {createSandboxRelayFetch} from './sandbox-relay.ts';
export {setActiveProfile,setActiveProfileContext,setProfileDocumentGuard} from './profile-context.ts';
export {setProfilePermit} from './profile-permissions.ts';
export {nativeProfileQueue,drainProfileQueue} from './profile-sync.ts';
export {exportProfileSnapshots,restoreProfileStream} from './profile-store.ts';
export {hubNamespace,hubSiteGroup,encodePortableValue,decodePortableValue} from './hub-contracts.ts';` } });
  app = await createApp({ dataDir: join(directory, "data"), staticDir: "/not-built", appOrigin: frontend,
    runtimeOrigin: "https://runtime.invalid", dynamicOrigins: false, localRelayMode: "frontend",
    profileRuntimeEnabled: true, profileRuntimeActivated: true, profileAssetsDir: assetDir,
    opaqueRuntimeEnabled: false, opaqueRuntimeActivated: false });
  app.get("/", (_request, reply) => reply.type("text/html").send("<!doctype html><title>Profile native proof</title><main data-trusted-profile-fixture=1></main>"));
  app.get("/fixture.js", (_request, reply) => reply.type("application/javascript").send(bundle.outputFiles[0].contents));
  app.get("/favicon.ico", (_request, reply) => reply.code(204).send());
  await app.listen({ host: "127.0.0.1", port: 0 });
  runtime = await createRuntime({ appOrigin: frontend, runtimeOrigin: "https://runtime.invalid", authorize: (...args) => app.nodePool.resolve(...args) });
  await runtime.listen({ host: "127.0.0.1", port: 0 });
  app.nodePool.setLocalConnections(() => runtime.connectionCount());
  edge.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url, frontend).pathname;
    (path.startsWith("/relay/") || path.startsWith("/wisp/") ? runtime : app).server.emit("upgrade", request, socket, head);
  });
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-proxy-server", "--host-resolver-rules=MAP front.test 127.0.0.1", "--ignore-certificate-errors-spki-list=" + spki] });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(frontend);
  const boot = async ({ profileId, writeValue = null, restored = null }) => {
    const api = window.profileFixtureAPI ||= await import("/fixture.js");
    window.profileFrontend?.dispose();
    api.setActiveProfile(profileId);
    const contextId = "same-origin-profile-fixture:" + profileId;
    api.setActiveProfileContext(contextId);
    api.setProfileDocumentGuard(async (origin) => {
      await api.setProfilePermit(indexedDB, { profileId, group: api.hubSiteGroup(origin), contextId,
        epoch: 1, expiresAt: Date.now() + 180000, offline: false, revoked: false });
    });
    if (restored) {
      for (const item of await api.decodePortableValue(restored.snapshots)) {
        await api.restoreProfileStream(indexedDB, profileId, item.namespace, item.payload, [], {
          revision: restored.revisions[api.hubNamespace(item.namespace).key] || 0, epoch: 1,
        });
      }
    }
    const html = `<!doctype html><html><head><title>Profile fixture site</title></head><body><script>
window.firstInlineProfileSave={local:localStorage.getItem('profile-save'),cookie:document.cookie};
(async()=>{try{
 const opened=indexedDB.open('profile-save-db',1);
 opened.onupgradeneeded=()=>opened.result.createObjectStore('saves');
 const db=await new Promise((r,j)=>{opened.onsuccess=()=>r(opened.result);opened.onerror=()=>j(opened.error)});
 const read=db.transaction('saves'),request=read.objectStore('saves').get('save');
 const before=await new Promise((r,j)=>{read.oncomplete=()=>r(request.result??null);read.onabort=()=>j(read.error)});
 const value=${JSON.stringify(writeValue)};
 if(value!==null){
   localStorage.setItem('profile-save',value);
   document.cookie='profile_save='+value+'; Secure; Path=/; SameSite=Lax';
   const transaction=db.transaction('saves','readwrite');transaction.objectStore('saves').put(value,'save');
   await new Promise((r,j)=>{transaction.oncomplete=r;transaction.onabort=()=>j(transaction.error)});
 }
 db.close();
 const networkCookie=await fetch('https://site.example/echo',{credentials:'include'}).then(r=>r.text());
 window.profileSaveResult={first:window.firstInlineProfileSave,idbBefore:before,after:localStorage.getItem('profile-save'),cookie:document.cookie,networkCookie};
}catch(error){window.profileSaveFailure={name:error.name,message:error.message,stack:error.stack}}})();
</script></body></html>`;
    window.profileCalls = [];
    const transport = async (request) => {
      const cookie = request.headers.find(([name]) => name.toLowerCase() === "cookie")?.[1] || "";
      window.profileCalls.push({ url: request.url, cookie });
      const isPage = request.url === "https://site.example/page";
      if (!isPage && request.url !== "https://site.example/echo") throw Error("Fixture upstream path denied");
      const headers = [["content-type", isPage ? "text/html;charset=utf-8" : "text/plain"]];
      if (isPage && writeValue !== null) headers.push(["set-cookie", "http_only_save=" + writeValue + "; Secure; HttpOnly; Path=/; SameSite=Lax"]);
      const bytes = new TextEncoder().encode(isPage ? html : cookie);
      return { url: request.url, status: 200, statusText: "OK", headers, body: bytes.buffer };
    };
    window.profileStates = [];
    window.profileFrontend = await api.createFrontendBrowser({ container: document.querySelector("main"), timeoutMs: 30000,
      onState: (state) => profileStates.push(state),
      components: { fetch: (fixed) => api.createSandboxRelayFetch({ ...fixed,
        relay: { assignment: fixed.relay.assignment, request: transport } }) },
    });
    await profileFrontend.start("https://site.example/page");
  };
  const resultFor = async (target, input) => {
    await target.evaluate(boot, input);
    const frame = target.frames().find((frame) => frame.url().startsWith(frontend + "/browse/frame/"));
    assert.ok(frame);
    try { await frame.waitForFunction(() => window.profileSaveResult || window.profileSaveFailure, null, { timeout: 20000 }); }
    catch (error) { console.error(JSON.stringify({ errors, states: await target.evaluate(() => profileStates), body: await frame.evaluate(() => document.documentElement.outerHTML.slice(0, 800)) })); throw error; }
    const result = await frame.evaluate(() => window.profileSaveResult || { failure: window.profileSaveFailure });
    assert.equal(result.failure, undefined, JSON.stringify(result));
    return { frame, result };
  };
  const first = await resultFor(page, { profileId: accountA, writeValue: "A1" });
  assert.deepEqual(first.result.first, { local: null, cookie: "" });
  assert.equal(first.result.idbBefore, null);
  assert.equal(first.result.after, "A1");
  assert.match(first.result.cookie, /profile_save=A1/);
  assert.doesNotMatch(first.result.cookie, /http_only_save/);
  assert.match(first.result.networkCookie, /http_only_save=A1/);
  await page.reload();
  const reloaded = await resultFor(page, { profileId: accountA });
  assert.equal(reloaded.result.first.local, "A1");
  assert.match(reloaded.result.first.cookie, /profile_save=A1/);
  assert.equal(reloaded.result.idbBefore, "A1");
  const other = await resultFor(page, { profileId: accountB, writeValue: "B1" });
  assert.deepEqual(other.result.first, { local: null, cookie: "" });
  assert.equal(other.result.idbBefore, null);
  assert.match(other.result.networkCookie, /http_only_save=B1/);
  assert.doesNotMatch(other.result.networkCookie, /A1/);
  const returned = await resultFor(page, { profileId: accountA });
  assert.equal(returned.result.first.local, "A1");
  assert.equal(returned.result.idbBefore, "A1");
  assert.match(returned.result.networkCookie, /http_only_save=A1/);
  assert.doesNotMatch(returned.result.networkCookie, /B1/);
  const cloud = await page.evaluate(async ({ accountA, accountB }) => {
    profileFrontend.dispose();
    const api = profileFixtureAPI, queue = api.nativeProfileQueue(indexedDB, accountA);
    const before = await queue.list(), otherBefore = (await api.nativeProfileQueue(indexedDB, accountB).list()).length;
    const revisions = {}, mockCloud = {
      stream: async (n) => ({ revision: revisions[api.hubNamespace(n).key] || 0 }),
      writer: async () => ({ epoch: 1, expiresAt: new Date(Date.now() + 180000).toISOString() }),
      commit: async () => ({ acknowledged: false, revision: 1 }),
    };
    let rejected = "";
    try { await api.drainProfileQueue(queue, mockCloud); } catch (error) { rejected = error.message; }
    const afterRejected = (await queue.list()).length;
    mockCloud.commit = async (input) => {
      const key = api.hubNamespace(input.namespace).key, revision = revisions[key] || 0;
      if (revision !== input.baseRevision) throw Error("MOCK_CLOUD_BASE_REVISION_MISMATCH");
      revisions[key] = revision + 1;
      return { acknowledged: true, revision: revision + 1 };
    };
    const acknowledged = await api.drainProfileQueue(queue, mockCloud);
    return {
      pendingBefore: before.length, kinds: [...new Set(before.map((c) => c.entry.kind))].sort(), rejected, afterRejected,
      acknowledged, pendingAfter: (await queue.list()).length, otherBefore,
      otherAfter: (await api.nativeProfileQueue(indexedDB, accountB).list()).length,
      snapshots: await api.encodePortableValue(await api.exportProfileSnapshots(indexedDB, accountA)), revisions,
    };
  }, { accountA, accountB });
  assert.deepEqual(cloud.kinds, ["cookies", "idb", "local"]);
  assert.ok(cloud.pendingBefore >= 3);
  assert.equal(cloud.rejected, "PROFILE_ACK_INVALID");
  assert.equal(cloud.afterRejected, cloud.pendingBefore);
  assert.equal(cloud.acknowledged, cloud.pendingBefore);
  assert.equal(cloud.pendingAfter, 0);
  assert.ok(cloud.otherBefore > 0);
  assert.equal(cloud.otherAfter, cloud.otherBefore);
  const freshContext = await browser.newContext(), fresh = await freshContext.newPage();
  await fresh.goto(frontend);
  const restored = await resultFor(fresh, { profileId: accountA, restored: { snapshots: cloud.snapshots, revisions: cloud.revisions } });
  assert.equal(restored.result.first.local, "A1");
  assert.match(restored.result.first.cookie, /profile_save=A1/);
  assert.equal(restored.result.idbBefore, "A1");
  assert.match(restored.result.networkCookie, /http_only_save=A1/);
  assert.doesNotMatch(restored.result.cookie, /http_only_save/);
  const freshPending = await fresh.evaluate(async (id) => (await profileFixtureAPI.nativeProfileQueue(indexedDB, id).list()).length, accountA);
  assert.equal(freshPending, 0);
  const receipt = { result: "PASS", runtime: "same-origin-profile", realBuiltDocumentAndOwnerPorts: true,
    nativeStores: ["localStorage", "IndexedDB", "document.cookie", "HttpOnly HTTP cookies"],
    reloadFirstInlineRestored: true, accountSwitch: "A1 -> B1 -> A1", accountIsolation: true,
    nativeJournalKinds: cloud.kinds, rejectedMockAcknowledgmentRetained: cloud.afterRejected,
    positiveMockAcknowledgments: cloud.acknowledged, pendingAfterAcknowledgment: cloud.pendingAfter,
    otherAccountPendingUntouched: cloud.otherAfter,
    freshBrowserSnapshotFirstInlineRestored: true, freshBrowserPending: freshPending,
    websiteHTTP: "deterministic upstream transport mock; profile cookie authority remains real",
    cloud: "in-memory acknowledgment mock; no actual Hub sign-in or cross-host cloud handoff claimed", errors };
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(join(evidence, "PROFILE-BROWSER.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
  await fresh.evaluate(() => profileFrontend.dispose());
  await freshContext.close();
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => edge.close(resolve));
  await runtime?.close();
  await app?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
