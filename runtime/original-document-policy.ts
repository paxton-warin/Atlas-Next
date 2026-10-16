/** Trusted, bounded ORIGINAL logical-CSP decisions. These checks do not replace
 * physical sandbox CSP or confer trust on a child-selected request destination.
 * https://www.w3.org/TR/CSP3/#source-list-syntax
 */
export type OriginalPolicyKind =
  | "script"
  | "style"
  | "image"
  | "font"
  | "connect";
/** URL authorization is separate from runtime support. Parsing a valid media,
 * frame or worker directive grants no DOM/transport capability; unsupported
 * consumers continue to fail closed at their own sink. */
export type OriginalPolicyDestination =
  | OriginalPolicyKind
  | "worker"
  | "frame"
  | "media"
  | "manifest"
  | "object"
  | "base"
  | "form";
export type OriginalInlineReceipt = Readonly<{
  kind: "script" | "style";
  source: string;
  nonce?: string;
  hashes: Readonly<Record<string, string>>;
}>;
const digestNative = crypto.subtle?.digest.bind(crypto.subtle),
  encodeNative = TextEncoder.prototype.encode,
  encoder = new TextEncoder(),
  base64 = btoa.bind(globalThis),
  chars = String.fromCharCode;
const failure = (code: string, directive?: string) =>
  Object.assign(new Error(code), { name: "SecurityError", code, directive });
const nonce = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/i,
  hash = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})'$/i;
const normalized = (s: string) =>
  s.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
const relevant = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "worker-src",
  "child-src",
  "frame-src",
  "media-src",
  "manifest-src",
  "object-src",
  "base-uri",
  "form-action",
]);
const unsupported = new Set(["sandbox", "frame-ancestors", "webrtc"]);
const keywords = new Set([
  "'none'",
  "'self'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
  "'report-sample'",
]);
const schemeMatch = (a: string, b: string) =>
  a === b ||
  (a === "http:" && b === "https:") ||
  (a === "ws:" && ["wss:", "http:", "https:"].includes(b)) ||
  (a === "wss:" && b === "https:");
const port = (u: URL) =>
  u.port || (["https:", "wss:"].includes(u.protocol) ? "443" : "80");
