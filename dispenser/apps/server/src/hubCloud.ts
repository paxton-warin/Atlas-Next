import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AppError } from "./errors.js";
import { encrypt } from "./security.js";
import {
  CloudError,
  hashPlan,
  makePlan,
  validateOrigin,
  type CloudAccount,
  type CloudResource,
  type CloudRole,
} from "./hubCloudWorker.js";

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new AppError("VALIDATION_ERROR", "Invalid operation.");
  return v as Record<string, unknown>;
};
const uuid = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
  )
    throw new AppError("VALIDATION_ERROR", "Invalid identifier.");
  return v;
};
const text = (v: unknown, max: number): string => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\u0000-\u001f\u007f]/.test(v)
  )
    throw new AppError("VALIDATION_ERROR", "Enter a valid value.");
  return v.trim();
};
const conflict = () =>
  new AppError(
    "VALIDATION_ERROR",
    "This operation changed. Refresh before continuing.",
    409,
  );
const safeOrigin = (v: unknown) => {
  try {
    return validateOrigin(v);
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Enter a public origin hostname, without a URL or IP.",
    );
  }
};
const accountFields =
  'id,label,expected_account_id AS "expectedAccountId",verified_account_id AS "verifiedAccountId",region,status,verified_at AS "verifiedAt"';
const endpointFields =
  'e.id,e.role,e.logical_id AS "logicalId",e.link_id AS "linkId",e.account_id AS "accountId",e.distribution_id AS "distributionId",e.url,e.origin_host AS "originHost",e.revision,e.state';
const jobFields =
  'id,plan,plan_hash AS "planHash",state,revision,checkpoint,error_code AS "errorCode",created_at AS "createdAt",updated_at AS "updatedAt"';

