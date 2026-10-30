import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import WebSocket from "ws";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { opaqueRuntimeSettings } from "../server/runtime-activation.mjs";
import { createApp } from "../server/app.mjs";
import { installHubBranch, validateHubBranchConfig } from "../server/hub-branch.mjs";
import { installSandboxStorageRendezvous } from "../server/sandbox-storage-rendezvous.mjs";
import { installSandboxCookieRendezvous } from "../server/sandbox-cookie-rendezvous.mjs";
import { OPAQUE_CORE_SOURCE_SHA256, OPAQUE_HTTPENGINE_SOURCE_SHA256 } from "../server/runtime-capabilities.mjs";

const origin = "https://frontend.example";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mode = (cwd = "/release") => opaqueRuntimeSettings({
  ATLAS_BROWSER_RUNTIME: "same-origin-profile",
  LOCAL_RELAY_MODE: "frontend",
}, cwd);
const hubConfig = () => ({
  appOrigin: origin,
  hubOrigin: "https://hub.example",
  hubBranchId: randomUUID(),
  hubBranchSecret: "s".repeat(43),
});
async function fixtureAssets(directory) {
  await mkdir(directory, { recursive: true });
  const files = {}, names = {};
  for (const kind of ["document", "dedicated", "storage", "cookies", "relay", "httpengine", "rewriter"]) {
    const bytes = Buffer.from("// profile server fixture: " + kind + "\n"), hash = sha(bytes);
    const name = kind + "-" + hash.slice(0, 16) + ".js";
    names[kind] = name;
    files[name] = { sha256: hash };
    await writeFile(join(directory, name), bytes);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    version: 2, activated: false,
    coreSourceSHA256: OPAQUE_CORE_SOURCE_SHA256,
    engineSourceSHA256: OPAQUE_HTTPENGINE_SOURCE_SHA256,
    adaptedCoreSHA256: "a".repeat(64),
    adaptedEngineSHA256: files[names.httpengine].sha256,
    bootstrap: names.document, dedicatedWorker: names.dedicated,
    engine: names.httpengine, trustedRewriter: names.rewriter,
    workers: { storage: names.storage, cookies: names.cookies, relay: names.relay }, files,
  }));
}

test("same-origin-profile selects the normal controller host while opaque activation stays off", () => {
  const settings = mode();
  assert.equal(settings.profileRuntimeEnabled, true);
  assert.equal(settings.profileRuntimeActivated, true);
  assert.equal(settings.profileAssetsDir, "/release/dist/opaque-runtime");
  assert.equal(settings.sameOriginRuntime, true);
  assert.equal(settings.profileRuntimeEngine, "scramjet-controller");
  assert.equal(settings.runtimePath, "/browse/runtime/");
  assert.equal(settings.opaqueRuntimeEnabled, false);
  assert.equal(settings.opaqueRuntimeActivated, false);
  assert.throws(() => opaqueRuntimeSettings({ ATLAS_BROWSER_RUNTIME: "same-origin-profile" }), /frontend/);
  assert.deepEqual(opaqueRuntimeSettings({}), {
    opaqueRuntimeEnabled: false, opaqueRuntimeActivated: false, opaqueAssetsDir: null,
  });
});

test("Hub accepts explicit profile composition but still rejects plain same-origin and partial activation", () => {
  assert.equal(validateHubBranchConfig({ ...hubConfig(), ...mode() }), true);
  for (const patch of [
    { profileRuntimeActivated: false }, { profileRuntimeEnabled: false },
    { sameOriginRuntime: false }, { profileRuntimeEngine: undefined },
    { profileRuntimeEngine: "unknown" }, { opaqueRuntimeActivated: true },
  ]) assert.throws(() => validateHubBranchConfig({ ...hubConfig(), ...mode(), ...patch }));
  assert.throws(() => validateHubBranchConfig({ ...hubConfig(), sameOriginRuntime: true }));
  assert.equal(validateHubBranchConfig({ ...hubConfig(), opaqueRuntimeActivated: true }), true);
});

test("profile activation rejects partial physical/runtime combinations before opening a database", async () => {
  for (const patch of [
    { profileRuntimeEnabled: false }, { profileAssetsDir: null },
    { localRelayMode: "isolated" }, { appOrigin: "http://frontend.example" },
    { sameOriginRuntime: false }, { profileRuntimeEngine: undefined },
    { profileRuntimeEngine: "unknown" }, { opaqueRuntimeEnabled: true },
    { opaqueRuntimeActivated: true },
  ]) await assert.rejects(createApp({
    ...mode(), dataDir: "/never-created-same-origin-profile-test",
    appOrigin: origin, runtimeOrigin: "https://runtime.invalid", localRelayMode: "frontend", ...patch,
  }), /Same-origin profile activation requires/);
});

