/** Reviewed opaque-document adaptation of a COPY of the exact pinned core.
 * The original committed vendor artifact stays byte-identical. Build and browser
 * qualification share these unique, hash-checked seams; activation is separate. */
import { createHash } from "node:crypto";
import { OPAQUE_CORE_SOURCE_SHA256 as OPAQUE_CORE_SOURCE_HASH } from "../server/runtime-capabilities.mjs";
export { OPAQUE_CORE_SOURCE_HASH };
export function adaptPinnedRuntimeBundle(source) {
  if (
    createHash("sha256").update(source).digest("hex") !==
    OPAQUE_CORE_SOURCE_HASH
  )
    throw new Error(
      "Experimental fork source hash does not match the inspected pin.",
    );
  const edits = [
    // initSync already retains its first initialized Wasm instance. The pin
    // nevertheless recompiles identical bytes before EVERY subsequent call.
    // Cache only that private rewriter module, initially compiled by trusted
    // bootstrap before website policy/execution. No global WebAssembly API or
    // website CSP changes, and no module is exported to website code.
    ["3430(e,t,r){let i;", "3430(e,t,r){let i,opaqueCompiledRewriterModule;"],
    [
      "function A(e){i=e instanceof Uint8Array?e:new Uint8Array(e)}",
      "function A(e,t){i=e instanceof Uint8Array?e:new Uint8Array(e);if(t instanceof WebAssembly.Module)opaqueCompiledRewriterModule=t}",
    ],
    [
      "(0,n.QR)({module:new WebAssembly.Module(i)});",
      "(0,n.QR)({module:opaqueCompiledRewriterModule??=new WebAssembly.Module(i)});",
    ],
    [
      "this.serviceWorker=this.global.navigator.serviceWorker",
      "this.serviceWorker=t.opaqueDocument?void 0:this.global.navigator.serviceWorker",
    ],
    [
      "let i=e(r);r.endsWith",
      "let i=this.init.opaqueDocument?.moduleOverrides?.[r]??e(r);r.endsWith",
    ],
    [
      "get url(){return new g.xP(this.restoreurl(this.global.location.href))}",
      "get url(){return new g.xP(this.init.opaqueDocument?this.init.opaqueDocument.url():this.restoreurl(this.global.location.href))}",
    ],
    [
      "set url(e){e=(0,g.Qf)(e),",
      'set url(e){if(this.init.opaqueDocument){this.init.opaqueDocument.navigate(String(e),"assign");return}e=(0,g.Qf)(e),',
    ],
    [
      'if("hash"===r){t.location.hash=a[0],',
      'if("hash"===r&&e.init.opaqueDocument){let t=new o.xP(e.url.href);t.hash=a[0];e.init.opaqueDocument.navigate(t.href,"hash");return}if("hash"===r){t.location.hash=a[0],',
    ],
    [
      "self.$runtimekit=h})();",
      'Object.defineProperty(h.RuntimeKitClient,"opaqueAdapterVersion",{value:1});self.$runtimekit=h})();',
    ],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2)
      throw new Error(
        "Experimental seam match must be unique: " + before.slice(0, 50),
      );
    source = source.replace(before, after);
  }
  return source;
}
