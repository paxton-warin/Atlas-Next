import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-node-entry-"));
const origin = "http://localhost:4490",
  endpoint = "http://127.0.0.1:4493";
const app = await createApp({
  dataDir: join(dir, "main"),
  appOrigin: origin,
  runtimeOrigin: "http://127.0.0.1:4491",
  staticDir: "/not-built",
});
let child,
  output = "";
async function start() {
  output = "";
  child = spawn(process.execPath, ["server/node.mjs"], {
    env: {
      ...process.env,
      DATA_DIR: join(dir, "node"),
      HOST: "127.0.0.1",
      PORT: "4493",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => (output += data.toString()));
  child.stderr.on("data", () => {});
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("Node entrypoint exited");
    if (output.includes("ATLAS_NODE_READY")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Node start timeout");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}
try {
  await app.listen({ port: 4490, host: "127.0.0.1" });
  await start();
  const code = output.match(/NODE_PAIRING_CODE=([A-F0-9]+)/)?.[1];
  assert.ok(code);
  const attached = await app.nodePool.attach(
    { name: "Persisted node", endpoint, code },
    origin,
  );
  app.nodePool.update("local", { state: "disabled", weight: 1 });
  const lease = await app.nodePool.allocate(
    "",
    origin,
    "http://127.0.0.1:4491",
  );
  assert.equal(lease.node.id, attached.id);
  await stop();
  await start();
  assert.ok(!output.includes("NODE_PAIRING_CODE="));
  const config = await fetch(endpoint + "/runtime-config", {
    headers: { authorization: "Bearer " + lease.ticket },
  });
  assert.equal(config.status, 200);
  const resumed = await app.nodePool.allocate(
    lease.session,
    origin,
    "http://127.0.0.1:4491",
  );
  assert.equal(resumed.node.id, lease.node.id);
  assert.equal((await fetch(endpoint + "/api/admin/state")).status, 404);
  console.log(
    "PAIR=PASS; NODE_RESTART=PASS; SESSION=PINNED; ADMIN_API_ON_NODE=404; MODE=DIRECT",
  );
} finally {
  await stop();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
