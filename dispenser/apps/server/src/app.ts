import { installHubPerformance } from "./hubPerformance.js";
import { randomUUID } from "node:crypto";
import { registerHubIdentityRoutes } from "./hubIdentity.js";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import { registerHubBackupsV2Routes } from "./hubBackupsV2.js";
import { registerHubLegacyConversionRoutes } from "./hubBackupsV2Legacy.js";
import { registerHubProfilePolicyRoutes } from "./hubProfilePolicy.js";
import { registerHubSessionTransfer } from "./hubSessionTransfer.js";
import { registerHubSupportRoutes } from "./hubSupport.js";
import { registerHubMetricsRoutes } from "./hubMetrics.js";
import { registerHubCloudRoutes } from "./hubCloud.js";
import { registerHubAtlasControlRoutes } from "./hubAtlasControl.js";
import {
  entryLaunchLinkOrDefault,
  validateEntryLaunchLink,
} from "./entryLaunchLink.js";
import { registerDocumentAnnouncementRoutes } from "./hubDocumentAnnouncement.js";
import { isIP } from "node:net";
import {
  createManualVerificationService,
  registerManualVerificationRoutes,
} from "./manualVerification.js";
import {
  createCheckMailService,
  CheckMailError,
  type CheckMailAllowlistInput,
} from "./checkMail.js";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import type { Pool } from "pg";
import { createHubDatabasePools, closeHubDatabasePools, verifyHubDatabaseHeadroom } from "./hubDatabasePools.js";
import { installHubListenMultiplexer } from "./hubListenMultiplexer.js";
import {
  isEmail,
  normalizeEmail,
  type EmailRuleInput,
  type LinkInput,
  type ReportCategory,
} from "@atlas-link-dispenser/shared";
import {
  allocateLink,
  type AssignmentSettings,
  withSerializableRetry,
} from "./allocation.js";
import {
  assertPublicDestination,
  parseBulkLinks,
  validatedPublicUrl,
} from "./bulkLinks.js";
import { config } from "./config.js";
import {
  queryPage,
  searchPattern,
  statusFilter,
  type PageQuery,
} from "./pagination.js";
import {
  evaluateEmailPolicy,
  validateRegex,
  type EmailRule,
} from "./emailPolicy.js";
import { AppError, forbidden, unauthorized } from "./errors.js";
import { backupAdmissionSnapshot,backupDatabaseSnapshot } from "./hubBackupsV2Admission.js";
import {
  GoogleDriveVerificationService,
  type DriveVerificationProvider,
} from "./googleDrive.js";
import {
  hashSecret,
  randomToken,
  safeEqual,
  sixDigitCode,
} from "./security.js";

type AuthUser = {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "suspended";
  sessionId: string;
  csrfHash: string;
};
type Dependencies = {
  hubEnabled?: boolean;
  pool?: Pool;
  redis?: Redis;
  checkMailFetch?: typeof fetch;
  drive?: DriveVerificationProvider & Partial<GoogleDriveVerificationService>;
};
const SESSION_COOKIE = "ald_session";
const CSRF_COOKIE = "ald_csrf";
const EMAIL_RULE_FIELDS =
  'id,kind,action,pattern,priority,enabled,note,denial_message AS "denialMessage"';
const EMAIL_RULE_ADMIN_FIELDS = `${EMAIL_RULE_FIELDS},created_at,updated_at`;
const DEFAULT_EMAIL_DENIAL_MESSAGE =
  "This email address is not eligible to register.";

