import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { AppError, forbidden } from "./errors.js";
import type { HubRouteOptions } from "./hubSupport.js";
export const HUB_FRESHNESS_MS = 45_000;
const validId = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export const validMetric = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e16;
export async function sampleHubMetrics(pool: Pool, now = new Date()) {
  const bucket = new Date(Math.floor(now.getTime() / 15000) * 15000);
  const sources = (
    await pool.query(
      "SELECT * FROM hub_metric_sources WHERE observed_at>$1 AND received_at>$1 AND id NOT LIKE 'atlas_presence_%'",
      [new Date(now.getTime() - HUB_FRESHNESS_MS)],
    )
  ).rows;
  const expectedSources = Number(
    (
      await pool.query(
        "SELECT count(*)::int n FROM hub_metric_sources WHERE presence_verified",
      )
    ).rows[0].n,
  );
  const presence = sources.filter((s) => s.presence_verified);
  const complete =
    presence.length > 0 &&
    presence.length === expectedSources &&
    presence.every((s) => s.complete);
  const accounts = new Set<string>();
  for (const s of presence) for (const id of s.account_ids) accounts.add(id);
  const points: Array<[string, string, number]> = [];
  if (complete) points.push(["fleet", "online_users", accounts.size]);
  for (const s of sources) {
    if (s.presence_verified)
      points.push([s.id, "online_users", new Set(s.account_ids).size]);
    for (const [metric, value] of Object.entries(s.payload))
      if (validMetric(value)) points.push([s.id, metric, value as number]);
  }
  for (const [scope, metric, value] of points)
    await pool.query(
      "INSERT INTO hub_metric_points(bucket,resolution,scope,metric,value,minimum,maximum) VALUES($1,15,$2,$3,$4,$4,$4) ON CONFLICT(bucket,resolution,scope,metric) DO UPDATE SET value=excluded.value,minimum=excluded.minimum,maximum=excluded.maximum",
      [bucket, scope, metric, value],
    );
  return {
    onlineUsers: presence.length ? accounts.size : null,
    reportingSources: sources.length,
    expectedSources,
    complete,
    updatedAt: now.toISOString(),
    freshnessMs: HUB_FRESHNESS_MS,
    sources: sources.map((s) => ({
      id: s.id,
      observedAt: s.observed_at,
      onlineUsers: s.presence_verified ? new Set(s.account_ids).size : null,
      metrics: s.payload,
    })),
  };
}
export async function downsampleHubMetrics(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const [from, to, days] of [
      [15, 300, 7],
      [300, 3600, 90],
    ]) {
      await c.query(
        `INSERT INTO hub_metric_points(bucket,resolution,scope,metric,value,minimum,maximum,samples) SELECT to_timestamp(floor(extract(epoch FROM bucket)/$2)*$2),$2,scope,metric,sum(value*samples)/sum(samples),min(minimum),max(maximum),sum(samples) FROM hub_metric_points WHERE resolution=$1 AND bucket<date_trunc('day',now())-($3::text||' days')::interval GROUP BY 1,scope,metric ON CONFLICT(bucket,resolution,scope,metric) DO UPDATE SET value=excluded.value,minimum=excluded.minimum,maximum=excluded.maximum,samples=excluded.samples`,
        [from, to, days],
      );
      await c.query(
        "DELETE FROM hub_metric_points WHERE resolution=$1 AND bucket<date_trunc('day',now())-($2::text||' days')::interval",
        [from, days],
      );
    }
    await c.query(
      "DELETE FROM hub_metric_points WHERE bucket<now()-interval '365 days'",
    );
    await c.query(
      "UPDATE hub_metric_sources SET account_ids='{}' WHERE received_at<now()-interval '24 hours'",
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function registerHubMetricsRoutes(
  app: FastifyInstance,
  o: HubRouteOptions,
) {
  const { pool } = o;
  app.post("/api/hub/internal/metrics", async (request) => {
    if (!o.verifyService || !(await o.verifyService(request)))
      throw forbidden();
    const b = request.body as any;
    if (
      !b ||
      !validId(b.sourceId) ||
      (b.accountIds !== null && !Array.isArray(b.accountIds)) ||
      (b.accountIds?.length ?? 0) > 10000
    )
      throw new AppError("VALIDATION_ERROR", "Invalid telemetry.");
    const observed = new Date(b.observedAt);
    if (
      !Number.isFinite(observed.getTime()) ||
      observed.getTime() > Date.now() + 5000 ||
      Date.now() - observed.getTime() > HUB_FRESHNESS_MS
    )
      throw new AppError("VALIDATION_ERROR", "Telemetry is stale.", 409);
    const accountIds = [...new Set(b.accountIds ?? [])];
    if (
      accountIds.some(
        (id) =>
          typeof id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            id as string,
          ),
      )
    )
      throw new AppError("VALIDATION_ERROR", "Invalid account bindings.");
    const metrics: Record<string, number> = {};
    const names = [
      "host_memory_used_bytes",
      "host_memory_available_bytes",
      "process_rss_bytes",
      "host_uptime_seconds",
      "process_uptime_seconds",
      "disk_total_bytes",
      "host_memory_total_bytes",
      "container_memory_bytes",
      "container_memory_limit_bytes",
      "heap_used_bytes",
      "cpu_percent",
      "connections",
      "active_streams",
      "requests_per_second",
      "errors_per_second",
      "latency_p95_ms",
      "disk_available_bytes",
    ];
    for (const name of names)
      if (b.metrics?.[name] !== undefined) {
        if (!validMetric(b.metrics[name]))
          throw new AppError("VALIDATION_ERROR", "Invalid metric.");
        metrics[name] = b.metrics[name];
      }
    const known = (
      await pool.query(
        "SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active'",
        [accountIds],
      )
    ).rows.map((r) => r.id);
    await pool.query(
      "INSERT INTO hub_metric_sources(id,observed_at,account_ids,payload,presence_verified,complete) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,received_at=now(),account_ids=excluded.account_ids,payload=excluded.payload,presence_verified=excluded.presence_verified,complete=excluded.complete WHERE hub_metric_sources.observed_at<excluded.observed_at",
      [
        b.sourceId,
        observed,
        known,
        JSON.stringify(metrics),
        Array.isArray(b.accountIds),
        b.complete === true,
      ],
    );
    return { ok: true };
  });
  app.get("/api/admin/hub/metrics", async (request) => {
    await o.requireAdmin(request);
    const value = await sampleHubMetrics(pool);
    return {
      ...value,
      sources: value.sources.map((source) => ({
        ...source,
        label: o.sourceLabel?.(source.id) || source.id,
      })),
    };
  });
  app.get("/api/admin/hub/metrics/history", async (request) => {
    await o.requireAdmin(request);
    const q = request.query as any;
    const hours = Math.min(8760, Math.max(1, Number(q.hours) || 24)),
      scope = validId(q.scope) ? q.scope : "fleet";
    const metric =
      typeof q.metric === "string" && /^[a-z_]{1,60}$/.test(q.metric)
        ? q.metric
        : "online_users";
    return {
      points: (
        await pool.query(
          "SELECT to_timestamp(floor(extract(epoch FROM bucket)/$4::integer)*$4::integer) bucket,$4::integer resolution,sum(value*samples)/sum(samples) value,min(minimum) minimum,max(maximum) maximum,sum(samples) samples FROM hub_metric_points WHERE scope=$1 AND metric=$2 AND bucket>now()-($3::text||' hours')::interval GROUP BY 1 ORDER BY bucket LIMIT 12000",
          [scope, metric, hours, hours > 168 ? 3600 : hours > 24 ? 300 : 15],
        )
      ).rows,
    };
  });
  let pending = false,
    lastRollup = 0;
  const timer = setInterval(async () => {
    if (pending) return;
    pending = true;
    try {
      await sampleHubMetrics(pool);
      if (Date.now() - lastRollup > 3600000) {
        await downsampleHubMetrics(pool);
        lastRollup = Date.now();
      }
    } catch (error) {
      app.log.error({ err: error }, "hub metric sampling failed");
    } finally {
      pending = false;
    }
  }, 15000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}
