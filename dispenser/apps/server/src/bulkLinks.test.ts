import { describe, expect, it } from "vitest";
import { parseBulkLinks, validatedPublicUrl } from "./bulkLinks.js";
describe("bulk link import", () => {
  it("accepts newline URLs and named pipe rows", () =>
    expect(
      parseBulkLinks("https://one.example\nSecond | https://two.example/path"),
    ).toEqual([
      expect.objectContaining({
        name: "one.example",
        url: "https://one.example/",
      }),
      expect.objectContaining({
        name: "Second",
        url: "https://two.example/path",
      }),
    ]));
  it("rejects duplicates and private destinations", () => {
    expect(() =>
      parseBulkLinks("https://one.example\nhttps://one.example"),
    ).toThrow(/Duplicate/);
    expect(() => validatedPublicUrl("http://127.0.0.1/admin")).toThrow(
      /Private/,
    );
  });
  it("supports large imports", () =>
    expect(
      parseBulkLinks(
        Array.from(
          { length: 1000 },
          (_, i) => `https://node-${i}.example`,
        ).join("\n"),
      ),
    ).toHaveLength(1000));
});
