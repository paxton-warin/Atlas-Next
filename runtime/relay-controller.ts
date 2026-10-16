// The fork bootstrap fixes the relay to location.host. For a Main assignment,
// reuse its pinned assets/API with an explicit transport URL; the iframe remains
// on the paired node origin and never shares Atlas's privileged frontend origin.
export async function createRelayController(
  sw: ServiceWorker,
  relayOrigin: string,
  relayTicket: string,
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
  const load = (src: string) =>
    new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(Error("Browsing asset failed to load."));
      };
      document.head.appendChild(script);
    });
  for (const src of [
    "/runtime/runtimekit.js",
    "/controller/controller.api.js",
    "/runtime/runtimekit-utils.js",
    "/clients/httpengine-client.js",
  ])
    await load(src);
  const relay = new URL(
    "/relay/" + encodeURIComponent(relayTicket) + "/",
    origin,
  );
  relay.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const transport = new globals.HttpEngineTransport.HttpEngineClient({
    relay: relay.href,
  });
  const { Controller, config } = globals.$runtimekitController;
  config.injectPath = "/controller/controller.inject.js";
  config.wasmPath = "/runtime/runtimekit.wasm";
  config.runtimekitPath = "/runtime/runtimekit.js";
  return new Controller({ serviceworker: sw, transport });
}

// Rotate only credentials for the already assigned relay. The existing client
// exposes no mutable socket factory; initialize its replacement so future HTTP
// and WebSocket connections use the new bearer, then swap managed transports.
// Existing sockets are not closed and the browsing frame is not navigated.
export async function refreshRelayCredentials(
  controller: any,
  relayOrigin: string,
  relayTicket: string,
) {
  const origin = new URL(relayOrigin);
  // The committed vendor artifact calls this replaceConnector; upstream
  // TypeScript calls it setTransport. Qualify the shipped artifact, not only
  // the source checkout, and preserve both pinned API spellings.
  const replace = controller?.replaceConnector ?? controller?.setTransport;
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
    typeof replace !== "function"
  )
    throw Error("Invalid relay credential update.");
  const relay = new URL(
    "/relay/" + encodeURIComponent(relayTicket) + "/",
    origin,
  );
  relay.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const transport = new (window as any).HttpEngineTransport.HttpEngineClient({
    relay: relay.href,
  });
  await transport.init();
  replace.call(controller, transport);
}
