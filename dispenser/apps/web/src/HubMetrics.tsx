import { useEffect, useId, useState } from "react";
import { Activity, Clock3, RefreshCw } from "lucide-react";
import { api } from "./api";
import { Badge, Button, Card, Empty, Notice, PageHeader, Select } from "./ui";
type Snapshot = {
  onlineUsers: number | null;
  reportingSources: number;
  expectedSources?: number;
  complete: boolean;
  updatedAt: string;
  sources: Array<{ id: string; label?: string; observedAt: string; onlineUsers: number | null; metrics: Record<string, number> }>;
};
export type MetricPoint = { bucket: string; value: number; minimum: number; maximum: number; resolution?: number };
const labels: Record<string, string> = {
  online_users: "Online users", host_memory_used_bytes: "Host memory used", host_memory_available_bytes: "Host memory available",
  host_memory_total_bytes: "Host memory total", container_memory_bytes: "Container memory", container_memory_limit_bytes: "Container memory limit",
  heap_used_bytes: "JavaScript heap", process_rss_bytes: "Process memory", cpu_percent: "CPU usage", disk_available_bytes: "Disk available",
  disk_total_bytes: "Disk total", host_uptime_seconds: "Host uptime", process_uptime_seconds: "Process uptime",
  connections: "Connections", active_streams: "Active streams", latency_p95_ms: "Response time (p95)",
};
export function metricLabel(name: string) { return labels[name] || name.replaceAll("_", " "); }
export function metricValue(name: string, value: number) {
  if (!Number.isFinite(value)) return "—";
  if (name.endsWith("_bytes")) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const power = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10)));
    return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
  }
  if (name.endsWith("_seconds")) return value >= 86400 ? `${(value / 86400).toFixed(1)} days` : value >= 3600 ? `${(value / 3600).toFixed(1)} hours` : `${Math.floor(value / 60)} min`;
  if (name.endsWith("_percent")) return `${value.toFixed(1)}%`;
  if (name.endsWith("_ms")) return `${value.toFixed(0)} ms`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
