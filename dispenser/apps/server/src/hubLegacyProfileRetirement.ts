/** V1 website replication is permanently retired. This hook runs before body
 * parsing, live authentication, pool admission, account locks or any mutation.
 * Read-only legacy recovery and normal UI preference endpoints remain separate. */
import type { FastifyInstance } from "fastify";
export const PROFILE_LEGACY_SYNC_RETIRED = "PROFILE_LEGACY_SYNC_RETIRED";
const base = "/api/hub/branch/profile";
const exact = new Set([
  "POST " + base + "/commits",
  "POST " + base + "/chunks",
  "POST " + base + "/recoveries",
  "POST " + base + "/imports",
  "POST " + base + "/writers",
  "PUT " + base + "/writers",
  "DELETE " + base + "/writers",
  "POST " + base + "/writers/takeover",
  "POST " + base + "/backups/v2/legacy-conversions",
]);
export function isRetiredLegacyProfileWrite(method: string, path: string) {
  const clean = path.split("?")[0].replace(/\/+$/, "");
  return (
    exact.has(method + " " + clean) ||
    (method === "POST" &&
      new RegExp("^" + base + "/writers/requests/[^/]+/ack$").test(clean)) ||
    (method === "POST" &&
      new RegExp("^" + base + "/imports/[^/]+/commit$").test(clean)) ||
    (method === "DELETE" &&
      new RegExp("^" + base + "/imports/[^/]+$").test(clean))
  );
}
export function registerLegacyProfileWriteRetirement(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    if (
      !isRetiredLegacyProfileWrite(
        request.method,
        request.routeOptions.url || request.url,
      )
    )
      return;
    return reply
      .code(410)
      .header("cache-control", "no-store")
      .send({
        error: {
          code: PROFILE_LEGACY_SYNC_RETIRED,
          message:
            "Legacy live synchronization has been retired. Local-first website storage and periodic backups replace this endpoint.",
          retryable: false,
        },
      });
  });
}
