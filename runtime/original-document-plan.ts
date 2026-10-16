/** ORIGINAL HTML authorization plan, created ONLY in trusted frontend code.
 * It is not executable rewritten content and does not compile physical CSP.
 * Consumers must enforce every emitted decision before graph/native loading.
 */
import type {
  OriginalDocumentPolicy,
  OriginalInlineReceipt,
} from "./original-document-policy.ts";
import { rendererTarget } from "./opaque-renderer.ts";
import { qualifyInlineSVG } from "./inline-svg.ts";
import { parseNativeSrcset, serializeNativeSrcset } from "./native-srcset.ts";
type Kind = "script" | "style" | "image" | "font" | "media";
export type OriginalElementDecision = Readonly<{
  index: number;
  kind: Kind | "style-attribute" | "script-attribute";
  allowed: boolean;
  url?: string;
  source?: string;
  nonce?: string;
  integrity?: string;
  module?: boolean;
  attribute?: string;
  receipt?:
    | OriginalInlineReceipt
    | Readonly<{ kind: "style-attribute" | "script-attribute"; source: string }>;
}>;
type Natives = {
  DOMParser: typeof DOMParser;
  parseFromString?: typeof DOMParser.prototype.parseFromString;
  querySelectorAll?: typeof Document.prototype.querySelectorAll;
  getAttribute?: typeof Element.prototype.getAttribute;
  setAttribute?: typeof Element.prototype.setAttribute;
  removeAttribute?: typeof Element.prototype.removeAttribute;
  remove?: typeof Element.prototype.remove;
  textContent?: PropertyDescriptor;
  attributes?: PropertyDescriptor;
  outerHTML?: PropertyDescriptor;
};
const failure = (code: string) =>
  Object.assign(new Error(code), { name: "SecurityError", code });
