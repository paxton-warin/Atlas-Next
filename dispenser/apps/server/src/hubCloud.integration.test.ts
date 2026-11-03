import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerHubCloudRoutes } from "./hubCloud.js";
import { AppError } from "./errors.js";
import {
  HubCloudWorker,
  DatabaseFakeCloudAdapter,
  type CloudCheckpoint,
} from "./hubCloudWorker.js";
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Hub cloud admin routes and durable local worker integration", () => {
  const schema = `cloud_${randomUUID().replaceAll("-", "")}`;
  const admin = randomUUID(),
    user = randomUUID();
  const headers = { "x-test-user": admin, "x-test-csrf": "yes" };
  let pool: Pool, maintenance: Pool, worker: HubCloudWorker;
  const app = Fastify();
  let oldAccount: string, newAccount: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith("_test"))
      throw Error("Dedicated test database required");
    process.env.HUB_CLOUD_FAKE = "1";
    maintenance = new Pool({ connectionString: url });
    await maintenance.query("SELECT pg_advisory_lock(870412201)");
    try {
      await maintenance.query(
        "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
      );
      const extension = (
        await maintenance.query(
          "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'",
        )
      ).rows[0];
      if (extension?.nspname !== "public")
        await maintenance.query("ALTER EXTENSION pgcrypto SET SCHEMA public");
    } finally {
      await maintenance.query("SELECT pg_advisory_unlock(870412201)");
    }
    await maintenance.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await pool.query(
      await readFile(
        new URL(
          "../../../packages/database/migrations/0001_initial.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL(
          "../../../packages/database/migrations/0010_hub_cloud.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL(
          "../../../packages/database/migrations/0014_hub_cloud_simulator_faults.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    app.setErrorHandler((e, _r, reply) => {
      reply.code(e instanceof AppError ? e.status : 500).send({
        error: {
          code: e instanceof AppError ? e.code : "INTERNAL_ERROR",
          message: e instanceof Error ? e.message : "Unknown error",
        },
      });
    });
    registerHubCloudRoutes(app, {
      pool,
      encryptionKey: "fixture-encryption-secret",
      requireAdmin: async (r) => {
        if (r.headers["x-test-user"] !== admin)
          throw new AppError("FORBIDDEN", "Not an administrator.", 403);
        return { id: admin };
      },
      csrf: (r) => {
        if (r.headers["x-test-csrf"] !== "yes")
          throw new AppError("FORBIDDEN", "CSRF failed.", 403);
      },
    });
    await app.ready();
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE hub_cloud_events,hub_cloud_jobs,hub_cloud_login,hub_cloud_simulator_resources,hub_cloud_simulator_functions,hub_cloud_endpoints,hub_cloud_accounts,link_assignments,links,audit_events,users CASCADE",
    );
    await pool.query(
      "INSERT INTO users(id,email,normalized_email,role) VALUES($1,'admin@example.com','admin@example.com','admin'),($2,'user@example.com','user@example.com','user')",
      [admin, user],
    );
    oldAccount = (
      await pool.query(
        "INSERT INTO hub_cloud_accounts(label,expected_account_id,verified_account_id,status) VALUES('Old','111111111111','111111111111','connected') RETURNING id",
      )
    ).rows[0].id;
    newAccount = (
      await pool.query(
        "INSERT INTO hub_cloud_accounts(label,expected_account_id,verified_account_id,status) VALUES('New','222222222222','222222222222','connected') RETURNING id",
      )
    ).rows[0].id;
    worker = new HubCloudWorker(pool, {
      encryptionKey: "fixture-encryption-secret",
      fake: true,
    });
  });
  afterAll(async () => {
    await worker?.close();
    await app.close();
    await pool?.end();
    if (maintenance) {
      await maintenance.query(`DROP SCHEMA ${schema} CASCADE`);
      await maintenance.end();
    }
    delete process.env.HUB_CLOUD_FAKE;
  });
  const request = (
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url: "/api/admin/cloud" + path, headers, payload });
  const create = async (count = 1) => {
    const res = await request("POST", "/plans", {
      accountId: newAccount,
      operations: [
        {
          kind: "create",
          role: "frontend",
          count,
          originHost: "vps.example.com",
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  it("protects reads and writes with admin authentication and CSRF", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/cloud/accounts" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/cloud/accounts",
          headers: { "x-test-user": admin },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/cloud/jobs",
          headers: { "x-test-user": user },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("never returns credential caches or submitted authorization codes", async () => {
    await pool.query(
      "UPDATE hub_cloud_accounts SET encrypted_cache='cipher-secret' WHERE id=$1",
      [oldAccount],
    );
    const login = (
      await request("POST", `/accounts/${oldAccount}/login`)
    ).json();
    await pool.query(
      "UPDATE hub_cloud_login SET status='waiting_code',authorization_url='https://signin.aws.amazon.com/oauth' WHERE id=$1",
      [login.id],
    );
    expect(
      (
        await request("POST", `/login/${login.id}/code`, {
          code: "secret-auth-code",
        })
      ).statusCode,
    ).toBe(200);
    const secret = (
      await pool.query(
        "SELECT encrypted_code FROM hub_cloud_login WHERE id=$1",
        [login.id],
      )
    ).rows[0].encrypted_code;
    expect(secret).not.toContain("secret-auth-code");
    const output = (await request("GET", "/accounts")).body;
    expect(output).not.toContain("cipher-secret");
    expect(output).not.toContain("secret-auth-code");
    expect(output).not.toContain("encrypted_code");
  });
  it("queues fake sign-in and verifies the expected account without invoking AWS", async () => {
    const row = (
      await request("POST", "/accounts", {
        label: "Third",
        expectedAccountId: "333333333333",
        region: "us-east-1",
      })
    ).json();
    expect(row.status).toBe("sign_in_required");
    const login = (await request("POST", `/accounts/${row.id}/login`)).json();
    await worker.tick();
    expect(
      (
        await pool.query(
          "SELECT status,verified_account_id FROM hub_cloud_accounts WHERE id=$1",
          [row.id],
        )
      ).rows[0],
    ).toEqual({ status: "connected", verified_account_id: "333333333333" });
    expect(
      (
        await pool.query("SELECT status FROM hub_cloud_login WHERE id=$1", [
          login.id,
        ])
      ).rows[0].status,
    ).toBe("complete");
  });
  it("keeps previews immutable and requires an exact revision to approve", async () => {
    const plan = await create();
    expect(
      (await request("POST", `/jobs/${plan.id}/approve`, { revision: 9 }))
        .statusCode,
    ).toBe(409);
    await expect(
      pool.query(
        'UPDATE hub_cloud_jobs SET plan=plan||\'{"accountId":"changed"}\'::jsonb WHERE id=$1',
        [plan.id],
      ),
    ).rejects.toThrow("immutable");
    expect(
      (await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 }))
        .statusCode,
    ).toBe(200);
    expect(
      (await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 }))
        .statusCode,
    ).toBe(409);
  });
  it("runs 101-endpoint job to validation hold without changing existing links or quotas", async () => {
    const original = (
      await pool.query(
        "INSERT INTO links(name,url) VALUES('Existing','https://dold.cloudfront.net') RETURNING id,url",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)",
      [user, original.id],
    );
    const plan = await create(101);
    await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 });
    await worker.tick();
    const row = (
      await pool.query("SELECT * FROM hub_cloud_jobs WHERE id=$1", [plan.id])
    ).rows[0];
    expect(row.state).toBe("ready_for_activation");
    expect(Object.keys(row.checkpoint.resources)).toHaveLength(101);
    expect((await pool.query("SELECT * FROM links")).rows).toHaveLength(1);
    expect(
      (await pool.query("SELECT url FROM links WHERE id=$1", [original.id]))
        .rows[0].url,
    ).toBe(original.url);
    expect(
      (await pool.query("SELECT count(*) FROM link_assignments")).rows[0].count,
    ).toBe("1");
  });
  it("replaces exactly one selected imported endpoint and retains logical identity", async () => {
    const links = (
      await pool.query(
        "INSERT INTO links(name,url) VALUES('One','https://done.cloudfront.net'),('Two','https://dtwo.cloudfront.net') RETURNING id,name,url",
      )
    ).rows;
    const endpoint = (
      await request("POST", "/endpoints", {
        role: "frontend",
        accountId: oldAccount,
        linkId: links[0].id,
        distributionId: "OLDONE",
        url: links[0].url,
        originHost: "vps.example.com",
      })
    ).json();
    const plan = (
      await request("POST", "/plans", {
        accountId: newAccount,
        operations: [{ kind: "replace", endpointId: endpoint.id, revision: 1 }],
      })
    ).json();
    expect(plan.plan.resources[0].logicalId).toBe(links[0].id);
    expect(plan.plan.resources).toHaveLength(1);
    await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 });
    await worker.tick();
    expect(
      (
        await pool.query("SELECT state FROM hub_cloud_jobs WHERE id=$1", [
          plan.id,
        ])
      ).rows[0].state,
    ).toBe("ready_for_activation");
    expect(
      (await pool.query("SELECT id,url FROM links ORDER BY name")).rows,
    ).toEqual(links.map((l) => ({ id: l.id, url: l.url })));
  });
  it("rejects stale endpoint revisions before creating remote resources", async () => {
    const link = (
      await pool.query(
        "INSERT INTO links(name,url) VALUES('One','https://done.cloudfront.net') RETURNING id",
      )
    ).rows[0];
    const endpoint = (
      await request("POST", "/endpoints", {
        role: "frontend",
        accountId: oldAccount,
        linkId: link.id,
        distributionId: "OLDONE",
        url: "https://done.cloudfront.net",
        originHost: "vps.example.com",
      })
    ).json();
    const plan = (
      await request("POST", "/plans", {
        accountId: newAccount,
        operations: [{ kind: "replace", endpointId: endpoint.id, revision: 1 }],
      })
    ).json();
    await pool.query("UPDATE hub_cloud_endpoints SET revision=2 WHERE id=$1", [
      endpoint.id,
    ]);
    await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 });
    await worker.tick();
    const job = (
      await pool.query(
        "SELECT state,error_code FROM hub_cloud_jobs WHERE id=$1",
        [plan.id],
      )
    ).rows[0];
    expect(job).toEqual({
      state: "failed",
      error_code: "ENDPOINT_REVISION_CONFLICT",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_cloud_simulator_resources WHERE account_id=$1",
          [newAccount],
        )
      ).rows[0].count,
    ).toBe("0");
  });
  it("simulator inventory survives worker restart independently of checkpoints", async () => {
    const adapter = await new DatabaseFakeCloudAdapter(
      pool,
      newAccount,
      "222222222222",
    ).restore();
    const resource = {
      key: "one",
      role: "frontend" as const,
      logicalId: "logical-one",
      originHost: "vps.example.com",
    };
    await adapter.create("job", resource, "fn");
    const fresh = await new DatabaseFakeCloudAdapter(
      pool,
      newAccount,
      "222222222222",
    ).restore();
    expect(await fresh.inventory()).toHaveLength(1);
    await expect(fresh.create("job", resource, "fn")).rejects.toMatchObject({
      code: "AWS_RECONCILE_REQUIRED",
    });
  });
  it("cancels queued work and refuses stale resume", async () => {
    const plan = await create();
    await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 });
    expect(
      (await request("POST", `/jobs/${plan.id}/cancel`, { revision: 1 }))
        .statusCode,
    ).toBe(200);
    await worker.tick();
    expect(
      (
        await pool.query("SELECT state FROM hub_cloud_jobs WHERE id=$1", [
          plan.id,
        ])
      ).rows[0].state,
    ).toBe("cancelled");
    expect(
      (await request("POST", `/jobs/${plan.id}/resume`, { revision: 2 }))
        .statusCode,
    ).toBe(409);
  });
  for (const [scenario, expectedState, expectedCode] of [
    ["expired", "sign_in_required", "SIGN_IN_REQUIRED"],
    ["wrong_account", "failed", "AWS_ACCOUNT_MISMATCH"],
    ["throttled", "waiting", "AWS_THROTTLED"],
    ["lost_ack", "waiting", "AWS_TIMEOUT"],
    ["revision", "failed", "AWS_REVISION_CONFLICT"],
    ["deployment_delay", "waiting", null],
  ] as const)
    it(
      "rehearses " +
        scenario +
        " through the administrator queue and resumes without duplicate resources",
      async () => {
        expect(
          (
            await request("POST", "/simulator/faults", {
              accountId: newAccount,
              scenario,
            })
          ).statusCode,
        ).toBe(200);
        const plan = await create();
        await request("POST", `/jobs/${plan.id}/approve`, { revision: 0 });
        await worker.tick();
        let row = (
          await pool.query(
            "SELECT state,error_code,revision FROM hub_cloud_jobs WHERE id=$1",
            [plan.id],
          )
        ).rows[0];
        expect(row.state).toBe(expectedState);
        expect(row.error_code).toBe(expectedCode);
        if (scenario === "expired") {
          await request("POST", `/accounts/${newAccount}/login`);
          await worker.tick();
        }
        expect(
          (
            await request("POST", `/jobs/${plan.id}/resume`, {
              revision: row.revision,
            })
          ).statusCode,
        ).toBe(200);
        await worker.tick();
        row = (
          await pool.query(
            "SELECT state,error_code FROM hub_cloud_jobs WHERE id=$1",
            [plan.id],
          )
        ).rows[0];
        expect(row.state).toBe("ready_for_activation");
        expect(row.error_code).toBeNull();
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM hub_cloud_simulator_resources WHERE account_id=$1",
              [newAccount],
            )
          ).rows[0].count,
        ).toBe("1");
      },
    );
  it("simulator controls retain administrator and CSRF checks and reject arbitrary operations", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/cloud/simulator/faults",
          headers: { "x-test-user": user, "x-test-csrf": "yes" },
          payload: { accountId: newAccount, scenario: "expired" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", "/simulator/faults", {
          accountId: newAccount,
          scenario: "shell-command",
        })
      ).statusCode,
    ).toBe(400);
  });
});
