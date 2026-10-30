import {installBackupV2Proxy, backupV2Operation} from "./hub-backups-v2-proxy.mjs";
import { installLegacySyncRetirement } from "./legacy-sync-retirement.mjs";
import { createIdentityVerification } from "./identity-verification.mjs";
/** Trusted branch gateway. Hub credentials never enter browser-visible JSON. */
import { onlyNativeResourceEnrollmentCookies } from "./opaque-ambient-cookies.mjs";
import { createEntryLaunchLinkReader, normalizeEntryLaunchLink } from "./entry-launch-link.mjs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const random = () => randomBytes(32).toString("base64url");
const fail = (message, statusCode = 400, code = "HUB_INVALID") =>
  Object.assign(Error(message), { statusCode, code });
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const token = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function hubBranchSettings(env = process.env) {
  return {
    hubOrigin: env.ATLAS_HUB_ORIGIN || "",
    hubBranchId: env.ATLAS_HUB_BRANCH_ID || "",
    hubBranchSecret: env.ATLAS_HUB_BRANCH_SECRET || "",
    hubUiOnlyLab: env.ATLAS_HUB_UI_ONLY_LAB === "true",
    hubServiceSecret: env.ATLAS_HUB_SERVICE_SECRET || "",
  };
}
export function validateHubBranchConfig(config) {
  if (!config.hubOrigin) return false;
  let url;
  try {
    url = new URL(config.hubOrigin);
  } catch {
    throw Error("ATLAS_HUB_ORIGIN must be an HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== config.hubOrigin ||
    url.username ||
    url.password
  )
    throw Error("ATLAS_HUB_ORIGIN must be an HTTPS origin.");
  const initial = uuid(config.hubBranchId) && token(config.hubBranchSecret);
  const entries =
    Array.isArray(config.hubBranches) && config.hubBranches.length > 0;
  if (
    !initial &&
    !entries &&
    !(
      typeof config.hubServiceSecret === "string" &&
      config.hubServiceSecret.length >= 32
    )
  )
    throw Error(
      "Hub branch credentials or a private registry control credential are required.",
    );
  if (entries)
    for (const e of config.hubBranches) {
      if (
        !e ||
        !uuid(e.id) ||
        !token(e.secret) ||
        new URL(e.origin).origin !== e.origin ||
        !e.origin.startsWith("https://")
      )
        throw Error("Invalid server-owned branch registry entry.");
    }
  const profileRuntime =
    config.profileRuntimeEnabled === true &&
    config.profileRuntimeActivated === true &&
    !config.opaqueRuntimeEnabled &&
    !config.opaqueRuntimeActivated &&
    (config.sameOriginRuntime
      ? config.profileRuntimeEngine === "scramjet-controller"
      : config.profileRuntimeEngine === undefined);
  if (!config.hubUiOnlyLab &&
    ((config.sameOriginRuntime && !profileRuntime) ||
      !(config.opaqueRuntimeActivated && !config.profileRuntimeEnabled) && !profileRuntime))
    throw Error(
      config.profileRuntimeEnabled || config.profileRuntimeActivated
        ? "Hub profiles require an explicitly activated profile-backed runtime; use UI-only lab mode to test the account interface without browsing."
        : "Hub profiles require verified opaque runtime isolation; use UI-only lab mode to test the account interface without browsing.",
    );
  return true;
}
export async function installHubBranch(
  app,
  {
    config,
    originFor,
    seal,
    unseal,
    store,
    pool,
    authorizeReservedDocument,
    fetch: requestFetch = globalThis.fetch,
    now = Date.now,
  },
) {
  installLegacySyncRetirement(app);
  if (store?.get("hubCurrentOrigin"))
    config.hubOrigin = store.get("hubCurrentOrigin");
  const enabled = validateHubBranchConfig(config),
    cache = new Map();
  const verification = createIdentityVerification();
  const readEntryLaunchLink = createEntryLaunchLinkReader({ fetch: requestFetch, now });
  app.get("/api/hub/launch-link", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return readEntryLaunchLink(enabled ? config.hubOrigin : "");
  });
  app.get("/api/hub/document-announcement", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!enabled) return { url: "", hubEnabled: false, browserEnabled: false,
      announcementId: "", acknowledged: true };
    const s = await requireSession(req);
    const data = await hub("/api/hub/branch/document-announcement", "GET", undefined, s.token, s.branch);
    const presentation = normalizeEntryLaunchLink(data);
    if (!presentation.url || typeof data.acknowledged !== "boolean" ||
        !/^[a-f0-9]{64}$/.test(data.announcementId || "") ||
        createHash("sha256").update(presentation.url).digest("hex") !== data.announcementId)
      throw fail("The document announcement could not be checked.", 502, "HUB_ANNOUNCEMENT_UNAVAILABLE");
    return { ...presentation, announcementId: data.announcementId, acknowledged: data.acknowledged };
  });
  app.post("/api/hub/document-announcement/ack", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!enabled) throw fail("Document announcements are not enabled.", 503);
    const s = await requireSession(req); csrf(req, s);
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || !/^[a-f0-9]{64}$/.test(req.body.announcementId || ""))
      throw fail("Invalid document acknowledgement.", 400, "HUB_INVALID");
    const data = await hub("/api/hub/branch/document-announcement/ack", "POST",
      { announcementId: req.body.announcementId }, s.token, s.branch);
    if (data.acknowledged !== true || data.announcementId !== req.body.announcementId)
      throw fail("The document acknowledgement was not confirmed.", 502, "HUB_ANNOUNCEMENT_UNAVAILABLE");
    return { acknowledged: true, announcementId: data.announcementId };
  });
  pool?.setRequireHubOwnership(enabled);
  const memoryRegistry = {};
  const getRegistry = () => store?.get("hubBranchRegistry") || memoryRegistry;
  const writeRegistry = (value) => {
    if (store) store.set("hubBranchRegistry", value);
    else {
      for (const k of Object.keys(memoryRegistry)) delete memoryRegistry[k];
      Object.assign(memoryRegistry, value);
    }
  };
  // Cache parsing/decryption by the exact stored value, not by elapsed time.
  // Every lookup still reads the current registry row, so edits/revocations
  // invalidate immediately. Mutation routes retain fresh getRegistry() copies.
  const registryRead = store?.db?.prepare?.("SELECT value FROM settings WHERE key=?");
  let registryJSON, registryValue = memoryRegistry;
  const branchEntries = new Map();
  function registryRecord(origin) {
    if (!registryRead) return getRegistry()[origin];
    const raw = registryRead.get("hubBranchRegistry")?.value;
    if (raw !== registryJSON) {
      registryValue = raw === undefined ? memoryRegistry : (JSON.parse(raw) || memoryRegistry);
      registryJSON = raw;
    }
    return registryValue[origin];
  }
  function branchFor(req) {
    const origin = originFor(req);
    let entry;
    const record = registryRecord(origin);
    if (record) {
      try {
        const prior = branchEntries.get(origin);
        if (prior?.record === record) entry = prior.entry;
        else {
          entry = JSON.parse(unseal(record));
          if (branchEntries.size >= 512) branchEntries.delete(branchEntries.keys().next().value);
          branchEntries.set(origin, { record, entry });
        }
      } catch {
        throw fail(
          "Branch registry entry is unavailable.",
          503,
          "HUB_BRANCH_UNAVAILABLE",
        );
      }
    }
    if (!entry) entry = config.hubBranches?.find((e) => e.origin === origin);
    if (
      !entry &&
      origin === config.appOrigin &&
      uuid(config.hubBranchId) &&
      token(config.hubBranchSecret)
    )
      entry = {
        id: config.hubBranchId,
        secret: config.hubBranchSecret,
        generation: 1,
      };
    if (!entry || !uuid(entry.id) || !token(entry.secret))
      throw fail(
        "This Atlas address is not connected to the Hub.",
        503,
        "HUB_BRANCH_UNAVAILABLE",
      );
    return {
      ...entry,
      generation: entry.generation || 1,
      origin,
      // Only a sealed, server-owned registry record may schedule a transition.
      transition: record ? entry.transition : undefined,
    };
  }
  const cacheKey = (s) =>
    s.origin +
    ":" +
    [s.grant.branchId, s.generation, s.grant.userId, s.grant.profileId,
      s.grant.sessionId, s.grant.contextId].join(":") + ":" +
    createHash("sha256").update(s.token).digest("hex");
  const secure = new URL(config.appOrigin).protocol === "https:";
  const sessionName = secure ? "__Host-atlas-hub" : "atlas-hub-lab";
  const pendingName = secure
    ? "__Host-atlas-hub-pending"
    : "atlas-hub-pending-lab";
  const cookie = (name, value, age) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const read = (req, name) => {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1);
    if (!raw) return null;
    try {
      return JSON.parse(unseal(raw));
    } catch {
      return null;
    }
  };
  const safeGrant = (g) => ({
    protocol: 1,
    userId: g.userId,
    profileId: g.profileId,
    branchId: g.branchId,
    sessionId: g.sessionId,
    contextId: g.contextId,
    expiresAt: g.expiresAt,
    grantExpiresAt: g.grantExpiresAt,
  });
  const checkGrant = (g, branch, grantExpiry = true) =>
    g &&
    g.protocol === 1 &&
    g.branchId === branch.id &&
    uuid(g.userId) &&
    uuid(g.profileId) &&
    uuid(g.sessionId) &&
    typeof g.contextId === "string" &&
    Date.parse(g.expiresAt) > now() &&
    (!grantExpiry || Date.parse(g.grantExpiresAt) > now());
  async function hub(path, method, body, sessionToken, branch, timeoutMs = 6000) {
    if (!branch)
      throw fail("Branch context required.", 503, "HUB_BRANCH_UNAVAILABLE");
    let r;
    try {
      r = await requestFetch(config.hubOrigin + path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
          ...(sessionToken ? { "x-atlas-branch-session": sessionToken } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw fail(
        "Atlas Hub is temporarily unavailable. Retry without signing out.",
        503,
        "HUB_UNAVAILABLE",
      );
    }
    let data;
    try {
      data = await r.json();
    } catch (error) {
      // Record only transport metadata: never log credentials, identity, body,
      // or the parsing error message (which can include private response text).
      app.log.error({
        upstreamPath: path,
        upstreamStatus: r.status,
        upstreamContentType: r.headers.get("content-type"),
        errorName: typeof error?.name === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : undefined,
        errorCode: typeof error?.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined,
      }, "Atlas Hub response could not be decoded.");
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw fail(
        timedOut
          ? "Atlas Hub is temporarily unavailable. Retry without signing out."
          : "Atlas Hub returned an invalid response.",
        timedOut ? 503 : 502,
        "HUB_UNAVAILABLE",
      );
    }
    if (!r.ok) {
      const e = fail(
        r.status === 401
          ? "Authenticate with Atlas Hub again."
          : r.status === 403
            ? "This account does not currently have browsing access."
            : "The Hub request did not complete.",
        r.status === 401
          ? 401
          : r.status === 403
            ? 403
            : r.status >= 500
              ? 503
              : r.status,
        "HUB_REQUEST_FAILED",
      );
      if (
        typeof data?.error?.code === "string" &&
        /^HUB_[A-Z_]+$/.test(data.error.code)
      )
        e.code = data.error.code;
      throw e;
    }
    return data;
  }
  // Reuse verification only within one HTTP request. Cross-request expiry,
  // explicit fresh checks, revocation and CSRF validation remain unchanged.
  const requestSessions = new WeakMap();
  const requestFailures = new WeakMap();
  async function requireSession(req, { fresh = false } = {}) {
    if (!enabled) return null;
    if (fresh) { requestSessions.delete(req); requestFailures.delete(req); }
    else if (requestFailures.has(req)) throw requestFailures.get(req);
    else if (requestSessions.has(req)) return requestSessions.get(req);
    const branch = branchFor(req);
    const s = read(req, sessionName);
    if (
      !s ||
      !token(s.token) ||
      s.origin !== originFor(req) ||
      !checkGrant(s.grant, branch, false) ||
      s.generation !== branch.generation
    )
      throw fail(
        "Authenticate with Atlas Hub to continue.",
        401,
        "HUB_SESSION_EXPIRED",
      );
    const key = cacheKey(s);
    let cached = cache.get(key);
    if (
      fresh ||
      !cached ||
      now() - cached.checkedAt >= 30000 ||
      Date.parse(cached.grant.grantExpiresAt) <= now()
    ) {
      try {
        const r = await verification.run(key, () => hub(
          "/api/hub/branch/session", "POST", {}, s.token, branch,
        ));
        const currentBranch = branchFor(req);
        if (currentBranch.id !== branch.id || currentBranch.generation !== branch.generation ||
            currentBranch.secret !== branch.secret)
          throw fail("Hub branch changed.", 401, "HUB_SESSION_EXPIRED");
        if (
          !checkGrant(r.grant, branch) ||
          r.grant.userId !== s.grant.userId ||
          r.grant.profileId !== s.grant.profileId ||
          r.grant.sessionId !== s.grant.sessionId ||
          r.grant.contextId !== s.grant.contextId
        )
          throw fail(
            "Hub session identity changed.",
            401,
            "HUB_SESSION_EXPIRED",
          );
        cached = { grant: safeGrant(r.grant), checkedAt: now() };
        cache.set(key, cached);
      } catch (e) {
        if (e.statusCode === 401 || e.statusCode === 403) {
          verification.invalidate(key);
          cache.delete(key);
          pool?.revokeHubSession(s.grant.sessionId);
        }
        throw e;
      }
    }
    if (cache.size > 10000)
      for (const [k, v] of cache)
        if (now() - v.checkedAt > 45000) cache.delete(k);
    req.hubGrant = cached.grant;
    req.hubValidatedAt = cached.checkedAt;
    pool?.refreshHubIdentity(cached.grant, cached.checkedAt);
    const verified = { ...s, grant: cached.grant, branch };
    requestSessions.set(req, verified);
    return verified;
  }
  function csrf(req, s) {
    if (
      req.headers.origin !== originFor(req) ||
      !same(req.headers["x-atlas-hub-csrf"], s.csrf)
    )
      throw fail("Refresh Atlas before retrying this action.", 403, "HUB_CSRF");
  }
  app.get("/api/hub/state", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!enabled) return { enabled: false };
    try {
      const s = await requireSession(req);
      return {
        enabled: true,
        authenticated: true,
        hubOrigin: config.hubOrigin,
        csrf: s.csrf,
        grant: safeGrant(s.grant),
        uiOnlyLab: !!config.hubUiOnlyLab,
        browsingAvailable: !config.hubUiOnlyLab,
        ...(s.branch.transition?.active === true &&
        Number.isSafeInteger(s.branch.transition.revision) &&
        s.branch.transition.revision > 0
          ? {
              endpointTransition: {
                revision: s.branch.transition.revision,
                hubOrigin: config.hubOrigin,
              },
            }
          : {}),
      };
    } catch (e) {
      if (e.code === "HUB_BRANCH_UNAVAILABLE")
        return {
          enabled: true,
          authenticated: false,
          hubOrigin: config.hubOrigin,
          branchAvailable: false,
        };
      if (e.statusCode !== 401 && e.statusCode !== 403) throw e;
      return {
        enabled: true,
        authenticated: false,
        hubOrigin: config.hubOrigin,
        blocked: e.statusCode === 403,
      };
    }
  });
  app.post("/api/hub/signin", async (req, reply) => {
    if (!enabled) throw fail("Hub authentication is not enabled.", 404);
    if (req.headers.origin !== originFor(req))
      throw fail("Origin required.", 403);
    const origin = originFor(req);
    const branch = branchFor(req);
    let destination = "/";
    try {
      const target = new URL(req.body?.returnTo || "/", origin);
      if (
        target.origin === origin &&
        ["/", "/popout", "/support"].includes(target.pathname) &&
        target.href.length < 4096
      )
        destination = target.pathname + target.search;
    } catch {}
    const pending = {
      branchId: branch.id,
      generation: branch.generation,
      state: random(),
      verifier: random(),
      origin,
      destination,
      expires: now() + 600000,
    };
    reply.header(
      "Set-Cookie",
      cookie(pendingName, seal(JSON.stringify(pending)), 600),
    );
    const url = new URL("/authorize", config.hubOrigin);
    url.searchParams.set("branchId", branch.id);
    url.searchParams.set("callbackOrigin", origin);
    url.searchParams.set(
      "codeChallenge",
      createHash("sha256").update(pending.verifier).digest("base64url"),
    );
    url.searchParams.set("state", pending.state);
    return { redirect: url.href };
  });
  app.get("/auth/hub/callback", async (req, reply) => {
    if (!enabled) throw fail("Not found.", 404);
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer");
    const branch = branchFor(req);
    const p = read(req, pendingName);
    if (
      !p ||
      p.origin !== originFor(req) ||
      p.branchId !== branch.id ||
      p.generation !== branch.generation ||
      p.expires <= now() ||
      !same(p.state, req.query?.state) ||
      !token(req.query?.code)
    )
      throw fail(
        "This sign-in attempt expired. Start again from Atlas.",
        400,
        "HUB_HANDOFF_INVALID",
      );
    reply.header("Set-Cookie", cookie(pendingName, "", 0));
    try {
      const r = await hub(
        "/api/hub/branch/exchange",
        "POST",
        {
          code: req.query.code,
          verifier: p.verifier,
          callbackOrigin: p.origin,
        },
        undefined,
        branch,
      );
      if (
        !same(r.state, p.state) ||
        !token(r.branchSession) ||
        !checkGrant(r.grant, branch)
      )
        throw fail("Hub sign-in response did not match this browser.", 401);
      const s = {
        generation: branch.generation,
        token: r.branchSession,
        grant: safeGrant(r.grant),
        csrf: random(),
        origin: p.origin,
      };
      cache.set(cacheKey(s), {
        grant: s.grant,
        checkedAt: now(),
      });
      const age = Math.max(
        1,
        Math.floor((Date.parse(s.grant.expiresAt) - now()) / 1000),
      );
      reply.header("Set-Cookie", [
        cookie(pendingName, "", 0),
        cookie(sessionName, seal(JSON.stringify(s)), age),
      ]);
      return reply.redirect(p.destination);
    } catch {
      return reply.redirect("/?hub_error=signin_failed");
    }
  });
  app.post("/api/hub/logout", async (req, reply) => {
    if (!enabled) throw fail("Not found.", 404);
    if (req.headers.origin !== originFor(req))
      throw fail("Origin required.", 403);
    const local = read(req, sessionName);
    if (local?.csrf) csrf(req, local);
    let revocationPending = false;
    try {
      const session = await requireSession(req);
      if (session)
        await hub(
          "/api/hub/branch/session",
          "DELETE",
          undefined,
          session.token,
          session.branch,
        );
    } catch (error) {
      // Signing out locally must not require a healthy upstream authority.
      revocationPending = error.statusCode !== 401 && error.statusCode !== 403;
    } finally {
      if (local?.token && local?.grant?.branchId && local.origin) {
        verification.invalidate(cacheKey(local));
        cache.delete(cacheKey(local));
        pool?.revokeHubSession(local.grant.sessionId);
      }
      reply.header("Set-Cookie", cookie(sessionName, "", 0));
    }
    return { ok: true, revocationPending };
  });
  installBackupV2Proxy(app,{enabled,requireSession,csrf,hubOrigin:config.hubOrigin,requestFetch,fail});
  const allowed = [
    ["GET", /^\/preferences$/],
    ["POST", /^\/preferences$/],
    ["GET", /^$/],
    ["POST", /^\/recoveries$/],
    ["GET", /^\/recoveries$/],
    ["GET", /^\/recoveries\/[0-9a-f-]{36}$/],
    ["POST", /^\/(stream|writers|commits|chunks|imports)$/],
    ["PUT", /^\/writers$/],
    ["DELETE", /^\/writers$/],
    ["GET", /^\/chunks\/[a-f0-9]{64}$/],
    ["POST", /^\/writers\/takeover$/],
    ["GET", /^\/writers\/requests$/],
    ["POST", /^\/writers\/requests\/[0-9a-f-]{36}\/ack$/],
    ["GET", /^\/receipts\/[A-Za-z0-9_-]{16,96}$/],
    ["POST", /^\/imports\/[0-9a-f-]{36}\/commit$/],
    ["DELETE", /^\/imports\/[0-9a-f-]{36}$/],
  ];
  app.post("/api/hub/profile/chunks", { bodyLimit: 6_000_000 }, proxyProfile);
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/api/hub/profile",
    bodyLimit: 2_000_000,
    handler: proxyProfile,
  });
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/api/hub/profile/*",
    bodyLimit: 2_000_000,
    handler: proxyProfile,
  });
  const profileOperation = req => {
    if (backupV2Operation(req)) return true;
    if (req.url.includes("?")) return false;
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/api/hub/profile/events") return true;
    if (!(path === "/api/hub/profile" || path.startsWith("/api/hub/profile/"))) return false;
    const suffix = path.slice("/api/hub/profile".length);
    return allowed.some(([method, pattern]) => method === req.method && pattern.test(suffix));
  };
  async function profileRateSubject(req) {
    if (!enabled || !profileOperation(req)) return null;
    const s = await requireSession(req);
    if (req.method !== "GET") csrf(req, s);
    return { userId: s.grant.userId, profileId: s.grant.profileId };
  }
  async function proxyProfile(req) {
    if (!enabled) throw fail("Not found.", 404);
    const suffix = req.url.split("?")[0].slice("/api/hub/profile".length);
    if (
      req.url.includes("?") ||
      !allowed.some(
        ([method, pattern]) => method === req.method && pattern.test(suffix),
      )
    )
      throw fail("Profile operation not found.", 404);
    const s = await requireSession(req);
    if (req.method !== "GET") csrf(req, s);
    return hub(
      "/api/hub/branch/profile" + suffix,
      req.method,
      req.method === "GET" ? undefined : req.body,
      s.token,
      s.branch,
    );
  }
  // Fixed, separately authenticated event routes; never a caller-selected proxy.
  const eventStreams = new Set();
  app.addHook("preClose", async () => {
    for (const abort of eventStreams) abort.abort();
  });
  for (const channel of [
    { local: "/api/hub/support/events", upstream: "/api/hub/branch/events", name: "Support notifications" },
    { local: "/api/hub/profile/events", upstream: "/api/hub/branch/profile/events", name: "Save notifications" },
  ]) app.get(channel.local, async (req, reply) => {
    if (!enabled || req.url.includes("?"))
      throw fail("Event stream not found.", 404);
    const session = await requireSession(req),
      abort = new AbortController();
    eventStreams.add(abort);
    const timeout = setTimeout(() => abort.abort(), 10000);
    timeout.unref();
    const close = () => {
      abort.abort();
      eventStreams.delete(abort);
    };
    reply.raw.once("close", close);
    let upstream;
    try {
      upstream = await requestFetch(
        config.hubOrigin + channel.upstream,
        {
          method: "GET",
          headers: {
            authorization: "Bearer " + session.branch.secret,
            "x-atlas-branch-id": session.branch.id,
            "x-atlas-branch-session": session.token,
            accept: "text/event-stream",
          },
          signal: abort.signal,
          redirect: "error",
        },
      );
    } catch {
      clearTimeout(timeout);
      close();
      throw fail(channel.name + " are temporarily unavailable.", 503);
    }
    clearTimeout(timeout);
    if (
      !upstream.ok ||
      !upstream.headers.get("content-type")?.startsWith("text/event-stream") ||
      !upstream.body
    ) {
      close();
      throw fail(
        channel.name + " are temporarily unavailable.",
        upstream.status === 401 || upstream.status === 403
          ? upstream.status
          : 503,
      );
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    reply.raw.flushHeaders();
    try {
      for await (const chunk of upstream.body) {
        if (abort.signal.aborted) break;
        if (reply.raw.writableLength > 32768) break;
        reply.raw.write(chunk);
      }
    } catch {
    } finally {
      close();
      reply.raw.end();
    }
  });
  const announcementUuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const announcementDetail = new RegExp("^/announcements/" + announcementUuid + "$");
  const announcementRead = new RegExp("^/announcements/" + announcementUuid + "/read$");
  const supportAllowed = [
    ["GET", /^\/(notifications|tickets)$/],
    ["GET", announcementDetail],
    ["POST", announcementRead],
    ["POST", /^\/(tickets|legacy-tickets\/claim)$/],
    ["GET", /^\/tickets\/[0-9a-f-]{36}$/],
    ["GET", /^\/tickets\/[0-9a-f-]{36}\/attachments\/[0-9a-f-]{36}$/],
    ["POST", /^\/tickets\/[0-9a-f-]{36}\/(messages|read)$/],
  ];
  const supportMediaBodyLimit = 29 * 1024 * 1024;
  async function proxySupport(req, reply) {
    if (!enabled) throw fail("Not found.", 404);
    const suffix = req.url.slice("/api/hub/support".length);
    if (
      req.url.includes("?") ||
      !supportAllowed.some(
        ([method, re]) => method === req.method && re.test(suffix),
      )
    )
      throw fail("Support operation not found.", 404);
    const session = await requireSession(req);
    if (req.method !== "GET") csrf(req, session);
    reply.header("Cache-Control", "private, no-store");
    const mediaTransfer = suffix.includes("/attachments/") ||
      (req.method === "POST" && (suffix === "/tickets" || suffix.endsWith("/messages")));
    return hub(
      "/api/hub/branch" + suffix,
      req.method,
      req.method === "GET" ? undefined : req.body,
      session.token,
      session.branch,
      mediaTransfer ? 30000 : 6000,
    );
  }
  // Only message submission routes accept bounded media payloads. The remaining
  // support API keeps its existing small body allowance and fixed-path proxy.
  app.post("/api/hub/support/tickets", { bodyLimit: supportMediaBodyLimit }, proxySupport);
  app.post("/api/hub/support/tickets/:id/messages", { bodyLimit: supportMediaBodyLimit }, proxySupport);
  app.route({
    method: ["GET", "POST"],
    url: "/api/hub/support/*",
    bodyLimit: 12000,
    handler: proxySupport,
  });
  app.post("/api/internal/hub/branches", async (req) => {
    if (
      !enabled ||
      typeof config.hubServiceSecret !== "string" ||
      config.hubServiceSecret.length < 32 ||
      !store
    )
      throw fail("Hub registry control is not configured.", 503);
    if (
      req.headers.origin ||
      !same(req.headers.authorization, "Bearer " + config.hubServiceSecret)
    )
      throw fail("Service authorization required.", 401);
    const b = req.body;
    let url;
    try {
      url = new URL(b?.origin);
    } catch {
      throw fail("Invalid branch origin.");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== b.origin ||
      !uuid(b.id) ||
      !token(b.secret) ||
      !Number.isSafeInteger(b.generation) ||
      b.generation < 1
    )
      throw fail("Invalid branch registry entry.");
    const registry = { ...getRegistry() };
    let previous;
    if (registry[b.origin]) {
      try {
        previous = JSON.parse(unseal(registry[b.origin]));
      } catch {
        throw fail("Existing registry entry is unreadable.", 409);
      }
    }
    if (previous && b.generation <= previous.generation) {
      if (
        b.generation === previous.generation &&
        b.id === previous.id &&
        same(b.secret, previous.secret)
      )
        return { ok: true, generation: b.generation, replayed: true };
      throw fail("Branch registry generation is stale.", 409);
    }
    registry[b.origin] = seal(
      JSON.stringify({ id: b.id, secret: b.secret, generation: b.generation }),
    );
    writeRegistry(registry);
    cache.clear();
    return { ok: true, generation: b.generation };
  });
  // Opt an existing old origin into sync-before-Hub navigation without rotating
  // its credentials, revoking sessions or blocking its final profile writes.
  app.post("/api/internal/hub/branch-transitions", async (req) => {
    if (
      !enabled ||
      typeof config.hubServiceSecret !== "string" ||
      config.hubServiceSecret.length < 32 ||
      !store?.db
    )
      throw fail("Hub registry control is not configured.", 503);
    if (
      req.headers.origin ||
      !same(req.headers.authorization, "Bearer " + config.hubServiceSecret)
    )
      throw fail("Service authorization required.", 401);
    const b = req.body;
    let url;
    try {
      url = new URL(b?.origin);
    } catch {
      throw fail("Invalid branch origin.");
    }
    if (
      !b || typeof b !== "object" || Array.isArray(b) ||
      Object.keys(b).some((key) => !["origin", "expectedGeneration", "revision", "active"].includes(key)) ||
      url.protocol !== "https:" || url.origin !== b.origin ||
      !Number.isSafeInteger(b.expectedGeneration) || b.expectedGeneration < 1 ||
      !Number.isSafeInteger(b.revision) || b.revision < 1 ||
      typeof b.active !== "boolean"
    )
      throw fail("Invalid branch transition.");
    // The read and sealed registry write form one SQLite compare-and-set even
    // if a second service process accesses the same persistent store.
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const registry = { ...getRegistry() };
      let previous;
      try {
        if (registry[b.origin]) previous = JSON.parse(unseal(registry[b.origin]));
      } catch {
        throw fail("Existing registry entry is unreadable.", 409);
      }
      if (
        !previous || !uuid(previous.id) || !token(previous.secret) ||
        previous.generation !== b.expectedGeneration
      )
        throw fail("Branch registry generation changed.", 409);
      const transition = previous.transition;
      if (transition !== undefined && (
        !transition || typeof transition !== "object" ||
        !Number.isSafeInteger(transition.revision) || transition.revision < 1 ||
        typeof transition.active !== "boolean"
      ))
        throw fail("Existing branch transition is unreadable.", 409);
      if (transition && b.revision === transition.revision && b.active === transition.active) {
        store.db.exec("COMMIT");
        return { ok: true, generation: previous.generation, revision: b.revision, active: b.active, replayed: true };
      }
      if (b.revision !== (transition?.revision ?? 0) + 1)
        throw fail("Branch transition revision changed.", 409);
      registry[b.origin] = seal(JSON.stringify({
        ...previous,
        transition: { revision: b.revision, active: b.active },
      }));
      writeRegistry(registry);
      store.db.exec("COMMIT");
      return { ok: true, generation: previous.generation, revision: b.revision, active: b.active };
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  });
  const browsingPath = (p) =>
    [
      "/api/browse/",
      "/browse/",
      "/runtime-config",
      "/~/",
      "/runtime/",
      "/controller/",
      "/clients/",
      "/bootstrap/",
      "/wisp/",
      "/bare/",
      "/games/",
      "/api/ai/",
    ].some((prefix) => p.startsWith(prefix));
  app.addHook("onRequest", async (req, reply) => {
    if (!enabled) return;
    const p = req.url.split("?")[0];
    if (p.startsWith("/_control/"))
      return reply.redirect(config.hubOrigin + "/?admin=overview");
    if (p.startsWith("/api/admin/"))
      throw fail("Administration is managed in Atlas Hub.", 403);
    if (p === "/api/tickets" || p.startsWith("/api/tickets/"))
      throw fail(
        "Support conversations are managed in Atlas Hub.",
        403,
        "HUB_SUPPORT_REQUIRED",
      );
    const publicAsset =
      ["GET", "HEAD"].includes(req.method) &&
      /^\/browse\/assets\/(document|dedicated|storage|cookies|relay|httpengine|rewriter)-[a-f0-9]{16}\.js$/.test(
        p,
      );
    // Main is also an eligible native-resource host. Its partitioned HttpOnly
    // enrollment cookies ride opaque child navigations but are NOT Hub identity.
    // Ignore only that exact cookie-name family on the narrow shell/receipt
    // exceptions below. Independent document/owner capabilities still authorize
    // each operation; cookie values never provide authority here.
    const nativeEnrollmentCookiesOnly = onlyNativeResourceEnrollmentCookies(
      req.headers.cookie,
    );
    const opaqueMarker =
      !config.profileRuntimeEnabled &&
      req.method === "POST" &&
      req.headers.origin === "null" &&
      nativeEnrollmentCookiesOnly &&
      !req.headers.authorization &&
      /^\/browse\/(storage\/commit|cookies\/result)\/[A-Za-z0-9_-]{43}$/.test(
        p,
      );
    // The same-origin profile mode retains the exact document capability and
    // live-owner checks in each rendezvous. Ambient frontend cookies are not
    // document authority and are expected on native same-origin XHR.
    const profileMarker =
      config.profileRuntimeEnabled === true &&
      config.profileRuntimeActivated === true &&
      req.method === "POST" &&
      req.headers.origin === originFor(req) &&
      !req.headers.authorization &&
      /^\/browse\/(storage\/commit|cookies\/result)\/[A-Za-z0-9_-]{43}$/.test(p);
    const physicalDocument =
      /^\/browse\/(frame|popup)\/(doc_[a-f0-9]{32})$/.exec(p);
    const reservedDocument =
      !config.hubUiOnlyLab &&
      config.opaqueRuntimeActivated === true &&
      ["GET", "HEAD"].includes(req.method) &&
      nativeEnrollmentCookiesOnly &&
      !req.headers.authorization &&
      !req.url.includes("?") &&
      (req.headers.origin === undefined || req.headers.origin === "null") &&
      !!physicalDocument &&
      authorizeReservedDocument?.(
        req,
        physicalDocument[2],
        physicalDocument[1],
      ) === true;
    if (browsingPath(p) && !publicAsset && !opaqueMarker && !profileMarker && !reservedDocument) {
      await requireSession(req);
      if (config.hubUiOnlyLab)
        throw fail(
          "Browsing is held in this UI-only lab until profile and isolation gates pass.",
          503,
          "HUB_RUNTIME_HELD",
        );
    }
  });
  app.addHook("preHandler", async (req) => {
    if (
      !enabled ||
      !browsingPath(req.url.split("?")[0]) ||
      !req.hubGrant ||
      !pool
    )
      return;
    for (const raw of [
      req.headers["x-atlas-browse-session"],
      req.body?.session,
      req.body?.previousSession,
    ])
      if (typeof raw === "string" && raw)
        pool.assertHubLease(
          createHash("sha256").update(raw).digest("hex"),
          req.hubGrant,
        );
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (
      enabled &&
      pool &&
      req.hubGrant &&
      reply.statusCode < 300 &&
      req.method === "POST" &&
      [
        "/api/browse/session",
        "/api/browse/controller/session",
        "/api/browse/controller/commit",
      ].includes(req.url.split("?")[0])
    ) {
      const data = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (typeof data?.session === "string")
        pool.bindHubLease(
          createHash("sha256").update(data.session).digest("hex"),
          req.hubGrant,
          req.hubValidatedAt,
        );
    }
    return payload;
  });
  const ordinaryAdmissionPaths = new Set([
    "GET /api/hub/state", "GET /api/config", "GET /api/catalog",
    "GET /api/hub/support/notifications", "GET /api/hub/support/events",
    "POST /api/browse/controller/runtime", "POST /api/browse/controller/bootstrap",
    "POST /api/browse/controller/initial-retire", "POST /api/browse/controller/session",
    "POST /api/browse/controller/commit", "POST /api/browse/controller/runtime-ticket",
    "POST /api/browse/controller/resource-owner", "DELETE /api/browse/controller/session",
    "POST /api/browse/cookies/owners", "DELETE /api/browse/cookies/owners",
    "POST /api/browse/storage/owners", "DELETE /api/browse/storage/owners",
    "POST /api/browse/cookies/documents", "POST /api/browse/storage/documents",
    "GET /api/hub/document-announcement", "POST /api/hub/document-announcement/ack",
  ]);
  async function ordinaryRateSubject(req) {
    const path = req.url.split("?")[0];
    // Trusted frontend native-owner lifecycle calls already require a verified
    // Hub session below. Their later assignment/capability/generation and CSRF
    // checks remain authoritative; only the shared-NAT accounting changes.
    const documentRelease = req.method === "DELETE" &&
      /^\/api\/browse\/(?:cookies|storage)\/documents\/[A-Za-z0-9_-]{16,96}$/.test(path);
    const supportSuffix = req.url.slice("/api/hub/support".length);
    const announcementOperation = req.url.startsWith("/api/hub/support/") &&
      !req.url.includes("?") &&
      ((req.method === "GET" && announcementDetail.test(supportSuffix)) ||
       (req.method === "POST" && announcementRead.test(supportSuffix)));
    if (!enabled || !(ordinaryAdmissionPaths.has(req.method + " " + path) || documentRelease || announcementOperation)) return null;
    let value;
    try { value = await requireSession(req); }
    catch (error) {
      // Signed-out state remains a normal 200 response after the existing IP
      // lane is charged; other routes retain their original authentication.
      const path = req.url.split("?")[0];
      if (req.method === "GET" && (["/api/config", "/api/catalog"].includes(path) ||
          (path === "/api/hub/state" && [401, 403].includes(error.statusCode)))) {
        requestFailures.set(req, error);
        return null;
      }
      throw error;
    }
    return { userId: value.grant.userId, profileId: value.grant.profileId };
  }
  app.addHook("onClose", async () => { verification.close(); cache.clear(); });
  return { enabled, requireSession, profileRateSubject, ordinaryRateSubject, hub, branchFor };
}
