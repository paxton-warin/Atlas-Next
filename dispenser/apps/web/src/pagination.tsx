import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button, Select } from "./ui";

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** A monotonic guard: an older response must never replace a newer query. */
export function createRequestGuard() {
  let generation = 0;
  return {
    next: () => ++generation,
    current: (request: number) => request === generation,
    invalidate: () => {
      generation += 1;
    },
  };
}

export function useData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const guard = useRef(createRequestGuard());
  const latestLoader = useRef(loader);
  latestLoader.current = loader;
  // CRUD may complete after a filter changed. Even a previously captured
  // reload callback must refresh the current query, not its old page.
  const load = useCallback(async () => {
    const request = guard.current.next();
    setLoading(true);
    setData(undefined);
    setError("");
    try {
      const next = await latestLoader.current();
      if (guard.current.current(request)) setData(next);
    } catch (failure) {
      if (guard.current.current(request))
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load this page.",
        );
    } finally {
      if (guard.current.current(request)) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => guard.current.invalidate();
  }, [load, ...deps]);
  return { data, error, loading, reload: load, setData };
}

export function pageUrl(path: string, page: number, pageSize: number) {
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  return `${pathname}?${params}`;
}

export function pageRange(info: PageInfo) {
  const first = info.total ? (info.page - 1) * info.pageSize + 1 : 0;
  return `${first.toLocaleString()}–${Math.min(info.page * info.pageSize, info.total).toLocaleString()} of ${info.total.toLocaleString()}`;
}

export function usePagedData<T>(path: string) {
  const [request, setRequest] = useState({ path, page: 1, pageSize: 50 });
  // Reset in the same render as a new search/filter, rather than fetching the
  // previous page once and resetting it in a later effect.
  const current =
    request.path === path ? request : { ...request, path, page: 1 };
  if (request.path !== path) setRequest(current);
  const state = useData(
    () =>
      api<T & { pagination: PageInfo }>(
        pageUrl(path, current.page, current.pageSize),
      ),
    [path, current.page, current.pageSize],
  );
  return {
    ...state,
    pager: {
      info: state.data?.pagination,
      loading: state.loading,
      pageSize: current.pageSize,
      // Use the server's clamped page for navigation after deleting the last
      // record on a page. Do not trigger a redundant correction fetch.
      onPage: (page: number) => setRequest({ ...current, page }),
      onPageSize: (pageSize: number) =>
        setRequest({ ...current, page: 1, pageSize }),
    },
  };
}

export function Pagination({
  label,
  info,
  loading,
  pageSize,
  onPage,
  onPageSize,
}: {
  label: string;
  info?: PageInfo;
  loading: boolean;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
}) {
  return (
    <nav
      className="pagination"
      aria-label={`${label} pagination`}
      aria-busy={loading}
    >
      <span className="pagination__summary" aria-live="polite">
        {loading
          ? "Loading records…"
          : info
            ? `${pageRange(info)} ${label.toLowerCase()}`
            : "Records unavailable"}
      </span>
      <label className="pagination__size">
        Rows
        <Select
          aria-label={`${label} per page`}
          value={pageSize}
          disabled={loading}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </Select>
      </label>
      <div className="pagination__controls">
        <Button
          disabled={loading || !info || info.page <= 1}
          onClick={() => info && onPage(info.page - 1)}
        >
          Previous
        </Button>
        <span>
          Page {info?.page ?? 1} of {Math.max(1, info?.totalPages ?? 1)}
        </span>
        <Button
          disabled={loading || !info || info.page >= info.totalPages}
          onClick={() => info && onPage(info.page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
