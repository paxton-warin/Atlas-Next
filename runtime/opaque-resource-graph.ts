/** Client-local graph for browser-readable resources. Cross-origin bodies enter
 * this graph ONLY after the trusted network broker grants CORS readability.
 * No destination flag grants no-cors bytes, and no frontend HTTP fallback exists.
 */
import { init as initializeLexer, parse } from "es-module-lexer/minimal";
import { OpaqueImportMap } from "./opaque-import-map.ts";
import { parseNativeSrcset, serializeNativeSrcset } from "./native-srcset.ts";
import { qualifyInlineSVG } from "./inline-svg.ts";
import { imageResourceMIME } from "./raster-image-mime.ts";
import { decodeLocalCSSDataResource } from "./local-css-data-resource.ts";
import {
  resourceDigest,
  verifyResourceIntegrity,
} from "./opaque-resource-integrity.ts";
import type {
  createOpaqueNetworkClient,
  createPinnedOpaqueRewriter,
} from "./opaque-runtime-adapter.ts";
import type { NativeResourceDescriptor } from "./native-resource-preparer.ts";
import type {
  OriginalDocumentPolicy,
  OriginalPolicyKind,
} from "./original-document-policy.ts";
import {
  scanNativeCSSDependencies,
  quoteNativeCSSURL,
} from "./native-css-dependencies.ts";
type Rewriter = ReturnType<typeof createPinnedOpaqueRewriter>;
type Network = ReturnType<typeof createOpaqueNetworkClient>;
const MODULE = "atlas-opaque-module:";
const RESOURCE = "atlas-opaque-resource:";
const SCRIPT_CONTEXT = "atlas-script-context:";
const key = (url: string) => MODULE + encodeURIComponent(url);
type Kind = "classic" | "style" | "image" | "font" | "auto" | "audio" | "video";
type Module = {
  source: string;
  dependencies: string[];
  blob?: string;
  integrity?: string;
  nonce?: string;
  baseURL?: string;
};
export function createOpaqueResourceGraph(options: {
  documentURL: string;
  /** Trusted first-base decision; separate from CSP/storage/cookie identity. */
  documentBaseURL?: string;
  rewriter: Rewriter;
  network: Network;
  document: Document;
  /** Original response policies are supplied by the trusted source provider. */
  originalPolicy?: OriginalDocumentPolicy;
  /** Native eval/Wasm restriction installed before the first website script. */
  executionPolicy?: string;
  /** URL-only private capability, never a readable no-CORS response fallback. */
  nativeResources?: {
    prepare(
      descriptor: NativeResourceDescriptor,
      signal?: AbortSignal,
      acceptScriptContext?: (baseURL: string) => void,
    ): Promise<string>;
  };
  /** Captured BEFORE RuntimeKit hooks. All created Blobs belong to this child. */
  natives: {
    DOMParser: typeof DOMParser;
    Blob: typeof Blob;
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
    importModule: (url: string) => Promise<unknown>;
    appendChild: typeof Node.prototype.appendChild;
    setAttribute: typeof Element.prototype.setAttribute;
    parseFromString?: typeof DOMParser.prototype.parseFromString;
    getAttribute?: typeof Element.prototype.getAttribute;
    removeAttribute?: typeof Element.prototype.removeAttribute;
    insertBefore?: typeof Node.prototype.insertBefore;
    setScriptText?: (element: HTMLScriptElement, source: string) => void;
    digest?: (algorithm: string, body: Uint8Array) => Promise<ArrayBuffer>;
  };
  maxResources?: number;
  maxTotalBytes?: number;
}) {
  const documentURL = new URL(options.documentURL);
  const documentBaseURL = new URL(options.documentBaseURL ?? options.documentURL);
  if (!/^https?:$/.test(documentBaseURL.protocol) || documentBaseURL.username || documentBaseURL.password)
    throw new TypeError("Invalid logical document base");
  const { rewriter, network, natives, document, originalPolicy } = options;
  const modules = new Map<string, Module>(),
    resources = new Map<string, Promise<string>>();
  const raw = new Map<
    string,
    Promise<{ body: ArrayBuffer; type: string; url: string }>
  >();
  const allocated = new Set<string>(),
    mapped = new Set<string>(),
    digests = new Map<string, string>();
  const importMap = new OpaqueImportMap(documentBaseURL.href);
  const moduleIntegrity = new Map<string, string>();
  const scriptContexts = new Map<
    string,
    Readonly<{ baseURL: string; nonce?: string }>
  >();
  const randomUUID = crypto.randomUUID.bind(crypto);
  // Discord's public login document alone currently declares 356 scripts and
  // 322 stylesheets. Count limits must allow that finite graph; byte/depth and
  // per-destination policy bounds remain independent, not an unlimited loader.
  const maxResources = options.maxResources ?? 1024,
    maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 2048 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 64 * 1024 * 1024)
    throw new TypeError("Invalid website resource graph limits.");
  const nativeSubtleDigest = crypto.subtle.digest.bind(crypto.subtle);
  const digest =
    natives.digest ??
    ((algorithm: string, bytes: Uint8Array) =>
      nativeSubtleDigest(algorithm, bytes as BufferSource));
  const nativeBlobArrayBuffer = natives.Blob.prototype.arrayBuffer;
  const encoder = new TextEncoder(),
    nativeEncode = TextEncoder.prototype.encode;
  const nativeBtoa = btoa.bind(globalThis),
    nativeCharacters = String.fromCharCode;
  const codecs = {
    encode: (value: string) => nativeEncode.call(encoder, value),
    base64: (value: Uint8Array) => nativeBtoa(nativeCharacters(...value)),
  };
  const parser = new natives.DOMParser(),
    parseHTML = natives.parseFromString ?? parser.parseFromString;
  const nativeGet =
    natives.getAttribute ?? document.documentElement.getAttribute;
  const get = (element: Element, attribute: string) =>
    nativeGet.call(element, attribute);
  const original = (element: Element, attribute: string) =>
    get(element, "runtimekit-attr-" + attribute) ??
    get(element, attribute) ??
    "";
  const set = (element: Element, attribute: string, value: string) =>
    natives.setAttribute.call(element, attribute, value);
  const scriptText = (element: Element, source: string) => {
    if (natives.setScriptText)
      natives.setScriptText(element as HTMLScriptElement, source);
    else element.textContent = source;
  };
  const icon = (element: Element) =>
    element.localName === "link" &&
    /(?:^|\s)(?:icon|apple-touch-icon|mask-icon)(?:\s|$)/i.test(
      original(element, "rel"),
    );
  let totalBytes = 0,
    live = true,
    inlineSerial = 0;
  let tail = Promise.resolve();
  const resolve = (value: string, base = documentBaseURL.href) => {
    const restored = value.startsWith(MODULE)
      ? decodeURIComponent(value.slice(MODULE.length))
      : value.startsWith(rewriter.context.prefix.href) ||
          value.startsWith(rewriter.context.prefix.pathname)
        ? rewriter.restoreURL(value)
        : value;
    const resolved = new URL(restored, base).href;
    const url = new URL(originalPolicy?.upgradeURL(resolved) ?? resolved);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw new DOMException(
        "Website resources require HTTP(S) URLs.",
        "SecurityError",
      );
    return url.href;
  };
  const moduleURL = (specifier: string, base = documentBaseURL.href) =>
    resolve(importMap.resolve(specifier, base), base);
  // Only an IMG's own local bytes may retain data:. Other fetch destinations,
  // CSS dependencies and the generic HTTP/module resolver remain unchanged.
  const imageURL = (value: string) => {
    const url = new URL(value, documentBaseURL);
    if (url.protocol !== "data:") return resolve(value);
    if (url.href.length > 16384)
      throw new DOMException(
        "Local image URL limit reached.",
        "QuotaExceededError",
      );
    return url.href;
  };
  const executionContext = (identity: string) => {
    if (identity.startsWith(SCRIPT_CONTEXT)) {
      const context = scriptContexts.get(identity);
      if (!context)
        throw new DOMException(
          "Unknown script execution context.",
          "SecurityError",
        );
      return context;
    }
    const logical = resolve(identity),
      record =
        modules.get(logical) ??
        [...modules.values()].find((entry) => entry.baseURL === logical);
    return { baseURL: record?.baseURL ?? logical, nonce: record?.nonce };
  };
  function registerClassicContext(baseURL: string, nonce?: string) {
    if (scriptContexts.size >= maxResources)
      throw new DOMException(
        "Script execution context limit reached.",
        "QuotaExceededError",
      );
    const identity = SCRIPT_CONTEXT + randomUUID().replaceAll("-", "");
    scriptContexts.set(identity, Object.freeze({ baseURL, nonce }));
    return identity;
  }
  function classicSource(source: string, baseURL: string, nonce?: string) {
    const identity = registerClassicContext(baseURL, nonce);
    try {
      return rewriter.javascript(source, baseURL, false, identity);
    } catch (error) {
      scriptContexts.delete(identity);
      throw error;
    }
  }
  async function blob(body: string | ArrayBuffer, type: string) {
    if (!live)
      throw new DOMException(
        "Document resource graph was disposed.",
        "AbortError",
      );
    const value = new natives.Blob([body], { type }),
      url = natives.createObjectURL(value);
    allocated.add(url);
    digests.set(
      url,
      await resourceDigest(
        new Uint8Array(await nativeBlobArrayBuffer.call(value)),
        digest,
        codecs,
      ),
    );
    return url;
  }
  async function load(
    value: string,
    integrity?: string,
    credentials: RequestCredentials = "same-origin",
    kind?: Exclude<OriginalPolicyKind, "connect"> | "media",
    nonce?: string,
    isModule = false,
  ) {
    const url = new URL(resolve(value));
    url.hash = "";
    if (originalPolicy && kind)
      originalPolicy.checkURL({ url: url.href, kind, nonce, integrity });
    if (originalPolicy && !kind)
      throw Object.assign(
        new DOMException(
          "An original resource destination is required.",
          "NotSupportedError",
        ),
        { code: "original_policy_resource_kind_required" },
      );
    if (!live)
      throw new DOMException(
        "Document resource graph was disposed.",
        "AbortError",
      );
    const cache = JSON.stringify([url.href, credentials, kind, nonce]);
    if (!raw.has(cache)) {
      if (raw.size + localCSSResources.size >= maxResources)
        throw new DOMException(
          "Website resource graph limit reached.",
          "QuotaExceededError",
        );
      const pending = (async () => {
        const init = {
          mode: url.origin === documentURL.origin ? "same-origin" : "cors",
          credentials,
        } as RequestInit;
        const response =
          kind && network.fetchResource
            ? await network.fetchResource(url.href, init, {
                destination: kind,
                nonce,
                integrity,
                isModule,
              })
            : await network.fetch(url.href, init);
        if (!response.ok || !["basic", "cors"].includes(response.type))
          throw new TypeError("Website resource is not CORS-readable.");
        const finalURL = resolve(response.url || url.href);
        if (kind)
          originalPolicy?.checkURL({
            url: finalURL,
            kind,
            nonce,
            integrity,
            redirectCount: response.redirected ? 1 : 0,
          });
        const body = await response.arrayBuffer();
        totalBytes += body.byteLength;
        if (totalBytes > maxTotalBytes)
          throw new DOMException(
            "Website resource graph byte limit reached.",
            "QuotaExceededError",
          );
        return {
          body,
          url: finalURL,
          type: (response.headers.get("content-type") ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase(),
        };
      })();
      raw.set(cache, pending);
      void pending.catch(() => raw.delete(cache));
    }
    const result = await raw.get(cache)!;
    await verifyResourceIntegrity(
      integrity,
      new Uint8Array(result.body),
      digest,
      codecs,
    );
    return result;
  }
  const javascript = (type: string) =>
    /^(?:text|application)\/(?:java|ecma)script$/.test(type);
  async function moduleSource(source: string, url: string) {
    await initializeLexer();
    const [imports] = parse(source, url),
      dependencies: string[] = [],
      changes: { start: number; end: number; text: string }[] = [];
    for (const entry of imports) {
      if (entry.d !== -1) continue;
      if (entry.a !== -1 || !entry.n)
        throw new DOMException(
          "Non-JavaScript module attributes require a separate loader.",
          "NotSupportedError",
        );
      const dependency = moduleURL(entry.n, url);
      dependencies.push(dependency);
      // Replace only lexer-proven static import string literals. Actual WASM
      // still rewrites all JavaScript globals, locations and dynamic imports.
      changes.push({
        start: entry.s - 1,
        end: entry.e + 1,
        text: JSON.stringify(dependency),
      });
    }
    for (const change of changes.sort((a, b) => b.start - a.start))
      source =
        source.slice(0, change.start) + change.text + source.slice(change.end);
    source = rewriter.module(source, url).source;
    // Normalize only rewriter-generated static import literals after WASM has
    // attached transport metadata. Import-map keys are stable logical identities.
    const [rewritten] = parse(source, url);
    let index = 0;
    const final = [];
    for (const entry of rewritten)
      if (entry.d === -1) {
        if (index >= dependencies.length)
          throw new TypeError("RuntimeKit changed the static module graph.");
        final.push({
          start: entry.s - 1,
          end: entry.e + 1,
          text: JSON.stringify(key(dependencies[index++])),
        });
      }
    if (index !== dependencies.length)
      throw new TypeError("RuntimeKit removed a static module dependency.");
    for (const change of final.sort((a, b) => b.start - a.start))
      source =
        source.slice(0, change.start) + change.text + source.slice(change.end);
    return { source, dependencies };
  }
  async function visitModule(
    url: string,
    source?: string,
    nonce?: string,
  ): Promise<void> {
    if (source === undefined)
      originalPolicy?.checkURL({ url, kind: "script", nonce });
    if (modules.has(url)) return;
    const record: Module = { source: "", dependencies: [], nonce };
    modules.set(url, record);
    try {
      let baseURL = url;
      if (source === undefined) {
        const value = await load(
          url,
          moduleIntegrity.get(url) ?? importMap.integrityFor(url),
          "same-origin",
          "script",
          nonce,
          true,
        );
        if (!javascript(value.type))
          throw new TypeError("Module requires a JavaScript MIME type.");
        source = new TextDecoder().decode(value.body);
        baseURL = value.url;
      }
      record.baseURL = baseURL;
      const rewritten = await moduleSource(source, baseURL);
      record.source = rewritten.source;
      record.dependencies = rewritten.dependencies;
      for (const dependency of record.dependencies)
        await visitModule(dependency, undefined, nonce);
    } catch (error) {
      modules.delete(url);
      throw error;
    }
  }
  async function publishModules() {
    const imports: Record<string, string> = {};
    for (const [url, record] of modules) {
      record.blob ??= await blob(record.source, "application/javascript");
      if (!mapped.has(url)) imports[key(url)] = record.blob;
    }
    if (!Object.keys(imports).length) return;
    const map = document.createElement("script");
    map.type = "importmap";
    scriptText(map, JSON.stringify({ imports }));
    natives.appendChild.call(document.head || document.documentElement, map);
    for (const url of modules.keys()) mapped.add(url);
  }
  function prepareModule(
    value: string,
    base = documentURL.href,
    integrity?: string,
    nonce?: string,
  ) {
    const url = resolve(value, base);
    originalPolicy?.checkURL({ url, kind: "script", nonce, integrity });
    const run = tail.then(async () => {
      // Every requesting element authenticates its own original metadata, even
      // when this module identity was already rewritten and published.
      if (integrity) {
        await load(url, integrity, "same-origin", "script", nonce, true);
        moduleIntegrity.set(url, integrity);
      }
      await visitModule(url, undefined, nonce);
      await publishModules();
      return modules.get(url)!.blob!;
    });
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  async function prepareInlineModule(
    source: string,
    base = documentURL.href,
    nonce?: string,
  ) {
    await originalPolicy?.authorizeInline({ kind: "script", source, nonce });
    const url = new URL(base);
    url.hash = "atlas-inline-" + ++inlineSerial;
    const run = tail.then(async () => {
      await visitModule(url.href, source, nonce);
      await publishModules();
      return modules.get(url.href)!.blob!;
    });
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const font = (type: string) =>
    /^font\//.test(type) ||
    /^(?:application\/(?:font-woff|vnd.ms-fontobject|x-font-ttf|x-font-opentype))$/.test(
      type,
    );
  const localCSSResources = new Map<string, Promise<string>>();
  async function localCSSResource(
    value: string,
    kind: "image" | "font",
    integrity?: string,
  ) {
    if (!live)
      throw new DOMException("Document resource graph was disposed.", "AbortError");
    const url = new URL(value);
    url.hash = "";
    originalPolicy?.checkURL({ url: url.href, kind, integrity });
    const cache = JSON.stringify([kind, url.href, integrity]);
    const existing = localCSSResources.get(cache);
    if (existing) return existing;
    if (raw.size + localCSSResources.size >= maxResources)
      throw new DOMException("Website local CSS resource limit reached.", "QuotaExceededError");
    const operation = (async () => {
      const decoded = decodeLocalCSSDataResource(url.href, kind);
      totalBytes += decoded.body.byteLength;
      if (totalBytes > maxTotalBytes)
        throw new DOMException("Website resource graph byte limit reached.", "QuotaExceededError");
      await verifyResourceIntegrity(integrity, decoded.body, digest, codecs);
      if (!live)
        throw new DOMException("Document resource graph was disposed.", "AbortError");
      return kind === "font" ? blob(decoded.body.buffer, decoded.mime) : decoded.url;
    })();
    localCSSResources.set(cache, operation);
    try {
      return await operation;
    } catch (error) {
      localCSSResources.delete(cache);
      throw error;
    }
  }
  async function resource(
    value: string,
    kind: Kind,
    base = documentURL.href,
    integrity?: string,
    credentials: RequestCredentials = "same-origin",
    seen = new Set<string>(),
    nonce?: string,
  ): Promise<string> {
    const local = new URL(value, base);
    if (local.protocol === "data:") {
      if (kind !== "image" && kind !== "font")
        throw new DOMException("Local CSS resources require image/font destinations.", "SecurityError");
      return localCSSResource(local.href, kind, integrity);
    }
    const url = resolve(value, base),
      resourceKey = JSON.stringify([
        kind,
        url,
        integrity ?? "",
        credentials,
        nonce,
      ]);
    const destination =
      kind === "classic"
        ? "script"
        : kind === "auto"
          ? undefined
          : kind === "audio" || kind === "video"
            ? "media"
            : kind;
    if (destination)
      originalPolicy?.checkURL({ url, kind: destination, nonce, integrity });
    if (seen.has(resourceKey)) return await blob("", "text/css"); // Native CSS import cycles do not reapply the cycle.
    // Share original HTTP bytes, never a rewritten classic execution context.
    const cached = kind === "classic" ? undefined : resources.get(resourceKey);
    if (cached) return await cached;
    const path = new Set(seen);
    path.add(resourceKey);
    const pending = (async () => {
      const result = await load(
        url,
        integrity,
        credentials,
        destination,
        nonce,
      );
      if (kind === "classic") {
        if (!javascript(result.type))
          throw new TypeError("Classic script requires JavaScript MIME type.");
        return await blob(
          classicSource(
            new TextDecoder().decode(result.body),
            result.url,
            nonce,
          ),
          "application/javascript",
        );
      }
      if (kind === "style" || (kind === "auto" && result.type === "text/css")) {
        if (result.type !== "text/css")
          throw new TypeError("Stylesheet requires text/css.");
        return await blob(
          await css(new TextDecoder().decode(result.body), result.url, path),
          "text/css",
        );
      }
      if (kind === "font" || (kind === "auto" && font(result.type))) {
        if (!font(result.type))
          throw new TypeError("Font MIME type is not recognized.");
        return await blob(result.body, result.type);
      }
      if (kind === "audio" || kind === "video") {
        const supported =
          kind === "audio"
            ? /^audio\/(?:mpeg|mp4|webm|ogg|wav|x-wav|wave)$/
            : /^video\/(?:mp4|webm|ogg)$/;
        if (!supported.test(result.type))
          throw new TypeError("Unsupported media MIME type");
        return await blob(result.body, result.type);
      }
      const imageType = kind === "image"
        ? imageResourceMIME(result.type, new Uint8Array(result.body))
        : /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(result.type) ? result.type : undefined;
      if (!imageType) throw new TypeError("Image MIME type is not recognized.");
      return await blob(result.body, imageType);
    })();
    resources.set(resourceKey, pending);
    try {
      return await pending;
    } catch (error) {
      resources.delete(resourceKey);
      throw error;
    }
  }
  async function css(source: string, base: string, seen = new Set<string>()) {
    const rewritten = rewriter.stylesheet(source, base);
    let output = rewritten.source;
    for (const dependency of scanNativeCSSDependencies(output).reverse()) {
      const marked = dependency.url.startsWith(RESOURCE);
      const originalURL = marked ? decodeURIComponent(dependency.url.slice(RESOURCE.length)) : dependency.url;
      if (!marked && !originalURL.startsWith("data:")) continue;
      if (
        dependency.kind === "style" &&
        dependency.qualifiers &&
        !/^layer(?:\(\s*[-_a-zA-Z][-_a-zA-Z0-9]*(?:\.[-_a-zA-Z][-_a-zA-Z0-9]*)*\s*\))?$/i.test(
          dependency.qualifiers,
        )
      )
        throw new DOMException(
          "Conditional CSS imports require native fetch-activation authority",
          "NotSupportedError",
        );
      const reference = new URL(originalURL, base);
      const requested = reference.protocol === "data:" ? reference : new URL(resolve(originalURL, base)),
        fragment = requested.hash;
      requested.hash = "";
      const url = requested.href,
        local = await resource(
          url,
          dependency.kind,
          base,
          undefined,
          "same-origin",
          seen,
        );
      const token = output.slice(dependency.start, dependency.end);
      const replacement = /^['"]/.test(token)
        ? quoteNativeCSSURL(local + fragment)
        : "url(" + quoteNativeCSSURL(local + fragment) + ")";
      output =
        output.slice(0, dependency.start) +
        replacement +
        output.slice(dependency.end);
    }
    return output;
  }
  const sourceScript = (element: Element) => {
    const encoded = get(element, "runtimekit-attr-script-source-src");
    return encoded
      ? new TextDecoder().decode(
          Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0)),
        )
      : (element.textContent ?? "");
  };
  const metadata = (element: Element) =>
    original(element, "integrity") || undefined;
  const nativeElement = (
    element: Element,
    url: string,
    kind: NativeResourceDescriptor["kind"],
  ) => {
    if (
      !options.nativeResources ||
      new URL(url).origin === documentURL.origin ||
      get(element, "crossorigin") !== null ||
      get(element, "runtimekit-attr-crossorigin") !== null
    )
      return undefined;
    const nonce = original(element, "nonce") || undefined,
      identity =
        kind === "script" ? registerClassicContext(url, nonce) : undefined;
    let bound = !identity;
    return options.nativeResources
      .prepare(
        {
          url,
          kind,
          integrity: metadata(element),
          nonce,
          ...(identity ? { scriptContext: identity } : {}),
        },
        undefined,
        identity
          ? (baseURL) => {
              if (!live || !scriptContexts.has(identity) || bound)
                throw new DOMException(
                  "Invalid script execution binding.",
                  "SecurityError",
                );
              const logical = resolve(baseURL);
              if (
                new URL(logical).hostname ===
                new URL(rewriter.context.prefix.href).hostname
              )
                throw new DOMException(
                  "Invalid script execution binding.",
                  "SecurityError",
                );
              scriptContexts.set(
                identity,
                Object.freeze({ baseURL: logical, nonce }),
              );
              bound = true;
            }
          : undefined,
      )
      .then((nativeURL) => {
        if (!bound)
          throw new DOMException(
            "Missing script execution binding.",
            "SecurityError",
          );
        return nativeURL;
      })
      .catch((error) => {
        if (identity) scriptContexts.delete(identity);
        throw error;
      });
  };
  function removeURL(element: Element, attribute: string) {
    const remove = natives.removeAttribute ?? Element.prototype.removeAttribute;
    remove.call(element, attribute);
    remove.call(element, "runtimekit-attr-" + attribute);
  }
  async function imageResource(value: string, element: Element) {
    const url = imageURL(value);
    originalPolicy?.checkURL({ url, kind: "image" });
    if (url.startsWith("data:")) return url;
    return await (nativeElement(element, url, "image") ??
      resource(
        url,
        "image",
        documentURL.href,
        undefined,
        original(element, "crossorigin") === "use-credentials"
          ? "include"
          : "same-origin",
      ));
  }
  async function responsive(
    element: Element,
    isCurrent: () => boolean,
    parentHint?: Element,
  ) {
    const source = original(element, "srcset");
    if (!source) return;
    const parent = element.parentElement ?? parentHint;
    const requestElement =
      element.localName === "source" && parent?.localName === "picture"
        ? (parent.querySelector("img") ?? element)
        : element;
    const candidates = [];
    for (const candidate of parseNativeSrcset(source)) {
      if (!isCurrent()) return;
      try {
        candidates.push({
          ...candidate,
          url: await imageResource(candidate.url, requestElement),
        });
      } catch (error) {
        if ((error as any)?.code !== "original_policy_denied") throw error;
      }
    }
    if (isCurrent()) set(element, "srcset", serializeNativeSrcset(candidates));
  }
  async function prepareAllowedElement(
    element: Element,
    isCurrent: () => boolean = () => true,
    parentHint?: Element,
  ) {
    const tag = element.localName.toLowerCase();
    if (tag === "script") {
      const type = (get(element, "type") || "").toLowerCase();
      if (type === "importmap") return;
      const src = original(element, "src");
      if (!src && type !== "module") {
        if (
          [
            "",
            "text/javascript",
            "application/javascript",
            "text/ecmascript",
            "application/ecmascript",
          ].includes(type)
        )
          scriptText(
            element,
            classicSource(
              sourceScript(element),
              documentBaseURL.href,
              original(element, "nonce") || undefined,
            ),
          );
        return;
      }
      const local =
        type === "module"
          ? src
            ? await prepareModule(
                resolve(src),
                documentURL.href,
                metadata(element),
                original(element, "nonce") || undefined,
              )
            : await prepareInlineModule(
                sourceScript(element),
                documentBaseURL.href,
                original(element, "nonce") || undefined,
              )
          : await (nativeElement(element, resolve(src), "script") ??
              resource(
                resolve(src),
                "classic",
                documentURL.href,
                metadata(element),
                original(element, "crossorigin") === "use-credentials"
                  ? "include"
                  : "same-origin",
                new Set(),
                original(element, "nonce") || undefined,
              ));
      if (!isCurrent()) return;
      if (!src) scriptText(element, "");
      set(element, "src", local);
      if (metadata(element)) set(element, "integrity", digests.get(local)!);
    } else if (
      tag === "link" &&
      /(?:^|\s)stylesheet(?:\s|$)/i.test(original(element, "rel"))
    ) {
      const local = await (nativeElement(
        element,
        resolve(original(element, "href")),
        "style",
      ) ??
        resource(
          resolve(original(element, "href")),
          "style",
          documentURL.href,
          metadata(element),
          original(element, "crossorigin") === "use-credentials"
            ? "include"
            : "same-origin",
          new Set(),
          original(element, "nonce") || undefined,
        ));
      if (!isCurrent()) return;
      set(element, "href", local);
      if (metadata(element)) set(element, "integrity", digests.get(local)!);
    } else if ((tag === "img" && original(element, "src")) || icon(element)) {
      const attribute = tag === "img" ? "src" : "href";
      const local = await imageResource(original(element, attribute), element);
      if (isCurrent()) set(element, attribute, local);
    } else if (
      (tag === "video" || tag === "audio" || tag === "source") &&
      original(element, "src")
    ) {
      const parent =
        tag === "source" ? (element.parentElement ?? parentHint) : element;
      if (!parent || !["video", "audio"].includes(parent.localName))
        throw new DOMException(
          "Source requires media parent",
          "NotSupportedError",
        );
      const kind = parent.localName as "audio" | "video",
        url = resolve(original(element, "src"));
      originalPolicy?.checkURL({ url, kind: "media" });
      const local = await (nativeElement(parent, url, kind) ??
        resource(
          url,
          kind,
          documentURL.href,
          undefined,
          original(parent, "crossorigin") === "use-credentials"
            ? "include"
            : "same-origin",
        ));
      if (isCurrent()) set(element, "src", local);
    } else if (tag === "style") {
      const text = await css(
        rewriter.originalCSS(element.textContent || ""),
        documentBaseURL.href,
      );
      if (isCurrent()) element.textContent = text;
    }
    if (
      tag === "img" ||
      (tag === "source" &&
        (element.parentElement ?? parentHint)?.localName === "picture")
    )
      await responsive(element, isCurrent, parentHint);
    if (tag === "video" && original(element, "poster")) {
      try {
        const local = await imageResource(original(element, "poster"), element);
        if (isCurrent()) set(element, "poster", local);
      } catch (error) {
        if ((error as any)?.code !== "original_policy_denied") throw error;
        if (isCurrent()) removeURL(element, "poster");
      }
    }
    if (get(element, "style")) {
      const text = await css(original(element, "style"), documentBaseURL.href);
      if (isCurrent()) set(element, "style", text);
    }
  }
  async function prepareElement(
    element: Element,
    isCurrent: () => boolean = () => true,
    parentHint?: Element,
  ) {
    if (originalPolicy) {
      const tag = element.localName.toLowerCase(),
        nonce = original(element, "nonce") || undefined,
        integrity = metadata(element);
      try {
        if (tag === "script") {
          const type = (get(element, "type") || "").trim().toLowerCase();
          if (
            [
              "",
              "module",
              "importmap",
              "text/javascript",
              "application/javascript",
              "text/ecmascript",
              "application/ecmascript",
            ].includes(type)
          ) {
            const src = original(element, "src");
            if (src)
              originalPolicy.checkURL({
                url: resolve(src),
                kind: "script",
                nonce,
                integrity,
              });
            else
              await originalPolicy.authorizeInline({
                kind: "script",
                source: sourceScript(element),
                nonce,
              });
          }
        } else if (
          tag === "link" &&
          /(?:^|\s)stylesheet(?:\s|$)/i.test(original(element, "rel"))
        )
          originalPolicy.checkURL({
            url: resolve(original(element, "href")),
            kind: "style",
            nonce,
            integrity,
          });
        else if (tag === "img" && original(element, "src"))
          originalPolicy.checkURL({
            url: imageURL(original(element, "src")),
            kind: "image",
          });
        else if (icon(element))
          originalPolicy.checkURL({
            url: imageURL(original(element, "href")),
            kind: "image",
          });
        else if (
          ["video", "audio", "source"].includes(tag) &&
          original(element, "src")
        )
          originalPolicy.checkURL({
            url: resolve(original(element, "src")),
            kind: "media",
          });
        else if (tag === "style")
          await originalPolicy.authorizeInline({
            kind: "style",
            source: rewriter.originalCSS(element.textContent || ""),
            nonce,
          });
      } catch (error) {
        if ((error as any)?.code !== "original_policy_denied") throw error;
        if (!isCurrent()) return;
        const remove =
          natives.removeAttribute ?? Element.prototype.removeAttribute;
        for (const attr of ["src", "href"]) {
          remove.call(element, attr);
          remove.call(element, "runtimekit-attr-" + attr);
        }
        if (tag === "script") {
          set(element, "type", "application/x-atlas-csp-blocked");
          scriptText(element, "");
        }
        if (tag === "style") element.textContent = "";
        if (!["img", "video", "audio", "source"].includes(tag)) return;
      }
      if (original(element, "style")) {
        try {
          originalPolicy.authorizeStyleAttribute(original(element, "style"));
        } catch (error) {
          if ((error as any)?.code !== "original_policy_denied") throw error;
          const remove =
            natives.removeAttribute ?? Element.prototype.removeAttribute;
          remove.call(element, "style");
          remove.call(element, "runtimekit-attr-style");
        }
      }
    }
    return prepareAllowedElement(element, isCurrent, parentHint);
  }
  return {
    prepareModule,
    prepareInlineModule,
    prepareElement,
    resolveModule: (base: string, specifier: string) =>
      moduleURL(specifier, executionContext(base).baseURL),
    async importModule(base: string, specifier: string) {
      const context = executionContext(base),
        url = moduleURL(specifier, context.baseURL);
      await prepareModule(url, documentURL.href, undefined, context.nonce);
      return await natives.importModule(key(url));
    },
    async prepareDocument(source: string) {
      // The lexer itself uses trusted pinned Wasm. Initialize it before the
      // document's original execution CSP takes effect, even if the initial
      // HTML contains only classic scripts and the first module arrives later.
      await initializeLexer();
      // The trusted plan chose the first permitted base. The copied core scans
      // every base itself and otherwise makes the last one win. Remove only the
      // physical href before its transform; retain logical getters separately.
      const input = parseHTML.call(parser, source, "text/html");
      const inputBases = Array.from(input.querySelectorAll("base"));
      const baseHrefs = inputBases.map(element => get(element,"href"));
      const nativeRemove = natives.removeAttribute ?? Element.prototype.removeAttribute;
      for (const element of inputBases) nativeRemove.call(element,"href");
      const reviewedFrames=Array.from(input.querySelectorAll("iframe"));
      const rendererSources=reviewedFrames.map(element=>get(element,"runtimekit-attr-src"));
      for(const element of reviewedFrames)nativeRemove.call(element,"src");
      const parsed = parseHTML.call(parser, rewriter.html("<!doctype html>" + input.documentElement.outerHTML, documentBaseURL.href), "text/html");
      Array.from(parsed.querySelectorAll("base")).forEach((element,index)=>{
        if(baseHrefs[index]!==null && baseHrefs[index]!==undefined) set(element,"runtimekit-attr-href",baseHrefs[index]!);
      });
      qualifyInlineSVG(parsed, {
        rewritten: true,
        natives: {
          getAttribute: nativeGet,
          setAttribute: natives.setAttribute,
        },
      });
      if (
        parsed.querySelector("frame,object,embed,input[type=image]")
      )
        throw new DOMException(
          "This nested/streaming resource path requires its bound loader.",
          "NotSupportedError",
        );
      Array.from(parsed.querySelectorAll("iframe")).forEach((element,index)=>{
        const source=rendererSources[index];
        if(get(element,"srcdoc")!==null)throw new DOMException("Inline nested documents require inherited policy","NotSupportedError");
        nativeRemove.call(element,"src");
        if(source){
          const url=new URL(source);
          if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw new DOMException("Invalid nested document URL","SecurityError");
          originalPolicy?.checkURL({url:url.href,kind:"frame"});
          set(element,"runtimekit-attr-src",url.href);
        }
      });
      for (const element of parsed.querySelectorAll(
        'script[type="importmap"]',
      )) {
        if (originalPolicy) {
          try {
            await originalPolicy.authorizeInline({
              kind: "script",
              source: sourceScript(element),
              nonce: original(element, "nonce") || undefined,
            });
          } catch (error) {
            if ((error as any)?.code !== "original_policy_denied") throw error;
            element.remove();
            continue;
          }
        }
        const value = JSON.parse(element.textContent || "{}");
        if (value.imports)
          for (const name of Object.keys(value.imports))
            if (typeof value.imports[name] === "string")
              value.imports[name] = rewriter.restoreURL(value.imports[name]);
        importMap.add(value, documentBaseURL.href);
        element.remove();
      }
      for (const element of parsed.querySelectorAll(
        "script,link,style,img,source,video,audio,[style]",
      ))
        await prepareElement(element);
      if (options.executionPolicy) {
        const meta = parsed.createElement("meta");
        set(meta, "http-equiv", "Content-Security-Policy");
        set(meta, "content", options.executionPolicy);
        const insert = natives.insertBefore ?? Node.prototype.insertBefore;
        insert.call(parsed.head, meta, parsed.head.firstChild);
      }
      return "<!doctype html>" + parsed.documentElement.outerHTML;
    },
    integrityForBlob: (url: string) => digests.get(url),
    dispose() {
      if (!live) return;
      live = false;
      for (const url of allocated) natives.revokeObjectURL(url);
      allocated.clear();
      resources.clear();
      localCSSResources.clear();
      modules.clear();
      scriptContexts.clear();
      raw.clear();
    },
    get resourceCount() {
      return modules.size + resources.size + localCSSResources.size;
    },
  };
}
