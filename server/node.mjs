import { createNodeService } from "./node-service.mjs";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { digest } from "./store.mjs";
const directory = resolve(process.env.DATA_DIR || "node-data");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = resolve(directory, "node.json");
let credentials = existsSync(file) ? JSON.parse(readFileSync(file)) : null;
let code, expires;
function newCode() {
  code = randomBytes(6).toString("hex").toUpperCase();
  expires = Date.now() + 600000;
  console.log("NODE_PAIRING_CODE=" + code + " (expires in 10 minutes)");
}
if (!credentials) newCode();
const app = await createNodeService({
  id: credentials?.id,
  secret: credentials?.secret,
  pairing: {
    verify(value) {
      return (
        !credentials &&
        Date.now() < expires &&
        typeof value === "string" &&
        digest(value.trim().toUpperCase()) === digest(code)
      );
    },
    save(value) {
      writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
      renameSync(file + ".tmp", file);
      credentials = value;
      code = null;
      console.log("NODE_ATTACHED=" + value.id);
      setTimeout(() => void heartbeat(), 100);
    },
  },
});
await app.listen({
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 4183),
});
let stopped = false,
  busy = false;
async function heartbeat() {
  if (!credentials || busy) return;
  busy = true;
  try {
    const r = await fetch(
      new URL("/api/nodes/heartbeat", credentials.control),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer " + credentials.secret,
        },
        body: JSON.stringify({
          id: credentials.id,
          connections: app.connectionCount(),
        }),
        signal: AbortSignal.timeout(6000),
        redirect: "error",
      },
    );
    if (!r.ok) console.error("NODE_HEARTBEAT_STATUS=" + r.status);
    else app.applyControl(await r.json());
  } catch {
    console.error("NODE_HEARTBEAT_UNREACHABLE");
  } finally {
    busy = false;
  }
}
await heartbeat();
const timer = setInterval(() => {
  if (stopped) return;
  if (!credentials && Date.now() > expires) newCode();
  else void heartbeat();
}, 15000);
console.log("ATLAS_NODE_READY");
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    stopped = true;
    clearInterval(timer);
    app.server.closeAllConnections?.();
    await app.close();
    process.exit(0);
  });
