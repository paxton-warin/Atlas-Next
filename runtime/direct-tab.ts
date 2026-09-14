/** Keep the existing assignment ticket and target out of HTTP URLs/referrers. */
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
    destination.origin === runtime.origin
  )
    throw Error("Use an external web URL.");
  if (
    ticket !== undefined &&
    (typeof ticket !== "string" || !ticket || ticket.length > 32768)
  )
    throw Error("Use a valid browsing ticket.");
  const fragment = new URLSearchParams({ goto: destination.href });
  if (ticket) fragment.set("ticket", ticket);
  if (!youtubeAdblock) fragment.set("adblock", "0");
  const result = new URL(runtime.origin + "/");
  result.hash = fragment.toString();
  return result.href;
}
