import { createHash } from "node:crypto";
import { adaptNormalRuntimeCore } from "./runtime-normal-core.mjs";

export const RUNTIME_WORKER_GLOBALS_UPSTREAM_SHA256 =
  "cc87e1fd09550a2dc7a9b89f28ed8da84cf7d2be0fa9cdecdd20f3ed44619ca1";
const hash = value => createHash("sha256").update(value).digest("hex");

/** Exact pinned snapshot adaptation. Only the nine worker compiler operands
 * become removable; Window descriptors and every other descriptor retain the
 * original behavior. The source pin/vendor archive stay byte-for-byte intact.
 * Operand lifetime is instead held by lexical script/module/Function bindings.
 */
export function adaptRuntimeWorkerGlobals(bytes) {
  if (hash(bytes) !== RUNTIME_WORKER_GLOBALS_UPSTREAM_SHA256)
    throw Error("Worker bindings require the qualified runtime artifact");
  const before = "let d=globalThis.Object.defineProperty;";
  const source = adaptNormalRuntimeCore(bytes).toString();
  if (source.split(before).length !== 2) throw Error("Worker snapshot anchor changed");
  const after = `let d=((define,owner,worker)=>{const names=new Set(["$runtimekit$wrap","$runtimekit$prop","$runtimekit$clean","$runtimekit$import","$runtimekit$rewrite","$runtimekit$meta","$runtimekit$wrappostmessage","$runtimekit$pushsourcemap","$runtimekit$tryset"]);return(target,key,desc)=>define(target,key,worker&&target===owner&&names.has(key)?{...desc,configurable:true}:desc)})(globalThis.Object.defineProperty,globalThis,"WorkerGlobalScope" in globalThis);`;
  let adapted = source.replace(before, after);
  // Stack decoration is optional bookkeeping, not a reason to mutate a site's
  // frozen Error constructor or fail an otherwise valid IPC/Function call.
  // Preserve native decoration when writable; never unfreeze/redefine it.
  const stack = `const atlasWorkerStackTrace=(()=>{const ctor=globalThis.Error,desc=Object.getOwnPropertyDescriptor,extensible=Object.isExtensible,set=Reflect.set;return{get value(){return ctor.prepareStackTrace},set value(value){const d=desc(ctor,"prepareStackTrace");if(d?(d.writable||d.set):extensible(ctor))set(ctor,"prepareStackTrace",value)}}})();`;
  if (!adapted.startsWith("(()=>{")) throw Error("Worker closure anchor changed");
  adapted = "(()=>{const AtlasWorkerTextDecoder=globalThis.TextDecoder,AtlasWorkerTextEncoder=globalThis.TextEncoder,atlasWorkerGetRandomValues=globalThis.crypto.getRandomValues.bind(globalThis.crypto);" + stack + adapted.slice(6);
  for (const [before, after, count] of [["new TextDecoder", "new AtlasWorkerTextDecoder", 7], ["new TextEncoder", "new AtlasWorkerTextEncoder", 3]]) {
    if (adapted.split(before).length !== count + 1) throw Error("Worker codec seam changed");
    adapted = adapted.replaceAll(before, after);
  }
  for (const [anchor, count] of [["g.$D.prepareStackTrace", 6], ["i.$D.prepareStackTrace", 3]]) {
    if (adapted.split(anchor).length !== count + 1) throw Error("Worker stack seam changed");
    adapted = adapted.replaceAll(anchor, "atlasWorkerStackTrace.value");
  }
  for (const [before, after] of [
    // Rust's sourcemap-tag import needs private secure entropy even after the
    // site's capability cleanup. Do not restore or expose ambient crypto.
    ['crypto.getRandomValues(new Uint8Array(1))', 'atlasWorkerGetRandomValues(new Uint8Array(1))'],
    // window.event is a Window legacy API, not a worker capability. Do not
    // recreate it on a worker that deliberately removed/froze ambient globals.
    ['return t.event||(0,o.pS)(t,"event",{get:()=>s[0],configurable:!0}),(0,o.z$)(e,i,s)', 'return(0,o.z$)(e,i,s)'],
    // Callback bookkeeping is runtime-private and must not require adding a
    // symbol property to frozen native endpoints/globalThis.
    ['let s=(0,o.Rq)("runtimekit original onevent function");', 'let s=new WeakMap;'],
    ['get(e){return this[s]?this[s]:e.get()},set(e,t){if(this[s]=t,"function"!=typeof t)', 'get(e){return s.get(this)||e.get()},set(e,t){if(s.set(this,t),"function"!=typeof t)'],
  ]) {
    if (adapted.split(before).length !== 2) throw Error("Worker event seam changed");
    adapted = adapted.replace(before, after);
  }
  return Buffer.from(adapted);
}
