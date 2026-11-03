/** Explicit PostgreSQL admission budgets. Backups cannot consume control capacity. */
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
export const HUB_DATABASE_POOL_BUDGET = Object.freeze({
  control: 4,
  ordinary: 6,
  bulk: 2,
  maintenance: 1,
  listen: 1,
});
export type HubDatabasePools = {
  [K in keyof typeof HUB_DATABASE_POOL_BUDGET]: Pool;
};
export function createHubDatabasePools(
  connectionString: string,
): HubDatabasePools {
  return Object.fromEntries(
    Object.entries(HUB_DATABASE_POOL_BUDGET).map(([name, max]) => [
      name,
      new Pool({
        connectionString,
        max,
        connectionTimeoutMillis: 1000,
        statement_timeout: 3000,
        lock_timeout: 1000,
        idle_in_transaction_session_timeout: 7000,
        application_name: "atlas-" + name,
      }),
    ]),
  ) as HubDatabasePools;
}
/** Activation fails before consuming reserved capacity when PostgreSQL lacks headroom.
 * Other processes must reserve their own budgets; this checks currently free capacity. */
export async function verifyHubDatabaseHeadroom(
  pools: HubDatabasePools,
  margin = 4,
) {
  const row = (
    await pools.ordinary
      .query(`SELECT current_setting('max_connections')::int maximum,
 current_setting('superuser_reserved_connections')::int reserved,
 COALESCE(NULLIF(current_setting('reserved_connections',true),''),'0')::int reserved_roles,
 (SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend')::int active`)
  ).rows[0];
  const budget = Object.values(HUB_DATABASE_POOL_BUDGET).reduce(
      (n, v) => n + v,
      0,
    ),
    already = Object.values(pools).reduce((n, p) => n + p.totalCount, 0);
  const remaining =
    Number(row.maximum) -
    Number(row.reserved) -
    Number(row.reserved_roles) -
    Number(row.active);
  if (remaining < budget - already + margin)
    throw Error("HUB_DATABASE_CONNECTION_HEADROOM_REQUIRED");
  return {
    maximum: Number(row.maximum),
    active: Number(row.active),
    reserved: Number(row.reserved) + Number(row.reserved_roles),
    remaining,
    budget,
    margin,
  };
}
export async function closeHubDatabasePools(pools: HubDatabasePools) {
  await Promise.all(Object.values(pools).map((p) => p.end()));
}
