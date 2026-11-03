let csrfToken: string | null = null;
export const setCsrf = (value: string | null) => {
  csrfToken = value;
};
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(!["GET", "HEAD"].includes(method) && csrfToken
        ? { "x-csrf-token": csrfToken }
        : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    if (
      payload.error?.code === "MANUAL_VERIFICATION_REQUIRED" &&
      typeof window !== "undefined"
    )
      window.dispatchEvent(new Event("atlas:manual-verification-required"));
    throw new ApiError(
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? "Something went wrong.",
      response.status,
    );
  }
  return payload as T;
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
