import { createHmac, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import type { Pool, PoolClient } from "pg";
import { isEmail, normalizeEmail } from "@atlas-link-dispenser/shared";
import { validateRegex } from "./emailPolicy.js";
import { decrypt, encrypt } from "./security.js";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const CHECK_MAIL_ENDPOINT = "https://api.check-mail.org/v2/";
export type CheckMailErrorCode =
  | "CHECK_MAIL_UNAVAILABLE"
  | "CHECK_MAIL_REJECTED"
  | "CHECK_MAIL_LIMIT"
  | "VALIDATION_ERROR";
export class CheckMailError extends Error {
  constructor(
    readonly code: CheckMailErrorCode,
    message: string,
    readonly status = 503,
    readonly providerRemaining: number | null = null,
  ) {
    super(message);
  }
}
export interface CheckMailAllowlistInput {
  kind: "exact" | "domain" | "regex";
  pattern: string;
  enabled?: boolean;
  note?: string;
}
export interface CheckMailAllowlistRule extends CheckMailAllowlistInput {
  id: string;
  enabled: boolean;
  note: string;
}
export type CheckMailResult = {
  allowed: true;
  reason: "returning_account" | "disabled" | "allowlist" | "cache" | "provider";
  ruleId?: string;
};
interface Settings {
  enabled: boolean;
  encrypted_api_key: string | null;
  monthly_limit: number;
  provider_remaining: number | null;
  provider_observed_at: Date | null;
}
const unavailable = () =>
  new CheckMailError(
    "CHECK_MAIL_UNAVAILABLE",
    "Email checking is temporarily unavailable. Please try again later.",
  );
const rejected = () =>
  new CheckMailError(
    "CHECK_MAIL_REJECTED",
    "This email address cannot be used for a new account. Please use a permanent email address.",
    403,
  );
const limit = () =>
  new CheckMailError(
    "CHECK_MAIL_LIMIT",
    "New account email checks are temporarily at capacity. Please try again later.",
  );
const validation = (message: string) =>
  new CheckMailError("VALIDATION_ERROR", message, 400);
function emailValue(value: string) {
  if (typeof value !== "string" || value.length > 320 || !isEmail(value))
    throw validation("Enter a valid email address.");
  return normalizeEmail(value);
}
export function normalizeCheckMailRule(
  input: CheckMailAllowlistInput,
): CheckMailAllowlistInput & { enabled: boolean; note: string } {
  if (
    !input ||
    !["exact", "domain", "regex"].includes(input.kind) ||
    typeof input.pattern !== "string" ||
    (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
    (input.note !== undefined && typeof input.note !== "string")
  )
    throw validation("Invalid email-check whitelist rule.");
  let pattern = input.pattern.trim();
  if (input.kind === "exact") pattern = emailValue(pattern);
  else if (input.kind === "domain") {
    pattern = domainToASCII(pattern.replace(/^@/, "").toLowerCase());
    if (
      !pattern ||
      pattern.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        pattern,
      )
    )
      throw validation(
        "Enter a domain such as fcpsschools.net, without a URL or wildcard.",
      );
  } else validateRegex(pattern);
  if ((input.note ?? "").length > 500)
    throw validation("Whitelist notes must be 500 characters or fewer.");
  return {
    kind: input.kind,
    pattern,
    enabled: input.enabled ?? true,
    note: input.note ?? "",
  };
}
export function matchCheckMailAllowlist(
  email: string,
  rules: CheckMailAllowlistRule[],
) {
  const normalized = emailValue(email),
    domain = domainToASCII(normalized.slice(normalized.lastIndexOf("@") + 1));
  return (
    rules.find((rule) => {
      if (!rule.enabled) return false;
      if (rule.kind === "exact")
        return normalizeEmail(rule.pattern) === normalized;
      if (rule.kind === "domain")
        return domain === rule.pattern.replace(/^@/, "").toLowerCase();
      validateRegex(rule.pattern);
      return new RegExp(rule.pattern, "i").test(normalized);
    }) ?? null
  );
}
export function parseCheckMailResponse(value: unknown, email: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  const data = value as Record<string, unknown>;
  if (
    typeof data.valid !== "boolean" ||
    typeof data.block !== "boolean" ||
    typeof data.is_disposable !== "boolean" ||
    typeof data.domain !== "string" ||
    domainToASCII(data.domain.toLowerCase()) !==
      domainToASCII(email.slice(email.lastIndexOf("@") + 1).toLowerCase())
  )
    throw unavailable();
  return { allowed: data.valid && !data.block && !data.is_disposable };
}
export async function requestCheckMail(
  email: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<{
  allowed: boolean;
  providerRemaining: number | null;
  rateLimited?: boolean;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let observedRemaining: number | null = null;
  try {
    const response = await fetcher(CHECK_MAIL_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ email }).toString(),
    });
    const rawRemaining = response.headers.get("x-ratelimit-requests-remaining");
    const remaining =
      rawRemaining !== null && /^\d{1,9}$/.test(rawRemaining)
        ? Number(rawRemaining)
        : null;
    observedRemaining = remaining;
    if (response.status === 429) {
      await response.body?.cancel();
      return {
        allowed: false,
        providerRemaining: 0,
        ...{ rateLimited: true },
      } as { allowed: boolean; providerRemaining: number; rateLimited: true };
    }
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      throw unavailable();
    }
    if (Number(response.headers.get("content-length") ?? 0) > 32_768) {
      await response.body?.cancel();
      throw unavailable();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 32_768) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return {
      ...parseCheckMailResponse(JSON.parse(body), email),
      providerRemaining: remaining,
    };
  } catch (error) {
    const failure = error instanceof CheckMailError ? error : unavailable();
    throw new CheckMailError(
      failure.code,
      failure.message,
      failure.status,
      observedRemaining,
    );
  } finally {
    clearTimeout(timer);
  }
}
export function createCheckMailService(options: {
  pool: Pool;
  dataEncryptionKey: string;
  fetch?: typeof fetch;
}) {
  const { pool, dataEncryptionKey } = options;
  const listAllowlist = async (
    client: Pick<Pool, "query"> | PoolClient = pool,
  ): Promise<CheckMailAllowlistRule[]> =>
    (
      await client.query<CheckMailAllowlistRule>(
        "SELECT id,kind,pattern,enabled,note FROM check_mail_allowlist ORDER BY created_at,id",
      )
    ).rows;
  async function getConfig() {
    const result = await pool.query<
      Settings & { used: number; first_attempt: Date | null }
    >(
      `SELECT s.*, (SELECT count(*)::int FROM check_mail_attempts WHERE created_at>now()-interval '30 days') used,(SELECT min(created_at) FROM check_mail_attempts WHERE created_at>now()-interval '30 days') first_attempt FROM check_mail_settings s WHERE id=true`,
    );
    const row = result.rows[0];
    if (!row) throw unavailable();
    const providerRemaining =
      row.provider_observed_at &&
      Date.now() - new Date(row.provider_observed_at).getTime() < WINDOW_MS
        ? row.provider_remaining
        : null;
    const now = Date.now();
    return {
      enabled: row.enabled,
      configured: !!row.encrypted_api_key,
      monthlyLimit: row.monthly_limit,
      used: row.used,
      remaining: Math.max(
        0,
        Math.min(row.monthly_limit - row.used, providerRemaining ?? Infinity),
      ),
      providerRemaining,
      periodStart: new Date(now - WINDOW_MS).toISOString(),
      periodEnd: new Date(
        row.first_attempt
          ? new Date(row.first_attempt).getTime() + WINDOW_MS
          : now + WINDOW_MS,
      ).toISOString(),
      allowlist: await listAllowlist(),
    };
  }
  async function updateConfig(input: {
    enabled?: boolean;
    apiKey?: string;
    clearApiKey?: boolean;
    monthlyLimit?: number;
  }) {
    if (
      !input ||
      typeof input !== "object" ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      (input.clearApiKey !== undefined &&
        typeof input.clearApiKey !== "boolean") ||
      (input.monthlyLimit !== undefined &&
        (!Number.isInteger(input.monthlyLimit) ||
          input.monthlyLimit < 1 ||
          input.monthlyLimit > 1000))
    )
      throw validation("Monthly check limit must be between 1 and 1000.");
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== "string" ||
        input.apiKey.trim().length < 8 ||
        input.apiKey.length > 4096 ||
        /[\r\n\x00-\x1f\x7f]/.test(input.apiKey))
    )
      throw validation("Enter a valid Check-Mail API key.");
    if (input.clearApiKey && input.apiKey !== undefined)
      throw validation("Set or remove an API key, not both.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = (
        await client.query<Settings>(
          "SELECT * FROM check_mail_settings WHERE id=true FOR UPDATE",
        )
      ).rows[0];
      if (!current) throw unavailable();
      const encryptedKey = input.clearApiKey
        ? null
        : input.apiKey !== undefined
          ? encrypt(input.apiKey.trim(), dataEncryptionKey)
          : current.encrypted_api_key;
      const enabled = input.clearApiKey
        ? false
        : (input.enabled ?? current.enabled);
      if (enabled && !encryptedKey)
        throw validation("Save an API key before enabling email checking.");
      await client.query(
        "UPDATE check_mail_settings SET enabled=$1,encrypted_api_key=$2,monthly_limit=$3,updated_at=now() WHERE id=true",
        [enabled, encryptedKey, input.monthlyLimit ?? current.monthly_limit],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return getConfig();
  }
  async function addAllowlist(input: CheckMailAllowlistInput) {
    const r = normalizeCheckMailRule(input);
    return (
      await pool.query<CheckMailAllowlistRule>(
        "INSERT INTO check_mail_allowlist(kind,pattern,enabled,note) VALUES($1,$2,$3,$4) RETURNING id,kind,pattern,enabled,note",
        [r.kind, r.pattern, r.enabled, r.note],
      )
    ).rows[0]!;
  }
  async function updateAllowlist(id: string, input: CheckMailAllowlistInput) {
    const r = normalizeCheckMailRule(input);
    const result = await pool.query<CheckMailAllowlistRule>(
      "UPDATE check_mail_allowlist SET kind=$2,pattern=$3,enabled=$4,note=$5,updated_at=now() WHERE id=$1 RETURNING id,kind,pattern,enabled,note",
      [id, r.kind, r.pattern, r.enabled, r.note],
    );
    if (!result.rows[0]) throw validation("Whitelist rule not found.");
    return result.rows[0];
  }
  async function deleteAllowlist(id: string) {
    const result = await pool.query(
      "DELETE FROM check_mail_allowlist WHERE id=$1",
      [id],
    );
    if (!result.rowCount) throw validation("Whitelist rule not found.");
    return { deleted: true };
  }
  async function testAllowlist(email: string) {
    const rule = matchCheckMailAllowlist(email, await listAllowlist());
    return { matched: !!rule, rule, skipReason: rule ? "allowlist" : null };
  }
  async function checkNewAccount(
    rawEmail: string,
    input: { accountExists: boolean },
  ): Promise<CheckMailResult> {
    if (input.accountExists)
      return { allowed: true, reason: "returning_account" };
    const email = emailValue(rawEmail),
      emailHash = createHmac("sha256", dataEncryptionKey)
        .update(`check-mail:${email}`)
        .digest("hex");
    const client = await pool.connect();
    let attemptId = "",
      apiKey = "";
    try {
      await client.query("BEGIN");
      const settings = (
        await client.query<Settings>(
          "SELECT * FROM check_mail_settings WHERE id=true FOR UPDATE",
        )
      ).rows[0];
      if (!settings) throw unavailable();
      // A registration may have completed after the caller's first identity lookup.
      if (
        (
          await client.query(
            "SELECT 1 FROM users WHERE normalized_email=$1 LIMIT 1",
            [email],
          )
        ).rowCount
      ) {
        await client.query("COMMIT");
        return { allowed: true, reason: "returning_account" };
      }
      if (!settings.enabled) {
        await client.query("COMMIT");
        return { allowed: true, reason: "disabled" };
      }
      const rule = matchCheckMailAllowlist(email, await listAllowlist(client));
      if (rule) {
        await client.query("COMMIT");
        return { allowed: true, reason: "allowlist", ruleId: rule.id };
      }
      const cached = (
        await client.query<{ outcome: string }>(
          "SELECT outcome FROM check_mail_cache WHERE email_hash=$1 AND expires_at>now()",
          [emailHash],
        )
      ).rows[0];
      if (cached) {
        await client.query("COMMIT");
        if (cached.outcome === "accepted")
          return { allowed: true, reason: "cache" };
        if (cached.outcome === "rejected") throw rejected();
        throw unavailable();
      }
      const used = Number(
        (
          await client.query<{ used: number }>(
            "SELECT count(*)::int used FROM check_mail_attempts WHERE created_at>now()-interval '30 days'",
          )
        ).rows[0]?.used ?? 0,
      );
      if (used >= settings.monthly_limit) throw limit();
      if (
        settings.provider_observed_at &&
        Date.now() - new Date(settings.provider_observed_at).getTime() <
          WINDOW_MS &&
        settings.provider_remaining === 0
      )
        throw limit();
      if (!settings.encrypted_api_key) throw unavailable();
      try {
        apiKey = decrypt(settings.encrypted_api_key, dataEncryptionKey);
      } catch {
        throw unavailable();
      }
      attemptId = randomUUID();
      await client.query(
        "INSERT INTO check_mail_attempts(id,email_hash) VALUES($1,$2)",
        [attemptId, emailHash],
      );
      await client.query(
        "INSERT INTO check_mail_cache(email_hash,attempt_id,outcome,expires_at) VALUES($1,$2,'pending',now()+interval '10 minutes') ON CONFLICT(email_hash) DO UPDATE SET attempt_id=excluded.attempt_id,outcome='pending',expires_at=excluded.expires_at",
        [emailHash, attemptId],
      );
      await client.query(
        "UPDATE check_mail_settings SET provider_remaining=CASE WHEN provider_observed_at>now()-interval '30 days' THEN greatest(0,provider_remaining-1) ELSE NULL END WHERE id=true",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    let result: Awaited<ReturnType<typeof requestCheckMail>>;
    try {
      result = await requestCheckMail(email, apiKey, options.fetch);
    } catch (error) {
      await finalize(
        attemptId,
        emailHash,
        "error",
        error instanceof CheckMailError ? error.providerRemaining : null,
      );
      throw unavailable();
    } finally {
      apiKey = "";
    }
    const rateLimited = "rateLimited" in result;
    await finalize(
      attemptId,
      emailHash,
      rateLimited ? "error" : result.allowed ? "accepted" : "rejected",
      result.providerRemaining,
    );
    if (rateLimited) throw limit();
    if (!result.allowed) throw rejected();
    return { allowed: true, reason: "provider" };
  }
  async function finalize(
    attemptId: string,
    emailHash: string,
    outcome: "accepted" | "rejected" | "error",
    remaining: number | null,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM check_mail_settings WHERE id=true FOR UPDATE",
      );
      await client.query(
        "UPDATE check_mail_attempts SET outcome=$2,completed_at=now() WHERE id=$1",
        [attemptId, outcome],
      );
      await client.query(
        "UPDATE check_mail_cache SET outcome=$3::varchar,expires_at=now()+CASE WHEN $3::varchar='error' THEN interval '1 minute' ELSE interval '30 days' END WHERE email_hash=$1 AND attempt_id=$2",
        [emailHash, attemptId, outcome],
      );
      if (remaining !== null)
        await client.query(
          "UPDATE check_mail_settings SET provider_remaining=CASE WHEN provider_observed_at>now()-interval '30 days' AND provider_remaining IS NOT NULL THEN least(provider_remaining,$1) ELSE $1 END,provider_observed_at=CASE WHEN provider_observed_at>now()-interval '30 days' AND provider_remaining=0 THEN provider_observed_at ELSE now() END WHERE id=true",
          [remaining],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    getConfig,
    updateConfig,
    listAllowlist,
    addAllowlist,
    updateAllowlist,
    deleteAllowlist,
    testAllowlist,
    checkNewAccount,
  };
}
