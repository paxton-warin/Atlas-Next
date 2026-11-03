import { domainToASCII } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  isEmail,
  normalizeEmail,
  type ManualVerificationRequest,
  type ManualVerificationState,
} from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
import {
  queryPage,
  searchPattern,
  statusFilter,
  type PageQuery,
} from "./pagination.js";

type User = { id: string; email: string; role: "admin" | "user" };
type Queryable = Pick<Pool, "query">;
const requestFields = `r.id,r.user_id AS "userId",r.domain,r.name,r.school_name AS "schoolName",r.additional_information AS "additionalInformation",r.status,r.revision,r.submitted_at AS "submittedAt",r.updated_at AS "updatedAt",r.reviewed_at AS "reviewedAt",r.review_note AS "reviewNote"`;
const schoolFields = `s.id,s.domain_id AS "domainId",s.name,s.enabled,s.created_at AS "createdAt",s.updated_at AS "updatedAt",(SELECT count(*)::int FROM manual_verification_known_emails e WHERE e.school_id=s.id) AS "emailCount"`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("VALIDATION_ERROR", "Invalid request.");
  return value as Record<string, unknown>;
}
function field(
  value: unknown,
  name: string,
  max: number,
  required = true,
): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new AppError(
      "VALIDATION_ERROR",
      `${name} must be ${required ? "between 1 and" : "no more than"} ${max} characters.`,
    );
  return value.trim();
}
function enabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new AppError("VALIDATION_ERROR", "Enabled must be true or false.");
  return value;
}
function identifier(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AppError("VALIDATION_ERROR", "Invalid record identifier.");
  return value;
}
function revision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > 2_147_483_646
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "A current request revision is required.",
    );
  return Number(value);
}
function conflict(): never {
  throw new AppError(
    "MANUAL_VERIFICATION_CONFLICT",
    "This request changed. Refresh it before saving or reviewing.",
    409,
  );
}
function missing(): never {
  throw new AppError("VALIDATION_ERROR", "Record not found.", 404);
}
export function normalizeDirectoryDomain(value: unknown): string {
  if (typeof value !== "string")
    throw new AppError("VALIDATION_ERROR", "Enter an email domain.");
  const raw = value.trim().toLowerCase().replace(/^@/, "");
  if (/[\\/:@?#\s]/.test(raw))
    throw new AppError(
      "VALIDATION_ERROR",
      "Enter a valid email domain, without a URL or wildcard.",
    );
  const domain = domainToASCII(raw);
  if (
    !domain ||
    domain.length > 253 ||
    !domain.includes(".") ||
    !domain
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Enter a valid email domain, without a URL or wildcard.",
    );
  return domain;
}
export function parseDirectoryEmails(value: unknown, domain: string): string[] {
  if (typeof value !== "string" || value.length > 1_900_000)
    throw new AppError(
      "VALIDATION_ERROR",
      "Upload a plain-text email directory under 1.9 MB.",
    );
  const entries = value
    .replace(/^\uFEFF/, "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (entries.length > 50_000)
    throw new AppError(
      "VALIDATION_ERROR",
      "A directory may contain at most 50,000 email entries.",
    );
  const emails = new Set<string>();
  for (const entry of entries) {
    const email = normalizeEmail(entry);
    if (
      email.length > 320 ||
      /[\u0000-\u001f\u007f]/.test(email) ||
      !isEmail(email) ||
      email.split("@")[1] !== domain
    )
      throw new AppError(
        "VALIDATION_ERROR",
        `Every directory entry must be an email in @${domain}. No changes were saved.`,
      );
    emails.add(email);
  }
  return [...emails].sort();
}
export function createManualVerificationService(pool: Pool) {
  const state = async (
    user: User,
    queryable: Queryable = pool,
  ): Promise<ManualVerificationState> => {
    const domain = user.email.toLowerCase().split("@")[1] ?? "";
    if (user.role === "admin")
      return {
        required: false,
        status: "not_required",
        domain: null,
        request: null,
      };
    const policy = (
      await queryable.query<{ enabled: boolean }>(
        "SELECT enabled FROM manual_verification_domains WHERE domain=$1",
        [domain],
      )
    ).rows[0];
    const request =
      (
        await queryable.query<ManualVerificationRequest>(
          `SELECT ${requestFields} FROM manual_verification_requests r WHERE r.user_id=$1`,
          [user.id],
        )
      ).rows[0] ?? null;
    if (!policy?.enabled)
      return { required: false, status: "not_required", domain: null, request };
    // An explicit denial is authoritative, even if a later import contains this email.
    if (request?.status === "denied")
      return { required: true, status: "denied", domain, request };
    if (request?.status === "approved")
      return { required: false, status: "approved", domain, request };
    const known = await queryable.query(
      "SELECT 1 FROM manual_verification_known_emails e JOIN manual_verification_schools s ON s.id=e.school_id JOIN manual_verification_domains d ON d.id=s.domain_id WHERE d.domain=$1 AND d.enabled AND s.enabled AND e.email=$2 LIMIT 1",
      [domain, normalizeEmail(user.email)],
    );
    if (known.rowCount)
      return { required: false, status: "not_required", domain, request };
    return {
      required: true,
      status: request?.status ?? "required",
      domain,
      request,
    };
  };
  return { state };
}

export function registerManualVerificationRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    requireUser: (request: FastifyRequest) => Promise<User>;
    requireAdmin: (request: FastifyRequest) => Promise<User>;
    csrf: (request: FastifyRequest, user: any) => void;
    audit: (
      adminId: string,
      action: string,
      targetType: string,
      targetId: string | null,
      before: unknown,
      after: unknown,
    ) => Promise<unknown>;
  },
) {
  const { pool, requireUser, requireAdmin, csrf, audit } = options;
  const { state } = createManualVerificationService(pool);
  const id = (request: FastifyRequest) =>
    identifier((request.params as { id: string }).id);
  const transaction = async <T>(run: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505")
        throw new AppError(
          "VALIDATION_ERROR",
          "That domain or school already exists.",
          409,
        );
      throw error;
    } finally {
      client.release();
    }
  };
  app.get("/api/manual-verification", async (request) =>
    state(await requireUser(request)),
  );
  app.put("/api/manual-verification", async (request) => {
    const user = await requireUser(request);
    csrf(request, user);
    const input = object(request.body);
    const value = {
      name: field(input.name, "Name", 160),
      schoolName: field(input.schoolName, "School name", 200),
      additionalInformation: field(
        input.additionalInformation,
        "Additional information",
        5000,
      ),
      revision: revision(input.revision),
    };
    return transaction(async (client) => {
      // The user row serializes two concurrent first submissions without duplicate requests.
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      const current = await state(user, client);
      if (user.role === "admin" || (!current.required && !current.request))
        throw new AppError(
          "VALIDATION_ERROR",
          "Manual verification is not required for this account.",
        );
      if (value.revision !== (current.request?.revision ?? 0)) conflict();
      if (!current.domain && !current.request)
        throw new AppError(
          "VALIDATION_ERROR",
          "Manual verification is not required for this account.",
        );
      if (!current.request)
        await client.query(
          "INSERT INTO manual_verification_requests(user_id,domain,name,school_name,additional_information) VALUES($1,$2,$3,$4,$5)",
          [
            user.id,
            current.domain,
            value.name,
            value.schoolName,
            value.additionalInformation,
          ],
        );
      else {
        const updated = await client.query(
          "UPDATE manual_verification_requests SET name=$3,school_name=$4,additional_information=$5,status=CASE WHEN status='denied' THEN 'denied' ELSE 'pending' END,revision=revision+1,updated_at=now(),reviewed_at=CASE WHEN status='denied' THEN reviewed_at ELSE NULL END,reviewed_by=CASE WHEN status='denied' THEN reviewed_by ELSE NULL END,review_note=CASE WHEN status='denied' THEN review_note ELSE '' END WHERE user_id=$1 AND revision=$2 RETURNING id",
          [
            user.id,
            value.revision,
            value.name,
            value.schoolName,
            value.additionalInformation,
          ],
        );
        if (!updated.rowCount) conflict();
      }
      return state(user, client);
    });
  });

  app.get("/api/admin/manual-verification/domains", async (request) => {
    await requireAdmin(request);
    const result = await pool.query(
      `SELECT d.id,d.domain,d.enabled,(SELECT count(*)::int FROM manual_verification_schools s WHERE s.domain_id=d.id) AS "schoolCount",(SELECT count(DISTINCT e.email)::int FROM manual_verification_known_emails e JOIN manual_verification_schools s ON s.id=e.school_id WHERE s.domain_id=d.id AND s.enabled) AS "knownEmailCount" FROM manual_verification_domains d ORDER BY d.domain`,
    );
    return { domains: result.rows };
  });
  app.post("/api/admin/manual-verification/domains", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const input = object(request.body);
    const domain = normalizeDirectoryDomain(input.domain);
    const result = await transaction((client) =>
      client.query(
        'INSERT INTO manual_verification_domains(domain,enabled) VALUES($1,$2) RETURNING id,domain,enabled,0 AS "schoolCount",0 AS "knownEmailCount"',
        [domain, enabled(input.enabled, false)],
      ),
    );
    const item = result.rows[0];
    await audit(
      admin.id,
      "manual.domain.create",
      "manual_domain",
      item.id,
      null,
      item,
    );
    return item;
  });
  app.put("/api/admin/manual-verification/domains/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const input = object(request.body);
    const result = await pool.query(
      "UPDATE manual_verification_domains SET enabled=$2,updated_at=now() WHERE id=$1 RETURNING id,domain,enabled",
      [id(request), enabled(input.enabled, false)],
    );
    if (!result.rows[0]) missing();
    await audit(
      admin.id,
      "manual.domain.update",
      "manual_domain",
      id(request),
      null,
      result.rows[0],
    );
    return result.rows[0];
  });
  app.delete("/api/admin/manual-verification/domains/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const result = await pool.query(
      "DELETE FROM manual_verification_domains WHERE id=$1 RETURNING domain",
      [id(request)],
    );
    if (!result.rowCount) missing();
    await audit(
      admin.id,
      "manual.domain.delete",
      "manual_domain",
      id(request),
      result.rows[0],
      { deleted: true },
    );
    return { ok: true };
  });
  app.get(
    "/api/admin/manual-verification/domains/:id/schools",
    async (request) => {
      await requireAdmin(request);
      const result = await pool.query(
        `SELECT ${schoolFields} FROM manual_verification_schools s WHERE s.domain_id=$1 ORDER BY s.name,s.id`,
        [id(request)],
      );
      return { schools: result.rows };
    },
  );
  app.post(
    "/api/admin/manual-verification/domains/:id/schools",
    async (request) => {
      const admin = await requireAdmin(request);
      csrf(request, admin);
      const input = object(request.body);
      const domainId = id(request);
      const name = field(input.name, "School name", 200);
      const school = await transaction(async (client) => {
        const domain = (
          await client.query<{ domain: string }>(
            "SELECT domain FROM manual_verification_domains WHERE id=$1 FOR UPDATE",
            [domainId],
          )
        ).rows[0];
        if (!domain) missing();
        const emails = parseDirectoryEmails(input.text ?? "", domain.domain);
        const row = (
          await client.query<{ id: string }>(
            "INSERT INTO manual_verification_schools(domain_id,name,enabled) VALUES($1,$2,$3) RETURNING id",
            [domainId, name, enabled(input.enabled, true)],
          )
        ).rows[0]!;
        if (emails.length)
          await client.query(
            "INSERT INTO manual_verification_known_emails(school_id,email) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",
            [row.id, emails],
          );
        return (
          await client.query(
            `SELECT ${schoolFields} FROM manual_verification_schools s WHERE s.id=$1`,
            [row.id],
          )
        ).rows[0];
      });
      await audit(
        admin.id,
        "manual.school.create",
        "manual_school",
        school.id,
        null,
        { domainId, name, emailCount: school.emailCount },
      );
      return school;
    },
  );
  app.put("/api/admin/manual-verification/schools/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const input = object(request.body);
    const school = await transaction(async (client) => {
      const old = (
        await client.query<{ name: string; enabled: boolean }>(
          "SELECT name,enabled FROM manual_verification_schools WHERE id=$1 FOR UPDATE",
          [id(request)],
        )
      ).rows[0];
      if (!old) missing();
      await client.query(
        "UPDATE manual_verification_schools SET name=$2,enabled=$3,updated_at=now() WHERE id=$1",
        [
          id(request),
          input.name === undefined
            ? old.name
            : field(input.name, "School name", 200),
          enabled(input.enabled, old.enabled),
        ],
      );
      return (
        await client.query(
          `SELECT ${schoolFields} FROM manual_verification_schools s WHERE s.id=$1`,
          [id(request)],
        )
      ).rows[0];
    });
    await audit(
      admin.id,
      "manual.school.update",
      "manual_school",
      school.id,
      null,
      {
        name: school.name,
        enabled: school.enabled,
        emailCount: school.emailCount,
      },
    );
    return school;
  });
  app.delete("/api/admin/manual-verification/schools/:id", async (request) => {
    const admin = await requireAdmin(request);
    csrf(request, admin);
    const result = await pool.query(
      "DELETE FROM manual_verification_schools WHERE id=$1 RETURNING name,domain_id",
      [id(request)],
    );
    if (!result.rowCount) missing();
    await audit(
      admin.id,
      "manual.school.delete",
      "manual_school",
      id(request),
      result.rows[0],
      { deleted: true },
    );
    return { ok: true };
  });
  app.get(
    "/api/admin/manual-verification/schools/:id/emails",
    async (request) => {
      await requireAdmin(request);
      const result = await pool.query<{ email: string }>(
        "SELECT email FROM manual_verification_known_emails WHERE school_id=$1 ORDER BY email",
        [id(request)],
      );
      return { emails: result.rows.map((row) => row.email) };
    },
  );
  app.put(
    "/api/admin/manual-verification/schools/:id/emails",
    async (request) => {
      const admin = await requireAdmin(request);
      csrf(request, admin);
      const input = object(request.body);
      if (input.mode !== "replace" && input.mode !== "add")
        throw new AppError(
          "VALIDATION_ERROR",
          "Choose add or replace for the directory.",
        );
      const result = await transaction(async (client) => {
        const row = (
          await client.query<{ domain: string }>(
            "SELECT d.domain FROM manual_verification_schools s JOIN manual_verification_domains d ON d.id=s.domain_id WHERE s.id=$1 FOR UPDATE OF s",
            [id(request)],
          )
        ).rows[0];
        if (!row) missing();
        const emails = parseDirectoryEmails(input.text, row.domain);
        if (input.mode === "replace")
          await client.query(
            "DELETE FROM manual_verification_known_emails WHERE school_id=$1",
            [id(request)],
          );
        const added = emails.length
          ? ((
              await client.query(
                "INSERT INTO manual_verification_known_emails(school_id,email) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",
                [id(request), emails],
              )
            ).rowCount ?? 0)
          : 0;
        await client.query(
          "UPDATE manual_verification_schools SET updated_at=now() WHERE id=$1",
          [id(request)],
        );
        const school = (
          await client.query(
            `SELECT ${schoolFields} FROM manual_verification_schools s WHERE s.id=$1`,
            [id(request)],
          )
        ).rows[0];
        return { school, added, total: school.emailCount };
      });
      await audit(
        admin.id,
        "manual.directory.update",
        "manual_school",
        id(request),
        null,
        { mode: input.mode, added: result.added, total: result.total },
      );
      return result;
    },
  );
  app.get("/api/admin/manual-verification/requests", async (request) => {
    await requireAdmin(request);
    const query = request.query as PageQuery;
    const status = statusFilter(query, [
      "all",
      "pending",
      "approved",
      "denied",
    ]);
    const values: unknown[] = [searchPattern(query)];
    let where =
      "(u.email ILIKE $1 OR r.name ILIKE $1 OR r.school_name ILIKE $1)";
    if (status !== "all") {
      values.push(status);
      where += " AND r.status=$2";
    }
    const result = await queryPage(pool, query, {
      select: `${requestFields},u.email`,
      from: "manual_verification_requests r JOIN users u ON u.id=r.user_id",
      where,
      values,
      order: "r.updated_at DESC,r.id DESC",
    });
    return { requests: result.items, pagination: result.pagination };
  });
  app.put(
    "/api/admin/manual-verification/requests/:id/review",
    async (request) => {
      const admin = await requireAdmin(request);
      csrf(request, admin);
      const input = object(request.body);
      const expected = revision(input.revision);
      if (input.decision !== "approved" && input.decision !== "denied")
        throw new AppError("VALIDATION_ERROR", "Choose approve or deny.");
      const note = field(input.reviewNote ?? "", "Review note", 1000, false);
      // Atomic revision compare makes edits and review mutually exclusive: stale content is never approved.
      const result = await pool.query(
        "UPDATE manual_verification_requests SET status=$3,revision=revision+1,reviewed_at=now(),reviewed_by=$4,review_note=$5,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING id",
        [id(request), expected, input.decision, admin.id, note],
      );
      if (!result.rowCount) {
        if (
          !(
            await pool.query(
              "SELECT 1 FROM manual_verification_requests WHERE id=$1",
              [id(request)],
            )
          ).rowCount
        )
          missing();
        conflict();
      }
      const reviewed = (
        await pool.query(
          `SELECT ${requestFields},u.email FROM manual_verification_requests r JOIN users u ON u.id=r.user_id WHERE r.id=$1`,
          [id(request)],
        )
      ).rows[0];
      await audit(
        admin.id,
        "manual.request.review",
        "manual_request",
        id(request),
        { revision: expected },
        { decision: input.decision, revision: expected + 1 },
      );
      return { request: reviewed };
    },
  );
}
