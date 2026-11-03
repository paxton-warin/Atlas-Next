import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTRY_LAUNCH_LINK,
  entryLaunchLinkOrDefault,
  validateEntryLaunchLink,
} from "./entryLaunchLink.js";

const valid = {
  url: "https://example.test/doc?tab=t.0#heading",
  hubEnabled: true,
  browserEnabled: false,
};

describe("Entry launch link validation", () => {
  it("defaults both surfaces off without changing the configured document URL", () => {
    expect(entryLaunchLinkOrDefault(undefined)).toEqual(
      DEFAULT_ENTRY_LAUNCH_LINK,
    );
    expect(DEFAULT_ENTRY_LAUNCH_LINK.hubEnabled).toBe(false);
    expect(DEFAULT_ENTRY_LAUNCH_LINK.browserEnabled).toBe(false);
    expect(DEFAULT_ENTRY_LAUNCH_LINK.url).toContain("edit?tab=t.0");
  });

  it("preserves the full destination including its query and fragment", () => {
    expect(validateEntryLaunchLink(valid)).toEqual(valid);
    expect(
      validateEntryLaunchLink({
        ...valid,
        url: " http://example.test/a?b=2#c ",
      }).url,
    ).toBe("http://example.test/a?b=2#c");
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { ...valid, url: "" },
    { ...valid, url: "example.test" },
    { ...valid, url: "javascript:alert(1)" },
    { ...valid, url: "data:text/html,<h1>test</h1>" },
    { ...valid, url: "ftp://example.test/file" },
    { ...valid, url: "https://user:password@example.test/" },
    { ...valid, url: "https://user@example.test/" },
    { ...valid, url: "https://exam\nple.test/" },
    { ...valid, url: "https://example.test/" + "a".repeat(2048) },
    { ...valid, hubEnabled: "true" },
    { ...valid, browserEnabled: 1 },
    { ...valid, unknown: true },
    { url: valid.url, hubEnabled: true },
  ])(
    "rejects malformed settings and fails stored values closed: %j",
    (value) => {
      expect(() => validateEntryLaunchLink(value)).toThrow();
      expect(entryLaunchLinkOrDefault(value)).toEqual(
        DEFAULT_ENTRY_LAUNCH_LINK,
      );
    },
  );
});
