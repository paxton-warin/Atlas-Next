// Real Caddy routing against disposable HTTP/WebSocket upstreams; no AWS changes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
const root = resolve(process.argv[2] || ".");
const binary = process.env.CADDY_BIN || "caddy";
const dir = mkdtempSync(join(tmpdir(), "atlas-caddy-"));
const servers = [];
let child;
async function upstream(name) {
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      name === "app" ? "frame-ancestors 'none'" : "frame-ancestors https:",
    );
    res.end(
      JSON.stringify({
        name,
        host: req.headers["x-forwarded-host"],
        proto: req.headers["x-forwarded-proto"],
        ip: req.headers["x-forwarded-for"],
      }),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.send(name));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return server.address().port;
}
try {
  const appPort = await upstream("app"),
    runtimePort = await upstream("runtime");
  const reserve = createServer().listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const config =
    "{\n admin off\n auto_https off\n}\n" +
    readFileSync(join(root, "Caddyfile.cloudfront"), "utf8")
      .replaceAll("app:4180", `127.0.0.1:${appPort}`)
      .replaceAll("app:4181", `127.0.0.1:${runtimePort}`);
  const filename = join(dir, "Caddyfile");
  writeFileSync(filename, config);
  const env = {
    ...process.env,
    ORIGIN_HOST: `http://127.0.0.1:${port}`,
    ORIGIN_KEY: "synthetic-origin-key",
  };
  env.RUNTIME_HOST = "legacy-runtime.example";
  const valid = spawnSync(
    binary,
    ["validate", "--config", filename, "--adapter", "caddyfile"],
    { env, encoding: "utf8" },
  );
  assert.equal(valid.status, 0, valid.stderr);
  child = spawn(
    binary,
    ["run", "--config", filename, "--adapter", "caddyfile"],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let logs = "";
  child.stderr.on("data", (chunk) => (logs += chunk));
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(ready, logs);
  assert.equal((await fetch(base)).status, 403);
  const headers = {
    "X-Atlas-Origin-Key": "synthetic-origin-key",
    "X-Atlas-Viewer-Host": "d1.frontend.example",
    "X-Atlas-Viewer-Ip": "198.51.100.20",
  };
  for (const host of ["d1.frontend.example", "d100.frontend.example"]) {
    headers["X-Atlas-Viewer-Host"] = host;
    for (const route of ["/", "/api/config", "/health"]) {
      const response = await fetch(base + route, { headers });
      assert.match(
        response.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      assert.deepEqual(await response.json(), {
        name: "app",
        host,
        proto: "https",
        ip: "198.51.100.20",
      });
    }
    for (const route of ["/relay/fixture/", "/wisp/fixture/"]) {
      const response = await fetch(base + route, { headers });
      assert.equal((await response.json()).name, "runtime");
      const socket = new WebSocket(base.replace("http:", "ws:") + route, {
        headers,
      });
      const [message] = await once(socket, "message");
      assert.equal(message.toString(), "runtime");
      socket.close();
      await once(socket, "close");
    }
  }
  const legacy = await fetch(base + "/health", {
    headers: { ...headers, "X-Atlas-Viewer-Host": "legacy-runtime.example" },
  });
  assert.equal((await legacy.json()).name, "runtime");
  console.log(
    "CADDY_VALIDATE=PASS; ALIASES=PASS; API=APP; RELAY=RUNTIME; WEBSOCKET=PASS; ORIGIN_403=PASS; APP_CSP=UNCHANGED; LEGACY_RUNTIME=PASS",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  rmSync(dir, { recursive: true, force: true });
}
