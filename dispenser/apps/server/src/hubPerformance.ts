/** Fixed-cardinality causal counters only: no request bodies, URLs or identities. */
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const LATENCY_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 3000, 10000];
const NAMES = ["route.health", "route.branch-validation", "route.branch-exchange", "route.profile", "route.admin", "route.hub", "route.other", "pool.acquire", "auth.transaction", "auth.refresh", "auth.rollback", "profile.gc"] as const;
export type HubPerformanceName = typeof NAMES[number];
export type HubPerformanceOutcome = "ok" | "rejected" | "error" | "timeout" | "aborted";
type Metric = { count: number; sumMs: number; maxMs: number; buckets: number[]; outcomes: Record<HubPerformanceOutcome, number> };
const add = (value: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount);
export function createHubPerformance() {
  const metrics = Object.fromEntries(NAMES.map(name => [name, { count: 0, sumMs: 0, maxMs: 0, buckets: Array(LATENCY_MS.length + 1).fill(0), outcomes: { ok: 0, rejected: 0, error: 0, timeout: 0, aborted: 0 } }])) as Record<HubPerformanceName, Metric>;
  const started = Date.now();
  return {
    observe(name: HubPerformanceName, elapsedMs: number, outcome: HubPerformanceOutcome = "ok") {
      // Runtime callers cannot turn untrusted strings into unbounded label sets.
      if (!Object.hasOwn(metrics, name) || !["ok", "rejected", "error", "timeout", "aborted"].includes(outcome)) return;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      const elapsed = Math.min(elapsedMs, 3_600_000), row = metrics[name];
      row.count = add(row.count); row.sumMs = add(row.sumMs, elapsed); row.maxMs = Math.max(row.maxMs, elapsed);
      const index = LATENCY_MS.findIndex(bound => elapsed <= bound);
      row.buckets[index < 0 ? LATENCY_MS.length : index] = add(row.buckets[index < 0 ? LATENCY_MS.length : index]);
      row.outcomes[outcome] = add(row.outcomes[outcome]);
    },
    snapshot(pool?: Pick<Pool, "totalCount" | "idleCount" | "waitingCount">) {
      const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
      return { schema: "atlas-hub-performance-v1", observedAt: new Date().toISOString(), startedAt: new Date(started).toISOString(), latencyBucketUpperBoundsMs: [...LATENCY_MS, null], metrics: structuredClone(metrics), pool: pool ? { total: count(pool.totalCount), idle: count(pool.idleCount), waiting: count(pool.waitingCount) } : null };
    },
  };
}
export type HubPerformance = ReturnType<typeof createHubPerformance>;
export function performanceOutcome(error: unknown): HubPerformanceOutcome {
  const code = (error as { code?: string })?.code;
  if (code === "HUB_REQUEST_ABORTED") return "aborted";
  if (["HUB_DATABASE_BUSY", "HUB_TRANSACTION_TIMEOUT", "57014", "55P03"].includes(code || "")) return "timeout";
  return Number((error as { status?: number })?.status) >= 400 && Number((error as { status?: number })?.status) < 500 ? "rejected" : "error";
}
export function installHubPerformance(app: FastifyInstance, pool: Pool) {
  const telemetry = createHubPerformance(), started = new WeakMap<object, number>();
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let lastUtilization = performance.eventLoopUtilization(), sampledAt = performance.now();
  app.addHook("onClose", async () => { delay.disable(); });
  app.addHook("onRequest", async request => { started.set(request, performance.now()); });
  app.addHook("onResponse", async (request, reply) => {
    const begin = started.get(request); if (begin === undefined) return;
    const route = request.routeOptions.url || "";
    const name: HubPerformanceName = route.startsWith("/health/") ? "route.health" : route === "/api/hub/branch/session" ? "route.branch-validation" : route === "/api/hub/branch/exchange" ? "route.branch-exchange" : route.startsWith("/api/hub/branch/profile") ? "route.profile" : route.startsWith("/api/admin/") ? "route.admin" : route.startsWith("/api/hub/") ? "route.hub" : "route.other";
    telemetry.observe(name, performance.now() - begin, reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "rejected" : "ok");
  });
  return {
    ...telemetry,
    snapshot(currentPool: Pick<Pool, "totalCount" | "idleCount" | "waitingCount"> = pool) {
      const now = performance.now(), utilization = performance.eventLoopUtilization(lastUtilization);
      lastUtilization = performance.eventLoopUtilization();
      const eventLoop = { intervalMs: now - sampledAt, histogramResolutionMs: 20,
        samples: delay.count, p95Ms: delay.count ? delay.percentile(95) / 1e6 : null,
        maxMs: delay.count ? delay.max / 1e6 : null, utilization: utilization.utilization };
      sampledAt = now; delay.reset();
      const memory = process.memoryUsage();
      return { ...telemetry.snapshot(currentPool), counterScope: "process-lifetime", eventLoop,
        processMemoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external } };
    },
  };
}
