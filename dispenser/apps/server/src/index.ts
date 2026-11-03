import { access } from "node:fs/promises";
import { join } from "node:path";
import staticPlugin from "@fastify/static";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startBackgroundJobs } from "./jobs.js";

const { app, pool, redis, drive } = await buildApp();
const webRoot = join(import.meta.dirname, "../../web/dist");
try {
  await access(webRoot);
  await app.register(staticPlugin, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/") || request.url.startsWith("/health/")
      ? reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: "Not found." } })
      : reply.sendFile("index.html"),
  );
} catch {
  app.log.warn("Web build not found; API-only mode enabled");
}
const stopJobs = startBackgroundJobs(pool, redis, drive, app.log);
app.addHook("onClose", async () => stopJobs());
await app.listen({ host: "0.0.0.0", port: config.port });
