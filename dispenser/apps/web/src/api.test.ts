import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, post, setCsrf } from "./api";

describe("API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrf(null);
  });
  it("adds CSRF only to mutating requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    setCsrf("csrf-value");
    await api("/session");
    await post("/logout");
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("x-csrf-token");
    expect(fetch.mock.calls[1][1].headers).toHaveProperty(
      "x-csrf-token",
      "csrf-value",
    );
  });
  it("exposes typed server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: { code: "QUOTA_EXCEEDED", message: "Limit reached." },
        }),
      }),
    );
    await expect(post("/assignment")).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 429,
      message: "Limit reached.",
    } satisfies Partial<ApiError>);
  });
  it("requests session rerouting when a current dashboard becomes manually restricted", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "MANUAL_VERIFICATION_REQUIRED",
            message: "Manual verification is required.",
          },
        }),
      }),
    );
    await expect(api("/assignment")).rejects.toMatchObject({
      code: "MANUAL_VERIFICATION_REQUIRED",
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0][0].type).toBe(
      "atlas:manual-verification-required",
    );
  });
});
