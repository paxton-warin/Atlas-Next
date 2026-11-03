import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckMailAdmin,
  CheckMailSettings,
  CheckMailUsage,
  checkMailSettingsBody,
  describeCheckMailTest,
  type CheckMailConfig,
} from "./CheckMailAdmin";

const config: CheckMailConfig = {
  enabled: true,
  configured: true,
  monthlyLimit: 900,
  used: 28,
  remaining: 872,
  providerRemaining: null,
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-10-31T00:00:00.000Z",
  allowlist: [],
};
describe("Check-Mail administration", () => {
  it("omits blank keys so ordinary settings edits retain the credential", () => {
    expect(checkMailSettingsBody(true, 900, "  ", false)).toEqual({
      enabled: true,
      monthlyLimit: 900,
    });
  });
  it("sends a replacement key only on explicit input", () => {
    expect(
      checkMailSettingsBody(true, 1000, "  example-test-key  ", false),
    ).toEqual({
      enabled: true,
      monthlyLimit: 1000,
      apiKey: "example-test-key",
    });
  });
  it("deleting a key disables checking and never includes a replacement", () => {
    expect(checkMailSettingsBody(true, 500, "example-test-key", true)).toEqual({
      enabled: false,
      monthlyLimit: 500,
      clearApiKey: true,
    });
  });
  it("distinguishes returning accounts without implying a paid verification", () => {
    expect(
      describeCheckMailTest({ skipped: true, reason: "existing_account" }),
    ).toContain("Returning accounts use no Check-Mail requests");
  });
  it("makes whitelist scope explicit and shows the matched rule", () => {
    expect(
      describeCheckMailTest({
        skipped: true,
        reason: "allowlist",
        matchedRule: {
          id: "1",
          kind: "domain",
          pattern: "fcpsschools.net",
          enabled: true,
          note: "Trusted school",
        },
      }),
    ).toBe(
      "Whitelist match: Check-Mail is skipped (Trusted school). Ordinary email rules still apply.",
    );
  });
  it("supports a whitelist match with no note or returned rule", () => {
    expect(
      describeCheckMailTest({
        skipped: true,
        reason: "allowlist",
        matchedRule: {
          id: "1",
          kind: "domain",
          pattern: "fcpsschools.net",
          enabled: true,
          note: "",
        },
      }),
    ).toContain("(fcpsschools.net)");
    expect(
      describeCheckMailTest({ skipped: true, reason: "allowlist" }),
    ).toContain("Check-Mail is skipped.");
  });
  it("does not claim the local tester validated deliverability", () => {
    expect(
      describeCheckMailTest({ skipped: false, reason: "check_required" }),
    ).toContain("This test made no provider request");
    expect(
      describeCheckMailTest({ skipped: true, reason: "disabled" }),
    ).toContain("no provider request would be made");
  });
  it("keeps the credential blank, password-protected, and independent of browser storage", () => {
    const html = renderToStaticMarkup(
      <CheckMailSettings value={config} onSaved={async () => {}} />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("Leave blank to keep the saved key");
    expect(html).toContain("API key configured");
    expect(html).toContain("Remove saved API key and disable Check-Mail");
    expect(html).toContain('min="1"');
    expect(html).toContain('max="1000"');
    expect(html).not.toContain("example-test-key");
  });
  it("supports setup directly in admin with no environment work", () => {
    const html = renderToStaticMarkup(
      <CheckMailSettings
        value={{ ...config, enabled: false, configured: false }}
        onSaved={async () => {}}
      />,
    );
    expect(html).toContain("API key not configured");
    expect(html).toContain("No environment configuration or restart is needed");
    expect(html).not.toContain("Remove saved API key");
  });
  it("shows local and provider counters separately without a provider call", () => {
    const html = renderToStaticMarkup(<CheckMailUsage value={config} />);
    expect(html).toContain("872");
    expect(html).toContain("30-day window");
    expect(html).toContain("Not yet reported");
    expect(html).toContain("not the provider&#x27;s billing counter");
    expect(html).toContain("never contact Check-Mail");
  });
  it("shows a known provider counter and exhausted budget explicitly", () => {
    const html = renderToStaticMarkup(
      <CheckMailUsage
        value={{ ...config, used: 900, remaining: 0, providerRemaining: 77 }}
      />,
    );
    expect(html).toContain("77");
    expect(html).toContain("budget is exhausted");
    expect(html).toContain(
      "returning accounts and whitelist matches still use no requests",
    );
  });
  it("labels the independent provider-only whitelist even before loading", () => {
    const html = renderToStaticMarkup(<CheckMailAdmin />);
    expect(html).toContain("Only new accounts are checked");
    expect(html).toContain("does not override ordinary email deny rules");
  });
});
