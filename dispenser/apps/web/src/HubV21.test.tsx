import { describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@atlas-link-dispenser/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { Admin, adminDestination, adminGroup, adminPanelURL, signOutHub } from "./Admin";
import { userArea, nextSupportRequest } from "./UserDashboard";
import { hubRestorePending } from "./App";
import { HubEntry } from "./HubEntry";
import { HubAuthorize } from "./HubAuthorize";
import { HubSessionRestoring } from "./HubSessionTransfer";
import { MetricChart, metricScale, metricPath, type MetricPoint } from "./HubMetrics";
import { NotificationActivity, supportReadPermitted } from "./HubSupport";
import { Button, Field, Select, Input } from "./ui";
const points: MetricPoint[] = [
  { bucket: "2026-10-20T00:00:00Z", value: 2, minimum: 1, maximum: 3, resolution: 15 },
  { bucket: "2026-10-20T00:00:15Z", value: 4, minimum: 3, maximum: 5, resolution: 15 },
  { bucket: "2026-10-20T00:01:00Z", value: 3, minimum: 2, maximum: 4, resolution: 15 },
];
describe("V2.1 Hub navigation and existing contracts", () => {
  it("revokes the existing server session before changing administrator UI state", async () => {
    const calls: string[] = [];
    let resolve!: () => void;
    const pending = signOutHub(() => calls.push("signed-out"), () => new Promise<void>((done) => { calls.push("POST /logout"); resolve = done; }));
    expect(calls).toEqual(["POST /logout"]);
    resolve(); await pending;
    expect(calls).toEqual(["POST /logout", "signed-out"]);
  });
  it("keeps the administrator signed in when logout fails so a retry remains possible", async () => {
    let signedOut = false;
    await expect(signOutHub(() => { signedOut = true; }, async () => { throw Error("offline"); })).rejects.toThrow("offline");
    expect(signedOut).toBe(false);
  });
  it("keeps every existing admin deep link and rejects mismatched contextual panels", () => {
    for (const section of ["overview", "users", "links", "infrastructure", "support", "rules", "check-mail", "verification", "manual-verification", "reports", "settings", "audit"] as const) {
      expect(adminDestination(`?admin=${section}`)).toBe(section);
      expect(adminPanelURL(section)).toBe(`/?admin=${section}`);
    }
    expect(adminDestination("?admin=infrastructure&view=cloud")).toBe("cloud");
    expect(adminDestination("?admin=settings&view=storage")).toBe("storage");
    expect(adminDestination("?admin=rules&view=directories")).toBe("directories");
    expect(adminDestination("?admin=users&view=cloud")).toBe("users");
    expect(adminDestination("?admin=unknown")).toBe("overview");
    expect(adminGroup("manual-verification")).toBe("users");
    vi.stubGlobal("location", { search: "?admin=overview" });
    try {
      const html = renderToStaticMarkup(<Admin user={{ id: "admin-fixture", email: "admin@example.test", role: "admin" } as PublicUser} onLogout={() => {}} onExit={() => {}} />);
      expect(html.indexOf("<h1>Overview</h1>")).toBeGreaterThan(-1);
      expect(html.indexOf("hub-metrics")).toBeGreaterThan(-1);
      expect(html.indexOf("<h1>Overview</h1>")).toBeLessThan(html.indexOf("hub-metrics"));
    } finally { vi.unstubAllGlobals(); }
  });
  it("maps ordinary-user views without adding an Inbox or exposing admin destinations", () => {
    for (const area of ["links", "data", "sessions", "support"]) expect(userArea(`?view=${area}`)).toBe(area);
    expect(userArea("?view=inbox")).toBe("links");
    expect(userArea("?admin=overview")).toBe("links");
  });
  it("holds new-auth rendering until replacement-Hub discovery settles", () => {
    expect(hubRestorePending(true, true, false, false, false)).toBe(true);
    expect(hubRestorePending(true, true, false, false, true)).toBe(true);
    expect(hubRestorePending(true, true, false, true, false)).toBe(false);
    expect(hubRestorePending(true, true, true, false, false)).toBe(false);
    expect(hubRestorePending(false, true, false, false, false)).toBe(false);
  });
  it("never permits hidden, background or admin conversations to acknowledge user reads", () => {
    expect(supportReadPermitted(false, true, true)).toBe(true);
    expect(supportReadPermitted(false, false, true)).toBe(false);
    expect(supportReadPermitted(false, true, false)).toBe(false);
    expect(supportReadPermitted(true, true, true)).toBe(false);
  });
  it("renders notification records only, with no invented message preview or read mutation", () => {
    const html = renderToStaticMarkup(<NotificationActivity notifications={[{ id: "1", ticket_id: "ticket-1", subject: "Question <script>", created_at: "2026-10-20T00:00:00Z", read_at: null }]} onOpen={() => {}} />);
    expect(html).toContain("Question &lt;script&gt;");
    expect(html).toContain("Unread");
    expect(html).toContain("Support replied");
    expect(html).not.toContain("Create ticket");
    expect(html).not.toContain("textarea");
    const first = nextSupportRequest({ ticketId: "", revision: 0 }, "ticket-1");
    const sameAfterSelectingAnotherConversation = nextSupportRequest(first, "ticket-1");
    expect(sameAfterSelectingAnotherConversation.ticketId).toBe("ticket-1");
    expect(sameAfterSelectingAnotherConversation.revision).toBeGreaterThan(first.revision);
    expect(sameAfterSelectingAnotherConversation).not.toBe(first);
  });
  it("keeps busy actions disabled even when callers explicitly pass disabled=false", () => {
    const html = renderToStaticMarkup(<Button busy disabled={false}>Save</Button>);
    expect(html).toContain('disabled=""'); expect(html).toContain('aria-busy="true"');
    const labelled = renderToStaticMarkup(<Field label="Category" hint="Choose a category"><Select><option>Other</option></Select></Field>);
    expect(labelled).toMatch(/<label[^>]*for="[^"]+"[^>]*>Category<\/label>/);
    expect(labelled).toContain("aria-describedby");
    expect(labelled.match(/<label[^>]*>(.*?)<\/label>/)?.[1]).toBe("Category");
    expect(renderToStaticMarkup(<Input className="code-input" />)).toContain('class="input code-input"');
  });
});
describe("honest metric geometry", () => {
  it("fixes CPU axes to percent and uses one IEC unit across a memory chart", () => {
    expect(metricScale("cpu_percent", points)).toEqual({ divisor: 1, unit: "%", max: 100 });
    const scale = metricScale("host_memory_used_bytes", [{ ...points[0], maximum: 3 * 1024 ** 3 }]);
    expect(scale.divisor).toBe(1024 ** 3); expect(scale.unit).toBe("GiB");
    expect(metricScale("online_users", [{ ...points[0], maximum: 2 }]).max).toBe(2);
  });
  it("retains gaps rather than connecting missing samples", () => {
    expect((metricPath(points).match(/M/g) || [])).toHaveLength(2);
  });
  it("renders labelled axes, timezone and keyboard-accessible point summaries", () => {
    const html = renderToStaticMarkup(<MetricChart metric="online_users" points={points} />);
    expect(html).toContain("people"); expect(html).toContain("Zero baseline");
    expect(html.match(/tabindex="0"/g)?.length).toBeGreaterThanOrEqual(points.length);
    expect(html).toContain("View measurements"); expect(html).toContain("15s resolution");
    expect(html).toContain('class="hub-chart-yaxis"'); expect(html).toContain('class="hub-chart-xaxis"');
    expect(html).not.toContain("<text");
  });
});


describe("review-requested unified entry presentation", () => {
  it("keeps checking, transfer and authorization in the same Atlas loading card", () => {
    const frames = [<HubEntry />, <HubSessionRestoring />, <HubAuthorize enabled />];
    for (const frame of frames) {
      const html = renderToStaticMarkup(frame);
      expect(html).toContain('data-entry-card=');
      expect(html).toContain('class="auth-shell hub-entry"');
      expect(html).toContain('<h1 id="hub-entry-title">Opening Atlas</h1>');
      expect(html).toContain('style="visibility:hidden" aria-hidden="true"');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain("Back to Hub");
      expect(html).not.toContain("Sign out");
    }
  });
  it("retains explicit recovery controls when entry is unavailable", () => {
    const html=renderToStaticMarkup(<HubAuthorize enabled={false} />);
    expect(html).toContain("This Hub is not activated yet.");
    expect(html).toContain("Back to Hub");
    expect(html).toContain('aria-busy="false"');
  });
});
