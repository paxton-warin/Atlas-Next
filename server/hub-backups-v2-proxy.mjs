import { Readable, Transform } from "node:stream";
import { createGzip, constants as zlibConstants } from "node:zlib";
let activeCompression = 0; // Saturation sends identity bytes; browsing/control never wait.
const acceptsGzip = (value) =>
  String(value || "")
    .split(",")
    .some((item) => {
      const [name, ...params] = item.trim().toLowerCase().split(";");
      if (name !== "gzip") return false;
      const quality = params.find((p) => p.trim().startsWith("q="));
      return (
        !quality ||
        (/^q=(?:1(?:\.0{0,3})?|0(?:\.[0-9]{0,3})?)$/.test(quality.trim()) &&
          Number(quality.trim().slice(2)) > 0)
      );
    });
const prefix = "/api/hub/profile/backups/v2";
const id = "[0-9a-f-]{36}",
  hash = "[a-f0-9]{64}";
const rules = [
  ["GET", /^\/capabilities$/],
  ["POST", /^\/replicas$/],
  ["POST", /^\/legacy-conversions$/],
  ["GET", new RegExp(`^/legacy-conversions/${id}$`)],
  [
    "POST",
    new RegExp(`^/replicas/${id}/(?:checkpoints|adopt|cancellations/adopt)$`),
  ],
  ["DELETE", new RegExp(`^/replicas/${id}$`)],
  ["GET", new RegExp(`^/staging/${id}$`)],
  ["DELETE", new RegExp(`^/staging/${id}$`)],
  ["POST", new RegExp(`^/staging/${id}/publish$`)],
  ["PUT", new RegExp(`^/staging/${id}/parts/${hash}$`)],
  ["GET", /^\/checkpoints(?:\/latest)?$/],
  ["GET", new RegExp(`^/checkpoints/${id}$`)],
  ["POST", new RegExp(`^/checkpoints/${id}/restore-(?:renew|release)$`)],
  ["GET", new RegExp(`^/checkpoints/${id}/namespaces$`)],
  ["GET", new RegExp(`^/namespace-versions/${id}/records$`)],
  ["GET", new RegExp(`^/parts/${hash}$`)],
];
export function backupV2Operation(req) {
  if (!req.url.startsWith(prefix + "/")) return false;
  const url = new URL(req.url, "http://atlas.invalid"),
    suffix = url.pathname.slice(prefix.length);
  if (
    !rules.some(
      ([method, pattern]) => req.method === method && pattern.test(suffix),
    )
  )
    return false;
  const keys = [...url.searchParams.keys()];
  if (!keys.length) return true;
  const checkpoint = new RegExp(`^/checkpoints/${id}$`).test(suffix);
  if (req.method === "GET" && checkpoint && keys.includes("restoreId")) {
    if (
      keys.length > 2 ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !["restoreId", "catalog"].includes(key))
    )
      return false;
    return (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        url.searchParams.get("restoreId") || "",
      ) &&
      (!keys.includes("catalog") || url.searchParams.get("catalog") === "paged")
    );
  }
  if (keys.length !== 1 || req.method !== "GET") return false;
  if (keys[0] === "catalog")
    return (
      url.searchParams.get("catalog") === "paged" &&
      (suffix === "/checkpoints/latest" ||
        new RegExp(`^/checkpoints/${id}$`).test(suffix))
    );
  if (keys[0] !== "cursor") return false;
  const cursor = url.searchParams.get("cursor");
  if (new RegExp(`^/checkpoints/${id}/namespaces$`).test(suffix))
    return /^[A-Za-z0-9_.-]{1,2048}$/.test(cursor);
  return suffix === "/checkpoints"
    ? /^\d{1,20}$/.test(cursor)
    : new RegExp(`^/namespace-versions/${id}/records$`).test(suffix) &&
        new RegExp(`^${hash}$`).test(cursor);
}
/** Dedicated binary proxy; bounded bytes stream through Main without converting
 * the body to JSON/base64. Existing v1 parsers and wire formats are untouched. */
