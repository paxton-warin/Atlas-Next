// The fork bootstrap fixes the relay to location.host. Use its qualified
// assets/API with an explicit assigned-node transport URL so frontend-hosted
// browsing frames can send traffic directly through their selected node.
export async function createRelayController(
  sw: ServiceWorker,
  relayOrigin: string,
  relayTicket: string,
  beforeConstruct?: (globals: any) => void,
  signal?: AbortSignal,
) {
  const globals = window as any;
  const origin = new URL(relayOrigin);
  if (
    !["https:", ...(location.protocol === "http:" ? ["http:"] : [])].includes(
      origin.protocol,
    ) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !relayTicket
  )
    throw Error("Invalid assigned relay.");
  signal?.throwIfAborted();
  const load = (src: string) =>
    new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        script.onload = null;
        script.onerror = null;
        script.remove();
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () => finish(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      script.src = src;
      script.onload = () => finish();
      script.onerror = () => finish(Error("Browsing asset failed to load."));
      document.head.appendChild(script);
    });
  for (const src of [
    "/runtime/runtimekit-normal.js",
    "/controller/controller.api.js",
    "/runtime/runtimekit-utils.js",
    "/clients/httpengine-client.js",
  ])
    await load(src);
  signal?.throwIfAborted();
  const relay = new URL(
    "/relay/" + encodeURIComponent(relayTicket) + "/",
    origin,
  );
  relay.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const transport = new globals.HttpEngineTransport.HttpEngineClient({
    relay: relay.href,
  });
  const { Controller, config } = globals.$runtimekitController;
  beforeConstruct?.(globals);
  signal?.throwIfAborted();
  config.injectPath = "/controller/controller.inject.js";
  config.wasmPath = "/runtime/runtimekit.wasm";
  config.runtimekitPath = "/runtime/runtimekit-normal.js";
  return new Controller({ serviceworker: sw, transport });
}

// Rotate only future upgrade credentials on the already assigned client. The
// qualified transport preserves its native HTTP pool and established renewable
// relay socket instead of leaking a new pool/socket for every five-minute renew.
export async function refreshRelayCredentials(
  controller: any,
  relayOrigin: string,
  relayTicket: string,
) {
  const origin = new URL(relayOrigin);
  const transport = controller?.transport;
  if (
    !/^https?:$/.test(origin.protocol) ||
    (location.protocol === "https:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !relayTicket ||
    relayTicket.length > 32768 ||
    typeof transport?.updateRelay !== "function"
  )
    throw Error("Invalid relay credential update.");
  const relay = new URL(
    "/relay/" + encodeURIComponent(relayTicket) + "/",
    origin,
  );
  relay.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  transport.updateRelay(relay.href);
}