export function registerHubCloudRoutes<User extends { id: string }>(
  app: FastifyInstance,
  options: {
    pool: Pool;
    requireAdmin: (r: FastifyRequest) => Promise<User>;
    csrf: (r: FastifyRequest, u: User) => void;
    encryptionKey: string;
  },
) {
  const { pool, requireAdmin, csrf } = options;
  const admin = async (r: FastifyRequest) => {
    const u = await requireAdmin(r);
    if (!["GET", "HEAD"].includes(r.method)) csrf(r, u);
    return u;
  };
  const event = (
    adminId: string,
    action: string,
    target: string,
    value: unknown,
  ) =>
    pool.query(
      "INSERT INTO audit_events(admin_id,action,target_type,target_id,after) VALUES($1,$2,'cloud',$3,$4)",
      [adminId, action, target, JSON.stringify(value)],
    );
  app.get("/api/admin/cloud/accounts", async (r) => {
    await admin(r);
    const accounts = (
      await pool.query(
        `SELECT ${accountFields} FROM hub_cloud_accounts ORDER BY created_at`,
      )
    ).rows;
    const logins = (
      await pool.query(
        'SELECT id,account_id AS "accountId",status,authorization_url AS "authorizationUrl",error_code AS "errorCode",expires_at AS "expiresAt" FROM hub_cloud_login WHERE created_at>now()-interval \'1 day\' ORDER BY created_at DESC LIMIT 50',
      )
    ).rows;
    return {
      accounts,
      logins,
      provider:
        process.env.HUB_CLOUD_FAKE === "1" &&
        process.env.NODE_ENV !== "production"
          ? "local_simulator"
          : "aws",
      workerRequired: true,
      simulationActivation:
        process.env.HUB_CLOUD_SIMULATION_AUTO_ACTIVATE === "1" &&
        process.env.NODE_ENV === "test",
    };
  });
  app.post("/api/admin/cloud/accounts", async (r) => {
    const u = await admin(r);
    const b = object(r.body);
    const label = text(b.label, 120);
    const accountId = text(b.expectedAccountId, 12);
    if (!/^\d{12}$/.test(accountId))
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter the twelve-digit AWS account ID.",
      );
    const region = b.region === undefined ? "us-east-1" : text(b.region, 40);
    if (!/^(?:us|eu|ap|ca|sa|me|af|il|mx)-(?:[a-z]+-)?[a-z]+-\d$/.test(region))
      throw new AppError("VALIDATION_ERROR", "Enter a valid AWS region.");
    const result = await pool.query(
      `INSERT INTO hub_cloud_accounts(label,expected_account_id,region,created_by) VALUES($1,$2,$3,$4) RETURNING ${accountFields}`,
      [label, accountId, region, u.id],
    );
    await event(u.id, "cloud.account_added", result.rows[0].id, {
      label,
      expectedAccountId: accountId,
    });
    return result.rows[0];
  });
  app.post<{ Params: { id: string } }>(
    "/api/admin/cloud/accounts/:id/login",
    async (r) => {
      const u = await admin(r);
      const id = uuid(r.params.id);
      if (
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM hub_cloud_login WHERE account_id=$1 AND created_at>now()-interval '1 hour'",
              [id],
            )
          ).rows[0].count,
        ) >= 10
      )
        throw new AppError(
          "VALIDATION_ERROR",
          "Please wait before requesting another AWS sign-in.",
          429,
        );
      const exists = (
        await pool.query("SELECT id FROM hub_cloud_accounts WHERE id=$1", [id])
      ).rowCount;
      if (!exists)
        throw new AppError("VALIDATION_ERROR", "Account not found.", 404);
      await pool.query(
        "UPDATE hub_cloud_login SET status='expired',encrypted_code=NULL WHERE account_id=$1 AND expires_at<=now() AND status IN ('queued','waiting_code','code_submitted')",
        [id],
      );
      let result;
      try {
        result = await pool.query(
          'INSERT INTO hub_cloud_login(account_id) VALUES($1) RETURNING id,status,expires_at AS "expiresAt"',
          [id],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new AppError(
            "VALIDATION_ERROR",
            "A sign-in is already pending for this account.",
            409,
          );
        throw e;
      }
      await event(u.id, "cloud.login_requested", id, {
        loginId: result.rows[0].id,
      });
      return result.rows[0];
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/cloud/login/:id/code",
    async (r) => {
      await admin(r);
      const b = object(r.body);
      const code = text(b.code, 8192);
      const result = await pool.query(
        "UPDATE hub_cloud_login SET encrypted_code=$2,status='code_submitted' WHERE id=$1 AND status='waiting_code' AND expires_at>now() RETURNING id,status",
        [uuid(r.params.id), encrypt(code, options.encryptionKey)],
      );
      if (!result.rowCount)
        throw new AppError(
          "VALIDATION_ERROR",
          "This sign-in expired or already received its code. Start again.",
          409,
        );
      return result.rows[0];
    },
  );
  if (process.env.NODE_ENV === "test" && process.env.HUB_CLOUD_FAKE === "1") {
    app.post("/api/admin/cloud/simulator/faults", async (r) => {
      const u = await admin(r);
      const b = object(r.body);
      const accountId = uuid(b.accountId);
      const scenarios: Record<string, [string, string]> = {
        expired: ["identity", "SIGN_IN_REQUIRED"],
        wrong_account: ["identity", "AWS_ACCOUNT_MISMATCH"],
        throttled: ["create", "AWS_THROTTLED"],
        lost_ack: ["create_ack", "AWS_TIMEOUT"],
        revision: ["function", "AWS_REVISION_CONFLICT"],
        deployment_delay: ["inspect", "AWS_DEPLOYING"],
      };
      const scenario =
        typeof b.scenario === "string" ? scenarios[b.scenario] : undefined;
      if (!scenario)
        throw new AppError(
          "VALIDATION_ERROR",
          "Choose a local failure scenario.",
        );
      if (
        !(
          await pool.query("SELECT 1 FROM hub_cloud_accounts WHERE id=$1", [
            accountId,
          ])
        ).rowCount
      )
        throw new AppError("VALIDATION_ERROR", "Account not found.", 404);
      const row = (
        await pool.query(
          "INSERT INTO hub_cloud_simulator_faults(account_id,operation,code,created_by) VALUES($1,$2,$3,$4) RETURNING id",
          [accountId, scenario[0], scenario[1], u.id],
        )
      ).rows[0];
      await event(u.id, "cloud.simulator_fault", row.id, {
        accountId,
        scenario: b.scenario,
      });
      return { ok: true, id: row.id };
    });
  }
  app.get("/api/admin/cloud/endpoints", async (r) => {
    await admin(r);
    return {
      endpoints: (
        await pool.query(
          `SELECT ${endpointFields} FROM hub_cloud_endpoints e ORDER BY e.created_at DESC LIMIT 10000`,
        )
      ).rows,
      links: (
        await pool.query(
          "SELECT id,name,url FROM links WHERE enabled ORDER BY created_at DESC LIMIT 10000",
        )
      ).rows,
    };
  });
  app.post("/api/admin/cloud/endpoints", async (r) => {
    const u = await admin(r);
    const b = object(r.body);
    const role = text(b.role, 16) as CloudRole;
    if (!["hub", "frontend", "node"].includes(role))
      throw new AppError("VALIDATION_ERROR", "Choose a valid endpoint role.");
    const logicalId =
      role === "frontend" ? uuid(b.linkId) : text(b.logicalId, 120);
    const id = uuid(b.accountId);
    const distributionId = text(b.distributionId, 64);
    const url = text(b.url, 300);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter the CloudFront HTTPS address.",
      );
    }
    if (
      !/^[A-Z0-9]{1,64}$/.test(distributionId) ||
      parsed.protocol !== "https:" ||
      !/^d[a-z0-9]+\.cloudfront\.net$/.test(parsed.hostname) ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "Enter a CloudFront distribution ID and its HTTPS address.",
      );
    const origin = safeOrigin(b.originHost);
    if (role === "frontend") {
      const link = (
        await pool.query("SELECT url FROM links WHERE id=$1", [logicalId])
      ).rows[0];
      if (!link || new URL(link.url).origin !== parsed.origin)
        throw new AppError(
          "VALIDATION_ERROR",
          "Select the existing logical link matching this address.",
        );
    }
    if (
      !(
        await pool.query(
          "SELECT 1 FROM hub_cloud_accounts WHERE id=$1 AND status='connected'",
          [id],
        )
      ).rowCount
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "Sign into this AWS account first.",
      );
    const endpoint = (
      await pool.query(
        `INSERT INTO hub_cloud_endpoints(role,logical_id,link_id,account_id,distribution_id,url,origin_host,state) VALUES($1,$2,$3,$4,$5,$6,$7,'staged') RETURNING id`,
        [
          role,
          logicalId,
          role === "frontend" ? logicalId : null,
          id,
          distributionId,
          parsed.origin,
          origin,
        ],
      )
    ).rows[0];
    if (
      process.env.HUB_CLOUD_FAKE === "1" &&
      process.env.NODE_ENV !== "production"
    )
      await pool.query(
        "INSERT INTO hub_cloud_simulator_resources(account_id,id,resource) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          id,
          distributionId,
          JSON.stringify({
            id: distributionId,
            domain: parsed.hostname,
            status: "Deployed",
            caller: "fixture-import",
            originHost: origin,
          }),
        ],
      );
    await event(u.id, "cloud.endpoint_imported", endpoint.id, {
      role,
      logicalId,
      state: "staged",
    });
    return endpoint;
  });
  app.post("/api/admin/cloud/plans", async (r) => {
    const u = await admin(r);
    const b = object(r.body);
    const accountId = uuid(b.accountId);
    const row = (
      await pool.query(
        `SELECT id,expected_account_id AS "expectedAccountId",region FROM hub_cloud_accounts WHERE id=$1 AND status='connected' AND verified_account_id=expected_account_id`,
        [accountId],
      )
    ).rows[0] as CloudAccount | undefined;
    if (!row)
      throw new AppError(
        "VALIDATION_ERROR",
        "Sign into and verify the target account first.",
      );
    if (
      !Array.isArray(b.operations) ||
      !b.operations.length ||
      b.operations.length > 5000
    )
      throw new AppError("VALIDATION_ERROR", "Add at least one operation.");
    const resources: CloudResource[] = [];
    for (const item of b.operations) {
      const op = object(item);
      if (op.kind === "replace") {
        const old = (
          await pool.query(
            `SELECT ${endpointFields} FROM hub_cloud_endpoints e WHERE e.id=$1 AND e.state IN ('active','staged')`,
            [uuid(op.endpointId)],
          )
        ).rows[0];
        if (!old || old.revision !== op.revision) throw conflict();
        resources.push({
          key: `replace-${old.id}`,
          role: old.role,
          logicalId: old.logicalId,
          originHost: old.originHost,
          previous: {
            id: old.id,
            revision: old.revision,
            distributionId: old.distributionId,
            accountId: old.accountId,
            url: old.url,
          },
        });
      } else if (op.kind === "create") {
        const role = text(op.role, 16) as CloudRole;
        const count = op.count === undefined ? 1 : Number(op.count);
        if (
          !["hub", "frontend", "node"].includes(role) ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 5000 ||
          (role !== "frontend" && count !== 1)
        )
          throw new AppError(
            "VALIDATION_ERROR",
            "Choose 1–5000 frontends, or one Hub/node per operation.",
          );
        const originHost = safeOrigin(op.originHost);
        for (let i = 0; i < count; i++) {
          const logicalId =
            role === "frontend" ? randomUUID() : text(op.logicalId, 120);
          resources.push({
            key: `new-${randomUUID()}`,
            role,
            logicalId,
            originHost,
          });
        }
      } else
        throw new AppError("VALIDATION_ERROR", "Choose create or replace.");
      if (resources.length > 5000)
        throw new AppError(
          "VALIDATION_ERROR",
          "This operation exceeds 5000 endpoints.",
        );
    }
    let plan;
    try {
      plan = makePlan(row, resources);
    } catch (e) {
      if (e instanceof CloudError)
        throw new AppError(
          "VALIDATION_ERROR",
          "The operation contains invalid or duplicate endpoints.",
        );
      throw e;
    }
    const result = (
      await pool.query(
        `INSERT INTO hub_cloud_jobs(plan,plan_hash,created_by) VALUES($1,$2,$3) RETURNING ${jobFields}`,
        [JSON.stringify(plan), hashPlan(plan), u.id],
      )
    ).rows[0];
    await event(u.id, "cloud.plan_created", result.id, {
      hash: result.planHash,
      resources: resources.length,
    });
    return result;
  });
  app.get("/api/admin/cloud/jobs", async (r) => {
    await admin(r);
    return {
      jobs: (
        await pool.query(
          `SELECT ${jobFields} FROM hub_cloud_jobs ORDER BY created_at DESC LIMIT 50`,
        )
      ).rows,
    };
  });
  for (const action of ["approve", "resume", "cancel"] as const)
    app.post<{ Params: { id: string } }>(
      `/api/admin/cloud/jobs/:id/${action}`,
      async (r) => {
        const u = await admin(r);
        const id = uuid(r.params.id);
        const b = object(r.body);
        if (!Number.isSafeInteger(b.revision) || Number(b.revision) < 0)
          throw conflict();
        const result = await pool.query(
          `UPDATE hub_cloud_jobs SET state=$3,approved_by=CASE WHEN $4='approve' THEN $5 ELSE approved_by END,revision=revision+1,error_code=NULL,updated_at=now() WHERE id=$1 AND revision=$2 AND ${action === "approve" ? "state='preview'" : action === "resume" ? "state IN ('failed','sign_in_required','waiting')" : "state IN ('preview','queued','running','waiting','sign_in_required','ready_for_activation','failed')"} RETURNING ${jobFields}`,
          [
            id,
            b.revision,
            action === "cancel" ? "cancelled" : "queued",
            action,
            u.id,
          ],
        );
        if (!result.rowCount) throw conflict();
        await event(u.id, `cloud.job_${action}`, id, {
          revision: result.rows[0].revision,
        });
        return result.rows[0];
      },
    );
}
