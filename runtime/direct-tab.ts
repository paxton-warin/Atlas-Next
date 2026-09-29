import { encodeTarget, decodeTarget } from "./url-codec.ts";

/** Keep assignment tickets out of HTTP URLs/referrers and literal targets out of wrapper URLs. */
export function createDirectTabUrl(
  runtimeOrigin: string,
  target: string,
  ticket?: string,
  youtubeAdblock = true,
): string {
  const runtime = new URL(runtimeOrigin);
  const destination = new URL(target);
  if (
    !["https:", "http:"].includes(runtime.protocol) ||
    runtime.username ||
    runtime.password ||
    runtime.pathname !== "/" ||
    runtime.search ||
    runtime.hash
  )
    throw Error("Use a browsing node origin.");
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
  const result = new URL(runtime.origin + "/");
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
