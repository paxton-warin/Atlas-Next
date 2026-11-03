import { describe, expect, it } from "vitest";
import {
  decrypt,
  encrypt,
  hashSecret,
  safeEqual,
  sixDigitCode,
} from "./security.js";

describe("security primitives", () => {
  it("generates numeric codes at the requested length", () => {
    const codes = new Set(Array.from({ length: 100 }, () => sixDigitCode(6)));
    expect([...codes].every((code) => /^\d{6}$/.test(code))).toBe(true);
    expect(codes.size).toBeGreaterThan(95);
  });
  it("encrypts authenticated data and rejects tampering", () => {
    const encrypted = encrypt("refresh token", "secret");
    expect(decrypt(encrypted, "secret")).toBe("refresh token");
    const parts = encrypted.split(".");
    parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
    expect(() => decrypt(parts.join("."), "secret")).toThrow();
  });
  it("compares hashed values safely", () => {
    const hash = hashSecret("value", "secret");
    expect(safeEqual(hash, hash)).toBe(true);
    expect(safeEqual(hash, hashSecret("other", "secret"))).toBe(false);
  });
});
