/** Trusted-only native resource preparation. No-CORS original bytes never cross
 * a child MessagePort. Only separately CORS-authorized font dependencies use a
 * private snapshot-to-child-Blob channel; public prepare remains native URL only.
 * The transport MUST be createSandboxRelayFetch (assigned browser HttpEngine +
 * trusted persistent cookie jar), never native frontend fetch or server fetch.
 * Fetch/CORP: https://fetch.spec.whatwg.org/#cross-origin-resource-policy-header
 * CSP: https://www.w3.org/TR/CSP3/#match-url-to-source-expression
 * SRI: https://www.w3.org/TR/sri/
 */
import { getDomain } from "tldts";
import { imageResourceMIME } from "./raster-image-mime.ts";
import { verifyResourceIntegrity } from "./opaque-resource-integrity.ts";
import type {
  SandboxNetworkRequest,
  SandboxNetworkContext,
  SandboxNetworkResponse,
} from "./sandbox-network.ts";
export type NativeResourceIdentity = Readonly<{
  nodeId: string;
  resourceOrigin: string;
  leaseHash: string;
  generation: number;
}>;
export type NativeResourceDescriptor = Readonly<{
  url: string;
  kind: "image" | "style" | "script" | "audio" | "video";
  crossOrigin?: "anonymous" | "use-credentials";
  integrity?: string;
  nonce?: string;
  /** Document-local CLASSIC execution slot; never a logical source URL. */
  scriptContext?: string;
}>;
export type NativeResourceDependencyDescriptor = Omit<
  NativeResourceDescriptor,
  "kind"
