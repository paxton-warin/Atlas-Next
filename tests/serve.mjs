import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { digest, openStore } from "../server/store.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { createRuntime } from "../server/runtime.mjs";
import { navigationFixture } from "./navigation-fixture.mjs";
const dir = mkdtempSync(join(tmpdir(), "atlas-browser-"));
const seed = openStore(dir);
seed.set("bootstrap", {
  hash: digest("e2e-fixture-bootstrap"),
  expires: Date.now() + 3600000,
});
seed.db.close();
const appProcess = spawn(process.execPath, ["server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "4180",
    RUNTIME_PORT: "4181",
    APP_ORIGIN: "http://localhost:4180",
    RUNTIME_ORIGIN: "http://127.0.0.1:4181",
    DATA_DIR: dir,
    NODE_ENV: "test",
    ATLAS_TEST_FIXTURE: "1",
    AI_ENABLED: "true",
    AI_BASE_URL: "http://127.0.0.1:4199/v1",
    AI_MODEL: "atlas-test-model",
    AI_API_KEY: "fixture-only-key",
    AI_PROTOCOL: "responses",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const baseline = await createRuntime({
  appOrigin: "http://127.0.0.1:4182",
  runtimeOrigin: "http://127.0.0.1:4182",
  fixture: true,
  baseline: true,
  staticDir: resolve("upstream/scramjet/packages/demo/dist"),
});
// Only accept WebSocket upgrades; libcurl's h2c offer must retain normal HTTP body parsing.
// https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener
const fixture = createServer(
  {
    shouldUpgradeCallback: (req) =>
      req.headers.upgrade?.toLowerCase() === "websocket",
  },
  async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:4199");
    if (await navigationFixture(req, res, url)) return;
    res.setHeader("Cache-Control", "no-store");
    // Test-only fixture server: independent browser cases share one loopback IP.
    // Keep the production limits intact, but reset their fixture counters between cases.
    if (
      req.method === "POST" &&
      url.pathname === "/__test/reset-browser-limits"
    ) {
      const store = openStore(dir);
      store.db.exec(
        "DELETE FROM limits WHERE key LIKE 'browse:%' OR key LIKE 'api:%'",
      );
      store.db.close();
      res.end("FIXTURE_BROWSER_LIMITS_RESET");
      return;
    }
    // Isolate independent AI browser cases; production cooldowns remain enabled.
    if (req.method === "POST" && url.pathname === "/__test/reset-ai-limits") {
      const store = openStore(dir);
      store.db.exec(
        "DELETE FROM ai_cooldowns; DELETE FROM ai_usage; DELETE FROM limits WHERE key LIKE 'ai:%'",
      );
      store.db.close();
      res.end("FIXTURE_AI_LIMITS_RESET");
      return;
    }
    if (url.pathname.startsWith("/icons/") || url.pathname === "/favicon.ico") {
      const missing =
        url.pathname === "/icons/missing.svg" ||
        (url.pathname === "/favicon.ico" &&
          !req.headers.cookie?.includes("favicon_root=1"));
      const unauthorized =
        url.pathname === "/icons/session.svg" &&
        !req.headers.cookie?.includes("favicon_session=1");
      if (missing || unauthorized) {
        res.writeHead(missing ? 404 : 401);
        res.end("Icon not available");
        return;
      }
      res.setHeader("Content-Type", "image/svg+xml");
      const color = url.pathname.includes("pink") ? "#e93d82" : "#4285f4";
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="24" text-anchor="middle" font-size="24" fill="white">A</text></svg>`,
      );
      return;
    }
    if (url.pathname.startsWith("/favicon-fixture")) {
      const mode = url.searchParams.get("mode");
      const icon =
        mode === "root"
          ? ""
          : `<link id="site-icon" rel="shortcut icon" href="${mode === "missing" ? "missing" : mode === "session" ? "session" : "blue"}.svg">`;
      res.setHeader(
        "Set-Cookie",
        mode === "root"
          ? "favicon_root=1; Path=/; SameSite=Lax"
          : "favicon_session=1; Path=/; HttpOnly; SameSite=Lax",
      );
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><html><head><base href="/icons/"><title>Favicon fixture</title>${icon}</head><body><h1>Favicon fixture ready</h1><button onclick="document.getElementById('site-icon').href='pink.svg'">Change icon</button></body></html>`,
      );
      return;
    }
    if (["/v1/responses", "/v1/chat/completions"].includes(url.pathname)) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const last = (body.input || body.messages).at(-1).content;
      if (req.headers.authorization !== "Bearer fixture-only-key") {
        res.writeHead(401);
        res.end("fixture key mismatch");
        return;
      }
      if (last === "provider error") {
        res.writeHead(500);
        res.end("private provider detail fixture-only-key");
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      const parts = ["Test reply: ", last, "\n\n**Streaming complete.**"];
      for (const text of parts) {
        if (res.destroyed) return;
        res.write(
          "data: " +
            JSON.stringify(
              url.pathname.endsWith("responses")
                ? { type: "response.output_text.delta", delta: text }
                : { choices: [{ delta: { content: text } }] },
            ) +
            "\n\n",
        );
        await new Promise((r) =>
          setTimeout(r, last === "slow response" ? 1500 : 60),
        );
      }
      res.end(
        "data: " +
          (url.pathname.endsWith("responses")
            ? JSON.stringify({ type: "response.completed" })
            : "[DONE]") +
          "\n\n",
      );
      return;
    }
    if (url.pathname === "/set-cookie") {
      res.setHeader("Set-Cookie", [
        "atlas_fixture=persistent; Path=/; Max-Age=3600; SameSite=Lax",
        "atlas_http_only=present; Path=/; HttpOnly; Max-Age=3600",
      ]);
      res.writeHead(302, { Location: "/fixture" });
      res.end();
      return;
    }
    if (url.pathname === "/logout") {
      res.setHeader("Set-Cookie", [
        "atlas_fixture=; Path=/; Max-Age=0",
        "atlas_http_only=; Path=/; HttpOnly; Max-Age=0",
      ]);
      res.writeHead(302, { Location: "/fixture" });
      res.end();
      return;
    }
    if (url.pathname === "/echo") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          cookie: req.headers.cookie || "",
          method: req.method,
          body,
        }),
      );
      return;
    }
    if (url.pathname === "/download") {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="atlas-fixture.txt"',
      );
      res.end("Atlas download works");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><head><meta charset="UTF-8"><title>Atlas fixture</title></head><body><h1>Proxy fixture ready</h1><p id="cookie">${req.headers.cookie || "no-cookie"}</p><a href="/set-cookie">Sign in fixture</a><a href="/logout">Sign out fixture</a><a href="/fixture?next=1">Next page</a><a href="/fixture?popup=1" target="_blank">Open popup</a><a href="/download" download>Download file</a><form method="POST" action="/echo"><input name="message" value="Atlas form"/><button>Submit form</button></form><button id="storage">Save storage</button><p id="stored"></p><button id="fetch">Test fetch</button><p id="fetch-result"></p><button id="socket">Test WebSocket</button><p id="socket-result"></p><script>document.getElementById('stored').textContent=localStorage.getItem('atlas-fixture-storage')||'';document.getElementById('storage').onclick=()=>{localStorage.setItem('atlas-fixture-storage','persisted');document.getElementById('stored').textContent=localStorage.getItem('atlas-fixture-storage')};document.getElementById('fetch').onclick=async()=>document.getElementById('fetch-result').textContent=await fetch('/echo',{method:'POST',body:'fetch works'}).then(r=>r.text());document.getElementById('socket').onclick=()=>{const s=new WebSocket('ws://127.0.0.1:4199/socket');s.onopen=()=>s.send('socket works');s.onmessage=e=>{document.getElementById('socket-result').textContent=e.data;s.close()}};<\/script></body></html>`,
    );
  },
);
const ws = new WebSocketServer({ noServer: true });
fixture.on("upgrade", (req, socket, head) => {
  if (req.url === "/socket")
    ws.handleUpgrade(req, socket, head, (client) =>
      ws.emit("connection", client, req),
    );
  else socket.destroy();
});
ws.on("connection", (socket) =>
  socket.on("message", (v) => socket.send(v.toString())),
);
await new Promise((resolve) => fixture.listen(4199, "127.0.0.1", resolve));
await baseline.listen({ port: 4182, host: "127.0.0.1" });
for (let i = 0; i < 100; i++) {
  if (appProcess.exitCode !== null)
    throw Error("Application entrypoint exited");
  try {
    if ((await fetch("http://localhost:4180/health")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const pairedNode = await createNodeService({
  fixture: true,
  pairing: { verify: (code) => code === "AABBCCDDEEFF", save: () => {} },
});
await pairedNode.listen({ port: 4195, host: "127.0.0.1" });
console.log("TEST_SERVERS_READY");
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, async () => {
    for (const client of ws.clients) client.terminate();
    fixture.closeAllConnections();
    fixture.close();
    const stopped = once(appProcess, "exit");
    appProcess.kill("SIGTERM");
    baseline.server.closeAllConnections?.();
    await Promise.all([stopped, baseline.close(), pairedNode.close()]);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
