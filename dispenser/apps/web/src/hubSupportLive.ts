/** SSE only invalidates authorized durable reads. Polling remains the recovery
 * path when a proxy, suspended tab or reconnect loses an invalidation. */
export function subscribeSupportLive(changed: () => void) {
  if (typeof EventSource === "undefined") return () => {};
  let stream: EventSource;
  const update = () => changed();
  const connect = () => {
    stream?.close();
    const current = new EventSource("/api/hub/events", {
      withCredentials: true,
    });
    stream = current;
    current.addEventListener("ready", update);
    current.addEventListener("support", update);
    current.addEventListener("error", update);
    current.addEventListener("authorization", () => {
      current.close();
      changed();
    });
  };
  connect();
  // Some browser network emulation/proxies retain a half-open stream through
  // an offline interval. Always reauthorize a fresh stream on return online.
  if (typeof addEventListener === "function")
    addEventListener("online", connect);
  return () => {
    if (typeof removeEventListener === "function")
      removeEventListener("online", connect);
    stream.close();
  };
}
