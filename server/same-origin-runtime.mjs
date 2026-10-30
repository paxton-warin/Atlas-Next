/** Full pinned runtime compatibility mode. Website documents deliberately share
 * the frontend browser origin; Scramjet owns their logical website identities.
 * Keep Atlas API authentication/CSRF unchanged and route only reserved assets. */
import fastifyStatic from "@fastify/static";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export async function installSameOriginRuntime(app, {
  directory, originFor, runtimeConfig, fixture = false, profileRuntimeEngine,
}) {
  const headers = async (_req, reply) => {
    // Do not impose the opaque bootstrap's restrictive resource allowlists on
    // the complete rewriting runtime. It must load modules, workers and Wasm.
    reply.removeHeader("Content-Security-Policy");
    if (profileRuntimeEngine === "scramjet-controller") {
      for (const name of [
        "X-Frame-Options",
        "Cross-Origin-Opener-Policy",
        "Cross-Origin-Embedder-Policy",
        "Permissions-Policy",
      ]) reply.removeHeader(name);
    } else reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "no-referrer");
  };
  await app.register(async function runtimeAssets(scope) {
    scope.addHook("onRequest", headers);
    await scope.register(fastifyStatic, {
      root: directory, prefix: "/browse/runtime/", decorateReply: false,
      preCompressed: true, index: ["index.html"],
    });
    for (const name of ["runtime", "controller", "bootstrap", "clients"])
      await scope.register(fastifyStatic, {
        root: resolve(directory, name), prefix: `/${name}/`,
        decorateReply: false, preCompressed: true,
      });
    scope.get("/worker.js", (_req, reply) => reply
      .header("Service-Worker-Allowed", "/")
      .header("Cache-Control", "no-cache")
      .type("application/javascript")
      .send(readFileSync(resolve(directory, "worker.js"))));
    scope.get("/runtime-config", (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const origin = originFor(req);
      if (req.headers.origin && req.headers.origin !== origin)
        return reply.code(403).send({ error: "Origin mismatch.", code: "INVALID_TICKET" });
      const ticket = req.headers.authorization?.replace(/^Bearer /, "");
      return { ...runtimeConfig(ticket, origin), fixture };
    });
    scope.get("/~/app/*", (_req, reply) => reply.code(503).type("text/plain")
      .send("Proxy worker is not controlling this page. Reload Atlas and retry."));
    scope.get("/~/sj/*", (_req, reply) => reply.code(503).type("text/plain")
      .send("Proxy worker is not controlling this page. Reload Atlas and retry."));
  });
}
