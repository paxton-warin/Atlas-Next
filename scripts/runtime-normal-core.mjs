import { createHash } from "node:crypto";
export const NORMAL_CORE_UPSTREAM_SHA256 = "cc87e1fd09550a2dc7a9b89f28ed8da84cf7d2be0fa9cdecdd20f3ed44619ca1";

/** The pin's initSync already retains its initialized instance, but its caller
 * unnecessarily compiles identical Wasm bytes on every rewrite. Retain that
 * private module too. Nothing changes global WebAssembly or website policy. */
export function adaptNormalRuntimeCore(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== NORMAL_CORE_UPSTREAM_SHA256)
    throw Error("Normal core requires the qualified runtime artifact");
  let source = bytes.toString();
  for (const [before, after] of [
    ["3430(e,t,r){let i;", "3430(e,t,r){let i,atlasCompiledRewriterModule;"],
    ["(0,n.QR)({module:new WebAssembly.Module(i)});", "(0,n.QR)({module:atlasCompiledRewriterModule??=new WebAssembly.Module(i)});"],
  ]) {
    if (source.split(before).length !== 2) throw Error("Normal rewriter seam changed");
    source = source.replace(before, after);
  }
  return Buffer.from(source);
}
