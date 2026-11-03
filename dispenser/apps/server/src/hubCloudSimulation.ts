/** Real local endpoint activation for the isolated simulator; never real AWS. */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { encrypt, decrypt, hashSecret, randomToken } from "./security.js";
import {
  CloudError,
  type CloudPlan,
  type CloudCheckpoint,
  type CloudResource,
  type Distribution,
} from "./hubCloudWorker.js";
export type SimulationItem = {
  resource: CloudResource;
  distribution: Distribution;
  origin: string;
  branchId?: string;
  branchSecret?: string;
  generation: number;
  nodeId?: string;
};
export interface SimulationCoordinator {
  prepare(
    jobId: string,
    resources: { resource: CloudResource; distribution: Distribution }[],
  ): Promise<{ items: { key: string; origin: string; nodeId?: string }[] }>;
  install(jobId: string, items: SimulationItem[]): Promise<void>;
  commit(jobId: string, items: SimulationItem[]): Promise<void>;
}
export type SimulationOptions = {
  encryptionKey: string;
  sessionSecret: string;
  initialCredentials?: Record<string, string>;
};
export function localSimulationOrigin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.origin !== value ||
    !(
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      /^[a-z0-9-]+(?:\.atlas)?\.localhost$/.test(u.hostname)
    ) ||
    ![4280, 4282, 4283, 4284, 4300].includes(Number(u.port))
  )
    throw new CloudError("INVALID_SIMULATION_ORIGIN");
  return value;
}
export class HttpSimulationCoordinator implements SimulationCoordinator {
  constructor(
    private endpoint: string,
    private secret: string,
    private requestFetch: typeof fetch = fetch,
  ) {
    if (process.env.NODE_ENV === "production")
      throw new CloudError("SIMULATION_FORBIDDEN");
    localSimulationOrigin(endpoint);
    if (secret.length < 32) throw new CloudError("SIMULATION_SECRET_REQUIRED");
  }
  private async call(action: string, body: unknown) {
    let response;
    try {
      response = await this.requestFetch(
        this.endpoint + "/__lab/cloud/" + action,
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + this.secret,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new CloudError("SIMULATION_COORDINATOR_UNAVAILABLE", true);
    }
    if (!response.ok)
      throw new CloudError(
        "SIMULATION_" + action.toUpperCase() + "_FAILED",
        response.status >= 500,
      );
    return response.json();
  }
  prepare(
    jobId: string,
    resources: { resource: CloudResource; distribution: Distribution }[],
  ) {
    return this.call("prepare", { jobId, resources });
  }
  async install(jobId: string, items: SimulationItem[]) {
    await this.call("install", { jobId, items });
  }
  async commit(jobId: string, items: SimulationItem[]) {
    await this.call("commit", { jobId, items });
  }
}
export async function activateSimulation(
  pool: Pool,
  jobId: string,
  plan: CloudPlan,
  checkpoint: CloudCheckpoint,
  coordinator: SimulationCoordinator,
  options: SimulationOptions,
) {
  if (process.env.NODE_ENV === "production")
    throw new CloudError("SIMULATION_FORBIDDEN");
  let receipt = (
    await pool.query("SELECT * FROM hub_cloud_activation WHERE job_id=$1", [
      jobId,
    ])
  ).rows[0];
  let items: SimulationItem[];
  if (receipt)
    items = JSON.parse(
      decrypt(receipt.encrypted_payload, options.encryptionKey),
    );
  else {
    const resources = plan.resources.map((resource) => {
      const distribution = checkpoint.resources?.[resource.key];
      if (!distribution || distribution.status !== "Deployed")
        throw new CloudError("SIMULATION_NOT_DEPLOYED");
      return { resource, distribution };
    });
    const prepared = await coordinator.prepare(jobId, resources);
    if (prepared.items.length !== resources.length)
      throw new CloudError("SIMULATION_PREPARE_INVALID");
    items = [];
    for (const entry of resources) {
      const mapped = prepared.items.find((i) => i.key === entry.resource.key);
      if (!mapped) throw new CloudError("SIMULATION_PREPARE_INVALID");
      localSimulationOrigin(mapped.origin);
      const resource = entry.resource;
      const item: SimulationItem = {
        ...entry,
        origin: mapped.origin,
        generation: (resource.previous?.revision ?? 0) + 1,
        nodeId: mapped.nodeId,
      };
      if (resource.role === "frontend") {
        const prior = (
          await pool.query("SELECT id FROM hub_branches WHERE link_id=$1", [
            resource.logicalId,
          ])
        ).rows[0];
        item.branchId = prior?.id ?? randomUUID();
        if (prior) {
          const saved = (
            await pool.query(
              "SELECT encrypted_secret FROM hub_cloud_branch_credentials WHERE branch_id=$1",
              [prior.id],
            )
          ).rows[0];
          item.branchSecret = saved
            ? decrypt(saved.encrypted_secret, options.encryptionKey)
            : options.initialCredentials?.[prior.id];
          if (!item.branchSecret)
            throw new CloudError("SIMULATION_BRANCH_CREDENTIAL_REQUIRED");
        } else item.branchSecret = randomToken();
      }
      items.push(item);
    }
    await pool.query(
      "INSERT INTO hub_cloud_activation(job_id,phase,encrypted_payload) VALUES($1,'prepared',$2) ON CONFLICT DO NOTHING",
      [jobId, encrypt(JSON.stringify(items), options.encryptionKey)],
    );
  }
  if (receipt?.phase === "complete") return items;
  // Registry installation and health probes precede changing user-visible links.
  await coordinator.install(jobId, items);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (
      await client.query(
        "SELECT phase FROM hub_cloud_activation WHERE job_id=$1 FOR UPDATE",
        [jobId],
      )
    ).rows[0];
    if (locked.phase === "prepared") {
      for (const item of items) {
        const { resource: r, distribution: d } = item;
        if (r.previous) {
          const previous = (
            await client.query(
              "SELECT * FROM hub_cloud_endpoints WHERE id=$1 AND revision=$2 AND state IN ('active','staged') FOR UPDATE",
              [r.previous.id, r.previous.revision],
            )
          ).rows[0];
          if (!previous) throw new CloudError("ENDPOINT_REVISION_CONFLICT");
          await client.query(
            "UPDATE hub_cloud_endpoints SET state='transition' WHERE id=$1",
            [previous.id],
          );
        }
        if (r.role === "frontend") {
          if (r.previous) {
            const updated = await client.query(
              "UPDATE links SET url=$2,updated_at=now() WHERE id=$1",
              [r.logicalId, item.origin],
            );
            if (!updated.rowCount)
              throw new CloudError("SIMULATION_LINK_MISSING");
          } else
            await client.query(
              "INSERT INTO links(id,name,url,health_status,health_monitoring) VALUES($1,$2,$3,'healthy',false)",
              [
                r.logicalId,
                "Atlas Link " + d.id.replace(/\D/g, ""),
                item.origin,
              ],
            );
          await client.query(
            "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$2,$3,$4) ON CONFLICT(link_id) DO UPDATE SET origin=excluded.origin",
            [
              item.branchId,
              r.logicalId,
              item.origin,
              hashSecret(item.branchSecret!, options.sessionSecret),
            ],
          );
          await client.query(
            "UPDATE hub_branch_origins SET state='transition' WHERE branch_id=$1 AND state='active'",
            [item.branchId],
          );
          if (r.previous)
            await client.query(
              "INSERT INTO hub_branch_origins(branch_id,origin,state) VALUES($1,$2,'transition') ON CONFLICT(branch_id,origin) DO UPDATE SET state='transition'",
              [item.branchId, r.previous.url],
            );
          await client.query(
            "INSERT INTO hub_branch_origins(branch_id,origin,state) VALUES($1,$2,'active') ON CONFLICT(branch_id,origin) DO UPDATE SET state='active'",
            [item.branchId, item.origin],
          );
          await client.query(
            "INSERT INTO hub_cloud_branch_credentials(branch_id,encrypted_secret) VALUES($1,$2) ON CONFLICT(branch_id) DO NOTHING",
            [item.branchId, encrypt(item.branchSecret!, options.encryptionKey)],
          );
        }
        await client.query(
          "INSERT INTO hub_cloud_endpoints(role,logical_id,link_id,account_id,distribution_id,url,origin_host,revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active') ON CONFLICT(account_id,distribution_id) DO NOTHING",
          [
            r.role,
            r.logicalId,
            r.role === "frontend" ? r.logicalId : null,
            plan.accountId,
            d.id,
            item.origin,
            r.originHost,
            item.generation,
          ],
        );
      }
      await client.query(
        "UPDATE hub_cloud_activation SET phase='database_committed',updated_at=now() WHERE job_id=$1",
        [jobId],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  // Crash here resumes from the durable receipt and reapplies idempotent routing.
  await coordinator.commit(jobId, items);
  await pool.query(
    "UPDATE hub_cloud_activation SET phase='complete',updated_at=now() WHERE job_id=$1",
    [jobId],
  );
  return items;
}