function sourceMatches(source: string, url: URL, self: URL, redirects: number) {
  const lower = source.toLowerCase();
  if (lower === "*")
    return /^https?:$/.test(url.protocol) || url.protocol === self.protocol;
  if (lower === "'self'")
    return (
      url.origin === self.origin ||
      (url.hostname === self.hostname &&
        (port(self) === port(url) || (!self.port && !url.port)) &&
        (["https:", "wss:"].includes(url.protocol) ||
          (self.protocol === "http:" &&
            ["http:", "ws:"].includes(url.protocol))))
    );
  if (/^[A-Za-z][A-Za-z0-9+.-]*:$/.test(source))
    return schemeMatch(lower, url.protocol);
  const match = source.match(
    /^(?:(https?|wss?):\/\/)?(\[[a-fA-F0-9:]+\]|\*|(?:\*\.)?[a-zA-Z0-9.-]+)(?::(\*|\d+))?(\/[^?#]*)?$/,
  );
  if (!match) return false;
  const [, scheme, hostname, sourcePort, path] = match,
    host = hostname.toLowerCase();
  // CSP host-source matching does not grant arbitrary IP literals. The
  // historical loopback127.0.0.1 exception is retained; scheme sources/self
  // are separate algorithms. Never broaden a host wildcard to private IPs.
  if (
    (/^\[/.test(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname)) &&
    !(url.hostname === "127.0.0.1" && host === "127.0.0.1")
  )
    return false;
  if (
    !schemeMatch(
      scheme ? scheme.toLowerCase() + ":" : self.protocol,
      url.protocol,
    )
  )
    return false;
  if (
    host !== "*" &&
    !(host.startsWith("*.")
      ? url.hostname.endsWith(host.slice(1)) && url.hostname !== host.slice(2)
      : url.hostname === host)
  )
    return false;
  if (
    sourcePort !== "*" &&
    !(sourcePort
      ? sourcePort === port(url) ||
        (sourcePort === "80" &&
          ["https:", "wss:"].includes(url.protocol) &&
          port(url) === "443")
      : url.port === "")
  )
    return false;
  if (path && redirects === 0) {
    try {
      const expected = path.split("/").map(decodeURIComponent),
        actual = url.pathname.split("/").map(decodeURIComponent),
        prefix = path.endsWith("/");
      if (prefix) expected.pop();
      if (
        (!prefix && expected.length !== actual.length) ||
        expected.some((part, i) => part !== actual[i])
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
export function createOriginalDocumentPolicy(options: {
  documentURL: string;
  contentPolicies: readonly string[];
}) {
  const logical = new URL(options.documentURL);
  if (
    !/^https?:$/.test(logical.protocol) ||
    logical.username ||
    logical.password ||
    !Array.isArray(options.contentPolicies) ||
    options.contentPolicies.length > 32
  )
    throw failure("original_policy_invalid");
  const parsed: Map<string, string[]>[] = [];
  let bytes = 0;
  for (const value of options.contentPolicies) {
    if (
      typeof value !== "string" ||
      (bytes += value.length) > 65536 ||
      value.includes(",") ||
      /[^\x09\x0a\x0c\x0d\x20-\x7e]/.test(value)
    )
      throw failure("original_policy_invalid");
    const map = new Map<string, string[]>();
    for (const part of value.split(";")) {
      const [raw, ...sources] = part.trim().split(/[\t\n\f\r ]+/),
        name = raw.toLowerCase();
      if (!name || map.has(name)) continue;
      if (unsupported.has(name))
        throw failure("original_policy_unsupported_directive", name);
      if (
        (name === "require-trusted-types-for" &&
          sources.some((source) => source !== "'script'")) ||
        (name === "trusted-types" &&
          sources.some(
            (source) =>
              !["*", "'none'", "'allow-duplicates'"].includes(source) &&
              !/^[A-Za-z0-9#=_/@.%-]+$/.test(source),
          ))
      )
        throw failure("original_policy_unsupported_source", name);
      if (relevant.has(name))
        for (const source of sources) {
          const lower = source.toLowerCase();
          if (
            [
              "'strict-dynamic'",
              "'unsafe-hashes'",
              "'trusted-types-eval'",
              "'inline-speculation-rules'",
              "'unsafe-webtransport-hashes'",
            ].includes(lower)
          )
            throw failure("original_policy_unsupported_source", name);
          if (
            !keywords.has(lower) &&
            !nonce.test(source) &&
            !hash.test(source) &&
            source !== "*" &&
            !/^[A-Za-z][A-Za-z0-9+.-]*:$/.test(source) &&
            !/^(?:(?:https?|wss?):\/\/)?(?:\[[a-fA-F0-9:]+\]|\*|(?:\*\.)?[a-zA-Z0-9.-]+)(?::(?:\*|\d+))?(?:\/[^?#]*)?$/.test(
              source,
            )
          )
            throw failure("original_policy_unsupported_source", name);
        }
      map.set(name, sources);
    }
    parsed.push(map);
  }
  const upgrade = parsed.some((p) => p.has("upgrade-insecure-requests"));
  // Multiple enforced policies intersect. Emitting their directives repeatedly
  // in ONE meta would incorrectly use first-directive-wins, so compile their
  // policy-name/duplicate intersection before native Trusted Types activation.
  const ttLists = parsed
    .filter((p) => p.has("trusted-types"))
    .map((p) => p.get("trusted-types")!);
  let ttNames: string[] | null | undefined;
  for (const sources of ttLists) {
    const names = sources.filter(
      (s) => s !== "'none'" && s !== "'allow-duplicates'",
    );
    if (names.includes("*")) {
      if (ttNames === undefined) ttNames = null;
    } else {
      ttNames =
        ttNames == null
          ? [...new Set(names)]
          : ttNames.filter((s) => names.includes(s));
    }
  }
  const ttRequired = parsed.some((p) =>
    p.get("require-trusted-types-for")?.includes("'script'"),
  );
  const ttDuplicates =
    ttLists.length > 0 &&
    ttLists.every((s) => s.includes("'allow-duplicates'"));
  const ttCSP = [
    ...(ttRequired ? ["require-trusted-types-for 'script'"] : []),
    ...(ttNames !== undefined
      ? [
          "trusted-types " +
            (ttNames === null
              ? "*"
              : ttNames.length
                ? ttNames.join(" ")
                : "'none'") +
            (ttDuplicates ? " 'allow-duplicates'" : ""),
        ]
      : []),
  ].join("; ");
  function list(map: Map<string, string[]>, kind: OriginalPolicyDestination) {
    // CSP3's distinct fallback chains matter: script-src-elem never controls
    // workers, while navigation/base directives do not inherit default-src.
    if (kind === "base") return map.get("base-uri");
    if (kind === "form") return map.get("form-action");
    if (kind === "frame")
      return (
        map.get("frame-src") ?? map.get("child-src") ?? map.get("default-src")
      );
    if (kind === "worker")
      return (
        map.get("worker-src") ??
        map.get("child-src") ??
        map.get("script-src") ??
        map.get("default-src")
      );
    const name = kind === "image" ? "img-src" : kind + "-src";
    return (
      (kind === "script" || kind === "style"
        ? map.get(name + "-elem")
        : undefined) ??
      map.get(name) ??
      map.get("default-src")
    );
  }
  function checkedURL(value: string, localData = false) {
    const limit =
      localData && typeof value === "string" && /^data:/i.test(value)
        ? 8 * 1024 * 1024 * 4 + 65536
        : 16384;
    if (typeof value !== "string" || value.length > limit)
      throw failure("original_policy_invalid_url");
    const u = new URL(value, logical);
    if (upgrade) {
      if (u.protocol === "http:") u.protocol = "https:";
      if (u.protocol === "ws:") u.protocol = "wss:";
    }
    if (
      !/^https?:$|^wss?:$|^data:$/.test(u.protocol) ||
      u.username ||
      u.password ||
      (logical.protocol === "https:" && ["http:", "ws:"].includes(u.protocol))
    )
      throw failure("original_policy_destination_denied");
    return u;
  }
  const api = {
    documentURL: logical.href,
    trustedTypes: Object.freeze({ required: ttRequired, csp: ttCSP }),
    upgradeURL: (url: string) => checkedURL(url).href,
    checkURL(input: {
      url: string;
      kind: OriginalPolicyDestination;
      redirectCount?: number;
      nonce?: string;
      integrity?: string;
    }) {
      if (
        ![
          "script",
          "style",
          "image",
          "font",
          "connect",
          "worker",
          "frame",
          "media",
          "manifest",
          "object",
          "base",
          "form",
        ].includes(input.kind) ||
        !Number.isSafeInteger(input.redirectCount ?? 0) ||
        (input.redirectCount ?? 0) < 0 ||
        (input.redirectCount ?? 0) > 20
      )
        throw failure("original_policy_invalid_request");
      const url = checkedURL(
        input.url,
        input.kind === "image" || input.kind === "font",
      );
      if (url.protocol === "data:" && !["image", "font"].includes(input.kind))
        throw failure("original_policy_destination_denied");
      if (input.kind !== "connect" && !/^https?:$|^data:$/.test(url.protocol))
        throw failure("original_policy_destination_denied");
      for (const map of parsed) {
        const sources = list(map, input.kind);
        if (!sources) continue;
        if (
          (input.kind === "script" || input.kind === "style") &&
          input.nonce &&
          sources.some((s) => nonce.exec(s)?.[1] === input.nonce)
        )
          continue;
        if (
          !sources.some((s) =>
            sourceMatches(s, url, logical, input.redirectCount ?? 0),
          )
        ) {
          if (
            input.integrity &&
            (input.kind === "script" || input.kind === "style") &&
            sources.some((s) => hash.test(s))
          )
            throw failure(
              "original_policy_external_hash_unsupported",
              input.kind + "-src",
            );
          throw failure(
            "original_policy_denied",
            input.kind === "image"
              ? "img-src"
              : input.kind === "base"
                ? "base-uri"
                : input.kind === "form"
                  ? "form-action"
                  : input.kind + "-src",
          );
        }
      }
      return Object.freeze({ url: url.href, kind: input.kind });
    },
    async authorizeInline(input: {
      kind: "script" | "style";
      source: string;
      nonce?: string;
    }): Promise<OriginalInlineReceipt> {
      if (
        !["script", "style"].includes(input.kind) ||
        typeof input.source !== "string" ||
        input.source.length > 2 * 1024 * 1024 ||
        (typeof input.nonce !== "undefined" && typeof input.nonce !== "string")
      )
        throw failure("original_policy_invalid_inline");
      const data = encodeNative.call(encoder, input.source);
      if (data.length > 2 * 1024 * 1024)
        throw failure("original_policy_inline_limit");
      const hashes: Record<string, string> = {};
      for (const map of parsed) {
        const sources = list(map, input.kind);
        if (!sources) continue;
        if (
          input.nonce &&
          sources.some((s) => nonce.exec(s)?.[1] === input.nonce)
        )
          continue;
        const expressions = sources
          .map((s) => hash.exec(s))
          .filter(Boolean) as RegExpExecArray[];
        if (
          !sources.some((s) => nonce.test(s) || hash.test(s)) &&
          sources.some((s) => s.toLowerCase() === "'unsafe-inline'")
        )
          continue;
        let allowed = false;
        for (const expression of expressions) {
          if(!digestNative)throw failure("original_policy_inline_digest_unavailable",input.kind+"-src");
          const algorithm = expression[1].toLowerCase();
          hashes[algorithm] ??= base64(
            chars(
              ...new Uint8Array(
                await digestNative(
                  "SHA-" + algorithm.slice(3),
                  data as BufferSource,
                ),
              ),
            ),
          );
          if (normalized(hashes[algorithm]) === normalized(expression[2]))
            allowed = true;
        }
        if (!allowed)
          throw failure("original_policy_denied", input.kind + "-src");
      }
      return Object.freeze({ ...input, hashes: Object.freeze(hashes) });
    },
    checkEval(kind: "javascript" | "wasm") {
      if (!["javascript", "wasm"].includes(kind))
        throw failure("original_policy_invalid_eval");
      for (const map of parsed) {
        const sources = map.get("script-src") ?? map.get("default-src");
        if (
          sources &&
          !sources.some(
            (s) =>
              s.toLowerCase() === "'unsafe-eval'" ||
              (kind === "wasm" && s.toLowerCase() === "'wasm-unsafe-eval'"),
          )
        )
          throw failure("original_policy_eval_denied", "script-src");
      }
    },
    authorizeStyleAttribute(source: string) {
      if (typeof source !== "string" || source.length > 2 * 1024 * 1024)
        throw failure("original_policy_invalid_inline");
      for (const map of parsed) {
        const sources =
          map.get("style-src-attr") ??
          map.get("style-src") ??
          map.get("default-src");
        if (!sources) continue;
        if (
          sources.some((s) => nonce.test(s) || hash.test(s)) ||
          !sources.some((s) => s.toLowerCase() === "'unsafe-inline'")
        )
          throw failure("original_policy_denied", "style-src-attr");
      }
      return Object.freeze({ kind: "style-attribute" as const, source });
    },
    assertAttribute(_kind: "script" | "style"): never {
      throw failure("original_policy_attribute_unsupported");
    },
    snapshot: Object.freeze(options.contentPolicies.map((s) => String(s))),
  };
  return Object.freeze(api);
}
export type OriginalDocumentPolicy = ReturnType<
  typeof createOriginalDocumentPolicy
>;

/** Additional immutable native-document policy for string/Wasm compilation.
 * Resource authorization remains the graph + trusted broker's responsibility;
 * this deliberately does not claim a complete physical CSP compilation. The
 * original header sandbox remains enforced independently, including direct visits.
 */
export function originalExecutionCSP(
  policy: OriginalDocumentPolicy,
  nativeResourceOrigin?: string,
  trustedWorkerResources=false,
) {
  const sources = ["'unsafe-inline'", "blob:"];
  if (nativeResourceOrigin) {
    const origin = new URL(nativeResourceOrigin);
    if (origin.protocol !== "https:" || origin.origin !== nativeResourceOrigin)
      throw failure("original_policy_invalid_native_origin");
    sources.push(origin.origin + "/native-resource/v1/resource/");
  }
  const compilation: string[] = ["'unsafe-inline'"];
  if(trustedWorkerResources)compilation.push("blob:");
  for (const [kind, keyword] of [
    ["javascript", "'unsafe-eval'"],
    ["wasm", "'wasm-unsafe-eval'"],
  ] as const) {
    try {
      policy.checkEval(kind);
      compilation.push(keyword);
    } catch (error) {
      if ((error as any)?.code !== "original_policy_eval_denied") throw error;
    }
  }
  return (
    "script-src " +
    compilation.join(" ") +
    "; script-src-elem " +
    sources.join(" ") +
    (policy.trustedTypes.csp ? "; " + policy.trustedTypes.csp : "")
  );
}