test("normal profile composition retains owner assets but replaces selfboot frames with the controller root worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-profile-server-"));
  await fixtureAssets(join(directory, "assets"));
  const app = await createApp({
    ...mode(), dataDir: join(directory, "data"), staticDir: "/not-built",
    appOrigin: origin, runtimeOrigin: "https://runtime.invalid", dynamicOrigins: false,
    localRelayMode: "frontend", profileAssetsDir: join(directory, "assets"), runtimeAssetsDir: resolve("dist/runtime"),
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const configResponse = await app.inject("/api/config");
  const config = configResponse.json();
  assert.equal(configResponse.headers["permissions-policy"], undefined);
  assert.equal(configResponse.headers["x-frame-options"], "DENY");
  assert.match(configResponse.headers["content-security-policy"], /default-src 'self'/);
  assert.deepEqual(config.runtimeProtocols.profile, { version: 2, activated: true, documentOrigin: "same-origin",
    engine: "scramjet-controller", runtimePath: "/browse/runtime/" });
  assert.equal(config.runtimeProtocols.opaque.activated, false);
  assert.equal(config.runtimeProtocols.sameOrigin.activated, true);
  const result = await app.inject({ method: "POST", url: "/api/browse/controller/runtime", headers: { origin }, payload: {} });
  assert.equal(result.statusCode, 200);
  const manifest = result.json();
  assert.equal(manifest.version, 2);
  assert.equal(manifest.documentOrigin, "same-origin");
  assert.equal(manifest.engine, "scramjet-controller");
  assert.equal(manifest.runtimePath, "/browse/runtime/");
  for (const asset of [manifest.bootstrap, manifest.trustedRewriter, ...Object.values(manifest.workers)])
    assert.equal((await app.inject(asset)).statusCode, 200);
  const frame = await app.inject("/browse/frame/profile_document_0123456789");
  assert.equal(frame.statusCode, 404);
  assert.equal((await app.inject("/browse/popup/profile_document_0123456789")).statusCode, 404);
  const worker = await app.inject("/worker.js");
  assert.equal(worker.statusCode, 200);
  assert.equal(worker.headers["service-worker-allowed"], "/");
  assert.equal(worker.headers["content-security-policy"], undefined);
  assert.equal((await app.inject("/browse/runtime/")).statusCode, 200);
  for (const path of ["/browse/runtime/", "/worker.js", "/runtime/runtimekit.js", "/controller/controller.api.js", "/clients/httpengine-client.js", "/~/app/uncontrolled"]) {
    const response = await app.inject(path);
    for (const header of ["x-frame-options", "content-security-policy", "cross-origin-opener-policy", "cross-origin-embedder-policy", "permissions-policy"])
      assert.equal(response.headers[header], undefined, path + ": " + header);
  }
  const bootstrap = await app.inject({ method: "POST", url: "/api/browse/controller/bootstrap", headers: { origin }, payload: {} });
  assert.equal(bootstrap.statusCode, 200);
  const assignment = await app.inject({ method: "POST", url: "/api/browse/controller/session", headers: {
    origin, cookie: bootstrap.headers["set-cookie"].split(";")[0],
  }, payload: { intent: "new", requestId: bootstrap.json().requestId } });
  assert.equal(assignment.statusCode, 200);
  for (const kind of ["storage", "cookies"]) {
    const owner = await app.inject({ method: "POST", url: `/api/browse/${kind}/owners`, headers: {
      origin, "x-atlas-browse-session": assignment.json().session,
      "x-atlas-browse-generation": String(assignment.json().generation),
    }, payload: {} });
    assert.equal(owner.statusCode, 200, owner.body);
  }
  const requestTicket = (payload, headers = {}) => app.inject({ method: "POST", url: "/api/browse/controller/runtime-ticket",
    headers: { origin, ...headers }, payload });
  const lease = assignment.json(), body = { session: lease.session, generation: lease.generation };
  const grant = await requestTicket(body);
  assert.equal(grant.statusCode, 200, grant.body);
  assert.equal(grant.json().runtimePath, "/browse/runtime/");
  const runtimeTicket = grant.json().runtimeTicket;
  const runtime = await app.inject({ url: "/runtime-config", headers: { authorization: "Bearer " + runtimeTicket } });
  assert.equal(runtime.statusCode, 200, runtime.body);
  assert.equal(runtime.json().engine, "scramjet-controller");
  assert.equal(runtime.json().profileRuntime, true);
  assert.equal(runtime.json().runtimeOrigin, origin);
  assert.equal(runtime.json().generation, lease.generation);
  assert.equal(app.nodePool.resolve(runtime.json().relayTicket, origin, "relay", { relayOrigin: origin }).node.id, lease.node.id);
  assert.throws(() => app.nodePool.resolve(runtimeTicket, origin, "relay", { relayOrigin: origin }), (error) => error.code === "INVALID_TICKET");
  assert.equal((await app.inject({ url: "/runtime-config", headers: { authorization: "Bearer " + lease.ticket } })).statusCode, 401);
  for (const bad of ["null", "https://foreign.example", ""])
    assert.equal((await requestTicket(body, { origin: bad })).statusCode, 403);
  for (const bad of [{}, { ...body, generation: 0 }, { ...body, generation: "1" }, { ...body, website: "https://site.example" }])
    assert.equal((await requestTicket(bad)).statusCode, 400);
  assert.equal((await requestTicket({ ...body, session: "a".repeat(43) })).statusCode, 401);
  assert.equal((await requestTicket({ ...body, generation: lease.generation + 1 })).statusCode, 401);
  const legacy = await app.nodePool.operate({}, origin, "https://runtime.invalid");
  assert.equal((await requestTicket({ session: legacy.session, generation: legacy.generation })).statusCode, 401);
  app.nodePool.setRequireHubOwnership(true);
  assert.equal((await requestTicket(body)).statusCode, 401);
  assert.equal((await app.inject({ url: "/runtime-config", headers: { authorization: "Bearer " + runtimeTicket } })).statusCode, 410);
  const hubGrant = { userId: randomUUID(), profileId: randomUUID(), branchId: randomUUID(), sessionId: randomUUID(), contextId: randomUUID() };
  app.nodePool.bindHubLease(lease.sessionHash, hubGrant);
  assert.equal((await requestTicket(body)).statusCode, 200);
  app.nodePool.revokeHubSession(hubGrant.sessionId);
  assert.equal((await requestTicket(body)).statusCode, 401);
  assert.equal((await app.inject({ url: "/runtime-config", headers: { authorization: "Bearer " + runtimeTicket } })).statusCode, 410);
  app.nodePool.setRequireHubOwnership(false);
  app.nodePool.release(lease.session, origin);
  assert.ok([409, 410].includes((await app.inject({ url: "/runtime-config", headers: { authorization: "Bearer " + runtimeTicket } })).statusCode));
  assert.equal((await requestTicket(body)).statusCode, 401);
});

