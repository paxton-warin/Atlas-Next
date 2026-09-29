// The pinned core currently adds Origin to ordinary document GETs. Native
// navigation does not: https://fetch.spec.whatwg.org/#append-a-request-origin-header
// Correct only that narrow case; POST, CORS fetches and WebSocket handshakes
// retain their origin/cookie/referrer semantics.
export function normalizeNavigationHeaders(
  context: {
    request: { method: string };
    parsed: { destination: string; fetchMode?: string };
  },
  init: { headers?: [string, string][] },
) {
  if (
    !["GET", "HEAD"].includes(context.request.method) ||
    !["document", "iframe", "frame"].includes(context.parsed.destination) ||
    (context.parsed.fetchMode !== undefined &&
      context.parsed.fetchMode !== "navigate") ||
    !Array.isArray(init.headers)
  )
    return;
  init.headers = init.headers.filter(
    ([name]) => name.toLowerCase() !== "origin",
  );
}

export function createRequestHeadersPlugin(globals: any) {
  const { ManagedPlugin } = globals.$runtimekitController;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-navigation-headers", []);
    }
    install(frame: any) {
      super.install(frame);
      this.tap(
        frame.fetchHandler.hooks.fetch.request,
        (context: any, props: any) => {
          if (props.init) normalizeNavigationHeaders(context, props.init);
        },
      );
    }
  })();
}
