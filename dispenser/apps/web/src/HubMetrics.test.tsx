import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HubMetrics, MetricChart, metricPath, metricRangePath, metricScale, type MetricPoint } from "./HubMetrics";

describe("Metric measurement ordering", () => {
  it("renders the latest 48 rows newest first while preserving chronological graph data", () => {
    const points: MetricPoint[] = Array.from({ length: 60 }, (_, i) => ({ bucket: new Date(Date.UTC(2026, 9, 21, 14, 0, i * 15)).toISOString(), value: i, minimum: i, maximum: i + 1, resolution: 15 }));
    const original = structuredClone(points);
    points.forEach(Object.freeze);
    Object.freeze(points);
    const path = metricPath(points, 750, 160, metricScale("online_users", points).max);
    const html = renderToStaticMarkup(<MetricChart points={points} metric="online_users" />);
    const table = html.match(/<tbody>(.*?)<\/tbody>/)?.[1] || "";
    const rows = [...table.matchAll(/<tr>(.*?)<\/tr>/g)].map(match => match[1]);
    expect(rows).toHaveLength(48);
    expect(rows[0]).toContain(new Date(points[59].bucket).toLocaleString());
    expect(rows.at(-1)).toContain(new Date(points[12].bucket).toLocaleString());
    for (const excluded of points.slice(0, 12)) expect(table).not.toContain(new Date(excluded.bucket).toLocaleString());
    expect(html).toContain(`d="${path}"`);
    expect(metricPath(points, 750, 160, metricScale("online_users", points).max)).toBe(path);
    expect(points).toEqual(original);
  });
  it("keeps the existing empty-history presentation without rendering an invalid chart", () => {
    const html = renderToStaticMarkup(<HubMetrics active={false} />);
    expect(html).toContain("History will appear here");
    expect(html).not.toContain("View measurements");
  });
});

describe("Concurrent user line and observed range", () => {
  const points: MetricPoint[] = [
    { bucket: "2026-10-23T12:00:00Z", value: 30, minimum: 24, maximum: 36 },
    { bucket: "2026-10-23T12:00:15Z", value: 40, minimum: 32, maximum: 48 },
    { bucket: "2026-10-23T12:02:00Z", value: 20, minimum: 16, maximum: 28 },
    { bucket: "2026-10-23T12:02:15Z", value: 32, minimum: 20, maximum: 40 },
  ];
  it("keeps exact time gaps in both the mean and observed min/max band", () => {
    const before = structuredClone(points), path = metricRangePath(points, 750, 160, 48);
    expect(path.match(/M/g)).toHaveLength(2); expect(path.match(/Z/g)).toHaveLength(2);
    expect(metricPath(points).match(/M/g)).toHaveLength(2); expect(points).toEqual(before);
    expect(metricRangePath([])).toBe(""); expect(metricRangePath(points.slice(0, 1))).toBe("");
  });
  it("renders a clean concurrent-user mean with transparent interactive targets and observed labels", () => {
    const html = renderToStaticMarkup(<MetricChart points={points} metric="online_users" />);
    expect(html).toContain('class="hub-chart-range"'); expect(html).toContain('Low 16'); expect(html).toContain('High 48');
    expect(html).toContain("not a confidence range"); expect(html.match(/class="hub-chart-hit-point"/g)).toHaveLength(4);
    expect(html.match(/tabindex="0"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("Focus a measurement"); expect(html).toContain('aria-label="'); expect(html).toContain("View measurements");
  });
  it("leaves other metric point markers and units unchanged", () => {
    const html = renderToStaticMarkup(<MetricChart points={points} metric="cpu_percent" />);
    expect(html).not.toContain('class="hub-chart-range"'); expect(html).not.toContain("hub-chart-hit-point");
    expect(html).toContain('r="3"'); expect(html).toContain("Host CPU"); expect(html).toContain("%");
  });
});