export function installBackupV2Proxy(
  app,
  { enabled, requireSession, csrf, hubOrigin, requestFetch = fetch, fail },
) {
  app.register(async (scoped) => {
    scoped.addContentTypeParser(
      "application/octet-stream",
      (_req, payload, done) => done(null, payload),
    );
    scoped.route({
      method: ["GET", "POST", "PUT", "DELETE"],
      url: prefix + "/*",
      bodyLimit: 262144,
      handler: async (req, reply) => {
        if (!enabled || !backupV2Operation(req))
          throw fail("Backup operation not found.", 404, "HUB_NOT_FOUND");
        const s = await requireSession(req);
        if (req.method !== "GET") csrf(req, s);
        if (
          req.headers["x-atlas-profile-id"] &&
          req.headers["x-atlas-profile-id"] !== s.grant?.profileId
        )
          throw fail(
            "Cloud backup account changed; local data is retained.",
            409,
            "BACKUP_PROFILE_CHANGED",
          );
        const suffix = req.url.slice(prefix.length),
          binary = req.method === "PUT";
        if (
          binary &&
          req.headers["content-type"]?.split(";")[0] !==
            "application/octet-stream"
        )
          throw fail("Binary backup part required.", 415, "BACKUP_INVALID");
        const abort = new AbortController();
        let timer;
        const progress = () => {
          clearTimeout(timer);
          timer = setTimeout(() => abort.abort(), 45000);
        };
        progress();
        const closed = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        req.raw.once("aborted", closed);
        reply.raw.once("close", closed);
        let stream;
        try {
          let body;
          if (binary) {
            let bytes = 0;
            const limit = new Transform({
              transform(chunk, _encoding, done) {
                bytes += chunk.length;
                if (chunk.length) progress();
                done(
                  bytes > 262144
                    ? Object.assign(new Error("Backup part too large"), {
                        statusCode: 413,
                        code: "BACKUP_PART_TOO_LARGE",
                      })
                    : null,
                  chunk,
                );
              },
            });
            stream = req.body.pipe(limit);
            body = stream;
          } else if (req.body !== undefined) body = JSON.stringify(req.body);
          const response = await requestFetch(
            hubOrigin + "/api/hub/branch/profile/backups/v2" + suffix,
            {
              method: req.method,
              headers: {
                "accept-encoding": "identity",
                "x-atlas-branch-id": s.branch.id,
                authorization: "Bearer " + s.branch.secret,
                "x-atlas-branch-session": s.token,
                ...(body === undefined
                  ? {}
                  : {
                      "content-type": binary
                        ? "application/octet-stream"
                        : "application/json",
                    }),
              },
              ...(body === undefined ? {} : { body }),
              ...(binary ? { duplex: "half" } : {}),
              redirect: "error",
              signal: abort.signal,
            },
          );
          progress();
          reply.code(response.status).header("cache-control", "no-store");
          const retryAfter = response.headers.get("retry-after");
          if (
            [429, 503].includes(response.status) &&
            /^\d{1,3}$/.test(retryAfter || "") &&
            Number(retryAfter) >= 1 &&
            Number(retryAfter) <= 900
          )
            reply.header("retry-after", retryAfter);
          const type =
            response.headers.get("content-type") || "application/json";
          reply.type(type.split(";")[0]);
          if (
            req.method === "GET" &&
            response.ok &&
            new RegExp(`^/checkpoints/${id}(?:\\?|$)`).test(suffix) &&
            response.headers.get("x-atlas-restore-reader") === "v1"
          )
            reply.header("x-atlas-restore-reader", "v1");
          if (response.body) {
            const incoming = Readable.fromWeb(response.body);
            incoming.on("data", (chunk) => {
              if (chunk.length) progress();
            });
            // Compress exactly once at Main's final hop. Fetch may already have
            // decoded an upstream body: never copy its Content-Encoding/Length.
            const compress =
              activeCompression < 2 &&
              req.method === "GET" &&
              response.ok &&
              acceptsGzip(req.headers["accept-encoding"]) &&
              (type.includes("application/json") ||
                /\/parts\/[a-f0-9]{64}$/.test(suffix)) &&
              (!response.headers.get("content-length") ||
                Number(response.headers.get("content-length")) >= 1024);
            reply.header("vary", "Accept-Encoding");
            const outgoing = compress
              ? incoming.pipe(
                  createGzip({
                    level: zlibConstants.Z_BEST_SPEED,
                    flush: zlibConstants.Z_SYNC_FLUSH,
                  }),
                )
              : incoming;
            if (compress) {
              activeCompression++;
              outgoing.once("close", () => {
                activeCompression--;
              });
              reply.header("content-encoding", "gzip");
              incoming.once("error", (error) => outgoing.destroy(error));
            }
            outgoing.once("close", () => incoming.destroy());
            // Cleanup follows stream completion, not the handler returning.
            outgoing.once("close", () => {
              clearTimeout(timer);
              req.raw.off("aborted", closed);
              reply.raw.off("close", closed);
            });
            return reply.send(outgoing);
          }
          clearTimeout(timer);
          return reply.send();
        } catch (error) {
          clearTimeout(timer);
          req.raw.off("aborted", closed);
          reply.raw.off("close", closed);
          stream?.destroy();
          if (error.statusCode === 413) throw error;
          throw fail(
            "Cloud backup is temporarily unavailable. Local saves are unaffected.",
            503,
            "HUB_UNAVAILABLE",
          );
        }
      },
    });
  });
}