> & {
  kind: NativeResourceDescriptor["kind"] | "font";
};
export type NativeFontSnapshot = Readonly<{ body: Uint8Array; mime: string }>;
export type NativeResourceUpload = {
  documentId: string;
  sourceURL: string;
  kind: NativeResourceDescriptor["kind"];
  mime: string;
  body: Uint8Array;
  policy: {
    originalAllowed: true;
    mixedContentChecked: true;
    integrityChecked: true;
    contentPolicyChecked: true;
  };
};
type Options = {
  documentId: string;
  documentURL: string;
  topLevelURL: string;
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  fetch: (
    request: SandboxNetworkRequest,
    context: SandboxNetworkContext,
  ) => Promise<SandboxNetworkResponse>;
  selectedIdentity: () => NativeResourceIdentity;
  upload: (
    upload: NativeResourceUpload,
    identity: NativeResourceIdentity,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Enforced original policies, one string per policy; NOT report-only values. */
  contentPolicies: string[];
  coep?: "unsafe-none" | "require-corp" | "credentialless";
  /** Runs ONLY inside trusted frontend code. Required for executable/CSS bytes.
   * It must rewrite nested resource references through the same authority and
   * preserve opaque realm execution; never return original cross-site text to a child. */
  transform?: (resource: {
    body: Uint8Array;
    mime: string;
    kind: NativeResourceDescriptor["kind"];
    url: string;
    scriptContext?: string;
    signal: AbortSignal;
    /** Trusted-only same-preparer recursion: never crosses a document port. */
    prepareDependency: (
      descriptor: NativeResourceDependencyDescriptor,
    ) => Promise<string>;
  }) => Promise<Uint8Array>;
  maxBodyBytes?: number;
  maxTotalBytes?: number;
  maxResources?: number;
  timeoutMs?: number;
};
const fail = (code: string) => Object.assign(new TypeError(code), { code });
const MIME = {
  font: /^font\/(?:woff2?|ttf|otf)$/,
  image:
    /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/,
  audio: /^audio\/(?:mpeg|mp4|webm|ogg|wav|x-wav|wave)$/,
  video: /^video\/(?:mp4|webm|ogg)$/,
  style: /^text\/css$/,
  script: /^(?:text|application)\/(?:java|ecma)script$/,
};
const own = (value: object, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const port = (url: URL) =>
  url.port || (url.protocol === "https:" ? "443" : "80");
const scheme = (a: string, b: string) =>
  a === b || (a === "http:" && b === "https:");
const site = (url: URL) =>
  getDomain(url.hostname, { allowPrivateDomains: true }) || url.hostname;
function sourceMatches(source: string, url: URL, self: URL, redirects: number) {
  if (source === "*")
    return /^https?:$/.test(url.protocol) || url.protocol === self.protocol;
  if (source.toLowerCase() === "'self'")
    return (
      url.origin === self.origin ||
      (url.hostname === self.hostname &&
        scheme(self.protocol, url.protocol) &&
        (port(self) === port(url) ||
          (self.protocol === "http:" &&
            port(self) === "80" &&
            url.protocol === "https:" &&
            port(url) === "443")))
    );
  if (/^[A-Za-z][A-Za-z0-9+.-]*:$/.test(source))
    return scheme(source.toLowerCase(), url.protocol);
  if (source.startsWith("'")) return false;
  const match = source.match(
    /^(?:(https?):\/\/)?(\[[a-fA-F0-9:]+\]|\*|(?:\*\.)?[a-zA-Z0-9.-]+)(?::(\*|\d+))?(\/[^?#]*)?$/,
  );
  if (!match) return false;
  const [, protocol, rawHost, sourcePort, path] = match,
    host = rawHost.toLowerCase();
  if (!scheme(protocol ? protocol + ":" : self.protocol, url.protocol))
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
          url.protocol === "https:" &&
          port(url) === "443")
      : url.port === "")
  )
    return false;
  if (path && redirects === 0) {
    try {
      const expected = path.split("/").map(decodeURIComponent),
        actual = url.pathname.split("/").map(decodeURIComponent);
      const prefix = path.endsWith("/");
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
function policies(values: string[]) {
  if (
    !Array.isArray(values) ||
    values.length > 32 ||
    values.some(
      (v) => typeof v !== "string" || v.length > 65536 || v.includes(","),
    )
  )
    throw fail("native_resource_invalid_policy");
  return values.map((value) => {
    const directives = new Map<string, string[]>();
    for (const part of value.split(";")) {
      const [name, ...list] = part.trim().split(/[\t\n\f\r ]+/);
      if (name && !directives.has(name.toLowerCase()))
        directives.set(name.toLowerCase(), list);
    }
    return directives;
  });
}
export function createNativeResourcePreparer(options: Options) {
  const logical = new URL(options.documentURL),
    top = new URL(options.topLevelURL),
    frontend = new URL(options.frontendOrigin);
  const forbidden = new Set(
    [frontend, ...(options.forbiddenOrigins || []).map((v) => new URL(v))].map(
      (v) => v.hostname,
    ),
  );
  const originalPolicies = policies(options.contentPolicies);
  const upgrade = originalPolicies.some((p) =>
    p.has("upgrade-insecure-requests"),
  );
  const coep = options.coep ?? "unsafe-none";
  if (
    !["unsafe-none", "require-corp", "credentialless"].includes(coep) ||
    !options.documentId ||
    [logical, top].some(
      (u) =>
        !/^https?:$/.test(u.protocol) ||
        u.username ||
        u.password ||
        forbidden.has(u.hostname),
    )
  )
    throw fail("native_resource_invalid_document");
  const bodyLimit = options.maxBodyBytes ?? 8 * 1024 * 1024,
    totalLimit = options.maxTotalBytes ?? 32 * 1024 * 1024,
    resourceLimit = options.maxResources ?? 128,
    timeoutMs = options.timeoutMs ?? 15000;
  if (
    [bodyLimit, totalLimit, resourceLimit, timeoutMs].some(
      (v) => !Number.isSafeInteger(v) || v < 1,
    ) ||
    bodyLimit > 8 * 1024 * 1024 ||
    totalLimit > 64 * 1024 * 1024 ||
    resourceLimit > 512 ||
    timeoutMs > 120000
  )
    throw fail("native_resource_invalid_limits");
  let live = true,
    totalBytes = 0,
    totalResources = 0;
  const pending = new Set<AbortController>();
  const identity = () => {
    const value = options.selectedIdentity();
    const resource = new URL(value.resourceOrigin);
    if (
      !value.nodeId ||
      !/^https:$/.test(resource.protocol) ||
      resource.origin !== value.resourceOrigin ||
      !/^[a-f0-9]{64}$/.test(value.leaseHash) ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1
    )
      throw fail("native_resource_invalid_assignment");
    return Object.freeze({ ...value });
  };
  const same = (a: NativeResourceIdentity, b: NativeResourceIdentity) =>
    a.nodeId === b.nodeId &&
    a.resourceOrigin === b.resourceOrigin &&
    a.leaseHash === b.leaseHash &&
    a.generation === b.generation;
  const check = (snapshot: NativeResourceIdentity, signal: AbortSignal) => {
    if (!live || signal.aborted) throw fail("native_resource_aborted");
    if (!same(snapshot, identity()))
      throw fail("native_resource_assignment_changed");
  };
  const checkedURL = (value: string, snapshot: NativeResourceIdentity) => {
    if (value.length > 16384) throw fail("native_resource_invalid_url");
    const u = new URL(value, logical);
    if (upgrade && u.protocol === "http:") u.protocol = "https:";
    if (
      !/^https?:$/.test(u.protocol) ||
      u.username ||
      u.password ||
      forbidden.has(u.hostname) ||
      u.hostname === new URL(snapshot.resourceOrigin).hostname ||
      (logical.protocol === "https:" && u.protocol !== "https:")
    )
      throw fail("native_resource_destination_denied");
    u.hash = "";
    return u;
  };
  function contentAllowed(
    request: NativeResourceDependencyDescriptor,
    url: URL,
    redirects: number,
  ) {
    for (const directives of originalPolicies) {
      if (
        request.kind === "script" &&
        directives.has("sandbox") &&
        !directives.get("sandbox")!.includes("allow-scripts")
      )
        throw fail("native_resource_csp_denied");
      const name =
          request.kind === "font"
            ? "font-src"
            : request.kind === "image"
              ? "img-src"
              : ["audio", "video"].includes(request.kind)
                ? "media-src"
                : request.kind + "-src-elem",
        fallback = request.kind + "-src";
      const list =
        directives.get(name) ??
        directives.get(fallback) ??
        directives.get("default-src");
      if (!list) continue;
      const nonce =
        ["script", "style"].includes(request.kind) &&
        request.nonce &&
        list.some((s) => s === `'nonce-${request.nonce}'`);
      if (nonce) continue;
      // Trust propagation and external hash-source authorization require a trusted
      // initiator graph; absent that proof, deny rather than broaden host rules.
      if (request.kind === "script" && list.includes("'strict-dynamic'"))
        throw fail("native_resource_csp_initiator_required");
      if (
        !list.some((source) => sourceMatches(source, url, logical, redirects))
      )
        throw fail("native_resource_csp_denied");
    }
  }
  async function perform(
    descriptor: NativeResourceDependencyDescriptor,
    snapshot: NativeResourceIdentity,
    signal: AbortSignal,
    ancestry: readonly string[] = [],
    referrerURL?: string,
    onScriptContext?: (binding: { identity: string; baseURL: string }) => void,
    onFont?: (
      font: NativeFontSnapshot,
      identity: NativeResourceIdentity,
      signal: AbortSignal,
    ) => Promise<string>,
  ): Promise<string> {
    if (ancestry.length >= 8)
      throw fail("native_resource_dependency_depth_limit");
    const local = new URL(descriptor.url, logical);
    if (local.protocol === "data:") {
      local.hash = "";
      // This is a dependency-only local-byte sink, never a generic data URL
      // fetch/script/worker authority. No request, cookie, node upload or CORP
      // exemption is created. CSP scheme grants are checked before decoding.
      check(snapshot, signal);
      if (!ancestry.length || !["image", "font"].includes(descriptor.kind))
        throw fail("native_resource_destination_denied");
      contentAllowed(descriptor, local, 0);
      if (local.href.length > bodyLimit * 4 + 65536)
        throw fail("native_resource_byte_limit");
      const comma = local.href.indexOf(",");
      if (comma < 0) throw fail("native_resource_invalid_data");
      const metadata = local.href.slice(5, comma),
        mime = metadata.split(";")[0].trim().toLowerCase();
      if (!MIME[descriptor.kind].test(mime))
        throw fail("native_resource_mime_denied");
      const encoded = new TextEncoder().encode(local.href.slice(comma + 1));
      let length = 0;
      for (let i = 0; i < encoded.length; i++) {
        if (
          encoded[i] === 37 &&
          i + 2 < encoded.length &&
          /^[0-9a-f]{2}$/i.test(
            String.fromCharCode(encoded[i + 1], encoded[i + 2]),
          )
        ) {
          encoded[length++] = parseInt(
            String.fromCharCode(encoded[i + 1], encoded[i + 2]),
            16,
          );
          i += 2;
        } else encoded[length++] = encoded[i];
      }
      let body = encoded.slice(0, length);
      if (/;base64[\t\n\f\r ]*$/i.test(metadata)) {
        try {
          const binary = atob(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
          body = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        } catch {
          throw fail("native_resource_invalid_data");
        }
      }
      if (!body.byteLength) throw fail("native_resource_invalid_data");
      totalBytes += body.byteLength;
      if (body.byteLength > bodyLimit || totalBytes > totalLimit)
        throw fail("native_resource_byte_limit");
      await verifyResourceIntegrity(descriptor.integrity, body);
      check(snapshot, signal);
      if (descriptor.kind === "image") return local.href;
      if (!onFont) throw fail("native_resource_font_bridge_required");
      const blob = await onFont({ body, mime }, snapshot, signal);
      check(snapshot, signal);
      if (typeof blob !== "string" || !/^blob:null\/[a-f0-9-]{36}$/i.test(blob))
        throw fail("native_resource_invalid_font_blob");
      return blob;
    }
    let url = checkedURL(descriptor.url, snapshot),
      redirects = 0,
      requestOrigin = logical.origin,
      taint: "basic" | "cors" | "opaque" = "basic";
    const mode =
        descriptor.kind === "font" || descriptor.crossOrigin
          ? "cors"
          : "no-cors",
      credentialMode =
        descriptor.kind === "font" || descriptor.crossOrigin === "anonymous"
          ? "same-origin"
          : "include";
    for (;;) {
      check(snapshot, signal);
      if (ancestry.includes(url.href))
        throw fail("native_resource_dependency_cycle");
      contentAllowed(descriptor, url, redirects);
      if (url.origin !== logical.origin && taint === "basic")
        taint = mode === "cors" ? "cors" : "opaque";
      const credentials =
        coep === "credentialless" &&
        mode === "no-cors" &&
        url.origin !== logical.origin
          ? "omit"
          : credentialMode === "include" ||
              (credentialMode === "same-origin" && taint === "basic")
            ? "include"
            : "omit";
      const context = Object.freeze({
        documentId: options.documentId,
        documentURL: logical.href,
        origin: logical.origin,
        signal,
        preflight: false,
        requestOrigin,
        responseTaint: taint,
        redirectCount: redirects,
        ...(referrerURL === undefined ? {} : { referrerURL }),
      });
      const response = await options.fetch(
        {
          url: url.href,
          method: "GET",
          headers: [],
          mode,
          credentials,
          redirect: "manual",
          destination: descriptor.kind,
        },
        context,
      );
      check(snapshot, signal);
      if (
        response.url !== url.href ||
        response.redirected ||
        !(response.body instanceof ArrayBuffer) ||
        response.body.byteLength > bodyLimit ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599 ||
        !Array.isArray(response.headers) ||
        response.headers.length > 128
      )
        throw fail("native_resource_invalid_response");
      totalBytes += response.body.byteLength;
      if (totalBytes > totalLimit) throw fail("native_resource_byte_limit");
      let headerBytes = 0;
      const headers = new Headers();
      for (const pair of response.headers) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some((v) => typeof v !== "string") ||
          (headerBytes += pair[0].length + pair[1].length) > 65536
        )
          throw fail("native_resource_invalid_response");
        if (/^set-cookie2?$/i.test(pair[0]))
          throw fail("native_resource_unfiltered_cookie");
        headers.append(...pair);
      }
      if (taint === "cors") {
        const allow = headers.get("access-control-allow-origin");
        if (
          !(
            allow === requestOrigin ||
            (allow === "*" && credentialMode !== "include")
          ) ||
          (credentialMode === "include" &&
            headers.get("access-control-allow-credentials") !== "true")
        )
          throw fail("native_resource_cors_denied");
      }
      if (taint === "opaque") {
        const corp = headers.get("cross-origin-resource-policy");
        let policy = ["same-origin", "same-site", "cross-origin"].includes(
          corp || "",
        )
          ? corp
          : null;
        if (
          !policy &&
          (coep === "require-corp" ||
            (coep === "credentialless" && credentials === "include"))
        )
          policy = "same-origin";
        if (
          (policy === "same-origin" && url.origin !== logical.origin) ||
          (policy === "same-site" &&
            (site(logical) !== site(url) ||
              (logical.protocol !== "https:" && url.protocol === "https:")))
        )
          throw fail("native_resource_corp_denied");
      }
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        headers.has("location")
      ) {
        if (redirects >= 20) throw fail("native_resource_redirect_limit");
        const next = checkedURL(
          new URL(headers.get("location")!, url).href,
          snapshot,
        );
        if (url.protocol === "https:" && next.protocol !== "https:")
          throw fail("native_resource_destination_denied");
        if (next.origin !== url.origin && url.origin !== logical.origin)
          requestOrigin = "null";
        url = next;
        redirects++;
        continue;
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.status === 204 ||
        response.status === 205
      )
        throw fail("native_resource_http_failure");
      if (
        ["audio", "video"].includes(descriptor.kind) &&
        (response.status === 206 || headers.has("content-range"))
      )
        throw fail("native_resource_complete_media_required");
      let mime = (headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (descriptor.kind === "image")
        mime = imageResourceMIME(mime, new Uint8Array(response.body)) ?? "";
      if (!MIME[descriptor.kind].test(mime))
        throw fail("native_resource_mime_denied");
      if (descriptor.integrity && taint === "opaque")
        throw fail("native_resource_integrity_requires_cors");
      const original = new Uint8Array(response.body);
      await verifyResourceIntegrity(descriptor.integrity, original);
      check(snapshot, signal);

      if (descriptor.kind === "font") {
        // Font fetch is anonymous CORS even when its parent sheet is no-CORS.
        // Only CORS-authorized bytes may cross this private child binding.
        if (!onFont) throw fail("native_resource_font_bridge_required");
        const blob = await onFont({ body: original, mime }, snapshot, signal);
        check(snapshot, signal);
        if (
          typeof blob !== "string" ||
          !/^blob:null\/[a-f0-9-]{36}$/i.test(blob)
        )
          throw fail("native_resource_invalid_font_blob");
        return blob;
      }
      if (
        (descriptor.kind === "script" ||
          descriptor.kind === "style" ||
          mime === "image/svg+xml") &&
        !options.transform
      )
        throw fail("native_resource_transform_required");
      let transforming = true;
      let body: Uint8Array;
      try {
        body = options.transform
          ? await options.transform({
              body: original,
              mime,
              kind: descriptor.kind,
              url: url.href,
              scriptContext: descriptor.scriptContext,
              signal,
              prepareDependency: async (dependency) => {
                if (!transforming)
                  throw fail("native_resource_dependency_scope_closed");
                check(snapshot, signal);
                if (headers.has("referrer-policy"))
                  throw fail(
                    "native_resource_dependency_referrer_policy_required",
                  );
                validateDescriptor(dependency, true);
                if (++totalResources > resourceLimit)
                  throw fail("native_resource_count_limit");
                return perform(
                  Object.freeze({
                    ...dependency,
                    url: new URL(dependency.url, url).href,
                  }),
                  snapshot,
                  signal,
                  [...ancestry, url.href],
                  url.href,
                  undefined,
                  onFont,
                );
              },
            })
          : original;
      } finally {
        transforming = false;
      }

      check(snapshot, signal);
      if (
        !(body instanceof Uint8Array) ||
        !body.byteLength ||
        body.byteLength > bodyLimit
      )
        throw fail("native_resource_invalid_transformation");
      if (body.byteLength > original.byteLength) {
        totalBytes += body.byteLength - original.byteLength;
        if (totalBytes > totalLimit) throw fail("native_resource_byte_limit");
      }
      const uploaded = await options.upload(
        {
          documentId: options.documentId,
          sourceURL: url.href,
          kind: descriptor.kind,
          mime,
          body,
          policy: {
            originalAllowed: true,
            mixedContentChecked: true,
            integrityChecked: true,
            contentPolicyChecked: true,
          },
        },
        snapshot,
        signal,
      );
      check(snapshot, signal);
      const native = new URL(uploaded);
      if (
        native.origin !== snapshot.resourceOrigin ||
        !/^\/native-resource\/v1\/resource\/[A-Za-z0-9_-]{43}$/.test(
          native.pathname,
        ) ||
        native.search ||
        native.hash ||
        native.username ||
        native.password
      )
        throw fail("native_resource_wrong_selected_node");
      if (descriptor.scriptContext)
        onScriptContext?.({
          identity: descriptor.scriptContext,
          baseURL: url.href,
        });
      return native.href;
    }
  }
  function dispose() {
    if (!live) return;
    live = false;
    for (const controller of pending) controller.abort();
  }
  function validateDescriptor(
    input: NativeResourceDependencyDescriptor,
    dependency = false,
  ) {
    if (
      !input ||
      typeof input !== "object" ||
      !own(input, [
        "url",
        "kind",
        "crossOrigin",
        "integrity",
        "nonce",
        "scriptContext",
      ]) ||
      typeof input.url !== "string" ||
      !Object.hasOwn(MIME, input.kind) ||
      (input.kind === "font" && !dependency) ||
      (input.crossOrigin !== undefined &&
        !["anonymous", "use-credentials"].includes(input.crossOrigin)) ||
      (input.integrity !== undefined &&
        (typeof input.integrity !== "string" ||
          input.integrity.length > 16384)) ||
      (input.nonce !== undefined &&
        (typeof input.nonce !== "string" || input.nonce.length > 1024)) ||
      (input.scriptContext !== undefined &&
        (input.kind !== "script" ||
          typeof input.scriptContext !== "string" ||
          !/^atlas-script-context:[a-f0-9]{32}$/.test(input.scriptContext)))
    )
      throw fail("native_resource_invalid_descriptor");
  }
  return {
    async prepare(
      input: NativeResourceDescriptor,
      outerSignal?: AbortSignal,
      onScriptContext?: (binding: {
        identity: string;
        baseURL: string;
      }) => void,
      onFont?: (
        font: NativeFontSnapshot,
        identity: NativeResourceIdentity,
        signal: AbortSignal,
      ) => Promise<string>,
    ) {
      if (!live || outerSignal?.aborted) throw fail("native_resource_aborted");
      validateDescriptor(input);
      if (pending.size >= 4 || ++totalResources > resourceLimit)
        throw fail("native_resource_count_limit");
      const snapshot = identity(),
        controller = new AbortController();
      pending.add(controller);
      const abort = () => controller.abort();
      outerSignal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = perform(
        Object.freeze({ ...input }),
        snapshot,
        controller.signal,
        [],
        undefined,
        onScriptContext,
        onFont,
      );
      void operation.finally(() => pending.delete(controller)).catch(() => {});
      let abortListener: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(fail("native_resource_aborted"));
        controller.signal.addEventListener("abort", abortListener, {
          once: true,
        });
      });
      try {
        return await Promise.race([
          operation,
          aborted,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(fail("native_resource_timeout"));
              dispose();
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", abortListener);
      }
    },
    dispose,
    stats() {
      return { live, pending: pending.size, totalBytes, totalResources };
    },
  };
}
