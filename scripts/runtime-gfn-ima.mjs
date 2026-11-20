import {createHash} from 'node:crypto';

/** A narrowly qualified source compatibility adaptation for the public Google
 * IMA 3.797.1 measurement-frame factory. Its initial about:blank document is not
 * service-worker controlled. An explicit empty srcdoc navigates that ordinary
 * same-origin child before IMA adopts its measurement script. The publisher's
 * existing SafeHTML/Trusted Types helper supplies the value; this changes no
 * sandbox attributes, policy, ad state, request response or success callback.
 * This function is injected privately before the original WASM source rewrite,
 * so reconstruction maps describe the intentionally adapted source as well.
 * Exactly two source identities are accepted: the observed public SDK and the
 * tracked authored browser-test fixture. Provider updates fail unchanged until
 * independently reviewed and explicitly pinned; structural matches alone never
 * authorize a change. */
export function createGfnImaSourceAdapter() {
  const NativeUint8Array = Uint8Array;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const isView = ArrayBuffer.isView;
  const apply = Reflect.apply;
  const typedArrayTag = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(NativeUint8Array.prototype), Symbol.toStringTag).get;
  const NativeUint32Array = Uint32Array;
  const roundConstants = new NativeUint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  // A full source digest also proves these structural matches are executable
  // publisher declarations, rather than lookalikes inside comments/templates.
  // crypto.subtle is asynchronous; this synchronous SHA-256 runs only after
  // all URL, size, ASCII and structural checks. No general JS lexer is inferred.
  function sha256Ascii(source) {
    const length = source.length;
    const data = new NativeUint8Array(((length + 9 + 63) >>> 6) << 6);
    for (let i = 0; i < length; i++) data[i] = source.charCodeAt(i);
    data[length] = 128;
    const bits = length * 8;
    for (let i = 0; i < 4; i++) data[data.length - 1 - i] = bits >>> (i * 8);
    const state = new NativeUint32Array([
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,
    ]);
    const words = new NativeUint32Array(64);
    const rotate = (value, count) => (value >>> count) | (value << (32 - count));
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let i = 0; i < 16; i++) {
        const p = offset + i * 4;
        words[i] = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
      }
      for (let i = 16; i < 64; i++) {
        const x = words[i - 15], y = words[i - 2];
        words[i] = words[i - 16] + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) +
          words[i - 7] + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10));
      }
      let [a,b,c,d,e,f,g,h] = state;
      for (let i = 0; i < 64; i++) {
        const t1 = h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) +
          ((e & f) ^ (~e & g)) + roundConstants[i] + words[i];
        const t2 = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c));
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      state[0]+=a;state[1]+=b;state[2]+=c;state[3]+=d;
      state[4]+=e;state[5]+=f;state[6]+=g;state[7]+=h;
    }
    let result = '';
    for (const value of state) result += value.toString(16).padStart(8,'0');
    return result;
  }
  const factory = `function KM(a){var b,c,d,e,f,g;return A(function(h){if(h.j==1)return tq(hB)?(b=Mk("IFRAME"),b.style.visibility="hidden",b.style.width="0",b.style.height="0",b.style.position="absolute",b.style.left="0",b.style.top="0",b.title="Advertisement"):b=ql("IFRAME",{style:"visibility: hidden; width: 0; height: 0; position: absolute; left: 0; top: 0;",title:"Advertisement"}),c=new Promise(function(k){b.addEventListener("load",function(){k()})}),a.appendChild(b),h.h(c,2);d=tq(hB)?Mk("SCRIPT"):ql("SCRIPT");e= 
LM();jk(d,e);f=new Promise(function(k,l){d.addEventListener("load",function(){var n=ul(b);n&&JM(n)?k(b):l()})});g=b.contentDocument||b.contentWindow.document;g.head.appendChild(d);return h.return(f)})}`;
  const safeHtml = 'function fk(a){var b=Sj();a=b?b.createHTML(a):a;return new ek(a)}function gk(a){if(a instanceof ek)return a.h;throw Error("");}';
  const seam = 'c=new Promise(function(k){b.addEventListener("load",function(){k()})}),a.appendChild(b),h.h(c,2)';
  const replacement = 'c=new Promise(function(k){b.addEventListener("load",function(){k()})}),b.srcdoc=gk(fk("")),a.appendChild(b),h.h(c,2)';
  const once = (text, part) => {
    const index = text.indexOf(part);
    return index >= 0 && text.indexOf(part, index + part.length) === -1;
  };
  return function adaptSource(input, sourceURL, isModule = false) {
    if (sourceURL !== 'https://imasdk.googleapis.com/js/sdkloader/ima3.js' || isModule !== false)
      return input;
    try {
      const string = typeof input === 'string';
      if (!string && (!isView(input) || apply(typedArrayTag, input, []) !== 'Uint8Array')) return input;
      if (input.length > 1024 * 1024 || (input.length !== 508928 && input.length !== 2845)) return input;
      for (let i = 0; i < input.length; i++) {
        if ((string ? input.charCodeAt(i) : input[i]) > 127) return input;
      }
      const source = string ? input : decoder.decode(input);
      if (!source.includes('"h.3.797.1"') || !once(source, '"bridge3.797.1_"') ||
          !once(source, safeHtml) || !once(source, 'function fk(a){') ||
          !once(source, 'function gk(a){') || !once(source, 'function KM(a){') ||
          !once(source, factory) || !once(source, seam)) return input;
      const digest = sha256Ascii(source);
      if (digest !== 'acfe84a90c6debfc95f0a774d512e48648bd9effd5678ab6843657cab0145dfb' &&
          digest !== 'd4403e287e3c8e2fd97b7506456286e65d6d6c51c1736762c8853722c36d4f0c') return input;
      const start = source.indexOf(factory);
      const adaptedFactory = factory.replace(seam, replacement);
      const result = source.slice(0, start) + adaptedFactory + source.slice(start + factory.length);
      return string ? result : encoder.encode(result);
    } catch {
      return input;
    }
  };
}

