import { describe, expect, it } from "vitest";
import { evaluateEmailPolicy, validateRegex } from "./emailPolicy.js";
const rules = [
  {
    id: "deny",
    kind: "exact" as const,
    action: "deny" as const,
    pattern: "blocked@example.com",
    priority: 20,
    enabled: true,
    note: "Blocked",
    denialMessage: "Use your organization email address.",
  },
  {
    id: "allow",
    kind: "domain" as const,
    action: "allow" as const,
    pattern: "@example.com",
    priority: 10,
    enabled: true,
    note: "Members",
    denialMessage: "",
  },
];
describe("email policy", () => {
  it("normalizes addresses and honors priority", () => {
    expect(
      evaluateEmailPolicy(" BLOCKED@Example.com ", rules, "deny"),
    ).toMatchObject({
      allowed: false,
      rule: {
        id: "deny",
        denialMessage: "Use your organization email address.",
      },
    });
    expect(
      evaluateEmailPolicy("person@example.com", rules, "deny"),
    ).toMatchObject({ allowed: true, rule: { id: "allow" } });
  });
  it("uses the default when no rule matches", () =>
    expect(
      evaluateEmailPolicy("person@elsewhere.test", rules, "deny").allowed,
    ).toBe(false));
  it("rejects risky regexes", () => {
    expect(() => validateRegex("(a+)+$")).toThrow(/unsafe/);
    expect(() => validateRegex("[")).toThrow(/invalid/);
    expect(() => validateRegex("^[a-z]+@example\\.com$")).not.toThrow();
  });
});
