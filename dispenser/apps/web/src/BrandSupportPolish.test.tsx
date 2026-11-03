import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AtlasBrandMark } from "./AtlasBrandMark";
import { supportAuthorLabel } from "./HubSupport";

describe("Atlas corner branding and ticket participant labels", () => {
  it("uses the shared decorative Atlas mark without duplicating the wordmark's accessible text", () => {
    expect(renderToStaticMarkup(<AtlasBrandMark />)).toBe('<span class="atlas-brand-mark" aria-hidden="true">A</span>');
  });
  it("does not call the ticket's user You on the administrator side", () => {
    expect(supportAuthorLabel("user", true)).toBe("User");
    expect(supportAuthorLabel("user", false)).toBe("You");
    expect(supportAuthorLabel("admin", true)).toBe("Atlas support");
    expect(supportAuthorLabel("admin", false)).toBe("Atlas support");
  });
});
