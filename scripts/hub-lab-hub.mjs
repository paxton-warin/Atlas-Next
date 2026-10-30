import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { validateLabDatabase, validateLabRedis } from "./hub-lab.mjs";
if (process.env.NODE_ENV !== "test" || process.env.HUB_CLOUD_FAKE !== "1")
  throw Error("Local fixture runner only.");
validateLabDatabase(process.env.DATABASE_URL);
validateLabRedis(process.env.REDIS_URL);
const state = JSON.parse(readFileSync(process.env.ATLAS_LAB_STATE, "utf8"));
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hub = resolve(root, "../Atlas-Link-Dispenser");
const require = createRequire(join(hub, "apps/server/package.json"));
const Redis = require("ioredis");
const redis = new Redis(process.env.REDIS_URL, {
  keyPrefix: `atlas-lab:${state.id}:`,
  lazyConnect: true,
});
const verification = new Map();
const drive = {
  async createVerificationFile(email, code) {
    const id = randomUUID();
    verification.set(id, { email, code, expires: Date.now() + 600000 });
    console.log(`Local verification file created for ${email}`);
    return {
      fileId: id,
      permissionId: id,
      url: `https://localhost:4300/__lab/verification/${id}`,
    };
  },
  async removeVerificationFile(id) {
    verification.delete(id);
  },
  async testConnection() {
    return "Local fixture only; no Google requests.";
  },
};
const { buildApp } = await import(join(hub, "apps/server/src/app.ts"));
const { app, pool } = await buildApp({ redis, drive });
app.get("/__lab/verification/:id", async (request, reply) => {
  const value = verification.get(request.params.id);
  reply.header("Cache-Control", "no-store").type("text/plain");
  if (!value || value.expires < Date.now())
    return reply
      .code(404)
      .send("This local verification file expired. Request another.");
  return `ATLAS LOCAL LAB — synthetic verification only\n\nEmail: ${value.email}\nVerification code: ${value.code}\n\nReturn to the Hub sign-in screen and enter this code. No email or Google request was made.`;
});
await app.register(require("@fastify/static"), {
  root: join(hub, "apps/web/dist"),
  wildcard: true,
});
app.setNotFoundHandler((request, reply) =>
  request.url.startsWith("/api/") || request.url.startsWith("/__lab/")
    ? reply.code(404).send({ error: { message: "Not found" } })
    : reply.sendFile("index.html"),
);
if (!(await pool.query("SELECT 1 FROM users WHERE role='admin'")).rowCount) {
  const response = await app.inject({
    method: "POST",
    url: "/api/setup/bootstrap",
    payload: {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL,
      token: process.env.BOOTSTRAP_TOKEN,
    },
  });
  if (response.statusCode !== 200)
    throw Error("Local initial administrator setup failed.");
}
const admin = (
  await pool.query(
    "SELECT id FROM users WHERE normalized_email='admin@atlas-lab.example'",
  )
).rows[0];
await pool.query(
  "INSERT INTO link_assignments(user_id,link_id) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=$2)",
  [admin.id, state.linkId],
);
await app.listen({ host: "127.0.0.1", port: 4301 });
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    redis.disconnect();
    process.exit(0);
  });
