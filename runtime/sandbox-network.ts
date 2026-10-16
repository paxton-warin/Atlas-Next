/** Readable fetch capability for an opaque website document. Transport and
 * cookies stay in trusted code. This is not the native resource-loading path:
 * callers cannot turn a no-CORS script request into readable cross-site bytes.
 */
export const SANDBOX_NETWORK_PROTOCOL = "atlas-network-v2";
import { resourceResponseBudget } from "./resource-response-budget.ts";
import type {
  OriginalDocumentPolicy,
  OriginalPolicyKind,
} from "./original-document-policy.ts";
export type SandboxNetworkRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body?: ArrayBuffer;
  credentials: "omit" | "same-origin" | "include";
  mode: "cors" | "no-cors" | "same-origin";
  destination?: string;
  /** Rewriter-owned original element metadata; never a CORS readability grant. */
  policyNonce?: string;
  policyIntegrity?: string;
  isModule?: boolean;
  /** XHR upload listeners require preflight even for a safelisted request. */
  forcePreflight?: boolean;
  /** Consumed by this broker, never delegated to a transport redirector. */
  redirect?: "follow" | "error" | "manual";
};
export type SandboxNetworkResponse = {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
  type?: "basic" | "cors" | "opaque" | "opaqueredirect";
  redirected?: boolean;
};
export type SandboxNetworkContext = Readonly<{
  documentId: string;
  documentURL: string;
  origin: string;
  signal: AbortSignal;
  preflight: boolean;
  /** Trusted serialized request Origin; authority remains context.origin. */
  requestOrigin?: string;
  responseTaint?: "basic" | "cors" | "opaque";
  redirectCount?: number;
  /** Trusted top-level navigation loader only; never fields of child messages. */
  topLevelNavigation?: boolean;
  referrerURL?: string | null;
  /** Initiating logical website for trusted HTML-form navigations only. */
  navigationSourceURL?: string;
}>;
type Binding = {
  port: MessagePort;
  documentId: string;
  documentURL: string;
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  /** Must use the assigned relay, apply the trusted cookie jar, disable
   * automatic redirects, bound received bytes, and honor AbortSignal. No native
   * frontend fetch fallback is provided. Origin/referrer derive from context. */
  fetch: (
    request: SandboxNetworkRequest,
    context: SandboxNetworkContext,
  ) => Promise<SandboxNetworkResponse>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Constructed from the trusted navigation response before this port exists. */
  originalPolicy?: OriginalDocumentPolicy;
};
const REQUEST_BYTES = 2 * 1024 * 1024;
const QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_ACTIVE = 4;
const FORBIDDEN =
  /^(?:accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|permissions-policy|referer|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
const EXPOSED = new Set([
  "cache-control",
  "content-language",
  "content-length",
  "content-type",
  "expires",
  "last-modified",
  "pragma",
]);
const ownKeys = (value: object, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const failure = (code: string) => Object.assign(new Error(code), { code });
const tokens = (value: string | null) =>
  (value || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
function safeHeader(name: string, value: string) {
  // Headers normalizes WebIDL ByteString values first: each JS code unit is
  // one header byte, not a UTF-8 encoded string (native browser parity tested).
  if (value.length > 128) return false;
  if (["accept-language", "content-language"].includes(name))
    return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
  if (name === "range") return /^bytes=\d+-\d*$/.test(value);
  if (
    !["accept", "content-type"].includes(name) ||
    /[\x00-\x08\x0a-\x1f\x7f"():<>?@\[\]{}\\]/.test(value)
  )
    return false;
  return (
    name !== "content-type" ||
    [
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "text/plain",
    ].includes(value.split(";")[0].trim().toLowerCase())
  );
}
function allowedCORS(headers: Headers, origin: string, credentials: boolean) {
  const allow = headers.get("access-control-allow-origin");
  return (
    (allow === origin || (!credentials && allow === "*")) &&
    (!credentials || headers.get("access-control-allow-credentials") === "true")
  );
}

export function bindSandboxNetwork(binding: Binding) {
  const documentURL = new URL(binding.documentURL);
  const forbidden = new Set(
    [binding.frontendOrigin, ...(binding.forbiddenOrigins || [])].map(
      (v) => new URL(v).hostname,
    ),
  );
  function checkedURL(value: string) {
    if (value.length > 16384) throw failure("invalid_network_request");
    const resolved = new URL(value, documentURL).href;
    const url = new URL(
      binding.originalPolicy?.upgradeURL(resolved) ?? resolved,
    );
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      forbidden.has(url.hostname)
    )
      throw failure("destination_denied");
    if (documentURL.protocol === "https:" && url.protocol !== "https:")
      throw failure("mixed_content_denied");
    url.hash = "";
    return url;
  }
  checkedURL(documentURL.href);
  const { port, documentId } = binding;
  let live = true,
    next = 1,
    active = 0,
    bytes = 0,
    invalid = 0;
  type Work = {
    sequence: number;
    request: SandboxNetworkRequest;
    size: number;
    controller: AbortController;
    started: boolean;
  };
  const pending = new Map<number, Work>();
  const queue: Work[] = [];
  const send = (value: object, transfer: Transferable[] = []) => {
    if (live)
      port.postMessage(
        { protocol: SANDBOX_NETWORK_PROTOCOL, documentId, ...value },
        transfer,
      );
  };
  const error = (sequence: number | undefined, code: string) =>
    send({ type: "error", sequence, code, message: code });
  function dispose() {
    if (!live) return;
    live = false;
    port.removeEventListener("message", receive);
    for (const work of pending.values()) work.controller.abort();
    pending.clear();
    queue.length = 0;
    bytes = 0;
    port.close();
  }
  function parse(value: any): SandboxNetworkRequest {
    if (
      !value ||
      typeof value !== "object" ||
      !ownKeys(value, [
        "url",
        "method",
        "headers",
        "body",
        "credentials",
        "mode",
        "destination",
        "policyNonce",
        "policyIntegrity",
        "isModule",
        "forcePreflight",
        "redirect",
      ]) ||
      typeof value.url !== "string"
    )
      throw failure("invalid_network_request");
    const url = checkedURL(value.url);
    const method = value.method === undefined ? "GET" : value.method;
    if (
      typeof method !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(method) ||
      /^(?:CONNECT|TRACE|TRACK)$/i.test(method)
    )
      throw failure("invalid_network_request");
    const credentials = value.credentials ?? "same-origin",
      mode = value.mode ?? "cors";
    if (
      !["omit", "same-origin", "include"].includes(credentials) ||
      !["cors", "no-cors", "same-origin"].includes(mode) ||
      (value.destination !== undefined &&
        (typeof value.destination !== "string" ||
          value.destination.length > 32)) ||
      ["policyNonce", "policyIntegrity"].some(
        (key) =>
          value[key] !== undefined &&
          (typeof value[key] !== "string" || value[key].length > 4096),
      ) ||
      (value.isModule !== undefined && typeof value.isModule !== "boolean") ||
      (value.forcePreflight !== undefined &&
        typeof value.forcePreflight !== "boolean") ||
      (value.redirect !== undefined &&
        !["follow", "error", "manual"].includes(value.redirect))
    )
      throw failure("invalid_network_request");
    if (mode === "same-origin" && url.origin !== documentURL.origin)
      throw failure("cors_denied");
    if (documentURL.protocol === "https:" && url.protocol !== "https:")
      throw failure("mixed_content_denied");
    if (!Array.isArray(value.headers) || value.headers.length > 64)
      throw failure("invalid_network_request");
    const headers: [string, string][] = [];
    let size = 0;
    for (const pair of value.headers) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((v: unknown) => typeof v !== "string")
      )
        throw failure("invalid_network_request");
      const name = pair[0].toLowerCase(),
        content = pair[1];
      size += name.length + content.length;
      if (
        FORBIDDEN.test(name) ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
        /[\r\n\0]/.test(content) ||
        size > 16384
      )
        throw failure("forbidden_request_header");
      headers.push([name, content]);
    }
    // Native Headers coalesces duplicate fields before evaluating safelisting.
    const normalized = Array.from(new Headers(headers).entries());
    const normalizedMethod = /^(?:DELETE|GET|HEAD|OPTIONS|POST|PUT)$/i.test(
      method,
    )
      ? method.toUpperCase()
      : method;
    if (
      mode === "no-cors" &&
      (!["GET", "HEAD", "POST"].includes(normalizedMethod) ||
        normalized.some(([n, v]) => !safeHeader(n, v)))
    )
      throw failure("cors_denied");
    if (
      value.body !== undefined &&
      (!(value.body instanceof ArrayBuffer) ||
        value.body.byteLength > REQUEST_BYTES ||
        ["GET", "HEAD"].includes(normalizedMethod))
    )
      throw failure("invalid_network_request");
    return {
      url: url.href,
      method: normalizedMethod,
      headers: normalized,
      body: value.body,
      credentials,
      mode,
      destination: value.destination,
      policyNonce: value.policyNonce,
      policyIntegrity: value.policyIntegrity,
      isModule: value.isModule,
      forcePreflight: value.forcePreflight,
      redirect: value.redirect,
    };
  }
  async function perform(work: Work) {
    const { controller } = work;
    const { redirect = "follow", ...initial } = work.request;
    let request = {
      ...initial,
      headers: initial.headers.map(([n, v]) => [n, v] as [string, string]),
    };
    const credentialsMode = initial.credentials;
    let redirectCount = 0,
      requestOrigin = documentURL.origin,
      responseTaint: "basic" | "cors" | "opaque" = "basic";
    let receivedBytes = 0;
    const maxBytes = binding.maxResponseBytes ?? resourceResponseBudget(initial.destination);
    const checkedResponse = (result: SandboxNetworkResponse, url: URL) => {
      if (!result || typeof result.url !== "string")
        throw failure("invalid_network_response");
      const actual = checkedURL(result.url);
      // The callback must return one raw hop, never a transport-followed result.
      if (actual.href !== url.href || result.redirected === true)
        throw failure("redirect_requires_broker");
      if (
        !(result.body instanceof ArrayBuffer) ||
        !Number.isInteger(result.status) ||
        result.status < 200 ||
        result.status > 599 ||
        typeof result.statusText !== "string" ||
        result.statusText.length > 256 ||
        !Array.isArray(result.headers) ||
        result.headers.length > 512
      )
        throw failure("invalid_network_response");
      let headerBytes = 0;
      for (const pair of result.headers) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some((v) => typeof v !== "string")
        )
          throw failure("invalid_network_response");
        headerBytes += pair[0].length + pair[1].length;
        if (headerBytes > 65536) throw failure("invalid_network_response");
      }
      receivedBytes += result.body.byteLength;
      if (receivedBytes > maxBytes) throw failure("invalid_network_response");
      try {
        const headers = new Headers(result.headers);
        // Location is not a list-valued field. Native HTTP accepts repeated
        // identical values but rejects conflicting values; never resolve a
        // comma-joined synthetic URL that neither response actually supplied.
        const locations = result.headers
          .filter(([name]) => name.toLowerCase() === "location")
          .map(([, value]) => value.replace(/^[\t ]+|[\t ]+$/g, ""));
        if (new Set(locations).size > 1) throw failure("invalid_redirect");
        if (locations.length > 1) headers.set("location", locations[0]);
        return headers;
      } catch (error: any) {
        throw error?.code ? error : failure("invalid_network_response");
      }
    };
    for (;;) {
      if (!live || controller.signal.aborted) throw failure("request_aborted");
      const url = checkedURL(request.url),
        cross = url.origin !== documentURL.origin;
      if (binding.originalPolicy) {
        const destination = request.destination || "connect";
        if (
          !["connect", "script", "style", "image", "font", "media"].includes(destination)
        )
          throw failure("original_policy_resource_kind_required");
        // Check BEFORE every actual hop, including preflights and redirects.
        // No destination bypasses the independent logical CORS/cookie checks.
        binding.originalPolicy.checkURL({
          url: url.href,
          kind: destination as OriginalPolicyKind | "media",
          nonce: request.policyNonce,
          integrity: request.policyIntegrity,
          redirectCount,
        });
      }
      if (request.mode === "same-origin" && cross) throw failure("cors_denied");
      if (responseTaint === "basic" && cross)
        responseTaint = request.mode === "no-cors" ? "opaque" : "cors";
      const includeCredentials =
        credentialsMode === "include" ||
        (credentialsMode === "same-origin" && responseTaint === "basic");
      const corsCredentials = credentialsMode === "include";
      const context = Object.freeze({
        documentId,
        documentURL: documentURL.href,
        origin: documentURL.origin,
        signal: controller.signal,
        preflight: false,
        requestOrigin,
        responseTaint,
        redirectCount,
      });
      if (responseTaint === "cors") {
        const unsafe = [
          ...new Set(
            request.headers
              .filter(([n, v]) => !safeHeader(n, v))
              .map(([n]) => n),
          ),
        ].sort();
        if (
          request.forcePreflight ||
          !["GET", "HEAD", "POST"].includes(request.method) ||
          unsafe.length
        ) {
          const headers: [string, string][] = [
            ["access-control-request-method", request.method],
          ];
          if (unsafe.length)
            headers.push(["access-control-request-headers", unsafe.join(",")]);
          const preflight = await binding.fetch(
            {
              url: url.href,
              method: "OPTIONS",
              headers,
              credentials: "omit",
              mode: "cors",
            },
            Object.freeze({ ...context, preflight: true }),
          );
          if (!live || controller.signal.aborted)
            throw failure("request_aborted");
          const result = checkedResponse(preflight, url),
            methods = (result.get("access-control-allow-methods") || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            allowed = tokens(result.get("access-control-allow-headers"));
          // Preflight redirects are never followed, and Authorization is never
          // included in a wildcard allow-headers grant.
          if (
            preflight.status < 200 ||
            preflight.status >= 300 ||
            !allowedCORS(result, requestOrigin, corsCredentials) ||
            (!methods.includes(request.method) &&
              !(!corsCredentials && methods.includes("*")) &&
              !["GET", "HEAD", "POST"].includes(request.method)) ||
            unsafe.some(
              (n) =>
                !allowed.includes(n) &&
                !(
                  !corsCredentials &&
                  n !== "authorization" &&
                  allowed.includes("*")
                ),
            )
          )
            throw failure("cors_preflight_denied");
        }
      }
      const hop = {
        ...request,
        url: url.href,
        credentials: includeCredentials
          ? ("include" as const)
          : ("omit" as const),
      };
      const result = await binding.fetch(hop, context);
      if (!live || controller.signal.aborted) throw failure("request_aborted");
      const headers = checkedResponse(result, url);
      // Apply CORS before observing/following every redirect, not only final data.
      if (
        responseTaint === "cors" &&
        !allowedCORS(headers, requestOrigin, corsCredentials)
      )
        throw failure("cors_denied");
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (redirect === "error") throw failure("redirect_denied");
        if (redirect === "manual")
          return {
            url: url.href,
            status: 0,
            statusText: "",
            headers: [],
            body: new ArrayBuffer(0),
            type: "opaqueredirect",
            redirected: false,
          } satisfies SandboxNetworkResponse;
        const location = headers.get("location");
        if (location !== null) {
          if (redirectCount >= 20) throw failure("redirect_limit");
          let next: URL;
          try {
            next = checkedURL(new URL(location, url).href);
          } catch (error: any) {
            throw error?.code ? error : failure("invalid_redirect");
          }
          if (url.protocol === "https:" && next.protocol !== "https:")
            throw failure("mixed_content_denied");
          if (
            request.mode === "same-origin" &&
            next.origin !== documentURL.origin
          )
            throw failure("cors_denied");
          let method = request.method,
            body = request.body,
            nextHeaders = request.headers;
          if (
            ((result.status === 301 || result.status === 302) &&
              method === "POST") ||
            (result.status === 303 && method !== "GET" && method !== "HEAD")
          ) {
            method = "GET";
            body = undefined;
            nextHeaders = nextHeaders.filter(
              ([name]) =>
                ![
                  "content-encoding",
                  "content-language",
                  "content-location",
                  "content-type",
                ].includes(name),
            );
          }
          if (next.origin !== url.origin) {
            nextHeaders = nextHeaders.filter(
              ([name]) => name !== "authorization",
            );
            // Fetch redirect-taint: initial A→B retains A; B→C or B→A serializes
            // a null Origin permanently, including same-site origin changes.
            if (url.origin !== documentURL.origin) requestOrigin = "null";
          }
          request = {
            ...request,
            url: next.href,
            method,
            body,
            headers: nextHeaders,
          };
          redirectCount++;
          continue;
        }
      }
      if (responseTaint === "opaque")
        return {
          url: "",
          status: 0,
          statusText: "",
          headers: [],
          body: new ArrayBuffer(0),
          type: "opaque",
          redirected: false,
        } satisfies SandboxNetworkResponse;
      const exposed = tokens(headers.get("access-control-expose-headers"));
      const filtered = Array.from(headers.entries()).filter(
        ([name]) =>
          !["set-cookie", "set-cookie2"].includes(name) &&
          (responseTaint === "basic" ||
            EXPOSED.has(name) ||
            exposed.includes(name) ||
            (!corsCredentials && exposed.includes("*"))),
      );
      return {
        url: url.href,
        status: result.status,
        statusText: result.statusText,
        body: result.body,
        headers: filtered,
        type: responseTaint,
        redirected: redirectCount > 0,
      } satisfies SandboxNetworkResponse;
    }
  }
  async function run(work: Work) {
    active++;
    work.started = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        perform(work),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(failure("network_timeout")),
            binding.timeoutMs ?? 15000,
          );
        }),
      ]);
      send({ type: "response", sequence: work.sequence, response }, [
        response.body,
      ]);
    } catch (cause: any) {
      const code =
        cause?.code ||
        (work.controller.signal.aborted ? "request_aborted" : "network_failed");
      error(work.sequence, code);
      // A handler ignoring cancellation must not permit unlimited orphan work.
      if (code === "network_timeout") dispose();
    } finally {
      clearTimeout(timer);
      active--;
      bytes = Math.max(0, bytes - work.size);
      pending.delete(work.sequence);
      drain();
    }
  }
  function drain() {
    while (live && active < MAX_ACTIVE && queue.length) {
      const work = queue.shift()!;
      if (!work.controller.signal.aborted) void run(work);
    }
  }
  function receive(event: MessageEvent) {
    const value = event.data;
    if (!live) return;
    if (
      !value ||
      typeof value !== "object" ||
      value.protocol !== SANDBOX_NETWORK_PROTOCOL ||
      value.documentId !== documentId ||
      value.sequence !== next ||
      !Number.isSafeInteger(next) ||
      !["fetch", "cancel"].includes(value.type) ||
      !ownKeys(value, [
        "protocol",
        "documentId",
        "sequence",
        "type",
        "request",
        "targetSequence",
      ])
    ) {
      error(undefined, "invalid_capability_message");
      if (++invalid >= 4) dispose();
      return;
    }
    const sequence = next++;
    try {
      if (value.type === "cancel") {
        if (
          !Number.isSafeInteger(value.targetSequence) ||
          value.request !== undefined
        )
          throw failure("invalid_network_request");
        const work = pending.get(value.targetSequence);
        if (work) {
          work.controller.abort();
          if (!work.started) {
            queue.splice(queue.indexOf(work), 1);
            pending.delete(work.sequence);
            bytes -= work.size;
            error(work.sequence, "request_aborted");
          }
        }
        send({
          type: "cancelled",
          sequence,
          targetSequence: value.targetSequence,
        });
        return;
      }
      if (value.targetSequence !== undefined)
        throw failure("invalid_network_request");
      const request = parse(value.request),
        size =
          (request.body?.byteLength || 0) +
          JSON.stringify([request.url, request.headers]).length * 2;
      if (pending.size >= MAX_PENDING || bytes + size > QUEUE_BYTES)
        throw failure("network_backpressure");
      const work = {
        sequence,
        request,
        size,
        controller: new AbortController(),
        started: false,
      };
      pending.set(sequence, work);
      bytes += size;
      queue.push(work);
      drain();
    } catch (cause: any) {
      error(sequence, cause?.code || "invalid_network_request");
    }
  }
  port.addEventListener("message", receive);
  port.start();
  return {
    dispose,
    get pending() {
      return pending.size;
    },
    get live() {
      return live;
    },
  };
}