export function createOriginalDocumentPlan(options: {
  documentURL: string;
  policy: OriginalDocumentPolicy;
  natives?: Natives;
  maxElements?: number;
}) {
  const logical = new URL(options.documentURL),
    policy = options.policy,
    n = options.natives ?? { DOMParser };
  if (logical.href !== policy.documentURL)
    throw failure("original_plan_identity_mismatch");
  const parser = new n.DOMParser(),
    parse = n.parseFromString ?? n.DOMParser.prototype.parseFromString,
    query = n.querySelectorAll ?? Document.prototype.querySelectorAll,
    get = n.getAttribute ?? Element.prototype.getAttribute,
    set = n.setAttribute ?? Element.prototype.setAttribute,
    removeAttr = n.removeAttribute ?? Element.prototype.removeAttribute,
    remove = n.remove ?? Element.prototype.remove;
  const text =
      n.textContent ??
      Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!,
    attributes =
      n.attributes ??
      Object.getOwnPropertyDescriptor(Element.prototype, "attributes")!,
    outer =
      n.outerHTML ??
      Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML")!;
  const limit = options.maxElements ?? 4096;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384)
    throw failure("original_plan_invalid_limit");
  return Object.freeze({
    async prepare(html: string, signal?: AbortSignal) {
      if (typeof html !== "string" || html.length > 8 * 1024 * 1024)
        throw failure("original_plan_html_limit");
      const check = () => {
        if (signal?.aborted) throw failure("original_plan_aborted");
      };
      check();
      const doc = parse.call(parser, html, "text/html");
      // DOMParser uses scripting-disabled parsing, while every website realm
      // here has allow-scripts. Its noscript fallback descendants are inert in
      // the actual document, not executable resources/CSP/navigation targets.
      for (const fallback of query.call(doc,"noscript")) remove.call(fallback);
      const all = query.call(doc, "*");
      if (all.length > limit) throw failure("original_plan_element_limit");
      if (
        query.call(
          doc,
          "frame,object,embed,applet,track,portal,template,math,input[type=image],[background]",
        ).length
      )
        throw failure("original_plan_unsupported_element");
      qualifyInlineSVG(doc, {natives:{querySelectorAll:query,getAttribute:get,setAttribute:set,attributes}});
      const decisions: OriginalElementDecision[] = [];
      let serial = 0;
      const attr = (e: Element, k: string) => get.call(e, k),
        content = (e: Element) => text.get!.call(e) ?? "";
      let baseURL = logical.href;
      const firstBase = Array.from(all).find(e => e.localName.toLowerCase() === "base" && attr(e, "href") !== null);
      if (firstBase) {
        const candidate = policy.upgradeURL(new URL(attr(firstBase,"href")!, logical).href);
        try { policy.checkURL({url:candidate,kind:"base"}); baseURL=candidate; }
        catch(error) { if((error as any)?.code!=="original_policy_denied")throw error; }
      }
      const decide = async (
        record: Omit<OriginalElementDecision, "index" | "allowed">,
        authorize: () => unknown | Promise<unknown>,
        deny: () => void,
      ) => {
        check();
        let allowed = true,
          receipt: OriginalElementDecision["receipt"];
        try {
          const v = await authorize();
          if (v && typeof v === "object" && "source" in v)
            receipt = v as typeof receipt;
        } catch (e) {
          if ((e as any)?.code !== "original_policy_denied") throw e;
          allowed = false;
          deny();
        }
        check();
        decisions.push(
          Object.freeze({
            ...record,
            index: ++serial,
            allowed,
            ...(receipt ? { receipt } : {}),
          }),
        );
      };
      for (const element of all) {
        check();
        // Removal mutates NamedNodeMap: snapshot original attributes so a
        // denied handler never skips the next original attribute or URL gate.
        const values = Array.from(attributes.get!.call(element) as NamedNodeMap,
          a => ({ name: a.name, value: a.value }));
        for (const a of values) {
          if (/^runtimekit-attr-/i.test(a.name))
            throw failure("original_plan_reserved_attribute");
          try {
            if (new URL(a.value, logical).protocol === "javascript:")
              throw failure("original_plan_handler_unsupported");
          } catch (e) {
            if ((e as any)?.code === "original_plan_handler_unsupported")
              throw e;
          }
          if (/^on/i.test(a.name))
            await decide(
              { kind: "script-attribute", attribute: a.name, source: a.value },
              () => policy.authorizeScriptAttribute(a.value),
              () => removeAttr.call(element, a.name),
            );
        }
        const tag = element.localName.toLowerCase(),
          nonce = attr(element, "nonce") ?? undefined,
          integrity = attr(element, "integrity") ?? undefined;
        if(tag === "iframe") {
          const src=attr(element,"src"), tokens=(attr(element,"sandbox")??"").split(/\s+/);
          const target=src===null?undefined:rendererTarget(new URL(src,baseURL).href,logical.href);
          if(!target||attr(element,"srcdoc")!==null||!tokens.includes("allow-scripts")||tokens.includes("allow-same-origin"))throw failure("original_plan_unsupported_element");
          try {policy.checkURL({url:target.href,kind:"frame"});}
          catch(error){if((error as any)?.code!=="original_policy_denied")throw error;remove.call(element);continue;}
          set.call(element,"runtimekit-attr-src",target.href);removeAttr.call(element,"src");
        }
        if (tag === "source" && !["picture", "video", "audio"].includes(element.parentElement?.localName.toLowerCase() ?? ""))
          throw failure("original_plan_source_parent_unsupported");
        if (attr(element,"srcset") !== null && !["img","source"].includes(tag))
          throw failure("original_plan_srcset_element_unsupported");
        if (attr(element,"poster") !== null && tag !== "video")
          throw failure("original_plan_poster_element_unsupported");
        if (
          tag === "meta" &&
          (attr(element, "http-equiv") ?? "").toLowerCase().trim() ===
            "content-security-policy"
        ) {
          remove.call(element);
          continue;
        }
        if (
          tag === "meta" &&
          (attr(element, "http-equiv") ?? "").toLowerCase().trim() === "refresh"
        )
          throw failure("original_plan_navigation_unsupported");
        if (tag === "script") {
          const type = (attr(element, "type") ?? "").trim().toLowerCase();
          if (
            !["", "module", "importmap"].includes(type) &&
            !/^(?:text|application)\/(?:java|ecma)script$/.test(type)
          )
            continue;
          const src = attr(element, "src");
          const record = {
            kind: "script" as const,
            nonce,
            integrity,
            module: type === "module",
          };
          const denied = () => {
            removeAttr.call(element, "src");
            set.call(element, "type", "application/x-atlas-csp-blocked");
            text.set!.call(element, "");
          };
          if (src !== null) {
            const url = policy.upgradeURL(new URL(src, baseURL).href);
            await decide(
              { ...record, url },
              () => policy.checkURL({ url, kind: "script", nonce, integrity }),
              denied,
            );
            if (decisions.at(-1)!.allowed) set.call(element, "src", url);
          } else {
            const source = content(element);
            await decide(
              { ...record, source },
              () => policy.authorizeInline({ kind: "script", source, nonce }),
              denied,
            );
          }
        } else if (tag === "style") {
          const source = content(element);
          await decide(
            { kind: "style", source, nonce },
            () => policy.authorizeInline({ kind: "style", source, nonce }),
            () => {
              text.set!.call(element, "");
              set.call(element, "type", "text/x-atlas-csp-blocked");
            },
          );
        } else if (tag === "link") {
          const rel = (attr(element, "rel") ?? "").toLowerCase().split(/\s+/),
            href = attr(element, "href");
          if (href !== null && rel.includes("stylesheet")) {
            const url = policy.upgradeURL(new URL(href, baseURL).href);
            await decide(
              { kind: "style", url, nonce, integrity },
              () => policy.checkURL({ url, kind: "style", nonce, integrity }),
              // The readable graph treats any rel=stylesheet as loadable; a
              // blank href would accidentally refetch the document as CSS.
              () => remove.call(element),
            );
            if (decisions.at(-1)!.allowed) set.call(element, "href", url);
          } else if (href !== null && rel.some(value=>["icon","apple-touch-icon","apple-touch-icon-precomposed","mask-icon"].includes(value))) {
            const url=policy.upgradeURL(new URL(href,baseURL).href);
            await decide({kind:"image",url},()=>policy.checkURL({kind:"image",url}),()=>remove.call(element));
            if(decisions.at(-1)!.allowed)set.call(element,"href",url);
          } else if (href !== null && rel.length && rel.every(value=>["preconnect","dns-prefetch","preload","prefetch","modulepreload","prerender"].includes(value))) {
            // Resource hints are optimization requests, not executable content.
            // The regular bound loader still fetches each actual resource.
            remove.call(element);
          } else if (href !== null && rel.every(value=>["","canonical","alternate","author","license","help","next","prev","search"].includes(value))) {
            const url=new URL(href,baseURL);
            if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw failure("original_plan_link_unsupported");
            set.call(element,"href",url.href);
          } else if (href !== null) throw failure("original_plan_link_unsupported");
        } else if (tag === "img" && attr(element, "src")) {
          const url = policy.upgradeURL(
            new URL(attr(element, "src")!, baseURL).href,
          );
          await decide(
            { kind: "image", url },
            () => policy.checkURL({ url, kind: "image" }),
            () => removeAttr.call(element, "src"),
          );
          if (decisions.at(-1)!.allowed) set.call(element, "src", url);
        }
        if ((tag === "video" || tag === "audio" || tag === "source" && ["video","audio"].includes(element.parentElement?.localName.toLowerCase() ?? "")) && attr(element,"src")) {
          const url=policy.upgradeURL(new URL(attr(element,"src")!,baseURL).href);
          await decide({kind:"media",url},()=>policy.checkURL({kind:"media",url}),()=>removeAttr.call(element,"src"));
          if(decisions.at(-1)!.allowed)set.call(element,"src",url);
        }
        if (attr(element,"srcset") !== null) {
          if (tag === "source" && element.parentElement?.localName.toLowerCase() !== "picture")
            throw failure("original_plan_srcset_element_unsupported");
          const candidates=parseNativeSrcset(attr(element,"srcset")!);
          let allowed=true;
          const rewritten=[];
          for(const candidate of candidates){
            const url=policy.upgradeURL(new URL(candidate.url,baseURL).href);
            await decide({kind:"image",url},()=>policy.checkURL({kind:"image",url}),()=>{allowed=false});
            rewritten.push({...candidate,url});
          }
          if(allowed)set.call(element,"srcset",serializeNativeSrcset(rewritten));
          else removeAttr.call(element,"srcset");
        }
        if (tag === "video" && attr(element,"poster")) {
          const url=policy.upgradeURL(new URL(attr(element,"poster")!,baseURL).href);
          await decide({kind:"image",url},()=>policy.checkURL({kind:"image",url}),()=>removeAttr.call(element,"poster"));
          if(decisions.at(-1)!.allowed)set.call(element,"poster",url);
        }
        const style = attr(element, "style");
        if (style !== null)
          await decide(
            { kind: "style-attribute", source: style },
            () => policy.authorizeStyleAttribute(style),
            () => removeAttr.call(element, "style"),
          );
      }
      check();
      return Object.freeze({
        documentURL: logical.href,
        baseURL,
        html: "<!doctype html>" + outer.get!.call(doc.documentElement),
        decisions: Object.freeze(decisions),
        requiresPhysicalEnforcement: true as const,
      });
    },
  });
}
