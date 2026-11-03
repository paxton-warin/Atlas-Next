import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { adminGroup } from "./Admin";
import { HubMetrics, metricPath, metricLabel, metricValue } from "./HubMetrics";
import { HubSupport, HubNotificationBell } from "./HubSupport";
describe("unified Hub interface", () => {
  it("formats resource labels and units without exposing machine field names", () => {
    expect(metricLabel("cpu_percent")).toBe("CPU usage");
    expect(metricValue("cpu_percent", 39.073)).toBe("39.1%");
    expect(metricValue("disk_total_bytes", 1024 ** 4)).toBe("1.0 TiB");
    expect(metricValue("host_uptime_seconds", 172800)).toBe("2.0 days");
    expect(metricValue("latency_p95_ms", 123.4)).toBe("123 ms");
  });
  it("keeps existing controls in six focused navigation groups", () => {
    expect(adminGroup("manual-verification")).toBe("users");
    expect(adminGroup("verification")).toBe("users");
    expect(adminGroup("links")).toBe("links");
    expect(adminGroup("reports")).toBe("support");
    for (const section of ["rules", "check-mail", "audit", "settings"] as const)
      expect(adminGroup(section)).toBe("settings");
  });
  it("does not invent online users or historical telemetry", () => {
    const html = renderToStaticMarkup(<HubMetrics />);
    expect(html).toContain("History will appear here");
    expect(html).toContain("Missing reports are not counted as zero");
    expect(html).not.toContain("100 users");
  });
  it("separates user support creation from administrator conversation selection", () => {
    expect(renderToStaticMarkup(<HubSupport />)).toContain("Create ticket");
    const html = renderToStaticMarkup(<HubSupport admin />);
    expect(html).toContain("Choose a ticket");
    expect(html).not.toContain("Create ticket");
  });
  it("provides a distinct accessible notification activity entry point", () => {
    expect(
      renderToStaticMarkup(<HubNotificationBell onOpen={() => {}} />),
    ).toContain('aria-label="Notifications"');
  });
  it("breaks graph paths across missing measurements", () => {
    const path = metricPath([
      { bucket: "2026-10-20T00:00:00Z", value: 2, minimum: 2, maximum: 2 },
      { bucket: "2026-10-20T00:00:15Z", value: 3, minimum: 3, maximum: 3 },
      { bucket: "2026-10-20T00:00:45Z", value: 4, minimum: 4, maximum: 4 },
    ]);
    expect(path.match(/M/g) || []).toHaveLength(2);
    expect(path.match(/L/g) || []).toHaveLength(1);
    expect(metricPath([])).toBe("");
  });
});