export async function buildApp(dependencies: Dependencies = {}) {
  const hubEnabled = dependencies.hubEnabled ?? config.hubEnabled;
  const databasePools = dependencies.pool ? undefined : createHubDatabasePools(config.databaseUrl);
  const pool = dependencies.pool ?? databasePools!.ordinary;
  if (databasePools) {
    try { if (hubEnabled) await verifyHubDatabaseHeadroom(databasePools); }
    catch (error) { await closeHubDatabasePools(databasePools); throw error; }
  }
  const redis =
    dependencies.redis ??
    new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  if (redis.status === "wait") await redis.connect();
  const drive = dependencies.drive ?? new GoogleDriveVerificationService(pool);
  const checkMail = createCheckMailService({
    pool,
    dataEncryptionKey: config.encryptionKey,
    fetch: dependencies.checkMailFetch,
  });
  const manualVerification = createManualVerificationService(pool);
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.headers.x-atlas-branch-session",
      ],
    },
    trustProxy: config.trustedProxyCidrs,
    bodyLimit: 2_000_000,
  });
  const hubPerformance = installHubPerformance(app, pool);
  app.addHook("onRequest", async (request) => {
    if (!isIP(request.ip))
      throw new AppError(
        "INVALID_CLIENT_ADDRESS",
        "The request address is invalid.",
        400,
      );
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  app.addHook("onClose", async () => {
    if (!dependencies.redis) redis.disconnect();
    if (databasePools) await closeHubDatabasePools(databasePools);
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError || error instanceof CheckMailError;
    if (!known) request.log.error({ err: error }, "request failed");
    reply.code(known ? error.status : 500).send({
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known
          ? error.message
          : "Something went wrong. Please try again.",
        ...(error instanceof AppError && error.details ? {details:error.details}:{}),
      },
    });
  });

  const rateLimit = async (key: string, max: number, seconds: number) => {
    const count = await redis.incr(`rate:${key}`);
    if (count === 1) await redis.expire(`rate:${key}`, seconds);
    if (count > max)
      throw new AppError(
        "VERIFICATION_RATE_LIMITED",
        "Please wait before trying again.",
        429,
      );
  };
  const session = async (request: FastifyRequest): Promise<AuthUser | null> => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return null;
    const result = await pool.query<AuthUser>(
      `SELECT u.id,u.email,u.role,u.status,s.id "sessionId",s.csrf_hash "csrfHash" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [hashSecret(token, config.sessionSecret)],
    );
    return result.rows[0] ?? null;
  };
  const requireUser = async (request: FastifyRequest) => {
    const user = await session(request);
    if (!user) throw unauthorized();
    if (user.status === "suspended")
      throw new AppError("USER_SUSPENDED", "This account is suspended.", 403);
    return user;
  };
  const requireAdmin = async (request: FastifyRequest) => {
    const user = await requireUser(request);
    if (user.role !== "admin") throw forbidden();
    return user;
  };
  const csrf = (request: FastifyRequest, user: AuthUser) => {
    const value = request.headers["x-csrf-token"];
    if (
      typeof value !== "string" ||
      !safeEqual(hashSecret(value, config.sessionSecret), user.csrfHash)
    )
      throw new AppError(
        "FORBIDDEN",
        "The security check expired. Refresh and try again.",
        403,
      );
  };
  const setCookies = (
    reply: { setCookie: Function },
    token: string,
    csrfToken: string,
    expires: Date,
  ) => {
    const common = {
      path: "/",
      sameSite: "strict" as const,
      secure: config.production,
      expires,
    };
    reply.setCookie(SESSION_COOKIE, token, { ...common, httpOnly: true });
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...common, httpOnly: false });
  };
  const createSession = async (
    userId: string,
    request: FastifyRequest,
    reply: { setCookie: Function },
    queryable: Pick<Pool, "query"> = pool,
  ) => {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expires = new Date(Date.now() + 30 * 86400_000);
    await queryable.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6)",
      [
        userId,
        hashSecret(token, config.sessionSecret),
        hashSecret(csrfToken, config.sessionSecret),
        expires,
        request.ip,
        request.headers["user-agent"],
      ],
    );
    setCookies(reply, token, csrfToken, expires);
    return csrfToken;
  };
  const clearCookies = (reply: { clearCookie: Function }) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
  };
  const setting = async <T>(key: string): Promise<T> => {
    const result = await pool.query<{ value: T }>(
      "SELECT value FROM app_settings WHERE key=$1",
      [key],
    );
    if (!result.rows[0]) throw new Error(`Missing setting ${key}`);
    return result.rows[0].value;
  };
  const audit = (
    adminId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    before: unknown,
    after: unknown,
  ) =>
    pool.query(
      "INSERT INTO audit_events(admin_id,action,target_type,target_id,before,after) VALUES($1,$2,$3,$4,$5,$6)",
      [
        adminId,
        action,
        targetType,
        targetId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ],
    );
  const object = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError("VALIDATION_ERROR", "Invalid request.");
    return value as Record<string, unknown>;
  };

  const assertEmailAllowed = async (
    email: string,
    queryable: Pick<Pool, "query"> = pool,
  ) => {
    const registration = (
      await queryable.query<{ value: { defaultMode: "allow" | "deny" } }>(
        "SELECT value FROM app_settings WHERE key='registration'",
      )
    ).rows[0]!.value;
    const rules = (
      await queryable.query<EmailRule>(
        `SELECT ${EMAIL_RULE_FIELDS} FROM email_rules ORDER BY priority DESC`,
      )
    ).rows;
    const policy = evaluateEmailPolicy(email, rules, registration.defaultMode);
    if (!policy.allowed)
      throw new AppError(
        "EMAIL_NOT_ALLOWED",
        policy.rule?.action === "deny" && policy.rule.denialMessage.trim()
          ? policy.rule.denialMessage.trim()
          : DEFAULT_EMAIL_DENIAL_MESSAGE,
        403,
      );
  };
  const requireEligibleUser = async (request: FastifyRequest) => {
    const user = await requireUser(request);
    if (user.role === "admin") return user;
    await assertEmailAllowed(user.email);
    if ((await manualVerification.state(user)).required)
      throw new AppError(
        "MANUAL_VERIFICATION_REQUIRED",
        "Complete manual verification before accessing links.",
        403,
      );
    return user;
  };
  registerManualVerificationRoutes(app, {
    pool,
    requireUser,
    requireAdmin,
    csrf,
    audit,
  });
  app.get("/api/hub/config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { enabled: hubEnabled, protocol: 1 };
  });
  app.get("/api/hub/launch-link", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await pool.query<{ value: unknown }>(
      "SELECT value FROM app_settings WHERE key='entryLaunchLink'",
    );
    return entryLaunchLinkOrDefault(result.rows[0]?.value);
  });
  registerDocumentAnnouncementRoutes(app, { pool, requireUser, csrf });
  if (hubEnabled) {
    const controlPool = databasePools?.control ?? pool;
    const bulkPool = databasePools?.bulk ?? pool;
    const maintenancePool = databasePools?.maintenance ?? pool;
    if (databasePools) installHubListenMultiplexer(app, databasePools.listen);
    registerHubSessionTransfer(app, {
      pool: controlPool,
      sessionSecret: config.sessionSecret,
      session,
      csrf,
      issueSession: createSession,
      limit: (request) =>
        rateLimit(`hub-session-transfer:${request.ip}`, 60, 300),
    });
    app.addHook("onRequest", async (request, reply) => {
      if (
        request.url.startsWith("/api/hub/") ||
        request.url.startsWith("/api/admin/hub/") ||
        request.url.startsWith("/api/admin/cloud/")
      )
        reply.header("cache-control", "no-store");
    });
    const assertEligible = async (user: {
      id: string;
      email: string;
      role: "user" | "admin";
      status: "active" | "suspended";
    }, queryable: Pick<Pool, "query"> = pool) => {
      if (user.status !== "active")
        throw new AppError("USER_SUSPENDED", "This account is suspended.", 403);
      if (user.role === "admin") return;
      await assertEmailAllowed(user.email, queryable);
      if ((await manualVerification.state(user, queryable)).required)
        throw new AppError(
          "MANUAL_VERIFICATION_REQUIRED",
          "Complete manual verification before browsing.",
          403,
        );
    };
    const identity = registerHubIdentityRoutes(app, {
      pool: controlPool,
      sessionSecret: config.sessionSecret,
      encryptionKey: config.encryptionKey,
      requireUser,
      requireEligibleUser,
      requireAdmin,
      csrf: (request, user) => csrf(request, user as AuthUser),
      assertEligible,
      performance: hubPerformance,
    });
    registerDocumentAnnouncementRoutes(app, {
      pool,
      userPrefix: "/api/hub/branch",
      requireUser: async (request) => ({
        id: (await identity.authenticate(request)).userId,
      }),
      csrf: () => {},
    });
    registerHubProfileRoutes(app, {
      pool: bulkPool,
      identity,
      encryptionKey: config.encryptionKey,
    });
    registerHubBackupsV2Routes(app, { pool: bulkPool, maintenancePool, identity, encryptionKey: config.encryptionKey, maintenance: !config.backupMaintenanceExternal, publicationDisabled: config.backupPublishDisabled });
    registerHubLegacyConversionRoutes(app, {pool: config.backupMaintenanceExternal ? bulkPool : maintenancePool, identity, encryptionKey: config.encryptionKey, startWorker: !config.backupMaintenanceExternal, publicationDisabled: config.backupPublishDisabled});
    const verifyService = (request: FastifyRequest) => {
      const expected = config.hubServiceSecret;
      const supplied = request.headers.authorization?.replace(/^Bearer /, "");
      return (
        !!expected &&
        typeof supplied === "string" &&
        supplied.length <= 256 &&
        safeEqual(
          hashSecret(supplied, config.sessionSecret),
          hashSecret(expected, config.sessionSecret),
        )
      );
    };
    const atlasControls = await registerHubAtlasControlRoutes(app, {
      pool,
      requireUser,
      requireAdmin,
      csrf,
      coordinatorOrigin: config.hubCoordinatorOrigin,
      coordinatorOriginKey: config.hubCoordinatorOriginKey,
      serviceSecret: config.hubServiceSecret,
    });
    await registerHubSupportRoutes(app, {
      pool,
      requireUser,
      requireAdmin,
      csrf,
      verifyService,
      legacyVerify: atlasControls.verifyLegacy,
    });
    await registerHubSupportRoutes(app, {
      pool,
      userPrefix: "/api/hub/branch",
      includeAdmin: false,
      requireUser: async (request) => {
        const grant = await identity.authenticate(request);
        return {
          id: grant.userId,
          role: "user" as const,
          sessionId: grant.sessionId,
        };
      },
      requireAdmin: async () => {
        throw new AppError("FORBIDDEN", "Forbidden.", 403);
      },
      csrf: () => {},
      legacyVerify: atlasControls.verifyLegacy,
    });
    await registerHubMetricsRoutes(app, {
      pool,
      requireUser,
      requireAdmin,
      csrf,
      verifyService,
      sourceLabel: atlasControls.sourceLabel,
    });
    await registerHubProfilePolicyRoutes(app, {
      pool,
      requireUser,
      requireAdmin,
      csrf,
      encryptionKey: config.encryptionKey,
      performance: hubPerformance,
      maintenancePool,
      maintenanceDisabled: config.backupMaintenanceExternal,
    });
    registerHubCloudRoutes(app, {
      pool,
      requireAdmin,
      csrf,
      encryptionKey: config.encryptionKey,
    });
  }

  app.get("/api/admin/performance", async (request, reply) => {
    reply.header("cache-control", "no-store");
    await requireAdmin(request);
    return {...hubPerformance.snapshot(pool),backupAdmission:backupAdmissionSnapshot(),backupDatabase:backupDatabaseSnapshot()};
  });

  app.get("/health/live", async () => ({
    service: "atlas-link-dispenser",
    status: "ok",
  }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      return { status: "ok" };
    } catch {
      reply.code(503);
      return { status: "unavailable" };
    }
  });
  app.get("/api/setup/status", async () => ({
    initialized:
      Number(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text count FROM users WHERE role='admin'",
          )
        ).rows[0]?.count ?? 0,
      ) > 0,
  }));
  app.post("/api/setup/bootstrap", async (request, reply) => {
    await rateLimit(`bootstrap:${request.ip}`, 10, 3600);
    const input = object(request.body);
    if (
      input.token !== config.bootstrapToken ||
      normalizeEmail(String(input.email ?? "")) !== config.bootstrapEmail
    )
      throw forbidden();
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM users WHERE role='admin'",
    );
    if (Number(count.rows[0]?.count ?? 0))
      throw new AppError(
        "FORBIDDEN",
        "Initial setup is already complete.",
        409,
      );
    const created = await pool.query<{ id: string }>(
      `INSERT INTO users(email,normalized_email,role,verified_at,last_login_at) VALUES($1,$1,'admin',now(),now()) ON CONFLICT(normalized_email) DO NOTHING RETURNING id`,
      [config.bootstrapEmail],
    );
    if (!created.rows[0])
      throw new AppError(
        "FORBIDDEN",
        "Initial setup is already complete.",
        409,
      );
    const csrfToken = await createSession(created.rows[0]!.id, request, reply);
    return { ok: true, csrfToken };
  });
  app.post("/api/setup/recover", async (request, reply) => {
    await rateLimit(`recovery:${request.ip}`, 5, 3600);
    const input = object(request.body);
    if (
      input.token !== config.bootstrapToken ||
      normalizeEmail(String(input.email ?? "")) !== config.bootstrapEmail
    )
      throw forbidden();
    const admin = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE normalized_email=$1 AND role='admin' AND status='active' LIMIT 1",
      [config.bootstrapEmail],
    );
    if (!admin.rows[0]) throw forbidden();
    const csrfToken = await createSession(admin.rows[0].id, request, reply);
    await audit(
      admin.rows[0].id,
      "admin.recover",
      "user",
      admin.rows[0].id,
      null,
      { ip: request.ip },
    );
    return { ok: true, csrfToken };
  });
  app.get("/api/session", async (request) => {
    const user = await session(request);
    const csrfToken = request.cookies[CSRF_COOKIE];
    return {
      manualVerification: user ? await manualVerification.state(user) : null,
      user: user
        ? {
            id: user.id,
            email: user.email,
            role: user.role,
            status: user.status,
          }
        : null,
      csrfToken:
        user &&
        csrfToken &&
        safeEqual(hashSecret(csrfToken, config.sessionSecret), user.csrfHash)
          ? csrfToken
          : null,
    };
  });
  app.post("/api/auth/request", async (request) => {
    const input = object(request.body);
    const email = normalizeEmail(String(input.email ?? ""));
    if (!isEmail(email))
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter a valid Google email address.",
      );
    const registration = await setting<{
      defaultMode: "allow" | "deny";
      rateLimitPerHour: number;
    }>("registration");
    await rateLimit(
      `verify-ip:${request.ip}`,
      Math.max(10, registration.rateLimitPerHour * 2),
      3600,
    );
    await rateLimit(
      `verify-email:${email}`,
      registration.rateLimitPerHour,
      3600,
    );
    const rules = (
      await pool.query<EmailRule>(
        `SELECT ${EMAIL_RULE_FIELDS} FROM email_rules ORDER BY priority DESC`,
      )
    ).rows;
    const policy = evaluateEmailPolicy(email, rules, registration.defaultMode);
    if (!policy.allowed) {
      await pool.query(
        "INSERT INTO denied_email_logins(email,matched_rule_id,matched_rule_pattern,decision_source,request_ip,user_agent) VALUES($1,$2,$3,$4,$5,$6)",
        [
          email,
          policy.rule?.id ?? null,
          policy.rule?.pattern ?? null,
          policy.rule ? "rule" : "default_policy",
          request.ip,
          request.headers["user-agent"] ?? null,
        ],
      );
      throw new AppError(
        "EMAIL_NOT_ALLOWED",
        policy.rule?.action === "deny" && policy.rule.denialMessage.trim()
          ? policy.rule.denialMessage.trim()
          : DEFAULT_EMAIL_DENIAL_MESSAGE,
        403,
      );
    }
    const verification = await setting<{
      codeLength: number;
      lifetimeMinutes: number;
      maxAttempts: number;
      resendCooldownSeconds: number;
    }>("verification");
    const recent = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM verifications WHERE email=$1 AND created_at>now()-($2 || ' seconds')::interval ORDER BY created_at DESC LIMIT 1`,
      [email, verification.resendCooldownSeconds],
    );
    if (recent.rows[0])
      throw new AppError(
        "VERIFICATION_RATE_LIMITED",
        "A file was just sent. Please wait before requesting another.",
        429,
      );
    const existingAccount = await pool.query(
      "SELECT 1 FROM users WHERE normalized_email=$1 LIMIT 1",
      [email],
    );
    await checkMail.checkNewAccount(email, {
      accountExists: !!existingAccount.rowCount,
    });
    const id = randomUUID();
    const code = sixDigitCode(
      Math.min(8, Math.max(6, verification.codeLength)),
    );
    const expiresAt = new Date(
      Date.now() + verification.lifetimeMinutes * 60_000,
    );
    const replaced = await pool.query<{
      id: string;
      google_drive_file_id: string | null;
    }>(
      `UPDATE verifications SET status='replaced' WHERE email=$1 AND status='pending' RETURNING id,google_drive_file_id`,
      [email],
    );
    for (const old of replaced.rows)
      if (old.google_drive_file_id)
        void drive
          .removeVerificationFile(old.google_drive_file_id)
          .then(() =>
            pool.query(
              "UPDATE verifications SET cleanup_status='complete' WHERE id=$1",
              [old.id],
            ),
          )
          .catch(() =>
            pool.query(
              "UPDATE verifications SET cleanup_status='retry' WHERE id=$1",
              [old.id],
            ),
          );
    await pool.query(
      "INSERT INTO verifications(id,email,code_hash,expires_at,max_attempts,request_ip) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        email,
        hashSecret(`${id}:${code}`, config.sessionSecret),
        expiresAt,
        verification.maxAttempts,
        request.ip,
      ],
    );
    try {
      const file = await drive.createVerificationFile(
        email,
        code,
        verification.lifetimeMinutes,
      );
      await pool.query(
        "UPDATE verifications SET google_drive_file_id=$2,google_drive_permission_id=$3 WHERE id=$1",
        [id, file.fileId, file.permissionId],
      );
      return {
        verificationId: id,
        email,
        expiresAt,
        codeLength: Math.min(8, Math.max(6, verification.codeLength)),
        driveUrl: file.url,
      };
    } catch (error) {
      request.log.error(
        { err: error, verificationId: id },
        "Google Drive verification failed",
      );
      await pool.query(
        `UPDATE verifications SET status='delivery_failed' WHERE id=$1`,
        [id],
      );
      throw new AppError(
        "GOOGLE_DRIVE_UNAVAILABLE",
        "We couldn't send your verification file. Please try again in a moment.",
        503,
      );
    }
  });
  app.post("/api/auth/verify", async (request, reply) => {
    const input = object(request.body);
    const id = String(input.verificationId ?? "");
    const code = String(input.code ?? "").replace(/\D/g, "");
    await rateLimit(`code-ip:${request.ip}`, 30, 600);
    // Never hold a verification transaction/pool client while the external
    // checker acquires its own connection. Revalidate under FOR UPDATE below;
    // this preliminary read cannot consume or authorize a verification code.
    const pending = (
      await pool.query<{
        email: string;
        code_hash: string;
        expires_at: Date;
        attempt_count: number;
        max_attempts: number;
        status: string;
      }>(
        "SELECT email,code_hash,expires_at,attempt_count,max_attempts,status FROM verifications WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (
      pending &&
      pending.status === "pending" &&
      pending.expires_at > new Date() &&
      pending.attempt_count < pending.max_attempts &&
      safeEqual(
        hashSecret(`${id}:${code}`, config.sessionSecret),
        pending.code_hash,
      )
    ) {
      // Rules can change after delivery: deny before spending checker quota.
      await assertEmailAllowed(pending.email);
      const existingAccount = await pool.query(
        "SELECT 1 FROM users WHERE normalized_email=$1 LIMIT 1",
        [pending.email],
      );
      await checkMail.checkNewAccount(pending.email, {
        accountExists: !!existingAccount.rowCount,
      });
    }
    const client = await pool.connect();
    let fileId: string | null = null;
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        email: string;
        code_hash: string;
        expires_at: Date;
        attempt_count: number;
        max_attempts: number;
        status: string;
        google_drive_file_id: string | null;
      }>("SELECT * FROM verifications WHERE id=$1 FOR UPDATE", [id]);
      const attempt = result.rows[0];
      if (!attempt)
        throw new AppError(
          "VERIFICATION_INVALID",
          "That code is not valid.",
          400,
        );
      if (attempt.status !== "pending")
        throw new AppError(
          "VERIFICATION_INVALID",
          "That verification file can no longer be used.",
          400,
        );
      if (attempt.expires_at <= new Date()) {
        await client.query(
          `UPDATE verifications SET status='expired' WHERE id=$1`,
          [id],
        );
        await client.query("COMMIT");
        throw new AppError(
          "VERIFICATION_EXPIRED",
          "That code has expired. Send another file.",
          400,
        );
      }
      if (attempt.attempt_count >= attempt.max_attempts)
        throw new AppError(
          "VERIFICATION_INVALID",
          "Too many attempts. Send another file.",
          429,
        );
      if (
        !safeEqual(
          hashSecret(`${id}:${code}`, config.sessionSecret),
          attempt.code_hash,
        )
      ) {
        await client.query(
          `UPDATE verifications SET attempt_count=attempt_count+1,status=CASE WHEN attempt_count+1 >= max_attempts THEN 'failed' ELSE status END WHERE id=$1`,
          [id],
        );
        await client.query("COMMIT");
        throw new AppError(
          "VERIFICATION_INVALID",
          attempt.attempt_count + 1 >= attempt.max_attempts
            ? "Too many attempts. Send another file."
            : "That code is not correct.",
          attempt.attempt_count + 1 >= attempt.max_attempts ? 429 : 400,
        );
      }
      // Recheck inside the locked verification transaction before consuming the code
      // or creating an account. Directory membership never overrides email rules.
      await assertEmailAllowed(attempt.email, client);
      await client.query(
        `UPDATE verifications SET status='used',used_at=now(),cleanup_status='pending' WHERE id=$1`,
        [id],
      );
      fileId = attempt.google_drive_file_id;
      const user = await client.query<{ id: string; status: string }>(
        `INSERT INTO users(email,normalized_email,role,verified_at,last_login_at) VALUES($1,$1,$2::role,now(),now()) ON CONFLICT(normalized_email) DO UPDATE SET last_login_at=now(),verified_at=COALESCE(users.verified_at,now()) RETURNING id,status`,
        [
          attempt.email,
          attempt.email === config.bootstrapEmail ? "admin" : "user",
        ],
      );
      if (user.rows[0]?.status === "suspended")
        throw new AppError("USER_SUSPENDED", "This account is suspended.", 403);
      await client.query("COMMIT");
      // Reuse this already-owned connection after COMMIT. Acquiring another
      // pool connection here can deadlock simultaneous first-account logins.
      const csrfToken = await createSession(
        user.rows[0]!.id,
        request,
        reply,
        client,
      );
      if (fileId)
        void drive
          .removeVerificationFile(fileId)
          .then(() =>
            pool.query(
              `UPDATE verifications SET cleanup_status='complete' WHERE id=$1`,
              [id],
            ),
          )
          .catch((error) =>
            request.log.error(
              { err: error, verificationId: id },
              "verification cleanup failed",
            ),
          );
      return { ok: true, csrfToken };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.post("/api/logout", async (request, reply) => {
    const user = await requireUser(request);
    csrf(request, user);
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      user.sessionId,
    ]);
    clearCookies(reply);
    return { ok: true };
  });
  app.get("/api/assignment", async (request) => {
    const user = await requireEligibleUser(request);
    // Filter after choosing each link's representative assignment so a revoked
    // latest assignment cannot resurrect an older copy of the same ownership.
    const result = await pool.query(
      `SELECT id,"assignedAt","expiresAt",name,CASE WHEN available THEN url ELSE '' END url,status,available
       FROM (
         SELECT DISTINCT ON (a.link_id) a.id,a.assigned_at "assignedAt",a.expires_at "expiresAt",l.name,l.url,
           CASE
             WHEN a.replaced_at IS NOT NULL THEN 'removed'
             WHEN NOT l.enabled OR (l.expires_at IS NOT NULL AND l.expires_at<=now()) THEN 'unavailable'
             WHEN a.active AND (a.expires_at IS NULL OR a.expires_at>now()) THEN 'ready'
             ELSE 'previous'
           END status,
           (a.replaced_at IS NULL AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now())) available
         FROM link_assignments a JOIN links l ON l.id=a.link_id
         WHERE a.user_id=$1
         ORDER BY a.link_id,a.active DESC,a.assigned_at DESC,a.id DESC
       ) history WHERE status <> 'removed' ORDER BY "assignedAt" DESC,id DESC`,
      [user.id],
    );
    return { assignments: result.rows };
  });
  app.post("/api/assignment", async (request) => {
    const user = await requireEligibleUser(request);
    csrf(request, user);
    const settings = await setting<AssignmentSettings>("assignments");
    return {
      assignment: await withSerializableRetry(() =>
        allocateLink(pool, user.id, settings),
      ),
    };
  });
  app.post("/api/reports", async (request) => {
    const user = await requireEligibleUser(request);
    csrf(request, user);
    await rateLimit(`report:${user.id}`, 10, 3600);
    const input = object(request.body);
    const category = String(input.category ?? "") as ReportCategory;
    if (
      ![
        "does_not_load",
        "error_page",
        "very_slow",
        "wrong_page",
        "other",
      ].includes(category)
    )
      throw new AppError("VALIDATION_ERROR", "Choose a report category.");
    const detail = String(input.detail ?? "")
      .trim()
      .slice(0, 1000);
    const settings = await setting<{ duplicateCooldownMinutes: number }>(
      "reporting",
    );
    const assignment = await pool.query<{ id: string; link_id: string }>(
      "SELECT id,link_id FROM link_assignments WHERE id=$1 AND user_id=$2",
      [String(input.assignmentId ?? ""), user.id],
    );
    if (!assignment.rows[0]) throw forbidden();
    const duplicate = await pool.query<{ id: string }>(
      `SELECT id FROM reports WHERE user_id=$1 AND link_id=$2 AND status='open' AND created_at>now()-($3 || ' minutes')::interval LIMIT 1`,
      [user.id, assignment.rows[0].link_id, settings.duplicateCooldownMinutes],
    );
    if (duplicate.rows[0]) {
      await pool.query(
        "UPDATE reports SET category=$2,detail=$3,updated_at=now() WHERE id=$1",
        [duplicate.rows[0].id, category, detail],
      );
      return { reportId: duplicate.rows[0].id, deduplicated: true };
    }
    const report = await pool.query<{ id: string }>(
      "INSERT INTO reports(user_id,assignment_id,link_id,category,detail) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        user.id,
        assignment.rows[0].id,
        assignment.rows[0].link_id,
        category,
        detail,
      ],
    );
    return { reportId: report.rows[0]!.id, deduplicated: false };
  });

  app.get("/api/admin/overview", async (request) => {
    await requireAdmin(request);
    const result = await pool.query(
      `SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM users WHERE created_at>current_date) users_today,(SELECT count(*) FROM link_assignments WHERE active) active_assignments,(SELECT count(*) FROM link_assignments WHERE assigned_at>current_date) allocations_today,(SELECT count(*) FROM links WHERE enabled AND (capacity IS NULL OR (SELECT count(*) FROM link_assignments a WHERE a.link_id=links.id AND a.active)<capacity)) available_links,(SELECT count(*) FROM links WHERE capacity IS NOT NULL AND (SELECT count(*) FROM link_assignments a WHERE a.link_id=links.id AND a.active)>=capacity) links_at_capacity,(SELECT count(*) FROM links WHERE health_status='unavailable') unhealthy_links,(SELECT count(*) FROM reports WHERE status='open') open_reports,(SELECT count(*) FROM verifications WHERE created_at>current_date) verification_attempts,(SELECT count(*) FROM verifications WHERE used_at>current_date) verification_successes,(SELECT COALESCE(round(100.0*count(*) FILTER(WHERE used_at IS NOT NULL)/NULLIF(count(*),0)),0) FROM verifications WHERE created_at>current_date) verification_success_rate`,
    );
    return result.rows[0];
  });
  app.get("/api/admin/links", async (request) => {
    await requireAdmin(request);
    const query = request.query as PageQuery;
    const select = `l.*,(SELECT count(*)::int FROM link_assignments a WHERE a.link_id=l.id AND a.active) used,(SELECT count(*)::int FROM reports r WHERE r.link_id=l.id AND r.status='open') open_reports`;
    const status = statusFilter(query, [
      "all",
      "enabled",
      "disabled",
      "healthy",
      "degraded",
      "unavailable",
      "unknown",
    ]);
    const filters = ["(l.name ILIKE $1 OR l.url ILIKE $1)"];
    const values: unknown[] = [searchPattern(query)];
    if (status === "enabled" || status === "disabled") {
      values.push(status === "enabled");
      filters.push("l.enabled=$2");
    } else if (status !== "all") {
      values.push(status);
      filters.push("l.health_status=$2");
    }
    const where = filters.join(" AND ");
    // The browser replacement helper deliberately requests a complete snapshot.
    // Keep this legacy no-pagination contract; the admin UI always sends a page.
    if (query.page === undefined && query.pageSize === undefined) {
      const result = await pool.query(
        `SELECT ${select} FROM links l WHERE ${where} ORDER BY l.created_at DESC,l.id DESC`,
        values,
      );
      return { links: result.rows };
    }
    const result = await queryPage(pool, query, {
      select,
      from: "links l",
      where,
      values,
      order: "l.created_at DESC,l.id DESC",
    });
    return { links: result.items, pagination: result.pagination };
  });
  const linkValues = (raw: unknown): LinkInput => {
    const input = object(raw);
    return {
      name: String(input.name ?? "")
        .trim()
        .slice(0, 160),
      url: validatedPublicUrl(String(input.url ?? "")),
      enabled: input.enabled !== false,
      capacity:
        input.capacity === null ||
        input.capacity === "" ||
        input.capacity === undefined
          ? null
          : Number(input.capacity),
      weight: Number(input.weight ?? 1),
      expiresAt: input.expiresAt ? String(input.expiresAt) : null,
      notes: String(input.notes ?? "").slice(0, 2000),
      healthMonitoring: input.healthMonitoring !== false,
    };
  };
  app.post("/api/admin/links", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const value = linkValues(request.body);
    if (
      !value.name ||
      (value.capacity !== null &&
        (!Number.isInteger(value.capacity) || value.capacity < 1)) ||
      !Number.isInteger(value.weight) ||
      value.weight < 1
    )
      throw new AppError("VALIDATION_ERROR", "Link values are invalid.");
    const created = await pool.query(
      "INSERT INTO links(name,url,enabled,capacity,weight,expires_at,notes,health_monitoring) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        value.name,
        value.url,
        value.enabled,
        value.capacity,
        value.weight,
        value.expiresAt,
        value.notes,
        value.healthMonitoring,
      ],
    );
    await audit(
      admin.id,
      "link.create",
      "link",
      created.rows[0].id,
      null,
      created.rows[0],
    );
    return created.rows[0];
  });
  app.post("/api/admin/links/bulk", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const values = parseBulkLinks(String(object(request.body).text ?? ""));
    const client = await pool.connect();
    const inserted: unknown[] = [];
    const skipped: string[] = [];
    try {
      await client.query("BEGIN");
      for (const value of values) {
        const result = await client.query(
          "INSERT INTO links(name,url,enabled,capacity,weight,notes,health_monitoring) VALUES($1,$2,true,NULL,1,$3,true) ON CONFLICT(url) DO NOTHING RETURNING id,name,url",
          [value.name, value.url, value.notes],
        );
        if (result.rows[0]) inserted.push(result.rows[0]);
        else skipped.push(value.url);
      }
      await client.query("COMMIT");
      await audit(admin.id, "link.bulk_create", "link_pool", null, null, {
        inserted: inserted.length,
        skipped: skipped.length,
      });
      return { inserted, skipped };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.put("/api/admin/links/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const before = (await pool.query("SELECT * FROM links WHERE id=$1", [id]))
      .rows[0];
    if (!before) throw new AppError("LINK_UNAVAILABLE", "Link not found.", 404);
    const value = linkValues(request.body);
    const result = await pool.query(
      "UPDATE links SET name=$2,url=$3,enabled=$4,capacity=$5,weight=$6,expires_at=$7,notes=$8,health_monitoring=$9,health_status=CASE WHEN $4 AND health_status='disabled' THEN 'unknown'::health_status WHEN $4 THEN health_status ELSE 'disabled'::health_status END,updated_at=now() WHERE id=$1 RETURNING *",
      [
        id,
        value.name,
        value.url,
        value.enabled,
        value.capacity,
        value.weight,
        value.expiresAt,
        value.notes,
        value.healthMonitoring,
      ],
    );
    await audit(admin.id, "link.update", "link", id, before, result.rows[0]);
    return result.rows[0];
  });
  app.put("/api/admin/links/:id/enabled", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const enabled = object(request.body).enabled;
    if (typeof enabled !== "boolean")
      throw new AppError("VALIDATION_ERROR", "Enabled must be true or false.");
    const before = (await pool.query("SELECT * FROM links WHERE id=$1", [id]))
      .rows[0];
    if (!before) throw new AppError("LINK_UNAVAILABLE", "Link not found.", 404);
    const result = await pool.query(
      "UPDATE links SET enabled=$2,health_status=CASE WHEN $2 THEN 'unknown'::health_status ELSE 'disabled'::health_status END,consecutive_failures=0,consecutive_successes=0,updated_at=now() WHERE id=$1 RETURNING *",
      [id, enabled],
    );
    await audit(
      admin.id,
      enabled ? "link.enable" : "link.disable",
      "link",
      id,
      before,
      result.rows[0],
    );
    return result.rows[0];
  });
  app.delete("/api/admin/links/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const client = await pool.connect();
    let before: Record<string, unknown> | undefined;
    let assignments = 0;
    let reports = 0;
    try {
      await client.query("BEGIN");
      before = (
        await client.query<Record<string, unknown>>(
          "SELECT * FROM links WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!before)
        throw new AppError("LINK_UNAVAILABLE", "Link not found.", 404);
      reports =
        (await client.query("DELETE FROM reports WHERE link_id=$1", [id]))
          .rowCount ?? 0;
      assignments =
        (
          await client.query("DELETE FROM link_assignments WHERE link_id=$1", [
            id,
          ])
        ).rowCount ?? 0;
      await client.query("DELETE FROM health_checks WHERE link_id=$1", [id]);
      await client.query("DELETE FROM links WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await audit(admin.id, "link.delete", "link", id, before, {
      deleted: true,
      assignments,
      reports,
    });
    return { ok: true, deleted: true, assignments, reports };
  });
  app.post("/api/admin/links/:id/check", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    return checkLink(pool, (request.params as { id: string }).id);
  });
  app.post("/api/admin/links/:id/reset-assignments", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const result = await pool.query(
      "UPDATE link_assignments SET active=false,replaced_at=now() WHERE link_id=$1 AND active",
      [id],
    );
    await audit(admin.id, "link.reset_assignments", "link", id, null, {
      count: result.rowCount,
    });
    return { ok: true, count: result.rowCount };
  });
  app.get("/api/admin/users", async (request) => {
    await requireAdmin(request);
    const query = request.query as PageQuery;
    const status = statusFilter(query, ["all", "active", "suspended"]);
    const values: unknown[] = [searchPattern(query)];
    let where = "u.email ILIKE $1";
    if (status !== "all") {
      values.push(status);
      where += " AND u.status=$2";
    }
    const result = await queryPage(pool, query, {
      select: `u.id,u.email,u.role,u.status,u.created_at,u.last_login_at,u.admin_notes,u.quota_override,COALESCE(current_links.count,0)::int active_assignment_count,current_links.latest_name link_name`,
      from: `users u LEFT JOIN LATERAL (SELECT count(*)::int count,(array_agg(l.name ORDER BY a.assigned_at DESC,a.id DESC))[1] latest_name FROM link_assignments a JOIN links l ON l.id=a.link_id WHERE a.user_id=u.id AND a.active AND l.enabled) current_links ON true`,
      where,
      values,
      order: "u.created_at DESC,u.id DESC",
    });
    return { users: result.items, pagination: result.pagination };
  });
  app.get("/api/admin/users/:id", async (request) => {
    await requireAdmin(request);
    const id = (request.params as { id: string }).id;
    const user = (
      await pool.query(
        "SELECT id,email,role,status,created_at,last_login_at,verified_at,admin_notes,suspension_reason,quota_override,quota_reset_at FROM users WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!user) throw new AppError("VALIDATION_ERROR", "User not found.", 404);
    const [assignments, reports, verifications, sessions, usage, counts] =
      await Promise.all([
        pool.query(
          `SELECT a.id,a.active,a.assigned_at,a.expires_at,l.name,l.url FROM link_assignments a JOIN links l ON l.id=a.link_id WHERE a.user_id=$1 ORDER BY a.assigned_at DESC,a.id DESC LIMIT 50`,
          [id],
        ),
        pool.query(
          `SELECT r.id,r.category,r.status,r.created_at,l.name link_name FROM reports r JOIN links l ON l.id=r.link_id WHERE r.user_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 50`,
          [id],
        ),
        pool.query(
          `SELECT id,status,attempt_count,created_at,expires_at,used_at FROM verifications WHERE email=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,
          [user.email],
        ),
        pool.query(
          `SELECT id,created_at,expires_at,revoked_at,ip,user_agent FROM sessions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,
          [id],
        ),
        pool.query(
          `SELECT count(DISTINCT a.link_id) FILTER(WHERE a.assigned_at>=date_trunc('week',now()) AND ($2::timestamptz IS NULL OR a.assigned_at>$2))::int "week" FROM link_assignments a JOIN links l ON l.id=a.link_id WHERE a.user_id=$1 AND l.enabled`,
          [id, user.quota_reset_at],
        ),
        pool.query(
          `SELECT (SELECT count(*)::int FROM link_assignments WHERE user_id=$1) assignments,(SELECT count(*)::int FROM reports WHERE user_id=$1) reports,(SELECT count(*)::int FROM verifications WHERE email=$2) verifications,(SELECT count(*)::int FROM sessions WHERE user_id=$1) sessions`,
          [id, user.email],
        ),
      ]);
    return {
      user,
      manualVerification: await manualVerification.state(user as AuthUser),
      assignments: assignments.rows,
      reports: reports.rows,
      verifications: verifications.rows,
      sessions: sessions.rows,
      usage: usage.rows[0],
      counts: counts.rows[0],
    };
  });
  app.get("/api/admin/users/:id/activity", async (request) => {
    await requireAdmin(request);
    const id = (request.params as { id: string }).id;
    const query = request.query as PageQuery;
    const kind = query.kind;
    if (
      typeof kind !== "string" ||
      !["assignments", "reports", "verifications", "sessions"].includes(kind)
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Choose a valid user activity kind.",
      );
    }
    const user = (
      await pool.query<{ email: string }>(
        "SELECT email FROM users WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!user) throw new AppError("VALIDATION_ERROR", "User not found.", 404);
    const sources = {
      assignments: {
        select: "a.id,a.active,a.assigned_at,a.expires_at,l.name,l.url",
        from: "link_assignments a JOIN links l ON l.id=a.link_id",
        where: "a.user_id=$1",
        values: [id],
        order: "a.assigned_at DESC,a.id DESC",
      },
      reports: {
        select: "r.id,r.category,r.status,r.created_at,l.name link_name",
        from: "reports r JOIN links l ON l.id=r.link_id",
        where: "r.user_id=$1",
        values: [id],
        order: "r.created_at DESC,r.id DESC",
      },
      verifications: {
        select: "id,status,attempt_count,created_at,expires_at,used_at",
        from: "verifications",
        where: "email=$1",
        values: [user.email],
        order: "created_at DESC,id DESC",
      },
      sessions: {
        select: "id,created_at,expires_at,revoked_at,ip,user_agent",
        from: "sessions",
        where: "user_id=$1",
        values: [id],
        order: "created_at DESC,id DESC",
      },
    };
    return queryPage(pool, query, sources[kind as keyof typeof sources]);
  });
  app.put("/api/admin/users/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const input = object(request.body);
    const before = (
      await pool.query(
        "SELECT id,email,status,admin_notes,quota_override FROM users WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!before) throw new AppError("VALIDATION_ERROR", "User not found.", 404);
    const status = input.status === "suspended" ? "suspended" : "active";
    const notes = String(input.adminNotes ?? before.admin_notes).slice(0, 5000);
    const quota =
      input.quotaOverride === null
        ? null
        : (input.quotaOverride ?? before.quota_override);
    const result = await pool.query(
      `UPDATE users SET status=$2::user_status,admin_notes=$3,quota_override=$4::jsonb,suspended_at=CASE WHEN $2::user_status='suspended'::user_status THEN now() ELSE NULL END,suspension_reason=CASE WHEN $2::user_status='suspended'::user_status THEN $5 ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING id,email,status,admin_notes,quota_override`,
      [
        id,
        status,
        notes,
        quota ? JSON.stringify(quota) : null,
        String(input.suspensionReason ?? ""),
      ],
    );
    if (status === "suspended")
      await pool.query(
        "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        [id],
      );
    await audit(admin.id, "user.update", "user", id, before, result.rows[0]);
    return result.rows[0];
  });
  app.post("/api/admin/users/:id/revoke-sessions", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    await pool.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [id],
    );
    await audit(admin.id, "user.revoke_sessions", "user", id, null, null);
    return { ok: true };
  });
  app.post("/api/admin/users/:id/reset-assignment", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    await pool.query(
      "UPDATE link_assignments SET active=false,replaced_at=now() WHERE user_id=$1 AND active",
      [id],
    );
    await audit(admin.id, "user.reset_assignment", "user", id, null, null);
    return { ok: true };
  });
  app.post("/api/admin/users/:id/reset-quota", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    await pool.query(
      "UPDATE users SET quota_reset_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
    await audit(admin.id, "user.reset_quota", "user", id, null, {
      resetAt: new Date().toISOString(),
    });
    return { ok: true };
  });
  app.delete("/api/admin/users/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    if (id === admin.id)
      throw new AppError(
        "VALIDATION_ERROR",
        "You cannot delete your own account.",
      );
    const before = (
      await pool.query("SELECT id,email,role FROM users WHERE id=$1", [id])
    ).rows[0];
    if (!before) throw new AppError("VALIDATION_ERROR", "User not found.", 404);
    if (before.role === "admin")
      throw new AppError(
        "VALIDATION_ERROR",
        "Demote another administrator before deleting the account.",
      );
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
    await audit(admin.id, "user.delete", "user", id, before, null);
    return { ok: true };
  });
  app.get("/api/admin/email-rules", async (request) => {
    await requireAdmin(request);
    const result = await queryPage(pool, request.query as PageQuery, {
      select: EMAIL_RULE_ADMIN_FIELDS,
      from: "email_rules",
      order: "priority DESC,created_at ASC,id ASC",
    });
    return { rules: result.items, pagination: result.pagination };
  });
  const ruleValues = (raw: unknown): EmailRuleInput => {
    const input = object(raw);
    const kind = String(input.kind) as EmailRuleInput["kind"];
    const action = String(input.action) as EmailRuleInput["action"];
    const pattern = String(input.pattern ?? "").trim();
    if (
      !["exact", "domain", "regex"].includes(kind) ||
      !["allow", "deny"].includes(action) ||
      !pattern
    )
      throw new AppError("VALIDATION_ERROR", "Rule values are invalid.");
    if (kind === "regex") validateRegex(pattern);
    const denialMessage =
      input.denialMessage === undefined
        ? undefined
        : String(input.denialMessage ?? "").trim();
    if (denialMessage !== undefined && denialMessage.length > 500)
      throw new AppError(
        "VALIDATION_ERROR",
        "Blocked-user messages must be 500 characters or fewer.",
      );
    return {
      kind,
      action,
      pattern,
      priority: Number(input.priority ?? 0),
      enabled: input.enabled !== false,
      note: String(input.note ?? "").slice(0, 1000),
      denialMessage,
    };
  };
  app.post("/api/admin/email-rules", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const value = ruleValues(request.body);
    const result = await pool.query(
      `INSERT INTO email_rules(kind,action,pattern,priority,enabled,note,denial_message) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${EMAIL_RULE_ADMIN_FIELDS}`,
      [
        value.kind,
        value.action,
        value.pattern,
        value.priority,
        value.enabled,
        value.note,
        value.denialMessage ?? "",
      ],
    );
    await audit(
      admin.id,
      "email_rule.create",
      "email_rule",
      result.rows[0].id,
      null,
      result.rows[0],
    );
    return result.rows[0];
  });
  app.put("/api/admin/email-rules/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const value = ruleValues(request.body);
    const before = (
      await pool.query(
        `SELECT ${EMAIL_RULE_ADMIN_FIELDS} FROM email_rules WHERE id=$1`,
        [id],
      )
    ).rows[0];
    const result = await pool.query(
      `UPDATE email_rules SET kind=$2,action=$3,pattern=$4,priority=$5,enabled=$6,note=$7,denial_message=COALESCE($8,denial_message),updated_at=now() WHERE id=$1 RETURNING ${EMAIL_RULE_ADMIN_FIELDS}`,
      [
        id,
        value.kind,
        value.action,
        value.pattern,
        value.priority,
        value.enabled,
        value.note,
        value.denialMessage ?? null,
      ],
    );
    await audit(
      admin.id,
      "email_rule.update",
      "email_rule",
      id,
      before,
      result.rows[0],
    );
    return result.rows[0];
  });
  app.delete("/api/admin/email-rules/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const before = (
      await pool.query(
        `DELETE FROM email_rules WHERE id=$1 RETURNING ${EMAIL_RULE_ADMIN_FIELDS}`,
        [id],
      )
    ).rows[0];
    await audit(admin.id, "email_rule.delete", "email_rule", id, before, null);
    return { ok: true };
  });
  app.post("/api/admin/email-rules/test", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const email = normalizeEmail(String(object(request.body).email ?? ""));
    if (!isEmail(email))
      throw new AppError("VALIDATION_ERROR", "Enter a valid email.");
    const registration = await setting<{ defaultMode: "allow" | "deny" }>(
      "registration",
    );
    const rules = (
      await pool.query<EmailRule>(
        `SELECT ${EMAIL_RULE_FIELDS} FROM email_rules ORDER BY priority DESC`,
      )
    ).rows;
    return evaluateEmailPolicy(email, rules, registration.defaultMode);
  });
  app.get("/api/admin/reports", async (request) => {
    await requireAdmin(request);
    const [reports, aggregates] = await Promise.all([
      queryPage(pool, request.query as PageQuery, {
        select:
          "r.*,u.email,l.name link_name,l.url,count(*) OVER(PARTITION BY r.link_id) link_report_count",
        from: "reports r JOIN users u ON u.id=r.user_id JOIN links l ON l.id=r.link_id",
        order: "r.created_at DESC,r.id DESC",
      }),
      pool.query(
        `SELECT l.id,l.name,count(*)::int reports,count(DISTINCT r.user_id)::int unique_users,max(r.created_at) last_report,jsonb_object_agg(r.category,r.category_count) categories FROM links l JOIN (SELECT link_id,user_id,category,created_at,count(*) OVER(PARTITION BY link_id,category)::int category_count FROM reports WHERE created_at>now()-interval '24 hours') r ON r.link_id=l.id GROUP BY l.id,l.name ORDER BY reports DESC,l.id DESC LIMIT 50`,
      ),
    ]);
    return {
      reports: reports.items,
      pagination: reports.pagination,
      aggregates: aggregates.rows,
    };
  });
  app.put("/api/admin/reports/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const input = object(request.body);
    const before = (await pool.query("SELECT * FROM reports WHERE id=$1", [id]))
      .rows[0];
    const status = ["open", "resolved", "dismissed"].includes(
      String(input.status),
    )
      ? String(input.status)
      : "open";
    const result = await pool.query(
      "UPDATE reports SET status=$2,admin_note=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [id, status, String(input.adminNote ?? "").slice(0, 2000)],
    );
    await audit(
      admin.id,
      "report.update",
      "report",
      id,
      before,
      result.rows[0],
    );
    return result.rows[0];
  });
  app.post("/api/admin/reports/:id/disable-link", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = (request.params as { id: string }).id;
    const report = (
      await pool.query<{ link_id: string }>(
        "SELECT link_id FROM reports WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!report)
      throw new AppError("VALIDATION_ERROR", "Report not found.", 404);
    const before = (
      await pool.query(
        "SELECT id,name,enabled,health_status FROM links WHERE id=$1",
        [report.link_id],
      )
    ).rows[0];
    await pool.query(
      "UPDATE links SET enabled=false,health_status='disabled',updated_at=now() WHERE id=$1",
      [report.link_id],
    );
    await audit(
      admin.id,
      "link.disable_from_report",
      "link",
      report.link_id,
      before,
      { ...before, enabled: false, health_status: "disabled" },
    );
    return { ok: true };
  });
  app.get("/api/admin/verifications", async (request) => {
    await requireAdmin(request);
    const result = await queryPage(pool, request.query as PageQuery, {
      select:
        "id,email,status,attempt_count,max_attempts,expires_at,cleanup_status,created_at,used_at",
      from: "verifications",
      order: "created_at DESC,id DESC",
    });
    return { verifications: result.items, pagination: result.pagination };
  });
  app.get("/api/admin/denied-email-logins", async (request) => {
    await requireAdmin(request);
    const query = request.query as PageQuery;
    const result = await queryPage(pool, query, {
      select:
        "id,email,matched_rule_pattern,decision_source,request_ip,user_agent,created_at",
      from: "denied_email_logins",
      where: "email ILIKE $1",
      values: [searchPattern(query)],
      order: "created_at DESC,id DESC",
    });
    return { items: result.items, pagination: result.pagination };
  });
  const uuid = (value: string) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new AppError("VALIDATION_ERROR", "Invalid whitelist rule ID.");
    return value;
  };
  // Separate provider configuration: neither generic settings nor audit payloads
  // expose the encrypted or plaintext API credential.
  app.get("/api/admin/check-mail", async (request, reply) => {
    await requireAdmin(request);
    reply.header("Cache-Control", "no-store");
    return checkMail.getConfig();
  });
  app.put("/api/admin/check-mail", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const body = object(request.body);
    if (
      Object.keys(body).some(
        (key) =>
          !["enabled", "monthlyLimit", "apiKey", "clearApiKey"].includes(key),
      )
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "Unknown email-check configuration field.",
      );
    const before = await checkMail.getConfig();
    const result = await checkMail.updateConfig(body);
    const publicAudit = (value: typeof result) => ({
      enabled: value.enabled,
      configured: value.configured,
      monthlyLimit: value.monthlyLimit,
    });
    await audit(
      admin.id,
      "check_mail.configure",
      "check_mail",
      null,
      publicAudit(before),
      {
        ...publicAudit(result),
        credentialChanged:
          body.apiKey !== undefined || body.clearApiKey === true,
      },
    );
    return result;
  });
  app.post("/api/admin/check-mail/allowlist", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const rule = await checkMail.addAllowlist(
      object(request.body) as unknown as CheckMailAllowlistInput,
    );
    await audit(
      admin.id,
      "check_mail.allowlist.create",
      "check_mail_allowlist",
      rule.id,
      null,
      rule,
    );
    return rule;
  });
  app.put("/api/admin/check-mail/allowlist/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = uuid((request.params as { id: string }).id);
    const before =
      (await checkMail.listAllowlist()).find((rule) => rule.id === id) ?? null;
    const rule = await checkMail.updateAllowlist(
      id,
      object(request.body) as unknown as CheckMailAllowlistInput,
    );
    await audit(
      admin.id,
      "check_mail.allowlist.update",
      "check_mail_allowlist",
      id,
      before,
      rule,
    );
    return rule;
  });
  app.delete("/api/admin/check-mail/allowlist/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const id = uuid((request.params as { id: string }).id);
    const before =
      (await checkMail.listAllowlist()).find((rule) => rule.id === id) ?? null;
    const result = await checkMail.deleteAllowlist(id);
    await audit(
      admin.id,
      "check_mail.allowlist.delete",
      "check_mail_allowlist",
      id,
      before,
      null,
    );
    return result;
  });
  app.post("/api/admin/check-mail/test", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const email = normalizeEmail(String(object(request.body).email ?? ""));
    if (!isEmail(email) || email.length > 320)
      throw new AppError("VALIDATION_ERROR", "Enter a valid email.");
    const existing = await pool.query(
      "SELECT 1 FROM users WHERE normalized_email=$1 LIMIT 1",
      [email],
    );
    if (existing.rowCount)
      return { skipped: true, reason: "existing_account", matchedRule: null };
    const settings = await checkMail.getConfig(),
      result = await checkMail.testAllowlist(email);
    return {
      skipped: !settings.enabled || result.matched,
      reason: !settings.enabled
        ? "disabled"
        : result.matched
          ? "allowlist"
          : "check_required",
      matchedRule: result.rule,
    };
  });
  app.get("/api/admin/settings", async (request) => {
    await requireAdmin(request);
    const settings = Object.fromEntries(
      (
        await pool.query<{ key: string; value: unknown }>(
          "SELECT key,value FROM app_settings WHERE key=ANY($1::text[]) ORDER BY key",
          [
            [
              "registration",
              "verification",
              "assignments",
              "reporting",
              "health",
              "entryLaunchLink",
            ],
          ],
        )
      ).rows.map((row) => [row.key, row.value]),
    );
    settings.entryLaunchLink = entryLaunchLinkOrDefault(settings.entryLaunchLink);
    return {
      settings,
    };
  });
  app.get("/api/admin/settings/:key", async (request) => {
    await requireAdmin(request);
    const key = (request.params as { key: string }).key;
    if (key !== "entryLaunchLink")
      throw new AppError("VALIDATION_ERROR", "Unknown settings section.");
    const result = await pool.query<{ value: unknown }>(
      "SELECT value FROM app_settings WHERE key=$1",
      [key],
    );
    return { key, value: entryLaunchLinkOrDefault(result.rows[0]?.value) };
  });
  const settingsValues = async (key: string, raw: unknown) => {
    if (key === "entryLaunchLink") return validateEntryLaunchLink(raw);
    const input = object(raw);
    const current = await setting<Record<string, unknown>>(key);
    const merged = { ...current, ...input };
    const number = (name: string, min: number, max: number) => {
      const value = Number(merged[name]);
      if (!Number.isFinite(value) || value < min || value > max)
        throw new AppError(
          "VALIDATION_ERROR",
          `${name} must be between ${min} and ${max}.`,
        );
      return value;
    };
    if (key === "registration")
      return {
        defaultMode: merged.defaultMode === "deny" ? "deny" : "allow",
        rateLimitPerHour: number("rateLimitPerHour", 1, 1000),
      };
    if (key === "verification")
      return {
        codeLength: number("codeLength", 6, 8),
        lifetimeMinutes: number("lifetimeMinutes", 1, 60),
        maxAttempts: number("maxAttempts", 1, 20),
        resendCooldownSeconds: number("resendCooldownSeconds", 10, 3600),
      };
    if (key === "assignments") {
      const strategy = String(merged.strategy);
      if (
        ![
          "balanced_random",
          "random",
          "weighted_random",
          "sequential",
        ].includes(strategy)
      )
        throw new AppError("VALIDATION_ERROR", "Unknown allocation strategy.");
      return {
        strategy,
        linksPerWeek: number("linksPerWeek", 1, 10000),
        assignmentLifetimeHours: number("assignmentLifetimeHours", 0, 8760),
        reassignmentCooldownMinutes: number(
          "reassignmentCooldownMinutes",
          0,
          10080,
        ),
      };
    }
    if (key === "reporting")
      return {
        duplicateCooldownMinutes: number("duplicateCooldownMinutes", 1, 10080),
      };
    if (key === "health") {
      const expected = Array.isArray(merged.expectedStatuses)
        ? merged.expectedStatuses.map(Number)
        : [];
      if (
        !expected.length ||
        expected.some(
          (status) => !Number.isInteger(status) || status < 100 || status > 599,
        )
      )
        throw new AppError(
          "VALIDATION_ERROR",
          "Expected statuses must contain valid HTTP status codes.",
        );
      return {
        enabled: merged.enabled !== false,
        intervalMinutes: number("intervalMinutes", 1, 1440),
        timeoutSeconds: number("timeoutSeconds", 1, 60),
        path: String(merged.path ?? "").slice(0, 500),
        failureThreshold: number("failureThreshold", 1, 20),
        successThreshold: number("successThreshold", 1, 20),
        expectedStatuses: expected,
      };
    }
    throw new AppError("VALIDATION_ERROR", "Unknown settings section.");
  };
  app.put("/api/admin/settings/:key", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const key = (request.params as { key: string }).key;
    if (
      ![
        "registration",
        "verification",
        "assignments",
        "reporting",
        "health",
        "entryLaunchLink",
      ].includes(key)
    )
      throw new AppError("VALIDATION_ERROR", "Unknown settings section.");
    const value = await settingsValues(key, request.body);
    const before = (
      await pool.query("SELECT value FROM app_settings WHERE key=$1", [key])
    ).rows[0]?.value;
    await pool.query(
      key === "entryLaunchLink"
        ? "INSERT INTO app_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()"
        : "UPDATE app_settings SET value=$2,updated_by=$3,updated_at=now() WHERE key=$1",
      [key, JSON.stringify(value), admin.id],
    );
    await audit(admin.id, "settings.update", "settings", key, before, value);
    return { key, value };
  });
  app.get("/api/admin/audit", async (request) => {
    await requireAdmin(request);
    const result = await queryPage(pool, request.query as PageQuery, {
      select: "a.*,u.email admin_email",
      from: "audit_events a LEFT JOIN users u ON u.id=a.admin_id",
      order: "a.created_at DESC,a.id DESC",
    });
    return { events: result.items, pagination: result.pagination };
  });
  app.get("/api/admin/google/status", async (request) => {
    await requireAdmin(request);
    return {
      connection:
        (await (drive as GoogleDriveVerificationService).status?.()) ?? null,
    };
  });
  app.post("/api/admin/google/connect", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    if (
      !(drive instanceof GoogleDriveVerificationService) ||
      !config.googleClientId ||
      !config.googleClientSecret
    )
      throw new AppError(
        "GOOGLE_DRIVE_UNAVAILABLE",
        "Add the Google OAuth client ID and secret to the server configuration first.",
        400,
      );
    const state = randomToken(24);
    await redis.setex(`oauth:${state}`, 600, admin.id);
    return { url: drive.authorizationUrl(state) };
  });
  app.get("/api/admin/google/callback", async (request, reply) => {
    const query = request.query as { state?: string; code?: string };
    if (!query.state || !query.code)
      throw new AppError(
        "VALIDATION_ERROR",
        "Google authorization was cancelled.",
      );
    const adminId = await redis.get(`oauth:${query.state}`);
    if (!adminId)
      throw new AppError("FORBIDDEN", "This connection request expired.", 403);
    await redis.del(`oauth:${query.state}`);
    const email = await (drive as GoogleDriveVerificationService).connect(
      query.code,
    );
    await audit(adminId, "google.connect", "google_connection", null, null, {
      email,
    });
    reply.redirect(`${config.appUrl}/?admin=verification&google=connected`);
  });
  app.post("/api/admin/google/test", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    try {
      return { message: await drive.testConnection() };
    } catch (error) {
      request.log.error({ err: error }, "Google Drive connection test failed");
      throw new AppError(
        "GOOGLE_DRIVE_UNAVAILABLE",
        "The Google Drive connection test failed. Reconnect the account and try again.",
        503,
      );
    }
  });
  app.delete("/api/admin/google", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    await (drive as GoogleDriveVerificationService).disconnect?.();
    await audit(
      admin.id,
      "google.disconnect",
      "google_connection",
      null,
      null,
      null,
    );
    return { ok: true };
  });

  return { app, pool, redis, drive };
}

