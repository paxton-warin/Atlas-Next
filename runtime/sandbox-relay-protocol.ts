/** Trusted controller <-> trusted dedicated relay worker. Never grant this port
 * or assignment credentials to a website document. */
export const SANDBOX_RELAY_PROTOCOL = "atlas-relay-worker-v1";
export type SandboxRelayAssignment = Readonly<{
  origin: string;
  ticket: string;
  generation: number;
  sessionHash: string;
}>;
export type SandboxRelayRawResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
};
export function sandboxRelayURL(
  assignment: SandboxRelayAssignment,
  secure: boolean,
) {
  const origin = new URL(assignment.origin);
  if (
    !/^https?:$/.test(origin.protocol) ||
    (secure && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    typeof assignment.ticket !== "string" ||
    !/^[A-Za-z0-9_.-]{1,32768}$/.test(assignment.ticket) ||
    !/^[a-f0-9]{64}$/.test(assignment.sessionHash) ||
    !Number.isSafeInteger(assignment.generation) ||
    assignment.generation < 1
  )
    throw new TypeError("Invalid assigned relay.");
  const url = new URL(
    "/relay/" + encodeURIComponent(assignment.ticket) + "/",
    origin,
  );
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Both trusted worker and owner enforce these independent website WS bounds. */
export const SANDBOX_RELAY_SOCKET_LIMITS = Object.freeze({
  sockets: 16,
  messageBytes: 1024 * 1024,
  queuedBytes: 4 * 1024 * 1024,
  incomingMessages: 64,
});
export function validRelaySocketRequest(
  url: unknown,
  protocols: unknown,
  headers: unknown,
) {
  if (
    typeof url !== "string" ||
    url.length > 16384 ||
    !Array.isArray(protocols) ||
    protocols.length > 64 ||
    new Set(protocols).size !== protocols.length ||
    protocols.some(
      (p) =>
        typeof p !== "string" ||
        p.length > 256 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p),
    ) ||
    !Array.isArray(headers) ||
    headers.length > 3
  )
    return false;
  try {
    const target = new URL(url);
    if (
      !/^wss?:$/.test(target.protocol) ||
      target.username ||
      target.password ||
      target.href.includes("#")
    )
      return false;
    const names = new Set<string>();
    let bytes = 0;
    for (const pair of headers) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((v) => typeof v !== "string") ||
        !/^(origin|cookie|user-agent)$/i.test(pair[0]) ||
        /[\0\r\n]/.test(pair[1]) ||
        names.has(pair[0].toLowerCase())
      )
        return false;
      names.add(pair[0].toLowerCase());
      bytes += pair[0].length + pair[1].length;
      if (bytes > 65536) return false;
      if (pair[0].toLowerCase() === "origin") {
        const origin = new URL(pair[1]);
        if (!/^https?:$/.test(origin.protocol) || origin.origin !== pair[1])
          return false;
      }
    }
    return names.has("origin");
  } catch {
    return false;
  }
}
