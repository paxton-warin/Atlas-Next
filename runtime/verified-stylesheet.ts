// Discord's HTTP Link preload retains its SRI digest while RuntimeKit rewrites
// the stylesheet body. Authenticate publisher bytes before transforming them,
// then bind the preload to the exact transformed bytes served by this frame.
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT = 8000;
const SITE = "https://discord.com/";
const ASSET =
  /^https:\/\/cdn\.prod\.website-files\.com\/6257adef93867e50d84d30e2\/css\/discord-2022\.shared\.[a-z0-9]+\.min\.css$/;

export function splitLinkHeader(header: string): string[] {
  const parts: string[] = [];
  let quoted = false,
    angle = false,
    escaped = false,
    start = 0;
  for (let index = 0; index < header.length; index++) {
    const char = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angle = true;
    if (!quoted && char === ">") angle = false;
    if (!quoted && !angle && char === ",") {
      parts.push(header.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(header.slice(start));
  return parts;
}

function base64(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export async function authenticateStylesheet(
  bytes: Uint8Array,
  integrity: string,
) {
  const algorithms = {
    sha256: "SHA-256",
    sha384: "SHA-384",
    sha512: "SHA-512",
  } as const;
  const tokens = integrity
    .trim()
    .split(/\s+/)
    .map((token) =>
      token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?\S*)?$/),
    )
    .filter((token) => token !== null);
  const strongest = ["sha512", "sha384", "sha256"].find((algorithm) =>
    tokens.some((token) => token[1] === algorithm),
  ) as keyof typeof algorithms | undefined;
  if (!strongest) throw Error("stylesheet_integrity_unsupported");
  const digest = base64(
    await crypto.subtle.digest(
      algorithms[strongest],
      new Uint8Array(bytes).buffer,
    ),
  );
  if (
    !tokens.some(
      (token) =>
        token[1] === strongest &&
        token[2].replace(/=+$/, "") === digest.replace(/=+$/, ""),
    )
  )
    throw Error("stylesheet_integrity_mismatch");
  return { algorithm: strongest, digest: `${strongest}-${digest}` };
}

async function transformedIntegrity(
  text: string,
  algorithm: "sha256" | "sha384" | "sha512",
) {
  const name = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[
    algorithm
  ];
  return `${algorithm}-${base64(await crypto.subtle.digest(name, new TextEncoder().encode(text)))}`;
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("stylesheet_integrity_timeout")),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBytes(response: any): Promise<Uint8Array> {
  if (
    response.status !== 200 ||
    !/^text\/css(?:\s*;|$)/i.test(response.headers.get("content-type") || "") ||
    response.headers.get("access-control-allow-origin") !== "*"
  )
    throw Error("stylesheet_integrity_response_rejected");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES)
    throw Error("stylesheet_integrity_too_large");
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await within(response.arrayBuffer()));
    if (bytes.length > MAX_BYTES) throw Error("stylesheet_integrity_too_large");
    return bytes;
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    await within(
      (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const bytes = new Uint8Array(value);
          size += bytes.length;
          if (size > MAX_BYTES) throw Error("stylesheet_integrity_too_large");
          chunks.push(bytes);
        }
      })(),
    );
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

type Entry = {
  state: "pending" | "verified" | "blocked";
  body?: string;
  integrity?: string;
};

export function createVerifiedStylesheetPlugin(globals: any) {
  const { ManagedPlugin } = globals.$runtimekitController;
  const { RuntimeKitHeaders, transformCss, restoreurl } = globals.$runtimekit;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-verified-stylesheet", []);
    }
    install(frame: any) {
      super.install(frame);
      const entries = new Map<string, Entry>();
      this.tap(frame.hooks.fetch.intercept, ({ parsed }: any, props: any) => {
        const entry = entries.get(parsed.url.href);
        if (!entry || parsed.destination !== "style") return;
        props.response = {
          body:
            entry.state === "verified"
              ? entry.body
              : "Stylesheet integrity verification failed.",
          status: entry.state === "verified" ? 200 : 502,
          statusText: entry.state === "verified" ? "OK" : "Bad Gateway",
          headers: RuntimeKitHeaders.fromRawHeaders([
            [
              "Content-Type",
              entry.state === "verified"
                ? "text/css; charset=utf-8"
                : "text/plain; charset=utf-8",
            ],
            ["Cache-Control", "no-store"],
            ["Access-Control-Allow-Origin", "*"],
          ]),
        };
      });
      this.tap(
        frame.hooks.fetch.response,
        async ({ parsed, request }: any, props: any) => {
          if (
            request.method !== "GET" ||
            !["document", "iframe"].includes(parsed.destination) ||
            parsed.url.href !== SITE ||
            props.response.status !== 200
          )
            return;
          const header = props.response.headers.get("link");
          if (!header) return;
          const parts = splitLinkHeader(header);
          for (let index = 0; index < parts.length; index++) {
            const part = parts[index],
              resource = part.match(/^\s*<([^>]+)>/),
              integrity = part.match(/;\s*integrity\s*=\s*"([^"]+)"/i);
            if (
              !resource ||
              !integrity ||
              !/;\s*as\s*=\s*"?style"?(?:;|\s|$)/i.test(part) ||
              !/;\s*rel\s*=\s*"?preload"?(?:;|\s|$)/i.test(part)
            )
              continue;
            let original: string;
            try {
              original = String(
                restoreurl(resource[1], frame.fetchHandler.context),
              );
            } catch {
              continue;
            }
            if (!ASSET.test(original)) continue;
            const entry: Entry = { state: "pending" };
            entries.clear();
            entries.set(original, entry);
            try {
              const response = await within(
                frame.fetchHandler.client.fetch(new URL(original), {
                  method: "GET",
                  headers: [
                    ["Accept", "text/css,*/*;q=0.1"],
                    ["Origin", "https://discord.com"],
                  ],
                  redirect: "manual",
                }),
              );
              const bytes = await readBytes(response);
              const verified = await authenticateStylesheet(
                bytes,
                integrity[1],
              );
              const url = new URL(original);
              const body = String(
                transformCss(
                  new TextDecoder().decode(bytes),
                  frame.fetchHandler.context,
                  { origin: url, base: url },
                ),
              );
              if (new TextEncoder().encode(body).length > MAX_BYTES)
                throw Error("stylesheet_integrity_too_large");
              const rewritten = await transformedIntegrity(
                body,
                verified.algorithm,
              );
              entry.body = body;
              entry.integrity = rewritten;
              entry.state = "verified";
              parts[index] = part.replace(
                integrity[0],
                integrity[0].replace(integrity[1], rewritten),
              );
            } catch {
              entry.state = "blocked";
            }
          }
          props.response.headers.set("link", parts.join(","));
        },
      );
    }
  })();
}
