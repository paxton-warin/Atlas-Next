// Report authentication failure even when runtime configuration fails before boot.
export async function loadRuntimeConfig(ticket: string) {
  let failure: { type: string; message: string } | undefined;
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
  try {
    const response = await fetch("/runtime-config", {
      cache: "no-store",
      headers: ticket ? { authorization: "Bearer " + ticket } : {},
      signal: AbortSignal.timeout(8000),
    });
    const config = await response.json();
    if (!response.ok) {
      failure = {
        type:
          response.status === 401 || response.status === 410
            ? "session-expired"
            : "boot-error",
        message:
          config.message || config.error || "Browsing node is unavailable.",
      };
      throw Error(failure.message);
    }
    removeEventListener("message", ping);
    return config;
  } catch (error) {
    failure ||= { type: "boot-error", message: (error as Error).message };
    report();
    // Keep the listener on failure so a parent handshake arriving later receives it.
    throw error;
  }
}

export function watchRuntimeSession(
  ticket: string,
  notify: (type: string, data?: Record<string, unknown>) => void,
) {
  if (!ticket) return;
  let checking = false,
    expired = false;
  const check = async () => {
    if (checking || expired) return;
    checking = true;
    try {
      const response = await fetch("/runtime-config", {
        cache: "no-store",
        headers: { authorization: "Bearer " + ticket },
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401 || response.status === 410) {
        expired = true;
        clearInterval(timer);
        notify("session-expired");
      }
    } catch {
      /* Temporary network loss is not proof of session expiry. */
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(check, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check();
  });
  window.addEventListener("pageshow", () => void check());
  window.addEventListener("online", () => void check());
}
