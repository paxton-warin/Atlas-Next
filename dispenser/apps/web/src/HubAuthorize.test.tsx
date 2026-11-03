import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HubAuthorize,
  parseHubAuthorization,
  hubCallbackURL,
} from "./HubAuthorize";
describe("Hub branch authorization UI", () => {
  const state = "random_state_123456789",
    branchId = "11111111-1111-4111-8111-111111111111",
    challenge = "x".repeat(43);
  it("accepts only branch identity, PKCE and state; caller callback URLs do not affect the request", () => {
    expect(
      parseHubAuthorization(
        "?branchId=" +
          branchId +
          "&codeChallenge=" +
          challenge +
          "&state=" +
          state +
          "&return_to=https://attacker.test",
      ),
    ).toEqual({ branchId, codeChallenge: challenge, state });
  });
  it("rejects incomplete or forged identity requests", () => {
    expect(() =>
      parseHubAuthorization(
        "?branchId=evil&codeChallenge=" + challenge + "&state=" + state,
      ),
    ).toThrow();
    expect(() =>
      parseHubAuthorization(
        "?branchId=" + branchId + "&codeChallenge=" + challenge,
      ),
    ).toThrow();
  });
  it("uses only HTTPS fixed callback and bound state", () => {
    const value = {
      callback: "https://branch.example/auth/hub/callback",
      code: "a".repeat(43),
      state,
    };
    expect(hubCallbackURL(value, state)).toContain(
      "https://branch.example/auth/hub/callback?code=",
    );
    for (const callback of [
      "http://branch.example/auth/hub/callback",
      "https://branch.example/other",
      "https://branch.example/auth/hub/callback?next=evil",
    ])
      expect(() => hubCallbackURL({ ...value, callback }, state)).toThrow();
    expect(() => hubCallbackURL(value, "wrong-state")).toThrow();
  });
  it("holds disabled activation rather than issuing a handoff", () => {
    const html = renderToStaticMarkup(<HubAuthorize enabled={false} />);
    expect(html).toContain("not activated");
    expect(html).not.toContain("Signing you into");
  });
});
