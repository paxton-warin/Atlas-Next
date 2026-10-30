/** Retired mutation replication must never reach identity/account/SQL work.
 * Native website storage and the backup-v2 protocol do not use these routes. */
const prefix = "/api/hub/profile";
export function isRetiredLegacySyncMutation(request) {
  const path = request.url.split("?")[0].replace(/\/+$/, "");
  if (!path.startsWith(prefix + "/")) return false;
  const suffix = path.slice(prefix.length), method = request.method;
  if (method === "POST" && suffix === "/backups/v2/legacy-conversions") return true;
  if (method === "POST")
    return /^\/(?:commits|chunks|recoveries|imports|writers)$/.test(suffix) ||
      /^\/writers\/takeover$/.test(suffix) ||
      /^\/writers\/requests\/[^/]+\/ack$/.test(suffix) ||
      /^\/imports\/[^/]+\/commit$/.test(suffix);
  return (method === "PUT" || method === "DELETE") && suffix === "/writers" ||
    method === "DELETE" && /^\/imports\/[^/]+$/.test(suffix);
}
export function installLegacySyncRetirement(app) {
  app.addHook("onRequest", async (request, reply) => {
    if (!isRetiredLegacySyncMutation(request)) return;
    return reply.code(410).header("Cache-Control", "no-store").send({
      error: {
        code: "PROFILE_LEGACY_SYNC_RETIRED",
        message: "Legacy syncing has been retired. Reload Atlas once to use local-first storage.",
        retryable: false,
      },
    });
  });
}
