/** Hub identity authority. Branch credentials are server-only and never profile data. */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { HubBranchGrant } from "@atlas-link-dispenser/shared";
import { HUB_LIMITS } from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import { encrypt, hashSecret, randomToken, safeEqual } from "./security.js";
import { withHubAuthTransaction, type HubQueryable } from "./hubDatabaseWork.js";
import { performance } from "node:perf_hooks";
import { performanceOutcome, type HubPerformance } from "./hubPerformance.js";
export type HubUser = {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "suspended";
  sessionId: string;
};
export type HubSession = HubBranchGrant;
export type HubIdentityOptions = {
  pool: Pool;
  sessionSecret: string;
  encryptionKey: string;
  requireUser: (r: FastifyRequest) => Promise<HubUser>;
  requireEligibleUser: (r: FastifyRequest) => Promise<HubUser>;
  requireAdmin: (r: FastifyRequest) => Promise<HubUser>;
  csrf: (r: FastifyRequest, u: HubUser) => void;
  assertEligible: (u: HubUser, queryable?: HubQueryable) => Promise<void>;
  performance?: HubPerformance;
};
const invalid = (message = "Invalid Hub request.", status = 400) =>
  new AppError("HUB_INVALID", message, status);
export function hubObject(v: unknown): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v as Record<string, any>;
}
export function hubUUID(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    throw invalid("Invalid record identifier.");
  return v;
}
export function hubToken(v: unknown, min = 16, max = 128): string {
  if (
    typeof v !== "string" ||
    v.length < min ||
    v.length > max ||
    !/^[A-Za-z0-9_-]+$/.test(v)
  )
    throw invalid("Invalid context or credential.");
  return v;
}
export function registerHubIdentityRoutes(
  app: FastifyInstance,
  o: HubIdentityOptions,
) {
  const { pool } = o;
  const hash = (s: string) => hashSecret(s, o.sessionSecret);
  const rate = new Map<string, { count: number; until: number }>();
  const limited = (key: string, max: number) => {
    const now = Date.now();
    if (rate.size > 10000)
      for (const [k, v] of rate) if (v.until < now) rate.delete(k);
    const old = rate.get(key);
    const next =
      old && old.until > now
        ? { ...old, count: old.count + 1 }
        : { count: 1, until: now + 60000 };
    rate.set(key, next);
    if (next.count > max)
      throw new AppError(
        "HUB_RATE_LIMITED",
        "Please wait before retrying.",
        429,
      );
  };
  const profileRequest = (req: FastifyRequest) => {
    const path = req.url.split("?")[0];
    return path === "/api/hub/branch/profile" || path.startsWith("/api/hub/branch/profile/");
  };
  const validationRequest = (req: FastifyRequest) => req.method === "POST" && req.url === "/api/hub/branch/session";
  const announcementId = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const announcementDetail = new RegExp("^/api/hub/branch/announcements/" + announcementId + "$", "i");
  const announcementRead = new RegExp("^/api/hub/branch/announcements/" + announcementId + "/read$", "i");
  const supportActivityRequest = (req: FastifyRequest) =>
    (req.method === "GET" && (req.url === "/api/hub/branch/events" || req.url === "/api/hub/branch/notifications" || announcementDetail.test(req.url))) ||
    (req.method === "POST" && announcementRead.test(req.url));
  async function branch(req: FastifyRequest, queryable: HubQueryable = pool) {
    const id = hubUUID(req.headers["x-atlas-branch-id"]);
    const token = hubToken(
      req.headers.authorization?.replace(/^Bearer /, ""),
      43,
      43,
    );
    const r = (
      await queryable.query<{
        id: string;
        origin: string;
        link_id: string;
        secret_hash: string;
      }>(
        "SELECT b.* FROM hub_branches b JOIN links l ON l.id=b.link_id WHERE b.id=$1 AND b.enabled AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now())",
        [id],
      )
    ).rows[0];
    if (!r || !safeEqual(r.secret_hash, hash(token)))
      throw new AppError(
        "HUB_BRANCH_UNAUTHORIZED",
        "Branch authorization failed.",
        401,
      );
    // Profile journals have an authenticated account budget below; do not
    // charge their normal traffic to the shared branch control allowance.
    // Session refresh has a separate bounded lane. A verified service secret
    // is not sufficient for its account allowance: authenticate() still checks
    // the live session, assignment and eligibility, and failures retain600/min.
    // Mounted support subscribes/re-authenticates and polls every15s. Give only
    // its exact poll/SSE and UUID announcement detail/read endpoints a finite
    // aggregate lane; full live account
    // authority and the per-account bound still run in authenticate() below.
    limited((profileRequest(req) ? "branch-profile:" : validationRequest(req) ? "branch-validation:" : supportActivityRequest(req) ? "branch-support:" : "branch:") + id,
      profileRequest(req) ? 60000 : validationRequest(req) ? 6000 : supportActivityRequest(req) ? 12000 : 600);
    return r;
  }
  async function assigned(userId: string, branchId: string, queryable: HubQueryable = pool) {
    if (
      !(
        await queryable.query(
          "SELECT 1 FROM hub_branches b JOIN links l ON l.id=b.link_id JOIN link_assignments a ON a.link_id=l.id WHERE b.id=$1 AND a.user_id=$2 AND a.replaced_at IS NULL AND b.enabled AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now()) LIMIT 1",
          [branchId, userId],
        )
      ).rowCount
    )
      throw new AppError(
        "HUB_BRANCH_UNAUTHORIZED",
        "This branch is not assigned to your account.",
        403,
      );
  }
  const describe = (r: any): HubBranchGrant => ({
    protocol: 1,
    userId: r.user_id,
    profileId: r.profile_id,
    branchId: r.branch_id,
    sessionId: r.id,
    contextId: r.context_id,
    expiresAt: new Date(r.expires_at).toISOString(),
    grantExpiresAt: new Date(
      Math.min(
        Date.now() + HUB_LIMITS.grantMs,
        new Date(r.expires_at).getTime(),
        new Date(r.parent_expires).getTime(),
      ),
    ).toISOString(),
  });
  async function authenticate(req: FastifyRequest): Promise<HubSession> {
    const refreshStarted = performance.now();
    let refreshError: unknown;
    try {
    const b = await branch(req);
    try {
    const raw = hubToken(req.headers["x-atlas-branch-session"], 43, 43);
    const r = (
      await pool.query(
        `SELECT bs.*,(bs.seen_at<=now()-interval '60 seconds') AS activity_due,u.email,u.role,u.status,s.expires_at parent_expires FROM hub_branch_sessions bs JOIN users u ON u.id=bs.user_id JOIN sessions s ON s.id=bs.parent_session_id WHERE bs.token_hash=$1 AND bs.branch_id=$2 AND bs.revoked_at IS NULL AND bs.expires_at>now() AND s.revoked_at IS NULL AND s.expires_at>now()`,
        [hash(raw), b.id],
      )
    ).rows[0];
    if (!r)
      throw new AppError(
        "HUB_SESSION_EXPIRED",
        "Authenticate with Atlas Hub again.",
        401,
      );
    await assigned(r.user_id, b.id);
    await o.assertEligible({
      id: r.user_id,
      email: r.email,
      role: r.role,
      status: r.status,
      sessionId: r.parent_session_id,
    });
    if (profileRequest(req)) limited("profile:" + r.user_id + ":" + r.profile_id, 6000);
    else if (validationRequest(req)) limited("validation:" + r.user_id + ":" + r.profile_id, 60);
    else if (supportActivityRequest(req)) limited("support:" + r.user_id + ":" + r.profile_id, 120);
    // Activity is display metadata, not a lease or an authorization cache.
    // The live SELECT above computes freshness on the database clock, avoiding
    // both an extra round trip for fresh sessions and app/DB clock skew. Keep
    // the predicate on UPDATE too: concurrent Hub instances may have read the
    // same stale row, but only one may advance it in this one-minute window.
    if (r.activity_due !== false)
      await pool.query(
        "UPDATE hub_branch_sessions SET seen_at=now() WHERE id=$1 AND seen_at<=now()-interval '60 seconds'",
        [r.id],
      );
    return describe(r);
    } catch (error) {
      // A valid service secret alone is not an authenticated profile. Failed
      // session/eligibility attempts retain the ordinary branch abuse budget.
      if ((profileRequest(req) || validationRequest(req) || supportActivityRequest(req)) && !(error instanceof AppError && error.code === "HUB_RATE_LIMITED"))
        limited("branch:" + b.id, 600);
      throw error;
    }
    } catch (error) { refreshError = error; throw error; }
    finally {
      if (validationRequest(req)) o.performance?.observe("auth.refresh", performance.now() - refreshStarted, refreshError ? performanceOutcome(refreshError) : "ok");
    }
  }
  app.get("/api/hub/branches", async (req) => {
    const user = await o.requireEligibleUser(req);
    return {
      branches: (
        await pool.query(
          'SELECT b.id,b.origin,l.name,b.link_id AS "linkId" FROM hub_branches b JOIN links l ON l.id=b.link_id WHERE b.enabled AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now()) AND EXISTS(SELECT 1 FROM link_assignments a WHERE a.link_id=l.id AND a.user_id=$1 AND a.replaced_at IS NULL) ORDER BY l.name',
          [user.id],
        )
      ).rows,
    };
  });
  app.get("/api/admin/hub/branches", async (req) => {
    await o.requireAdmin(req);
    return {
      branches: (
        await pool.query(
          'SELECT b.id,b.origin,b.enabled,b.link_id AS "linkId",l.name,b.created_at AS "createdAt" FROM hub_branches b JOIN links l ON l.id=b.link_id ORDER BY b.created_at',
        )
      ).rows,
    };
  });
  app.post("/api/admin/hub/branches", async (req) => {
    const u = await o.requireAdmin(req);
    o.csrf(req, u);
    const v = hubObject(req.body),
      linkId = hubUUID(v.linkId);
    const link = (
      await pool.query(
        "SELECT url FROM links WHERE id=$1 AND enabled AND (expires_at IS NULL OR expires_at>now())",
        [linkId],
      )
    ).rows[0];
    if (!link) throw invalid("Enabled link not found.", 404);
    const target = new URL(link.url);
    if (target.protocol !== "https:" || target.username || target.password)
      throw invalid("Branch links require HTTPS.");
    const secret = randomToken();
    let row;
    try {
      row = (
        await pool.query(
          "INSERT INTO hub_branches(link_id,origin,secret_hash) VALUES($1,$2,$3) RETURNING id,origin,enabled",
          [linkId, target.origin, hash(secret)],
        )
      ).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new AppError(
          "HUB_CONFLICT",
          "This branch is already registered.",
          409,
        );
      throw e;
    }
    return { branch: row, secret };
  });
  app.put<{ Params: { id: string } }>(
    "/api/admin/hub/branches/:id",
    async (req) => {
      const u = await o.requireAdmin(req);
      o.csrf(req, u);
      const v = hubObject(req.body);
      if (typeof v.enabled !== "boolean") throw invalid();
      const result = await pool.query(
        "UPDATE hub_branches SET enabled=$2 WHERE id=$1 RETURNING id,enabled",
        [hubUUID(req.params.id), v.enabled],
      );
      if (!result.rowCount) throw invalid("Branch not found.", 404);
      return { branch: result.rows[0] };
    },
  );
  app.post("/api/hub/handoffs", async (req) => {
    limited("handoff-ip:" + req.ip, 30);
    const u = await o.requireEligibleUser(req);
    o.csrf(req, u);
    const v = hubObject(req.body),
      challenge = hubToken(v.codeChallenge, 43, 43),
      state = hubToken(v.state, 16, 128);
    const b = (
      await pool.query(
        "SELECT b.id,b.origin FROM hub_branches b JOIN links l ON l.id=b.link_id WHERE b.id=$1 AND b.enabled AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now())",
        [hubUUID(v.branchId)],
      )
    ).rows[0];
    if (!b) throw invalid("Branch unavailable.", 404);
    await assigned(u.id, b.id);
    let callbackOrigin=b.origin;
    if(v.callbackOrigin!==undefined){
      let u:URL;try{u=new URL(v.callbackOrigin);}catch{throw invalid("Invalid callback origin.");}
      if(u.protocol!=="https:"||u.origin!==v.callbackOrigin||u.username||u.password)throw invalid("Invalid callback origin.");
      if(u.origin!==b.origin&&!(await pool.query("SELECT 1 FROM hub_branch_origins WHERE branch_id=$1 AND origin=$2 AND state IN ('active','transition')",[b.id,u.origin])).rowCount)throw invalid("Unregistered callback origin.");
      callbackOrigin=u.origin;
    }
    const code = randomToken();
    await pool.query(
      "DELETE FROM hub_handoffs WHERE expires_at<now()-interval '1 hour'",
    );
    await pool.query(
      "INSERT INTO hub_handoffs(code_hash,branch_id,user_id,parent_session_id,challenge,state,callback_origin,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '60 seconds')",
      [hash(code), b.id, u.id, u.sessionId, challenge, state,callbackOrigin],
    );
    return {
      code,
      state,
      callback: callbackOrigin + "/auth/hub/callback",
      expiresIn: 60,
    };
  });
  app.post("/api/hub/branch/exchange", async (req, reply) => {
    return withHubAuthTransaction(pool, req, reply, async client => {
    const b = await branch(req, client),
      v = hubObject(req.body),
      code = hubToken(v.code, 43, 43);
    const verifier = hubToken(v.verifier, 43, 128);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const contextId =
      v.contextId === undefined ? randomUUID() : hubToken(v.contextId, 16, 96);
      const row = (
        await client.query(
          `SELECT h.*,u.email,u.role,u.status,s.expires_at parent_expires FROM hub_handoffs h JOIN users u ON u.id=h.user_id JOIN sessions s ON s.id=h.parent_session_id WHERE h.code_hash=$1 AND h.branch_id=$2 AND h.used_at IS NULL AND h.expires_at>now() AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF h`,
          [hash(code), b.id],
        )
      ).rows[0];
      if (!row || !safeEqual(row.challenge, challenge) || (row.callback_origin && row.callback_origin !== (v.callbackOrigin || b.origin)))
        throw new AppError(
          "HUB_HANDOFF_INVALID",
          "The authorization code expired or was already used.",
          401,
        );
      await assigned(row.user_id, b.id, client);
      await o.assertEligible({
        id: row.user_id,
        email: row.email,
        role: row.role,
        status: row.status,
        sessionId: row.parent_session_id,
      }, client);
      await client.query(
        "UPDATE hub_handoffs SET used_at=now() WHERE code_hash=$1",
        [hash(code)],
      );
      const profile = (
        await client.query(
          "INSERT INTO hub_profiles(user_id,encrypted_key) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id RETURNING id",
          [row.user_id, encrypt(randomToken(), o.encryptionKey)],
        )
      ).rows[0];
      const token = randomToken();
      const session = (
        await client.query(
          "INSERT INTO hub_branch_sessions(user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,LEAST($7,now()+interval '30 days')) RETURNING *",
          [
            row.user_id,
            profile.id,
            b.id,
            row.parent_session_id,
            hash(token),
            contextId,
            row.parent_expires,
          ],
        )
      ).rows[0];
      return {
        branchSession: token,
        grant: describe({ ...session, parent_expires: row.parent_expires }),
        state: row.state,
      };
    }, o.performance);
  });
  app.post("/api/hub/branch/session", async (req) => ({
    grant: await authenticate(req),
  }));
  app.delete("/api/hub/branch/session", async (req) => {
    const s = await authenticate(req);
    await pool.query(
      "WITH revoked AS (UPDATE hub_branch_sessions SET revoked_at=now() WHERE id=$1 RETURNING id), released AS (UPDATE hub_writers SET expires_at=now() WHERE session_id IN (SELECT id FROM revoked) RETURNING profile_id) SELECT id FROM revoked",
      [s.sessionId],
    );
    return { ok: true };
  });
  app.get("/api/hub/profile", async (req) => {
    const user = await o.requireUser(req);
    const profile = (
      await pool.query(
        "SELECT id,initialized,revision,bytes FROM hub_profiles WHERE user_id=$1",
        [user.id],
      )
    ).rows[0];
    return {
      profile: profile
        ? {
            id: profile.id,
            initialized: profile.initialized,
            revision: Number(profile.revision),
            bytes: Number(profile.bytes),
          }
        : null,
    };
  });
  app.get("/api/hub/sessions", async (req) => {
    const u = await o.requireUser(req);
    return {
      sessions: (
        await pool.query(
          'SELECT s.id,s.context_id AS "contextId",b.origin,s.created_at AS "createdAt",s.seen_at AS "seenAt",s.expires_at AS "expiresAt",s.revoked_at AS "revokedAt" FROM hub_branch_sessions s JOIN hub_branches b ON b.id=s.branch_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 100',
          [u.id],
        )
      ).rows,
    };
  });
  app.delete("/api/hub/profile", async (req) => {
    const user = await o.requireUser(req);
    o.csrf(req, user);
    const input = hubObject(req.body);
    if (input.confirmation !== "DELETE") throw invalid("Type DELETE to confirm cloud data deletion.");
    const profileId = hubUUID(input.profileId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Exchange locks a handoff before its profile too. Preserve that lock order.
      await client.query("DELETE FROM hub_handoffs WHERE user_id=$1", [user.id]);
      const deleted = await client.query(
        "DELETE FROM hub_profiles WHERE id=$1 AND user_id=$2 RETURNING id",
        [profileId, user.id],
      );
      if (deleted.rowCount !== 1) throw invalid("This browser profile changed. Refresh Browser data before deleting it.", 409);
      // Existing foreign keys cascade to branch sessions, streams, writers,
      // chunks and recoveries. An old browser token cannot repopulate this profile.
      await client.query(
        "INSERT INTO audit_events(admin_id,action,target_type,target_id,after) VALUES($1,'profile.delete','hub_profile',$2,$3)",
        [user.id, profileId, JSON.stringify({ deleted: true, localDeviceDataErased: false })],
      );
      await client.query("COMMIT");
      return { acknowledged: true, deleted: true, localDeviceDataErased: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });
  app.delete<{ Params: { id: string } }>(
    "/api/hub/sessions/:id",
    async (req) => {
      const u = await o.requireUser(req);
      o.csrf(req, u);
      const r = await pool.query(
        "WITH revoked AS (UPDATE hub_branch_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id), released AS (UPDATE hub_writers SET expires_at=now() WHERE session_id IN (SELECT id FROM revoked) RETURNING profile_id) SELECT id FROM revoked",
        [hubUUID(req.params.id), u.id],
      );
      if (!r.rowCount) throw invalid("Session not found.", 404);
      return { ok: true };
    },
  );
  return { authenticate, branch };
}
export type HubIdentity = ReturnType<typeof registerHubIdentityRoutes>;
