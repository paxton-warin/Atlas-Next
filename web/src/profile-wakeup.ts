/** A type-only hint. Every save/ownership decision still reads authenticated APIs. */
export function watchProfileWriters(
  wake: () => void,
  Source: typeof EventSource | undefined = globalThis.EventSource,
) {
  if (!Source) return { close() {}, closed: () => false };
  const stream = new Source("/api/hub/profile/events", { withCredentials: true });
  let live = true;
  const hint = (event: MessageEvent) => {
    if (!live || typeof event.data !== "string" || event.data.length > 128) return;
    try {
      const value = JSON.parse(event.data);
      if (value && Object.keys(value).length === 1 &&
          ["profile.writers.changed", "profile.writers.resync"].includes(value.type)) wake();
    } catch { /* Malformed hints do not change ownership or saves. */ }
  };
  stream.addEventListener("profile", hint as EventListener);
  const authorization = () => {
    if (!live) return;
    stream.close();
    wake(); // Authenticate again through the normal APIs; never trust this as revocation.
  };
  stream.addEventListener("authorization", authorization);
  return {
    closed: () => stream.readyState === Source.CLOSED,
    close() {
      live = false;
      stream.removeEventListener("profile", hint as EventListener);
      stream.removeEventListener("authorization", authorization);
      stream.close();
    },
  };
}
