import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_MAIL_ENDPOINT,
  CheckMailError,
  createCheckMailService,
  matchCheckMailAllowlist,
  normalizeCheckMailRule,
  parseCheckMailResponse,
  requestCheckMail,
  type CheckMailAllowlistRule,
} from "./checkMail.js";

const email = "new@example.com";
const valid = {
  valid: true,
  block: false,
  is_disposable: false,
  domain: "example.com",
};
const json = (body: unknown = valid, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
const mockFetch = (response: Response) =>
  vi.fn<typeof fetch>().mockResolvedValue(response);
const rule = (
  kind: CheckMailAllowlistRule["kind"],
  pattern: string,
  enabled = true,
): CheckMailAllowlistRule => ({
  id: "fixture",
  kind,
  pattern,
  enabled,
  note: "",
});
describe("Check-Mail local whitelist", () => {
  it("normalizes exact emails and domains without making any API call", () => {
    expect(
      normalizeCheckMailRule({ kind: "exact", pattern: " User@Example.com " })
        .pattern,
    ).toBe("user@example.com");
    expect(
      normalizeCheckMailRule({ kind: "domain", pattern: " @FCPSSCHOOLS.NET " })
        .pattern,
    ).toBe("fcpsschools.net");
    expect(
      normalizeCheckMailRule({ kind: "domain", pattern: "münich.example" })
        .pattern,
    ).toBe("xn--mnich-kva.example");
  });
  it("uses exact domain boundaries, not suffix matching", () => {
    const rules = [rule("domain", "fcpsschools.net")];
    expect(matchCheckMailAllowlist("A@fcpsschools.net", rules)?.id).toBe(
      "fixture",
    );
    expect(matchCheckMailAllowlist("A@notfcpsschools.net", rules)).toBeNull();
    expect(matchCheckMailAllowlist("A@sub.fcpsschools.net", rules)).toBeNull();
    expect(
      matchCheckMailAllowlist("A@fcpsschools.net.evil.com", rules),
    ).toBeNull();
  });
  it("supports safe regex patterns and disabled rules", () => {
    expect(
      matchCheckMailAllowlist(email, [rule("regex", "^new@example\\.com$")])
        ?.id,
    ).toBe("fixture");
    expect(
      matchCheckMailAllowlist(email, [rule("exact", email, false)]),
    ).toBeNull();
    expect(
      matchCheckMailAllowlist("next@example.com", [rule("exact", email)]),
    ).toBeNull();
  });
  it.each([
    "https://example.com",
    "*.example.com",
    "a@example.com",
    "-bad.example",
    "example..com",
  ])("rejects malformed domain %s", (pattern) =>
    expect(() => normalizeCheckMailRule({ kind: "domain", pattern })).toThrow(),
  );
  it("rejects unsafe regex and overlong metadata", () => {
    expect(() =>
      normalizeCheckMailRule({ kind: "regex", pattern: "(a+)+$" }),
    ).toThrow();
    expect(() =>
      normalizeCheckMailRule({ kind: "regex", pattern: "[" }),
    ).toThrow();
    expect(() =>
      normalizeCheckMailRule({
        kind: "exact",
        pattern: email,
        note: "x".repeat(501),
      }),
    ).toThrow();
  });
});
describe("Check-Mail provider validation", () => {
  it("accepts only a typed matching non-disposable response", () =>
    expect(parseCheckMailResponse(valid, email)).toEqual({ allowed: true }));
  it.each([
    { ...valid, is_disposable: true },
    { ...valid, block: true },
    { ...valid, valid: false },
  ])("rejects provider blocked or invalid addresses", (value) =>
    expect(parseCheckMailResponse(value, email)).toEqual({ allowed: false }),
  );
  it.each([
    null,
    [],
    {},
    { ...valid, valid: "true" },
    { ...valid, block: 0 },
    { ...valid, is_disposable: undefined },
    { ...valid, domain: "other.example" },
  ])("fails closed for malformed or mismatched data", (value) =>
    expect(() => parseCheckMailResponse(value, email)).toThrow(CheckMailError),
  );
  it("makes exactly one fixed HTTPS form request with no redirect or retry", async () => {
    const fetcher = mockFetch(
      json(valid, { headers: { "x-ratelimit-requests-remaining": "999" } }),
    );
    expect(await requestCheckMail(email, "fixture-api-key", fetcher)).toEqual({
      allowed: true,
      providerRemaining: 999,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(CHECK_MAIL_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBe("email=new%40example.com");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer fixture-api-key",
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });
  it.each([401, 403, 500, 503])(
    "fails closed on HTTP%d without retry",
    async (status) => {
      const fetcher = mockFetch(
        json({ message: "fixture raw secret must not surface" }, { status }),
      );
      await expect(
        requestCheckMail(email, "fixture-api-key", fetcher),
      ).rejects.toMatchObject({ code: "CHECK_MAIL_UNAVAILABLE", status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("records provider exhaustion without parsing an HTML response", async () => {
    const fetcher = mockFetch(new Response("rate limit", { status: 429 }));
    expect(
      await requestCheckMail(email, "fixture-api-key", fetcher),
    ).toMatchObject({ rateLimited: true, providerRemaining: 0 });
  });
  it("fails closed on redirects/network errors without revealing credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Bearer fixture-api-key"));
    await expect(
      requestCheckMail(email, "fixture-api-key", fetcher),
    ).rejects.toThrow("Email checking is temporarily unavailable.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves a zero remaining header even when the body is invalid", async () => {
    await expect(
      requestCheckMail(
        email,
        "fixture-api-key",
        mockFetch(
          json({}, { headers: { "x-ratelimit-requests-remaining": "0" } }),
        ),
      ),
    ).rejects.toMatchObject({ providerRemaining: 0 });
  });
  it("rejects wrong MIME and oversized streamed bodies", async () => {
    await expect(
      requestCheckMail(
        email,
        "fixture-api-key",
        mockFetch(
          new Response(JSON.stringify(valid), {
            headers: { "content-type": "text/html" },
          }),
        ),
      ),
    ).rejects.toThrow(CheckMailError);
    await expect(
      requestCheckMail(
        email,
        "fixture-api-key",
        mockFetch(json({ data: "x".repeat(33_000) })),
      ),
    ).rejects.toThrow(CheckMailError);
    await expect(
      requestCheckMail(
        email,
        "fixture-api-key",
        mockFetch(json(valid, { headers: { "content-length": "999999" } })),
      ),
    ).rejects.toThrow(CheckMailError);
  });
  it("aborts slow requests and never retries", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener(
              "abort",
              () => reject(new Error("timed out")),
              { once: true },
            ),
          ),
      );
    await expect(
      requestCheckMail(email, "fixture-api-key", fetcher, 5),
    ).rejects.toThrow(CheckMailError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe("Check-Mail returning-account guard", () => {
  it("does not read settings, consume budget, or call the provider for returning accounts", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("must not connect")),
      fetcher = vi.fn<typeof fetch>();
    const service = createCheckMailService({
      pool: { connect } as unknown as Pool,
      dataEncryptionKey: "fixture-encryption-key",
      fetch: fetcher,
    });
    expect(
      await service.checkNewAccount(email, { accountExists: true }),
    ).toEqual({ allowed: true, reason: "returning_account" });
    expect(connect).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
