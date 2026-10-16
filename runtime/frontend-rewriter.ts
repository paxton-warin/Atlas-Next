/** Trusted frontend transformation for native no-CORS resource uploads. This
 * object never crosses the opaque boundary. Unsupported recursive paths are
 * explicit release gates, not an identity transform of executable/CSS bytes. */
import { createPinnedOpaqueRewriter } from "./opaque-runtime-adapter.ts";
import type {
  NativeResourceDescriptor,
  NativeResourceDependencyDescriptor,
} from "./native-resource-preparer.ts";
import {
  scanNativeCSSDependencies,
  quoteNativeCSSURL,
} from "./native-css-dependencies.ts";
export function createFrontendResourceRewriter(options: {
  core: any;
  wasm: Uint8Array;
  documentId: string;
  documentURL: string;
  frontendOrigin: string;
}) {
  if (!/^doc_[a-f0-9]{32}$/.test(options.documentId))
    throw new TypeError("Invalid resource document");
  const rewriter = createPinnedOpaqueRewriter({
    ...options,
    prefix:
      options.frontendOrigin + "/browse/logical/" + options.documentId + "/",
  });
  const decoder = new TextDecoder("utf-8", { fatal: true }),
    encoder = new TextEncoder();
  return async (resource: {
    body: Uint8Array;
    mime: string;
    kind: NativeResourceDescriptor["kind"];
    url: string;
    scriptContext?: string;
    signal: AbortSignal;
    prepareDependency?: (
      descriptor: NativeResourceDependencyDescriptor,
    ) => Promise<string>;
  }) => {
    if (resource.signal.aborted)
      throw new DOMException("Resource transform aborted", "AbortError");
    if (resource.kind === "script")
      return encoder.encode(
        rewriter.javascript(
          decoder.decode(resource.body),
          resource.url,
          false,
          resource.scriptContext,
        ),
      );
    if (resource.kind === "style") {
      const source = decoder.decode(resource.body);
      const charset = source.match(/^@charset\s+["']([^"']+)["'];/i);
      if (charset && !/^utf-?8$/i.test(charset[1]))
        throw new DOMException(
          "Native CSS legacy encoding requires transport encoding metadata",
          "NotSupportedError",
        );
      const references = scanNativeCSSDependencies(source),
        edits: { start: number; end: number; text: string }[] = [];
      for (const reference of references) {
        if (resource.signal.aborted)
          throw new DOMException("Resource transform aborted", "AbortError");
        if (!reference.url || reference.url.startsWith("#")) continue;
        if (
          reference.kind === "style" &&
          reference.qualifiers &&
          !/^layer(?:\(\s*[-_a-zA-Z][-_a-zA-Z0-9]*(?:\.[-_a-zA-Z][-_a-zA-Z0-9]*)*\s*\))?$/i.test(
            reference.qualifiers,
          )
        )
          throw new DOMException(
            "Conditional CSS imports require native fetch-activation authority",
            "NotSupportedError",
          );
        const url = new URL(reference.url, resource.url);
        if (
          (!/^https?:$/.test(url.protocol) &&
            !(
              url.protocol === "data:" &&
              ["image", "font"].includes(reference.kind)
            )) ||
          url.username ||
          url.password
        )
          throw new DOMException(
            "Native CSS dependency scheme requires its original-policy loader",
            "NotSupportedError",
          );
        if (!resource.prepareDependency)
          throw new DOMException(
            "Native CSS dependency loader required",
            "NotSupportedError",
          );
        const fragment = url.hash;
        url.hash = "";
        const local = await resource.prepareDependency({
          url: url.href,
          kind: reference.kind,
        });
        const parsed = new URL(local);
        if (
          reference.kind === "font"
            ? !/^blob:null\/[a-f0-9-]{36}$/i.test(local)
            : reference.kind === "image" && url.protocol === "data:"
              ? local !== url.href
              : parsed.protocol !== "https:" ||
                !/^\/native-resource\/v1\/resource\/[A-Za-z0-9_-]{43}$/.test(
                  parsed.pathname,
                ) ||
                parsed.search ||
                parsed.hash ||
                parsed.username ||
                parsed.password
        )
          throw new TypeError("Invalid trusted native CSS dependency result");
        const quoted = quoteNativeCSSURL(local + fragment),
          token = source.slice(reference.start, reference.end);
        edits.push({
          start: reference.start,
          end: reference.end,
          text:
            token[0] === '"' || token[0] === "'"
              ? quoted
              : "url(" + quoted + ")",
        });
      }
      let rewritten = source;
      for (const edit of edits.sort((a, b) => b.start - a.start))
        rewritten =
          rewritten.slice(0, edit.start) +
          edit.text +
          rewritten.slice(edit.end);
      return encoder.encode(rewritten);
    }
    if (resource.mime === "image/svg+xml") {
      // SVG2 secure image mode disables script/interactivity/external fetches.
      // Do NOT fetch or inline external SVG references: that would add authority
      // not present when the original SVG is loaded by an img/CSS image.
      if (resource.kind !== "image")
        throw new TypeError("SVG requires image destination");
      const source = decoder.decode(resource.body);
      if (/<!DOCTYPE/i.test(source))
        throw new DOMException(
          "SVG DTD processing requires a separately qualified parser",
          "NotSupportedError",
        );
      const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
      if (
        parsed.documentElement?.localName !== "svg" ||
        parsed.documentElement.namespaceURI !== "http://www.w3.org/2000/svg" ||
        parsed.querySelector("parsererror")
      )
        throw new TypeError("Invalid SVG image document");
      return encoder.encode(new XMLSerializer().serializeToString(parsed));
    }
    return resource.body;
  };
}
