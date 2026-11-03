import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  pageMetadata,
  pageRequest,
  queryPage,
  searchPattern,
  statusFilter,
} from "./pagination.js";

describe("admin pagination", () => {
  it("defaults to a bounded 50-row page", () => {
    expect(pageRequest({})).toEqual({ page: 1, pageSize: 50 });
  });
  it.each([
    "0",
    "-1",
    "1.5",
    "1e2",
    "01",
    "",
    "Infinity",
    "9007199254740992",
    ["1", "2"],
    2,
    null,
  ])("rejects malformed page %j", (page) => {
    expect(() => pageRequest({ page })).toThrow();
  });
  it.each(["0", "-1", "101", "1000", "1.5", ["1", "2"]])(
    "rejects invalid pageSize %j",
    (pageSize) => {
      expect(() => pageRequest({ pageSize })).toThrow();
    },
  );
  it("accepts the page size limit and clamps stale last pages", () => {
    expect(
      pageMetadata(pageRequest({ page: "20", pageSize: "100" }), 501),
    ).toEqual({ page: 6, pageSize: 100, total: 501, totalPages: 6 });
    expect(pageMetadata(pageRequest({ page: "99" }), 0)).toEqual({
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    });
  });
  it("validates filter types and enum values", () => {
    expect(searchPattern({ q: " hello " })).toBe("%hello%");
    expect(() => searchPattern({ q: ["hello"] })).toThrow();
    expect(() => searchPattern({ q: "a".repeat(501) })).toThrow();
    expect(statusFilter({}, ["all", "active"])).toBe("all");
    expect(() =>
      statusFilter({ status: "admin" }, ["all", "active"]),
    ).toThrow();
  });
  it("counts and reads rows within one snapshot with parameterized filters and limits", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "251" }] })
      .mockResolvedValueOnce({ rows: [{ id: "last" }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = {
      connect: async () => ({ query, release }),
    } as unknown as Pool;
    const result = await queryPage(
      pool,
      { page: "99", pageSize: "50" },
      {
        select: "id",
        from: "users",
        where: "email ILIKE $1",
        values: ["%test%"],
        order: "created_at DESC,id DESC",
      },
    );
    expect(result).toEqual({
      items: [{ id: "last" }],
      pagination: { page: 6, pageSize: 50, total: 251, totalPages: 6 },
    });
    expect(query.mock.calls).toEqual([
      ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      [
        "SELECT count(*)::text total FROM users WHERE email ILIKE $1",
        ["%test%"],
      ],
      [
        "SELECT id FROM users WHERE email ILIKE $1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
        ["%test%", 50, 250],
      ],
      ["COMMIT"],
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
  it("rolls back and releases on query failure", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("query failed"))
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = {
      connect: async () => ({ query, release }),
    } as unknown as Pool;
    await expect(
      queryPage(pool, {}, { select: "id", from: "users", order: "id" }),
    ).rejects.toThrow("query failed");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
  it("validates pagination before opening a database connection", async () => {
    const connect = vi.fn();
    await expect(
      queryPage(
        { connect } as unknown as Pool,
        { pageSize: "101" },
        { select: "id", from: "users", order: "id" },
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
