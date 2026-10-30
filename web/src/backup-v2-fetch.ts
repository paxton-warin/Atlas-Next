/** Network-only transport. Deadlines measure inactivity, not total transfer
 * duration. Native website storage never imports or awaits this module. */
import {
  BACKUP_V2_LIMITS,
  canonicalBackupJSON,
} from "../../runtime/backup-v2-contracts.ts";
export function createBackupV2FetchTransport(options: {
  prefix?: string;
  headers: () => Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onActivity?: () => void;
}) {
  const prefix = options.prefix ?? "/api/hub/profile/backups/v2",
    fetcher = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 45000;
  const activityListeners = new Set<(path: string) => void>();
  const headerListeners = new Set<
    (headers: {
      path: string;
      status: number;
      restoreReader: string | null;
    }) => void
  >();
  function observedHeaders(path: string, response: Response) {
    for (const listener of headerListeners)
      try {
        listener({
          path,
          status: response.status,
          restoreReader: response.headers.get("x-atlas-restore-reader"),
        });
      } catch {}
  }

  function activity(path: string) {
    // Lease maintenance is not restore data progress: it must never keep a
    // stalled actor alive or recursively renew its own reader protection.
    if (/\/restore-(?:renew|release)$/.test(path)) return;
    options.onActivity?.();
    for (const listener of activityListeners)
      try {
        listener(path);
      } catch {}
  }

  function deadline(signal?: AbortSignal) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          controller.abort(
            Object.assign(
              Error(
                "Backup transfer stopped making progress. Retry to continue.",
              ),
              { name: "TimeoutError", code: "BACKUP_TRANSFER_STALLED" },
            ),
          ),
        timeout,
      );
    };
    reset();
    return {
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      reset,
      close() {
        clearTimeout(timer);
      },
    };
  }
  async function bytes(
    response: Response,
    limit: number,
    reset: () => void,
    path: string,
    reportProgress = true,
  ) {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    let buffer = new Uint8Array(Math.min(limit, 8192)),
      length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength) {
          reset();
          if (reportProgress) activity(path);
          length += next.value.byteLength;
          if (length > limit) {
            await reader.cancel();
            throw Object.assign(
              Error("Backup response exceeds its bounded allowance."),
              { code: "BACKUP_RESPONSE_TOO_LARGE" },
            );
          }
          if (length > buffer.length) {
            const grown = new Uint8Array(
              Math.min(limit, Math.max(length, buffer.length * 2)),
            );
            grown.set(buffer);
            buffer = grown;
          }
          buffer.set(next.value, length - next.value.byteLength);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return buffer.slice(0, length);
  }
  function retryAfter(response: Response) {
    const raw = response.headers.get("retry-after");
    if (!raw || !/^\d{1,3}$/.test(raw)) return {};
    const seconds = Number(raw);
    return seconds >= 1 && seconds <= 900
      ? { retryAfterMs: seconds * 1000 }
      : {};
  }
  function immutableRestoreRead(path: string, method: string) {
    if (method !== "GET") return false;
    const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
      parsed = new URL(path, "https://backup.invalid");
    return (
      new RegExp(`^/parts/[a-f0-9]{64}$`, "i").test(parsed.pathname) ||
      new RegExp(`^/namespace-versions/${uuid}/records$`, "i").test(
        parsed.pathname,
      ) ||
      new RegExp(`^/checkpoints/${uuid}(?:/namespaces)?$`, "i").test(
        parsed.pathname,
      )
    );
  }
  async function retryRestoreRead<T>(
    path: string,
    method: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw signal.reason;
      try {
        return await work();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const issue = error as { status?: number; retryAfterMs?: number };
        if (
          !immutableRestoreRead(path, method) ||
          attempt >= 3 ||
          ![429, 503].includes(issue?.status || 0)
        )
          throw error;
        // Retry the same immutable page/part inside this staging attempt. Do not
        // throw away its already verified metadata/cache on momentary pressure.
        // Long server delays are returned to the caller rather than ignored or
        // allowed to hold a restore actor/reader indefinitely.
        const serverDelay = issue.retryAfterMs ?? 0;
        const base = Math.min(2000, 250 * 2 ** attempt);
        const delay = Math.max(
          Math.min(2000, Math.round(base * (1 + Math.random() * 0.25))),
          serverDelay,
        );
        if (
          !Number.isFinite(serverDelay) ||
          serverDelay < 0 ||
          serverDelay > 15000 ||
          waited + delay > 30000
        )
          throw error;
        waited += delay;
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const aborted = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", aborted);
            reject(signal?.reason);
          };
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", aborted);
            resolve();
          }, delay);
          signal?.addEventListener("abort", aborted, { once: true });
          if (signal?.aborted) aborted();
        });
      }
    }
  }
  function errorFields(data: any) {
    const code = data?.error?.code,
      message = data?.error?.message;
    return {
      ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
        ? { code }
        : {}),
      ...(typeof message === "string" && message.length <= 500
        ? { message }
        : {}),
    };
  }
  function rejectionDetails(data: any) {
    const d = data?.error?.details,
      uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (
      data?.error?.code !== "BACKUP_CATALOG_FULL" ||
      !d ||
      typeof d.checkpointId !== "string" ||
      !uuid.test(d.checkpointId) ||
      typeof d.manifestDigest !== "string" ||
      !/^[a-f0-9]{64}$/i.test(d.manifestDigest) ||
      !Array.isArray(d.rejectedNamespaceVersionIds) ||
      d.rejectedNamespaceVersionIds.length < 1 ||
      d.rejectedNamespaceVersionIds.length > 64 ||
      d.rejectedNamespaceVersionIds.some(
        (id: unknown) => typeof id !== "string" || !uuid.test(id),
      ) ||
      new Set(d.rejectedNamespaceVersionIds).size !==
        d.rejectedNamespaceVersionIds.length
    )
      return {};
    return {
      details: {
        checkpointId: d.checkpointId,
        manifestDigest: d.manifestDigest,
        rejectedNamespaceVersionIds: [...d.rejectedNamespaceVersionIds],
      },
    };
  }
  async function call<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    binary = false,
  ): Promise<T> {
    const wait = deadline(signal);
    try {
      const response = await fetcher(prefix + path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: wait.signal,
        headers: {
          ...options.headers(),
          ...(body === undefined
            ? {}
            : {
                "content-type": binary
                  ? "application/octet-stream"
                  : "application/json",
              }),
        },
        ...(body === undefined
          ? {}
          : { body: binary ? (body as BodyInit) : canonicalBackupJSON(body) }),
      });
      wait.reset();
      observedHeaders(path, response);
      if (response.ok) activity(path);
      const rawBytes = await bytes(
        response,
        2 * 1024 * 1024,
        wait.reset,
        path,
        response.ok,
      );
      let data: any;
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
        data = raw ? JSON.parse(raw) : undefined;
      } catch {
        throw Object.assign(
          Error(
            response.ok
              ? "Backup returned invalid JSON."
              : "Backup service is temporarily unavailable.",
          ),
          {
            status: response.ok ? 502 : response.status || 502,
            code: "BACKUP_RESPONSE_INVALID",
            ...retryAfter(response),
          },
        );
      }
      if (!response.ok)
        throw Object.assign(
          Error(data?.error?.message || "Backup request failed."),
          {
            status: response.status,
            code: data?.error?.code || "BACKUP_REQUEST_FAILED",
            ...retryAfter(response),
            ...rejectionDetails(data),
          },
        );
      return data as T;
    } finally {
      wait.close();
    }
  }
  return {
    subscribeResponseHeaders(
      listener: (headers: {
        path: string;
        status: number;
        restoreReader: string | null;
      }) => void,
    ) {
      headerListeners.add(listener);
      return () => {
        headerListeners.delete(listener);
      };
    },
    subscribeActivity(listener: (path: string) => void) {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
    request: <T = unknown>(
      path: string,
      method = "GET",
      body?: unknown,
      signal?: AbortSignal,
    ) =>
      retryRestoreRead(path, method, signal, () =>
        call<T>(path, method, body, signal),
      ),
    upload: (path: string, data: Uint8Array, signal?: AbortSignal) =>
      call(path, "PUT", data, signal, true),
    download(path: string, signal?: AbortSignal) {
      return retryRestoreRead(path, "GET", signal, async () => {
        const wait = deadline(signal);
        try {
          const response = await fetcher(prefix + path, {
            credentials: "same-origin",
            cache: "no-store",
            headers: options.headers(),
            signal: wait.signal,
          });
          wait.reset();
          if (response.ok) activity(path);
          if (!response.ok) {
            // Error bodies are bounded independently and never signal restore
            // progress. Preserve the real admission/rate-limit code for recovery.
            let fields: { code?: string; message?: string } = {};
            try {
              const raw = await bytes(response, 8192, wait.reset, path, false);
              fields = errorFields(JSON.parse(new TextDecoder().decode(raw)));
            } catch {}
            throw Object.assign(
              Error(
                fields.message || "Backup part is temporarily unavailable.",
              ),
              {
                status: response.status,
                code: fields.code || "BACKUP_PART_UNAVAILABLE",
                ...retryAfter(response),
              },
            );
          }
          const result = await bytes(
            response,
            BACKUP_V2_LIMITS.partBytes,
            wait.reset,
            path,
          );
          if (!result.byteLength) throw Error("BACKUP_PART_EMPTY");
          return result;
        } finally {
          wait.close();
        }
      });
    },
  };
}
