import { encodeTarget, decodeTarget } from "./url-codec.ts";

export const SAME_ORIGIN_RUNTIME_PATH = "/browse/runtime/";

export function runtimeFrameSandbox(config?: {
  runtimeProtocols?: { sameOrigin?: { activated?: boolean } };
}) {
  return config?.runtimeProtocols?.sameOrigin?.activated === true
    ? undefined
    : "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-presentation";
}

/** Both runtime locations are fixed application routes, never caller URLs. */
export function runtimeDocumentUrl(runtimeOrigin: string, runtimePath = "/") {
  const runtime = new URL(runtimeOrigin);
  if (
    !["https:", "http:"].includes(runtime.protocol) ||
    runtime.username ||
    runtime.password ||
    runtime.pathname !== "/" ||
    runtime.search ||
    runtime.hash ||
    !["/", SAME_ORIGIN_RUNTIME_PATH].includes(runtimePath)
  )
    throw Error("Use a browsing runtime origin and route.");
  return new URL(runtimePath, runtime.origin);
}

export function createRuntimeFrameUrl(
  runtimeOrigin: string,
  ticket?: string,
  runtimePath = "/",
  attempt = 0,
) {
  const runtime = runtimeDocumentUrl(runtimeOrigin, runtimePath);
  if (attempt) runtime.searchParams.set("session", String(attempt));
  if (ticket) runtime.hash = new URLSearchParams({ ticket }).toString();
  return runtime.href;
}

/** Keep assignment tickets out of HTTP URLs/referrers and literal targets out of wrapper URLs. */
export function createDirectTabUrl(
  runtimeOrigin: string,
  target: string,
  ticket?: string,
  youtubeAdblock = true,
  runtimePath = "/",
): string {
  const runtime = runtimeDocumentUrl(runtimeOrigin, runtimePath);
  const destination = new URL(target);
  if (
    !["https:", "http:"].includes(destination.protocol) ||
    destination.username ||
    destination.password ||
    target.length > 8192 ||
    destination.href.length > 8192 ||
    destination.origin === runtime.origin
  )
    throw Error("Use an external web URL.");
  if (
    ticket !== undefined &&
    (typeof ticket !== "string" || !ticket || ticket.length > 32768)
  )
    throw Error("Use a valid browsing ticket.");
  const fragment = new URLSearchParams({
    page: encodeTarget(destination.href),
  });
  if (ticket) fragment.set("ticket", ticket);
  if (!youtubeAdblock) fragment.set("adblock", "0");
  const result = runtime;
  result.hash = fragment.toString();
  return result.href;
}

export function directTabTarget(params: URLSearchParams): string | null {
  const compact = params.get("page");
  if (compact !== null) {
    if (compact.length > 12000) throw Error("Invalid page address.");
    return decodeTarget(compact);
  }
  return params.get("goto");
}
