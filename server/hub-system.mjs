import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
export const SYSTEM_METRICS = [
  "host_memory_used_bytes",
  "host_memory_available_bytes",
  "host_memory_total_bytes",
  "container_memory_bytes",
  "container_memory_limit_bytes",
  "heap_used_bytes",
  "process_rss_bytes",
  "cpu_percent",
  "disk_available_bytes",
  "disk_total_bytes",
  "host_uptime_seconds",
  "process_uptime_seconds",
];
export function sanitizeSystem(value, now = Date.now()) {
  if (
    !value ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    Math.abs(now - Date.parse(value.observedAt)) > 45000
  )
    return null;
  const metrics = {};
  for (const name of SYSTEM_METRICS) {
    const v = value.metrics?.[name];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e16)
      metrics[name] = v;
  }
  return { observedAt: value.observedAt, metrics };
}
export function createSystemCollector({
  dataDir = ".",
  readFile = (path) => readFileSync(path, "utf8"),
  statfs = statfsSync,
  cpus = os.cpus,
  totalmem = os.totalmem,
  freemem = os.freemem,
  uptime = os.uptime,
  memory = process.memoryUsage,
  processUptime = process.uptime,
  now = Date.now,
} = {}) {
  let prior = null,
    cached = null;
  const read = (path) => {
    try {
      return String(readFile(path)).trim();
    } catch {
      return null;
    }
  };
  return () => {
    if (cached && now() - Date.parse(cached.observedAt) < 15000) return cached;
    let total = totalmem(),
      available = freemem();
    const info = read("/proc/meminfo");
    if (info) {
      const value = (k) =>
        Number(info.match(new RegExp("^" + k + ":\\s+(\\d+)", "m"))?.[1]) *
        1024;
      const a = value("MemAvailable"),
        t = value("MemTotal");
      if (Number.isFinite(a) && Number.isFinite(t)) {
        total = t;
        available = a;
      }
    }
    const metrics = {
      host_memory_used_bytes: Math.max(0, total - available),
      host_memory_available_bytes: available,
      host_memory_total_bytes: total,
      heap_used_bytes: memory().heapUsed,
      process_rss_bytes: memory().rss,
      host_uptime_seconds: uptime(),
      process_uptime_seconds: processUptime(),
    };
    const usage =
      read("/sys/fs/cgroup/memory.current") ??
      read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    const limit =
      read("/sys/fs/cgroup/memory.max") ??
      read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    if (usage !== null && Number.isFinite(Number(usage)))
      metrics.container_memory_bytes = Number(usage);
    if (
      limit !== null &&
      limit !== "max" &&
      Number.isFinite(Number(limit)) &&
      Number(limit) < 1e16
    )
      metrics.container_memory_limit_bytes = Number(limit);
    const samples = cpus();
    const current = samples.reduce(
      (a, c) => ({
        idle: a.idle + c.times.idle,
        total: a.total + Object.values(c.times).reduce((s, n) => s + n, 0),
      }),
      { idle: 0, total: 0 },
    );
    if (prior && current.total > prior.total)
      metrics.cpu_percent = Math.max(
        0,
        Math.min(
          100,
          100 *
            (1 - (current.idle - prior.idle) / (current.total - prior.total)),
        ),
      );
    prior = current;
    try {
      const fs = statfs(dataDir);
      metrics.disk_available_bytes = Number(fs.bavail) * Number(fs.bsize);
      metrics.disk_total_bytes = Number(fs.blocks) * Number(fs.bsize);
    } catch {}
    cached = sanitizeSystem(
      { observedAt: new Date(now()).toISOString(), metrics },
      now(),
    );
    return cached;
  };
}