test("held, opaque and plain same-origin modes retain their existing Atlas permissions and frame headers", async (t) => {
  for (const selected of ["held", "opaque", "same-origin"]) {
    const directory = await mkdtemp(join(tmpdir(), "atlas-profile-header-regression-"));
    const app = await createApp({ dataDir: directory, staticDir: "/not-built", appOrigin: origin,
      runtimeOrigin: "https://runtime.invalid", dynamicOrigins: false, localRelayMode: "frontend",
      opaqueRuntimeEnabled: selected === "opaque", opaqueRuntimeActivated: false,
      sameOriginRuntime: selected === "same-origin", runtimeAssetsDir: resolve("dist/runtime") });
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const config = await app.inject("/api/config");
    assert.match(config.headers["permissions-policy"], /geolocation=\(\)/, selected);
    assert.equal(config.headers["x-frame-options"], "DENY", selected);
    assert.match(config.headers["content-security-policy"], /default-src 'self'/, selected);
    if (selected === "same-origin") {
      const runtime = await app.inject("/browse/runtime/");
      assert.equal(runtime.headers["x-frame-options"], "SAMEORIGIN");
      assert.match(runtime.headers["permissions-policy"], /geolocation=\(\)/);
      assert.equal(runtime.headers["content-security-policy"], undefined);
    }
  }
});

