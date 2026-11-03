import type { Pool, QueryResultRow } from "pg";
import { AppError } from "./errors.js";

export type PageRequest = { page: number; pageSize: number };
export type Pagination = PageRequest & { total: number; totalPages: number };
export type PageQuery = Record<string, unknown>;

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${name} must be a positive integer.`,
    );
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${name} must be no greater than ${max}.`,
    );
  }
  return number;
}

export function pageRequest(query: PageQuery): PageRequest {
  return {
    page: positiveInteger(query.page, 1, "page"),
    pageSize: positiveInteger(query.pageSize, 50, "pageSize", 100),
  };
}

export function pageMetadata(request: PageRequest, total: number): Pagination {
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("Invalid pagination total");
  const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
  return {
    page: Math.min(request.page, totalPages),
    pageSize: request.pageSize,
    total,
    totalPages,
  };
}

export function searchPattern(query: PageQuery): string {
  if (
    query.q !== undefined &&
    (typeof query.q !== "string" || query.q.length > 500)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Search must be text of 500 characters or fewer.",
    );
  }
  return `%${(query.q as string | undefined)?.trim() ?? ""}%`;
}

export function statusFilter(
  query: PageQuery,
  allowed: readonly string[],
): string {
  const status = query.status ?? "all";
  if (typeof status !== "string" || !allowed.includes(status)) {
    throw new AppError("VALIDATION_ERROR", "Unknown status filter.");
  }
  return status;
}

// SQL fragments are authored by the server, never by request input. All values
// (including limits/offsets) are parameters. A single snapshot keeps count and
// rows consistent if records change while an administrator loads a page.
export async function queryPage<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  query: PageQuery,
  sql: {
    select: string;
    from: string;
    where?: string;
    order: string;
    values?: unknown[];
  },
): Promise<{ items: T[]; pagination: Pagination }> {
  const requested = pageRequest(query);
  const values = sql.values ?? [];
  const where = sql.where ? ` WHERE ${sql.where}` : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const count = await client.query<{ total: string }>(
      `SELECT count(*)::text total FROM ${sql.from}${where}`,
      values,
    );
    const pagination = pageMetadata(requested, Number(count.rows[0]!.total));
    const rows = await client.query<T>(
      `SELECT ${sql.select} FROM ${sql.from}${where} ORDER BY ${sql.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [
        ...values,
        pagination.pageSize,
        (pagination.page - 1) * pagination.pageSize,
      ],
    );
    await client.query("COMMIT");
    return { items: rows.rows, pagination };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
