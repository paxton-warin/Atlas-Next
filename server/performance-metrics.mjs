import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
/** Fixed-cardinality aggregate metadata only. No destinations, identities, text,
 * cookies, headers or per-request logs. Lifetime totals survive samples. */
const allowed = new Set(['dns','dns-cache-hit','dns-coalesced','dns-lookup','tcp','first-byte','tcp-queue','tcp-bytes-in','tcp-bytes-out',
    'relay-closed-revoked','relay-closed-expired','relay-closed-control','relay-closed-invalid',
    'relay-closed-peer','relay-closed-retired','relay-closed-end','relay-upgrade-rejected']);
export function sanitizePerformanceMetrics(input) {
  if (!input || typeof input !== 'object') return null;
  const finite = value => Number.isFinite(value) && value >= 0 && value <= 1e15;
  const counters = {};
  for (const key of allowed) {
    const row = input.counters?.[key];
    if (row && Number.isSafeInteger(row.count) && finite(row.count) && finite(row.total) && finite(row.max))
      counters[key] = { count: row.count, total: row.total, max: row.max };
  }
  const safeWindow = row => row && ['endedAt','durationMs','p95Ms','maxMs','utilization','samples'].every(key => finite(row[key])) && row.utilization <= 1 && Number.isSafeInteger(row.samples)
    ? Object.fromEntries(['endedAt','durationMs','p95Ms','maxMs','utilization','samples'].map(key => [key,row[key]])) : null;
  const recentWindows = Array.isArray(input.eventLoop?.recentWindows) ? input.eventLoop.recentWindows.slice(-60).map(safeWindow).filter(Boolean) : [];
  return { eventLoop: { p95Ms: finite(input.eventLoop?.p95Ms) ? input.eventLoop.p95Ms : null,
    maxMs: finite(input.eventLoop?.maxMs) ? input.eventLoop.maxMs : null,
    recentWindows }, counters };
}
export function createPerformanceMetrics({windowMs = 1000, historyWindows = 60} = {}) {
  const values = new Map();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const intervalMs = Math.max(20, Math.min(5000, Number(windowMs) || 1000));
  const limit = Math.max(1, Math.min(60, Math.floor(Number(historyWindows) || 60)));
  const windows = [];
  let lastAt = performance.now(), previousUtilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.now(), current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, previousUtilization);
    const samples = Number(loop.count) || 0;
    windows.push({endedAt:Date.now(), durationMs:now-lastAt, p95Ms:samples ? loop.percentile(95)/1e6 : 0,
      maxMs:samples && Number.isFinite(loop.max) ? loop.max/1e6 : 0,
      utilization:Math.max(0,Math.min(1,delta.utilization || 0)), samples});
    if(windows.length>limit)windows.shift();
    loop.reset(); lastAt=now; previousUtilization=current;
  }, intervalMs);
  timer.unref();
  return {
    record(kind, value = 1) {
      if (!allowed.has(kind) || !Number.isFinite(value) || value < 0) return;
      const row = values.get(kind) || { count: 0, total: 0, max: 0 };
      row.count++; row.total += value; row.max = Math.max(row.max, value);
      values.set(kind, row);
    },
    snapshot() {
      const last = windows.at(-1);
      return { eventLoop: { p95Ms: last?.p95Ms ?? 0,
        maxMs: Math.max(0,...windows.map(window=>window.maxMs)),
        recentWindows:windows.map(window=>({...window})) },
        counters: Object.fromEntries([...values].map(([key, value]) => [key, { ...value }])) };
    },
    close() { clearInterval(timer); loop.disable(); },
  };
}
