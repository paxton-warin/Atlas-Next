// The pinned helper buffers dynamic responses before cookie processing and rebuilds
// them through Response, whose browser header guard removes Set-Cookie. Cache only
// small, explicitly public static assets here; never replace a network response.
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font"]);
const MAX_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_BYTES;
const MAX_ENTRIES = 64;
const MAX_COPIES = 8;
const READ_TIMEOUT = 2000;
type Entry = {
  bytes: Uint8Array;
  headers: [string, string][];
  expires: number;
  storedAt: number;
  age: number;
};
type CacheState = {
  entries: Map<string, Entry>;
  bytes: number;
  copying: Set<string>;
};
// One controller/page, shared by its frames, never by users or browser profiles.
const states = new WeakMap<object, CacheState>();
function headersOf(value: Iterable<readonly [string, string]> = []) {
  return new Headers(
    Array.from(value, ([name, value]) => [name, value] as [string, string]),
  );
}
function requestKey(context: any, props: any): string | undefined {
  if (
    context.request.method !== "GET" ||
    !STATIC_DESTINATIONS.has(context.parsed.destination) ||
    ["no-store", "no-cache", "reload"].includes(context.request.cache) ||
    props.earlyResponse
  )
    return;
  const headers = headersOf(props.init?.headers);
  if (
    ["cookie", "authorization", "range"].some((name) => headers.has(name)) ||
    /(?:no-cache|no-store)/i.test(headers.get("cache-control") || "") ||
    /no-cache/i.test(headers.get("pragma") || "")
  )
    return;
  const url = new URL(context.parsed.url.href);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
  return url.href;
}
function lifetime(response: any, now: number) {
  if (response.status !== 200) return;
  const raw = response.rawHeaders as [string, string][];
  // Check RAW fields: browser Response headers deliberately conceal Set-Cookie.
  if (
    !Array.isArray(raw) ||
    raw.some(([key]) => key.toLowerCase() === "set-cookie")
  )
    return;
  const headers = headersOf(raw);
  const control = headers.get("cache-control") || "";
  if (
    !/(?:^|,)\s*public\s*(?:,|$)/i.test(control) ||
    /(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(control) ||
    headers.has("vary") ||
    headers.has("content-range") ||
    /no-cache/i.test(headers.get("pragma") || "") ||
    /attachment/i.test(headers.get("content-disposition") || "") ||
    /(?:text\/html|application\/(?:json|x-ndjson)|text\/event-stream|^(?:audio|video)\/)/i.test(
      headers.get("content-type") || "",
    )
  )
    return;
  const maxAge = control.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i);
  if (!maxAge) return;
  const seconds = Number(maxAge[1]);
  const age = Math.max(0, Number(headers.get("age") || 0));
  const date = Date.parse(headers.get("date") || "");
  const apparentAge = Number.isFinite(date)
    ? Math.max(0, (now - date) / 1000)
    : 0;
  const currentAge = Math.max(age, apparentAge);
  const length = Number(headers.get("content-length") || 0);
  if (
    !Number.isFinite(seconds) ||
    !Number.isFinite(currentAge) ||
    length > MAX_BYTES ||
    seconds <= currentAge
  )
    return;
  return {
    expires: now + Math.min(seconds - currentAge, 86400) * 1000,
    age: currentAge,
  };
}
async function boundedCopy(
  response: Response,
): Promise<Uint8Array | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      void reader.cancel().catch(() => {});
      resolve(undefined);
    }, READ_TIMEOUT);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        while (!expired) {
          const { done, value } = await reader.read();
          if (done) {
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return bytes;
          }
          size += value.byteLength;
          if (size > MAX_BYTES) {
            void reader.cancel().catch(() => {});
            return;
          }
          chunks.push(value);
        }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function createHttpCachePlugin(globals: any) {
  const { ManagedPlugin } = globals.$runtimekitController;
  const { ChannelResponse } = globals.$runtimekit;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-static-cache", []);
    }
    install(frame: any) {
      super.install(frame);
      const owner = frame.controller || frame;
      let state = states.get(owner);
      if (!state) {
        state = { entries: new Map(), bytes: 0, copying: new Set() };
        states.set(owner, state);
      }
      const cache = state;
      const eligible = new WeakMap<object, string>();
      const hooks = frame.fetchHandler.hooks.fetch;
      const remove = (key: string) => {
        const old = cache.entries.get(key);
        if (old) cache.bytes -= old.bytes.byteLength;
        cache.entries.delete(key);
      };
      this.tap(hooks.request, (context: any, props: any) => {
        const key = requestKey(context, props);
        if (!key) return;
        eligible.set(context.request, key);
        const entry = cache.entries.get(key);
        if (!entry) return;
        if (Date.now() >= entry.expires) {
          remove(key);
          return;
        }
        eligible.delete(context.request);
        cache.entries.delete(key);
        cache.entries.set(key, entry);
        const headers = entry.headers.filter(
          ([name]) => name.toLowerCase() !== "age",
        );
        headers.push([
          "Age",
          String(Math.floor(entry.age + (Date.now() - entry.storedAt) / 1000)),
        ]);
        props.earlyResponse = ChannelResponse.fromNativeResponse(
          new Response(entry.bytes.slice(), { status: 200, headers }),
        );
      });
      this.tap(hooks.preresponse, (context: any, props: any) => {
        const key = eligible.get(context.request);
        eligible.delete(context.request);
        if (!key) return;
        const now = Date.now();
        const fresh = lifetime(props.response, now);
        if (!fresh) return;
        // A large page can request hundreds of assets together. Bound the
        // background readers too, not just the completed cache entries.
        if (cache.copying.size >= MAX_COPIES || cache.copying.has(key)) return;
        cache.copying.add(key);
        const original = props.response;
        // Background, bounded copy. The original body/header object reaches the
        // rewriter immediately, including live streams and authentication cookies.
        void boundedCopy(original)
          .then((bytes) => {
            if (!bytes || Date.now() >= fresh.expires) return;
            remove(key);
            while (
              cache.entries.size >= MAX_ENTRIES ||
              cache.bytes + bytes.byteLength > MAX_TOTAL_BYTES
            ) {
              const oldest = cache.entries.keys().next().value;
              if (oldest === undefined) break;
              remove(oldest);
            }
            cache.entries.set(key, {
              bytes,
              headers: original.rawHeaders.map(
                ([key, value]: [string, string]) => [key, value],
              ),
              storedAt: now,
              ...fresh,
            });
            cache.bytes += bytes.byteLength;
          })
          .catch(() => {})
          .finally(() => cache.copying.delete(key));
      });
    }
  })();
}
