import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import {
  activateSimulation,
  type SimulationCoordinator,
  type SimulationItem,
} from "./hubCloudSimulation.js";
import {
  makePlan,
  hashPlan,
  CloudError,
  type CloudResource,
  type Distribution,
  type CloudCheckpoint,
} from "./hubCloudWorker.js";
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite(
  "Local CloudFront complete activation, identity preservation and crash recovery",
  () => {
    const schema = "cloud_activation_" + randomUUID().replaceAll("-", "");
    let pool: Pool, maintenance: Pool;
    let oldAccount: string, newAccount: string, userId: string;
    const options = {
      encryptionKey: "local-only-encryption-secret",
      sessionSecret: "local-only-session-secret-with-32-characters",
    };
    beforeAll(async () => {
      if (!new URL(url!).pathname.endsWith("_test"))
        throw Error("Dedicated test database required");
      maintenance = new Pool({ connectionString: url });
      await maintenance.query("SELECT pg_advisory_lock(870412201)");
      try {
        await maintenance.query(
          "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
        );
        await maintenance.query("ALTER EXTENSION pgcrypto SET SCHEMA public");
      } finally {
        await maintenance.query("SELECT pg_advisory_unlock(870412201)");
      }
      await maintenance.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: url,
        options: `-c search_path=${schema},public`,
      });
      for (const name of [
        "0001_initial.sql",
        "0002_quota_resets.sql",
        "0003_weekly_multi_link_and_denied_logins.sql",
        "0004_weekly_quota_only.sql",
        "0005_unique_active_user_links.sql",
        "0009_hub_core.sql",
        "0010_hub_cloud.sql",
        "0012_hub_cloud_activation.sql",
      ])
        await pool.query(
          await readFile(
            new URL(
              "../../../packages/database/migrations/" + name,
              import.meta.url,
            ),
            "utf8",
          ),
        );
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE hub_cloud_activation,hub_cloud_branch_credentials,hub_branch_origins,hub_cloud_simulator_routes,hub_cloud_jobs,hub_cloud_endpoints,hub_cloud_accounts,hub_branches,link_assignments,links,users CASCADE",
      );
      userId = (
        await pool.query(
          "INSERT INTO users(email,normalized_email) VALUES('student@example.com','student@example.com') RETURNING id",
        )
      ).rows[0].id;
      oldAccount = (
        await pool.query(
          "INSERT INTO hub_cloud_accounts(label,expected_account_id) VALUES('Old','111111111111') RETURNING id",
        )
      ).rows[0].id;
      newAccount = (
        await pool.query(
          "INSERT INTO hub_cloud_accounts(label,expected_account_id) VALUES('New','222222222222') RETURNING id",
        )
      ).rows[0].id;
    });
    afterAll(async () => {
      await pool?.end();
      await maintenance?.query(`DROP SCHEMA ${schema} CASCADE`);
      await maintenance?.end();
    });
    const checkpoint = (resources: CloudResource[]): CloudCheckpoint => ({
      resources: Object.fromEntries(
        resources.map((r, i) => [
          r.key,
          {
            id: "FAKE" + (i + 1),
            domain: "dfake" + (i + 1) + ".cloudfront.net",
            status: "Deployed",
            caller: "fixture",
            originHost: r.originHost,
          },
        ]),
      ),
    });
    async function job(resources: CloudResource[]) {
      const plan = makePlan(
        {
          id: newAccount,
          expectedAccountId: "222222222222",
          region: "us-east-1",
        },
        resources,
      );
      const id = (
        await pool.query(
          "INSERT INTO hub_cloud_jobs(plan,plan_hash,state) VALUES($1,$2,'running') RETURNING id",
          [JSON.stringify(plan), hashPlan(plan)],
        )
      ).rows[0].id;
      return { id, plan, checkpoint: checkpoint(resources) };
    }
    function coordinator(failCommitOnce = false): SimulationCoordinator {
      let failed = false;
      return {
        async prepare(jobId, resources) {
          return {
            items: resources.map(({ resource: r, distribution: d }) => ({
              key: r.key,
              origin: `https://${r.role[0]}${jobId.replaceAll("-", "")}${d.id.toLowerCase()}.atlas.localhost:${r.role === "hub" ? 4300 : r.role === "node" ? 4282 : 4280}`,
            })),
          };
        },
        async install(_id, items) {
          expect(
            items.every(
              (i) => i.resource.role !== "frontend" || !!i.branchSecret,
            ),
          ).toBe(true);
        },
        async commit(jobId, items) {
          if (failCommitOnce && !failed) {
            failed = true;
            throw new CloudError("SIMULATION_NETWORK_UNAVAILABLE", true);
          }
          for (const i of items)
            await pool.query(
              "INSERT INTO hub_cloud_simulator_routes(origin,role,logical_id,state,job_id) VALUES($1,$2,$3,'active',$4) ON CONFLICT(origin) DO UPDATE SET state='active'",
              [i.origin, i.resource.role, i.resource.logicalId, jobId],
            );
        },
      };
    }
    async function prior(
      index: number,
      role: "frontend" | "hub" | "node" = "frontend",
    ) {
      const logicalId = role === "frontend" ? randomUUID() : role + "-" + index;
      const oldUrl = `https://old${index}.${role}.example`;
      let branchId: string | undefined;
      if (role === "frontend") {
        await pool.query("INSERT INTO links(id,name,url) VALUES($1,$2,$3)", [
          logicalId,
          "Atlas Link " + index,
          oldUrl,
        ]);
        await pool.query(
          "INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)",
          [userId, logicalId],
        );
        branchId = (
          await pool.query(
            "INSERT INTO hub_branches(link_id,origin,secret_hash) VALUES($1,$2,$3) RETURNING id",
            [logicalId, oldUrl, "fixture-hash"],
          )
        ).rows[0].id;
        await pool.query(
          "INSERT INTO hub_branch_origins(branch_id,origin,state) VALUES($1,$2,'active')",
          [branchId, oldUrl],
        );
      }
      const endpoint = (
        await pool.query(
          "INSERT INTO hub_cloud_endpoints(role,logical_id,link_id,account_id,distribution_id,url,origin_host) VALUES($1,$2,$3,$4,$5,$6,'vps.example.com') RETURNING id",
          [
            role,
            logicalId,
            role === "frontend" ? logicalId : null,
            oldAccount,
            "OLD" + index,
            oldUrl,
          ],
        )
      ).rows[0];
      const resource: CloudResource = {
        key: "replace-" + index,
        role,
        logicalId,
        originHost: "vps.example.com",
        previous: {
          id: endpoint.id,
          revision: 1,
          distributionId: "OLD" + index,
          accountId: oldAccount,
          url: oldUrl,
        },
      };
      return { resource, branchId, oldUrl };
    }
    for (const count of [1, 100, 101, 250])
      it(`activates ${count} new logical links, callbacks and physical revisions`, async () => {
        const resources = Array.from({ length: count }, (_, i) => ({
          key: "new-" + i,
          role: "frontend" as const,
          logicalId: randomUUID(),
          originHost: "vps.example.com",
        }));
        const j = await job(resources);
        await activateSimulation(
          pool,
          j.id,
          j.plan,
          j.checkpoint,
          coordinator(),
          options,
        );
        expect(
          (await pool.query("SELECT count(*) FROM links")).rows[0].count,
        ).toBe(String(count));
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM hub_cloud_endpoints WHERE state='active'",
            )
          ).rows[0].count,
        ).toBe(String(count));
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM hub_branch_origins WHERE state='active'",
            )
          ).rows[0].count,
        ).toBe(String(count));
        expect(
          (
            await pool.query(
              "SELECT phase FROM hub_cloud_activation WHERE job_id=$1",
              [j.id],
            )
          ).rows[0].phase,
        ).toBe("complete");
      });
    it("single/subset/all replacements preserve every assignment, quota record and stable link ID", async () => {
      const all = await Promise.all([prior(1), prior(2), prior(3)]);
      const idsBefore = (
        await pool.query("SELECT id,link_id FROM link_assignments ORDER BY id")
      ).rows;
      const chosen = [all[0]!, all[2]!];
      const j = await job(chosen.map((p) => p.resource));
      const initialCredentials = Object.fromEntries(
        all.map((p) => [p.branchId!, "fixture-branch-secret-".padEnd(43, "x")]),
      );
      await activateSimulation(
        pool,
        j.id,
        j.plan,
        j.checkpoint,
        coordinator(),
        { ...options, initialCredentials },
      );
      expect(
        (
          await pool.query(
            "SELECT id,link_id FROM link_assignments ORDER BY id",
          )
        ).rows,
      ).toEqual(idsBefore);
      expect(
        (
          await pool.query("SELECT url FROM links WHERE id=$1", [
            all[1]!.resource.logicalId,
          ])
        ).rows[0].url,
      ).toBe(all[1]!.oldUrl);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_cloud_endpoints WHERE state='transition'",
          )
        ).rows[0].count,
      ).toBe("2");
      expect(
        (await pool.query("SELECT count(*) FROM links")).rows[0].count,
      ).toBe("3");
      for (const p of chosen) {
        const origin = (
          await pool.query("SELECT origin FROM hub_branches WHERE id=$1", [
            p.branchId,
          ])
        ).rows[0].origin;
        expect(origin).not.toBe(p.oldUrl);
        expect(
          (
            await pool.query(
              "SELECT state FROM hub_branch_origins WHERE branch_id=$1 AND origin=$2",
              [p.branchId, p.oldUrl],
            )
          ).rows[0].state,
        ).toBe("transition");
      }
    });
    for (const count of [1, 100, 101, 250])
      it(`replaces an entire ${count}-link pool without changing account allocations`, async () => {
        const previous = [];
        for (let i = 0; i < count; i++) previous.push(await prior(i + 1));
        const assignments = (
          await pool.query(
            "SELECT id,link_id FROM link_assignments ORDER BY id",
          )
        ).rows;
        const j = await job(previous.map((p) => p.resource));
        const initialCredentials = Object.fromEntries(
          previous.map((p) => [p.branchId!, "r".repeat(43)]),
        );
        await activateSimulation(
          pool,
          j.id,
          j.plan,
          j.checkpoint,
          coordinator(),
          { ...options, initialCredentials },
        );
        expect(
          (
            await pool.query(
              "SELECT id,link_id FROM link_assignments ORDER BY id",
            )
          ).rows,
        ).toEqual(assignments);
        expect(
          (await pool.query("SELECT count(*) FROM links")).rows[0].count,
        ).toBe(String(count));
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM hub_cloud_endpoints WHERE state='active'",
            )
          ).rows[0].count,
        ).toBe(String(count));
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM hub_cloud_endpoints WHERE state='transition'",
            )
          ).rows[0].count,
        ).toBe(String(count));
      });
    it("resumes after database commit but before routing acknowledgement without duplicating links", async () => {
      const resources = [
        {
          key: "new",
          role: "frontend" as const,
          logicalId: randomUUID(),
          originHost: "vps.example.com",
        },
      ];
      const j = await job(resources);
      const c = coordinator(true);
      await expect(
        activateSimulation(pool, j.id, j.plan, j.checkpoint, c, options),
      ).rejects.toMatchObject({ code: "SIMULATION_NETWORK_UNAVAILABLE" });
      expect(
        (
          await pool.query(
            "SELECT phase FROM hub_cloud_activation WHERE job_id=$1",
            [j.id],
          )
        ).rows[0].phase,
      ).toBe("database_committed");
      await activateSimulation(pool, j.id, j.plan, j.checkpoint, c, options);
      await activateSimulation(pool, j.id, j.plan, j.checkpoint, c, options);
      expect(
        (await pool.query("SELECT count(*) FROM links")).rows[0].count,
      ).toBe("1");
      expect(
        (
          await pool.query(
            "SELECT phase FROM hub_cloud_activation WHERE job_id=$1",
            [j.id],
          )
        ).rows[0].phase,
      ).toBe("complete");
    });
    it("stale replacement revisions roll back every database mutation", async () => {
      const p = await prior(1);
      const j = await job([p.resource]);
      await pool.query(
        "UPDATE hub_cloud_endpoints SET revision=2 WHERE id=$1",
        [p.resource.previous!.id],
      );
      await expect(
        activateSimulation(pool, j.id, j.plan, j.checkpoint, coordinator(), {
          ...options,
          initialCredentials: { [p.branchId!]: "x".repeat(43) },
        }),
      ).rejects.toMatchObject({ code: "ENDPOINT_REVISION_CONFLICT" });
      expect(
        (
          await pool.query("SELECT url FROM links WHERE id=$1", [
            p.resource.logicalId,
          ])
        ).rows[0].url,
      ).toBe(p.oldUrl);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM hub_cloud_endpoints WHERE state='transition'",
          )
        ).rows[0].count,
      ).toBe("0");
    });
    it("Hub and node physical revisions activate without frontend link creation", async () => {
      const oldHub = await prior(1, "hub"),
        oldNode = await prior(2, "node");
      const j = await job([oldHub.resource, oldNode.resource]);
      await activateSimulation(
        pool,
        j.id,
        j.plan,
        j.checkpoint,
        coordinator(),
        options,
      );
      expect(
        (await pool.query("SELECT count(*) FROM links")).rows[0].count,
      ).toBe("0");
      expect(
        (
          await pool.query(
            "SELECT role FROM hub_cloud_endpoints WHERE state='active' ORDER BY role",
          )
        ).rows.map((r) => r.role),
      ).toEqual(["hub", "node"]);
    });
  },
);
