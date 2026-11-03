import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRequestGuard,
  pageRange,
  pageUrl,
  Pagination,
} from "./pagination";

describe("admin pagination", () => {
  it("preserves encoded search/filter params and replaces page controls", () => {
    const url = pageUrl(
      "/admin/users?q=a%2Bb%40example.com&status=suspended&page=99",
      6,
      50,
    );
    expect(url).toBe(
      "/admin/users?q=a%2Bb%40example.com&status=suspended&page=6&pageSize=50",
    );
  });
  it("adds pagination to endpoints without an existing query", () => {
    expect(pageUrl("/admin/audit", 2, 100)).toBe(
      "/admin/audit?page=2&pageSize=100",
    );
  });
  it("shows records beyond the former 250-row cap", () => {
    expect(
      pageRange({ page: 6, pageSize: 50, total: 301, totalPages: 7 }),
    ).toBe("251–300 of 301");
    expect(
      pageRange({ page: 7, pageSize: 50, total: 301, totalPages: 7 }),
    ).toBe("301–301 of 301");
  });
  it("handles an empty list without a misleading first record", () => {
    expect(pageRange({ page: 1, pageSize: 50, total: 0, totalPages: 1 })).toBe(
      "0–0 of 0",
    );
  });
  it("rejects stale responses and invalidates responses on unmount", () => {
    const gate = createRequestGuard();
    const first = gate.next();
    const second = gate.next();
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    gate.invalidate();
    expect(gate.current(second)).toBe(false);
  });
  const markup = (page: number, total: number, loading = false) =>
    renderToStaticMarkup(
      <Pagination
        label="Users"
        info={{
          page,
          pageSize: 50,
          total,
          totalPages: Math.max(1, Math.ceil(total / 50)),
        }}
        loading={loading}
        pageSize={50}
        onPage={() => {}}
        onPageSize={() => {}}
      />,
    );
  it("provides accessible labels and disables Previous on page one", () => {
    const html = markup(1, 301);
    expect(html).toContain('aria-label="Users pagination"');
    expect(html).toContain('aria-label="Users per page"');
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Previous/);
    expect(html).not.toMatch(/<button[^>]+disabled=""[^>]*>Next/);
    expect(html).toContain("1–50 of 301 users");
  });
  it("uses the server's last page and disables Next", () => {
    const html = markup(7, 301);
    expect(html).toContain("Page 7 of 7");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Next/);
    expect(html).not.toMatch(/<button[^>]+disabled=""[^>]*>Previous/);
  });
  it("disables both navigation and page size while fetching", () => {
    const html = markup(2, 301, true);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading records…");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