/** The existing module-identity adaptation is retained byte-for-byte. These
 * are the three current cores and the three observed pre-cancellation cores. */
export const GFN_IMA_INPUTS = {
  'post-runtimekit.js': 'b8bb8122b4c62c514993c533848507481db1046d63ef4dd1e126739562672be3',
  'post-runtimekit-normal.js': '097f33ad8311a730131d833a57e6fb7291ac86cb34e1c63cf3bfa416aeea735a',
  'post-runtimekit-worker.js': '62e142acd283833a547bf95a29102b13b53ce69ced5494dd660345f330d69e16',
  'pre-runtimekit.js': '98e911b2fb905c2e71055a83ea0231c7d218b399f84e02c567e76790ab33c20e',
  'pre-runtimekit-normal.js': '187c11a659aeb9de042d969b42ea8201b1b9c407ac1a5e536262f5c7b90c0489',
  'pre-runtimekit-worker.js': '125b454a92ed3ff06fa747fe9bb0e8425abad8070dafc4f71836a392c9ca2f50',
};
export const GFN_IMA_OUTPUTS = {
  'post-runtimekit.js': '218f4391154ff64b18fafe7e26e53ee86681213b6a710ea3140eaf03deb3825e',
  'post-runtimekit-normal.js': 'cd5475ecf1cdd33321e4831987bf5aa604b691d8392b48f46a35a1ee8d692002',
  'post-runtimekit-worker.js': '414b3268a35283245c9a5a6eb719094580fa0bb5909dab13d47331eb94cf4fb7',
  'pre-runtimekit.js': '741b8a82d5dcfcd6d9693ad8616b3143674561db8f369f9f6c825c819e653d39',
  'pre-runtimekit-normal.js': '1d5ebd0846441bce1bdef6eac23be7930ddf0954c70f84efae57257cf48de71c',
  'pre-runtimekit-worker.js': '411984c4cb66d0320062b45e4fcf99aa315d811d93ac99a3b4ce62e1dfbef799',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('GFN IMA build seam changed');
  return source.replace(before, after);
}
export function adaptGfnIma(bytes) {
  const input = sha(bytes);
  const kind = Object.keys(GFN_IMA_INPUTS).find(k => GFN_IMA_INPUTS[k] === input);
  if (!kind) throw Error('GFN IMA requires a qualified module-identity core');
  let source = bytes.toString();
  source = replaceOnce(source, 'const atlasModuleIdentityContext=',
    'const atlasGfnImaSourceAdapter=(' + createGfnImaSourceAdapter.toString() + ')();const atlasModuleIdentityContext=');
  source = replaceOnce(source, 'return function(e,t,r,a,A){let[l,c]=(0,n.n)(r,a),u={};',
    'return function(e,t,r,a,A){e=atlasGfnImaSourceAdapter(e,t,A);let[l,c]=(0,n.n)(r,a),u={};');
  const output = Buffer.from(source);
  if (sha(output) !== GFN_IMA_OUTPUTS[kind]) throw Error('GFN IMA output hash mismatch');
  return output;
}
