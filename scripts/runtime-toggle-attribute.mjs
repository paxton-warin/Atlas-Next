import {createHash} from "node:crypto";
export const SOURCE_HASHES=new Set(["cc87e1fd09550a2dc7a9b89f28ed8da84cf7d2be0fa9cdecdd20f3ed44619ca1","380c68cccdf0c8d3e7a11499aa64f2dbe1c2fb484fc2117bc309e68aa32851d2","97f9ca69899f634a489d84cbc4dbcbebd99a1cbd241addf7a9cadc6251f79c28"]);
export function adaptToggleAttribute(bytes){
 if(!SOURCE_HASHES.has(createHash("sha256").update(bytes).digest("hex")))throw Error("toggleAttribute requires the qualified runtime artifact");
 const before='e.Proxy("Element.prototype.toggleAttribute",{apply(t){let r=(0,n.Qf)(t.args[0]);if(r.startsWith("runtimekit-attr"))return t.return(!1);e.natives.call("Element.prototype.hasAttribute",t.this,r)&&t.fn.call(t.this,`runtimekit-attr-${t.args[0]}`)}})';
 const after='e.Proxy("Element.prototype.toggleAttribute",{apply(t){let r=(0,n.Qf)(t.args[0]);if(r.startsWith("runtimekit-attr"))return t.return(!1);let i=e.natives.call("Element.prototype.hasAttribute",t.this,r),o=t.call();(!i||!o)&&e.natives.call("Element.prototype.removeAttribute",t.this,`runtimekit-attr-${r}`)}})';
 const source=bytes.toString();if(source.split(before).length!==2)throw Error("toggleAttribute seam changed");return Buffer.from(source.replace(before,after));
}
