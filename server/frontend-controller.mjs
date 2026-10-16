/** Private qualification seam for the combined frontend runtime. Installing
 * these routes is explicit; advertising transport capability alone never turns
 * the public interface on. Existing legacy leases keep their original protocol.
 * Browsing-owner authentication is separate from administrator authentication.
 */
import { token } from "./store.mjs";
import { connectionError } from "./node-ticket.mjs";
import { installSandboxStorageRendezvous } from "./sandbox-storage-rendezvous.mjs";
import { installSandboxCookieRendezvous } from "./sandbox-cookie-rendezvous.mjs";
import { installFrontendDocumentReservations } from "./frontend-documents.mjs";

const ROOT = "/api/browse/controller";
const fail = (code, message, status = 400) =>
  connectionError(message, status, code);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

export function installFrontendControllerAPI(
  app,
  { pool, originFor, limitBrowse, administrator },
) {
  const assignments = pool.frontendAssignments;
  // Only a trusted, same-frontend document can register storage/cookie owners.
  // Do not infer authority from a claimed website origin or an opaque Origin.
  const authorizeOwner = (req) => {
    const origin = originFor(req);
    if (req.headers.origin !== origin) return null;
    const raw = req.headers["x-atlas-browse-session"],
      generation = req.headers["x-atlas-browse-generation"];
    if (typeof generation !== "string" || !/^[1-9][0-9]{0,9}$/.test(generation))
      return null;
    return assignments.identity(raw, origin, Number(generation));
  };
  const ownerOptions = {
    originFor,
    authorizeOwner,
    validateOwner: assignments.validate,
  };
  installSandboxStorageRendezvous(app, ownerOptions);
  installSandboxCookieRendezvous(app, ownerOptions);

  function browserSession(req, reply) {
    const secure = new URL(originFor(req)).protocol === "https:",
      name = secure
        ? "__Host-atlas-browser-session-v2"
        : "atlas-browser-session-v2";
    const cookies = (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + "="));
    const value = cookies.length === 1 ? cookies[0].slice(name.length + 1) : "";
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    const fresh = token();
    // A session cookie deliberately has no Max-Age/Expires. It is shared by
    // concurrent trusted windows but cannot be read by opaque website scripts.
    // This is not the admin cookie, an assignment token or a server-side save.
    reply.header(
      "Set-Cookie",
      `${name}=${fresh}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    );
    return fresh;
  }
  function trusted(req) {
    if (req.headers.origin !== originFor(req))
      throw fail(
        "CONTROLLER_ORIGIN_REQUIRED",
        "Frontend origin required.",
        403,
      );
  }
  app.post(ROOT + "/bootstrap", async (req, reply) => {
    trusted(req);
    limitBrowse(req);
    if (!exact(req.body ?? {}, []))
      throw fail(
        "INVALID_INITIAL_REQUEST",
        "Invalid initial browsing bootstrap.",
      );
    const browserSessionId = browserSession(req, reply);
    return assignments.bootstrap(originFor(req), browserSessionId);
  });
  app.post(ROOT + "/initial-retire", async (req, reply) => {
    trusted(req);
    limitBrowse(req);
    if (!exact(req.body, ["requestId"]))
      throw fail(
        "INVALID_INITIAL_REQUEST",
        "Invalid initial browsing retirement.",
      );
    return assignments.retireInitial(
      req.body.requestId,
      originFor(req),
      browserSession(req, reply),
    );
  });
  app.post(ROOT + "/session", async (req, reply) => {
    trusted(req);
    limitBrowse(req);
    const input = req.body ?? {};
    if (!exact(input, ["intent", "session", "generation", "requestId"]))
      throw fail("INVALID_SESSION", "Invalid controller session operation.");
    if (!input.session && !input.requestId)
      throw fail(
        "INITIAL_REQUEST_REQUIRED",
        "Bootstrap and persist an initial browsing request before allocation.",
      );
    const browserSessionId = browserSession(req, reply);
    const grant = await assignments.operate(input, originFor(req), {
      browserSessionId,
    });
    return { ...grant, browserSessionId };
  });
  app.post(ROOT + "/commit", async (req, reply) => {
    trusted(req);
    limitBrowse(req);
    if (!exact(req.body, ["previousSession", "session", "generation"]))
      throw fail("INVALID_SESSION", "Invalid replacement confirmation.");
    const grant = await assignments.commit(
      req.body.previousSession,
      req.body.session,
      originFor(req),
      req.body.generation,
    );
    return { ...grant, browserSessionId: browserSession(req, reply) };
  });
  app.post(ROOT + "/resource-owner", async (req) => {
    trusted(req);
    limitBrowse(req);
    if (!exact(req.body, ["session", "generation"]))
      throw fail("INVALID_SESSION", "Invalid native resource owner request.");
    return pool.resourceOwner(
      req.body.session,
      originFor(req),
      req.body.generation,
    );
  });
  app.delete(ROOT + "/session", (req) => {
    trusted(req);
    if (
      !exact(req.body, ["session", "generation"]) ||
      !assignments.identity(
        req.body.session,
        originFor(req),
        req.body.generation,
      )
    )
      throw fail("INVALID_SESSION", "Invalid controller session release.");
    pool.release(req.body.session, originFor(req));
    return { ok: true };
  });
  app.post("/api/admin/nodes/controller-select", async (req, reply) => {
    trusted(req);
    administrator(req, true);
    limitBrowse(req);
    if (!exact(req.body, ["session", "node"]))
      throw fail("INVALID_SESSION", "Invalid explicit selection.");
    // This only reserves. The trusted frontend probes the candidate relay before
    // committing it, so a failed replacement cannot release the working socket.
    const grant = await assignments.select(
      req.body.session,
      originFor(req),
      req.body.node,
    );
    return { ...grant, browserSessionId: browserSession(req, reply) };
  });
  return installFrontendDocumentReservations(app, {
    pool,
    originFor,
    limitBrowse,
  });
}
