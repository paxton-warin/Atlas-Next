import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDocumentAnnouncementController, DEFAULT_ENTRY_LAUNCH_LINK, DocumentAnnouncementDialog, EntryLaunchLinkSettings,
  hubLaunchRouteEligible, HubLaunchLink, normalizeDocumentAnnouncement, normalizeEntryLaunchLink,
} from "./EntryLaunchLink";
const enabled = { ...DEFAULT_ENTRY_LAUNCH_LINK, hubEnabled: true, announcementId: "a".repeat(64), acknowledged: false };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const success = { acknowledged: true, announcementId: enabled.announcementId };

describe("Hub document announcement", () => {
  it("defaults both applications off and never renders before authenticated config is ready", () => {
    expect(DEFAULT_ENTRY_LAUNCH_LINK.hubEnabled).toBe(false);
    expect(DEFAULT_ENTRY_LAUNCH_LINK.browserEnabled).toBe(false);
    expect(renderToStaticMarkup(<HubLaunchLink userId="account-1" />)).toBe("");
    const html = renderToStaticMarkup(<EntryLaunchLinkSettings onSaved={() => {}} />);
    expect(html).toContain("Disabled by default"); expect(html).not.toContain('checked=""');
    expect(html).toContain('type="url"'); expect(html).toContain("Atlas Hub"); expect(html).toContain("Atlas Browser");
    expect(html).toContain("Save announcement"); expect(html).not.toContain("Automatic new tabs");
  });
  it("keeps toggles boolean and validates URL protocols, length and credentials", () => {
    expect(normalizeEntryLaunchLink(DEFAULT_ENTRY_LAUNCH_LINK)).toEqual(DEFAULT_ENTRY_LAUNCH_LINK);
    expect(normalizeEntryLaunchLink({ ...enabled, url: "http://example.test/path" })?.url).toBe("http://example.test/path");
    for (const url of ["javascript:alert(1)", "data:text/html,bad", "example.test", "https://user:secret@example.test", "https://" + "a".repeat(2048)])
      expect(normalizeEntryLaunchLink({ ...enabled, url })).toBeNull();
    expect(normalizeEntryLaunchLink({ ...enabled, hubEnabled: "false" })).toBeNull();
    expect(normalizeDocumentAnnouncement({ ...enabled, announcementId: "wrong" })).toBeNull();
    expect(normalizeDocumentAnnouncement({ ...enabled, acknowledged: "true" })).toBeNull();
  });
  it("fetches exactly once across StrictMode-style repeated starts and never opens external windows", async () => {
    const load = vi.fn(async () => enabled), acknowledge = vi.fn();
    const controller = createDocumentAnnouncementController({ load, acknowledge, eligible: () => true });
    const off = controller.subscribe(() => {});
    controller.start(); off(); controller.start(); await settle(); controller.start();
    expect(load).toHaveBeenCalledTimes(1); expect(acknowledge).not.toHaveBeenCalled();
    expect(controller.snapshot().open).toBe(true);
    await controller.close(false); controller.start(); expect(controller.snapshot().open).toBe(false);
  });
  it("provides only an explicit real Open document anchor and a saved-link checkbox", () => {
    const html = renderToStaticMarkup(<DocumentAnnouncementDialog announcement={enabled} open busy={false} error="" onClose={() => {}} />);
    expect(html).toContain("New document link"); expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain("Open document");
    expect(html).toContain("Not now"); expect(html).toContain("I&#x27;ve saved this link. Don&#x27;t show this again.");
  });
  it("does not persist Not now, and saves the exact current ID only after the user checks saved", async () => {
    const acknowledge = vi.fn(async () => success);
    const controller = createDocumentAnnouncementController({ load: async () => enabled, acknowledge, eligible: () => true });
    controller.start(); await settle(); await controller.close(false); expect(acknowledge).not.toHaveBeenCalled();
    const next = createDocumentAnnouncementController({ load: async () => enabled, acknowledge, eligible: () => true });
    next.start(); await settle(); await next.close(true);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(enabled.announcementId);
    expect(next.snapshot()).toMatchObject({ open: false, busy: false, error: "" });
  });
  it("keeps the modal open and retryable after an acknowledgement failure or mismatched ID", async () => {
    for (const response of [undefined, { acknowledged: true, announcementId: "b".repeat(64) }, { acknowledged: false, announcementId: enabled.announcementId }]) {
      const acknowledge = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(success);
      const controller = createDocumentAnnouncementController({ load: async () => enabled, acknowledge, eligible: () => true });
      controller.start(); await settle(); await controller.close(true);
      expect(controller.snapshot()).toMatchObject({ open: true, busy: false }); expect(controller.snapshot().error).not.toBe("");
      await controller.close(true); expect(controller.snapshot().open).toBe(false);
    }
    const controller = createDocumentAnnouncementController({ load: async () => enabled, acknowledge: async () => { throw Error("offline"); }, eligible: () => true });
    controller.start(); await settle(); await controller.close(true); expect(controller.snapshot().error).toBe("offline");
  });
  it("does not issue duplicate acknowledgement requests while one is pending", async () => {
    let resolve!: (value: unknown) => void; const acknowledge = vi.fn(() => new Promise((done) => { resolve = done; }));
    const controller = createDocumentAnnouncementController({ load: async () => enabled, acknowledge, eligible: () => true });
    controller.start(); await settle(); const closing = controller.close(true); await controller.close(true);
    expect(acknowledge).toHaveBeenCalledTimes(1); expect(controller.snapshot().busy).toBe(true);
    resolve(success); await closing; expect(controller.snapshot().open).toBe(false);
  });
  it("stays absent when acknowledged, disabled, Browser-only, malformed or unavailable", async () => {
    for (const value of [{ ...enabled, acknowledged: true }, { ...enabled, hubEnabled: false }, { ...enabled, hubEnabled: false, browserEnabled: true }, { ...enabled, url: "javascript:alert(1)" }]) {
      const controller = createDocumentAnnouncementController({ load: async () => value, acknowledge: vi.fn(), eligible: () => true });
      controller.start(); await settle(); expect(controller.snapshot().open).toBe(false);
    }
    const load = vi.fn(async () => { throw Error("offline"); });
    const controller = createDocumentAnnouncementController({ load, acknowledge: vi.fn(), eligible: () => true });
    controller.start(); await settle(); controller.start(); await settle(); expect(load).toHaveBeenCalledTimes(1); expect(controller.snapshot().open).toBe(false);
  });
  it("waits for a visible ordinary top-level document, including if hidden while fetching", async () => {
    let eligible = false; const load = vi.fn(async () => enabled);
    const controller = createDocumentAnnouncementController({ load, acknowledge: vi.fn(), eligible: () => eligible });
    controller.start(); expect(load).not.toHaveBeenCalled();
    eligible = true; controller.start(); eligible = false; await settle(); expect(controller.snapshot().open).toBe(false);
    eligible = true; controller.start(); expect(load).toHaveBeenCalledTimes(1); expect(controller.snapshot().open).toBe(true);
  });
  it("excludes authorization/transfer/helper routes, while permitting ordinary authenticated pages", () => {
    for (const route of ["/authorize", "/auth/callback", "/api/session", "/hub/session-transfer/start", "/hub/authorize", "/hub/profile/events", "/setup", "/health", "/worker.js"])
      expect(hubLaunchRouteEligible(route), route).toBe(false);
    for (const route of ["/", "/support", "/signin", "/login"]) expect(hubLaunchRouteEligible(route), route).toBe(true);
  });
});
