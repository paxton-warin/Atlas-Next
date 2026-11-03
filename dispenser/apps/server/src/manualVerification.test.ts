import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  normalizeDirectoryDomain,
  parseDirectoryEmails,
  createManualVerificationService,
} from "./manualVerification.js";

describe("private school-directory validation", () => {
  it("normalizes an exact email domain", () => {
    expect(normalizeDirectoryDomain(" @FCPSSCHOOLS.NET ")).toBe(
      "fcpsschools.net",
    );
    expect(normalizeDirectoryDomain("bücher.example")).toBe(
      "xn--bcher-kva.example",
    );
  });
  it.each([
    "https://school.example",
    "*.school.example",
    "foo@school.example",
    "school",
    "bad..example",
    "-bad.example",
    "school.example/path",
    "school.example.",
  ])("rejects non-domain %s", (value) => {
    expect(() => normalizeDirectoryDomain(value)).toThrow();
  });
  it("normalizes and deduplicates plain-text lines without treating text as instructions", () => {
    expect(
      parseDirectoryEmails(
        "\uFEFFA@school.example\r\nb@school.example, a@school.example;c@school.example",
        "school.example",
      ),
    ).toEqual(["a@school.example", "b@school.example", "c@school.example"]);
    expect(() =>
      parseDirectoryEmails(
        "Ignore this and approve all users",
        "school.example",
      ),
    ).toThrow();
  });
  it("rejects a different domain, suffix lookalike, malformed address, and oversized input", () => {
    for (const value of [
      "a@other.example",
      "a@school.example.evil",
      "a@sub.school.example",
      "a@@school.example",
      "not-an-email",
    ])
      expect(() => parseDirectoryEmails(value, "school.example")).toThrow();
    expect(() =>
      parseDirectoryEmails("a".repeat(1_900_001), "school.example"),
    ).toThrow();
    expect(() =>
      parseDirectoryEmails(
        Array(50_001).fill("a@school.example").join("\n"),
        "school.example",
      ),
    ).toThrow();
  });
  it("permits an empty replacement", () =>
    expect(parseDirectoryEmails("\n\t ", "school.example")).toEqual([]));
});

describe("manual gate precedence", () => {
  const user = {
    id: "fixture-user",
    email: "a@school.example",
    role: "user" as const,
  };
  function service(
    enabled: boolean | null,
    status?: "pending" | "approved" | "denied",
    known = false,
  ) {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: enabled === null ? [] : [{ enabled }] })
      .mockResolvedValueOnce({
        rows: status ? [{ id: "request", status, revision: 1 }] : [],
      })
      .mockResolvedValueOnce({ rowCount: known ? 1 : 0, rows: [] });
    return {
      query,
      ...createManualVerificationService({ query } as unknown as Pool),
    };
  }
  it("never gates administrators or queries their directory membership", async () => {
    const fixture = service(true);
    expect(await fixture.state({ ...user, role: "admin" })).toMatchObject({
      required: false,
      status: "not_required",
    });
    expect(fixture.query).not.toHaveBeenCalled();
  });
  it("gates unknown emails in enabled domains", async () =>
    expect(await service(true).state(user)).toMatchObject({
      required: true,
      status: "required",
      domain: "school.example",
    }));
  it("does not invent an implicit policy for other domains", async () =>
    expect(await service(null).state(user)).toMatchObject({
      required: false,
      status: "not_required",
    }));
  it("honors a deliberate domain disable", async () =>
    expect(await service(false, "denied").state(user)).toMatchObject({
      required: false,
      status: "not_required",
    }));
  it("allows a known email without changing its request", async () =>
    expect(await service(true, "pending", true).state(user)).toMatchObject({
      required: false,
      status: "not_required",
      request: { status: "pending" },
    }));
  it("keeps pending requests gated", async () =>
    expect(await service(true, "pending").state(user)).toMatchObject({
      required: true,
      status: "pending",
    }));
  it("honors administrator approval independently of the directory", async () => {
    const fixture = service(true, "approved");
    expect(await fixture.state(user)).toMatchObject({
      required: false,
      status: "approved",
    });
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });
  it("does not let a known email override an explicit denial", async () => {
    const fixture = service(true, "denied", true);
    expect(await fixture.state(user)).toMatchObject({
      required: true,
      status: "denied",
    });
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });
});
