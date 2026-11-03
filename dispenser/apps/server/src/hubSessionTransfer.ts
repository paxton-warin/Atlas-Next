/** Ordinary account sessions only: this does not grant eligibility or coordinator MFA. */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";
import { hashSecret, randomToken, safeEqual } from "./security.js";
export const HUB_TRANSFER_COOKIE = "__Host-atlas-hub-transfer";
export const transferChallenge = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const fail = (
  message = "The Hub sign-in transfer expired. Sign in to continue.",
  status = 400,
) => new AppError("HUB_INVALID", message, status);
const uuid = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw fail();
  return value;
};
const token = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw fail();
  return value;
};
const body = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
};
export function transferReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/hub/session-transfer")
  )
    throw fail();
  return value;
}
export function transferRequestOrigin(request: FastifyRequest) {
  let origin: string;
  try {
    origin = new URL(request.protocol + "://" + request.host).origin;
  } catch {
    throw fail();
  }
  if (!origin.startsWith("https://"))
    throw fail("Use the secure Hub address.", 403);
  return origin;
}
type TransferUser = { id: string; sessionId: string };
export function registerHubSessionTransfer(
  app: FastifyInstance,
  options: {
    pool: Pool;
    sessionSecret: string;
    session: (request: FastifyRequest) => Promise<TransferUser | null>;
    csrf: (request: FastifyRequest, user: any) => void;
    issueSession: (
      userId: string,
      request: FastifyRequest,
      reply: FastifyReply,
      queryable: PoolClient,
    ) => Promise<string>;
    limit?: (request: FastifyRequest) => Promise<void>;
  },
) {
  const { pool } = options,
    hash = (value: string) => hashSecret(value, options.sessionSecret);
  const cookie = {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 60,
  };
  const clear = (reply: FastifyReply) =>
    reply.clearCookie(HUB_TRANSFER_COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  async function approved(origin: string) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) return null;
    } catch {
      return null;
    }
    return (
      await pool.query(
        "SELECT logical_id,url,state FROM hub_cloud_endpoints WHERE role='hub' AND url=$1 AND state IN ('active','transition') ORDER BY revision DESC LIMIT 1",
        [origin],
      )
    ).rows[0];
  }
  async function checked(request: FastifyRequest) {
    const origin = transferRequestOrigin(request);
    if (request.headers.origin !== origin)
      throw fail("Open this action from the Hub.", 403);
    await options.limit?.(request);
    return origin;
  }
  async function context(request: FastifyRequest, id: string) {
    const origin = transferRequestOrigin(request),
      row = (
        await pool.query(
          "SELECT * FROM hub_session_transfers WHERE id=$1 AND expires_at>now()",
          [id],
        )
      ).rows[0];
    if (!row || ![row.source_origin, row.destination_origin].includes(origin))
      throw fail();
    const [source, destination] = await Promise.all([
      approved(row.source_origin),
      approved(row.destination_origin),
    ]);
    if (
      !source ||
      !destination ||
      source.logical_id !== destination.logical_id ||
      destination.state !== "active"
    )
      throw fail();
    return { origin, row };
  }
  const callback = (row: any, extra: string) =>
    row.destination_origin +
    "/hub/session-transfer/callback?request=" +
    row.id +
    extra;
  app.get("/api/hub/session-transfer/availability", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const origin = transferRequestOrigin(request),
      entry = await approved(origin);
    if (!entry || entry.state !== "active") return { sources: [] };
    const current = (
      await pool.query(
        "SELECT value FROM app_settings WHERE key='hub_current_origin'",
      )
    ).rows[0]?.value;
    if (current && current !== origin) return { sources: [] };
    const rows = (
      await pool.query(
        "SELECT DISTINCT ON (url) url,revision FROM hub_cloud_endpoints WHERE role='hub' AND logical_id=$1 AND state='transition' AND url<>$2 ORDER BY url,revision DESC",
        [entry.logical_id, origin],
      )
    ).rows;
    return {
      sources: rows
        .sort((a, b) => b.revision - a.revision)
        .slice(0, 8)
        .map((row) => row.url),
    };
  });
  app.post("/api/hub/session-transfer/start", async (request, reply) => {
    const origin = await checked(request),
      input = body(request.body),
      source = typeof input.source === "string" ? input.source : "",
      returnTo = transferReturnPath(input.returnTo ?? "/");
    const [current, old] = await Promise.all([
      approved(origin),
      approved(source),
    ]);
    if (
      !current ||
      current.state !== "active" ||
      !old ||
      old.state !== "transition" ||
      old.logical_id !== current.logical_id ||
      origin === source
    )
      throw fail();
    const hub = (
      await pool.query(
        "SELECT value FROM app_settings WHERE key='hub_current_origin'",
      )
    ).rows[0]?.value;
    if (hub && hub !== origin) throw fail();
    if (await options.session(request)) return { redirect: origin + returnTo };
    const id = randomUUID(),
      verifier = randomToken(),
      browser = randomToken();
    await pool.query(
      "INSERT INTO hub_session_transfers(id,source_origin,destination_origin,return_to,pkce_challenge,browser_hash) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        source,
        origin,
        returnTo,
        transferChallenge(verifier),
        hash(browser),
      ],
    );
    reply
      .setCookie(HUB_TRANSFER_COOKIE, [id, verifier, browser].join("."), cookie)
      .header("cache-control", "no-store");
    return { redirect: source + "/hub/session-transfer/source?request=" + id };
  });
  app.get("/api/hub/session-transfer/context", async (request, reply) => {
    const { row } = await context(
      request,
      uuid((request.query as Record<string, unknown>).request),
    );
    reply.header("cache-control", "no-store");
    return {
      returnTo: row.return_to,
      source: row.source_origin,
      destination: row.destination_origin,
    };
  });
  app.post("/api/hub/session-transfer/authorize", async (request, reply) => {
    await checked(request);
    const { origin, row } = await context(
      request,
      uuid(body(request.body).request),
    );
    if (origin !== row.source_origin) throw fail();
    const user = await options.session(request);
    reply.header("cache-control", "no-store");
    if (!user) {
      await pool.query(
        "UPDATE hub_session_transfers SET state='failed' WHERE id=$1 AND state='pending'",
        [row.id],
      );
      return { redirect: callback(row, "&failed=1") };
    }
    options.csrf(request, user);
    const code = randomToken();
    const updated = await pool.query(
      "UPDATE hub_session_transfers SET source_session_id=$2,user_id=$3,code_hash=$4,state='authorized' WHERE id=$1 AND state='pending' AND expires_at>now() RETURNING id",
      [row.id, user.sessionId, user.id, hash(code)],
    );
    if (!updated.rowCount) throw fail();
    return { redirect: callback(row, "&code=" + code) };
  });
  app.post("/api/hub/session-transfer/exchange", async (request, reply) => {
    const origin = await checked(request),
      input = body(request.body),
      id = uuid(input.request),
      parts = (request.cookies[HUB_TRANSFER_COOKIE] ?? "").split(".");
    if (parts.length !== 3 || parts[0] !== id) throw fail();
    const verifier = token(parts[1]),
      browser = token(parts[2]);
    const { row } = await context(request, id);
    if (
      row.destination_origin !== origin ||
      !safeEqual(row.pkce_challenge, transferChallenge(verifier)) ||
      !safeEqual(row.browser_hash, hash(browser))
    )
      throw fail();
    if (input.failed === true) {
      await pool.query(
        "UPDATE hub_session_transfers SET state='failed' WHERE id=$1 AND state IN ('pending','failed')",
        [id],
      );
      clear(reply);
      return { redirect: row.return_to };
    }
    const code = token(input.code),
      current = await options.session(request),
      client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = (
        await client.query(
          "SELECT t.* FROM hub_session_transfers t JOIN sessions s ON s.id=t.source_session_id AND s.user_id=t.user_id WHERE t.id=$1 AND t.destination_origin=$2 AND t.state='authorized' AND t.code_hash=$3 AND t.expires_at>now() AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF t,s",
          [id, origin, hash(code)],
        )
      ).rows[0];
      if (!locked) throw fail();
      if (current && current.id !== locked.user_id)
        throw fail(
          "Sign out of the current account before switching accounts.",
          409,
        );
      const cookies: Array<Parameters<FastifyReply["setCookie"]>> = [];
      const staged = {
        setCookie: (...args: Parameters<FastifyReply["setCookie"]>) => {
          cookies.push(args);
          return staged;
        },
      };
      await options.issueSession(
        locked.user_id,
        request,
        staged as unknown as FastifyReply,
        client,
      );
      await client.query(
        "UPDATE hub_session_transfers SET state='consumed',consumed_at=now(),code_hash=NULL WHERE id=$1",
        [id],
      );
      await client.query("COMMIT");
      for (const args of cookies) reply.setCookie(...args);
      clear(reply);
      reply.header("cache-control", "no-store");
      return { redirect: locked.return_to };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
