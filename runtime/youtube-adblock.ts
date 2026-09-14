import { installYouTubePlayerAdHandling } from "./youtube-player.ts";
// Independent, deliberately narrow YouTube filtering. Known player ad fields
// are documented in the maintained uAssets rules, not copied scriptlets:
// https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters.txt
// Stream hosts also carry the actual video; never blanket-block googlevideo.com.
// Player-side ad completion is separately gated to explicit ad state.
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_ENVELOPES = 1024;
const READ_TIMEOUT_MS = 5000;
const AD_FIELDS = ["playerAds", "adPlacements", "adSlots"] as const;
const documents = new WeakSet<Document>();

function parsedUrl(value: unknown): URL | undefined {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith("." + domain);
}
export function isYouTubeUrl(value: unknown): boolean {
  const url = parsedUrl(value);
  return (
    !!url &&
    (hostMatches(url.hostname, "youtube.com") ||
      hostMatches(url.hostname, "youtube-nocookie.com"))
  );
}
export function shouldBlockYouTubeRequest(
  pageUrl: unknown,
  targetUrl: unknown,
): boolean {
  if (!isYouTubeUrl(pageUrl)) return false;
  const target = parsedUrl(targetUrl);
  if (!target) return false;
  if (
    hostMatches(target.hostname, "doubleclick.net") ||
    hostMatches(target.hostname, "googlesyndication.com")
  )
    return true;
  // Do not match Google login, normal search, /videoplayback, thumbnails or the
  // player API. These are ad-only URL namespaces, scoped to a YouTube initiator.
  const pageAdHost =
    isYouTubeUrl(target.href) ||
    ["google.com", "www.google.com", "googleads.g.doubleclick.net"].includes(
      target.hostname,
    );
  return (
    (pageAdHost && target.pathname.startsWith("/pagead/")) ||
    (isYouTubeUrl(target.href) && target.pathname === "/api/stats/ads")
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function dataProperty(value: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor : undefined;
}

// Only a response root and its direct playerResponse envelope are inspected.
// Watch responses can also be arrays of envelopes; unrelated nested data stays
// untouched. Maintained examples: uAssets/filters/quick-fixes.txt (player,
// get_watch, watch and playlist). This is independent copy-on-change code.
function prunePlayerObject<T>(value: T, includeRoot: boolean): T {
  if (!record(value)) return value;
  let output: Record<string, unknown> | undefined;
  const writableCopy = () =>
    (output ??= Object.create(
      Object.getPrototypeOf(value),
      Object.getOwnPropertyDescriptors(value),
    ));
  if (includeRoot) {
    for (const key of AD_FIELDS) {
      const descriptor = dataProperty(value, key);
      if (descriptor?.configurable && Array.isArray(descriptor.value)) {
        delete writableCopy()[key];
      }
    }
  }
  const nested = dataProperty(value, "playerResponse");
  if (nested?.configurable && record(nested.value)) {
    // Deliberately one nested envelope; cyclic/unrelated trees stay untouched.
    let player: Record<string, unknown> | undefined;
    for (const key of AD_FIELDS) {
      const descriptor = dataProperty(nested.value, key);
      if (descriptor?.configurable && Array.isArray(descriptor.value)) {
        player ??= Object.create(
          Object.getPrototypeOf(nested.value),
          Object.getOwnPropertyDescriptors(nested.value),
        );
        delete player![key];
      }
    }
    if (player)
      Object.defineProperty(writableCopy(), "playerResponse", {
        ...nested,
        value: player,
      });
  }
  return (output ?? value) as T;
}

export function pruneYouTubePayload<T>(value: T): T {
  if (!Array.isArray(value)) return prunePlayerObject(value, true);
  if (value.length > MAX_RESPONSE_ENVELOPES) return value;
  let output: unknown[] | undefined;
  for (let index = 0; index < value.length; index++) {
    const descriptor = dataProperty(value, String(index));
    if (!descriptor?.configurable) continue;
    // Do not interpret arbitrary objects inside arrays as player responses.
    const filtered = prunePlayerObject(descriptor.value, false);
    if (filtered === descriptor.value) continue;
    output ??= Object.defineProperties(
      [],
      Object.getOwnPropertyDescriptors(value) as PropertyDescriptorMap,
    );
    Object.defineProperty(output!, index, { ...descriptor, value: filtered });
  }
  return (output ?? value) as T;
}

function installDocument(
  win: Window & typeof globalThis,
  pageUrl: () => string,
  enabled: () => boolean,
) {
  if (!enabled() || !isYouTubeUrl(pageUrl()) || documents.has(win.document))
    return;
  const doc = win.document;
  documents.add(doc);
  const active = () => enabled() && isYouTubeUrl(pageUrl());
  const guardedPlayers = new WeakSet<object>();
  const guardedEnvelopes = new WeakSet<object>();
  // Keep the actual object, rather than cloning at window assignment: YouTube
  // can retain that object and fill its ad arrays afterwards. Configurable
  // accessors suppress only array-valued ad fields while the setting is on;
  // opt-out reveals the latest underlying site value. Never replace site-owned
  // accessors or immutable data, and never change streams or playability fields.
  const watchProperty = (
    target: object,
    key: string,
    prepare?: (value: unknown) => void,
    adField = false,
  ) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (
        descriptor &&
        (!descriptor.configurable ||
          !("value" in descriptor) ||
          !descriptor.writable)
      )
        return;
      let current = descriptor?.value;
      let enumerable = descriptor?.enumerable ?? false;
      if (active()) prepare?.(current);
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable,
        get: () => {
          if (active()) {
            prepare?.(current);
            if (adField && Array.isArray(current)) return undefined;
          }
          return current;
        },
        set: (value) => {
          current = value;
          try {
            // An absent property becomes enumerable on its first assignment,
            // matching ordinary data-property behavior when filtering is off.
            if (!descriptor && !enumerable) {
              Object.defineProperty(target, key, { enumerable: true });
              enumerable = true;
            }
            if (active()) prepare?.(value);
          } catch {
            /* Preserve the site's assigned value if its object rejects hooks. */
          }
        },
      });
    } catch {
      /* Leave the original site property alone on unusual documents. */
    }
  };
  const guardPlayer = (value: unknown) => {
    if (!record(value) || guardedPlayers.has(value)) return;
    guardedPlayers.add(value);
    for (const key of AD_FIELDS) watchProperty(value, key, undefined, true);
  };
  const guardEnvelope = (value: unknown) => {
    if (!record(value) || guardedEnvelopes.has(value)) return;
    guardedEnvelopes.add(value);
    guardPlayer(value);
    watchProperty(value, "playerResponse", guardPlayer);
  };
  for (const key of ["ytInitialPlayerResponse", "playerResponse"]) {
    watchProperty(win, key, guardPlayer);
  }
  watchProperty(win, "ytInitialData", guardEnvelope);
  const addStyle = () => {
    if (!enabled() || !isYouTubeUrl(pageUrl())) return;
    const parent = doc.head || doc.documentElement;
    if (!parent || doc.getElementById("atlas-youtube-adblock")) return;
    const style = doc.createElement("style");
    style.id = "atlas-youtube-adblock";
    // CSS also covers cards created during SPA navigation, without observers,
    // broad sponsored-text matching or touching actual player/video controls.
    style.textContent =
      [
        "ytd-display-ad-renderer",
        "ytd-promoted-sparkles-web-renderer",
        "ytd-promoted-video-renderer",
        "ytd-ad-slot-renderer",
        "ytd-in-feed-ad-layout-renderer",
        "ytm-promoted-sparkles-web-renderer",
      ].join(",") + "{display:none!important}";
    parent.appendChild(style);
  };
  addStyle();
  if (!doc.documentElement)
    doc.addEventListener("DOMContentLoaded", addStyle, { once: true });
}

