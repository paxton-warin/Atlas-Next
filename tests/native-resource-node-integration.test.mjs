import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { createNodeService } from "../server/node-service.mjs";
import { signTicket } from "../server/node-ticket.mjs";
const frontend = "https://frontend.example",
  resource = "https://selected.cloudfront.net",
  secret = "fixture-secret-".repeat(4),
  hash = "b".repeat(64);
test("real selected-node gateway and relay upgrades preserve only trusted proxy HTTPS and keep purposes separate", async (t) => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "127.0.0.1";
  const node = await createNodeService({
    id: "selected",
    secret,
    staticDir: "/not-built",
  });
  if (previous === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previous;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await node.close();
  });
  node.applyControl({
    revision: 1,
    state: "active",
    leases: [hash],
    grants: [{ hash, generation: 1, expiresAt: Date.now() + 60000 }],
    revoked: [],
  });
  await node.listen({ host: "127.0.0.1", port: 0 });
  const base = "ws://127.0.0.1:" + node.server.address().port;
  const proxyHeaders = {
    origin: frontend,
    host: "internal-origin.example",
    "x-forwarded-host": "selected.cloudfront.net",
    "x-forwarded-proto": "https",
  };
  const common = {
    node: "selected",
    lease: hash,
    generation: 1,
    origin: frontend,
    runtimeOrigin: frontend,
    expires: Date.now() + 60000,
  };
  const relay = signTicket(
    { ...common, role: "frontend-controller-v2", relayOrigin: resource },
    secret,
  );
  const resourceTicket = signTicket(
    {
      ...common,
      role: "frontend-resource-owner-v1",
      purpose: "native-resource-owner",
      resourceOrigin: resource,
    },
    secret,
  );
  const registered = await node.inject({
    method: "POST",
    url: "/native-resource/v1/owners",
    headers: { ...proxyHeaders, authorization: "Bearer " + resourceTicket },
    payload: {},
  });
  assert.equal(registered.statusCode, 200, registered.body);
  const ws = new WebSocket(base + registered.json().websocket, {
    headers: proxyHeaders,
  });
  sockets.push(ws);
  await once(ws, "open");
  const pong = once(ws, "message");
  ws.send('{"type":"ping"}');
  assert.deepEqual(JSON.parse((await pong)[0]), { type: "pong" });
  const relayWS = new WebSocket(base + "/relay/" + relay + "/", {
    headers: proxyHeaders,
  });
  sockets.push(relayWS);
  const continuePacket = once(relayWS, "message");
  await once(relayWS, "open");
  assert.equal(new Uint8Array((await continuePacket)[0])[0], 3);
  async function denied(path, headers = proxyHeaders) {
    const connection = new WebSocket(base + path, { headers });
    sockets.push(connection);
    connection.on("error", () => {});
    return await new Promise((resolve) => {
      connection.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        res.resume();
        connection.terminate();
      });
      connection.on("open", () => {
        connection.terminate();
        resolve(101);
      });
    });
  }
  assert.equal(await denied("/relay/" + resourceTicket + "/"), 401);
  assert.equal(
    await denied("/relay/" + relay + "/", {
      origin: frontend,
      host: "internal-origin.example",
    }),
    401,
  );
  assert.equal(
    (
      await node.inject({
        method: "POST",
        url: "/native-resource/v1/owners",
        headers: { ...proxyHeaders, authorization: "Bearer " + relay },
        payload: {},
      })
    ).statusCode,
    401,
  );
  const closed = once(ws, "close");
  node.applyControl({
    revision: 2,
    state: "active",
    leases: [],
    grants: [],
    revoked: [hash],
  });
  ws.send('{"type":"ping"}');
  assert.equal((await closed)[0], 1008);
});
