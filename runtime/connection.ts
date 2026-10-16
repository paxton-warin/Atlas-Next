const SESSION_REFRESH_CODES = new Set([
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "INVALID_SESSION",
  "SESSION_GENERATION_MISMATCH",
  "TICKET_EXPIRED",
  "INVALID_TICKET",
]);
function authenticationNeedsRefresh(status: number, code?: string) {
  return (
    status === 401 ||
    status === 410 ||
    (status === 409 && SESSION_REFRESH_CODES.has(code || ""))
  );
}
export function runtimeConnectionRetryDelay(
  attempt: number,
  retryAfter?: string | null,
) {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const date =
    retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
  const hinted = Number.isFinite(seconds)
    ? seconds
    : Number.isFinite(date)
      ? (date - Date.now()) / 1000
      : NaN;
  return Math.min(
    30000,
    Math.max(
      1000,
      (Number.isFinite(hinted) && hinted >= 0
        ? hinted
        : Math.min(30, 2 ** Math.min(attempt, 5))) * 1000,
    ),
  );
}
// Report authentication failure even when runtime configuration fails before boot.
export async function loadRuntimeConfig(ticket: string) {
  let failure:
    | { type: string; message: string; code?: string; boot?: boolean }
    | undefined;
  let parentOrigin = "";
  const report = () => {
    if (failure && parentOrigin)
      parent.postMessage({ atlas: 1, ...failure }, parentOrigin);
  };
  const ping = (event: MessageEvent) => {
    if (
      parent === window ||
      event.source !== parent ||
      event.data?.atlas !== 1 ||
      event.data.type !== "ping"
    )
      return;
    parentOrigin = event.origin;
    report();
  };
  addEventListener("message", ping);
  let attempt = 0;
  const temporary = (status: number) => status === 429 || status >= 500;
  for (;;) {
    let response: Response | undefined;
    try {
      response = await fetch("/runtime-config", {
        cache: "no-store",
        headers: ticket ? { authorization: "Bearer " + ticket } : {},
        signal: AbortSignal.timeout(8000),
      });
      const config = await response.json();
      if (response.ok) {
        removeEventListener("message", ping);
        return config;
      }
      if (!temporary(response.status) || config.retryable === false) {
        failure = {
          type: authenticationNeedsRefresh(response.status, config.code)
            ? "session-refresh-needed"
            : "boot-error",
          code: config.code,
          boot: true,
          message:
            config.message || config.error || "Browsing node is unavailable.",
        };
        throw Error(failure.message);
      }
    } catch (error) {
      if (failure || (response && !temporary(response.status))) {
        failure ||= {
          type: "boot-error",
          message: (error as Error).message,
          boot: true,
        };
        report();
        // A later authenticated parent ping still receives a boot failure.
        throw error;
      }
      // Network failures and temporary server responses retry this exact
      // ticket/origin. They never allocate a session or switch a node.
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        runtimeConnectionRetryDelay(
          attempt++,
          response?.headers?.get("Retry-After"),
        ),
      ),
    );
  }
}

export function watchRuntimeSession(
  initialTicket: string | (() => string),
  notify: (type: string, data?: Record<string, unknown>) => void,
) {
  let ticket = typeof initialTicket === "string" ? initialTicket : "";
  const currentTicket = () =>
    typeof initialTicket === "function" ? initialTicket() : ticket;
  let checking = false;
  const check = async () => {
    const bearer = currentTicket();
    if (checking || !bearer) return;
    checking = true;
    try {
      const response = await fetch("/runtime-config", {
        cache: "no-store",
        headers: { authorization: "Bearer " + bearer },
        signal: AbortSignal.timeout(8000),
      });
      // A rotated credential may have superseded this request while in flight.
      if (bearer !== currentTicket()) return;
      if ([401, 409, 410].includes(response.status)) {
        const reason = await response.json().catch(() => ({}));
        if (!authenticationNeedsRefresh(response.status, reason.code)) return;
        // The frontend owns session intent and asks the authenticated server
        // to renew/restore. A stale bearer is not proof of lease revocation.
        notify("session-refresh-needed", {
          code: reason.code || "TICKET_EXPIRED",
        });
      }
    } catch {
      /* Temporary network loss is not proof of session expiry. */
    } finally {
      checking = false;
    }
  };
  const visible = () => {
    if (!document.hidden) void check();
  };
  const timer = setInterval(visible, 30000);
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pageshow", visible);
  window.addEventListener("online", visible);
  return {
    update(value: string) {
      ticket = value;
    },
    check,
    dispose() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", visible);
      window.removeEventListener("online", visible);
    },
  };
}