export function metricPath(points: MetricPoint[], width = 700, height = 180, maximum?: number) {
  if (points.length < 2) return "";
  const max = maximum ?? Math.max(1, ...points.map((p) => p.maximum));
  const first = Date.parse(points[0].bucket), span = Math.max(1, Date.parse(points.at(-1)!.bucket) - first);
  return points.map((p, i) => `${i && Date.parse(p.bucket) - Date.parse(points[i - 1].bucket) <= (p.resolution ?? 15) * 1500 ? "L" : "M"}${(((Date.parse(p.bucket) - first) / span) * width).toFixed(1)},${(height - (p.value / max) * height).toFixed(1)}`).join(" ");
}
/** Observed interval minima/maxima, not confidence bounds. Never bridge gaps. */
export function metricRangePath(points: MetricPoint[], width = 750, height = 160, maximum?: number) {
  if (points.length < 2) return "";
  const max = maximum ?? Math.max(1, ...points.map((p) => p.maximum));
  const first = Date.parse(points[0].bucket), span = Math.max(1, Date.parse(points.at(-1)!.bucket) - first);
  const x = (p: MetricPoint) => (((Date.parse(p.bucket) - first) / span) * width).toFixed(1);
  const y = (value: number) => (height - value / max * height).toFixed(1);
  const segments: MetricPoint[][] = [];
  for (const [index, point] of points.entries()) {
    if (!index || Date.parse(point.bucket) - Date.parse(points[index - 1].bucket) > (point.resolution ?? 15) * 1500) segments.push([]);
    segments.at(-1)!.push(point);
  }
  return segments.filter((segment) => segment.length > 1).map((segment) =>
    segment.map((p, i) => `${i ? "L" : "M"}${x(p)},${y(p.maximum)}`).join(" ") + " " +
    [...segment].reverse().map((p) => `L${x(p)},${y(p.minimum)}`).join(" ") + " Z"
  ).join(" ");
}
export function metricScale(metric: string, points: MetricPoint[]) {
  const maximum = Math.max(1, ...points.map((p) => p.maximum));
  let divisor = 1, unit = metric === "online_users" ? "people" : "count";
  if (metric.endsWith("_bytes")) { const power = Math.min(4, Math.max(0, Math.floor(Math.log2(maximum) / 10))); divisor = 1024 ** power; unit = ["B", "KiB", "MiB", "GiB", "TiB"][power]; }
  else if (metric.endsWith("_percent")) unit = "%";
  else if (metric.endsWith("_ms")) unit = "ms";
  else if (metric.endsWith("_seconds")) { divisor = maximum >= 86400 ? 86400 : maximum >= 3600 ? 3600 : 1; unit = divisor === 86400 ? "days" : divisor === 3600 ? "hours" : "seconds"; }
  const scaled = maximum / divisor;
  const magnitude = 10 ** Math.floor(Math.log10(scaled));
  let max = metric.endsWith("_percent") ? 100 : Math.ceil(scaled / magnitude) * magnitude * divisor;
  if (unit === "people" || unit === "count") max = max <= 4 ? Math.ceil(max) : Math.ceil(max / 4) * 4;
  return { divisor, unit, max };
}
export function MetricChart({ points, metric }: { points: MetricPoint[]; metric: string }) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const scale = metricScale(metric, points), first = Date.parse(points[0].bucket), last = Date.parse(points.at(-1)!.bucket);
  const span = Math.max(1, last - first), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const chosen = selected === null ? null : points[selected];
  const concurrent = metric === "online_users";
  const low = Math.min(...points.map((p) => p.minimum)), high = Math.max(...points.map((p) => p.maximum));
  const divisions = scale.unit === "people" || scale.unit === "count" ? Math.min(4, scale.max) : 4;
  const ticks = Array.from({ length: divisions + 1 }, (_, i) => scale.max * i / divisions);
  const summary = (p: MetricPoint) => `${new Date(p.bucket).toLocaleString()} ${timezone}: ${metricValue(metric, p.value)}; min ${metricValue(metric, p.minimum)}, max ${metricValue(metric, p.maximum)}; ${p.resolution ?? 15}s resolution`;
  const x = (p: MetricPoint) => ((Date.parse(p.bucket) - first) / span) * 750;
  const tick = (v: number) => (v / scale.divisor).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return <div className="hub-metric-chart">
    <div className="hub-chart-legend"><span>{metric === "cpu_percent" ? "Host CPU" : metricLabel(metric)} · {scale.unit}</span><span className="hub-chart-key"><span><i /> Mean</span>{concurrent && <span className="hub-chart-range-label" aria-label={`Observed low ${metricValue(metric, low)}, high ${metricValue(metric, high)} people`}>Low {metricValue(metric, low)} · High {metricValue(metric, high)}</span>}</span></div>
    <div className="hub-chart-plot"><div className="hub-chart-yaxis" aria-hidden="true">{[...ticks].reverse().map((value) => <span key={value}>{tick(value)}</span>)}</div>
    <svg className="hub-chart" viewBox="0 0 750 160" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{`${metricLabel(metric)} over time`}</title><desc id={`${id}-description`}>Zero baseline. Missing measurements remain gaps. Times use {timezone}. Focus a measurement or use the measurements table for values.{concurrent && " The shaded band shows observed interval lows and highs, not a confidence range."}</desc>
      {ticks.map((value) => <line key={value} x1="0" x2="750" y1={160 - value / scale.max * 160} y2={160 - value / scale.max * 160} className="hub-chart-grid" />)}
      {concurrent && <path className="hub-chart-range" d={metricRangePath(points, 750, 160, scale.max)} aria-hidden="true" />}
      <path d={metricPath(points, 750, 160, scale.max)} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {concurrent && chosen && <line className="hub-chart-selection" x1={x(chosen)} x2={x(chosen)} y1="0" y2="160" aria-hidden="true" vectorEffect="non-scaling-stroke" />}
      {points.map((point, index) => <circle className={concurrent ? "hub-chart-hit-point" : undefined} key={point.bucket} cx={x(point)} cy={160 - point.value / scale.max * 160} r={concurrent ? 10 : selected === index ? 5 : 3} tabIndex={0} role="img" aria-label={summary(point)} onFocus={() => setSelected(index)} onMouseEnter={() => setSelected(index)} onBlur={() => setSelected(null)} onMouseLeave={() => setSelected(null)}><title>{summary(point)}</title></circle>)}
    </svg></div>
    <div className="hub-chart-xaxis" aria-hidden="true">{[0, .25, .5, .75, 1].map((ratio) => <span key={ratio}>{new Date(first + ratio * span).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>)}</div>
    <p className="hub-chart-caption" aria-live="polite">{chosen ? summary(chosen) : `${new Date(first).toLocaleDateString()} · ${timezone} · gaps mean unavailable samples`}</p>
    <details className="hub-chart-data"><summary>View measurements</summary><p>Most recent {Math.min(48, points.length)} samples. Minimum and maximum describe the sample interval, not a confidence range.</p><div className="table-wrap" tabIndex={0} role="region" aria-label="Metric measurements"><table><thead><tr><th>Time ({timezone})</th><th>Mean</th><th>Minimum</th><th>Maximum</th><th>Resolution</th></tr></thead><tbody>{points.slice(-48).reverse().map((p) => <tr key={p.bucket}><td>{new Date(p.bucket).toLocaleString()}</td><td>{metricValue(metric, p.value)}</td><td>{metricValue(metric, p.minimum)}</td><td>{metricValue(metric, p.maximum)}</td><td>{p.resolution ?? 15}s</td></tr>)}</tbody></table></div></details>
  </div>;
}
export function HubMetrics({ compact = false, active = true }: { compact?: boolean; active?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(), [points, setPoints] = useState<MetricPoint[]>([]);
  const [hours, setHours] = useState("24"), [scope, setScope] = useState("fleet"), [metric, setMetric] = useState("online_users");
  const [error, setError] = useState(""), [retry, setRetry] = useState(0), [historyKey, setHistoryKey] = useState("");
  const key = `${hours}:${scope}:${metric}`;
  useEffect(() => {
    if (!active) return;
    let live = true;
    async function load() { try {
      const [s, h] = await Promise.all([api<Snapshot>("/admin/hub/metrics"), api<{ points: MetricPoint[] }>("/admin/hub/metrics/history?hours=" + hours + "&scope=" + encodeURIComponent(scope) + "&metric=" + metric)]);
      if (live) { setSnapshot(s); setPoints(h.points.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.minimum) && Number.isFinite(p.maximum) && Number.isFinite(Date.parse(p.bucket)))); setHistoryKey(key); setError(""); }
    } catch (e) { if (live) setError((e as Error).message); } }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [hours, scope, metric, active, retry]);
  const state = !snapshot ? "Loading" : snapshot.onlineUsers === null ? "Unavailable" : snapshot.complete ? "Complete" : "Partial lower bound";
  const source = snapshot?.sources.find((s) => s.id === scope);
  return <div className="stack hub-metrics">
    {!compact && <PageHeader title="Monitoring" description="Live account presence and reported resource measurements." actions={<Button onClick={() => setRetry((r) => r + 1)}><RefreshCw size={16} />Refresh</Button>} />}
    {error && <Notice tone="danger">{error} <Button onClick={() => setRetry((r) => r + 1)}>Retry</Button></Notice>}
    <div className="metric-grid hub-presence-summary">
      <Card><div className="hub-stat-label"><Activity size={16} />Online users</div><h2>{snapshot?.onlineUsers == null ? "—" : `${snapshot.complete ? "" : "≥ "}${snapshot.onlineUsers}`}</h2><Badge tone={snapshot?.complete ? "success" : "warning"}>{state}</Badge>{snapshot?.onlineUsers === null && <small>No verified relay telemetry</small>}</Card>
      <Card><div className="hub-stat-label">Reporting sources</div><h2>{snapshot?.reportingSources ?? "—"}{snapshot?.expectedSources !== undefined && <small> / {snapshot.expectedSources}</small>}</h2><small><Clock3 size={13} />{snapshot ? `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : "Awaiting measurements"}</small></Card>
    </div>
    <Card><div className="hub-chart-heading"><h3>{metric === "online_users" ? "Concurrent users" : metricLabel(metric)}</h3><div className="hub-chart-controls">
      {!compact && <><Select aria-label="Server" value={scope} onChange={(e) => { setScope(e.target.value); if (e.target.value === "fleet") setMetric("online_users"); }}><option value="fleet">All users</option>{snapshot?.sources.map((s) => <option key={s.id} value={s.id}>{s.label || s.id}</option>)}</Select>
      <Select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)}><option value="online_users">Online users</option>{scope !== "fleet" && Array.from(new Set([...Object.keys(labels).filter((m) => m !== "online_users"), ...Object.keys(source?.metrics ?? {})])).map((m) => <option key={m} value={m}>{metricLabel(m)}</option>)}</Select></>}
      <Select aria-label="History range" value={hours} onChange={(e) => setHours(e.target.value)}><option value="1">Last hour</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></Select>
    </div></div>
    {historyKey === key && points.length >= 2 ? <MetricChart key={key} points={points} metric={metric} /> : <Empty title={snapshot && historyKey !== key ? "Loading measurements…" : "History will appear here"}>Measurements start when verified relay telemetry arrives. Missing reports are not counted as zero.</Empty>}
    </Card>
    {!compact && snapshot?.sources.map((s) => <Card key={s.id} className="hub-source-card"><div className="hub-source-heading"><h3>{s.label || s.id}</h3><small>Observed {new Date(s.observedAt).toLocaleString()}</small></div><div className="metric-grid hub-source-stats"><div><small>Online users</small><strong>{s.onlineUsers ?? "—"}</strong></div>{Object.entries(s.metrics).map(([name, value]) => <div key={name}><small>{metricLabel(name)}</small><strong>{metricValue(name, value)}</strong></div>)}</div></Card>)}
  </div>;
}