for (const [kind, installer, endpoint, packet] of [
  ["storage", installSandboxStorageRendezvous, "commit", { ok: true, revision: 7 }],
  ["cookies", installSandboxCookieRendezvous, "result", { packet: "1".repeat(64) }],
]) test(`${kind} same-origin receipts retain exact origin, capability, sequence and native-owner acknowledgment`, async (t) => {
  const app = Fastify();
  let valid = true;
  installer(app, { documentOrigin: "same-origin", originFor: (req) => "http://" + req.headers.host,
    authorizeOwner: () => ({ session: "fixture" }), validateOwner: () => valid, timeoutMs: 1500 });
  const front = await app.listen({ host: "127.0.0.1", port: 0 }), host = new URL(front).host;
  let ws;
  t.after(async () => { ws?.terminate(); await app.close(); });
  const post = (url, payload, headers = {}) => app.inject({ method: "POST", url, payload, headers: {
    host, origin: front, cookie: "atlas-hub-fixture=ambient", ...headers,
  } });
  const owner = (await post(`/api/browse/${kind}/owners`, {})).json();
  const docResult = await post(`/api/browse/${kind}/documents`, { documentId: "profile_document_0123456789" }, { authorization: "Bearer " + owner.capability });
  assert.equal(docResult.statusCode, 200);
  const doc = docResult.json(), path = doc[endpoint];
  ws = new WebSocket(front.replace("http:", "ws:") + owner.websocket, { headers: { origin: front } });
  const ready = once(ws, "message"); await once(ws, "open"); await ready;
  for (const bad of ["null", "https://foreign.example", ""])
    assert.equal((await post(path, JSON.stringify({ sequence: 1 }), { origin: bad, "content-type": "text/plain" })).statusCode, 403);
  assert.equal((await post(path, JSON.stringify({ sequence: 1 }), { authorization: "Bearer invalid", "content-type": "text/plain" })).statusCode, 403);
  const waiting = once(ws, "message", { signal: AbortSignal.timeout(1800) }); let acknowledged = false;
  const response = post(path, JSON.stringify({ sequence: 1 }), { "content-type": "text/plain" }).then((r) => { acknowledged = true; return r; });
  assert.deepEqual(JSON.parse((await waiting)[0]), { type: "wait", documentId: doc.documentId, sequence: 1 });
  assert.equal(acknowledged, false);
  ws.send(JSON.stringify({ type: "result", documentId: doc.documentId, sequence: 1, ...packet }));
  const result = await response;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { ok: true, ...packet });
  assert.equal((await post(path, JSON.stringify({ sequence: 1 }), { "content-type": "text/plain" })).statusCode, 409);
  valid = false;
  assert.equal((await post(path, JSON.stringify({ sequence: 2 }), { "content-type": "text/plain" })).statusCode, 409);
});

test("Hub receipt exception is selected by explicit mode and exact origin; document capabilities still validate", async (t) => {
  const app = Fastify();
  await installHubBranch(app, { config: { ...hubConfig(), ...mode() }, originFor: () => origin, seal: String, unseal: String });
  installSandboxStorageRendezvous(app, { documentOrigin: "same-origin", originFor: () => origin,
    authorizeOwner: () => null, validateOwner: () => false });
  app.get("/api/browse/fixture", () => ({ ok: true }));
  t.after(() => app.close());
  const url = "/browse/storage/commit/" + "a".repeat(43);
  const marker = (markerOrigin) => app.inject({ method: "POST", url, headers: {
    origin: markerOrigin, cookie: "atlas-hub-fixture=ambient", "content-type": "text/plain",
  }, payload: JSON.stringify({ sequence: 1 }) });
  const rejected = await marker(origin);
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error.code, "storage_document_revoked");
  assert.equal((await marker("null")).statusCode, 401);
  assert.equal((await marker("https://foreign.example")).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/browse/fixture", headers: { origin } })).statusCode, 401);
});

test("normal runtime-ticket remains behind the existing Hub session gate", async (t) => {
  const app = Fastify();
  await installHubBranch(app, { config: { ...hubConfig(), ...mode() }, originFor: () => origin, seal: String, unseal: String });
  let issued = 0;
  app.post("/api/browse/controller/runtime-ticket", () => { issued++; return { runtimeTicket: "never-issued" }; });
  t.after(() => app.close());
  for (const headers of [{ origin }, { origin, cookie: "__Host-atlas-hub=invalid" }, { origin, authorization: "Bearer invalid" }]) {
    const result = await app.inject({ method: "POST", url: "/api/browse/controller/runtime-ticket", headers,
      payload: { session: "a".repeat(43), generation: 1 } });
    assert.equal(result.statusCode, 401);
    assert.equal(result.json().code, "HUB_SESSION_EXPIRED");
  }
  assert.equal(issued, 0);
});
