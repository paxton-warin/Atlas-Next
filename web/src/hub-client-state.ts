export type HubClientSession = {
  enabled: boolean;
  authenticated?: boolean;
  hubOrigin?: string;
  csrf?: string;
  blocked?: boolean;
  branchAvailable?: boolean;
  endpointTransition?: {
    revision: number;
    hubOrigin: string;
    destination?: string;
  };
  uiOnlyLab?: boolean;
  browsingAvailable?: boolean;
  grant?: {
    protocol: number;
    userId: string;
    profileId: string;
    branchId: string;
    sessionId: string;
    contextId: string;
    expiresAt: string;
    grantExpiresAt: string;
  };
};
let current: HubClientSession | null = null;
export const getHubSession = () => current;
export function setHubSession(value: HubClientSession | null) {
  current = value;
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("atlas:hub-session", { detail: value?.grant ?? null }),
    );
}
export type HubInitializer = (
  state: HubClientSession,
) => Promise<{ ready: boolean; message?: string }>;
let initializer: HubInitializer | null = null;
export function registerHubInitializer(fn: HubInitializer) {
  initializer = fn;
}
export async function initializeHubCloud(state: HubClientSession) {
  if (!initializer)
    return {
      ready: false,
      message:
        "Cloud profile initialization is not configured. Browsing remains held.",
    };
  return initializer(state);
}
export async function hubProfileRequest<T = unknown>(
  path = "",
  method = "GET",
  body?: unknown,
): Promise<T> {
  const s = getHubSession();
  if (!s?.authenticated || !s.csrf)
    throw Error("Authenticate with Atlas Hub first.");
  const response = await fetch("/api/hub/profile" + path, {
    method,
    signal: AbortSignal.timeout(12000),
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-atlas-hub-csrf": s.csrf },
    // Trusted profile workers can provide an already-serialized JSON Blob.
    // Its native transport avoids stringify/base64 work on the browser UI agent.
    ...(body === undefined ? {} : { body: body instanceof Blob && body.type === "application/json" ? body : JSON.stringify(body) }),
  });
  // HTTP status remains authoritative even when a gateway returns HTML or an
  // empty/truncated body. A malformed 503 must not become a permanent repair.
  let data: any;
  try { data = await response.json(); }
  catch {
    throw Object.assign(new Error(response.status >= 500
      ? "Atlas Hub is temporarily unavailable. Local saves are retained."
      : "Atlas Hub returned an invalid response. Retry without signing out."),
      {code:response.status >= 500 ? "HUB_UNAVAILABLE" : "HUB_INVALID_RESPONSE",status:response.status >= 500 ? response.status : 502});
  }
  const latest = getHubSession();
  if (
    !latest?.authenticated ||
    latest.grant?.profileId !== s.grant?.profileId ||
    latest.grant?.sessionId !== s.grant?.sessionId ||
    latest.grant?.contextId !== s.grant?.contextId
  )
    throw Object.assign(
      new Error("The account changed. This response was discarded."),
      { code: "PROFILE_CONTEXT_CHANGED" },
    );
  if (!response.ok)
    throw Object.assign(
      new Error(
        data.error?.message ||
          data.error ||
          "The cloud profile request failed.",
      ),
      { code: data.error?.code, status: response.status },
    );
  return data;
}