export async function checkLink(pool: Pool, id: string) {
  const link = (
    await pool.query<{ url: string; health_monitoring: boolean }>(
      "SELECT url,health_monitoring FROM links WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!link) throw new AppError("LINK_UNAVAILABLE", "Link not found.", 404);
  const health = (
    await pool.query<{
      value: {
        timeoutSeconds: number;
        path?: string;
        failureThreshold: number;
        successThreshold: number;
        expectedStatuses: number[];
      };
    }>("SELECT value FROM app_settings WHERE key='health'")
  ).rows[0]!.value;
  const started = Date.now();
  let healthy = false,
    statusCode: number | null = null,
    error: string | null = null;
  try {
    const destination = await assertPublicDestination(link.url);
    if (health.path) {
      destination.pathname = health.path.startsWith("/")
        ? health.path
        : `/${health.path}`;
      destination.search = "";
    }
    let response = await fetch(destination, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(health.timeoutSeconds * 1000),
    });
    if (response.status === 405) {
      response = await fetch(destination, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(health.timeoutSeconds * 1000),
      });
      await response.body?.cancel();
    }
    statusCode = response.status;
    healthy = health.expectedStatuses.includes(response.status);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : "Health check failed";
  }
  const duration = Date.now() - started;
  // Persist the observation and its status together. PostgreSQL resolves an
  // untyped CASE of string literals as text, not as our health_status enum.
  // Explicit enum casts prevent successful probes from leaving "unknown".
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO health_checks(link_id,healthy,status_code,duration_ms,error) VALUES($1,$2,$3,$4,$5)",
      [id, healthy, statusCode, duration, error],
    );
    const updated = healthy
      ? await client.query<{ health_status: string }>(
          `UPDATE links SET consecutive_successes=consecutive_successes+1,consecutive_failures=0,health_status=CASE WHEN NOT enabled THEN 'disabled'::health_status WHEN consecutive_successes+1 >= $2 THEN 'healthy'::health_status ELSE 'degraded'::health_status END,updated_at=now() WHERE id=$1 RETURNING health_status`,
          [id, health.successThreshold],
        )
      : await client.query<{ health_status: string }>(
          `UPDATE links SET consecutive_failures=consecutive_failures+1,consecutive_successes=0,health_status=CASE WHEN NOT enabled THEN 'disabled'::health_status WHEN consecutive_failures+1 >= $2 THEN 'unavailable'::health_status ELSE 'degraded'::health_status END,updated_at=now() WHERE id=$1 RETURNING health_status`,
          [id, health.failureThreshold],
        );
    if (!updated.rows[0])
      throw new AppError("LINK_UNAVAILABLE", "Link not found.", 404);
    await client.query("COMMIT");
    return {
      healthy,
      statusCode,
      duration,
      error,
      healthStatus: updated.rows[0].health_status,
    };
  } catch (failure) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw failure;
  } finally {
    client.release();
  }
}
