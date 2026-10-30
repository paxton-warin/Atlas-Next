/** Public presentation configuration only. No user/session credentials forwarded. */
export const DISABLED_ENTRY_LAUNCH_LINK = Object.freeze({
  url: "",
  hubEnabled: false,
  browserEnabled: false,
});

export function normalizeEntryLaunchLink(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      typeof raw.url !== "string" || raw.url.length > 2048 ||
      typeof raw.hubEnabled !== "boolean" || typeof raw.browserEnabled !== "boolean")
    return { ...DISABLED_ENTRY_LAUNCH_LINK };
  try {
    const url = new URL(raw.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return { ...DISABLED_ENTRY_LAUNCH_LINK };
    return { url: url.href, hubEnabled: raw.hubEnabled, browserEnabled: raw.browserEnabled };
  } catch { return { ...DISABLED_ENTRY_LAUNCH_LINK }; }
}

export function createEntryLaunchLinkReader({ fetch: requestFetch = globalThis.fetch,
  now = Date.now, cacheMs = 30000, failureMs = 5000 } = {}) {
  let lastOrigin, cached, expires = 0, pending;
  return async function read(hubOrigin) {
    if (!hubOrigin) return { ...DISABLED_ENTRY_LAUNCH_LINK };
    if (lastOrigin !== hubOrigin) {
      lastOrigin = hubOrigin; cached = undefined; expires = 0; pending = undefined;
    }
    if (cached && now() < expires) return { ...cached };
    if (!pending) {
      const origin = hubOrigin;
      const operation = (async () => {
        let value = { ...DISABLED_ENTRY_LAUNCH_LINK }, success = false;
        try {
          const response = await requestFetch(new URL("/api/hub/launch-link", origin).href, {
            method: "GET", headers: { accept: "application/json" },
            redirect: "error", signal: AbortSignal.timeout(1500),
          });
          if (response.ok) { value = normalizeEntryLaunchLink(await response.json()); success = true; }
          else await response.body?.cancel();
        } catch { /* A failed configuration read never launches an external tab. */ }
        if (lastOrigin === origin) {
          cached = value; expires = now() + (success ? cacheMs : failureMs);
        }
        return value;
      })();
      pending = operation;
      void operation.finally(() => { if (pending === operation) pending = undefined; });
    }
    return { ...(await pending) };
  };
}
