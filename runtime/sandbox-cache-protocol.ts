/** Cache records contain only readable, origin-owned bytes. Opaque network
 * responses need private raw handles and are deliberately not represented. */
export const SANDBOX_CACHE_PROTOCOL = "atlas-cache-v1";
export const SANDBOX_CACHE_DATABASE = "atlas.browsing.cache.v2";
export const SANDBOX_CACHE_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
  maxCaches: 64,
  maxEntries: 2048,
  maxBatch: 64,
  maxPending: 32,
  maxNameLength: 1024,
  maxURLLength: 16384,
  maxHeaders: 128,
  maxHeaderBytes: 65536,
});
export type CacheRequestData = {
  url: string;
  method: string;
  headers: [string, string][];
  mode: RequestMode;
  credentials: RequestCredentials;
  redirect: RequestRedirect;
  referrer: string;
  referrerPolicy: ReferrerPolicy;
  integrity: string;
};
export type CacheResponseData = {
  type: "default" | "basic" | "cors" | "error";
  url: string;
  redirected: boolean;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
};
export type CacheEntryData = {
  request: CacheRequestData;
  response: CacheResponseData;
};
export type CacheQueryData = {
  ignoreSearch: boolean;
  ignoreMethod: boolean;
  ignoreVary: boolean;
  cacheName?: string;
};
export type CacheState = {
  version: 1;
  nextId: number;
  names: { name: string; id: number }[];
  caches: { id: number; entries: CacheEntryData[] }[];
};
export const emptyCacheState = (): CacheState => ({
  version: 1,
  nextId: 1,
  names: [],
  caches: [],
});
export function cacheFailure(
  name: string,
  message = "Cache operation failed",
): Error {
  return name === "TypeError"
    ? new TypeError(message)
    : new DOMException(message, name);
}
export function cacheURL(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > SANDBOX_CACHE_LIMITS.maxURLLength
  )
    throw cacheFailure("TypeError", "Invalid cache request URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw cacheFailure("TypeError", "Cache requests require HTTP(S) URLs");
  return url.href;
}
export function cacheHeaders(value: unknown): value is [string, string][] {
  if (!Array.isArray(value) || value.length > SANDBOX_CACHE_LIMITS.maxHeaders)
    return false;
  let bytes = 0;
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0]) ||
      /[\r\n\0]/.test(pair[1])
    )
      return false;
    bytes += 2 * (pair[0].length + pair[1].length);
  }
  return bytes <= SANDBOX_CACHE_LIMITS.maxHeaderBytes;
}
export function checkedCacheRequest(value: any): CacheRequestData {
  if (
    !value ||
    typeof value !== "object" ||
    !cacheHeaders(value.headers) ||
    typeof value.method !== "string" ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(value.method) ||
    !["cors", "no-cors", "same-origin", "navigate"].includes(value.mode) ||
    !["omit", "same-origin", "include"].includes(value.credentials) ||
    !["follow", "error", "manual"].includes(value.redirect) ||
    typeof value.referrer !== "string" ||
    value.referrer.length > SANDBOX_CACHE_LIMITS.maxURLLength ||
    ![
      "",
      "no-referrer",
      "no-referrer-when-downgrade",
      "origin",
      "origin-when-cross-origin",
      "same-origin",
      "strict-origin",
      "strict-origin-when-cross-origin",
      "unsafe-url",
    ].includes(value.referrerPolicy) ||
    typeof value.integrity !== "string" ||
    value.integrity.length > 4096
  )
    throw cacheFailure("TypeError", "Invalid cache request record");
  return {
    url: cacheURL(value.url),
    method: value.method,
    headers: value.headers,
    mode: value.mode,
    credentials: value.credentials,
    redirect: value.redirect,
    referrer: value.referrer,
    referrerPolicy: value.referrerPolicy,
    integrity: value.integrity,
  };
}
export function checkedCacheResponse(value: any): CacheResponseData {
  if (
    !value ||
    typeof value !== "object" ||
    !["default", "basic", "cors", "error"].includes(value.type) ||
    typeof value.url !== "string" ||
    value.url.length > SANDBOX_CACHE_LIMITS.maxURLLength ||
    (value.url !== "" && cacheURL(value.url) !== value.url) ||
    typeof value.redirected !== "boolean" ||
    !Number.isInteger(value.status) ||
    typeof value.statusText !== "string" ||
    value.statusText.length > 1024 ||
    /[\r\n\0]/.test(value.statusText) ||
    !cacheHeaders(value.headers) ||
    (value.body !== null && !(value.body instanceof ArrayBuffer)) ||
    (value.body?.byteLength ?? 0) > SANDBOX_CACHE_LIMITS.maxBodyBytes ||
    (value.type === "error"
      ? value.status !== 0 || value.body !== null || value.headers.length !== 0
      : value.status < 200 || value.status > 599) ||
    ([204, 205, 304].includes(value.status) && value.body !== null) ||
    value.status === 206 ||
    headerValue(value.headers, "vary")
      .split(",")
      .some((x) => x.trim() === "*")
  )
    throw cacheFailure("TypeError", "Invalid cache response record");
  return {
    type: value.type,
    url: value.url,
    redirected: value.redirected,
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
    body: value.body,
  };
}
export function checkedCacheQuery(value: any): CacheQueryData {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.ignoreSearch !== "boolean" ||
    typeof value.ignoreMethod !== "boolean" ||
    typeof value.ignoreVary !== "boolean" ||
    (value.cacheName !== undefined &&
      (typeof value.cacheName !== "string" ||
        value.cacheName.length > SANDBOX_CACHE_LIMITS.maxNameLength))
  )
    throw cacheFailure("TypeError", "Invalid cache query options");
  return {
    ignoreSearch: value.ignoreSearch,
    ignoreMethod: value.ignoreMethod,
    ignoreVary: value.ignoreVary,
    ...(value.cacheName === undefined ? {} : { cacheName: value.cacheName }),
  };
}
export function headerValue(headers: [string, string][], name: string): string {
  return headers
    .filter((p) => p[0].toLowerCase() === name)
    .map((p) => p[1])
    .join(", ");
}
export function cacheMatches(
  entry: CacheEntryData,
  request: CacheRequestData,
  options: CacheQueryData,
): boolean {
  if (request.method !== "GET" && !options.ignoreMethod) return false;
  const a = new URL(entry.request.url),
    b = new URL(request.url);
  a.hash = b.hash = "";
  if (options.ignoreSearch) a.search = b.search = "";
  if (a.href !== b.href) return false;
  if (!options.ignoreVary)
    for (const field of headerValue(entry.response.headers, "vary").split(
      ",",
    )) {
      const name = field.trim().toLowerCase();
      if (
        name === "*" ||
        (name &&
          headerValue(entry.request.headers, name) !==
            headerValue(request.headers, name))
      )
        return false;
    }
  return true;
}
export function cacheStateBytes(state: CacheState): number {
  let bytes = 256,
    entries = 0;
  if (
    state.caches.length > SANDBOX_CACHE_LIMITS.maxCaches ||
    state.names.length > SANDBOX_CACHE_LIMITS.maxCaches
  )
    throw cacheFailure("QuotaExceededError", "Cache count limit exceeded");
  for (const item of state.names) bytes += 64 + 2 * item.name.length;
  for (const cache of state.caches)
    for (const entry of cache.entries) {
      if (++entries > SANDBOX_CACHE_LIMITS.maxEntries)
        throw cacheFailure("QuotaExceededError", "Cache entry limit exceeded");
      bytes += 512 + (entry.response.body?.byteLength ?? 0);
      for (const s of [
        entry.request.url,
        entry.request.method,
        entry.request.referrer,
        entry.request.referrerPolicy,
        entry.request.integrity,
        entry.response.url,
        entry.response.statusText,
      ])
        bytes += 2 * s.length;
      for (const pair of [...entry.request.headers, ...entry.response.headers])
        bytes += 32 + 2 * (pair[0].length + pair[1].length);
    }
  if (!Number.isSafeInteger(bytes)) throw cacheFailure("QuotaExceededError");
  return bytes;
}
