import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:https";
import { ports } from "./hub-lab.mjs";
import { createLabProxyHandlers } from "./hub-lab-proxy-handlers.mjs";
import { createCloudLabControl } from "./hub-lab-cloud-control.mjs";
if (process.env.NODE_ENV !== "test" || !process.env.ATLAS_LAB_STATE)
  throw Error("Local fixture runner only.");
const state = JSON.parse(readFileSync(process.env.ATLAS_LAB_STATE, "utf8"));
const cloud = await createCloudLabControl(state);
const directory = dirname(process.env.ATLAS_LAB_STATE);
const tls = {
  key: readFileSync(join(directory, "key.pem")),
  cert: readFileSync(join(directory, "cert.pem")),
};
const servers = [];
for (const [front, back] of [
  [ports.hub, ports.hubInternal],
  [ports.atlas, ports.atlasInternal],
  [ports.runtime, ports.runtimeInternal],
  ...ports.nodes.map((p, i) => [p, ports.nodeInternal[i]]),
]) {
  const handlers = createLabProxyHandlers({ front, back, ports, cloud });
  const server = createServer(tls, handlers.http);
  server.on("upgrade", handlers.upgrade);
  await new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(front, "127.0.0.1", ok);
  });
  servers.push(server);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    for (const server of servers) server.closeAllConnections();
    void cloud.close();
    process.exit(0);
  });
console.log("Loopback-only HTTPS/WSS proxies ready.");