function jsonEndpoint(value: unknown) {
  const url = parsedUrl(value);
  return (
    !!url &&
    isYouTubeUrl(url.href) &&
    (/^\/youtubei\/v1\/(?:player|next|browse|get_watch)\/?$/.test(
      url.pathname,
    ) ||
      /^\/(?:watch|playlist)\/?$/.test(url.pathname))
  );
}
function cancel(stream: ReadableStream) {
  // A tee branch's cancellation waits for its sibling. Awaiting this would
  // deadlock before the preserved original branch reaches the browser.
  try {
    void stream.cancel().catch(() => {});
  } catch {
    /* Already consumed. */
  }
}
async function boundedText(body: unknown): Promise<string | undefined> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength <= MAX_JSON_BYTES
      ? body
      : undefined;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength <= MAX_JSON_BYTES
      ? new TextDecoder("utf-8", { fatal: true }).decode(body)
      : undefined;
  }
  if (body instanceof Blob)
    return body.size <= MAX_JSON_BYTES
      ? new TextDecoder("utf-8", { fatal: true }).decode(
          await body.arrayBuffer(),
        )
      : undefined;
  if (!(body instanceof ReadableStream)) return undefined;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Error("YouTube JSON read timed out")),
      READ_TIMEOUT_MS,
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (!ArrayBuffer.isView(value)) return undefined;
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      length += bytes.byteLength;
      if (length > MAX_JSON_BYTES) return undefined;
      parts.push(bytes);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    // No await: the retained tee branch is deliberately not consumed yet.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createYouTubeAdblockPlugin(
  globals: any,
  enabled: () => boolean,
) {
  const { ManagedPlugin } = globals.$runtimekitController;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-youtube-adblock", []);
    }
    install(frame: any) {
      super.install(frame);
      let topPageUrl = () => "";
      this.tap(
        frame.hooks.init.post,
        ({ window: win, client, isTopLevel }: any) => {
          if (isTopLevel) topPageUrl = () => client.url.href;
          try {
            installDocument(win, () => client.url.href, enabled);
            if (typeof win.MutationObserver === "function")
              installYouTubePlayerAdHandling(
                win,
                () => client.url.href,
                enabled,
              );
          } catch {
            /* Filtering never prevents the engine from initializing. */
          }
        },
      );
      this.tap(frame.hooks.fetch.intercept, ({ parsed }: any, props: any) => {
        if (!enabled() || parsed.destination === "document" || props.response)
          return;
        if (
          !shouldBlockYouTubeRequest(
            parsed.clientUrl || topPageUrl(),
            parsed.url,
          )
        )
          return;
        props.response = {
          body: null,
          status: 204,
          statusText: "No Content",
          headers: globals.$runtimekit.RuntimeKitHeaders.fromRawHeaders([
            ["Cache-Control", "no-store"],
          ]),
        };
      });
      this.tap(
        frame.hooks.fetch.response,
        async ({ parsed }: any, props: any) => {
          const response = props.response;
          if (
            !enabled() ||
            !jsonEndpoint(parsed.url) ||
            response.status !== 200 ||
            !/^\s*application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") || "",
            )
          )
            return;
          const size = Number(response.headers.get("content-length"));
          if (Number.isFinite(size) && size > MAX_JSON_BYTES) return;
          let inspect = response.body;
          let original: ReadableStream | undefined;
          try {
            if (inspect instanceof ReadableStream) {
              [original, inspect] = inspect.tee();
              response.body = original;
            }
            const text = await boundedText(inspect);
            if (text === undefined || !enabled()) return;
            const payload = JSON.parse(text);
            const filtered = pruneYouTubePayload(payload);
            if (filtered === payload) return;
            const output = JSON.stringify(filtered);
            response.body = output;
            for (const key of [
              "content-length",
              "content-encoding",
              "etag",
              "content-md5",
            ])
              response.headers.delete(key);
            if (original) cancel(original);
          } catch {
            /* Preserve the original bytes on malformed/unfamiliar data. */
          }
        },
      );
    }
  })();
}
