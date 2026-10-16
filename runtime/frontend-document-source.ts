/** Trusted navigation loader, not a website-readable Fetch capability. Only
 * assigned-node transport/cookie authority enters here; no native fetch exists.
 * The final logical URL and original enforced policies bind the new document
 * BEFORE its storage/network/native-resource capabilities or content permit.
 */
import type {
  SandboxNetworkRequest,
  SandboxNetworkContext,
  SandboxNetworkResponse,
} from "./sandbox-network.ts";
import type { TrustedFormNavigation } from "./form-navigation.ts";
type Fetch = (
  request: SandboxNetworkRequest,
  context: SandboxNetworkContext,
) => Promise<SandboxNetworkResponse>;
type Natives = {
  DOMParser: typeof DOMParser;
  parseFromString?: typeof DOMParser.prototype.parseFromString;
  querySelectorAll?: typeof Document.prototype.querySelectorAll;
  getAttribute?: typeof Element.prototype.getAttribute;
  compareDocumentPosition?: typeof Node.prototype.compareDocumentPosition;
};
const failure = (code: string) => Object.assign(new TypeError(code), { code });
export function createFrontendDocumentSource(options: {
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  selectedNodeOrigin: () => string;
  fetch: Fetch;
  natives?: Natives;
  maxBodyBytes?: number;
  timeoutMs?: number;
}) {
  const frontend = new URL(options.frontendOrigin),
    forbidden = new Set(
      [
        frontend,
        ...(options.forbiddenOrigins ?? []).map((u) => new URL(u)),
      ].map((u) => u.hostname),
    );
  const maxBody = options.maxBodyBytes ?? 8 * 1024 * 1024,
    timeoutMs = options.timeoutMs ?? 15000;
  if (
    !/^https?:$/.test(frontend.protocol) ||
    frontend.origin !== options.frontendOrigin ||
    ![maxBody, timeoutMs].every(Number.isSafeInteger) ||
    maxBody < 1 ||
    maxBody > 8 * 1024 * 1024 ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw failure("document_source_invalid_options");
  const natives = options.natives ?? { DOMParser },
    parser = new natives.DOMParser(),
    parse =
      natives.parseFromString ?? natives.DOMParser.prototype.parseFromString;
  const query = natives.querySelectorAll ?? Document.prototype.querySelectorAll,
    get = natives.getAttribute ?? Element.prototype.getAttribute,
    compare =
      natives.compareDocumentPosition ?? Node.prototype.compareDocumentPosition;
  const pending = new Map<string, AbortController>();
  let live = true;
  const currentNode = () => {
    const value = options.selectedNodeOrigin(),
      u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.origin !== value)
      throw failure("document_source_invalid_assignment");
    return u.origin;
  };
  function policies(headers: [string, string][], html: string) {
    const result: string[] = [];
    const add = (policy: string, meta = false) => {
      if (policy.length > 65536 || policy.includes("\0"))
        throw failure("document_source_invalid_policy");
      // Header serialization is a policy LIST. Each member is independently
      // enforced (intersection), never collapsed into one last-wins policy.
      for (const value of policy.split(",")) {
        let item = value.trim();
        if (!item) continue;
        if (meta)
          item = item
            .split(";")
            .filter(
              (d) =>
                ![
                  "frame-ancestors",
                  "sandbox",
                  "report-uri",
                  "report-to",
                ].includes(
                  d
                    .trim()
                    .split(/[\t\n\f\r ]+/)[0]
                    .toLowerCase(),
                ),
            )
            .join(";");
        if (!item.trim()) continue;
        if (result.length >= 32) throw failure("document_source_policy_limit");
        result.push(item);
      }
    };
    for (const [name, value] of headers)
      if (name.toLowerCase() === "content-security-policy") add(value);
    const doc = parse.call(parser, html, "text/html"),
      metas = query.call(doc, "head meta[http-equiv]"),
      sensitive = query.call(
        doc,
        "script,style,link,img,iframe,frame,object,embed,video,audio,source,[style]",
      );
    const inScriptingFallback = (element: Element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (parent.localName.toLowerCase() === "noscript") return true;
      return false;
    };
    for (const element of metas) {
      if (inScriptingFallback(element)) continue;
      if (
        (get.call(element, "http-equiv") ?? "").toLowerCase().trim() !==
        "content-security-policy"
      )
        continue;
      const value = get.call(element, "content");
      if (value === null) continue;
      // Applying a late meta retroactively would not preserve parser-time CSP.
      // This initial immutable policy snapshot rejects that unsupported case.
      if (
        Array.from(sensitive).some((e) => !inScriptingFallback(e) && (compare.call(element, e) & 2) !== 0)
      )
        throw failure("document_source_late_meta_policy");
      add(value, true);
    }
    return Object.freeze(result);
  }
  return {
    async prepare(input: {
      documentId: string;
      website: string;
      signal: AbortSignal;
      navigation?: TrustedFormNavigation;
    }) {
      if (!live || input.signal.aborted)
        throw failure("document_source_aborted");
      if (
        !/^[A-Za-z0-9_-]{16,96}$/.test(input.documentId) ||
        pending.has(input.documentId) ||
        pending.size >= 4
      )
        throw failure("document_source_limit");
      const snapshot = currentNode(),
        controller = new AbortController(),
        abort = () => controller.abort();
      pending.set(input.documentId, controller);
      input.signal.addEventListener("abort", abort, { once: true });
      const check = () => {
        if (!live || controller.signal.aborted || input.signal.aborted)
          throw failure("document_source_aborted");
        if (currentNode() !== snapshot)
          throw failure("document_source_assignment_changed");
      };
      const checked = (value: string, base?: string) => {
        if (typeof value !== "string" || value.length > 16384)
          throw failure("document_source_invalid_url");
        const u = new URL(value, base);
        if (
          !/^https?:$/.test(u.protocol) ||
          u.username ||
          u.password ||
          forbidden.has(u.hostname) ||
          u.hostname === new URL(currentNode()).hostname
        )
          throw failure("document_source_destination_denied");
        return u;
      };
      let timer: ReturnType<typeof setTimeout> | undefined,
        stop: (() => void) | undefined;
      const operation = (async () => {
        const initial = checked(input.website),
          authority = new URL(initial),
          navigation = input.navigation,
          initiator = navigation ? checked(navigation.initiatorURL) : null;
        if (navigation && (navigation.url !== initial.href || !["GET", "POST"].includes(navigation.method)))
          throw failure("document_source_invalid_navigation");
        let method = navigation?.method ?? "GET",
          requestBody = navigation?.body,
          contentType = navigation?.contentType,
          requestOrigin = initiator?.origin ?? authority.origin;
        let url = new URL(initial),
          redirects = 0,
          total = 0;
        for (;;) {
          check();
          navigation?.authorizeURL(url.href, redirects);
          const requestURL = new URL(url);
          requestURL.hash = "";
          const context = Object.freeze({
            documentId: input.documentId,
            documentURL: authority.href,
            origin: authority.origin,
            signal: controller.signal,
            preflight: false,
            requestOrigin,
            responseTaint: "basic" as const,
            redirectCount: redirects,
            topLevelNavigation: true,
            referrerURL: initiator?.href ?? null,
            ...(initiator ? { navigationSourceURL: initiator.href } : {}),
          });
          const response = await options.fetch(
            {
              url: requestURL.href,
              method,
              headers: [["accept", "text/html,application/xhtml+xml"], ...(contentType ? [["content-type", contentType] as [string,string]] : [])],
              ...(requestBody ? { body: requestBody.slice(0) } : {}),
              credentials: "include",
              mode: "no-cors",
              redirect: "manual",
              destination: "document",
            },
            context,
          );
          check();
          if (
            !response ||
            response.url !== requestURL.href ||
            response.redirected ||
            !(response.body instanceof ArrayBuffer) ||
            response.body.byteLength > maxBody ||
            !Number.isInteger(response.status) ||
            response.status < 200 ||
            response.status > 599 ||
            !Array.isArray(response.headers) ||
            response.headers.length > 512
          )
            throw failure("document_source_invalid_response");
          total += response.body.byteLength;
          if (total > maxBody) throw failure("document_source_body_limit");
          let headerBytes = 0;
          for (const pair of response.headers)
            if (
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              pair.some((v) => typeof v !== "string" || /[\0\r\n]/.test(v)) ||
              !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0]) ||
              (headerBytes += pair[0].length + pair[1].length) > 65536 ||
              /^set-cookie2?$/i.test(pair[0])
            )
              throw failure("document_source_invalid_headers");
          const values = (name: string) =>
            response.headers
              .filter((p) => p[0].toLowerCase() === name)
              .map((p) => p[1]);
          const location = values("location");
          if (
            [301, 302, 303, 307, 308].includes(response.status) &&
            location.length
          ) {
            if (redirects >= 20)
              throw failure("document_source_redirect_limit");
            if (location.some((v) => v !== location[0]))
              throw failure("document_source_ambiguous_redirect");
            const next = checked(location[0], url.href);
            if (url.protocol === "https:" && next.protocol !== "https:")
              throw failure("document_source_destination_denied");
            if (!location[0].includes("#")) next.hash = url.hash;
            if (url.origin !== next.origin) requestOrigin = "null";
            if (([301,302].includes(response.status) && method === "POST") || response.status === 303) {
              method = "GET";
              requestBody = undefined;
              contentType = undefined;
            }
            url = next;
            redirects++;
            continue;
          }
          const types = values("content-type");
          if (
            response.status < 200 ||
            response.status >= 300 ||
            [204, 205].includes(response.status) ||
            types.length !== 1 ||
            !/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(
              types[0],
            )
          )
            throw failure("document_source_html_required");
          if (
            types[0].split(";")[0].trim().toLowerCase() ===
            "application/xhtml+xml"
          )
            throw failure("document_source_xhtml_parser_required");
          const charset = types[0].match(
              /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
            ),
            body = new Uint8Array(response.body);
          let encoding = charset?.[1] ?? charset?.[2] ?? "utf-8";
          if (body[0] === 0xff && body[1] === 0xfe) encoding = "utf-16le";
          else if (body[0] === 0xfe && body[1] === 0xff) encoding = "utf-16be";
          else if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)
            encoding = "utf-8";
          let html: string;
          try {
            html = new TextDecoder(encoding).decode(body);
          } catch {
            throw failure("document_source_encoding_unsupported");
          }
          const coeps = values("cross-origin-embedder-policy");
          let coep: "unsafe-none" | "require-corp" | "credentialless" =
            "unsafe-none";
          if (coeps.length) {
            if (coeps.length !== 1)
              throw failure("document_source_invalid_coep");
            const value = coeps[0].split(";")[0].trim();
            if (
              !["unsafe-none", "require-corp", "credentialless"].includes(value)
            )
              throw failure("document_source_invalid_coep");
            coep = value as typeof coep;
          }
          const contentPolicies = policies(response.headers, html);
          check();
          return Object.freeze({ url: url.href, html, contentPolicies, coep });
        }
      })();
      // A transport ignoring AbortSignal cannot create unlimited orphan loads:
      // retain its slot until the actual operation settles, even after timeout.
      void operation
        .finally(() => pending.delete(input.documentId))
        .catch(() => {});
      const aborted = new Promise<never>((_resolve, reject) => {
        stop = () => reject(failure("document_source_aborted"));
        controller.signal.addEventListener("abort", stop, { once: true });
        if (controller.signal.aborted) stop();
      });
      try {
        return await Promise.race([
          operation,
          aborted,
          new Promise<never>((_r, reject) => {
            timer = setTimeout(() => {
              reject(failure("document_source_timeout"));
              controller.abort();
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (stop) controller.signal.removeEventListener("abort", stop);
        controller.abort();
      }
    },
    dispose() {
      if (!live) return;
      live = false;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    },
  };
}
