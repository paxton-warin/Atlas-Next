import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { signTicket, verifyTicket } from "../server/node-ticket.mjs";
import {
  acceptedNodeCapabilities,
  FRONTEND_CONTROLLER_RELAY_V2 as capability,
} from "../server/runtime-capabilities.mjs";
const frontend = "http://main.example";
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-controller-protocol-"));
  const app = await createApp({
      dataDir: directory,
      staticDir: "/not-built",
      appOrigin: frontend,
      runtimeOrigin: "http://runtime.example",
    }),
    nodes = [];
  t.after(async () => {
    await Promise.all(nodes.map((n) => n.close()));
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let credentials;
  const remote = await createNodeService({
    pairing: { verify: () => true, save: (value) => (credentials = value) },
  });
  nodes.push(remote);
  await remote.listen({ host: "127.0.0.1", port: 0 });
  const endpoint = "http://127.0.0.1:" + remote.server.address().port;
  const { id } = await app.nodePool.attach(
    { endpoint, name: "Protocol node", code: "fixture" },
    frontend,
  );
  return {
    app,
    remote,
    endpoint,
    id,
    get secret() {
      return credentials.secret;
    },
  };
}
test("capability advertisement distinguishes transport support from held frontend activation", async (t) => {
  const f = await fixture(t);
  const protocol = (await f.app.inject("/api/config")).json().runtimeProtocols
    .opaque;
  assert.equal(protocol.version, 2);
  assert.equal(protocol.activated, false);
  assert.deepEqual(protocol.requiredNodeCapabilities, [
    capability,
    "frontend-native-resources-v1",
  ]);
  assert.deepEqual(
    acceptedNodeCapabilities([
      "unknown",
      capability,
      capability,
      "frontend-relay-v1",
    ]),
    [capability, "frontend-relay-v1"],
  );
  assert.ok(
    f.app.nodePool
      .list()
      .find((n) => n.id === f.id)
      .capabilities.includes(capability),
  );
});
test("controller tickets authorize only relay upgrades from their exact frontend to their selected node", async (t) => {
  const f = await fixture(t);
  f.app.nodePool.update("local", { state: "disabled", weight: 1 });
  const lease = await f.app.nodePool.operate(
    { intent: "new" },
    frontend,
    "http://runtime.example",
  );
  const grant = await f.app.nodePool.controllerRelay(
    lease.session,
    frontend,
    lease.generation,
  );
  assert.equal(grant.relayOrigin, f.endpoint);
  assert.equal(grant.frontendOrigin, frontend);
  const decoded = verifyTicket(grant.ticket, f.secret, frontend);
  assert.equal(decoded.role, "frontend-controller-v2");
  assert.equal(decoded.lease, lease.sessionHash);
  const ws = new WebSocket(
    f.endpoint.replace("http:", "ws:") + "/relay/" + grant.ticket + "/",
    { headers: { origin: frontend } },
  );
  const packet = once(ws, "message");
  await once(ws, "open");
  assert.equal(new Uint8Array((await packet)[0])[0], 3);
  ws.terminate();
  assert.equal(
    (
      await fetch(f.endpoint + "/runtime-config", {
        headers: { authorization: "Bearer " + grant.ticket },
      })
    ).status,
    401,
  );
  for (const origin of ["null", "http://other-frontend.example", f.endpoint]) {
    const bad = new WebSocket(
      f.endpoint.replace("http:", "ws:") + "/relay/" + grant.ticket + "/",
      { headers: { origin } },
    );
    const result = await new Promise((resolve) => {
      bad.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        res.resume();
        bad.terminate();
      });
      bad.on("error", () => {});
      bad.on("open", () => {
        resolve(101);
        bad.terminate();
      });
    });
    assert.equal(result, 401);
  }
  const wrongTarget = signTicket(
    { ...decoded, relayOrigin: "http://different-node.example" },
    f.secret,
  );
  const bad = new WebSocket(
    f.endpoint.replace("http:", "ws:") + "/relay/" + wrongTarget + "/",
    { headers: { origin: frontend } },
  );
  const result = await new Promise((resolve) => {
    bad.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
      res.resume();
      bad.terminate();
    });
    bad.on("error", () => {});
    bad.on("open", () => {
      resolve(101);
      bad.terminate();
    });
  });
  assert.equal(result, 401);
});
test("missing capabilities and stale/revoked owner assignments never silently select another node", async (t) => {
  const f = await fixture(t);
  f.app.nodePool.update("local", { state: "disabled", weight: 1 });
  const lease = await f.app.nodePool.operate(
    { intent: "new" },
    frontend,
    "http://runtime.example",
  );
  await assert.rejects(
    f.app.nodePool.controllerRelay(lease.session, frontend, 2),
    (e) => e.code === "SESSION_GENERATION_MISMATCH",
  );
  f.app.store.set("nodeCapabilities", { [f.id]: ["frontend-relay-v1"] });
  await assert.rejects(
    f.app.nodePool.controllerRelay(lease.session, frontend, 1),
    (e) => e.code === "RUNTIME_CAPABILITY_REQUIRED",
  );
  assert.equal(f.app.nodePool.list().find((n) => n.id === f.id).sessions, 1);
  f.app.nodePool.release(lease.session, frontend);
  await assert.rejects(
    f.app.nodePool.controllerRelay(lease.session, frontend, 1),
    (e) => e.code === "SESSION_REVOKED",
  );
});
test("Main controller relay ticket uses current frontend and does not depend on a runtime host", async (t) => {
  const f = await fixture(t);
  f.app.nodePool.update(f.id, { state: "disabled", weight: 1 });
  const lease = await f.app.nodePool.operate(
    { intent: "new" },
    frontend,
    "http://runtime.example",
  );
  const grant = await f.app.nodePool.controllerRelay(
    lease.session,
    frontend,
    1,
  );
  assert.equal(grant.node.id, "local");
  assert.equal(grant.relayOrigin, frontend);
  assert.equal(
    f.app.nodePool.resolve(grant.ticket, frontend, "relay", {
      relayOrigin: frontend,
    }).node.id,
    "local",
  );
  for (const [purpose, relayOrigin] of [
    ["runtime", frontend],
    ["relay", "http://another.example"],
  ])
    assert.throws(
      () =>
        f.app.nodePool.resolve(grant.ticket, frontend, purpose, {
          relayOrigin,
        }),
      (e) => e.code === "INVALID_TICKET",
    );
});
