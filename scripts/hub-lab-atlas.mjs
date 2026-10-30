import { createServer } from "node:http";
import argon2 from "argon2";
import { Secret } from "otpauth";
import { token, digest } from "../server/store.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../server/app.mjs";
import { createRuntime } from "../server/runtime.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { ports } from "./hub-lab.mjs";
import { serveLabFixture } from "./hub-lab-fixture.mjs";
if (
  process.env.NODE_ENV !== "test" ||
  process.env.ATLAS_TEST_FIXTURE !== "1" ||
  !process.env.ATLAS_LAB_STATE
)
  throw Error("Local fixture runner only.");
const app = await createApp({ nodesEnabled: true });
if (!app.store.get("admin")) {
  const password = token(),
    totpBase32 = new Secret({ size: 20 }).base32,
    recoveryCodes = Array.from({ length: 8 }, () => token());
  app.store.set("admin", {
    password: await argon2.hash(password, { type: argon2.argon2id }),
    secret: app.store.seal(totpBase32),
    recovery: recoveryCodes.map(digest),
  });
  writeFileSync(
    join(dirname(process.env.ATLAS_LAB_STATE), "coordinator-admin.json"),
    JSON.stringify({ password, secret: totpBase32, recovery: recoveryCodes }),
    { mode: 0o600 },
  );
}
const runtime = await createRuntime({
  appOrigin: "https://localhost:4280",
  runtimeOrigin: "https://127.0.0.1:4281",
  authorize: (...args) => app.nodePool.resolve(...args),
  fixture: true,
});
app.nodePool.setLocalConnections(() => runtime.connectionCount());
app.nodePool.setLocalRelayStats(() => runtime.connectionStats());
app.nodePool.setLocalRelaySessionIds(() => runtime.connectionSessionIds());
await runtime.listen({ host: "127.0.0.1", port: ports.runtimeInternal });
app.get("/__lab/simulator/state", async (req, reply) => {
  if (
    req.headers.origin ||
    req.headers.authorization !==
      "Bearer " + process.env.ATLAS_HUB_SERVICE_SECRET
  )
    return reply.code(401).send({ error: "Service authorization required." });
  return {
    generation: app.store.get("hubEndpointRevision")?.generation ?? 0,
    hubOrigin: app.atlasConfig.hubOrigin,
    nodes: app.nodePool.list(),
  };
});
await app.listen({ host: "127.0.0.1", port: ports.atlasInternal });
const credentialFile = join(dirname(process.env.ATLAS_LAB_STATE), "nodes.json");
let credentials = existsSync(credentialFile)
  ? JSON.parse(readFileSync(credentialFile))
  : [];
const nodes = [];
for (let i = 0; i < 3; i++) {
  let value = credentials[i];
  if (!value) {
    value = app.nodePool.add({
      name: `Lab Node ${i + 2}`,
      endpoint: `https://127.0.0.1:${ports.nodes[i]}`,
    });
    credentials[i] = value;
    writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  }
  const node = await createNodeService({
    id: value.id,
    secret: value.token,
    fixture: true,
    runtimeOrigin: `https://127.0.0.1:${ports.nodes[i]}`,
  });
  await node.listen({ host: "127.0.0.1", port: ports.nodeInternal[i] });
  nodes.push(node);
}
const heartbeats = setInterval(async () => {
  for (let i = 0; i < nodes.length; i++) {
    const value = credentials[i];
    try {
      await app.nodePool.heartbeat(
        value.id,
        value.token,
        nodes[i].connectionCount(),
      );
      nodes[i].applyControl(app.nodePool.nodeState(value.id));
    } catch {
      /* Proxies may be starting; subsequent ticks recover. */
    }
  }
}, 5000);
const fixture = createServer(serveLabFixture);
await new Promise((ok) => fixture.listen(ports.fixture, "127.0.0.1", ok));
console.log(
  "Local opaque browsing fixture ready; real AWS and production remain deferred.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    clearInterval(heartbeats);
    fixture.closeAllConnections();
    fixture.close();
    for (const node of nodes) {
      node.server.closeAllConnections();
      await node.close();
    }
    runtime.server.closeAllConnections();
    app.server.closeAllConnections();
    await runtime.close();
    await app.close();
    process.exit(0);
  });
