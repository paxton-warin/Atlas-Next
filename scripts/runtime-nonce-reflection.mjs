import { createHash } from 'node:crypto';

// Final qualified copies after the existing normal/worker, toggleAttribute and
// literal-eval adaptations. The pinned vendor originals remain unchanged.
export const NONCE_REFLECTION_SOURCE_HASHES = new Set([
  '9c5798c30098d753d85dbdcf8286452ac0184aac774831b89de99eeea509ff37',
  '8af727441170c86385c71fa1ee08640dbe9012482f32b62301fc16f97f9b3bf5',
  '243fb4ee3beff746f9dd571297c9dcad6fc2a006f81880f322a28e5209b72d4f',
]);

/** Preserve the website-visible nonce reflected from the original attribute.
 * The physical nonce stays removed by the existing HTML rewrite, so this does
 * not grant script execution, alter CSP, disable a check or choose gate values.
 */
export function adaptNonceReflection(bytes) {
  if (!NONCE_REFLECTION_SOURCE_HASHES.has(createHash('sha256').update(bytes).digest('hex')))
    throw Error('Nonce reflection requires a qualified runtime artifact');
  let source = bytes.toString();
  const edits = [
    ['get(){return["src","data","href","action","formaction"].includes(t)?(0,l.v2)(r.get.call(this),e.context):r.get.call(this)},set(e){return this.setAttribute(t,e)}',
     'get(){if("nonce"===t){let t=e.natives.call("Element.prototype.getAttribute",this,"runtimekit-attr-nonce");if(null!==t)return t}return["src","data","href","action","formaction"].includes(t)?(0,l.v2)(r.get.call(this),e.context):r.get.call(this)},set(e){return this.setAttribute(t,e)}'],
    ['if(r.startsWith("runtimekit-attr"))return t.return(void 0);e.natives.call("Element.prototype.hasAttribute",t.this,r)&&t.fn.call(t.this,`runtimekit-attr-${t.args[0]}`)',
     'if(r.startsWith("runtimekit-attr"))return t.return(void 0);("nonce"===r.toLowerCase()&&e.box.instanceof(t.this,"HTMLElement")||e.natives.call("Element.prototype.hasAttribute",t.this,r))&&t.fn.call(t.this,`runtimekit-attr-${t.args[0]}`)'],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw Error('Nonce reflection seam changed');
    source = source.replace(before, after);
  }
  return Buffer.from(source);
}
